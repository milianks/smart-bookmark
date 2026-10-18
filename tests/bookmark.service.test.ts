import { describe, expect, it, vi } from 'vitest';
import {
  ChromeBookmarkService,
  enumerateHistoricalBookmarks,
  getFoldersWithinRoot,
  isNodeWithinRoot,
  isValidTargetFolder,
  SMART_BOOKMARK_DEFAULT_FOLDERS,
  smartBookmarkOwnerName,
  type BookmarkApi,
  type BookmarkNode,
} from '../services/bookmark.service';

describe('ChromeBookmarkService', () => {
  it('按保护边界枚举历史书签，强制模式才包含自建文件夹后代', () => {
    const tree: BookmarkNode[] = [{ id: '0', title: '', children: [
      { id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', children: [
        { id: 'direct', title: 'Direct', url: 'https://example.com/direct', parentId: 'bar' },
        { id: 'folder', title: '自建', parentId: 'bar', children: [
          { id: 'nested', title: 'Nested', url: 'https://example.com/nested', parentId: 'folder' },
        ] },
        { id: 'javascript', title: 'JS', url: 'javascript:alert(1)', parentId: 'bar' },
      ] },
      { id: 'managed', title: '托管', folderType: 'other', unmodifiable: 'managed', children: [
        { id: 'blocked', title: 'Blocked', url: 'https://example.com/blocked', parentId: 'managed' },
      ] },
    ] }];

    expect(enumerateHistoricalBookmarks(tree, false).map((item) => item.id)).toEqual(['direct']);
    expect(enumerateHistoricalBookmarks(tree, true).map((item) => item.id)).toEqual(['direct', 'nested']);
  });

  it('遍历书签树、生成文件夹路径并执行受验证的移动和创建', async () => {
    const tree: BookmarkNode[] = [{ id: 'root', title: '', children: [
      { id: 'bar', title: 'Bookmarks bar', folderType: 'bookmarks-bar', children: [
        { id: 'topic', title: 'AI', parentId: 'bar', children: [] },
        { id: 'bookmark', title: 'Article', url: 'https://example.com', parentId: 'bar' },
      ] },
    ] }];
    const api: BookmarkApi = {
      getTree: vi.fn(async () => tree),
      get: vi.fn(async (id) => {
        const found = findNode(tree, id);
        if (!found) throw new Error('Not found');
        return [found];
      }),
      move: vi.fn(async () => tree[0]!),
      create: vi.fn(async ({ parentId, title }) => ({ id: 'new', title, parentId, children: [] })),
    };
    const service = new ChromeBookmarkService(api);

    expect(await service.getFolderPath('topic')).toBe('Bookmarks bar / AI');
    expect(await service.isEligibleRoot('bar')).toBe(true);
    await service.moveBookmark('bookmark', 'topic');
    await service.createFolder('Research', 'bar');
    expect(api.move).toHaveBeenCalledWith('bookmark', { parentId: 'topic' });
    expect(api.create).toHaveBeenCalledWith({ parentId: 'bar', title: 'Research' });
  });

  it('不允许移动到不存在的文件夹', async () => {
    const api: BookmarkApi = {
      getTree: vi.fn(async () => []),
      get: vi.fn(async () => { throw new Error('Not found'); }),
      move: vi.fn(async () => ({ id: 'bookmark', title: '', url: 'https://example.com' })),
      create: vi.fn(async () => ({ id: 'folder', title: '' })),
    };
    await expect(new ChromeBookmarkService(api).moveBookmark('bookmark', 'missing')).rejects.toThrow('目标文件夹');
    expect(api.move).not.toHaveBeenCalled();
  });

  it('按账号本地部分创建智能根目录和一级默认布局', async () => {
    const tree: BookmarkNode[] = [{ id: 'root', title: '', children: [
      { id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', children: [] },
    ] }];
    let nextId = 0;
    const api: BookmarkApi = {
      getTree: vi.fn(async () => structuredClone(tree)),
      get: vi.fn(async (id) => {
        const found = findNode(tree, id);
        if (!found) throw new Error('Not found');
        return [found];
      }),
      move: vi.fn(async () => tree[0]!),
      create: vi.fn(async ({ parentId, title }) => {
        const parent = findNode(tree, parentId);
        if (!parent) throw new Error('Parent not found');
        const node = { id: `created-${++nextId}`, title, parentId, children: [] };
        (parent.children ??= []).push(node);
        return node;
      }),
    };
    const service = new ChromeBookmarkService(api);

    await expect(service.initializeSmartBookmarkRoot({
      identity: { getProfileUserInfo: async () => ({ email: '  yuan@example.com ' }) },
    })).resolves.toMatchObject({ title: 'yuan 的智能书签', created: true, defaultsCreated: SMART_BOOKMARK_DEFAULT_FOLDERS.length });
    expect(api.create).toHaveBeenCalledTimes(1 + SMART_BOOKMARK_DEFAULT_FOLDERS.length);
    expect(findNode(tree, 'bar')?.children?.map((node) => node.title)).toEqual(['yuan 的智能书签']);
    expect(findNode(tree, 'created-1')?.children?.map((node) => node.title)).toEqual([...SMART_BOOKMARK_DEFAULT_FOLDERS]);
  });

  it('复用唯一同名根目录，邮箱不可用时回退 bookmark，并保持重复初始化幂等', async () => {
    const tree: BookmarkNode[] = [{ id: 'root', title: '', children: [
      { id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', children: [
        { id: 'smart', title: 'bookmark 的智能书签', parentId: 'bar', children: [] },
      ] },
    ] }];
    let nextId = 0;
    let createCalls = 0;
    const api: BookmarkApi = {
      getTree: vi.fn(async () => structuredClone(tree)),
      get: vi.fn(async (id) => {
        const found = findNode(tree, id);
        if (!found) throw new Error('Not found');
        return [found];
      }),
      move: vi.fn(async () => tree[0]!),
      create: vi.fn(async ({ parentId, title }) => {
        const parent = findNode(tree, parentId);
        if (!parent) throw new Error('Parent not found');
        createCalls += 1;
        const node = { id: `created-${++nextId}`, title, parentId, children: [] };
        (parent.children ??= []).push(node);
        return node;
      }),
    };
    const service = new ChromeBookmarkService(api);
    const identity = { getProfileUserInfo: async () => { throw new Error('not signed in'); } };

    await expect(service.initializeSmartBookmarkRoot({ identity, initializeDefaults: true })).resolves.toMatchObject({ rootId: 'smart', title: 'bookmark 的智能书签', created: false });
    const callsAfterFirstInitialization = createCalls;
    await expect(service.initializeSmartBookmarkRoot({ storedRootId: 'smart', identity, initializeDefaults: false })).resolves.toMatchObject({ rootId: 'smart', created: false, defaultsCreated: 0 });
    expect(createCalls).toBe(callsAfterFirstInitialization);
    expect(smartBookmarkOwnerName('')).toBe('bookmark');
  });

  it('边界 helper 只返回智能根目录内的可编辑目录', () => {
    const tree: BookmarkNode[] = [{ id: 'root', title: '', children: [
      { id: 'smart', title: '智能书签', parentId: 'bar', children: [
        { id: 'dev', title: '开发', parentId: 'smart', children: [
          { id: 'bookmark', title: '页面', url: 'https://example.com', parentId: 'dev' },
        ] },
        { id: 'managed', title: '托管', parentId: 'smart', unmodifiable: 'managed', children: [
          { id: 'blocked', title: '禁止', url: 'https://example.com/blocked', parentId: 'managed' },
        ] },
      ] },
      { id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', children: [] },
    ] }];

    expect(isNodeWithinRoot(tree, 'smart', 'smart')).toBe(true);
    expect(isNodeWithinRoot(tree, 'bookmark', 'smart')).toBe(true);
    expect(isNodeWithinRoot(tree, 'blocked', 'smart')).toBe(false);
    expect(isValidTargetFolder(tree, 'dev', 'smart')).toBe(true);
    expect(isValidTargetFolder(tree, 'managed', 'smart')).toBe(false);
    expect(getFoldersWithinRoot(tree, 'smart').map((folder) => folder.id)).toEqual(['smart', 'dev']);
  });

  it('智能根目录摘要只携带最多三条有界 HTTP 书签样例', () => {
    const longTitle = '标题'.repeat(200);
    const longUrl = `https://example.com/${'path/'.repeat(200)}`;
    const tree: BookmarkNode[] = [{ id: 'root', title: '', children: [
      { id: 'smart', title: '智能书签', parentId: 'bar', children: [
        { id: 'dev', title: '开发', parentId: 'smart', children: [
          { id: 'one', title: 'React', url: 'https://react.dev/reference/react', parentId: 'dev' },
          { id: 'two', title: longTitle, url: longUrl, parentId: 'dev' },
          { id: 'three', title: 'Skip me', url: 'javascript:alert(1)', parentId: 'dev' },
          { id: 'four', title: 'Hooks', url: 'https://react.dev/reference/hooks', parentId: 'dev' },
          { id: 'five', title: 'Router', url: 'https://react.dev/reference/router', parentId: 'dev' },
        ] },
      ] },
      { id: 'bar', title: '书签栏', folderType: 'bookmarks-bar', children: [] },
    ] }];

    const [folder] = getFoldersWithinRoot(tree, 'smart').filter((item) => item.id === 'dev');
    expect(folder?.samples).toHaveLength(3);
    expect(folder?.samples?.every((sample) => sample.title.length <= 160 && sample.url.length <= 512 && sample.hostname.length <= 253)).toBe(true);
    expect(folder?.samples?.map((sample) => sample.hostname)).toEqual(['react.dev', 'example.com', 'react.dev']);
  });
});

function findNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const result = node.children ? findNode(node.children, id) : undefined;
    if (result) return result;
  }
  return undefined;
}
