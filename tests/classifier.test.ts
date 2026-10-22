import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, emptyPersistedState, type FolderSummary } from '../types/domain';
import { MemoryStateRepository } from '../lib/storage/repository';
import { ClassificationService, PermissionRequiredError } from '../services/classifier.service';
import type { ClassifierProvider } from '../lib/ai/openai-compatible';
import { classifyWithRules, rankFolderCandidates } from '../lib/ai/rule-classifier';

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

  it('域名命中用户改选纠错时直接路由，不调用远端模型', async () => {
    const provider = createProvider();
    const store = new MemoryStateRepository();
    await store.update((state) => {
      state.corrections['github.com'] = { domain: 'github.com', action: 'move', folderId: 'development', createdAt: 1 };
    });
    const service = new ClassificationService(provider, store);

    const result = await service.classify({
      title: 'Some repository', url: 'https://github.com/a/b', domain: 'github.com',
      currentFolder: 'Bookmarks bar', currentFolderId: 'bar',
    }, folders, { ...DEFAULT_SETTINGS, apiKey: 'test-key' }, false);

    expect(result).toMatchObject({ source: 'rule', result: { action: 'move', targetFolderId: 'development', confidence: 0.93 } });
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it('域名命中保留纠错时返回 keep 且不请求模型', async () => {
    const provider = createProvider();
    const store = new MemoryStateRepository();
    await store.update((state) => {
      state.corrections['github.com'] = { domain: 'github.com', action: 'keep', createdAt: 1 };
    });
    const service = new ClassificationService(provider, store);

    const result = await service.classify({
      title: 'GitHub programming developer repository', url: 'https://github.com/example/repo', domain: 'github.com',
      currentFolder: 'Bookmarks bar', currentFolderId: 'bar',
    }, folders, { ...DEFAULT_SETTINGS, apiKey: 'test-key' }, true);

    expect(result).toMatchObject({ source: 'rule', result: { action: 'keep' } });
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it('主题/内容类型聚合偏好命中时直接路由到纠错目录', async () => {
    const provider = createProvider();
    const store = new MemoryStateRepository();
    await store.update((state) => {
      state.preferences['repo|AI Agent'] = {
        key: 'repo|AI Agent', topics: ['AI Agent'], contentType: 'repo',
        folderId: 'research', weight: 2, count: 2, createdAt: 1, updatedAt: 1,
      };
    });
    const service = new ClassificationService(provider, store);

    const result = await service.classify({
      title: 'Some agent', url: 'https://example.com/agent', domain: 'example.com',
      currentFolder: 'Bookmarks bar', currentFolderId: 'bar',
      pageProfile: { summary: 'An AI agent', topics: ['AI Agent', 'Python'], contentType: 'repo' },
    }, folders, { ...DEFAULT_SETTINGS, apiKey: 'test-key' }, false);

    expect(result).toMatchObject({ source: 'rule', result: { action: 'move', targetFolderId: 'research' } });
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it('最近纠错样本作为用户历史决定注入模型提示', async () => {
    const provider = createProvider();
    const store = new MemoryStateRepository();
    await store.update((state) => {
      state.corrections['github.com'] = { domain: 'github.com', action: 'move', folderId: 'development', createdAt: 2 };
      state.corrections['medium.com'] = { domain: 'medium.com', action: 'keep', createdAt: 1 };
    });
    const service = new ClassificationService(provider, store);

    await service.classify({
      title: 'Unknown page', url: 'https://example.com/decisions', domain: 'example.com',
      currentFolder: 'Bookmarks bar', currentFolderId: 'bar',
    }, folders, { ...DEFAULT_SETTINGS, apiKey: 'test-key' }, true);

    expect(provider.classify).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      [
        expect.objectContaining({ domain: 'github.com', action: 'move', folderPath: expect.stringContaining('Development') }),
        expect.objectContaining({ domain: 'medium.com', action: 'keep' }),
      ],
    );
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
    const second = await service.classify(input, folders, settings, true);

    expect(first.source).toBe('ai');
    expect(second.source).toBe('cache');
    expect(provider.classify).toHaveBeenCalledOnce();
  });

  it('切换 API 协议后不会复用另一协议的分类缓存', async () => {
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());
    const input = { title: 'Unknown page', url: 'https://example.com/protocol-cache', domain: 'example.com', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' };
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key' };

    const first = await service.classify(input, folders, settings, true);
    const second = await service.classify(input, folders, { ...settings, protocol: 'openai-responses' }, true);

    expect(first.source).toBe('ai');
    expect(second.source).toBe('ai');
    expect(provider.classify).toHaveBeenCalledTimes(2);
  });

  it('测试服务只调用合成 Provider 流程，不写分类缓存或活动记录', async () => {
    const provider = createProvider();
    const store = new MemoryStateRepository();
    const service = new ClassificationService(provider, store);

    await service.testProvider({ ...DEFAULT_SETTINGS, apiKey: 'test-key' });

    expect(provider.test).toHaveBeenCalledOnce();
    expect(await store.load()).toMatchObject({ cache: {}, activities: [], jobs: {}, reviews: {} });
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

  it('已有书签样例优先于泛化的项目目录名称', () => {
    const result = classifyWithRules({
      title: 'React Hooks reference',
      url: 'https://react.dev/reference/react/hooks',
      domain: 'react.dev',
      currentFolder: '书签栏 / 待分类',
      currentFolderId: 'inbox',
    }, [
      { id: 'generic', name: '项目', path: '智能书签 / 项目' },
      {
        id: 'frontend', name: '前端', path: '智能书签 / 开发 / 前端',
        samples: [{ title: 'React component guide', url: 'https://react.dev/learn', hostname: 'react.dev' }],
      },
      { id: 'inbox', name: '待分类', path: '智能书签 / 待分类' },
    ]);

    expect(result).toMatchObject({ action: 'move', targetFolderId: 'frontend' });
  });

  it('URL 路径参与目录匹配，预算内的目录全部交给 AI', () => {
    const folders: FolderSummary[] = [
      { id: 'current', name: '待分类', path: '智能书签 / 待分类' },
      { id: 'react', name: 'React', path: '智能书签 / 开发 / React' },
      ...Array.from({ length: 6 }, (_, index) => ({ id: `other-${index}`, name: `其他 ${index}`, path: `智能书签 / 其他 ${index}` })),
    ];
    const input = {
      title: 'Hooks guide', url: 'https://example.com/react/hooks', domain: 'example.com',
      currentFolder: '智能书签 / 待分类', currentFolderId: 'current',
    };

    expect(classifyWithRules(input, folders)).toMatchObject({ action: 'move', targetFolderId: 'react' });
    expect(rankFolderCandidates(input, folders)).toHaveLength(8);
  });

  it('超出候选预算时按排序截断并始终保留当前目录', () => {
    const fatSample = (id: string) => ({
      title: 'x'.repeat(400),
      url: `https://${id}.test/${'y'.repeat(400)}`,
      hostname: `${id}.test`,
    });
    const folders: FolderSummary[] = [
      { id: 'current', name: '待分类', path: '智能书签 / 待分类' },
      { id: 'react', name: 'React', path: '智能书签 / 开发 / React' },
      ...Array.from({ length: 24 }, (_, index) => ({
        id: `bulk-${index}`, name: `bulk ${index}`, path: `智能书签 / bulk ${index}`,
        samples: [fatSample(`bulk${index}`), fatSample(`bx${index}`), fatSample(`by${index}`)],
      })),
    ];
    const input = {
      title: 'Hooks guide', url: 'https://example.com/react/hooks', domain: 'example.com',
      currentFolder: '智能书签 / 待分类', currentFolderId: 'current',
    };

    const candidates = rankFolderCandidates(input, folders);
    expect(candidates.length).toBeLessThan(folders.length);
    expect(candidates.some((folder) => folder.id === 'react')).toBe(true);
    expect(candidates.some((folder) => folder.id === 'current')).toBe(true);
  });

  it('多级目录的父级路径参与标题和域名匹配', () => {
    const result = classifyWithRules({
      title: 'frontend react programming guide', url: 'https://github.com/example/guide', domain: 'github.com',
      currentFolder: '智能书签 / 待分类', currentFolderId: 'inbox',
    }, [
      { id: 'dev', name: 'resources', path: 'smart bookmarks / frontend / react / resources' },
      { id: 'inbox', name: '待分类', path: '智能书签 / 待分类' },
    ]);

    expect(result).toMatchObject({ action: 'move', targetFolderId: 'dev' });
  });

  it('泛化单词不能单独触发自动分类', () => {
    const result = classifyWithRules({
      title: 'Project overview', url: 'https://example.com/project', domain: 'example.com',
      currentFolder: '智能书签 / 待分类', currentFolderId: 'inbox',
    }, [
      { id: 'project', name: 'Project', path: '智能书签 / Project' },
      { id: 'inbox', name: '待分类', path: '智能书签 / 待分类' },
    ]);

    expect(result).toBeNull();
  });

  it('中文标题与目录名共享词汇时本地规则可命中', () => {
    const result = classifyWithRules({
      title: '机器学习入门',
      url: 'https://example.com/ml/intro',
      domain: 'example.com',
      currentFolder: '智能书签 / 待分类',
      currentFolderId: 'inbox',
    }, [
      { id: 'ml', name: '机器学习', path: '智能书签 / 机器学习' },
      { id: 'inbox', name: '待分类', path: '智能书签 / 待分类' },
    ]);

    expect(result).toMatchObject({ action: 'move', targetFolderId: 'ml' });
  });

  it('中文共享词汇用于排序并限制 AI 候选时保留当前目录', () => {
    const chineseFolders: FolderSummary[] = [
      { id: 'current', name: '待分类', path: '智能书签 / 待分类' },
      { id: 'ml', name: '机器学习', path: '智能书签 / 机器学习' },
      ...Array.from({ length: 6 }, (_, index) => ({ id: `misc-${index}`, name: `杂项 ${index}`, path: `智能书签 / 杂项 ${index}` })),
    ];
    const input = {
      title: '机器学习入门', url: 'https://example.com/ml/intro', domain: 'example.com',
      currentFolder: '智能书签 / 待分类', currentFolderId: 'current',
    };

    expect(classifyWithRules(input, chineseFolders)).toMatchObject({ action: 'move', targetFolderId: 'ml' });
    const candidates = rankFolderCandidates(input, chineseFolders);
    expect(candidates.some((folder) => folder.id === 'ml')).toBe(true);
    expect(candidates.some((folder) => folder.id === 'current')).toBe(true);
  });

  it('泛化中文词单独不能触发自动分类', () => {
    const result = classifyWithRules({
      title: '项目进度',
      url: 'https://example.com/status',
      domain: 'example.com',
      currentFolder: '智能书签 / 待分类',
      currentFolderId: 'inbox',
    }, [
      { id: 'project', name: '项目管理', path: '智能书签 / 项目管理' },
      { id: 'inbox', name: '待分类', path: '智能书签 / 待分类' },
    ]);

    expect(result).toBeNull();
  });

  it('同域样例单独不足以触发自动分类', () => {
    const result = classifyWithRules({
      title: 'Account settings', url: 'https://github.com/settings/profile', domain: 'github.com',
      currentFolder: '智能书签 / 待分类', currentFolderId: 'inbox',
    }, [
      { id: 'repos', name: '代码仓库', path: '智能书签 / 代码仓库', samples: [
        { title: 'Useful repository', url: 'https://github.com/example/project', hostname: 'github.com' },
      ] },
      { id: 'inbox', name: '待分类', path: '智能书签 / 待分类' },
    ]);

    expect(result).toBeNull();
  });

  it('证据不足时把完整目录交给 AI', () => {
    const manyFolders = [
      ...folders,
      ...Array.from({ length: 5 }, (_, index) => ({ id: `extra-${index}`, name: `分类 ${index}`, path: `智能书签 / 分类 ${index}` })),
    ];
    const input = { title: 'Unknown page', url: 'https://example.com/random', domain: 'example.com', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' };
    expect(rankFolderCandidates(input, manyFolders)).toBe(manyFolders);
  });

  it('目录样例变化会使分类缓存失效', async () => {
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());
    const input = { title: 'Unknown page', url: 'https://example.com/sample-cache', domain: 'example.com', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' };
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key' };
    const firstFolders = folders.map((folder) => folder.id === 'research'
      ? { ...folder, samples: [{ title: 'Research notes', url: 'https://research.example/one', hostname: 'research.example' }] }
      : folder);
    const secondFolders = firstFolders.map((folder) => folder.id === 'research'
      ? { ...folder, samples: [{ title: 'Research notes', url: 'https://research.example/two', hostname: 'research.example' }] }
      : folder);

    await service.classify(input, firstFolders, settings, true);
    await service.classify(input, secondFolders, settings, true);
    expect(provider.classify).toHaveBeenCalledTimes(2);
  });

  it('书签标题变化会使分类缓存失效', async () => {
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key' };
    const input = { title: 'First title', url: 'https://example.com/title-cache', domain: 'example.com', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' };

    await service.classify(input, folders, settings, true);
    await service.classify({ ...input, title: 'Updated title' }, folders, settings, true);

    expect(provider.classify).toHaveBeenCalledTimes(2);
  });

  it('批量分类混合本地命中与单次批量 AI 调用', async () => {
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());

    const results = await service.classifyBatch?.([
      { title: 'GitHub programming developer repository', url: 'https://github.com/example/repo', domain: 'github.com', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' },
      { title: 'Unusual page', url: 'https://example.com/random', domain: 'example.com', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' },
    ], folders, { ...DEFAULT_SETTINGS, apiKey: 'test-key' }, true);

    expect(results?.[0]).toMatchObject({ result: { result: { action: 'move', targetFolderId: 'development' }, source: 'rule' } });
    expect(results?.[1]).toMatchObject({ result: { source: 'ai' } });
    const batchMock = vi.mocked(provider.classifyBatch);
    expect(batchMock).toHaveBeenCalledOnce();
    expect(batchMock?.mock.calls[0]?.[0] ?? []).toHaveLength(1);
  });

  it('批量结果引用不存在目录时仅该条失败', async () => {
    const provider = createProvider();
    provider.classifyBatch = vi.fn(async () => [
      { action: 'move' as const, targetFolderId: 'ghost', confidence: 0.9, reason: '无效目录' },
      { action: 'keep' as const, confidence: 0.4, reason: '保留。' },
    ]);
    const service = new ClassificationService(provider, new MemoryStateRepository());

    const results = await service.classifyBatch?.([
      { title: 'Unusual page', url: 'https://example.com/random', domain: 'example.com', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' },
      { title: 'Other page', url: 'https://example.com/other', domain: 'example.com', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' },
    ], folders, { ...DEFAULT_SETTINGS, apiKey: 'test-key' }, true);

    expect(results?.[0]).toMatchObject({ error: { message: expect.stringContaining('不存在') } });
    expect(results?.[1]).toMatchObject({ result: { result: { action: 'keep' } } });
  });
});
function createProvider(): ClassifierProvider {
  return {
    classify: vi.fn(async () => ({ action: 'keep' as const, confidence: 0.4, reason: '没有明显分类。' })),
    classifyBatch: vi.fn(async (inputs: unknown[]) =>
      inputs.map(() => ({ action: 'keep' as const, confidence: 0.4, reason: '没有明显分类。' }))),
    test: vi.fn(async () => undefined),
  };
}
