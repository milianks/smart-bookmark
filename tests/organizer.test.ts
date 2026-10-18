import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, emptyPersistedState, type ClassificationResult, type FolderSummary } from '../types/domain';
import { MemoryStateRepository } from '../lib/storage/repository';
import type { BookmarkNode, BookmarkPort } from '../services/bookmark.service';
import { PermissionRequiredError, type ClassifierPort } from '../services/classifier.service';
import { ProviderError } from '../lib/ai/openai-compatible';
import type { NotificationPort } from '../services/notification.service';
import { OrganizerService } from '../services/organizer.service';
import { SettingsService } from '../services/settings.service';

const MOVE_RESULT: ClassificationResult = {
  action: 'move', targetFolderId: 'folder-dev', confidence: 0.95, reason: '与开发主题匹配。',
};

describe('OrganizerService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('高置信度匹配已有目录后自动移动并保存撤销记录', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());

    expect(h.bookmarks.parents.get('bookmark-1')).toBe('folder-dev');
    const state = await h.store.load();
    expect(state.lastUndo?.fromFolderId).toBe('smart-root');
    expect(state.lastUndo?.toFolderId).toBe('folder-dev');
    expect(state.jobs['bookmark-1']?.status).toBe('completed');
  });

  it('没有匹配文件夹时只创建待确认建议，不直接创建或移动', async () => {
    const suggestion: ClassificationResult = {
      action: 'suggest_folder',
      suggestedFolder: { name: '研究资料', parentId: 'smart-root' },
      confidence: 0.78,
      reason: '现有目录没有合适的研究主题。',
    };
    const h = createHarness({ result: suggestion, source: 'ai' });
    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());

    expect(h.bookmarks.parents.get('bookmark-1')).toBe('smart-root');
    expect(h.bookmarks.createdFolders).toHaveLength(0);
    expect((await h.store.load()).reviews['bookmark-1']?.status).toBe('pending');
    expect(h.notifications.reviewNeeded).toHaveBeenCalledOnce();
  });

  it('用户确认后幂等创建建议文件夹并移动书签', async () => {
    const suggestion: ClassificationResult = {
      action: 'suggest_folder',
      suggestedFolder: { name: '研究资料', parentId: 'smart-root' },
      confidence: 0.76,
      reason: '需要单独的研究分类。',
    };
    const h = createHarness({ result: suggestion, source: 'ai' });
    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());
    await h.organizer.approveReview('bookmark-1');
    await h.organizer.approveReview('bookmark-1');

    expect(h.bookmarks.createdFolders).toHaveLength(1);
    expect(h.bookmarks.parents.get('bookmark-1')).toBe(h.bookmarks.createdFolders[0]?.id);
    expect((await h.store.load()).reviews['bookmark-1']?.status).toBe('approved');
  });

  it('用户拒绝建议后书签保持原位', async () => {
    const h = createHarness({
      result: { action: 'suggest_folder', suggestedFolder: { name: '研究', parentId: 'smart-root' }, confidence: 0.7, reason: '新主题。' },
      source: 'ai',
    });
    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());
    await h.organizer.rejectReview('bookmark-1');

    expect(h.bookmarks.parents.get('bookmark-1')).toBe('smart-root');
    expect(h.bookmarks.createdFolders).toHaveLength(0);
    expect((await h.store.load()).reviews['bookmark-1']?.status).toBe('rejected');
  });

  it('AI 失败时标记失败且不移动书签', async () => {
    const h = createHarness({ error: new ProviderError('AI 分类结果不符合安全格式', false) });
    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());

    expect(h.bookmarks.parents.get('bookmark-1')).toBe('smart-root');
    expect((await h.store.load()).jobs['bookmark-1']?.status).toBe('failed');
    expect(h.notifications.processingFailed).toHaveBeenCalledOnce();
  });

  it('缺少 API 来源权限时进入等待，不会自触发重试；授权后恢复分类', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    h.hasProviderPermission.mockResolvedValue(false);
    vi.mocked(h.classifier.classify).mockImplementation(async (_input, _folders, _settings, hasPermission) => {
      if (!hasPermission) throw new PermissionRequiredError();
      return { result: MOVE_RESULT, source: 'ai' };
    });

    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.classifier.classify).toHaveBeenCalledOnce();
    expect((await h.store.load()).jobs['bookmark-1']?.status).toBe('awaiting_permission');
    expect(h.notifications.processingFailed).toHaveBeenCalledOnce();

    h.hasProviderPermission.mockResolvedValue(true);
    await h.organizer.resume();

    expect(h.classifier.classify).toHaveBeenCalledTimes(2);
    expect(h.bookmarks.parents.get('bookmark-1')).toBe('folder-dev');
  });

  it('书签移动 API 抛错后立即清理意图，不阻塞同一 Worker 的后续移动', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    h.bookmarks.failNextMove = true;

    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());

    let state = await h.store.load();
    expect(h.bookmarks.parents.get('bookmark-1')).toBe('smart-root');
    expect(state.pendingOperation).toBeUndefined();
    expect(state.jobs['bookmark-1']?.status).toBe('failed');

    h.bookmarks.addBookmark('bookmark-2');
    await h.organizer.onBookmarkCreated('bookmark-2', bookmarkEvent());

    state = await h.store.load();
    expect(h.bookmarks.parents.get('bookmark-2')).toBe('folder-dev');
    expect(state.pendingOperation).toBeUndefined();
    expect(state.jobs['bookmark-2']?.status).toBe('completed');
    expect(h.bookmarks.moveCount).toBe(1);
  });

  it('移动已生效但 API 随后抛错时按实际目录恢复完成状态', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    h.bookmarks.failAfterNextMove = true;

    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());

    const state = await h.store.load();
    expect(h.bookmarks.parents.get('bookmark-1')).toBe('folder-dev');
    expect(h.bookmarks.moveCount).toBe(1);
    expect(state.jobs['bookmark-1']?.status).toBe('completed');
    expect(state.lastUndo).toMatchObject({ fromFolderId: 'smart-root', toFolderId: 'folder-dev' });
    expect(state.pendingOperation).toBeUndefined();
  });

  it('瞬时 Provider 错误最多重试两次，耗尽后保持书签原位', async () => {
    const h = createHarness({ error: new ProviderError('AI 服务暂时不可用', true) });

    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());
    let state = await h.store.load();
    expect(state.jobs['bookmark-1']?.status).toBe('queued');
    expect(state.jobs['bookmark-1']?.attempts).toBe(1);

    h.setNow(1_700_000_002_000);
    await h.organizer.resume();
    state = await h.store.load();
    expect(state.jobs['bookmark-1']?.status).toBe('queued');
    expect(state.jobs['bookmark-1']?.attempts).toBe(2);

    h.setNow(1_700_000_005_100);
    await h.organizer.resume();
    state = await h.store.load();
    expect(state.jobs['bookmark-1']?.status).toBe('failed');
    expect(state.jobs['bookmark-1']?.attempts).toBe(2);
    expect(h.classifier.classify).toHaveBeenCalledTimes(3);
    expect(h.bookmarks.parents.get('bookmark-1')).toBe('smart-root');
    expect(h.bookmarks.moveCount).toBe(0);
  });

  it.each([
    ['切换为每次确认模式', (state: ReturnType<typeof emptyPersistedState>) => { state.settings.mode = 'confirm'; }],
    ['提高置信度阈值', (state: ReturnType<typeof emptyPersistedState>) => { state.settings.confidenceThreshold = 1; }],
  ])('AI 请求进行期间用户%s时，不自动移动', async (_description, changePolicy) => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    vi.mocked(h.classifier.classify).mockImplementationOnce(async () => {
      await h.store.update(changePolicy);
      return { result: MOVE_RESULT, source: 'ai' };
    });

    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());

    expect(h.bookmarks.parents.get('bookmark-1')).toBe('smart-root');
    expect(h.bookmarks.moveCount).toBe(0);
    expect((await h.store.load()).reviews['bookmark-1']?.status).toBe('pending');
    expect((await h.store.load()).pendingOperation).toBeUndefined();
  });

  it('持久化移动意图后重新检查策略，避免使用过期自动模式', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    const getFolderPath = h.bookmarks.getFolderPath.bind(h.bookmarks);
    vi.spyOn(h.bookmarks, 'getFolderPath').mockImplementation(async (id) => {
      await h.store.update((state) => { state.settings.mode = 'confirm'; });
      return getFolderPath(id);
    });

    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());

    expect(h.bookmarks.parents.get('bookmark-1')).toBe('smart-root');
    expect(h.bookmarks.moveCount).toBe(0);
    expect((await h.store.load()).reviews['bookmark-1']?.status).toBe('pending');
    expect((await h.store.load()).pendingOperation).toBeUndefined();
  });

  it('持久化移动意图后发现书签已离开合格来源目录时不执行移动', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    const getFolderPath = h.bookmarks.getFolderPath.bind(h.bookmarks);
    vi.spyOn(h.bookmarks, 'getFolderPath').mockImplementation(async (id) => {
      h.bookmarks.parents.set('bookmark-1', 'user-folder');
      return getFolderPath(id);
    });

    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());

    expect(h.bookmarks.parents.get('bookmark-1')).toBe('user-folder');
    expect(h.bookmarks.moveCount).toBe(0);
    expect((await h.store.load()).jobs['bookmark-1']?.status).toBe('skipped');
    expect((await h.store.load()).pendingOperation).toBeUndefined();
  });

  it('调用移动 API 前再次验证来源，避免覆盖刚发生的手动移动', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    const getBookmark = h.bookmarks.getBookmark.bind(h.bookmarks);
    let reads = 0;
    vi.spyOn(h.bookmarks, 'getBookmark').mockImplementation(async (id) => {
      reads += 1;
      if (reads === 4) h.bookmarks.parents.set(id, 'user-folder');
      return getBookmark(id);
    });

    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());

    const state = await h.store.load();
    expect(h.bookmarks.parents.get('bookmark-1')).toBe('user-folder');
    expect(h.bookmarks.moveCount).toBe(0);
    expect(state.pendingOperation).toBeUndefined();
    expect(state.jobs['bookmark-1']?.status).toBe('skipped');
  });

  it('Chrome 原生导入期间抑制新增书签分类', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    await h.organizer.onImportBegan();
    await h.organizer.onBookmarkCreated('imported', bookmarkEvent());
    expect(h.classifier.classify).not.toHaveBeenCalled();
    expect((await h.store.load()).jobs.imported).toBeUndefined();
    await h.organizer.onImportEnded();
    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());
    expect(h.classifier.classify).toHaveBeenCalledOnce();
  });

  it('分类目标文件夹在移动前被删除时安全失败', async () => {
    const h = createHarness({ result: { ...MOVE_RESULT, targetFolderId: 'deleted-folder' }, source: 'ai' });
    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());

    expect(h.bookmarks.parents.get('bookmark-1')).toBe('smart-root');
    expect((await h.store.load()).jobs['bookmark-1']?.status).toBe('failed');
  });

  it('AI 返回智能书签目录外的目标时拒绝移动', async () => {
    const h = createHarness({ result: { ...MOVE_RESULT, targetFolderId: 'user-folder' }, source: 'ai' });
    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());

    expect(h.bookmarks.parents.get('bookmark-1')).toBe('smart-root');
    expect(h.bookmarks.moveCount).toBe(0);
    expect((await h.store.load()).jobs['bookmark-1']?.status).toBe('failed');
  });

  it('重复和并发 onCreated 事件只分类和移动一次', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai', classifyDelay: 5 });
    await Promise.all([
      h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent()),
      h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent()),
    ]);

    expect(h.classifier.classify).toHaveBeenCalledOnce();
    expect(h.bookmarks.moveCount).toBe(1);
  });

  it('不同新增书签并发时也限制 AI 分类并发数', async () => {
    const h = createHarness({ result: { action: 'keep', confidence: 0.5, reason: '保留。' }, source: 'ai' });
    hAddBookmark(h.bookmarks, 'bookmark-2');
    hAddBookmark(h.bookmarks, 'bookmark-3');
    let active = 0;
    let maxActive = 0;
    vi.mocked(h.classifier.classify).mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { result: { action: 'keep', confidence: 0.5, reason: '保留。' }, source: 'ai' };
    });

    await Promise.all([
      h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent()),
      h.organizer.onBookmarkCreated('bookmark-2', bookmarkEvent()),
      h.organizer.onBookmarkCreated('bookmark-3', bookmarkEvent()),
    ]);
    await h.organizer.processPending();

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(h.classifier.classify).toHaveBeenCalledTimes(3);
  });

  it('撤销最近自动归档并恢复到原始文件夹', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());
    await expect(h.organizer.undoLastMove()).resolves.toBe('LangGraph Agent Guide');

    expect(h.bookmarks.parents.get('bookmark-1')).toBe('smart-root');
    expect((await h.store.load()).lastUndo).toBeUndefined();
  });

  it('Worker 重启后恢复持久化中的 processing 任务', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    await h.store.update((state) => {
      state.jobs['bookmark-1'] = {
        bookmark: { id: 'bookmark-1', title: 'LangGraph Agent Guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
        status: 'processing', attempts: 0, createdAt: 1, updatedAt: 1,
      };
    });
    const restarted = new OrganizerService({
      bookmarks: h.bookmarks,
      store: h.store,
      classifier: h.classifier,
      notifications: h.notifications,
      alarms: { schedule: vi.fn() },
      hasProviderPermission: vi.fn(async () => true),
    });

    await restarted.resume();

    expect(h.bookmarks.parents.get('bookmark-1')).toBe('folder-dev');
    expect((await h.store.load()).jobs['bookmark-1']?.status).toBe('completed');
  });

  it('Worker 重启时对已完成的 pending move intent 只补记撤销记录，不重复移动', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    h.bookmarks.parents.set('bookmark-1', 'folder-dev');
    await h.store.update((state) => {
      state.jobs['bookmark-1'] = {
        bookmark: { id: 'bookmark-1', title: 'LangGraph Agent Guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
        status: 'processing', attempts: 0, createdAt: 1, updatedAt: 1,
      };
      state.pendingOperation = {
        bookmarkId: 'bookmark-1', title: 'LangGraph Agent Guide',
        fromFolderId: 'smart-root', toFolderId: 'folder-dev', movedAt: 2,
        operationId: 'op-recovery', state: 'prepared', kind: 'automatic',
      };
    });
    const restarted = new OrganizerService({
      bookmarks: h.bookmarks,
      store: h.store,
      classifier: h.classifier,
      notifications: h.notifications,
      alarms: { schedule: vi.fn() },
      hasProviderPermission: vi.fn(async () => true),
    });

    await restarted.resume();

    const state = await h.store.load();
    expect(h.bookmarks.moveCount).toBe(0);
    expect(state.pendingOperation).toBeUndefined();
    expect(state.jobs['bookmark-1']?.status).toBe('completed');
    expect(state.lastUndo).toMatchObject({ fromFolderId: 'smart-root', toFolderId: 'folder-dev' });
  });

  it('缺少 API Key 时持久化等待任务，配置后恢复分类', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai', apiKey: '' });
    await h.organizer.onBookmarkCreated('bookmark-1', bookmarkEvent());
    expect((await h.store.load()).jobs['bookmark-1']?.status).toBe('awaiting_configuration');
    expect(h.classifier.classify).not.toHaveBeenCalled();

    await new SettingsService({
      store: h.store, classifier: h.classifier, hasProviderPermission: h.hasProviderPermission,
      afterUpdate: () => h.organizer.resume(),
    }).updateSettings({ apiKey: 'test-key' });
    expect(h.classifier.classify).toHaveBeenCalledOnce();
    expect(h.bookmarks.parents.get('bookmark-1')).toBe('folder-dev');
  });

  it('默认保留用户自建目录内的新增书签', async () => {
    const h = createHarness({ result: MOVE_RESULT, source: 'ai' });
    await h.organizer.onBookmarkCreated('nested-bookmark', bookmarkEvent('user-folder'));
    expect((await h.store.load()).jobs['nested-bookmark']).toBeUndefined();
    expect(h.classifier.classify).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  result?: ClassificationResult;
  source?: 'cache' | 'rule' | 'ai';
  error?: Error;
  apiKey?: string;
  classifyDelay?: number;
}) {
  const initial = emptyPersistedState();
  initial.settings = { ...DEFAULT_SETTINGS, apiKey: options.apiKey ?? 'test-key' };
  initial.smartBookmarkRootId = 'smart-root';
  initial.smartBookmarkInitialized = true;
  const store = new MemoryStateRepository(initial);
  const bookmarks = new FakeBookmarks();
  let now = 1_700_000_000_000;
  const classifier: ClassifierPort = {
    classify: vi.fn(async () => {
      if (options.classifyDelay) await new Promise((resolve) => setTimeout(resolve, options.classifyDelay));
      if (options.error) throw options.error;
      return { result: options.result ?? { action: 'keep', confidence: 0.5, reason: '保留。' }, source: options.source ?? 'ai' };
    }),
    testProvider: vi.fn(async () => undefined),
  };
  const notifications: NotificationPort = {
    reviewNeeded: vi.fn(async () => undefined),
    processingFailed: vi.fn(async () => undefined),
    moved: vi.fn(async () => undefined),
  };
  const hasProviderPermission = vi.fn(async (_baseUrl: string) => true);
  const organizer = new OrganizerService({
    bookmarks,
    store,
    classifier,
    notifications,
    alarms: { schedule: vi.fn() },
    hasProviderPermission,
    now: () => now,
    makeId: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
  });
  return { organizer, store, bookmarks, classifier, notifications, hasProviderPermission, setNow: (value: number) => { now = value; } };
}

function bookmarkEvent(parentId = 'smart-root'): BookmarkNode {
  return { id: 'bookmark-1', title: 'LangGraph Agent Guide', url: 'https://example.com/langgraph', parentId, dateAdded: 1 };
}

class FakeBookmarks implements BookmarkPort {
  readonly parents = new Map<string, string>([['bookmark-1', 'smart-root']]);
  readonly createdFolders: BookmarkNode[] = [];
  moveCount = 0;
  failNextMove = false;
  failAfterNextMove = false;
  private readonly nodes: BookmarkNode[] = [
    { id: 'root', title: '', children: [
      { id: 'bookmarks-bar', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
        { id: 'smart-root', title: 'yuan 的智能书签', parentId: 'bookmarks-bar', children: [
          { id: 'folder-dev', title: 'Development Programming', parentId: 'smart-root', children: [] },
          { id: 'bookmark-1', title: 'LangGraph Agent Guide', url: 'https://example.com/langgraph', parentId: 'smart-root' },
        ] },
      ] },
      { id: 'other', title: 'Other bookmarks', folderType: 'other', children: [] },
      { id: 'user-folder', title: 'Personal', parentId: 'bookmarks-bar', children: [] },
    ] },
  ];

  async getTree(): Promise<BookmarkNode[]> { return structuredClone(this.nodes); }
  async getBookmark(id: string): Promise<BookmarkNode | null> {
    const node = findNode(this.nodes, id);
    if (!node?.url) return null;
    return { ...structuredClone(node), parentId: this.parents.get(id) ?? node.parentId };
  }
  async getFolder(id: string): Promise<BookmarkNode | null> { const node = findNode(this.nodes, id); return node && !node.url ? node : null; }
  async getFolders(): Promise<FolderSummary[]> {
    const folders: FolderSummary[] = [];
    const walk = (node: BookmarkNode, ancestors: string[]) => {
      const path = node.title ? [...ancestors, node.title] : ancestors;
      if (!node.url && node.children !== undefined) folders.push({ id: node.id, name: node.title, path: path.join(' / '), parentId: node.parentId, folderType: node.folderType });
      for (const child of node.children ?? []) walk(child, path);
    };
    for (const node of this.nodes) walk(node, []);
    return folders;
  }
  async getFolderPath(id: string): Promise<string | null> { return (await this.getFolders()).find((folder) => folder.id === id)?.path ?? null; }
  async folderExists(id: string): Promise<boolean> { return Boolean(await this.getFolder(id)); }
  async isEligibleRoot(id: string): Promise<boolean> { return ['bookmarks-bar', 'other', 'mobile'].includes((await this.getFolder(id))?.folderType ?? ''); }
  async isWithinRoot(nodeId: string, rootId: string): Promise<boolean> {
    if (rootId !== 'smart-root') return false;
    if (nodeId === rootId) return true;
    let current = findNode(this.nodes, nodeId);
    let parentId = this.parents.get(nodeId) ?? current?.parentId;
    while (parentId) {
      if (parentId === rootId) return true;
      current = findNode(this.nodes, parentId);
      parentId = current?.parentId;
    }
    return false;
  }
  async getFoldersWithinRoot(rootId: string): Promise<FolderSummary[]> {
    if (rootId !== 'smart-root') return [];
    return (await this.getFolders()).filter((folder) => folder.id === 'smart-root' || folder.id === 'folder-dev' || folder.id.startsWith('created-'));
  }
  async isValidTargetFolder(targetFolderId: string, rootId: string): Promise<boolean> {
    return (await this.getFoldersWithinRoot(rootId)).some((folder) => folder.id === targetFolderId);
  }
  async moveBookmark(bookmarkId: string, targetFolderId: string): Promise<void> {
    if (!await this.folderExists(targetFolderId)) throw new Error('missing folder');
    if (this.failNextMove) {
      this.failNextMove = false;
      throw new Error('move failed');
    }
    this.parents.set(bookmarkId, targetFolderId);
    this.moveCount += 1;
    if (this.failAfterNextMove) {
      this.failAfterNextMove = false;
      throw new Error('move result unknown');
    }
  }
  async createFolder(name: string, parentId: string): Promise<BookmarkNode> {
    const folder = { id: `created-${this.createdFolders.length + 1}`, title: name, parentId, children: [] };
    const parent = findNode(this.nodes, parentId);
    if (!parent?.children) throw new Error('missing parent');
    parent.children.push(folder);
    this.createdFolders.push(folder);
    return folder;
  }
  addBookmark(id: string): void {
    const parent = findNode(this.nodes, 'smart-root');
    parent?.children?.push({ id, title: `Bookmark ${id}`, url: `https://example.com/${id}`, parentId: 'smart-root' });
    this.parents.set(id, 'smart-root');
  }
}

function findNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = node.children ? findNode(node.children, id) : undefined;
    if (child) return child;
  }
  return undefined;
}

function hAddBookmark(bookmarks: FakeBookmarks, id: string): void {
  bookmarks.addBookmark(id);
}
