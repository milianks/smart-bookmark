import { describe, expect, it, vi } from 'vitest';
import { ChromeStateRepository, normalizeCache, type LocalStorageArea } from '../lib/storage/repository';
import { CACHE_ENTRY_MAX_BYTES, DEFAULT_SETTINGS, SettingsSchema, emptyPersistedState, type CacheEntry, type PersistedState } from '../types/domain';
import { ClassificationService, PermissionRequiredError } from '../services/classifier.service';
import { OpenAICompatibleProvider } from '../lib/ai/openai-compatible';

const STORAGE_KEY = 'ai-bookmark-manager.state.v1';

describe('ChromeStateRepository', () => {
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
      forceOrganize: true,
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

  it('defaults new content-assist settings and normalizes preferences/pageProfiles', async () => {
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
    expect(Object.keys(loaded.pageProfiles)).toEqual(['https://github.com/a/b']);
    expect(loaded.pageProfiles['https://github.com/a/b']).toMatchObject({ summary: 'An agent', contentType: 'repo' });
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
