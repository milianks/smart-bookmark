import { describe, expect, it, vi } from 'vitest';
import { emptyPersistedState } from '../types/domain';
import { MemoryStateRepository } from '../lib/storage/repository';
import type { BookmarkNode, BookmarkPort } from '../services/bookmark.service';
import { ScanService } from '../services/scan.service';

const tree: BookmarkNode[] = [{ id: 'root', title: '', children: [{
  id: 'bar', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
    { id: 'smart-root', title: 'bookmark 的智能书签', parentId: 'bar', children: [
      { id: 'b1', title: 'Bookmark', url: 'https://example.test/a', parentId: 'smart-root' },
    ] },
  ],
}] }];
const bookmarks: BookmarkPort = {
  getTree: async () => structuredClone(tree), getBookmark: async () => null, getFolder: async () => null,
  getFolders: async () => [], getFolderPath: async () => null, folderExists: async () => false,
  isEligibleRoot: async () => true, moveBookmark: async () => {}, createFolder: async () => tree[0]!,
};

describe('ScanService', () => {
  it('persists preview jobs and rejects concurrent start while processing', async () => {
    const store = new MemoryStateRepository();
    await store.update((state) => { state.smartBookmarkRootId = 'smart-root'; state.smartBookmarkInitialized = true; });
    let unblock!: () => void;
    const pending = new Promise<void>((resolve) => { unblock = resolve; });
    const scan = new ScanService({ bookmarks, store, processPending: async () => pending, approveReview: async () => {}, makeId: () => 'scan-1' });
    const start = scan.startHistoricalScan();
    await expect(scan.startHistoricalScan()).rejects.toThrow('已有历史扫描正在启动');
    unblock();
    await expect(start).resolves.toEqual({ scanId: 'scan-1', eligibleTotal: 1 });
    const state = await store.load();
    expect(state.historicalScan?.status).toBe('scanning');
    expect(state.jobs.b1).toMatchObject({ scanId: 'scan-1', status: 'awaiting_configuration' });
    await expect(scan.startHistoricalScan()).rejects.toThrow('已有历史扫描正在进行');
  });

  it('refreshes state and holds batch lock while delegating approved items', async () => {
    const initial = emptyPersistedState();
    initial.settings.apiKey = 'key';
    initial.smartBookmarkRootId = 'smart-root';
    initial.smartBookmarkInitialized = true;
    const store = new MemoryStateRepository(initial);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const approveReview = vi.fn(async (id: string) => {
      await gate;
      await store.update((state) => { state.reviews[id]!.status = 'approved'; state.jobs[id]!.status = 'completed'; });
    });
    const scan = new ScanService({ bookmarks, store, processPending: async () => {}, approveReview, makeId: () => 'scan-2' });
    const started = await scan.startHistoricalScan();
    await store.update((state) => {
      state.jobs.b1!.status = 'pending_review';
      state.reviews.b1 = {
        id: 'b1', bookmarkId: 'b1', title: 'Bookmark', url: 'https://example.test/a', sourceParentId: 'bar',
        classification: { action: 'move', targetFolderId: 'target', confidence: 0.9, reason: 'test' },
        source: 'ai', createdAt: 1, status: 'pending', scanId: started.scanId,
      };
      state.historicalScan!.status = 'awaiting_review';
    });
    const first = scan.approveAllHistoricalReviews(started.scanId);
    await expect(scan.approveAllHistoricalReviews(started.scanId)).rejects.toThrow('历史批量审批正在进行');
    release();
    expect(await first).toBe(1);
    expect(approveReview).toHaveBeenCalledOnce();
    const state = await store.load();
    expect(state.historicalScan?.processedCount).toBe(1);
    expect(state.historicalScan?.status).toBe('completed');
  });

  it.each(['pending', 'approving'] as const)('旧数据的孤立 %s 审核阻止扫描提前完成', async (status) => {
    const initial = emptyPersistedState();
    initial.historicalScan = {
      id: 'legacy', status: 'scanning', startedAt: 1, updatedAt: 1,
      eligibleTotal: 1, processedCount: 0, pendingReviewCount: 0,
      failedCount: 0, skippedCount: 0, coveredIds: ['b1'], forceOrganize: false,
    };
    initial.reviews.b1 = {
      id: 'b1', bookmarkId: 'b1', title: 'Bookmark', url: 'https://example.test/a', sourceParentId: 'smart-root',
      classification: { action: 'keep', confidence: 0.7, reason: 'test' }, source: 'rule',
      createdAt: 1, status, scanId: 'legacy',
    };
    const store = new MemoryStateRepository(initial);
    const scan = new ScanService({ bookmarks, store, processPending: async () => {}, approveReview: async () => {} });

    await scan.refresh('legacy');

    expect((await store.load()).historicalScan).toMatchObject({
      status: 'awaiting_review', processedCount: 1, pendingReviewCount: 1, skippedCount: 0,
    });
  });

  it('重复 URL 归并标记 duplicateOf，保留最早添加的一条', async () => {
    const dupTree: BookmarkNode[] = [{ id: 'root', title: '', children: [{
      id: 'bar', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
        { id: 'smart-root', title: 'bookmark 的智能书签', parentId: 'bar', children: [
          { id: 'a1', title: 'Docs', url: 'https://example.test/docs', parentId: 'smart-root', dateAdded: 100 },
          { id: 'a2', title: 'Docs again', url: 'https://example.test/docs#section', parentId: 'smart-root', dateAdded: 200 },
          { id: 'a3', title: 'Docs third', url: 'https://example.test/docs/', parentId: 'smart-root', dateAdded: 300 },
          { id: 'u1', title: 'Unique', url: 'https://example.test/unique', parentId: 'smart-root' },
          { id: 'archive', title: '🗄️ 归档', parentId: 'smart-root', children: [] },
        ] },
      ],
}] }];
    const store = new MemoryStateRepository();
    await store.update((state) => {
      state.smartBookmarkRootId = 'smart-root';
      state.smartBookmarkInitialized = true;
      state.settings.apiKey = 'key';
    });
    const scanBookmarks: BookmarkPort = {
      ...bookmarks,
      getTree: async () => structuredClone(dupTree),
      getFoldersWithinRoot: async () => [{ id: 'archive', name: '🗄️ 归档', path: 'bookmark 的智能书签 / 🗄️ 归档' }],
    };
    const scan = new ScanService({
      bookmarks: scanBookmarks, store, processPending: async () => {},
      approveReview: async () => {}, makeId: () => 'scan-3',
    });

    const started = await scan.startHistoricalScan();

    expect(started).toEqual({ scanId: 'scan-3', eligibleTotal: 4 });
    const state = await store.load();
    expect(state.jobs.a1?.duplicateOf).toBeUndefined();
    expect(state.jobs.a2?.duplicateOf).toBe('a1');
    expect(state.jobs.a3?.duplicateOf).toBe('a1');
    expect(state.jobs.u1?.duplicateOf).toBeUndefined();
  });
});
