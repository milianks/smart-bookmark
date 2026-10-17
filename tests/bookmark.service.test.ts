import { describe, expect, it, vi } from 'vitest';
import { ChromeBookmarkService, enumerateHistoricalBookmarks, type BookmarkApi, type BookmarkNode } from '../services/bookmark.service';

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
});

function findNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const result = node.children ? findNode(node.children, id) : undefined;
    if (result) return result;
  }
  return undefined;
}
