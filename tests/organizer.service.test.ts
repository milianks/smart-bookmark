import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassifierPort } from '../services/classifier.service';
import type { BookmarkNode, BookmarkPort } from '../services/bookmark.service';
import type { NotificationPort } from '../services/notification.service';
import { OrganizerService } from '../services/organizer.service';
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
    this.addFolder('dev', '开发', 'bar');
    this.addFolder('nested', '稍后阅读', 'dev');
    this.addBookmark('b1', 'LangGraph guide', 'https://example.com/langgraph', 'bar');
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
  let result: ClassificationResult;

  beforeEach(async () => {
    bookmarks = new FakeBookmarks();
    store = new MemoryStateRepository();
    await store.update((state) => { state.settings.apiKey = 'test-key'; });
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
  });

  it('自动移动高置信度的已有目录建议，并保存撤销记录', async () => {
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    expect(bookmarks.moves).toEqual([{ id: 'b1', target: 'dev' }]);
    expect((await store.load()).lastUndo).toMatchObject({ bookmarkId: 'b1', fromFolderId: 'bar', toFolderId: 'dev' });
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
    expect((await bookmarks.getBookmark('b1'))?.parentId).toBe('bar');
    expect((await store.load()).reviews['b1']?.status).toBe('rejected');
  });

  it('AI 失败时书签留在原位并记录失败', async () => {
    classifier.classify = vi.fn(async () => { throw new Error('provider unavailable'); });
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    expect(bookmarks.moves).toHaveLength(0);
    expect((await bookmarks.getBookmark('b1'))?.parentId).toBe('bar');
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
    expect((await bookmarks.getBookmark('b1'))?.parentId).toBe('bar');
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
    expect(bookmarks.moves.at(-1)).toEqual({ id: 'b1', target: 'bar' });
    expect((await bookmarks.getBookmark('b1'))?.parentId).toBe('bar');
    expect((await store.load()).lastUndo).toBeUndefined();
  });

  it('默认保留保存到自建文件夹中的书签', async () => {
    const bookmark = bookmarks.addBookmark('nested-bookmark', 'Article', 'https://example.com/article', 'nested');
    await organizer.onBookmarkCreated(bookmark.id, bookmark);
    expect(classifier.classify).not.toHaveBeenCalled();
    expect((await bookmarks.getBookmark(bookmark.id))?.parentId).toBe('nested');
  });

  it('缺少 API Key 时持久化等待状态，配置后恢复处理', async () => {
    await store.update((state) => { state.settings.apiKey = ''; });
    await organizer.onBookmarkCreated('b1', bookmarks.nodes.get('b1')!);
    expect((await store.load()).jobs.b1?.status).toBe('awaiting_configuration');
    await organizer.updateSettings({ apiKey: 'test-key' });
    expect(bookmarks.moves).toEqual([{ id: 'b1', target: 'dev' }]);
  });
});
