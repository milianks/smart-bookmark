import { describe, expect, it, vi } from 'vitest';
import { MemoryStateRepository } from '../lib/storage/repository';
import { emptyPersistedState } from '../types/domain';
import type { BookmarkPort } from '../services/bookmark.service';
import { BookmarkMetadataService } from '../services/bookmark-metadata.service';

function makeSetup() {
  const initial = emptyPersistedState();
  initial.settings.apiKey = 'private-key';
  initial.settings.baseUrl = 'https://provider.example/v1';
  const store = new MemoryStateRepository(initial);
  const bookmarks = {
    getBookmark: vi.fn(async () => ({ id: 'bookmark-1', title: 'Example title', url: 'https://example.test/docs', parentId: 'folder-1' })),
    getFolderPath: vi.fn(async () => 'Bookmarks bar / Dev'),
    getTree: vi.fn(), getFolder: vi.fn(), getFolders: vi.fn(), folderExists: vi.fn(), isEligibleRoot: vi.fn(),
    moveBookmark: vi.fn(), createFolder: vi.fn(),
  } as unknown as BookmarkPort;
  const generateMetadata = vi.fn(async () => ({ summary: 'Useful documentation', tags: ['docs', 'typescript'] }));
  const provider = { generateMetadata, classify: vi.fn(), test: vi.fn() };
  const hasProviderPermission = vi.fn(async () => true);
  const service = new BookmarkMetadataService({ bookmarks, store, provider, hasProviderPermission, now: () => 123 });
  return { service, store, bookmarks, provider, hasProviderPermission, generateMetadata };
}

describe('BookmarkMetadataService', () => {
  it('uses metadata-only live bookmark projection and persists validated result without bookmark mutations', async () => {
    const { service, store, bookmarks, provider, hasProviderPermission, generateMetadata } = makeSetup();

    await expect(service.generate('bookmark-1')).resolves.toEqual({
      summary: 'Useful documentation', tags: ['docs', 'typescript'], generatedAt: 123,
    });

    expect(hasProviderPermission).toHaveBeenCalledWith('https://provider.example/v1');
    expect(generateMetadata).toHaveBeenCalledWith({
      title: 'Example title', url: 'https://example.test/docs', domain: 'example.test', currentFolder: 'Bookmarks bar / Dev',
    }, expect.objectContaining({ apiKey: 'private-key' }));
    expect(await store.load()).toMatchObject({ bookmarkMetadata: { 'bookmark-1': { summary: 'Useful documentation' } } });
    expect(bookmarks.moveBookmark).not.toHaveBeenCalled();
    expect(bookmarks.createFolder).not.toHaveBeenCalled();
    expect(bookmarks.getTree).not.toHaveBeenCalled();
    expect(provider.classify).not.toHaveBeenCalled();
  });

  it('preserves prior metadata when permission is missing or provider fails', async () => {
    const { service, store, hasProviderPermission, generateMetadata } = makeSetup();
    const old = { summary: 'Existing', tags: ['saved'], generatedAt: 10 };
    await store.update((state) => { state.bookmarkMetadata['bookmark-1'] = old; });
    hasProviderPermission.mockResolvedValueOnce(false);
    await expect(service.generate('bookmark-1')).rejects.toThrow('请先授予 AI 地址权限');
    expect(generateMetadata).not.toHaveBeenCalled();

    generateMetadata.mockRejectedValueOnce(new Error('provider failure'));
    await expect(service.generate('bookmark-1')).rejects.toThrow('provider failure');
    expect((await store.load()).bookmarkMetadata['bookmark-1']).toEqual(old);
  });

  it('does not call the provider when the API key is missing', async () => {
    const { service, store, generateMetadata } = makeSetup();
    await store.update((state) => { state.settings.apiKey = ''; });

    await expect(service.generate('bookmark-1')).rejects.toThrow('请先配置 API Key');
    expect(generateMetadata).not.toHaveBeenCalled();
  });

  it('rejects an invalid provider object and keeps the previous value', async () => {
    const { service, store, generateMetadata } = makeSetup();
    const old = { summary: 'Existing', tags: ['saved'], generatedAt: 10 };
    await store.update((state) => { state.bookmarkMetadata['bookmark-1'] = old; });
    generateMetadata.mockResolvedValueOnce({ summary: 'New summary', tags: ['tag', 'TAG'] } as never);

    await expect(service.generate('bookmark-1')).rejects.toThrow('AI 摘要标签结果不符合安全格式');
    expect((await store.load()).bookmarkMetadata['bookmark-1']).toEqual(old);
  });

  it('deduplicates concurrent generation for the same bookmark', async () => {
    const { service, generateMetadata } = makeSetup();
    let finish!: (value: { summary: string; tags: string[] }) => void;
    generateMetadata.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = service.generate('bookmark-1');
    const second = service.generate('bookmark-1');
    await vi.waitFor(() => expect(generateMetadata).toHaveBeenCalledOnce());
    finish({ summary: 'One result', tags: ['one'] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { summary: 'One result', tags: ['one'], generatedAt: 123 },
      { summary: 'One result', tags: ['one'], generatedAt: 123 },
    ]);
    expect(generateMetadata).toHaveBeenCalledOnce();
  });

  it('runs generation independently for different bookmark IDs', async () => {
    const { service, generateMetadata } = makeSetup();
    const finish: Array<(value: { summary: string; tags: string[] }) => void> = [];
    generateMetadata.mockImplementation(() => new Promise((resolve) => { finish.push(resolve); }));

    const first = service.generate('bookmark-1');
    const second = service.generate('bookmark-2');
    await vi.waitFor(() => expect(generateMetadata).toHaveBeenCalledTimes(2));
    finish[0]!({ summary: 'First', tags: ['first'] });
    finish[1]!({ summary: 'Second', tags: ['second'] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { summary: 'First', tags: ['first'], generatedAt: 123 },
      { summary: 'Second', tags: ['second'], generatedAt: 123 },
    ]);
  });

  it('does not call provider or overwrite metadata for a deleted bookmark', async () => {
    const { service, store, bookmarks, generateMetadata } = makeSetup();
    const old = { summary: 'Existing', tags: ['saved'], generatedAt: 10 };
    await store.update((state) => { state.bookmarkMetadata['bookmark-1'] = old; });
    vi.mocked(bookmarks.getBookmark).mockResolvedValueOnce(null);

    await expect(service.generate('bookmark-1')).rejects.toThrow('书签不存在或已被删除');
    expect(generateMetadata).not.toHaveBeenCalled();
    expect((await store.load()).bookmarkMetadata['bookmark-1']).toEqual(old);
  });
});
