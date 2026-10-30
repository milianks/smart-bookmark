import { expect, it, vi } from 'vitest';
import { ChromeStateRepository, type LocalStorageArea, type StorageChanges } from '../../lib/storage/repository';
import { ChromeBookmarkService, type BookmarkNode } from '../../services/bookmark.service';
import { OrganizerService } from '../../services/organizer.service';
import { ScanService } from '../../services/scan.service';
import { emptyPersistedState } from '../../types/domain';

it('bounds storage and dashboard work for a 5000-bookmark scan and one batch', async () => {
  const started = performance.now();
  const initial = emptyPersistedState();
  initial.smartBookmarkRootId = 'smart-root';
  initial.smartBookmarkInitialized = true;
  const values: Record<string, unknown> = { 'ai-bookmark-manager.state.v1': initial };
  const metrics = { gets: 0, sets: 0, writeBytes: 0, peakBytes: 0, dashboardTreeReads: 0, dashboardBytes: 0 };
  let onChanged: Parameters<StorageChanges['addListener']>[0] = () => {};
  const storage: LocalStorageArea = {
    get: async (key) => { metrics.gets += 1; return structuredClone({ [key]: values[key] }); },
    set: async (items) => {
      const bytes = new TextEncoder().encode(JSON.stringify(items)).byteLength;
      metrics.sets += 1;
      metrics.writeBytes += bytes;
      metrics.peakBytes = Math.max(metrics.peakBytes, bytes);
      Object.assign(values, structuredClone(items));
      onChanged(Object.fromEntries(Object.entries(items).map(([key, newValue]) => [key, { newValue }])), 'local');
    },
  };
  const store = new ChromeStateRepository(storage, { addListener: (listener) => { onChanged = listener; } });
  const children: BookmarkNode[] = Array.from({ length: 5000 }, (_, index) => ({
    id: `b${index}`, title: `Bookmark ${index}`, url: `https://example.test/page/${index}`, parentId: 'smart-root',
  }));
  const root: BookmarkNode = { id: 'smart-root', title: '智能书签', parentId: 'bar', children };
  const bar: BookmarkNode = { id: 'bar', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [root] };
  const nodes = new Map([bar, root, ...children].map((node) => [node.id, node]));
  const getTree = vi.fn(async () => structuredClone([bar]));
  const bookmarks = new ChromeBookmarkService({
    getTree, get: async (id) => nodes.has(id) ? [structuredClone(nodes.get(id)!)] : [],
    move: async () => { throw new Error('No moves expected'); },
    create: async () => { throw new Error('No folders expected'); },
  });
  const result = { result: { action: 'keep' as const, confidence: 1, reason: 'Already organized' }, source: 'ai' as const };
  const classifier = {
    classify: vi.fn(async () => result),
    classifyBatch: vi.fn(async (inputs: unknown[]) => inputs.map(() => ({ result }))),
  };
  const organizer = new OrganizerService({
    bookmarks, store, classifier, notifications: { reviewNeeded: vi.fn(), processingFailed: vi.fn(), moved: vi.fn() },
    alarms: { schedule: vi.fn() }, hasProviderPermission: async () => true, now: () => 1000, makeId: (prefix) => prefix,
  });
  const scan = new ScanService({
    bookmarks, store, processPending: () => organizer.processPending(), approveReview: async () => {},
    scheduleApprovalResume: async () => {}, now: () => 1000, makeId: () => 'scan',
  });
  expect((await scan.startHistoricalScan()).eligibleTotal).toBe(5000);
  await store.update((state) => {
    state.settings.apiKey = 'test-key';
    for (let index = 0; index < 15; index += 1) state.jobs[`b${index}`]!.status = 'queued';
  });
  await organizer.processPending();
  expect(classifier.classifyBatch).toHaveBeenCalledOnce();
  expect(Object.values((await store.load()).jobs).filter((job) => job.status === 'completed')).toHaveLength(15);
  const beforeTrees = getTree.mock.calls.length;
  for (let index = 0; index < 3; index += 1) {
    metrics.dashboardBytes += new TextEncoder().encode(JSON.stringify(await organizer.getDashboardState())).byteLength;
  }
  metrics.dashboardTreeReads = getTree.mock.calls.length - beforeTrees;
  expect(metrics.peakBytes).toBeLessThan(5_000_000);
  expect(metrics.gets).toBe(1);
  expect(metrics.sets).toBeLessThanOrEqual(33);
  expect(metrics.writeBytes).toBeLessThan(38_000_000);
  expect(metrics.dashboardTreeReads).toBe(1);
  if (import.meta.env.PERF === '1') console.log(JSON.stringify({ ...metrics, elapsedMs: Math.round(performance.now() - started) }));
}, 60_000);
