import { describe, expect, it, vi } from 'vitest';
import { emptyPersistedState } from '../types/domain';
import { MemoryStateRepository } from '../lib/storage/repository';
import type { BookmarkNode, BookmarkPort } from '../services/bookmark.service';
import { ScanService } from '../services/scan.service';

const tree: BookmarkNode[] = [{ id: 'root', title: '', children: [{
  id: 'bar', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
    { id: 'b1', title: 'Bookmark', url: 'https://example.test/a', parentId: 'bar' },
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
});
