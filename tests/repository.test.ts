import { describe, expect, it, vi } from 'vitest';
import { ChromeStateRepository, type LocalStorageArea } from '../lib/storage/repository';

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
});
