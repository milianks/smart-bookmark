import { describe, expect, it, vi } from 'vitest';
import { emptyPersistedState } from '../types/domain';
import { MemoryStateRepository } from '../lib/storage/repository';
import type { ClassifierPort } from '../services/classifier.service';
import { SettingsService } from '../services/settings.service';

describe('SettingsService', () => {
  it('persists and clones drafts; update resumes Organizer only when enabled', async () => {
    const store = new MemoryStateRepository();
    const afterUpdate = vi.fn(async () => {});
    const service = new SettingsService({ store, classifier: { classify: vi.fn(async () => ({ result: { action: 'keep' as const, confidence: 0.5, reason: 'test' }, source: 'ai' as const })) }, hasProviderPermission: async () => true, afterUpdate });
    await service.updateSettingsDraft({ model: 'draft-model' });
    const draft = await service.getSettingsDraft();
    expect(draft?.model).toBe('draft-model');
    draft!.model = 'mutated';
    expect((await service.getSettingsDraft())?.model).toBe('draft-model');
    await service.clearSettingsDraft();
    expect(await service.getSettingsDraft()).toBeNull();
    await service.updateSettings({ enabled: false });
    expect(afterUpdate).not.toHaveBeenCalled();
    await service.updateSettings({ enabled: true });
    expect(afterUpdate).toHaveBeenCalledOnce();
  });

  it('checks key and exact configured origin permission without persisting provider test', async () => {
    const initial = emptyPersistedState();
    initial.settings.apiKey = 'secret';
    const store = new MemoryStateRepository(initial);
    const classifier: ClassifierPort = { classify: vi.fn(async () => ({ result: { action: 'keep' as const, confidence: 0.5, reason: 'test' }, source: 'ai' as const })), testProvider: vi.fn(async () => {}) };
    const hasProviderPermission = vi.fn(async () => false);
    const service = new SettingsService({ store, classifier, hasProviderPermission, afterUpdate: async () => {} });
    const before = await store.load();
    await expect(service.testProvider()).rejects.toThrow('尚未授予此 API 地址');
    expect(hasProviderPermission).toHaveBeenCalledWith(initial.settings.baseUrl);
    expect(classifier.testProvider).not.toHaveBeenCalled();
    hasProviderPermission.mockResolvedValue(true);
    await service.testProvider();
    expect(classifier.testProvider).toHaveBeenCalledWith(initial.settings);
    expect(await store.load()).toEqual(before);
  });

  it('increments credential generation only for actual changes, including A→B→A', async () => {
    const initial = emptyPersistedState();
    initial.settings.apiKey = 'A';
    const store = new MemoryStateRepository(initial);
    const classifier: ClassifierPort = { classify: vi.fn(async () => ({ result: { action: 'keep' as const, confidence: 0.5, reason: 'test' }, source: 'ai' as const })) };
    const service = new SettingsService({ store, classifier, hasProviderPermission: async () => true, afterUpdate: async () => {} });
    await service.updateSettings({ apiKey: ' A ' });
    await service.updateSettings({ apiKey: '' });
    await service.updateSettings({ model: 'new-model' });
    expect((await store.load()).credentialGeneration).toBe(0);
    await service.updateSettings({ apiKey: 'B' });
    expect(await store.load()).toMatchObject({ settings: { apiKey: 'B' }, credentialGeneration: 1 });
    await service.updateSettings({ apiKey: 'A' });
    expect(await store.load()).toMatchObject({ settings: { apiKey: 'A' }, credentialGeneration: 2 });
  });

  it('clears learned corrections, preferences and cached decisions without changing settings', async () => {
    const initial = emptyPersistedState();
    initial.corrections['https://example.test/a'] = { url: 'https://example.test/a', domain: 'example.test', action: 'keep', createdAt: 1 };
    initial.preferences.topic = { key: 'topic', topics: ['topic'], contentType: 'doc', folderId: 'folder', weight: 1, count: 1, createdAt: 1, updatedAt: 1 };
    const store = new MemoryStateRepository(initial);
    const service = new SettingsService({ store, classifier: { classify: vi.fn() }, hasProviderPermission: async () => true, afterUpdate: async () => {} });
    await service.clearCorrections();
    expect(await store.load()).toMatchObject({ corrections: {}, preferences: {}, cache: {}, settings: initial.settings });
  });

  it('rejects provider testing without a saved API key', async () => {
    const store = new MemoryStateRepository();
    const classifier: ClassifierPort = { classify: vi.fn(async () => ({ result: { action: 'keep' as const, confidence: 0.5, reason: 'test' }, source: 'ai' as const })), testProvider: vi.fn(async () => {}) };
    const hasProviderPermission = vi.fn(async () => true);
    const service = new SettingsService({ store, classifier, hasProviderPermission, afterUpdate: async () => {} });
    await expect(service.testProvider()).rejects.toThrow('请先保存 API Key');
    expect(hasProviderPermission).not.toHaveBeenCalled();
  });
});
