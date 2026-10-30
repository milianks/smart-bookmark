import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, emptyPersistedState, type FolderSummary } from '../types/domain';
import { correctionUrl, stableFingerprint } from '../lib/utils/ids';
import { MemoryStateRepository } from '../lib/storage/repository';
import { ClassificationService, PermissionRequiredError } from '../services/classifier.service';
import { SettingsService } from '../services/settings.service';
import type { ClassifierProvider } from '../lib/ai/openai-compatible';
import type { ProviderConfig } from '../lib/ai/provider-config';
import { buildBatchMessages, buildClassificationMessages, type ClassificationInput, type RecentCorrection } from '../lib/ai/prompts';
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

  it('同一页面命中用户改选纠错时直接路由，不调用远端模型', async () => {
    const provider = createProvider();
    const store = new MemoryStateRepository();
    await store.update((state) => {
      state.corrections['https://github.com/a/b#readme'] = { domain: 'github.com', url: 'https://github.com/a/b#readme', action: 'move', folderId: 'development', createdAt: 1 };
    });
    const service = new ClassificationService(provider, store);

    const result = await service.classify({
      title: 'Some repository', url: 'https://github.com/a/b?utm_source=test#readme', domain: 'github.com',
      currentFolder: 'Bookmarks bar', currentFolderId: 'bar',
    }, folders, { ...DEFAULT_SETTINGS, apiKey: 'test-key' }, false);

    expect(result).toMatchObject({ source: 'rule', result: { action: 'move', targetFolderId: 'development', confidence: 0.93 } });
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it('同一页面命中保留纠错时返回 keep 且不请求模型', async () => {
    const provider = createProvider();
    const store = new MemoryStateRepository();
    await store.update((state) => {
      state.corrections['https://github.com/example/repo'] = { domain: 'github.com', url: 'https://github.com/example/repo', action: 'keep', createdAt: 1 };
    });
    const service = new ClassificationService(provider, store);

    const result = await service.classify({
      title: 'GitHub programming developer repository', url: 'https://github.com/example/repo', domain: 'github.com',
      currentFolder: 'Bookmarks bar', currentFolderId: 'bar',
    }, folders, { ...DEFAULT_SETTINGS, apiKey: 'test-key' }, true);

    expect(result).toMatchObject({ source: 'rule', result: { action: 'keep' } });
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it.each(['move', 'keep'] as const)('纠错 %s 不传播到同站其他页面，旧域名规则也不硬路由', async (action) => {
    const provider = createProvider();
    const store = new MemoryStateRepository();
    await store.update((state) => {
      state.corrections['github.com'] = { domain: 'github.com', action, folderId: 'development', createdAt: 1 };
      state.corrections['https://github.com/a/b'] = { domain: 'github.com', url: 'https://github.com/a/b', action, folderId: 'development', createdAt: 2 };
    });
    const service = new ClassificationService(provider, store);
    const result = await service.classify({
      title: 'Travel journal', url: 'https://github.com/other/travel', domain: 'github.com',
      currentFolder: 'Bookmarks bar', currentFolderId: 'bar',
    }, folders, { ...DEFAULT_SETTINGS, apiKey: 'test-key' }, true);
    expect(result.source).toBe('ai');
    expect(provider.classify).toHaveBeenCalledOnce();
    const decisions = vi.mocked(provider.classify).mock.calls[0]![3];
    expect(decisions?.[0]).toMatchObject({ url: 'https://github.com/a/b' });
    expect(buildClassificationMessages({ title: 'Travel', url: 'https://github.com/other/travel', domain: 'github.com', currentFolder: 'bar' }, folders, decisions)[0]!.content).toContain('不能推广到整个域名');
  });

  it.each(['move', 'keep'] as const)('纠错 %s 保留 SPA hash 路由边界，同时复用同一页面决定', async (action) => {
    const provider = createProvider();
    const store = new MemoryStateRepository();
    const url = 'https://portal.example/#/front';
    await store.update((state) => {
      state.corrections[url] = { domain: 'portal.example', url, action, folderId: 'development', createdAt: 1 };
    });
    const service = new ClassificationService(provider, store);
    const input = { title: 'Portal page', url, domain: 'portal.example', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' };
    const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key' };
    expect(await service.classify({ ...input, url: 'https://portal.example/?utm_source=test#/front' }, folders, settings, false))
      .toMatchObject({ source: 'rule', result: { action } });
    expect(provider.classify).not.toHaveBeenCalled();
    expect((await service.classify({ ...input, url: 'https://portal.example/#/finance' }, folders, settings, true)).source).toBe('ai');
    expect(provider.classify).toHaveBeenCalledOnce();
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
      expect.any(Function),
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

  it.each([
    { title: '学习烘焙', url: 'https://example.com/学习', samples: [] },
    { title: '学习烘焙', url: 'https://example.com/baking', samples: [{ title: '机器学习', url: 'https://example.com/ml', hostname: 'example.com' }] },
  ])('单个中文二元词即使被路径或同域样例重复命中也不自动移动', ({ title, url, samples }) => {
    expect(classifyWithRules({ title, url, domain: 'example.com', currentFolder: '待分类', currentFolderId: 'inbox' }, [
      { id: 'ml', name: '机器学习', path: '智能书签 / 机器学习', samples },
      { id: 'inbox', name: '待分类', path: '智能书签 / 待分类' },
    ])).toBeNull();
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
describe('classification cache safety', () => {
  const settings = { ...DEFAULT_SETTINGS, apiKey: 'test-key' };
  const input: ClassificationInput = { title: 'Unusual page', url: 'https://example.com/random#one', domain: 'example.com', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' };

  it('applies corrections, preferences and threshold rules before cache lookup', async () => {
    const store = new MemoryStateRepository();
    const provider = createProvider();
    const service = new ClassificationService(provider, store);
    const profiled = { ...input, pageProfile: { summary: 'private derived summary', topics: ['topic-x'], contentType: 'article' } };
    expect((await service.classify(profiled, folders, settings, true)).source).toBe('ai');
    await store.update((state) => { state.preferences.x = { key: 'x', topics: ['topic-x'], contentType: 'article', folderId: 'research', weight: 2, count: 2, createdAt: 1, updatedAt: 1 }; });
    expect(await service.classify(profiled, folders, settings, false)).toMatchObject({ source: 'rule', result: { targetFolderId: 'research' } });
    await store.update((state) => { state.corrections[correctionUrl(input.url)] = { domain: 'example.com', url: correctionUrl(input.url), action: 'keep', createdAt: 2 }; });
    expect(await service.classify(profiled, folders, settings, false)).toMatchObject({ source: 'rule', result: { action: 'keep' } });
    expect(provider.classify).toHaveBeenCalledOnce();

    const matched = { title: 'GitHub programming developer repository', url: 'https://github.com/repo', domain: 'github.com', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' };
    expect((await service.classify(matched, folders, { ...settings, confidenceThreshold: 1 }, true)).source).toBe('ai');
    expect((await service.classify(matched, folders, { ...settings, confidenceThreshold: 0.85 }, false)).source).toBe('rule');
  });

  it('uses the original URL, ordered candidates, parent and recent correction paths in the identity', async () => {
    const store = new MemoryStateRepository();
    const provider = createProvider();
    const service = new ClassificationService(provider, store);
    await store.update((state) => { state.corrections['another.test'] = { domain: 'another.test', action: 'move', folderId: 'research', createdAt: 1 }; });
    await service.classify(input, folders, settings, true);
    expect((await service.classify(input, folders, settings, false)).source).toBe('cache');
    await service.classify({ ...input, url: 'https://example.com/random#two' }, folders, settings, true);
    await service.classify(input, [...folders].reverse(), settings, true);
    await service.classify(input, folders.map((folder) => folder.id === 'research' ? { ...folder, parentId: 'different' } : folder), settings, true);
    await service.classify(input, folders.map((folder) => folder.id === 'research' ? { ...folder, path: 'changed path' } : folder), settings, true);
    expect(provider.classify).toHaveBeenCalledTimes(5);
  });

  it('reuses single results across overlapping and reordered batches while preserving mixed local positions', async () => {
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());
    const local = { title: 'GitHub programming developer repository', url: 'https://github.com/repo', domain: 'github.com', currentFolder: 'Bookmarks bar', currentFolderId: 'bar' };
    const other = { ...input, url: 'https://other.example/other', domain: 'other.example' };
    const first = await service.classifyBatch([input, local, other], folders, settings, true);
    expect(first.map((outcome) => 'result' in outcome ? outcome.result.source : 'error')).toEqual(['ai', 'rule', 'ai']);
    const second = await service.classifyBatch([input, local, other], folders, settings, false);
    expect(second.map((outcome) => 'result' in outcome ? outcome.result.source : 'error')).toEqual(['cache', 'rule', 'cache']);
    expect(vi.mocked(provider.classifyBatch!).mock.calls[0]?.[0]).toEqual([input, other]);
    await expect(service.classifyBatch([input, local, { ...other, url: 'https://other.example/new' }], folders, settings, false)).rejects.toBeInstanceOf(PermissionRequiredError);
    const reordered = await service.classifyBatch([other, local, input], folders, settings, false);
    expect(reordered.map((outcome) => 'result' in outcome && outcome.result.source)).toEqual(['cache', 'rule', 'cache']);
    const fresh = { ...other, url: 'https://other.example/new' };
    const overlap = await service.classifyBatch([other, local, fresh], folders, settings, true);
    expect(overlap.map((outcome) => 'result' in outcome && outcome.result.source)).toEqual(['cache', 'rule', 'ai']);
    expect(provider.classifyBatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.classifyBatch!).mock.calls.map((call) => call[0])).toEqual([[input, other], [fresh]]);
    expect((await service.classify(input, folders, settings, false)).source).toBe('cache');
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it('reuses a single classification before submitting only the batch miss', async () => {
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());
    const other = { ...input, url: 'https://example.com/other' };
    await service.classify(input, folders, settings, true);
    const outcomes = await service.classifyBatch([input, other], folders, settings, true);
    expect(outcomes.map((outcome) => 'result' in outcome && outcome.result.source)).toEqual(['cache', 'ai']);
    expect(vi.mocked(provider.classifyBatch!).mock.calls[0]?.[0]).toEqual([other]);
    expect((await service.classify(other, folders, settings, false)).source).toBe('cache');
  });

  it('reuses a complete batch after its individual entries are evicted', async () => {
    const store = new MemoryStateRepository();
    const provider = createProvider();
    const service = new ClassificationService(provider, store);
    const inputs = [input, { ...input, url: 'https://example.com/second' }];
    await service.classifyBatch(inputs, folders, settings, true);
    await store.update((state) => {
      state.cache = Object.fromEntries(Object.entries(state.cache).filter(([, entry]) => entry.mode === 'batch'));
    });
    const outcomes = await service.classifyBatch(inputs, folders, settings, false);
    expect(outcomes.map((outcome) => 'result' in outcome && outcome.result.source)).toEqual(['cache', 'cache']);
    expect(outcomes.every((outcome) => 'result' in outcome && outcome.result.cacheValidation?.())).toBe(true);
    expect(provider.classifyBatch).toHaveBeenCalledOnce();
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it.each(['single', 'batch'] as const)('invalidates shared single and whole-batch entries when only the %s policy changes', async (changedMode) => {
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());
    const inputs = [input, { ...input, url: 'https://example.com/second' }];
    await service.classifyBatch(inputs, folders, settings, true);
    const originalRequest = provider.getCacheRequest!;
    provider.getCacheRequest = (mode, ...args) => ({ ...originalRequest(mode, ...args), ...(mode === changedMode ? { policy: 'updated' } : {}) });
    await expect(service.classify(input, folders, settings, false)).rejects.toBeInstanceOf(PermissionRequiredError);
    await expect(service.classifyBatch(inputs, folders, settings, false)).rejects.toBeInstanceOf(PermissionRequiredError);
    expect(provider.classify).not.toHaveBeenCalled();
    expect(provider.classifyBatch).toHaveBeenCalledOnce();
  });

  it('keeps independent over-budget candidates stable across companions, ordering and cache hits', async () => {
    const fatSample = (id: string) => ({ title: 'x'.repeat(400), url: `https://${id}.test/${'y'.repeat(400)}`, hostname: `${id}.test` });
    const many: FolderSummary[] = [
      { id: 'current', name: '待分类', path: '智能书签 / 待分类' },
      { id: 'react', name: 'React', path: '智能书签 / 开发 / React' },
      { id: 'python', name: 'Python', path: '智能书签 / 开发 / Python' },
      ...Array.from({ length: 24 }, (_, index) => ({ id: `bulk-${index}`, name: `bulk ${index}`, path: `智能书签 / bulk ${index}`, samples: [fatSample(`bulk${index}`), fatSample(`bx${index}`), fatSample(`by${index}`)] })),
    ];
    const react = { title: 'Hooks guide', url: 'https://example.com/react/hooks', domain: 'example.com', currentFolder: '智能书签 / 待分类', currentFolderId: 'current' };
    const python = { ...react, title: 'Python guide', url: 'https://example.com/python/guide' };
    const otherReact = { ...react, url: 'https://example.com/react/hooks#other' };
    const reactCandidates = rankFolderCandidates(react, many);
    const pythonCandidates = rankFolderCandidates(python, many);
    expect(reactCandidates).not.toEqual(pythonCandidates);
    expect(rankFolderCandidates(otherReact, many)).toEqual(reactCandidates);
    expect(reactCandidates.some((folder) => folder.id === 'current')).toBe(true);
    const strictSettings = { ...settings, confidenceThreshold: 1 };
    const provider = createProvider();
    provider.classifyBatch = vi.fn<NonNullable<ClassifierProvider['classifyBatch']>>(async (items, candidates, config, corrections, onRequest) => {
      onRequest?.(provider.getCacheRequest!('batch', items, candidates, config, corrections)!);
      return items.map((item) => ({ action: 'keep' as const, confidence: 0.4, reason: item.url }));
    });
    const store = new MemoryStateRepository();
    const service = new ClassificationService(provider, store);
    await service.classifyBatch([react, python, otherReact], many, strictSettings, true);
    expect(vi.mocked(provider.classifyBatch!).mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [[react, otherReact], reactCandidates], [[python], pythonCandidates],
    ]);
    expect((await service.classify(react, many, strictSettings, false)).source).toBe('cache');
    await store.update((state) => {
      state.cache = Object.fromEntries(Object.entries(state.cache).filter(([, entry]) => !entry.results.some((result) => result.reason === python.url)));
    });
    const mixed = await service.classifyBatch([otherReact, python, react], many, strictSettings, true);
    expect(mixed.map((outcome) => 'result' in outcome && outcome.result.source)).toEqual(['cache', 'ai', 'cache']);
    expect(vi.mocked(provider.classifyBatch!).mock.calls[2]?.slice(0, 2)).toEqual([[python], pythonCandidates]);
    await service.classifyBatch([python, react, otherReact], many, strictSettings, false);
    expect(provider.classifyBatch).toHaveBeenCalledTimes(3);
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it.each(['single', 'batch'] as const)('skips %s cache writes if the variant changes before the storage mutator', async (mode) => {
    let variant = 0;
    const store = new MemoryStateRepository();
    const update = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementationOnce(async (mutator) => {
      variant += 1;
      return update(mutator);
    });
    const provider = createProvider();
    provider.getCacheVariant = () => variant;
    const service = new ClassificationService(provider, store);
    if (mode === 'single') await service.classify(input, folders, settings, true);
    else await service.classifyBatch([input, { ...input, url: 'https://example.com/other' }], folders, settings, true);
    expect((await store.load()).cache).toEqual({});
    await expect(service.classify(input, folders, settings, false)).rejects.toBeInstanceOf(PermissionRequiredError);
  });

  it('bounds mixed batch and individual cache entries without per-member storage writes', async () => {
    const store = new MemoryStateRepository();
    const update = vi.spyOn(store, 'update');
    const provider = createProvider();
    const service = new ClassificationService(provider, store);
    let lastInputs: ClassificationInput[] = [];
    for (let batch = 0; batch < 7; batch += 1) {
      lastInputs = Array.from({ length: 15 }, (_, index) => ({ ...input, url: `https://example.com/${batch}/${index}` }));
      await service.classifyBatch(lastInputs, folders, settings, true);
    }
    const entries = Object.values((await store.load()).cache);
    expect(entries.reduce((count, entry) => count + entry.results.length, 0)).toBeLessThanOrEqual(200);
    expect(entries.some((entry) => entry.mode === 'batch' && entry.results.length === 15)).toBe(true);
    expect(entries.some((entry) => entry.mode === 'single')).toBe(true);
    expect(entries.every((entry) => new TextEncoder().encode(JSON.stringify(entry)).byteLength <= 64 * 1024)).toBe(true);
    expect(update).toHaveBeenCalledTimes(7);
    expect((await service.classifyBatch(lastInputs, folders, settings, false)).every((outcome) => 'result' in outcome && outcome.result.source === 'cache')).toBe(true);
    expect(provider.classifyBatch).toHaveBeenCalledTimes(7);
  });

  it.each(['single', 'batch'] as const)('retries to the last bounded %s cache variant and preserves whole-batch ordering', async (mode) => {
    const store = new MemoryStateRepository();
    const provider = createProvider();
    const originalRequest = provider.getCacheRequest!;
    let generation = 0;
    provider.getCacheRequest = (...args) => ({ ...originalRequest(...args), generation });
    provider.classify = vi.fn(async (item, candidates, config, corrections, callback) => {
      callback?.(provider.getCacheRequest!('single', [item], candidates, config, corrections)!);
      return { action: 'keep' as const, confidence: 0.4, reason: `variant-${generation}` };
    });
    provider.classifyBatch = vi.fn(async (items, candidates, config, corrections, callback) => {
      callback?.(provider.getCacheRequest!('batch', items, candidates, config, corrections)!);
      return items.map((_: ClassificationInput, index: number) => ({ action: 'keep' as const, confidence: 0.4, reason: `variant-${generation}-${index}` }));
    });
    const service = new ClassificationService(provider, store);
    const inputs = [input, { ...input, url: 'https://example.com/other' }];
    const classify = (permission: boolean) => mode === 'single'
      ? service.classify(input, folders, settings, permission)
      : service.classifyBatch(inputs, folders, settings, permission);
    for (generation = 0; generation < 3; generation += 1) await classify(true);
    expect(Object.keys((await store.load()).cache)).toHaveLength(mode === 'single' ? 3 : 9);
    generation = 0;
    const subtle = globalThis.crypto.subtle;
    const originalSign = subtle.sign.bind(subtle);
    const sign = vi.spyOn(subtle, 'sign').mockImplementation(async (...args) => {
      const digest = await originalSign(...args);
      if (generation < 2) generation += 1;
      return digest;
    });
    try {
      const result = await classify(false);
      expect(sign).toHaveBeenCalledTimes(mode === 'single' ? 3 : 4);
      if (Array.isArray(result)) {
        expect(result.map((item) => 'result' in item && [item.result.source, item.result.result.reason]))
          .toEqual([['cache', 'variant-2-0'], ['cache', 'variant-2-1']]);
      } else {
        expect(result).toMatchObject({ source: 'cache', result: { reason: 'variant-2' } });
      }
      expect(mode === 'single' ? provider.classify : provider.classifyBatch).toHaveBeenCalledTimes(3);
    } finally {
      sign.mockRestore();
    }
  });

  it.each(['single', 'batch'] as const)('bounds retries when the %s provider variant keeps changing', async (mode) => {
    const store = new MemoryStateRepository();
    const provider = createProvider();
    const service = new ClassificationService(provider, store);
    const inputs = [input, { ...input, url: 'https://example.com/other' }];
    if (mode === 'single') await service.classify(input, folders, settings, true);
    else await service.classifyBatch(inputs, folders, settings, true);
    const originalRequest = provider.getCacheRequest!;
    let generation = 0;
    provider.getCacheRequest = (...args) => ({ ...originalRequest(...args), generation });
    const subtle = globalThis.crypto.subtle;
    const originalSign = subtle.sign.bind(subtle);
    const sign = vi.spyOn(subtle, 'sign').mockImplementation(async (...args) => {
      const digest = await originalSign(...args);
      generation += 1;
      return digest;
    });
    try {
      const classify = (permission: boolean) => mode === 'single'
        ? service.classify(input, folders, settings, permission)
        : service.classifyBatch(inputs, folders, settings, permission);
      const callCount = mode === 'single' ? vi.mocked(provider.classify).mock.calls.length : vi.mocked(provider.classifyBatch!).mock.calls.length;
      await expect(classify(false)).rejects.toBeInstanceOf(PermissionRequiredError);
      expect(sign).toHaveBeenCalledTimes(mode === 'single' ? 3 : 9);
      expect(mode === 'single' ? vi.mocked(provider.classify).mock.calls.length : vi.mocked(provider.classifyBatch!).mock.calls.length).toBe(callCount);
      const after = await classify(true);
      expect(sign).toHaveBeenCalledTimes(mode === 'single' ? 6 : 18);
      if (Array.isArray(after)) {
        expect(after.map((item) => 'result' in item && item.result.source)).toEqual(['ai', 'ai']);
      } else {
        expect(after.source).toBe('ai');
      }
      expect(mode === 'single' ? vi.mocked(provider.classify).mock.calls.length : vi.mocked(provider.classifyBatch!).mock.calls.length).toBe(callCount + 1);
    } finally {
      sign.mockRestore();
    }
  });

  it.each(['single', 'batch'] as const)('does not reuse cache if the %s provider cannot expose a stable variant token', async (mode) => {
    const store = new MemoryStateRepository();
    const provider = createProvider();
    const service = new ClassificationService(provider, store);
    const inputs = [input, { ...input, url: 'https://example.com/other' }];
    const classify = (permission: boolean) => mode === 'single'
      ? service.classify(input, folders, settings, permission)
      : service.classifyBatch(inputs, folders, settings, permission);
    await classify(true);
    expect(Object.keys((await store.load()).cache)).toHaveLength(mode === 'single' ? 1 : 3);
    provider.getCacheVariant = () => undefined;
    await expect(classify(false)).rejects.toBeInstanceOf(PermissionRequiredError);
    delete provider.getCacheVariant;
    await expect(classify(false)).rejects.toBeInstanceOf(PermissionRequiredError);
    await classify(true);
    expect(Object.keys((await store.load()).cache)).toHaveLength(mode === 'single' ? 1 : 3);
    expect(mode === 'single' ? provider.classify : provider.classifyBatch).toHaveBeenCalledTimes(2);
  });

  it('never reuses an earlier variant token after a provider changes away and back', async () => {
    const provider = createProvider();
    let variant = 0;
    let useFallback = false;
    const request = provider.getCacheRequest!;
    provider.getCacheVariant = () => variant;
    provider.getCacheRequest = (...args) => ({ ...request(...args), useFallback });
    provider.classify = vi.fn(async (item, candidates, config, corrections, callback) => {
      callback?.(provider.getCacheRequest!('single', [item], candidates, config, corrections)!);
      return { action: 'keep' as const, confidence: 0.4, reason: 'valid' };
    });
    const service = new ClassificationService(provider, new MemoryStateRepository());
    await service.classify(input, folders, settings, true);
    const oldHit = await service.classify(input, folders, settings, false);
    expect(oldHit.cacheValidation?.()).toBe(true);
    useFallback = true;
    variant += 1;
    expect(oldHit.cacheValidation?.()).toBe(false);
    useFallback = false;
    variant += 1;
    expect(oldHit.cacheValidation?.()).toBe(false);
    const newHit = await service.classify(input, folders, settings, false);
    expect(newHit.cacheValidation?.()).toBe(true);
    expect(oldHit.cacheValidation?.()).toBe(false);
  });

  it('fails closed if a cached result can no longer read its provider variant', async () => {
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());
    await service.classify(input, folders, settings, true);
    const cached = await service.classify(input, folders, settings, false);
    expect(cached.cacheValidation?.()).toBe(true);
    provider.getCacheVariant = () => { throw new Error('provider unavailable'); };
    expect(cached.cacheValidation?.()).toBe(false);
  });

  it('caches valid mapped members despite an invalid target but rejects incomplete batches', async () => {
    const store = new MemoryStateRepository();
    const provider = createProvider();
    provider.classifyBatch = vi.fn(async () => [
      { action: 'move' as const, targetFolderId: 'ghost', confidence: 0.9, reason: 'invalid' },
      { action: 'keep' as const, confidence: 0.4, reason: 'valid' },
    ]);
    const service = new ClassificationService(provider, store);
    const inputs = [input, { ...input, url: 'https://example.com/second' }];
    const snapshot = await store.load();
    const request = provider.getCacheRequest!('batch', inputs, folders, { protocol: settings.protocol, baseUrl: settings.baseUrl, model: settings.model, apiKey: settings.apiKey }, []);
    const callbackProvider = provider.classifyBatch;
    provider.classifyBatch = async (...args) => {
      if (request) args[4]?.(request);
      return callbackProvider!(...args);
    };
    const outcomes = await service.classifyBatch(inputs, folders, settings, true, snapshot);
    expect(outcomes[0]).toHaveProperty('error');
    expect(outcomes[1]).toHaveProperty('result');
    const cache = (await store.load()).cache;
    expect(Object.values(cache)).toHaveLength(1);
    expect(Object.values(cache)[0]).toMatchObject({ mode: 'single', results: [{ reason: 'valid' }] });
    expect((await service.classify(inputs[1]!, folders, settings, false)).source).toBe('cache');
    await expect(service.classify(input, folders, settings, false)).rejects.toBeInstanceOf(PermissionRequiredError);
    provider.classifyBatch = vi.fn(async () => [{ action: 'keep' as const, confidence: 0.4, reason: 'only one' }]);
    await expect(service.classifyBatch([input, { ...input, url: 'https://example.com/third' }], folders, settings, true)).rejects.toThrow('缺少');
    expect((await store.load()).cache).toEqual(cache);
  });

  it('rejects cached deleted/managed targets, malformed entries and unknown provider variants', async () => {
    const store = new MemoryStateRepository();
    const provider = createProvider();
    const request = provider.getCacheRequest!;
    provider.classify = vi.fn(async (item, candidates, config, corrections, callback) => {
      callback?.(request('single', [item], candidates, config, corrections));
      return { action: 'move' as const, targetFolderId: 'research', confidence: 0.9, reason: 'target' };
    });
    const service = new ClassificationService(provider, store);
    await service.classify(input, folders, settings, true);
    const badFolders = folders.map((folder) => folder.id === 'research' ? { ...folder, unmodifiable: 'managed' } : folder);
    await expect(service.classify(input, badFolders, settings, true)).rejects.toThrow('不存在');
    await store.update((state) => {
      const key = Object.keys(state.cache)[0]!;
      const invalid = { action: 'move' as const, targetFolderId: 'deleted', confidence: 0.9, reason: 'deleted target' };
      state.cache[key]!.result = invalid;
      state.cache[key]!.results = [invalid];
    });
    await service.classify(input, folders, settings, true);
    await store.update((state) => {
      const key = Object.keys(state.cache)[0]!;
      (state.cache[key] as unknown as Record<string, unknown>).results = [{ action: 'keep', confidence: 99, reason: 'bad' }];
    });
    await service.classify(input, folders, settings, true);
    expect(provider.classify).toHaveBeenCalledTimes(4);
    delete provider.getCacheRequest;
    await service.classify(input, folders, settings, true);
    await service.classify(input, folders, settings, true);
    expect(provider.classify).toHaveBeenCalledTimes(6);
  });

  it('does not reuse a whole batch if one stored member has a deleted destination', async () => {
    const store = new MemoryStateRepository();
    const provider = createProvider();
    const service = new ClassificationService(provider, store);
    const inputs = [input, { ...input, url: 'https://example.com/second' }];
    await service.classifyBatch(inputs, folders, settings, true);
    await store.update((state) => {
      state.cache = Object.fromEntries(Object.entries(state.cache).filter(([, entry]) => entry.mode === 'batch'));
      const entry = Object.values(state.cache)[0]!;
      entry.results[1] = { action: 'move', targetFolderId: 'deleted', confidence: 0.9, reason: 'deleted' };
    });
    expect((await service.classifyBatch(inputs, folders, settings, true)).map((outcome) => 'result' in outcome && outcome.result.source)).toEqual(['ai', 'ai']);
    expect(provider.classifyBatch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(provider.classifyBatch!).mock.calls[1]?.[0]).toEqual(inputs);
  });

  it('reuses the unaffected individual member when a sibling cache target is invalid', async () => {
    const store = new MemoryStateRepository();
    const provider = createProvider();
    const service = new ClassificationService(provider, store);
    const inputs = [input, { ...input, url: 'https://example.com/second' }];
    await service.classifyBatch(inputs, folders, settings, true);
    await store.update((state) => {
      const first = Object.values(state.cache).find((entry) => entry.mode === 'single')!;
      const batch = Object.values(state.cache).find((entry) => entry.mode === 'batch')!;
      const invalid = { action: 'move' as const, targetFolderId: 'deleted', confidence: 0.9, reason: 'deleted' };
      first.result = invalid;
      first.results = [invalid];
      batch.result = invalid;
      batch.results[0] = invalid;
    });
    const outcomes = await service.classifyBatch(inputs, folders, settings, true);
    expect(outcomes.map((outcome) => 'result' in outcome && outcome.result.source)).toEqual(['ai', 'cache']);
    expect(vi.mocked(provider.classifyBatch!).mock.calls[1]?.[0]).toEqual([input]);
  });

  it('invalidates when a recent correction target path changes outside the provider candidate set', async () => {
    const fatSample = (id: string) => ({ title: 'x'.repeat(400), url: `https://${id}.test/${'y'.repeat(400)}`, hostname: `${id}.test` });
    const many: FolderSummary[] = [
      { id: 'current', name: '待分类', path: '智能书签 / 待分类' },
      { id: 'react', name: 'React', path: '智能书签 / 开发 / React' },
      ...Array.from({ length: 24 }, (_, index) => ({ id: `bulk-${index}`, name: `bulk ${index}`, path: `智能书签 / bulk ${index}`, samples: [fatSample(`bulk${index}`), fatSample(`bx${index}`), fatSample(`by${index}`)] })),
    ];
    const request = { title: 'Hooks guide', url: 'https://example.com/react/hooks', domain: 'example.com', currentFolder: '智能书签 / 待分类', currentFolderId: 'current' };
    const candidates = rankFolderCandidates(request, many);
    const excluded = many.find((folder) => !candidates.some((candidate) => candidate.id === folder.id))!;
    expect(excluded).toBeDefined();
    const changed = many.map((folder) => folder.id === excluded.id ? { ...folder, path: `${folder.path} / renamed` } : folder);
    expect(rankFolderCandidates(request, changed)).toEqual(candidates);
    expect(classifyWithRules(request, changed)).toEqual(classifyWithRules(request, many));
    const store = new MemoryStateRepository();
    await store.update((state) => { state.corrections['other.example'] = { domain: 'other.example', action: 'move', folderId: excluded.id, createdAt: 1 }; });
    const provider = createProvider();
    const service = new ClassificationService(provider, store);
    const strictSettings = { ...settings, confidenceThreshold: 1 };
    expect((await service.classify(request, many, strictSettings, true)).source).toBe('ai');
    expect((await service.classify(request, many, strictSettings, false)).source).toBe('cache');
    expect((await service.classify(request, changed, strictSettings, true)).source).toBe('ai');
    const calls = vi.mocked(provider.classify).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toEqual(calls[1]?.[1]);
    expect(calls[0]?.[3]).toEqual([{ domain: 'other.example', action: 'move', folderPath: excluded.path }]);
    expect(calls[1]?.[3]).toEqual([{ domain: 'other.example', action: 'move', folderPath: `${excluded.path} / renamed` }]);
  });

  it('keeps over-budget irrelevant-folder changes warm while the old full-tree fingerprint changes', async () => {
    const fatSample = (id: string) => ({ title: 'x'.repeat(400), url: `https://${id}.test/${'y'.repeat(400)}`, hostname: `${id}.test` });
    const many: FolderSummary[] = [
      { id: 'current', name: '待分类', path: '智能书签 / 待分类' },
      { id: 'react', name: 'React', path: '智能书签 / 开发 / React' },
      ...Array.from({ length: 24 }, (_, index) => ({ id: `bulk-${index}`, name: `bulk ${index}`, path: `智能书签 / bulk ${index}`, samples: [fatSample(`bulk${index}`), fatSample(`bx${index}`), fatSample(`by${index}`)] })),
    ];
    const request = { title: 'Hooks guide', url: 'https://example.com/react/hooks', domain: 'example.com', currentFolder: '智能书签 / 待分类', currentFolderId: 'current' };
    const strictSettings = { ...settings, confidenceThreshold: 1 };
    const beforeCandidates = rankFolderCandidates(request, many);
    const excluded = many.find((folder) => !beforeCandidates.some((candidate) => candidate.id === folder.id))!;
    expect(excluded).toBeDefined();
    const changed = many.map((folder) => folder.id === excluded.id ? { ...folder, samples: folder.samples?.map((sample) => ({ ...sample, title: `${sample.title}z` })) } : folder);
    expect(classifyWithRules(request, many)).toEqual(classifyWithRules(request, changed));
    expect(rankFolderCandidates(request, changed)).toEqual(beforeCandidates);
    const oldFingerprint = (value: FolderSummary[]) => stableFingerprint(value.map((folder) => JSON.stringify({ id: folder.id, name: folder.name, path: folder.path, folderType: folder.folderType ?? '', unmodifiable: folder.unmodifiable ?? '', samples: (folder.samples ?? []).slice(0, 3) })).sort());
    expect(oldFingerprint(changed)).not.toBe(oldFingerprint(many));
    const provider = createProvider();
    const service = new ClassificationService(provider, new MemoryStateRepository());
    expect((await service.classify(request, many, strictSettings, true)).source).toBe('ai');
    expect((await service.classify(request, changed, strictSettings, false)).source).toBe('cache');
    expect(provider.classify).toHaveBeenCalledTimes(1);
  });

  it('does not persist request bodies, key material or derived profile contents', async () => {
    const store = new MemoryStateRepository();
    const service = new ClassificationService(createProvider(), store);
    await service.classify({ ...input, pageProfile: { summary: 'private-derived-profile', topics: ['profile-topic'], contentType: 'article' } }, folders, settings, true);
    const json = JSON.stringify((await store.load()).cache);
    expect(json).not.toContain('test-key');
    expect(json).not.toContain('private-derived-profile');
    expect(json).not.toContain(input.url);
  });

  it('blocks reuse after A→B→A and skips cache writes for in-flight credential changes', async () => {
    const initial = emptyPersistedState();
    initial.settings.apiKey = 'A';
    const store = new MemoryStateRepository(initial);
    const provider = createProvider();
    const service = new ClassificationService(provider, store);
    const settingsService = new SettingsService({ store, classifier: service, hasProviderPermission: async () => true, afterUpdate: async () => {} });
    await service.classify(input, folders, initial.settings, true);
    expect((await service.classify(input, folders, initial.settings, false)).source).toBe('cache');
    await settingsService.updateSettings({ apiKey: 'B' });
    await settingsService.updateSettings({ apiKey: 'A' });
    expect((await store.load()).credentialGeneration).toBe(2);
    expect((await service.classify(input, folders, initial.settings, true)).source).toBe('ai');

    const request = provider.getCacheRequest!;
    provider.classify = vi.fn(async (item, candidates, config, corrections, callback) => {
      callback?.(request('single', [item], candidates, config, corrections));
      await settingsService.updateSettings({ apiKey: 'C' });
      return { action: 'keep' as const, confidence: 0.4, reason: 'done' };
    });
    const racing = { ...input, url: 'https://example.com/inflight' };
    const countBefore = Object.keys((await store.load()).cache).length;
    await service.classify(racing, folders, initial.settings, true);
    expect(Object.keys((await store.load()).cache)).toHaveLength(countBefore);
  });

  it('uses supplied learning snapshots and degrades safely when cryptography is unavailable', async () => {
    const store = new MemoryStateRepository();
    const provider = createProvider();
    const service = new ClassificationService(provider, store);
    const snapshot = await store.load();
    await store.update((state) => { state.corrections[correctionUrl(input.url)] = { domain: 'example.com', url: correctionUrl(input.url), action: 'keep', createdAt: 1 }; });
    expect((await service.classify(input, folders, settings, true, snapshot)).source).toBe('ai');
    expect((await service.classify(input, folders, settings, false)).source).toBe('rule');
    const savedCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
      const noCrypto = new ClassificationService(createProvider(), new MemoryStateRepository());
      expect((await noCrypto.classify(input, folders, settings, true)).source).toBe('ai');
      await expect(noCrypto.classify(input, folders, settings, false)).rejects.toBeInstanceOf(PermissionRequiredError);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: savedCrypto });
    }
  });
});

function createProvider(): ClassifierProvider {
  const getCacheRequest = (mode: 'single' | 'batch', inputs: ClassificationInput[], candidates: FolderSummary[], _config: ProviderConfig, corrections?: RecentCorrection[]) => ({
    mode,
    messages: mode === 'single'
      ? buildClassificationMessages(inputs[0]!, candidates, corrections)
      : buildBatchMessages(inputs, candidates, corrections),
  });
  return {
    getCacheRequest,
    getCacheVariant: () => 0,
    classify: vi.fn(async (input, candidates, config, corrections, onRequest) => {
      onRequest?.(getCacheRequest('single', [input], candidates, config, corrections));
      return { action: 'keep' as const, confidence: 0.4, reason: '没有明显分类。' };
    }),
    classifyBatch: vi.fn(async (inputs, candidates, config, corrections, onRequest) => {
      onRequest?.(getCacheRequest('batch', inputs, candidates, config, corrections));
      return inputs.map(() => ({ action: 'keep' as const, confidence: 0.4, reason: '没有明显分类。' }));
    }),
    test: vi.fn(async () => undefined),
  };
}
