import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, emptyPersistedState, type FolderSummary } from '../types/domain';
import { MemoryStateRepository } from '../lib/storage/repository';
import { ClassificationService, PermissionRequiredError } from '../services/classifier.service';
import type { ClassifierProvider } from '../lib/ai/openai-compatible';

const folders: FolderSummary[] = [
  { id: 'bar', name: 'Bookmarks bar', path: 'Bookmarks bar', folderType: 'bookmarks-bar' },
  { id: 'development', name: 'Development Programming', path: 'Bookmarks bar / Development Programming', parentId: 'bar' },
  { id: 'research', name: 'Research Notes', path: 'Bookmarks bar / Research Notes', parentId: 'bar' },
];

describe('ClassificationService', () => {
  it('使用高置信度本地规则匹配，避免调用远端模型', async () => {
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());
    const result = await service.classify({
      title: 'GitHub programming developer repository',
      url: 'https://github.com/example/repo',
      domain: 'github.com',
      currentFolder: 'Bookmarks bar',
      currentFolderId: 'bar',
    }, folders, { ...DEFAULT_SETTINGS, apiKey: 'test-key' }, false);

    expect(result.source).toBe('rule');
    expect(result.result).toMatchObject({ action: 'move', targetFolderId: 'development' });
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it('不确定分类且缺少主机权限时不调用远端 API', async () => {
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());
    await expect(service.classify({
      title: 'A very unusual page', url: 'https://example.com/random', domain: 'example.com',
      currentFolder: 'Bookmarks bar', currentFolderId: 'bar',
    }, folders, { ...DEFAULT_SETTINGS, apiKey: 'test-key' }, false)).rejects.toBeInstanceOf(PermissionRequiredError);
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it('缓存同一 URL 和目录树的已校验 AI 结果', async () => {
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());
    const input = { title: 'Unknown page', url: 'https://example.com/unique', domain: 'example.com', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' };
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key' };
    const first = await service.classify(input, folders, settings, true);
    const second = await service.classify({ ...input, title: 'Changed title' }, folders, settings, true);

    expect(first.source).toBe('ai');
    expect(second.source).toBe('cache');
    expect(provider.classify).toHaveBeenCalledOnce();
  });

  it('不允许没有 API Key 的纯本地自动分类', async () => {
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());
    await expect(service.classify({
      title: 'GitHub programming developer', url: 'https://github.com/example', domain: 'github.com',
      currentFolder: 'Bookmarks bar', currentFolderId: 'bar',
    }, folders, { ...DEFAULT_SETTINGS, apiKey: '' }, false)).rejects.toThrow('API Key');
    expect(provider.classify).not.toHaveBeenCalled();
  });
});

function createProvider(): ClassifierProvider {
  return {
    classify: vi.fn(async () => ({ action: 'keep' as const, confidence: 0.4, reason: '没有明显分类。' })),
    test: vi.fn(async () => undefined),
  };
}
