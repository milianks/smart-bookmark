import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassifierPort } from '../services/classifier.service';
import type { BookmarkNode, BookmarkPort } from '../services/bookmark.service';
import { pruneJobs } from '../services/activity-log';
import type { NotificationPort } from '../services/notification.service';
import { OrganizerService } from '../services/organizer.service';
import { ScanService } from '../services/scan.service';
import { SettingsService } from '../services/settings.service';
import { MemoryStateRepository } from '../lib/storage/repository';
import type { ClassificationResult, FolderSummary } from '../types/domain';

class FakeBookmarks implements BookmarkPort {
  readonly nodes = new Map<string, BookmarkNode>();
  readonly moves: Array<{ id: string; target: string }> = [];
  readonly creations: Array<{ name: string; parent: string }> = [];

  constructor() {
    this.nodes.set('0', { id: '0', title: '', children: [{
      id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', parentId: '0', children: [],
    }, {
      id: 'other', title: '其他书签', folderType: 'other', parentId: '0', children: [],
    }] });
    this.nodes.set('bar', this.nodes.get('0')!.children![0]!);
    this.nodes.set('other', this.nodes.get('0')!.children![1]!);
    this.addFolder('smart-root', 'yuan 的智能书签', 'bar');
    this.addFolder('dev', '开发', 'smart-root');
    this.addFolder('nested', '稍后阅读', 'dev');
    this.addBookmark('b1', 'LangGraph guide', 'https://example.com/langgraph', 'smart-root');
  }

  async getTree(): Promise<BookmarkNode[]> { return structuredClone([this.nodes.get('0')!]); }
  async getBookmark(id: string): Promise<BookmarkNode | null> { return this.nodes.get(id)?.url ? this.nodes.get(id)! : null; }
  async getFolder(id: string): Promise<BookmarkNode | null> { const node = this.nodes.get(id); return node && !node.url ? node : null; }
  async getFolders(): Promise<FolderSummary[]> {
    const result: FolderSummary[] = [];
    const visit = (node: BookmarkNode, path: string[]) => {
      const next = node.title ? [...path, node.title] : path;
      if (!node.url && node.children) result.push({
        id: node.id, name: node.title, path: next.join(' / '),
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(node.folderType ? { folderType: node.folderType } : {}),
      });
      for (const child of node.children ?? []) visit(child, next);
    };
    visit(this.nodes.get('0')!, []);
    return result;
  }
  async getFolderPath(id: string): Promise<string | null> { return (await this.getFolders()).find((folder) => folder.id === id)?.path ?? null; }
  async folderExists(id: string): Promise<boolean> { return Boolean(await this.getFolder(id)); }
  async isEligibleRoot(id: string): Promise<boolean> { return ['bar', 'other'].includes(id); }
  async isWithinRoot(nodeId: string, rootId: string): Promise<boolean> {
    if (rootId !== 'smart-root') return false;
    if (nodeId === rootId) return true;
    let current = this.nodes.get(nodeId);
    while (current?.parentId) {
      if (current.parentId === rootId) return true;
      current = this.nodes.get(current.parentId);
    }
    return false;
  }
  async getFoldersWithinRoot(rootId: string): Promise<FolderSummary[]> {
    if (rootId !== 'smart-root') return [];
    return (await this.getFolders()).filter((folder) => folder.id === 'smart-root' || folder.id === 'dev' || folder.id === 'nested' || folder.id === 'archive' || folder.id.startsWith('folder-'));
  }
  async isValidTargetFolder(targetFolderId: string, rootId: string): Promise<boolean> {
    return (await this.getFoldersWithinRoot(rootId)).some((folder) => folder.id === targetFolderId);
  }
  async moveBookmark(bookmarkId: string, targetFolderId: string): Promise<void> {
    const bookmark = this.nodes.get(bookmarkId);
    const target = this.nodes.get(targetFolderId);
    if (!bookmark?.url || !target?.children) throw new Error('Invalid move');
    const source = this.nodes.get(bookmark.parentId ?? '');
    if (source?.children) source.children = source.children.filter((child) => child.id !== bookmarkId);
    target.children.push(bookmark);
    bookmark.parentId = targetFolderId;
    this.moves.push({ id: bookmarkId, target: targetFolderId });
  }
  async createFolder(name: string, parentId: string): Promise<BookmarkNode> {
    const folder = this.addFolder(`folder-${this.creations.length + 1}`, name, parentId);
    this.creations.push({ name, parent: parentId });
    return folder;
  }
  addBookmark(id: string, title: string, url: string, parentId: string): BookmarkNode {
    const bookmark: BookmarkNode = { id, title, url, parentId, children: undefined };
    this.nodes.set(id, bookmark);
    this.nodes.get(parentId)!.children!.push(bookmark);
    return bookmark;
  }
  addFolder(id: string, title: string, parentId: string): BookmarkNode {
    const folder: BookmarkNode = { id, title, parentId, children: [] };
    this.nodes.set(id, folder);
    const parent = this.nodes.get(parentId);
    if (parent?.children && !parent.children.some((child) => child.id === id)) parent.children.push(folder);
    return folder;
  }
}

describe('OrganizerService', () => {
  let bookmarks: FakeBookmarks;
  let store: MemoryStateRepository;
  let classifier: ClassifierPort;
  let notifications: NotificationPort;
  let organizer: OrganizerService;
  let scan: ScanService;
  let settings: SettingsService;
  let result: ClassificationResult;

  beforeEach(async () => {
    bookmarks = new FakeBookmarks();
    store = new MemoryStateRepository();
    await store.update((state) => { state.settings.apiKey = 'test-key'; state.smartBookmarkRootId = 'smart-root'; state.smartBookmarkInitialized = true; });
    result = { action: 'move', targetFolderId: 'dev', confidence: 0.96, reason: '与开发主题匹配' };
    classifier = { classify: vi.fn(async () => ({ result, source: 'ai' as const })) };
    notifications = {
      reviewNeeded: vi.fn(), processingFailed: vi.fn(), moved: vi.fn(),
    };
    organizer = new OrganizerService({
      bookmarks, store, classifier, notifications, alarms: { schedule: vi.fn() },
      hasProviderPermission: async () => true,
      makeId: (prefix) => `${prefix}-test`,
    });
    scan = new ScanService({ bookmarks, store, processPending: () => organizer.processPending(), approveReview: (id) => organizer.approveReview(id), makeId: (prefix) => `${prefix}-test` });
    settings = new SettingsService({ store, classifier, hasProviderPermission: async () => true, afterUpdate: () => organizer.resume() });
  });

  it('projects persisted metadata only onto matching recent jobs and review items', async () => {
    const metadata = { summary: 'Saved summary', tags: ['docs'], generatedAt: 10 };
    await store.update((state) => {
      state.bookmarkMetadata.b1 = metadata;
      state.bookmarkMetadata.unrelated = { summary: 'Unrelated', tags: ['other'], generatedAt: 11 };
      state.jobs.b1 = {
        bookmark: { id: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
        status: 'completed', attempts: 1, createdAt: 1, updatedAt: 2,
      };
      state.reviews.review1 = {
        id: 'review1', bookmarkId: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph',
        sourceParentId: 'smart-root', classification: result, source: 'ai', createdAt: 3, status: 'pending',
      };
    });

    const dashboard = await organizer.getDashboardState();

    expect(dashboard.recentJobs[0]?.metadata).toEqual(metadata);
    expect(dashboard.pendingReviews[0]?.metadata).toEqual(metadata);
    expect(dashboard).not.toHaveProperty('bookmarkMetadata');
    expect(JSON.stringify(dashboard)).not.toContain('Unrelated');
  });

  it('自动移动高置信度的已有目录建议，并保存撤销记录', async () => {
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    expect(bookmarks.moves).toEqual([{ id: 'b1', target: 'dev' }]);
    expect((await store.load()).lastUndo).toMatchObject({ bookmarkId: 'b1', fromFolderId: 'smart-root', toFolderId: 'dev' });
  });

  it('撤销栈保留多次自动移动并可逐条回退', async () => {
    const ids = { n: 0 };
    const multi = new OrganizerService({
      bookmarks, store, classifier, notifications, alarms: { schedule: vi.fn() },
      hasProviderPermission: async () => true,
      makeId: (prefix) => `${prefix}-${ids.n++}`,
    });
    bookmarks.addBookmark('b2', 'React docs', 'https://example.com/react', 'smart-root');
    await multi.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    await multi.onBookmarkCreated('b2', bookmarks.nodes.get('b2')!);

    let state = await store.load();
    expect(state.undoStack).toHaveLength(2);
    expect(state.lastUndo).toMatchObject({ bookmarkId: 'b2' });

    await multi.undoLastMove();
    await multi.undoLastMove();

    state = await store.load();
    expect(state.undoStack).toHaveLength(0);
    expect(state.lastUndo).toBeUndefined();
    expect(bookmarks.moves).toEqual([
      { id: 'b1', target: 'dev' }, { id: 'b2', target: 'dev' },
      { id: 'b2', target: 'smart-root' }, { id: 'b1', target: 'smart-root' },
    ]);
    await expect(multi.undoLastMove()).rejects.toThrow('没有可以撤销');
  });

  it('撤销栈最多保留 10 条自动移动', async () => {
    const ids = { n: 0 };
    const multi = new OrganizerService({
      bookmarks, store, classifier, notifications, alarms: { schedule: vi.fn() },
      hasProviderPermission: async () => true,
      makeId: (prefix) => `${prefix}-${ids.n++}`,
    });
    for (let index = 0; index < 12; index += 1) {
      const id = `stack-${index}`;
      bookmarks.addBookmark(id, `Article ${index}`, `https://example.com/a${index}`, 'smart-root');
      await multi.onBookmarkCreated(id, bookmarks.nodes.get(id)!);
    }

    const state = await store.load();
    expect(state.undoStack).toHaveLength(10);
    expect(state.undoStack[0]).toMatchObject({ bookmarkId: 'stack-2' });
  });

  it('没有合适目录时生成新目录建议，用户确认后才创建并移动', async () => {
    result = { action: 'suggest_folder', suggestedFolder: { name: 'Agent', parentId: 'dev' }, confidence: 0.79, reason: '主题目前没有合适目录' };
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    expect(bookmarks.moves).toHaveLength(0);
    expect(bookmarks.creations).toHaveLength(0);
    const pending = (await store.load()).reviews['b1'];
    expect(pending?.status).toBe('pending');
    await organizer.approveReview('b1');
    expect(bookmarks.creations).toEqual([{ name: 'Agent', parent: 'dev' }]);
    expect(bookmarks.moves.at(-1)).toEqual({ id: 'b1', target: 'folder-1' });
  });

  it('拒绝建议会保留书签原始位置', async () => {
    result = { action: 'move', targetFolderId: 'dev', confidence: 0.6, reason: '需要确认' };
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    await organizer.rejectReview('b1');
    expect(bookmarks.moves).toHaveLength(0);
    expect((await bookmarks.getBookmark('b1'))?.parentId).toBe('smart-root');
    expect((await store.load()).reviews['b1']?.status).toBe('rejected');
  });

  it('重复书签直接生成移入归档的待确认建议，不调用 AI', async () => {
    bookmarks.addFolder('archive', '🗄️ 归档', 'smart-root');
    await store.update((state) => {
      state.jobs.b1 = {
        bookmark: { id: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
        status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-x', duplicateOf: 'kept-1',
      };
    });

    await organizer.processPending();

    expect(classifier.classify).not.toHaveBeenCalled();
    const review = (await store.load()).reviews.b1;
    expect(review).toMatchObject({ status: 'pending', source: 'rule' });
    expect(review?.classification).toMatchObject({ action: 'move', targetFolderId: 'archive', confidence: 1 });
    expect(review?.targetFolderPath).toContain('归档');
    expect(review?.classification.reason).toContain('重复书签');
  });

  it('AI 失败时书签留在原位并记录失败', async () => {
    classifier.classify = vi.fn(async () => { throw new Error('provider unavailable'); });
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    expect(bookmarks.moves).toHaveLength(0);
    expect((await bookmarks.getBookmark('b1'))?.parentId).toBe('smart-root');
    expect((await store.load()).jobs.b1?.status).toBe('failed');
  });

  it('导入期间忽略新增事件，导入结束后可正常处理', async () => {
    await organizer.onImportBegan();
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    expect(classifier.classify).not.toHaveBeenCalled();
    await organizer.onImportEnded();
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    expect(classifier.classify).toHaveBeenCalledTimes(1);
  });

  it('目录已删除时安全降级，不执行移动', async () => {
    result = { action: 'move', targetFolderId: 'deleted', confidence: 0.99, reason: '旧目录' };
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    expect(bookmarks.moves).toHaveLength(0);
    expect((await bookmarks.getBookmark('b1'))?.parentId).toBe('smart-root');
    expect((await store.load()).jobs.b1?.status).toBe('failed');
  });

  it('重复并发事件只会触发一次分类与移动', async () => {
    await Promise.all([
      organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!),
      organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!),
    ]);
    expect(classifier.classify).toHaveBeenCalledTimes(1);
    expect(bookmarks.moves).toHaveLength(1);
  });

  it('撤销最近一次自动移动并回到原文件夹', async () => {
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    await organizer.undoLastMove();
    expect(bookmarks.moves.at(-1)).toEqual({ id: 'b1', target: 'smart-root' });
    expect((await bookmarks.getBookmark('b1'))?.parentId).toBe('smart-root');
    expect((await store.load()).lastUndo).toBeUndefined();
  });

  it('默认保留保存到自建文件夹中的书签', async () => {
    const bookmark = bookmarks.addBookmark('nested-bookmark', 'Article', 'https://example.com/article', 'other');
    await organizer.onBookmarkCreated(bookmark.id, bookmark);
    expect(classifier.classify).not.toHaveBeenCalled();
    expect((await bookmarks.getBookmark(bookmark.id))?.parentId).toBe('other');
  });

  it('缺少 API Key 时持久化等待状态，配置后恢复处理', async () => {
    await store.update((state) => { state.settings.apiKey = ''; });
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    expect((await store.load()).jobs.b1?.status).toBe('awaiting_configuration');
    await settings.updateSettings({ apiKey: 'test-key' });
    expect(bookmarks.moves).toEqual([{ id: 'b1', target: 'dev' }]);
  });

  it('历史扫描始终生成预览，不受新增书签自动模式影响', async () => {
    const started = await scan.startHistoricalScan();
    expect(started.eligibleTotal).toBe(1);
    expect(bookmarks.moves).toHaveLength(0);
    const state = await store.load();
    expect(state.historicalScan?.id).toBe(started.scanId);
    expect(state.reviews.b1?.scanId).toBe(started.scanId);
    expect(state.reviews.b1?.status).toBe('pending');
  });

  it('并发启动历史扫描只接受一个扫描锁', async () => {
    const results = await Promise.allSettled([scan.startHistoricalScan(), scan.startHistoricalScan()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('历史建议支持批量批准并撤销本批次移动', async () => {
    const { scanId } = await scan.startHistoricalScan();
    expect(bookmarks.moves).toHaveLength(0);
    expect(await scan.approveAllHistoricalReviews(scanId)).toBe(1);
    expect(bookmarks.moves).toEqual([{ id: 'b1', target: 'dev' }]);
    expect((await store.load()).lastHistoricalUndo?.moved).toHaveLength(1);
    expect(await organizer.undoHistoricalLast()).toBe(1);
    expect(bookmarks.moves.at(-1)).toEqual({ id: 'b1', target: 'smart-root' });
  });

  it('并发批量批准只允许一个请求执行', async () => {
    const { scanId } = await scan.startHistoricalScan();
    const results = await Promise.allSettled([
      scan.approveAllHistoricalReviews(scanId),
      scan.approveAllHistoricalReviews(scanId),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')[0]).toMatchObject({
      reason: new Error('历史批量审批正在进行，请稍后重试。'),
    });
    expect(bookmarks.moves).toEqual([{ id: 'b1', target: 'dev' }]);
  });

  it('Worker 重启后继续处理持久化的历史扫描任务', async () => {
    await store.update((state) => {
      state.historicalScan = {
        id: 'scan-restart', status: 'scanning', startedAt: 1, updatedAt: 1,
        eligibleTotal: 1, processedCount: 0, pendingReviewCount: 0,
        failedCount: 0, skippedCount: 0, coveredIds: ['b1'], forceOrganize: false,
      };
      state.jobs.b1 = {
        bookmark: { id: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
        status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-restart',
      };
    });

    const restarted = new OrganizerService({
      bookmarks, store, classifier, notifications, alarms: { schedule: vi.fn() },
      hasProviderPermission: async () => true,
      makeId: (prefix) => `${prefix}-restart`,
    });
    await restarted.resume();

    const state = await store.load();
    expect(state.reviews.b1).toMatchObject({ scanId: 'scan-restart', status: 'pending' });
    expect(bookmarks.moves).toHaveLength(0);
  });

  it('历史建议审批前发现书签手动移动时标记过期', async () => {
    const { scanId } = await scan.startHistoricalScan();
    await bookmarks.moveBookmark('b1', 'other');

    expect(await scan.approveAllHistoricalReviews(scanId)).toBe(0);
    expect((await store.load()).reviews.b1?.status).toBe('stale');
    expect(bookmarks.moves).toEqual([{ id: 'b1', target: 'other' }]);
  });
  it('prunes oldest eligible jobs and protects pending-review jobs', async () => {
    await store.update((state) => {
      for (let index = 0; index < 252; index += 1) {
        const id = `job-${index}`;
        state.jobs[id] = {
          bookmark: { id, title: id, url: `https://${id}.example`, parentId: 'smart-root' },
          status: index < 2 ? 'pending_review' : 'completed',
          attempts: 0,
          createdAt: index,
          updatedAt: index,
        };
      }
      pruneJobs(state);
    });

    const jobs = (await store.load()).jobs;
    expect(jobs['job-0']?.status).toBe('pending_review');
    expect(jobs['job-1']?.status).toBe('pending_review');
    expect(jobs['job-2']).toBeUndefined();
    expect(jobs['job-3']).toBeUndefined();
    expect(jobs['job-4']).toBeDefined();
    expect(jobs['job-251']).toBeDefined();
  });
});
