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
    const scan = new ScanService({ scheduleApprovalResume: async () => {}, bookmarks, store, processPending: async () => pending, approveReview: async () => {}, makeId: () => 'scan-1' });
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
    const scan = new ScanService({ scheduleApprovalResume: async () => {}, bookmarks, store, processPending: async () => {}, approveReview, makeId: () => 'scan-2' });
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
    expect(await scan.approveAllHistoricalReviews(started.scanId)).toBe(1);
    expect(approveReview).not.toHaveBeenCalled();
    await expect(scan.approveAllHistoricalReviews(started.scanId)).rejects.toThrow('历史批量审批正在进行');
    const processing = scan.resumeApprovals();
    release();
    await processing;
    expect(approveReview).toHaveBeenCalledOnce();
    const state = await store.load();
    expect(state.historicalScan?.processedCount).toBe(1);
    expect(state.historicalScan?.status).toBe('completed');
  });

  it('checkpoints ten approvals per wake and resumes the remainder after a worker restart', async () => {
    const initial = emptyPersistedState();
    for (let index = 0; index < 23; index += 1) {
      const id = `b${index}`;
      initial.reviews[id] = {
        id, bookmarkId: id, title: id, url: `https://example.test/${id}`, sourceParentId: 'smart-root',
        classification: { action: 'move', targetFolderId: 'target', confidence: 0.9, reason: 'test' },
        source: 'ai', createdAt: index, status: 'pending', scanId: 'scan-batch',
      };
    }
    const store = new MemoryStateRepository(initial);
    const scheduleApprovalResume = vi.fn(async () => {});
    const approveReview = vi.fn(async (id: string) => {
      if (id === 'b4') throw new Error('move failed');
      await store.update((state) => { state.reviews[id]!.status = 'approved'; });
    });
    const deps = { bookmarks, store, approveReview, scheduleApprovalResume, processPending: async () => {} };
    const scan = new ScanService(deps);
    expect(await scan.approveAllHistoricalReviews('scan-batch')).toBe(23);
    expect(approveReview).not.toHaveBeenCalled();
    await scan.resumeApprovals();
    expect(approveReview).toHaveBeenCalledTimes(10);
    expect((await store.load()).historicalApproval?.reviewIds).toHaveLength(13);
    const restarted = new ScanService(deps);
    await restarted.resumeApprovals();
    expect(approveReview).toHaveBeenCalledTimes(20);
    await restarted.resumeApprovals();
    expect(approveReview).toHaveBeenCalledTimes(23);
    expect((await store.load()).historicalApproval).toBeUndefined();
    expect((await store.load()).reviews.b4?.status).toBe('pending');
    expect(scheduleApprovalResume).toHaveBeenCalledWith(30_000);
  });

  it('does not repeat an applied move when the queue checkpoint fails', async () => {
    const initial = emptyPersistedState();
    initial.reviews.b1 = {
      id: 'b1', bookmarkId: 'b1', title: 'Bookmark', url: 'https://example.test/a', sourceParentId: 'smart-root',
      classification: { action: 'move', targetFolderId: 'target', confidence: 0.9, reason: 'test' },
      source: 'ai', createdAt: 1, status: 'pending', scanId: 'scan-restart',
    };
    initial.historicalApproval = { scanId: 'scan-restart', reviewIds: ['b1'] };
    const store = new MemoryStateRepository(initial);
    const update = store.update.bind(store);
    let interrupted = false;
    vi.spyOn(store, 'update').mockImplementation((mutator) => update((state) => {
      mutator(state);
      if (!state.historicalApproval && !interrupted) {
        interrupted = true;
        throw new Error('worker interrupted');
      }
    }));
    const approveReview = vi.fn(async () => {
      await store.update((state) => { state.reviews.b1!.status = 'approved'; });
    });
    const deps = { bookmarks, store, approveReview, scheduleApprovalResume: async () => {}, processPending: async () => {} };
    await expect(new ScanService(deps).resumeApprovals()).rejects.toThrow('worker interrupted');
    expect((await store.load()).historicalApproval?.reviewIds).toEqual(['b1']);
    await new ScanService(deps).resumeApprovals();
    expect(approveReview).toHaveBeenCalledOnce();
    expect((await store.load()).historicalApproval).toBeUndefined();
  });

  it('keeps unreconciled approvals queued instead of leaving them stuck approving', async () => {
    const initial = emptyPersistedState();
    initial.reviews.b1 = {
      id: 'b1', bookmarkId: 'b1', title: 'Bookmark', url: 'https://example.test/a', sourceParentId: 'smart-root',
      classification: { action: 'move', targetFolderId: 'target', confidence: 0.9, reason: 'test' },
      source: 'ai', createdAt: 1, status: 'pending', scanId: 'scan-retry',
    };
    initial.historicalApproval = { scanId: 'scan-retry', reviewIds: ['b1'] };
    const store = new MemoryStateRepository(initial);
    const approveReview = vi.fn(async () => {
      await store.update((state) => { state.reviews.b1!.status = 'approving'; });
      throw new Error('recovery failed');
    });
    const scan = new ScanService({ bookmarks, store, approveReview, scheduleApprovalResume: async () => {}, processPending: async () => {} });
    await expect(scan.resumeApprovals()).rejects.toThrow('recovery failed');
    expect((await store.load()).historicalApproval?.reviewIds).toEqual(['b1']);
  });

  it('preserves completed scan totals after terminal history has been pruned', async () => {
    const initial = emptyPersistedState();
    initial.historicalScan = {
      id: 'large-scan', status: 'completed', startedAt: 1, updatedAt: 2,
      eligibleTotal: 300, processedCount: 300, pendingReviewCount: 0,
      failedCount: 0, skippedCount: 0, coveredIds: Array.from({ length: 300 }, (_, index) => `b${index}`),
    };
    const store = new MemoryStateRepository(initial);
    const scan = new ScanService({ bookmarks, store, approveReview: async () => {}, scheduleApprovalResume: async () => {}, processPending: async () => {} });
    await scan.refresh('large-scan');
    expect((await store.load()).historicalScan).toEqual(initial.historicalScan);
  });

  it.each(['pending', 'approving'] as const)('旧数据的孤立 %s 审核阻止扫描提前完成', async (status) => {
    const initial = emptyPersistedState();
    initial.historicalScan = {
      id: 'legacy', status: 'scanning', startedAt: 1, updatedAt: 1,
      eligibleTotal: 1, processedCount: 0, pendingReviewCount: 0,
      failedCount: 0, skippedCount: 0, coveredIds: ['b1'],
    };
    initial.reviews.b1 = {
      id: 'b1', bookmarkId: 'b1', title: 'Bookmark', url: 'https://example.test/a', sourceParentId: 'smart-root',
      classification: { action: 'keep', confidence: 0.7, reason: 'test' }, source: 'rule',
      createdAt: 1, status, scanId: 'legacy',
    };
    const store = new MemoryStateRepository(initial);
    const scan = new ScanService({ scheduleApprovalResume: async () => {}, bookmarks, store, processPending: async () => {}, approveReview: async () => {} });

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
    const scan = new ScanService({ scheduleApprovalResume: async () => {},
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
