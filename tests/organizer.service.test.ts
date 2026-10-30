import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClassificationService, type ClassifierPort } from '../services/classifier.service';
import { OpenAICompatibleProvider, type ClassifierProvider } from '../lib/ai/openai-compatible';
import type { ClassificationInput, RecentCorrection } from '../lib/ai/prompts';
import type { ProviderConfig } from '../lib/ai/provider-config';
import { ChromeBookmarkService, getFoldersWithinRoot, isNodeWithinRoot, type BookmarkApi, type BookmarkNode, type BookmarkPort } from '../services/bookmark.service';
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
    return isNodeWithinRoot(await this.getTree(), nodeId, rootId);
  }
  async getFoldersWithinRoot(rootId: string): Promise<FolderSummary[]> {
    return getFoldersWithinRoot(await this.getTree(), rootId);
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
    scan = new ScanService({ scheduleApprovalResume: async () => {}, bookmarks, store, processPending: () => organizer.processPending(), approveReview: (id) => organizer.approveReview(id), makeId: (prefix) => `${prefix}-test` });
    settings = new SettingsService({ store, classifier, hasProviderPermission: async () => true, afterUpdate: () => organizer.resume() });
  });

  it('trims dashboard views, caches folders, and refreshes after invalidation and root changes', async () => {
    const folders = vi.spyOn(bookmarks, 'getFoldersWithinRoot');
    await store.update((state) => {
      state.reviews.history = {
        id: 'history', bookmarkId: 'b1', title: 'History', url: 'https://example.com/langgraph',
        sourceParentId: 'smart-root', classification: { action: 'keep', confidence: 1, reason: 'kept' },
        source: 'ai', createdAt: 1, status: 'approved', scanId: 'scan',
      };
    });
    const popup = await organizer.getDashboardState('popup');
    expect(popup).not.toHaveProperty('folders');
    expect(popup).not.toHaveProperty('historicalReviews');
    expect(popup.settings).not.toHaveProperty('apiKey');
    expect(Object.keys(await organizer.getDashboardState('settings')).sort()).toEqual(['activities', 'aiStatus', 'settings']);
    expect(folders).not.toHaveBeenCalled();
    const first = await organizer.getDashboardState();
    expect(first.historicalReviews).toHaveLength(1);
    first.folders[0]!.path = 'caller edit';
    expect((await organizer.getDashboardState('review')).folders[0]!.path).not.toBe('caller edit');
    expect(folders).toHaveBeenCalledTimes(1);
    bookmarks.addFolder('new-folder', 'New folder', 'smart-root');
    organizer.invalidateFolders();
    expect((await organizer.getDashboardState()).folders.some((folder) => folder.id === 'new-folder')).toBe(true);
    expect(folders).toHaveBeenCalledTimes(2);
    await store.update((state) => { state.smartBookmarkRootId = 'dev'; });
    expect((await organizer.getDashboardState()).folders.some((folder) => folder.id === 'new-folder')).toBe(false);
    expect(folders).toHaveBeenCalledTimes(3);
  });

  it('does not refill invalidated folders from an older in-flight read and retries read failures', async () => {
    let finish!: (value: FolderSummary[]) => void;
    let started!: () => void;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const folders = vi.spyOn(bookmarks, 'getFoldersWithinRoot').mockImplementationOnce(async () => {
      started();
      return new Promise<FolderSummary[]>((resolve) => { finish = resolve; });
    });
    const old = organizer.getDashboardState();
    await reading;
    organizer.invalidateFolders();
    const fresh = await organizer.getDashboardState();
    finish([{ id: 'stale', name: 'Stale', path: 'Stale' }]);
    await old;
    expect((await organizer.getDashboardState()).folders).toEqual(fresh.folders);
    expect(folders).toHaveBeenCalledTimes(2);
    organizer.invalidateFolders();
    folders.mockRejectedValueOnce(new Error('temporary bookmark failure'));
    expect((await organizer.getDashboardState()).folders).toEqual([]);
    expect((await organizer.getDashboardState()).folders.length).toBeGreaterThan(0);
    expect(folders).toHaveBeenCalledTimes(4);
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

  it('failed folder creation restores a queued approval to pending for manual retry', async () => {
    result = { action: 'suggest_folder', suggestedFolder: { name: 'Agent', parentId: 'dev' }, confidence: 0.79, reason: 'new topic' };
    const { scanId } = await scan.startHistoricalScan();
    vi.spyOn(bookmarks, 'createFolder').mockRejectedValueOnce(new Error('folder creation failed'));
    await scan.approveAllHistoricalReviews(scanId);
    await scan.resumeApprovals();
    expect((await store.load()).reviews.b1?.status).toBe('pending');
    expect((await store.load()).historicalApproval).toBeUndefined();
    expect(bookmarks.moves).toEqual([]);
    await organizer.approveReview('b1');
    expect((await store.load()).reviews.b1?.status).toBe('approved');
    expect(bookmarks.moves).toHaveLength(1);
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
    bookmarks.addBookmark('kept-1', 'Original', 'https://example.com/langgraph', 'smart-root');
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

  it('批准时可改选目标文件夹并按改选执行', async () => {
    result = { action: 'move', targetFolderId: 'dev', confidence: 0.6, reason: '需要确认' };
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    await organizer.approveReview('b1', 'nested');
    expect((await bookmarks.getBookmark('b1'))?.parentId).toBe('nested');
    expect(bookmarks.moves.at(-1)).toEqual({ id: 'b1', target: 'nested' });
  });

  it('keep 建议改选后批准会移动书签', async () => {
    await store.update((state) => {
      state.jobs.b1 = {
        bookmark: { id: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
        status: 'pending_review', attempts: 0, createdAt: 1, updatedAt: 1,
      };
      state.reviews.b1 = {
        id: 'b1', bookmarkId: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph',
        sourceParentId: 'smart-root', classification: { action: 'keep', confidence: 0.4, reason: '无明显主题' },
        source: 'ai', createdAt: 1, status: 'pending',
      };
    });
    await organizer.approveReview('b1', 'dev');
    expect((await bookmarks.getBookmark('b1'))?.parentId).toBe('dev');
  });

  it('removes metadata for deleted folders and closes pending work without touching other bookmarks', async () => {
    result = { action: 'move', targetFolderId: 'dev', confidence: 0.6, reason: 'review' };
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    await store.update((state) => {
      state.bookmarkMetadata.b1 = { summary: 'removed', tags: ['test'], generatedAt: 1 };
      state.bookmarkMetadata.other = { summary: 'retained', tags: ['test'], generatedAt: 1 };
    });
    await organizer.onBookmarkRemoved({ id: 'deleted-folder', title: 'Deleted', children: [bookmarks.nodes.get('b1')!] });
    const state = await store.load();
    expect(state.bookmarkMetadata.b1).toBeUndefined();
    expect(state.bookmarkMetadata.other?.summary).toBe('retained');
    expect(state.jobs.b1?.status).toBe('skipped');
    expect(state.reviews.b1?.status).toBe('stale');
    expect(bookmarks.moves).toEqual([]);
  });

  it('拒绝记录 keep 纠错，改选批准记录 move 纠错', async () => {
    result = { action: 'move', targetFolderId: 'dev', confidence: 0.6, reason: '需要确认' };
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    await organizer.rejectReview('b1');
    expect((await store.load()).corrections['https://example.com/langgraph']).toMatchObject({ action: 'keep' });

    bookmarks.addBookmark('b2', 'Second guide', 'https://example.org/x', 'smart-root');
    await organizer.onBookmarkCreated('b2', bookmarks.nodes.get('b2')!);
    await organizer.approveReview('b2', 'nested');
    expect((await store.load()).corrections['https://example.org/x']).toMatchObject({ action: 'move', folderId: 'nested' });
  });

  it('历史扫描任务走批量分类，一次调用处理多条', async () => {
    const batch = vi.fn(async (inputs: Array<{ title: string }>) =>
      inputs.map(() => ({
        result: { result: { action: 'move' as const, targetFolderId: 'dev', confidence: 0.55, reason: '批量建议' }, source: 'ai' as const },
      })));
    const batchClassifier: ClassifierPort = {
      classify: vi.fn(),
      classifyBatch: batch,
      testProvider: vi.fn(),
    };
    const batchOrganizer = new OrganizerService({
      bookmarks, store, classifier: batchClassifier, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    bookmarks.addBookmark('b2', 'React docs', 'https://example.com/react', 'smart-root');
    bookmarks.addBookmark('b3', 'Vue docs', 'https://example.com/vue', 'smart-root');
    await store.update((state) => {
      for (const id of ['b1', 'b2', 'b3']) {
        const node = bookmarks.nodes.get(id)!;
        state.jobs[id] = {
          bookmark: { id, title: node.title ?? '', url: node.url ?? '', parentId: 'smart-root' },
          status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-batch',
        };
      }
    });

    await batchOrganizer.processPending();

    expect(batch).toHaveBeenCalledOnce();
    expect(batch.mock.calls[0]?.[0]).toHaveLength(3);
    expect(batchClassifier.classify).not.toHaveBeenCalled();
    const state = await store.load();
    expect(state.reviews.b1?.status).toBe('pending');
    expect(state.reviews.b2?.status).toBe('pending');
    expect(state.reviews.b3?.status).toBe('pending');
  });

  it('批量准备期间目录和设置变化时丢弃旧快照，重试后使用一致的目录和学习状态', async () => {
    const second = bookmarks.addBookmark('b2', 'Second entry', 'https://second.test/item', 'nested');
    let changeOnce = true;
    const getBookmark = bookmarks.getBookmark.bind(bookmarks);
    vi.spyOn(bookmarks, 'getBookmark').mockImplementation(async (id) => {
      if (id === second.id && changeOnce) {
        changeOnce = false;
        bookmarks.nodes.get('nested')!.title = '新目录';
        await store.update((state) => {
          state.settings.model = 'new-model';
          state.corrections['other.test'] = { domain: 'other.test', action: 'keep', createdAt: 1 };
        });
      }
      return getBookmark(id);
    });
    const classifyBatch = vi.fn<NonNullable<ClassifierPort['classifyBatch']>>(async (inputs) => inputs.map(() => ({
      result: { result: { action: 'keep' as const, confidence: 0.7, reason: '保留' }, source: 'ai' as const },
    })));
    const batchOrganizer = new OrganizerService({
      bookmarks, store, classifier: { classify: vi.fn(), classifyBatch }, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    await store.update((state) => {
      for (const id of ['b1', 'b2']) {
        const node = bookmarks.nodes.get(id)!;
        state.jobs[id] = {
          bookmark: { id, title: node.title, url: node.url!, parentId: node.parentId! },
          status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-batch',
        };
      }
    });

    await batchOrganizer.processPending();

    expect(classifyBatch).toHaveBeenCalledOnce();
    const [inputs, folders, snapshotSettings, , snapshot] = classifyBatch.mock.calls[0]!;
    expect(inputs.map((input) => input.currentFolder)).toEqual(['yuan 的智能书签', 'yuan 的智能书签 / 开发 / 新目录']);
    expect(folders.find((folder: FolderSummary) => folder.id === 'nested')?.path).toBe(inputs[1]?.currentFolder);
    expect(snapshotSettings.model).toBe('new-model');
    expect(snapshot?.corrections['other.test']?.action).toBe('keep');
    expect((await store.load()).jobs.b1).toMatchObject({ status: 'completed', attempts: 1 });
    expect((await store.load()).jobs.b2).toMatchObject({ status: 'completed', attempts: 1 });
  });

  it.each(['folder', 'settings', 'corrections', 'preferences'] as const)(
    '批量分类返回前 %s 变化时丢弃所有旧结果并重试', async (kind) => {
      const b2 = bookmarks.addBookmark('b2', 'Second entry', 'https://second.test/item', 'smart-root');
      let calls = 0;
      const classifyBatch = vi.fn(async (inputs: Array<{ title: string }>) => {
        calls += 1;
        if (calls === 1) {
          if (kind === 'folder') bookmarks.nodes.get('dev')!.title = '改名';
          await store.update((state) => {
            if (kind === 'settings') state.settings.confidenceThreshold = 0.99;
            if (kind === 'corrections') state.corrections['example.com'] = { domain: 'example.com', action: 'keep', createdAt: 1 };
            if (kind === 'preferences') state.preferences.test = {
              key: 'test', topics: ['example'], contentType: 'article', folderId: 'dev',
              weight: 1, count: 1, createdAt: 1, updatedAt: 1,
            };
          });
        }
        return inputs.map(() => ({
          result: { result: { action: 'move' as const, targetFolderId: calls === 1 ? 'dev' : 'nested', confidence: 0.9, reason: `第 ${calls} 次` }, source: calls === 1 ? 'cache' as const : 'ai' as const },
        }));
      });
      const batchOrganizer = new OrganizerService({
        bookmarks, store, classifier: { classify: vi.fn(), classifyBatch }, notifications,
        alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
      });
      await store.update((state) => {
        for (const node of [bookmarks.nodes.get('b1')!, b2]) {
          state.jobs[node.id] = {
            bookmark: { id: node.id, title: node.title, url: node.url!, parentId: node.parentId! },
            status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-batch',
          };
        }
      });

      await batchOrganizer.processPending();

      expect(classifyBatch).toHaveBeenCalledTimes(2);
      const state = await store.load();
      expect(state.jobs.b1).toMatchObject({ status: 'pending_review', attempts: 1, classificationSource: 'ai' });
      expect(state.jobs.b2).toMatchObject({ status: 'pending_review', attempts: 1, classificationSource: 'ai' });
      expect(state.reviews.b1?.classification).toMatchObject({ action: 'move', targetFolderId: 'nested' });
      expect(state.reviews.b2?.classification).toMatchObject({ action: 'move', targetFolderId: 'nested' });
      expect(bookmarks.moves).toHaveLength(0);
    },
  );

  it('分类缓存读取后、实际提交前发生纠错时重试并丢弃命中结果', async () => {
    const b2 = bookmarks.addBookmark('b2', 'Second entry', 'https://second.test/item', 'smart-root');
    let lookupFinished = false;
    const classifyBatch = vi.fn<NonNullable<ClassifierPort['classifyBatch']>>(async (inputs) => {
      lookupFinished = true;
      return inputs.map(() => ({
        result: { result: { action: 'move' as const, targetFolderId: 'dev', confidence: 0.9, reason: '缓存建议' }, source: 'cache' as const },
      }));
    });
    let changed = false;
    const load = store.load.bind(store);
    vi.spyOn(store, 'load').mockImplementation(async () => {
      if (lookupFinished && !changed) {
        changed = true;
        await store.update((state) => {
          state.corrections['https://example.com/langgraph'] = { url: 'https://example.com/langgraph', domain: 'example.com', action: 'keep', createdAt: 1 };
        });
      }
      return load();
    });
    const batchOrganizer = new OrganizerService({
      bookmarks, store, classifier: { classify: vi.fn(), classifyBatch }, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    await store.update((state) => {
      for (const node of [bookmarks.nodes.get('b1')!, b2]) {
        state.jobs[node.id] = {
          bookmark: { id: node.id, title: node.title, url: node.url!, parentId: node.parentId! },
          status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-batch',
        };
      }
    });

    await batchOrganizer.processPending();

    expect(classifyBatch).toHaveBeenCalledTimes(2);
    expect(classifyBatch.mock.calls[0]?.[4]?.corrections).toEqual({});
    expect(classifyBatch.mock.calls[1]?.[4]?.corrections['https://example.com/langgraph']).toMatchObject({ action: 'keep' });
    expect((await store.load()).jobs.b1).toMatchObject({ status: 'pending_review', attempts: 1 });
    expect((await store.load()).jobs.b2).toMatchObject({ status: 'pending_review', attempts: 1 });
    expect(bookmarks.moves).toHaveLength(0);
  });

  it('批量处理期间先前成员变化时，不提交依赖它的剩余旧结果', async () => {
    const b2 = bookmarks.addBookmark('b2', 'Second entry', 'https://second.test/item', 'smart-root');
    let calls = 0;
    const classifyBatch = vi.fn<NonNullable<ClassifierPort['classifyBatch']>>(async (inputs) => {
      calls += 1;
      return inputs.map((input) => ({
        result: {
          result: input.title === 'Second entry' && calls === 1
            ? { action: 'move' as const, targetFolderId: 'dev', confidence: 0.9, reason: '旧批次建议' }
            : { action: 'keep' as const, confidence: 0.7, reason: '重新分类' },
          source: 'ai' as const,
        },
      }));
    });
    let firstCommitted = false;
    let changed = false;
    const update = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementation(async (mutator) => {
      const state = await update(mutator);
      if (state.jobs.b1?.status === 'completed') firstCommitted = true;
      return state;
    });
    const getTree = bookmarks.getTree.bind(bookmarks);
    vi.spyOn(bookmarks, 'getTree').mockImplementation(async () => {
      if (firstCommitted && !changed) {
        changed = true;
        bookmarks.nodes.get('b1')!.title = '已变更的首项';
      }
      return getTree();
    });
    const batchOrganizer = new OrganizerService({
      bookmarks, store, classifier: { classify: vi.fn(), classifyBatch }, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    await store.update((state) => {
      for (const node of [bookmarks.nodes.get('b1')!, b2]) {
        state.jobs[node.id] = {
          bookmark: { id: node.id, title: node.title, url: node.url!, parentId: node.parentId! },
          status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-batch',
        };
      }
    });

    await batchOrganizer.processPending();

    expect(classifyBatch).toHaveBeenCalledTimes(2);
    expect(classifyBatch.mock.calls[1]?.[0].map((input) => input.title)).toEqual(['Second entry']);
    const state = await store.load();
    expect(state.jobs.b2).toMatchObject({ status: 'completed', attempts: 1, classification: { action: 'keep', reason: '重新分类' } });
    expect(state.reviews.b2).toBeUndefined();
  });

  it('持续变化的分类上下文最多重试两次并安全失败', async () => {
    const b2 = bookmarks.addBookmark('b2', 'Second entry', 'https://second.test/item', 'smart-root');
    let calls = 0;
    const classifyBatch = vi.fn(async (inputs: Array<{ title: string }>) => {
      calls += 1;
      await store.update((state) => { state.settings.model = `model-${calls}`; });
      return inputs.map(() => ({
        result: { result: { action: 'move' as const, targetFolderId: 'dev', confidence: 0.9, reason: '过期' }, source: 'ai' as const },
      }));
    });
    const batchOrganizer = new OrganizerService({
      bookmarks, store, classifier: { classify: vi.fn(), classifyBatch }, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    await store.update((state) => {
      for (const node of [bookmarks.nodes.get('b1')!, b2]) {
        state.jobs[node.id] = {
          bookmark: { id: node.id, title: node.title, url: node.url!, parentId: node.parentId! },
          status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-batch',
        };
      }
    });

    await batchOrganizer.processPending();

    expect(classifyBatch).toHaveBeenCalledTimes(3);
    const state = await store.load();
    expect(state.jobs.b1).toMatchObject({ status: 'failed', attempts: 2 });
    expect(state.jobs.b2).toMatchObject({ status: 'failed', attempts: 2 });
    expect(state.reviews).toEqual({});
    expect(bookmarks.moves).toHaveLength(0);
  });

  it('历史扫描真实缓存区分任务去重，逐条复用并保持结果顺序', async () => {
    const existing = bookmarks.nodes.get('b1')!;
    existing.title = 'Entry 00';
    existing.url = 'https://site-00.example.test/item';
    for (let index = 1; index < 30; index += 1) {
      const suffix = String(index).padStart(2, '0');
      bookmarks.addBookmark(`b${index + 1}`, `Entry ${suffix}`, `https://site-${suffix}.example.test/item`, 'smart-root');
    }
    const request = (
      mode: 'single' | 'batch', inputs: ClassificationInput[], folders: FolderSummary[],
      config: ProviderConfig, recentCorrections?: RecentCorrection[],
    ): Record<string, unknown> => ({
      mode, inputs, folders, recentCorrections: recentCorrections ?? [],
      protocol: config.protocol, baseUrl: config.baseUrl, model: config.model,
    });
    const calls: string[][] = [];
    const provider: ClassifierProvider = {
      getCacheRequest: request,
      getCacheVariant: () => 0,
      classify: vi.fn<ClassifierProvider['classify']>(async (input, folders, config, corrections, onRequest) => {
        calls.push([input.title]);
        onRequest?.(request('single', [input], folders, config, corrections));
        return { action: 'keep', confidence: 0.7, reason: `result:${input.title}` };
      }),
      classifyBatch: vi.fn<NonNullable<ClassifierProvider['classifyBatch']>>(async (inputs, folders, config, corrections, onRequest) => {
        calls.push(inputs.map((input) => input.title));
        onRequest?.(request('batch', inputs, folders, config, corrections));
        return inputs.map((input) => ({ action: 'keep' as const, confidence: 0.7, reason: `result:${input.title}` }));
      }),
      test: vi.fn(),
    };
    const realClassifier = new ClassificationService(provider, store);
    const classifyBatch = vi.spyOn(realClassifier, 'classifyBatch');
    const historicalOrganizer = new OrganizerService({
      bookmarks, store, classifier: realClassifier, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    let scanNumber = 0;
    const historicalScan = new ScanService({ scheduleApprovalResume: async () => {},
      bookmarks, store, processPending: () => historicalOrganizer.processPending(),
      approveReview: (id) => historicalOrganizer.approveReview(id), makeId: () => `scan-${++scanNumber}`,
    });
    const waitForScan = async () => {
      await vi.waitFor(async () => expect((await store.load()).historicalScan?.status).toBe('completed'));
    };
    const checkJobs = async (source: 'ai' | 'cache') => {
      const state = await store.load();
      expect(Object.values(state.jobs)).toHaveLength(30);
      for (let index = 0; index < 30; index += 1) {
        const suffix = String(index).padStart(2, '0');
        expect(state.jobs[`b${index + 1}`]).toMatchObject({
          status: 'completed', classificationSource: source, classification: { reason: `result:Entry ${suffix}` },
        });
      }
    };

    await historicalScan.startHistoricalScan();
    await waitForScan();
    expect(calls.map((batch) => batch.length)).toEqual([15, 15]);
    expect(calls.flat()).toEqual(Array.from({ length: 30 }, (_, index) => `Entry ${String(index).padStart(2, '0')}`));
    expect(classifyBatch).toHaveBeenCalledTimes(2);
    await checkJobs('ai');

    await historicalScan.startHistoricalScan();
    await waitForScan();
    expect((await store.load()).historicalScan).toMatchObject({ skippedCount: 30 });
    expect(classifyBatch).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);

    await store.update((state) => { state.jobs = {}; state.reviews = {}; });
    await historicalScan.startHistoricalScan();
    await waitForScan();
    expect((await store.load()).historicalScan).toMatchObject({ skippedCount: 0, processedCount: 30 });
    expect(classifyBatch).toHaveBeenCalledTimes(4);
    expect(calls).toHaveLength(2);
    await checkJobs('cache');

    bookmarks.nodes.get('b8')!.title = 'Changed entry';
    await store.update((state) => { state.jobs = {}; state.reviews = {}; });
    await historicalScan.startHistoricalScan();
    await waitForScan();
    expect(classifyBatch).toHaveBeenCalledTimes(6);
    expect(calls.map((batch) => batch.length)).toEqual([15, 15, 1]);
    expect(calls[2]).toEqual(['Changed entry']);
    const finalState = await store.load();
    expect(finalState.jobs.b8).toMatchObject({ classificationSource: 'ai', classification: { reason: 'result:Changed entry' } });
    expect(finalState.jobs.b16).toMatchObject({ classificationSource: 'cache', classification: { reason: 'result:Entry 15' } });
    expect(bookmarks.moves).toHaveLength(0);
  });

  it('外部来源文件夹更名后重新分类，而非使用旧路径', async () => {
    await store.update((state) => { state.settings.organizeExternalRoots = true; });
    const node = bookmarks.addBookmark('ext-rename', 'External', 'https://external.test/a', 'other');
    const classify = vi.fn<ClassifierPort['classify']>(async (input) => {
      if (input.currentFolder === '其他书签') bookmarks.nodes.get('other')!.title = '已改名的外部根';
      return { result: { action: 'move', targetFolderId: 'dev', confidence: 0.6, reason: input.currentFolder }, source: 'ai' };
    });
    const instance = new OrganizerService({
      bookmarks, store, classifier: { classify }, notifications, alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });

    await instance.onBookmarkCreated(node.id, node);

    expect(classify.mock.calls.map(([input]) => input.currentFolder)).toEqual(['其他书签', '已改名的外部根']);
    expect((await store.load()).reviews[node.id]?.classification.reason).toBe('已改名的外部根');
  });

  it('分类时编辑标题和网址后重新分类，审核和纠错均使用新内容', async () => {
    const classify = vi.fn<ClassifierPort['classify']>(async (input) => {
      if (input.url === 'https://example.com/langgraph') {
        bookmarks.nodes.get('b1')!.title = 'Edited title';
        bookmarks.nodes.get('b1')!.url = 'https://changed.test/new';
      }
      return { result: { action: 'move', targetFolderId: 'dev', confidence: 0.6, reason: input.url }, source: 'ai' };
    });
    const instance = new OrganizerService({
      bookmarks, store, classifier: { classify }, notifications, alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });

    await instance.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);

    expect(classify.mock.calls.map(([input]) => input.url)).toEqual(['https://example.com/langgraph', 'https://changed.test/new']);
    const state = await store.load();
    expect(state.jobs.b1?.bookmark).toMatchObject({ title: 'Edited title', url: 'https://changed.test/new' });
    expect(state.reviews.b1).toMatchObject({ title: 'Edited title', url: 'https://changed.test/new', classification: { reason: 'https://changed.test/new' } });
    await instance.approveReview('b1', 'nested');
    expect((await store.load()).corrections['https://changed.test/new']).toMatchObject({ action: 'move', folderId: 'nested' });
    expect((await store.load()).corrections['example.com']).toBeUndefined();
  });

  it('审核前书签标题或网址变化时标记过期，不移动或记录纠错', async () => {
    result = { action: 'move', targetFolderId: 'dev', confidence: 0.6, reason: '需要确认' };
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    bookmarks.nodes.get('b1')!.title = 'Changed';
    bookmarks.nodes.get('b1')!.url = 'https://changed.test/';

    await expect(organizer.approveReview('b1', 'nested')).rejects.toThrow();
    const state = await store.load();
    expect(state.reviews.b1?.status).toBe('stale');
    expect(state.corrections).toEqual({});
    expect(bookmarks.moves).toHaveLength(0);
  });

  it('拒绝前网址变化时标记过期且不将纠错写入旧域名', async () => {
    result = { action: 'move', targetFolderId: 'dev', confidence: 0.6, reason: '需要确认' };
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    bookmarks.nodes.get('b1')!.url = 'https://changed.test/new';

    await expect(organizer.rejectReview('b1')).rejects.toThrow();
    expect((await store.load()).reviews.b1?.status).toBe('stale');
    expect((await store.load()).corrections).toEqual({});
  });

  it('分类进行时反复 resume 不重置正在执行的任务或重复请求', async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const classify = vi.fn<ClassifierPort['classify']>(async () => {
      await waiting;
      return { result: { action: 'keep', confidence: 0.7, reason: 'keep' }, source: 'ai' };
    });
    const instance = new OrganizerService({
      bookmarks, store, classifier: { classify }, notifications, alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    const processing = instance.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce());
    await instance.resume();
    await instance.resume();
    await instance.resume();
    expect((await store.load()).jobs.b1).toMatchObject({ status: 'processing', attempts: 0 });
    release();
    await processing;
    await vi.waitFor(async () => expect((await store.load()).jobs.b1?.status).toBe('completed'));
    expect(classify).toHaveBeenCalledOnce();
  });

  it.each(['source', 'duplicate', 'missing'] as const)(
    '重复书签的 %s 不再匹配时清除重复标记并正常分类', async (changed) => {
      bookmarks.addFolder('archive', '🗄️ 归档', 'smart-root');
      const original = bookmarks.addBookmark('original', 'Original', 'https://example.com/langgraph', 'smart-root');
      await store.update((state) => {
        state.jobs.b1 = {
          bookmark: { id: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
          status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-x', duplicateOf: 'original',
        };
      });
      if (changed === 'source') original.url = 'https://changed.test/source';
      if (changed === 'duplicate') bookmarks.nodes.get('b1')!.url = 'https://changed.test/copy';
      if (changed === 'missing') bookmarks.nodes.delete('original');
      classifier.classify = vi.fn<ClassifierPort['classify']>(async () => ({ result: { action: 'keep', confidence: 0.7, reason: '普通分类' }, source: 'ai' }));

      await organizer.processPending();

      expect(classifier.classify).toHaveBeenCalledOnce();
      const state = await store.load();
      expect(state.jobs.b1?.duplicateOf).toBeUndefined();
      expect(state.jobs.b1?.classification).toMatchObject({ action: 'keep', reason: '普通分类' });
      expect(state.reviews.b1).toBeUndefined();
    },
  );

  it('重复建议构造后原书签网址变化时舍弃建议并按普通分类重试', async () => {
    bookmarks.addFolder('archive', '🗄️ 归档', 'smart-root');
    const original = bookmarks.addBookmark('original', 'Original', 'https://example.com/langgraph', 'smart-root');
    await store.update((state) => {
      state.jobs.b1 = {
        bookmark: { id: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
        status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-x', duplicateOf: 'original',
      };
    });
    let changed = false;
    const getBookmark = bookmarks.getBookmark.bind(bookmarks);
    vi.spyOn(bookmarks, 'getBookmark').mockImplementation(async (id) => {
      const value = await getBookmark(id);
      if (id === 'original' && !changed) {
        changed = true;
        const previous = structuredClone(value);
        original.url = 'https://changed.test/new';
        return previous;
      }
      return value;
    });
    classifier.classify = vi.fn<ClassifierPort['classify']>(async () => ({
      result: { action: 'keep', confidence: 0.7, reason: '普通分类' }, source: 'ai',
    }));

    await organizer.processPending();

    const state = await store.load();
    expect(classifier.classify).toHaveBeenCalledOnce();
    expect(state.jobs.b1).toMatchObject({ status: 'completed', classification: { action: 'keep' } });
    expect(state.jobs.b1?.duplicateOf).toBeUndefined();
    expect(state.reviews.b1).toBeUndefined();
  });

  it('15 条历史批次复核复用树快照，不产生二次方树读取', async () => {
    for (let index = 2; index <= 15; index += 1) {
      bookmarks.addBookmark(`b${index}`, `Entry ${index}`, `https://site-${index}.test/item`, 'smart-root');
    }
    const api: BookmarkApi = {
      getTree: vi.fn(async () => bookmarks.getTree()),
      get: async (id) => {
        const node = bookmarks.nodes.get(id);
        return node ? [structuredClone(node)] : [];
      },
      move: vi.fn(),
      create: vi.fn(),
    };
    const chromeBookmarks = new ChromeBookmarkService(api);
    const classifyBatch = vi.fn<NonNullable<ClassifierPort['classifyBatch']>>(async (inputs) => inputs.map(() => ({
      result: { result: { action: 'keep', confidence: 0.7, reason: 'keep' }, source: 'ai' },
    })));
    const instance = new OrganizerService({
      bookmarks: chromeBookmarks, store, classifier: { classify: vi.fn(), classifyBatch }, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    await store.update((state) => {
      for (let index = 1; index <= 15; index += 1) {
        const node = bookmarks.nodes.get(`b${index}`)!;
        state.jobs[node.id] = {
          bookmark: { id: node.id, title: node.title, url: node.url!, parentId: node.parentId! },
          status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-batch',
        };
      }
    });

    await instance.processPending();

    expect(classifyBatch).toHaveBeenCalledOnce();
    expect(classifyBatch.mock.calls[0]?.[0]).toHaveLength(15);
    expect(Object.values((await store.load()).jobs).every((job) => job.status === 'completed')).toBe(true);
    expect(vi.mocked(api.getTree).mock.calls.length).toBeLessThanOrEqual(50);
  });

  it('目录在最终复核前异步读取期间变化时不提交旧目录结果', async () => {
    let afterProvider = false;
    let changed = false;
    const classify = vi.fn<ClassifierPort['classify']>(async () => {
      afterProvider = true;
      return { result: { action: 'move', targetFolderId: 'dev', confidence: 0.6, reason: changed ? '新目录' : '旧目录' }, source: 'ai' };
    });
    const getTree = bookmarks.getTree.bind(bookmarks);
    vi.spyOn(bookmarks, 'getTree').mockImplementation(async () => {
      if (afterProvider && !changed) {
        changed = true;
        bookmarks.nodes.get('dev')!.title = '改名目录';
      }
      return getTree();
    });
    const instance = new OrganizerService({
      bookmarks, store, classifier: { classify }, notifications, alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });

    await instance.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);

    expect(classify).toHaveBeenCalledTimes(2);
    expect((await store.load()).reviews.b1?.classification.reason).toBe('新目录');
  });

  it('移动锁内最新来源校验后书签网址变化时不自动移动', async () => {
    const getBookmark = bookmarks.getBookmark.bind(bookmarks);
    let scopeAfterIntent = false;
    let changed = false;
    const isWithinRoot = bookmarks.isWithinRoot.bind(bookmarks);
    vi.spyOn(bookmarks, 'isWithinRoot').mockImplementation(async (id, rootId) => {
      const state = await store.load();
      if (state.pendingOperation && id === 'b1') scopeAfterIntent = true;
      return isWithinRoot(id, rootId);
    });
    vi.spyOn(bookmarks, 'getBookmark').mockImplementation(async (id) => {
      if (id === 'b1' && scopeAfterIntent && !changed) {
        changed = true;
        bookmarks.nodes.get('b1')!.url = 'https://changed.test/new';
      }
      return getBookmark(id);
    });

    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);

    expect(changed).toBe(true);
    expect(bookmarks.moves).toHaveLength(0);
    expect((await store.load()).jobs.b1?.status).not.toBe('completed');
  });

  it('书签树复核挂起期间产生同域纠错时重新分类，不应用旧移动', async () => {
    let releaseTree!: () => void;
    let treeStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { releaseTree = resolve; });
    const started = new Promise<void>((resolve) => { treeStarted = resolve; });
    let afterClassification = false;
    let paused = false;
    const api: BookmarkApi = {
      getTree: vi.fn(async () => {
        const tree = await bookmarks.getTree();
        if (afterClassification && !paused) {
          paused = true;
          treeStarted();
          await waiting;
        }
        return tree;
      }),
      get: async (id) => {
        const node = bookmarks.nodes.get(id);
        return node ? [structuredClone(node)] : [];
      },
      move: vi.fn(async (id, destination) => {
        await bookmarks.moveBookmark(id, destination.parentId);
        return structuredClone(bookmarks.nodes.get(id)!);
      }),
      create: vi.fn(),
    };
    const provider: ClassifierProvider = {
      classify: vi.fn<ClassifierProvider['classify']>(async () => {
        afterClassification = true;
        return { action: 'move', targetFolderId: 'dev', confidence: 0.96, reason: '旧建议' };
      }),
      test: vi.fn(),
    };
    const classifier = new ClassificationService(provider, store);
    const classify = vi.spyOn(classifier, 'classify');
    const instance = new OrganizerService({
      bookmarks: new ChromeBookmarkService(api), store, classifier, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });

    const processing = instance.onBookmarkCreated('b1', structuredClone(bookmarks.nodes.get('b1')!));
    await started;
    await store.update((state) => {
      state.corrections['https://example.com/langgraph'] = { url: 'https://example.com/langgraph', domain: 'example.com', action: 'keep', createdAt: 1 };
    });
    releaseTree();
    await processing;

    expect(classify).toHaveBeenCalledTimes(2);
    expect(provider.classify).toHaveBeenCalledOnce();
    expect(api.move).not.toHaveBeenCalled();
    expect((await store.load()).jobs.b1).toMatchObject({ status: 'completed', attempts: 1, classification: { action: 'keep' } });
  });

  it.each(['changed', 'deleted'] as const)(
    '重复建议的原书签被 %s 后审批时拒绝归档', async (change) => {
      bookmarks.addFolder('archive', '🗄️ 归档', 'smart-root');
      const original = bookmarks.addBookmark('original', 'Original', 'https://example.com/langgraph', 'smart-root');
      const api: BookmarkApi = {
        getTree: vi.fn(async () => bookmarks.getTree()),
        get: async (id) => {
          const node = bookmarks.nodes.get(id);
          return node ? [structuredClone(node)] : [];
        },
        move: vi.fn(async (id, destination) => {
          await bookmarks.moveBookmark(id, destination.parentId);
          return structuredClone(bookmarks.nodes.get(id)!);
        }),
        create: vi.fn(),
      };
      const instance = new OrganizerService({
        bookmarks: new ChromeBookmarkService(api), store, classifier, notifications,
        alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
      });
      await store.update((state) => {
        state.jobs.b1 = {
          bookmark: { id: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
          status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-x', duplicateOf: 'original',
        };
      });
      await instance.processPending();
      expect((await store.load()).reviews.b1).toMatchObject({ status: 'pending', classification: { targetFolderId: 'archive' } });
      if (change === 'changed') original.url = 'https://changed.test/';
      else {
        bookmarks.nodes.delete(original.id);
        const root = bookmarks.nodes.get('smart-root')!;
        root.children = root.children!.filter((node) => node.id !== original.id);
      }

      await expect(instance.approveReview('b1')).rejects.toThrow();

      expect(api.move).not.toHaveBeenCalled();
      expect((await store.load()).reviews.b1?.status).toBe('stale');
      expect((await store.load()).jobs.b1?.status).toBe('skipped');
    },
  );

  it('重复建议原件有效且网址仅有片段差异时允许审批', async () => {
    bookmarks.addFolder('archive', '🗄️ 归档', 'smart-root');
    bookmarks.addBookmark('original', 'Original', 'https://example.com/langgraph#source', 'smart-root');
    const api: BookmarkApi = {
      getTree: vi.fn(async () => bookmarks.getTree()),
      get: async (id) => {
        const node = bookmarks.nodes.get(id);
        return node ? [structuredClone(node)] : [];
      },
      move: vi.fn(async (id, destination) => {
        await bookmarks.moveBookmark(id, destination.parentId);
        return structuredClone(bookmarks.nodes.get(id)!);
      }),
      create: vi.fn(),
    };
    const instance = new OrganizerService({
      bookmarks: new ChromeBookmarkService(api), store, classifier, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    await store.update((state) => {
      state.jobs.b1 = {
        bookmark: { id: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
        status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-x', duplicateOf: 'original',
      };
    });
    await instance.processPending();

    await instance.approveReview('b1');

    expect(api.move).toHaveBeenCalledOnce();
    expect((await store.load()).reviews.b1?.status).toBe('approved');
    expect((await bookmarks.getBookmark('b1'))?.parentId).toBe('archive');
  });

  it('重复建议在写入移动意图后原件发生变化时拒绝移动', async () => {
    bookmarks.addFolder('archive', '🗄️ 归档', 'smart-root');
    const original = bookmarks.addBookmark('original', 'Original', 'https://example.com/langgraph', 'smart-root');
    let changed = false;
    const api: BookmarkApi = {
      getTree: vi.fn(async () => bookmarks.getTree()),
      get: async (id) => {
        if (id === 'original' && !changed && (await store.load()).pendingOperation) {
          changed = true;
          original.url = 'https://changed.test/';
        }
        const node = bookmarks.nodes.get(id);
        return node ? [structuredClone(node)] : [];
      },
      move: vi.fn(), create: vi.fn(),
    };
    const instance = new OrganizerService({
      bookmarks: new ChromeBookmarkService(api), store, classifier, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    await store.update((state) => {
      state.jobs.b1 = {
        bookmark: { id: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
        status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-x', duplicateOf: 'original',
      };
    });
    await instance.processPending();

    await expect(instance.approveReview('b1')).rejects.toThrow();

    expect(changed).toBe(true);
    expect(api.move).not.toHaveBeenCalled();
    const state = await store.load();
    expect(state.pendingOperation).toBeUndefined();
    expect(state.reviews.b1?.status).toBe('stale');
    expect(state.jobs.b1?.status).toBe('skipped');
  });

  it.each(['approve', 'reject', 'before-move'] as const)(
    '历史审核在 %s 路径失效后刷新扫描状态并允许重新扫描', async (path) => {
      bookmarks.addFolder('archive', '🗄️ 归档', 'smart-root');
      const original = bookmarks.addBookmark('original', 'Original', 'https://example.com/langgraph', 'smart-root');
      let changedBeforeMove = false;
      const api: BookmarkApi = {
        getTree: vi.fn(async () => bookmarks.getTree()),
        get: async (id) => {
          if (path === 'before-move' && id === 'original' && !changedBeforeMove && (await store.load()).pendingOperation) {
            changedBeforeMove = true;
            original.url = 'https://changed.test/';
          }
          const node = bookmarks.nodes.get(id);
          return node ? [structuredClone(node)] : [];
        },
        move: vi.fn(), create: vi.fn(),
      };
      const chromeBookmarks = new ChromeBookmarkService(api);
      const instance = new OrganizerService({
        bookmarks: chromeBookmarks, store, classifier, notifications,
        alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
      });
      const historicalScan = new ScanService({ scheduleApprovalResume: async () => {},
        bookmarks: chromeBookmarks, store, processPending: () => instance.processPending(),
        approveReview: (id) => instance.approveReview(id), makeId: () => 'next-scan',
      });
      await store.update((state) => {
        state.historicalScan = {
          id: 'scan-x', status: 'scanning', startedAt: 1, updatedAt: 1,
          eligibleTotal: 1, processedCount: 0, pendingReviewCount: 0,
          failedCount: 0, skippedCount: 0, coveredIds: ['b1'],
        };
        state.jobs.b1 = {
          bookmark: { id: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
          status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-x', duplicateOf: 'original',
        };
      });
      await instance.processPending();
      expect((await store.load()).historicalScan).toMatchObject({ status: 'awaiting_review', pendingReviewCount: 1 });
      if (path === 'approve') original.url = 'https://changed.test/';
      if (path === 'reject') bookmarks.nodes.get('b1')!.url = 'https://changed.test/';

      if (path === 'reject') await expect(instance.rejectReview('b1')).rejects.toThrow();
      else await expect(instance.approveReview('b1')).rejects.toThrow();

      const state = await store.load();
      expect(state.reviews.b1?.status).toBe('stale');
      expect(state.jobs.b1?.status).toBe('skipped');
      expect(state.historicalScan).toMatchObject({
        status: 'completed', pendingReviewCount: 0, processedCount: 1, skippedCount: 1,
      });
      expect(state.pendingOperation).toBeUndefined();
      expect(api.move).not.toHaveBeenCalled();
      if (path === 'before-move') expect(changedBeforeMove).toBe(true);
      await expect(historicalScan.startHistoricalScan()).resolves.toMatchObject({ scanId: 'next-scan' });
    },
  );

  it('通知失败后裁剪任务仍保留待审核重复关系，原件变化时拒绝归档', async () => {
    bookmarks.addFolder('archive', '🗄️ 归档', 'smart-root');
    const original = bookmarks.addBookmark('original', 'Original', 'https://example.com/langgraph', 'smart-root');
    const api: BookmarkApi = {
      getTree: vi.fn(async () => bookmarks.getTree()),
      get: async (id) => {
        const node = bookmarks.nodes.get(id);
        return node ? [structuredClone(node)] : [];
      },
      move: vi.fn(), create: vi.fn(),
    };
    const failingNotifications: NotificationPort = {
      ...notifications, reviewNeeded: vi.fn(async () => { throw new Error('notification unavailable'); }),
    };
    const instance = new OrganizerService({
      bookmarks: new ChromeBookmarkService(api), store, classifier, notifications: failingNotifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    await store.update((state) => {
      state.historicalScan = {
        id: 'scan-x', status: 'scanning', startedAt: 1, updatedAt: 1,
        eligibleTotal: 1, processedCount: 0, pendingReviewCount: 0,
        failedCount: 0, skippedCount: 0, coveredIds: ['b1'],
      };
      state.jobs.b1 = {
        bookmark: { id: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
        status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-x', duplicateOf: 'original',
      };
    });
    await instance.processPending();
    expect((await store.load()).reviews.b1?.status).toBe('pending');
    expect((await store.load()).jobs.b1?.status).toBe('failed');
    await store.update((state) => {
      for (let index = 0; index < 250; index += 1) {
        const id = `prune-${index}`;
        state.jobs[id] = {
          bookmark: { id, title: id, url: `https://${id}.test/`, parentId: 'smart-root' },
          status: 'completed', attempts: 0, createdAt: index + 100, updatedAt: index + 100,
        };
      }
      state.jobs.b1!.updatedAt = 1;
      pruneJobs(state);
    });
    original.url = 'https://changed.test/';

    expect((await store.load()).jobs.b1?.duplicateOf).toBe('original');
    await expect(instance.approveReview('b1')).rejects.toThrow();
    expect(api.move).not.toHaveBeenCalled();
    expect((await store.load()).reviews.b1?.status).toBe('stale');
  });

  it('旧待审建议缺少关联任务时保守标记过期而不移动', async () => {
    await store.update((state) => {
      state.historicalScan = {
        id: 'old-scan', status: 'awaiting_review', startedAt: 1, updatedAt: 1,
        eligibleTotal: 1, processedCount: 1, pendingReviewCount: 1,
        failedCount: 0, skippedCount: 0, coveredIds: ['b1'],
      };
      state.reviews.b1 = {
        id: 'b1', bookmarkId: 'b1', title: 'LangGraph guide', url: 'https://example.com/langgraph',
        sourceParentId: 'smart-root', classification: { action: 'move', targetFolderId: 'dev', confidence: 1, reason: 'legacy' },
        source: 'rule', createdAt: 1, status: 'pending', scanId: 'old-scan',
      };
    });

    await expect(organizer.approveReview('b1')).rejects.toThrow();

    const state = await store.load();
    expect(state.reviews.b1?.status).toBe('stale');
    expect(state.historicalScan).toMatchObject({ status: 'completed', pendingReviewCount: 0, processedCount: 1, skippedCount: 1 });
    expect(bookmarks.moves).toHaveLength(0);
    await expect(scan.startHistoricalScan()).resolves.toMatchObject({ scanId: 'scan-test' });
  });

  it('移动请求挂起时 resume 等待已持久化意图，成功后抛错仍保存撤销记录', async () => {
    let releaseMove!: () => void;
    let moveStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { releaseMove = resolve; });
    const started = new Promise<void>((resolve) => { moveStarted = resolve; });
    const api: BookmarkApi = {
      getTree: vi.fn(async () => bookmarks.getTree()),
      get: async (id) => {
        const node = bookmarks.nodes.get(id);
        return node ? [structuredClone(node)] : [];
      },
      move: vi.fn(async (id, destination) => {
        moveStarted();
        await waiting;
        await bookmarks.moveBookmark(id, destination.parentId);
        throw new Error('move result unknown');
      }),
      create: vi.fn(),
    };
    const instance = new OrganizerService({
      bookmarks: new ChromeBookmarkService(api), store, classifier, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
      makeId: (prefix) => `${prefix}-race`,
    });
    const processing = instance.onBookmarkCreated('b1', structuredClone(bookmarks.nodes.get('b1')!));
    await started;
    const resuming = instance.resume();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const during = await store.load();
    releaseMove();
    await Promise.all([processing, resuming]);

    expect(during.pendingOperation).toMatchObject({ bookmarkId: 'b1', fromFolderId: 'smart-root', toFolderId: 'dev' });
    expect(during.jobs.b1?.status).toBe('processing');
    expect(api.move).toHaveBeenCalledOnce();
    const state = await store.load();
    expect(state.pendingOperation).toBeUndefined();
    expect(state.jobs.b1?.status).toBe('completed');
    expect(state.undoStack).toHaveLength(1);
    expect(state.lastUndo).toMatchObject({ bookmarkId: 'b1', fromFolderId: 'smart-root', toFolderId: 'dev' });
    expect((await bookmarks.getBookmark('b1'))?.parentId).toBe('dev');
  });

  it('真实 Chrome 树适配器在最终快照前捕获目录和成员变化并重新分类', async () => {
    const api: BookmarkApi = {
      getTree: vi.fn(async () => bookmarks.getTree()),
      get: async (id) => {
        const node = bookmarks.nodes.get(id);
        return node ? [structuredClone(node)] : [];
      },
      move: vi.fn(), create: vi.fn(),
    };
    const chromeBookmarks = new ChromeBookmarkService(api);
    let calls = 0;
    const classify = vi.fn<ClassifierPort['classify']>(async (input) => {
      calls += 1;
      if (calls === 1) {
        bookmarks.nodes.get('dev')!.title = '更新目录';
        bookmarks.nodes.get('b1')!.title = '更新标题';
        bookmarks.nodes.get('b1')!.url = 'https://changed.test/';
      }
      return { result: { action: 'move', targetFolderId: 'dev', confidence: 0.6, reason: input.url }, source: 'ai' };
    });
    const instance = new OrganizerService({
      bookmarks: chromeBookmarks, store, classifier: { classify }, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });

    await instance.onBookmarkCreated('b1', structuredClone(bookmarks.nodes.get('b1')!));

    expect(classify).toHaveBeenCalledTimes(2);
    expect(classify.mock.calls[1]?.[0]).toMatchObject({ title: '更新标题', url: 'https://changed.test/' });
    expect((await store.load()).reviews.b1).toMatchObject({ title: '更新标题', url: 'https://changed.test/', classification: { reason: 'https://changed.test/' } });
    expect(api.move).not.toHaveBeenCalled();
  });

  it('真实 provider 批量缓存命中后并发降级，最终复核丢弃整批旧缓存', async () => {
    const first = bookmarks.nodes.get('b1')!;
    first.title = 'Unrelated first';
    first.url = 'https://first.test/item';
    const second = bookmarks.addBookmark('b2', 'Unrelated second', 'https://second.test/item', 'smart-root');
    let downgrade = false;
    let provider!: OpenAICompatibleProvider;
    const fetcher = vi.fn<typeof fetch>(async (): Promise<Response> => {
      if (downgrade) {
        downgrade = false;
        return new Response(JSON.stringify({ error: { message: 'unsupported' } }), { status: 400 });
      }
      const reason = provider.getCacheVariant() === 0 ? '旧缓存' : '新变体';
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: [
        { index: 0, action: 'keep', confidence: 0.6, reason: `${reason}-0` },
        { index: 1, action: 'keep', confidence: 0.6, reason: `${reason}-1` },
      ] }) } }] }), { status: 200 });
    });
    provider = new OpenAICompatibleProvider(fetcher);
    const realClassifier = new ClassificationService(provider, store);
    const classify = realClassifier.classifyBatch.bind(realClassifier);
    const classifyBatch = vi.spyOn(realClassifier, 'classifyBatch');
    const instance = new OrganizerService({
      bookmarks, store, classifier: realClassifier, notifications, alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    const enqueue = async () => store.update((state) => {
      for (const node of [first, second]) {
        state.jobs[node.id] = {
          bookmark: { id: node.id, title: node.title, url: node.url!, parentId: node.parentId! },
          status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-batch',
        };
      }
    });
    await enqueue();
    await instance.processPending();
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await store.load()).jobs.b1?.classification?.reason).toBe('旧缓存-0');
    await enqueue();
    let cached = false;
    classifyBatch.mockImplementation(async (...args) => {
      const result = await classify(...args);
      if (result.some((item) => 'result' in item && item.result.source === 'cache')) cached = true;
      return result;
    });
    const getTree = bookmarks.getTree.bind(bookmarks);
    vi.spyOn(bookmarks, 'getTree').mockImplementation(async () => {
      if (cached) {
        cached = false;
        downgrade = true;
        const state = await store.load();
        const folders = getFoldersWithinRoot(await getTree(), state.smartBookmarkRootId!);
        await provider.classifyBatch([
          { title: 'External one', url: 'https://outside.test/one', domain: 'outside.test', currentFolder: folders[0]!.path },
          { title: 'External two', url: 'https://outside.test/two', domain: 'outside.test', currentFolder: folders[0]!.path },
        ], folders, { protocol: state.settings.protocol, baseUrl: state.settings.baseUrl, model: state.settings.model, apiKey: state.settings.apiKey });
      }
      return getTree();
    });

    await instance.processPending();

    const state = await store.load();
    expect(provider.getCacheVariant()).toBeGreaterThan(0);
    expect(classifyBatch).toHaveBeenCalledTimes(3);
    expect(state.jobs.b1).toMatchObject({ status: 'completed', attempts: 1, classificationSource: 'ai', classification: { reason: '新变体-0' } });
    expect(state.jobs.b2).toMatchObject({ status: 'completed', attempts: 1, classificationSource: 'ai', classification: { reason: '新变体-1' } });
    expect(bookmarks.moves).toHaveLength(0);
  });

  it.each(['single', 'batch'] as const)('%s 缓存写入 mutator 前变体失效时有界重试', async (mode) => {
    const second = bookmarks.addBookmark('b2', 'Second', 'https://second.test/item', 'smart-root');
    let current = true;
    let armed = false;
    let calls = 0;
    const outcome = () => {
      calls += 1;
      if (calls === 1) {
        armed = true;
        return { result: { action: 'keep' as const, confidence: 0.6, reason: '旧缓存' }, source: 'cache' as const, cacheValidation: () => current };
      }
      return { result: { action: 'keep' as const, confidence: 0.6, reason: '新结果' }, source: 'ai' as const };
    };
    const classify = vi.fn<ClassifierPort['classify']>(async () => outcome());
    const classifyBatch = vi.fn<NonNullable<ClassifierPort['classifyBatch']>>(async (inputs) => {
      const result = outcome();
      return inputs.map(() => ({ result }));
    });
    const update = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementation((mutator) => update((state) => {
      if (armed) {
        armed = false;
        current = false;
      }
      mutator(state);
    }));
    const instance = new OrganizerService({
      bookmarks, store, classifier: { classify, classifyBatch }, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    if (mode === 'batch') {
      await store.update((state) => {
        for (const node of [bookmarks.nodes.get('b1')!, second]) {
          state.jobs[node.id] = {
            bookmark: { id: node.id, title: node.title, url: node.url!, parentId: node.parentId! },
            status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-batch',
          };
        }
      });
      await instance.processPending();
      expect(classifyBatch).toHaveBeenCalledTimes(2);
    } else {
      await instance.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
      expect(classify).toHaveBeenCalledTimes(2);
    }

    const state = await store.load();
    expect(state.jobs.b1).toMatchObject({ status: 'completed', attempts: 1, classification: { reason: '新结果' } });
    if (mode === 'batch') expect(state.jobs.b2).toMatchObject({ status: 'completed', attempts: 1, classification: { reason: '新结果' } });
    expect(JSON.stringify(state)).not.toContain('cacheValidation');
    expect(state.activities.some((activity) => activity.message === '旧缓存')).toBe(false);
  });

  it.each(['false', 'throw'] as const)('缓存验证返回 %s 时最多重试两次并安全失败', async (behavior) => {
    const classify = vi.fn<ClassifierPort['classify']>(async () => ({
      result: { action: 'move', targetFolderId: 'dev', confidence: 0.99, reason: '旧结果' }, source: 'cache',
      cacheValidation: () => {
        if (behavior === 'throw') throw new Error('private detail');
        return false;
      },
    }));
    const instance = new OrganizerService({
      bookmarks, store, classifier: { classify }, notifications, alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });

    await instance.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);

    expect(classify).toHaveBeenCalledTimes(3);
    const state = await store.load();
    expect(state.jobs.b1).toMatchObject({ status: 'failed', attempts: 2 });
    expect(state.jobs.b1?.classification).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain('private detail');
    expect(bookmarks.moves).toHaveLength(0);
  });

  it('批量缓存部分提交后变体失效，只重试尚未提交的成员', async () => {
    const b2 = bookmarks.addBookmark('b2', 'Second', 'https://second.test/item', 'smart-root');
    const b3 = bookmarks.addBookmark('b3', 'Third', 'https://third.test/item', 'smart-root');
    let variant = 0;
    let calls = 0;
    const classifyBatch = vi.fn<NonNullable<ClassifierPort['classifyBatch']>>(async (inputs) => {
      calls += 1;
      const captured = variant;
      return inputs.map((input) => ({ result: {
        result: { action: 'keep' as const, confidence: 0.6, reason: `${calls === 1 ? '缓存' : '新结果'}-${input.title}` },
        source: calls === 1 ? 'cache' as const : 'ai' as const,
        ...(calls === 1 ? { cacheValidation: () => variant === captured } : {}),
      } }));
    });
    const update = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementation(async (mutator) => {
      const state = await update(mutator);
      if (state.jobs.b1?.status === 'completed' && variant === 0) variant = 1;
      return state;
    });
    const instance = new OrganizerService({
      bookmarks, store, classifier: { classify: vi.fn(), classifyBatch }, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    await store.update((state) => {
      for (const node of [bookmarks.nodes.get('b1')!, b2, b3]) {
        state.jobs[node.id] = {
          bookmark: { id: node.id, title: node.title, url: node.url!, parentId: node.parentId! },
          status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-batch',
        };
      }
    });

    await instance.processPending();

    expect(classifyBatch).toHaveBeenCalledTimes(2);
    expect(classifyBatch.mock.calls[1]?.[0].map((input) => input.title)).toEqual(['Second', 'Third']);
    const state = await store.load();
    expect(state.jobs.b1).toMatchObject({ status: 'completed', attempts: 0, classificationSource: 'cache' });
    expect(state.jobs.b2).toMatchObject({ status: 'completed', attempts: 1, classificationSource: 'ai', classification: { reason: '新结果-Second' } });
    expect(state.jobs.b3).toMatchObject({ status: 'completed', attempts: 1, classificationSource: 'ai', classification: { reason: '新结果-Third' } });
  });

  it('首项为本地规则时，批量缓存失效也会重试整批尚未提交成员', async () => {
    const b2 = bookmarks.addBookmark('b2', 'Second', 'https://second.test/item', 'smart-root');
    let variant = 0;
    let calls = 0;
    const classifyBatch = vi.fn<NonNullable<ClassifierPort['classifyBatch']>>(async (inputs) => {
      calls += 1;
      const captured = variant;
      if (calls === 1) variant += 1;
      return inputs.map((input, index) => ({ result: {
        result: { action: 'keep' as const, confidence: 0.6, reason: `${calls === 1 ? '旧结果' : '新结果'}-${input.title}` },
        source: index === 0 ? 'rule' as const : calls === 1 ? 'cache' as const : 'ai' as const,
        ...(index > 0 && calls === 1 ? { cacheValidation: () => variant === captured } : {}),
      } }));
    });
    const instance = new OrganizerService({
      bookmarks, store, classifier: { classify: vi.fn(), classifyBatch }, notifications,
      alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true,
    });
    await store.update((state) => {
      for (const node of [bookmarks.nodes.get('b1')!, b2]) {
        state.jobs[node.id] = {
          bookmark: { id: node.id, title: node.title, url: node.url!, parentId: node.parentId! },
          status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1, scanId: 'scan-batch',
        };
      }
    });

    await instance.processPending();

    expect(classifyBatch).toHaveBeenCalledTimes(2);
    expect(classifyBatch.mock.calls[1]?.[0]).toHaveLength(2);
    const state = await store.load();
    expect(state.jobs.b1).toMatchObject({ status: 'completed', attempts: 1, classification: { reason: '新结果-LangGraph guide' } });
    expect(state.jobs.b2).toMatchObject({ status: 'completed', attempts: 1, classification: { reason: '新结果-Second' } });
  });

  it('开启外部根接管后处理书签栏新增并支持撤销', async () => {
    await store.update((state) => { state.settings.organizeExternalRoots = true; });
    const node = bookmarks.addBookmark('ext-1', 'External guide', 'https://example.com/ext', 'bar');
    await organizer.onBookmarkCreated('ext-1', node);

    expect(classifier.classify).toHaveBeenCalledOnce();
    expect((await bookmarks.getBookmark('ext-1'))?.parentId).toBe('dev');
    let state = await store.load();
    expect(state.jobs['ext-1']?.externalRoot).toBe(true);

    await organizer.undoLastMove();
    expect((await bookmarks.getBookmark('ext-1'))?.parentId).toBe('bar');
    state = await store.load();
    expect(state.undoStack).toHaveLength(0);
  });

  it('外部根书签低置信度保留原位，确认后移入智能目录', async () => {
    await store.update((state) => { state.settings.organizeExternalRoots = true; });
    result = { action: 'move', targetFolderId: 'dev', confidence: 0.6, reason: '需要确认' };
    const node = bookmarks.addBookmark('ext-2', 'External low', 'https://example.com/low', 'bar');
    await organizer.onBookmarkCreated('ext-2', node);

    expect((await bookmarks.getBookmark('ext-2'))?.parentId).toBe('bar');
    expect((await store.load()).reviews['ext-2']?.status).toBe('pending');
    await organizer.approveReview('ext-2');
    expect((await bookmarks.getBookmark('ext-2'))?.parentId).toBe('dev');
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

  it('拒绝审核写入与纠错、扫描状态位于同一存储更新', async () => {
    await scan.startHistoricalScan();
    const update = store.update.bind(store);
    let rejectionWrites = 0;
    vi.spyOn(store, 'update').mockImplementation((mutator) => update((state) => {
      const wasPending = state.reviews.b1?.status === 'pending';
      mutator(state);
      if (wasPending && state.reviews.b1?.status === 'rejected') {
        rejectionWrites += 1;
        expect(state.jobs.b1?.status).toBe('completed');
        expect(state.corrections['https://example.com/langgraph']).toMatchObject({ action: 'keep', count: 1 });
        expect(state.historicalScan).toMatchObject({ status: 'completed', pendingReviewCount: 0 });
      }
    }));

    await organizer.rejectReview('b1');
    await organizer.rejectReview('b1');

    expect(rejectionWrites).toBe(1);
    expect((await store.load()).corrections['https://example.com/langgraph']?.count).toBe(1);
  });

  it('拒绝审核的状态与纠错写入失败后可重启重试，且重复请求不重复学习', async () => {
    await scan.startHistoricalScan();
    expect((await store.load()).historicalScan).toMatchObject({ status: 'awaiting_review', pendingReviewCount: 1 });
    let interrupted = false;
    const update = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementation((mutator) => update((state) => {
      mutator(state);
      if (!interrupted && state.reviews.b1?.status === 'rejected') {
        interrupted = true;
        throw new Error('storage interrupted');
      }
    }));

    await expect(organizer.rejectReview('b1')).rejects.toThrow('storage interrupted');
    let state = await store.load();
    expect(state.reviews.b1?.status).toBe('pending');
    expect(state.jobs.b1?.status).toBe('pending_review');
    expect(state.corrections).toEqual({});
    expect(state.historicalScan).toMatchObject({ status: 'awaiting_review', pendingReviewCount: 1 });
    const restarted = new OrganizerService({
      bookmarks, store, classifier, notifications, alarms: { schedule: vi.fn() },
      hasProviderPermission: async () => true,
    });
    await restarted.rejectReview('b1');
    await restarted.rejectReview('b1');

    state = await store.load();
    expect(state.reviews.b1?.status).toBe('rejected');
    expect(state.jobs.b1?.status).toBe('completed');
    expect(state.corrections['https://example.com/langgraph']).toMatchObject({ action: 'keep', count: 1 });
    expect(state.historicalScan).toMatchObject({ status: 'completed', pendingReviewCount: 0, processedCount: 1 });
    expect(state.activities.filter((activity) => activity.kind === 'review_rejected')).toHaveLength(1);
  });

  it('历史建议支持批量批准并撤销本批次移动', async () => {
    const { scanId } = await scan.startHistoricalScan();
    expect(bookmarks.moves).toHaveLength(0);
    expect(await scan.approveAllHistoricalReviews(scanId)).toBe(1);
    await scan.resumeApprovals();
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
    await scan.resumeApprovals();
    expect(bookmarks.moves).toEqual([{ id: 'b1', target: 'dev' }]);
  });

  it('Worker 重启后继续处理持久化的历史扫描任务', async () => {
    await store.update((state) => {
      state.historicalScan = {
        id: 'scan-restart', status: 'scanning', startedAt: 1, updatedAt: 1,
        eligibleTotal: 1, processedCount: 0, pendingReviewCount: 0,
        failedCount: 0, skippedCount: 0, coveredIds: ['b1'],
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

    expect(await scan.approveAllHistoricalReviews(scanId)).toBe(1);
    await scan.resumeApprovals();
    expect((await store.load()).reviews.b1?.status).toBe('stale');
    expect(bookmarks.moves).toEqual([{ id: 'b1', target: 'other' }]);
  });
  it('任务上限压力只裁剪无待审的终态，保留活动和待审关联任务', async () => {
    await store.update((state) => {
      for (let index = 0; index < 249; index += 1) {
        const id = `protected-${index}`;
        state.jobs[id] = {
          bookmark: { id, title: id, url: `https://${id}.test/`, parentId: 'smart-root' },
          status: 'pending_review', attempts: 0, createdAt: index, updatedAt: index,
        };
      }
      for (const [id, status] of [
        ['failed-review', 'failed'], ['active-processing', 'processing'], ['active-queued', 'queued'],
        ['active-key', 'awaiting_configuration'], ['active-permission', 'awaiting_permission'],
        ['terminal', 'completed'],
      ] as const) {
        state.jobs[id] = {
          bookmark: { id, title: id, url: `https://${id}.test/`, parentId: 'smart-root' },
          status, attempts: 0, createdAt: 1, updatedAt: 1,
        };
      }
      state.reviews['failed-review'] = {
        id: 'failed-review', bookmarkId: 'failed-review', title: 'failed-review', url: 'https://failed-review.test/',
        sourceParentId: 'smart-root', classification: { action: 'keep', confidence: 0.7, reason: 'test' },
        source: 'rule', createdAt: 1, status: 'pending',
      };
      pruneJobs(state);
    });

    const jobs = (await store.load()).jobs;
    expect(jobs['terminal']).toBeUndefined();
    for (const id of ['failed-review', 'active-processing', 'active-queued', 'active-key', 'active-permission']) expect(jobs[id]).toBeDefined();
    expect(Object.keys(jobs)).toHaveLength(254);
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
