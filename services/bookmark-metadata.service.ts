import { SummaryTagResultSchema, type BookmarkMetadata, type Settings } from '../types/domain';
import type { StateRepository } from '../lib/storage/repository';
import type { BookmarkPort } from './bookmark.service';
import type { BookmarkMetadataInput } from '../lib/ai/prompts';
import type { ClassifierProvider } from '../lib/ai/openai-compatible';
import { ProviderError } from '../lib/ai/openai-compatible';
import { normalizeBaseUrl, type ProviderConfig } from '../lib/ai/provider-config';

export interface BookmarkMetadataDependencies {
  bookmarks: BookmarkPort;
  store: StateRepository;
  provider: ClassifierProvider;
  hasProviderPermission(baseUrl: string): Promise<boolean>;
  now?: () => number;
}

export class BookmarkMetadataService {
  private readonly inFlight = new Map<string, Promise<BookmarkMetadata>>();
  private readonly now: () => number;

  constructor(private readonly deps: BookmarkMetadataDependencies) {
    this.now = deps.now ?? Date.now;
  }

  generate(bookmarkId: string): Promise<BookmarkMetadata> {
    const existing = this.inFlight.get(bookmarkId);
    if (existing) return existing;
    const operation = this.generateOnce(bookmarkId).finally(() => this.inFlight.delete(bookmarkId));
    this.inFlight.set(bookmarkId, operation);
    return operation;
  }

  private async generateOnce(bookmarkId: string): Promise<BookmarkMetadata> {
    const state = await this.deps.store.load();
    const bookmark = await this.deps.bookmarks.getBookmark(bookmarkId);
    if (!bookmark?.url || !bookmark.parentId) throw new Error('书签不存在或已被删除');
    const rootId = state.smartBookmarkRootId;
    if (!rootId || !this.deps.bookmarks.isWithinRoot) throw new Error('书签不在智能书签目录内');
    let withinRoot = false;
    try {
      withinRoot = await this.deps.bookmarks.isWithinRoot(bookmark.id, rootId);
    } catch {
      withinRoot = false;
    }
    if (!withinRoot) throw new Error('书签不在智能书签目录内');
    const settings = state.settings;
    if (!settings.apiKey.trim()) throw new ProviderError('请先配置 API Key', false);
    if (!(await this.deps.hasProviderPermission(settings.baseUrl))) throw new ProviderError('请先授予 AI 地址权限', false);
    const domain = safeDomain(bookmark.url);
    if (!domain) throw new Error('书签地址无效，无法生成摘要标签');
    if (!this.deps.bookmarks.getFoldersWithinRoot) throw new Error('智能书签目录结构不可用');
    const folder = (await this.deps.bookmarks.getFoldersWithinRoot(rootId))
      .find((candidate) => candidate.id === bookmark.parentId)?.path;
    if (!folder) throw new Error('书签所在文件夹不存在');
    const input: BookmarkMetadataInput = {
      title: bookmark.title || '(无标题)',
      url: bookmark.url,
      domain,
      currentFolder: folder,
    };
    if (!this.deps.provider.generateMetadata) throw new ProviderError('当前 AI 服务不支持摘要标签生成', false);
    const result = await this.deps.provider.generateMetadata(input, toConfig(settings));
    const validated = SummaryTagResultSchema.safeParse(result);
    if (!validated.success) throw new ProviderError('AI 摘要标签结果不符合安全格式', false);
    const metadata: BookmarkMetadata = { ...validated.data, generatedAt: this.now() };
    await this.deps.store.update((current) => { current.bookmarkMetadata[bookmarkId] = metadata; });
    return metadata;
  }
}

function toConfig(settings: Settings): ProviderConfig {
  return { protocol: settings.protocol, baseUrl: normalizeBaseUrl(settings.baseUrl), model: settings.model, apiKey: settings.apiKey };
}

function safeDomain(value: string): string {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.hostname : '';
  } catch { return ''; }
}
