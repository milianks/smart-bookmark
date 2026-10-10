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
});
