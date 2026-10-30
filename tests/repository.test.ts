import { describe, expect, it, vi } from 'vitest';
import { ChromeStateRepository, normalizeCache, type LocalStorageArea } from '../lib/storage/repository';
import { CACHE_ENTRY_MAX_BYTES, DEFAULT_SETTINGS, SettingsSchema, emptyPersistedState, type CacheEntry, type PersistedState } from '../types/domain';
import { ClassificationService, PermissionRequiredError } from '../services/classifier.service';
import { OpenAICompatibleProvider } from '../lib/ai/openai-compatible';

const STORAGE_KEY = 'ai-bookmark-manager.state.v1';

describe('ChromeStateRepository', () => {
  it('coalesces simultaneous reads without sharing mutable state or retaining stale reads', async () => {
    const values: Record<string, unknown> = { [STORAGE_KEY]: emptyPersistedState() };
    const storage: LocalStorageArea = {
      get: vi.fn(async (key) => ({ [key]: values[key] })),
      set: vi.fn(async (items) => { Object.assign(values, structuredClone(items)); }),
    };
    const repository = new ChromeStateRepository(storage);
    const [first, second] = await Promise.all([repository.load(), repository.load()]);
    expect(storage.get).toHaveBeenCalledTimes(1);
    first.settings.model = 'changed by caller';
    expect(second.settings.model).toBe(DEFAULT_SETTINGS.model);
    (values[STORAGE_KEY] as PersistedState).settings.model = 'external change';
    expect((await repository.load()).settings.model).toBe('external change');
    expect(storage.get).toHaveBeenCalledTimes(2);
  });

  it('skips unchanged writes and keeps serialized mutations durable after a failed write', async () => {
    const values: Record<string, unknown> = { [STORAGE_KEY]: emptyPersistedState() };
    let fail = false;
    const storage: LocalStorageArea = {
      get: vi.fn(async (key) => ({ [key]: values[key] })),
      set: vi.fn(async (items) => {
        if (fail) throw new Error('storage failed');
        Object.assign(values, structuredClone(items));
      }),
    };
    const repository = new ChromeStateRepository(storage);
    await repository.update(() => undefined);
    expect(storage.set).not.toHaveBeenCalled();
    await Promise.all([
      repository.update((state) => { state.settings.model = 'saved model'; }),
      repository.update((state) => { state.settings.enabled = false; }),
    ]);
    expect((await new ChromeStateRepository(storage).load()).settings).toMatchObject({ model: 'saved model', enabled: false });
    expect(storage.set).toHaveBeenCalledTimes(2);
    fail = true;
    await expect(repository.update((state) => { state.settings.model = 'failed model'; })).rejects.toThrow('storage failed');
    fail = false;
    await repository.update((state) => { state.settings.successNotifications = true; });
    expect((await repository.load()).settings).toMatchObject({ model: 'saved model', successNotifications: true });
  });

  it('bounds terminal reviews and metadata while preserving pending, active-scan, and recovery reviews', async () => {
    const state = emptyPersistedState();
    const review = (id: string, createdAt: number, status: 'approved' | 'pending' | 'approving' = 'approved') => ({
      id, bookmarkId: id, title: id, url: 'https://example.test', sourceParentId: 'root',
      classification: { action: 'keep' as const, confidence: 0.5, reason: 'kept' },
      source: 'ai' as const, createdAt, status,
    });
    state.reviews = Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`r${index}`, review(`r${index}`, index)]));
    state.reviews.pending = review('pending', 0, 'pending');
    state.reviews.approving = review('approving', 0, 'approving');
    state.reviews.active = { ...review('active', 0), scanId: 'active-scan' };
    state.reviews.recovery = review('recovery', 0);
    state.reviews.queued = review('queued', 0);
    state.pendingOperation = { bookmarkId: 'recovery', title: 'Recovery', fromFolderId: 'root', toFolderId: 'target', movedAt: 1, operationId: 'operation', state: 'prepared', kind: 'review', reviewId: 'recovery' };
    state.historicalScan = { id: 'active-scan', status: 'awaiting_review', startedAt: 1, updatedAt: 1, eligibleTotal: 1, processedCount: 1, pendingReviewCount: 1, failedCount: 0, skippedCount: 0, coveredIds: ['active'] };
    state.historicalApproval = { scanId: 'other-scan', reviewIds: ['queued', 'queued'] };
    state.bookmarkMetadata = Object.fromEntries(Array.from({ length: 2005 }, (_, index) => [`b${index}`, { summary: 'Summary', tags: [], generatedAt: index }]));
    const storage: LocalStorageArea = { get: async (key) => ({ [key]: state }), set: async () => undefined };
    const loaded = await new ChromeStateRepository(storage).load();
    expect(Object.keys(loaded.reviews)).toHaveLength(255);
    for (const id of ['pending', 'approving', 'active', 'recovery', 'queued', 'r299']) expect(loaded.reviews[id]).toBeDefined();
    expect(loaded.reviews.r0).toBeUndefined();
    expect(loaded.historicalApproval?.reviewIds).toEqual(['queued']);
    expect(Object.keys(loaded.bookmarkMetadata)).toHaveLength(2000);
    expect(loaded.bookmarkMetadata.b0).toBeUndefined();
    expect(loaded.bookmarkMetadata.b2004).toBeDefined();
  });

  it('removes legacy force flags without discarding the remaining settings draft', async () => {
    const values: Record<string, unknown> = { [STORAGE_KEY]: {
      ...emptyPersistedState(), settings: { ...DEFAULT_SETTINGS, forceOrganize: true },
      settingsDraft: { model: 'draft model', forceOrganize: true },
      pageProfiles: { obsolete: {} },
    } };
    const storage: LocalStorageArea = {
      get: async (key) => ({ [key]: values[key] }),
      set: async (items) => { Object.assign(values, items); },
    };
    const repository = new ChromeStateRepository(storage);
    const loaded = await repository.load();
    expect(loaded.settings).not.toHaveProperty('forceOrganize');
    expect(loaded.settingsDraft).toEqual({ model: 'draft model' });
    expect(loaded).not.toHaveProperty('pageProfiles');
    await repository.update((state) => { state.settings.enabled = false; });
    expect(values[STORAGE_KEY]).not.toHaveProperty('pageProfiles');
  });

  it('keeps only bounded URL-scoped corrections and rejects mismatched keys and legacy domain rules', async () => {
    const corrections: Record<string, unknown> = Object.fromEntries(Array.from({ length: 205 }, (_, index) => {
      const url = `https://github.com/project/${index}`;
      return [url, { url, domain: 'github.com', action: 'keep', createdAt: index }];
    }));
    corrections['github.com'] = { domain: 'github.com', action: 'keep', createdAt: 1000 };
    corrections['https://github.com/mismatch'] = { url: 'https://github.com/other', action: 'keep', createdAt: 1000 };
    corrections['javascript:alert(1)'] = { url: 'javascript:alert(1)', action: 'keep', createdAt: 1000 };
    corrections['https://github.com/canonical/?utm_source=test'] = {
      url: 'https://github.com/canonical', action: 'move', folderId: 'folder', createdAt: 1000,
    };
    const storage: LocalStorageArea = { get: async (key) => ({ [key]: { ...emptyPersistedState(), corrections } }), set: async () => undefined };
    const loaded = await new ChromeStateRepository(storage).load();
    expect(Object.keys(loaded.corrections)).toHaveLength(200);
    expect(loaded.corrections['github.com']).toBeUndefined();
    expect(loaded.corrections['https://github.com/mismatch']).toBeUndefined();
    expect(loaded.corrections['javascript:alert(1)']).toBeUndefined();
    expect(loaded.corrections['https://github.com/project/0']).toBeUndefined();
    expect(loaded.corrections['https://github.com/canonical']).toMatchObject({ url: 'https://github.com/canonical', domain: 'github.com', action: 'move', folderId: 'folder' });
  });

  it('persists independent learned decisions for SPA hash routes', async () => {
    const values: Record<string, unknown> = {};
    const storage: LocalStorageArea = {
      get: async (key) => ({ [key]: values[key] }),
      set: async (items) => { Object.assign(values, structuredClone(items)); },
    };
    const repository = new ChromeStateRepository(storage);
    const first = 'https://example.test/app#/frontend';
    const second = 'https://example.test/app#/backend';
    await repository.update((state) => {
      state.corrections[first] = { url: first, domain: 'example.test', action: 'move', folderId: 'frontend', createdAt: 1 };
      state.corrections[second] = { url: second, domain: 'example.test', action: 'keep', createdAt: 2 };
      state.corrections['https://example.test/app#/wrong-key'] = { url: first, domain: 'example.test', action: 'keep', createdAt: 3 };
    });
    const loaded = await new ChromeStateRepository(storage).load();
    expect(Object.keys(loaded.corrections)).toHaveLength(2);
    expect(loaded.corrections[first]).toMatchObject({ action: 'move', folderId: 'frontend' });
    expect(loaded.corrections[second]).toMatchObject({ action: 'keep' });
  });

  it('adds the default protocol to legacy settings and keeps valid saved values', async () => {
    const values: Record<string, unknown> = {
      [STORAGE_KEY]: {
        version: 1,
        settings: {
          enabled: false,
          baseUrl: 'https://proxy.example/v1',
          model: 'existing-model',
          apiKey: 'fixture',
          confidenceThreshold: 0.73,
          mode: 'confirm',
          forceOrganize: true,
          notificationsEnabled: false,
          successNotifications: true,
        },
        jobs: {},
        reviews: {},
        cache: {},
        activities: [],
      },
    };
    const storage: LocalStorageArea = {
      get: vi.fn(async (key) => ({ [key]: values[key] })),
      set: vi.fn(async (items) => Object.assign(values, items)),
    };
    const repository = new ChromeStateRepository(storage);

    const loaded = await repository.load();

    expect(loaded.settings).toMatchObject({
      protocol: 'openai-chat-completions',
      enabled: false,
      baseUrl: 'https://proxy.example/v1',
      model: 'existing-model',
      apiKey: 'fixture',
      confidenceThreshold: 0.73,
      mode: 'confirm',
      notificationsEnabled: false,
      successNotifications: true,
    });
    expect(storage.set).not.toHaveBeenCalled();

    await repository.update((state) => { state.settings.protocol = 'anthropic-messages'; });

    expect(values[STORAGE_KEY]).toMatchObject({ settings: { protocol: 'anthropic-messages', apiKey: 'fixture' } });
  });

  it('drops only malformed individual settings while preserving the rest of a legacy config', async () => {
    const storage: LocalStorageArea = {
      get: vi.fn(async (key) => ({ [key]: {
        version: 1,
        settings: {
          enabled: false,
          protocol: 'unknown-protocol',
          baseUrl: 'https://proxy.example/v1',
          model: 'existing-model',
          apiKey: 'fixture',
          confidenceThreshold: 9,
          mode: 'confirm',
        },
      } })),
      set: vi.fn(async () => undefined),
    };
    const repository = new ChromeStateRepository(storage);

    const loaded = await repository.load();

    expect(loaded.settings).toMatchObject({
      enabled: false,
      protocol: 'openai-chat-completions',
      baseUrl: 'https://proxy.example/v1',
      model: 'existing-model',
      apiKey: 'fixture',
      confidenceThreshold: 0.85,
      mode: 'confirm',
    });
  });

  it('normalizes persisted historical scan and batch undo state', async () => {
    const values: Record<string, unknown> = {
      [STORAGE_KEY]: {
        version: 1,
        settings: { apiKey: 'fixture' },
        jobs: {},
        reviews: {},
        cache: {},
        activities: [],
        historicalScan: {
          id: 'scan-1', status: 'awaiting_review', startedAt: 10, updatedAt: 20,
          eligibleTotal: 2, processedCount: 1, pendingReviewCount: 1,
          failedCount: 0, skippedCount: 0, coveredIds: ['bookmark-1', 'bookmark-2'],
          forceOrganize: false,
        },
        lastHistoricalUndo: {
          scanId: 'scan-1', createdAt: 30,
          moved: [{ bookmarkId: 'bookmark-1', title: 'Example', fromFolderId: 'bar', toFolderId: 'dev', movedAt: 25, operationId: 'op-1' }],
        },
      },
    };
    const storage: LocalStorageArea = {
      get: vi.fn(async (key) => ({ [key]: values[key] })),
      set: vi.fn(async (items) => Object.assign(values, items)),
    };

    const loaded = await new ChromeStateRepository(storage).load();

    expect(loaded.historicalScan).toMatchObject({ id: 'scan-1', status: 'awaiting_review', coveredIds: ['bookmark-1', 'bookmark-2'] });
    expect(loaded.lastHistoricalUndo?.moved).toHaveLength(1);
  });

  it('将旧版 lastUndo 迁移为撤销栈', async () => {
    const values: Record<string, unknown> = {
      [STORAGE_KEY]: {
        version: 1,
        settings: {
          enabled: true,
          baseUrl: 'https://api.example/v1',
          model: 'm',
          apiKey: 'k',
          confidenceThreshold: 0.85,
          mode: 'automatic',
          forceOrganize: false,
          notificationsEnabled: true,
          successNotifications: false,
        },
        lastUndo: { bookmarkId: 'b1', title: 'T', fromFolderId: 'a', toFolderId: 'b', movedAt: 1, operationId: 'op-1' },
      },
    };
    const storage: LocalStorageArea = { get: vi.fn(async (key) => ({ [key]: values[key] })), set: vi.fn(async (items) => Object.assign(values, items)) };

    const loaded = await new ChromeStateRepository(storage).load();

    expect(loaded.undoStack).toHaveLength(1);
    expect(loaded.undoStack[0]).toMatchObject({ bookmarkId: 'b1', operationId: 'op-1' });
  });

  it('normalizes legacy and malformed bookmark metadata without changing the storage version', async () => {
    const values: Record<string, unknown> = {
      [STORAGE_KEY]: {
        version: 1,
        settings: { apiKey: 'fixture' },
        bookmarkMetadata: {
          valid: { summary: '  Saved summary  ', tags: [' TypeScript ', 'AI'], generatedAt: 42 },
          duplicate: { summary: 'Summary', tags: ['Tag', 'tag'], generatedAt: 43 },
          oversized: { summary: 'x'.repeat(501), tags: ['tag'], generatedAt: 44 },
          malformed: { summary: 'Summary', tags: ['tag'], generatedAt: 'now' },
        },
      },
    };
    const storage: LocalStorageArea = {
      get: vi.fn(async (key) => ({ [key]: values[key] })),
      set: vi.fn(async (items) => Object.assign(values, items)),
    };

    const loaded = await new ChromeStateRepository(storage).load();

    expect(loaded.version).toBe(1);
    expect(loaded.bookmarkMetadata).toEqual({ valid: { summary: 'Saved summary', tags: ['TypeScript', 'AI'], generatedAt: 42 } });
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('向后兼容智能书签根目录状态，并拒绝无效根目录 ID', async () => {
    const storage: LocalStorageArea = {
      get: vi.fn(async (key) => ({ [key]: {
        version: 1,
        settings: { apiKey: 'fixture' },
        smartBookmarkRootId: '  smart-root  ',
        smartBookmarkInitialized: true,
      } })),
      set: vi.fn(async () => undefined),
    };

    const loaded = await new ChromeStateRepository(storage).load();
    expect(loaded.smartBookmarkRootId).toBe('smart-root');
    expect(loaded.smartBookmarkInitialized).toBe(true);

    const malformedStorage: LocalStorageArea = {
      get: vi.fn(async (key) => ({ [key]: {
        version: 1,
        settings: { apiKey: 'fixture' },
        smartBookmarkRootId: '   ',
        smartBookmarkInitialized: true,
      } })),
      set: vi.fn(async () => undefined),
    };
    const malformed = await new ChromeStateRepository(malformedStorage).load();
    expect(malformed.smartBookmarkRootId).toBeUndefined();
    expect(malformed.smartBookmarkInitialized).toBe(false);
  });

  it('cold-invalidates legacy or malformed caches without changing unrelated persisted state', async () => {
    const initial = emptyPersistedState();
    initial.settings.apiKey = 'saved-key';
    initial.jobs = { existing: { bookmark: { id: 'existing', title: 'title', url: 'https://example.test', parentId: 'root' }, status: 'queued', attempts: 0, createdAt: 1, updatedAt: 1 } };
    const valid = makeEntry('batch', 0, 2, 1);
    const values: Record<string, unknown> = { [STORAGE_KEY]: initial };
    const storage: LocalStorageArea = { get: async (key) => ({ [key]: values[key] }), set: async (items) => { Object.assign(values, structuredClone(items)); } };
    const repo = new ChromeStateRepository(storage);
    await repo.update((state) => { state.cache[valid.key] = valid; });
    const stored = values[STORAGE_KEY] as { cache: Record<string, unknown> };
    stored.cache.old = { key: 'old', result: valid.result, source: 'ai', createdAt: 1 };
    stored.cache['bad-index'] = { ...valid, key: 'bad-index' };
    const previousKey = valid.key.replace('v3:', 'v2:');
    stored.cache[previousKey] = { ...valid, key: previousKey, version: 2 };
    expect(Object.keys((await repo.load()).cache)).toEqual([valid.key]);
    await repo.update((state) => { state.activities = []; });
    const written = values[STORAGE_KEY] as Record<string, unknown>;
    const oldCodeView = written as { version: number; settings: typeof initial.settings; jobs: typeof initial.jobs; cache: Record<string, { key: string; result: unknown; source: string; createdAt: number }> };
    expect(oldCodeView).toMatchObject({ version: 1, settings: { apiKey: 'saved-key' }, jobs: initial.jobs });
    expect(oldCodeView.cache[valid.key]).toMatchObject({ key: valid.key, result: valid.result, source: 'ai', createdAt: 1 });
    expect((await new ChromeStateRepository(storage).load()).cache[valid.key]?.results).toHaveLength(2);
    delete written.credentialGeneration;
    expect((await repo.load()).cache).toEqual({});
    expect((await repo.load()).jobs).toEqual(initial.jobs);
  });

  it('cold-invalidates cache after the previous repository and settings logic performs A→B→A', async () => {
    const values: Record<string, unknown> = {};
    const storage: LocalStorageArea = { get: async (key) => ({ [key]: values[key] }), set: async (items) => { Object.assign(values, structuredClone(items)); } };
    const repo = new ChromeStateRepository(storage);
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'A' };
    await repo.update((state) => { state.settings = settings; });
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ action: 'keep', confidence: 0.5, reason: 'kept' }) } }] }), { status: 200 }));
    const service = new ClassificationService(new OpenAICompatibleProvider(fetcher), repo);
    const input = { title: 'Unusual page', url: 'https://example.test/page', domain: 'example.test', currentFolder: 'Inbox', currentFolderId: 'inbox' };
    const folders = [{ id: 'inbox', name: 'Inbox', path: 'Inbox' }];
    expect((await service.classify(input, folders, settings, true)).source).toBe('ai');
    expect((await service.classify(input, folders, settings, false)).source).toBe('cache');
    const before = await repo.load();
    expect(before.settings).not.toHaveProperty('_classificationCacheEpoch');
    const initialRaw = values[STORAGE_KEY] as { settings: Record<string, unknown> };
    const savedEpoch = initialRaw.settings._classificationCacheEpoch;
    initialRaw.settings._classificationCacheEpoch = -1;
    expect((await repo.load()).cache).toEqual({});
    initialRaw.settings._classificationCacheEpoch = savedEpoch;
    expect((await repo.load()).cache).toEqual(before.cache);
    const legacy = new LegacySettingsService(new LegacyStateRepository(storage));
    await legacy.updateSettings({ apiKey: 'B' });
    await legacy.updateSettings({ apiKey: 'A' });
    const raw = values[STORAGE_KEY] as { settings: Record<string, unknown>; credentialGeneration: number; cache: PersistedState['cache'] };
    expect(raw.settings.apiKey).toBe('A');
    expect(raw.settings).not.toHaveProperty('_classificationCacheEpoch');
    expect(raw.credentialGeneration).toBe(before.credentialGeneration);
    expect(raw.cache).toEqual(before.cache);
    const upgradedRepo = new ChromeStateRepository(storage);
    expect((await upgradedRepo.load()).cache).toEqual({});
    const upgraded = new ClassificationService(new OpenAICompatibleProvider(fetcher), upgradedRepo);
    await expect(upgraded.classify(input, folders, settings, false)).rejects.toBeInstanceOf(PermissionRequiredError);
    expect((await upgraded.classify(input, folders, settings, true)).source).toBe('ai');
    expect((await new ClassificationService(new OpenAICompatibleProvider(fetcher), new ChromeStateRepository(storage)).classify(input, folders, settings, false)).source).toBe('cache');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('bounds total cached results, evicts whole older batches, and rejects oversized entries', () => {
    const oldBatch = makeEntry('batch', 0, 15, 1);
    const middleBatch = makeEntry('batch', 1, 15, 2);
    const newest = makeEntry('batch', 2, 180, 3);
    const cache = normalizeCache({ [oldBatch.key]: oldBatch, [middleBatch.key]: middleBatch, [newest.key]: newest });
    expect(Object.values(cache).reduce((total, entry) => total + entry.results.length, 0)).toBe(195);
    expect(cache[oldBatch.key]).toBeUndefined();
    expect(cache[middleBatch.key]?.results).toHaveLength(15);
    expect(cache[newest.key]?.results).toHaveLength(180);
    const oversized = makeEntry('batch', 3, 200, 4);
    oversized.results = oversized.results.map(() => ({ action: 'keep', confidence: 0.5, reason: 'x'.repeat(500) }));
    oversized.result = oversized.results[0]!;
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength).toBeGreaterThan(CACHE_ENTRY_MAX_BYTES);
    expect(normalizeCache({ [oversized.key]: oversized })).toEqual({});
  });

  it('defaults content-assist settings and removes unused legacy pageProfiles', async () => {
    const values: Record<string, unknown> = {
      [STORAGE_KEY]: {
        version: 1,
        settings: { enabled: true },
        preferences: {
          'repo|AI Agent': { key: 'repo|AI Agent', topics: ['AI Agent'], contentType: 'repo', folderId: 'research', weight: 2, count: 2, createdAt: 1, updatedAt: 2 },
          broken: { folderId: '' },
        },
        pageProfiles: {
          'https://github.com/a/b': { summary: 'An agent', topics: ['AI Agent'], contentType: 'repo', charCount: 120, generatedAt: 5 },
          bad: { summary: '', topics: [], contentType: 'repo', charCount: 0, generatedAt: 0 },
        },
      },
    };
    const storage: LocalStorageArea = {
      get: vi.fn(async (key) => ({ [key]: values[key] })),
      set: vi.fn(async (items) => Object.assign(values, items)),
    };
    const loaded = await new ChromeStateRepository(storage).load();

    expect(loaded.settings).toMatchObject({
      contentAssistEnabled: false,
      extractCharLimit: 3000,
      contentAssistDisabledSites: [],
    });
    expect(Object.keys(loaded.preferences)).toEqual(['repo|AI Agent']);
    expect(loaded).not.toHaveProperty('pageProfiles');
  });
});

// Preserves the previous repository's actual storage normalization and settings update behavior.
class LegacyStateRepository {
  constructor(private readonly storage: LocalStorageArea) {}

  async update(mutator: (state: PersistedState) => void): Promise<void> {
    const stored = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY] as PersistedState;
    const state = this.normalize(stored);
    mutator(state);
    await this.storage.set({ [STORAGE_KEY]: this.normalize(state) });
  }

  private normalize(input: PersistedState): PersistedState {
    const candidate: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    const stored = input.settings as unknown as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof typeof DEFAULT_SETTINGS>) {
      const parsed = SettingsSchema.shape[key].safeParse(stored[key]);
      if (parsed.success) candidate[key] = parsed.data;
    }
    const parsed = SettingsSchema.safeParse(candidate);
    return {
      ...emptyPersistedState(),
      ...input,
      version: 1,
      settings: parsed.success ? parsed.data : { ...DEFAULT_SETTINGS },
      cache: input.cache && typeof input.cache === 'object' ? input.cache : {},
    };
  }
}

class LegacySettingsService {
  constructor(private readonly store: LegacyStateRepository) {}

  async updateSettings(patch: Partial<PersistedState['settings']>): Promise<void> {
    await this.store.update((state) => {
      state.settings = {
        ...state.settings,
        ...patch,
        apiKey: patch.apiKey?.trim() ? patch.apiKey.trim() : state.settings.apiKey,
      };
      if (!state.settings.enabled) {
        for (const job of Object.values(state.jobs)) {
          if (job.status === 'processing') job.status = 'queued';
        }
      }
    });
  }
}

function makeEntry(mode: 'single' | 'batch', id: number, count: number, createdAt: number): CacheEntry {
  const result = { action: 'keep' as const, confidence: 0.5, reason: 'valid' };
  const key = `classification-v3:${mode}:${id.toString(16).padStart(64, '0')}`;
  return { key, mode, version: 3, source: 'ai', result, results: Array.from({ length: count }, () => ({ ...result })), createdAt };
}
