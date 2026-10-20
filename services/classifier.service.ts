import type {
  CacheEntry,
  ClassifiedResult,
  ClassificationResult,
  CorrectionEntry,
  FolderSummary,
  Settings,
} from '../types/domain';
import type { StateRepository } from '../lib/storage/repository';
import { hostnameKey, normalizedUrl, stableFingerprint } from '../lib/utils/ids';
import type { ClassificationInput, RecentCorrection } from '../lib/ai/prompts';
import type { ClassifierProvider } from '../lib/ai/openai-compatible';
import { ProviderError } from '../lib/ai/openai-compatible';
import { classifyWithRules, rankFolderCandidates } from '../lib/ai/rule-classifier';
import { normalizeBaseUrl } from '../lib/ai/provider-config';

export class PermissionRequiredError extends Error {
  constructor() {
    super('尚未授予该 AI 服务的网络权限，请在设置中允许并重试。');
    this.name = 'PermissionRequiredError';
  }
}

export interface ClassifierPort {
  classify(
    input: ClassificationInput,
    folders: FolderSummary[],
    settings: Settings,
    hasProviderPermission: boolean,
  ): Promise<ClassifiedResult>;
  testProvider?(settings: Settings): Promise<void>;
}

export class ClassificationService implements ClassifierPort {
  constructor(
    private readonly provider: ClassifierProvider,
    private readonly store: StateRepository,
  ) {}

  async classify(
    input: ClassificationInput,
    folders: FolderSummary[],
    settings: Settings,
    hasProviderPermission: boolean,
  ): Promise<ClassifiedResult> {
    if (!settings.apiKey.trim()) throw new ProviderError('请先在设置中配置 API Key。', false);
    const cacheKey = makeCacheKey(input, folders, settings);
    const snapshot = await this.store.load();
    const cached = snapshot.cache[cacheKey];
    if (cached && resultReferencesFolders(cached.result, folders)) {
      return { result: cached.result, source: 'cache' };
    }
    if (cached) {
      await this.store.update((state) => { delete state.cache[cacheKey]; });
    }

    const corrected = applyCorrection(snapshot.corrections[hostnameKey(input.domain)], input, folders);
    if (corrected) return { result: corrected, source: 'rule' };

    const localResult = classifyWithRules(input, folders);
    if (localResult && localResult.confidence >= settings.confidenceThreshold) {
      await cacheResult(this.store, cacheKey, localResult, 'cache');
      return { result: localResult, source: 'rule' };
    }
    if (!hasProviderPermission) throw new PermissionRequiredError();

    const providerFolders = rankFolderCandidates(input, folders);
    const recentCorrections = recentUserDecisions(snapshot.corrections, folders);
    const result = await this.provider.classify(input, providerFolders, {
      protocol: settings.protocol,
      baseUrl: normalizeBaseUrl(settings.baseUrl),
      model: settings.model,
      apiKey: settings.apiKey,
    }, recentCorrections);
    if (!resultReferencesFolders(result, folders)) {
      throw new ProviderError('AI 推荐了当前书签树中不存在的文件夹，书签已保留原位。', false);
    }
    await cacheResult(this.store, cacheKey, result, 'ai');
    return { result, source: 'ai' };
  }

  async testProvider(settings: Settings): Promise<void> {
    if (!settings.apiKey.trim()) throw new ProviderError('请先配置 API Key。', false);
    await this.provider.test({
      protocol: settings.protocol,
      baseUrl: normalizeBaseUrl(settings.baseUrl),
      model: settings.model,
      apiKey: settings.apiKey,
    });
  }
}

function makeCacheKey(input: ClassificationInput, folders: FolderSummary[], settings: Settings): string {
  const folderFingerprint = stableFingerprint(
    folders.map((folder) => JSON.stringify({
      id: folder.id,
      name: folder.name,
      path: folder.path,
      folderType: folder.folderType ?? '',
      unmodifiable: folder.unmodifiable ?? '',
      samples: (folder.samples ?? []).slice(0, 3).map((sample) => ({
        title: sample.title,
        url: sample.url,
        hostname: sample.hostname,
      })),
    })).sort(),
  );
  const provider = `${settings.protocol}:${normalizeBaseUrl(settings.baseUrl)}:${settings.model}`;
  return `${normalizedUrl(input.url)}|${input.title}|${input.domain}|${input.currentFolderId ?? ''}|${input.currentFolder}|${folderFingerprint}|${provider}`;
}

function resultReferencesFolders(result: ClassificationResult, folders: FolderSummary[]): boolean {
  if (result.action === 'move') {
    return folders.some((folder) => folder.id === result.targetFolderId && folder.unmodifiable !== 'managed');
  }
  if (result.action === 'suggest_folder') {
    return folders.some((folder) => folder.id === result.suggestedFolder.parentId && folder.unmodifiable !== 'managed');
  }
  return true;
}

function applyCorrection(
  correction: CorrectionEntry | undefined,
  input: ClassificationInput,
  folders: FolderSummary[],
): ClassificationResult | null {
  if (!correction) return null;
  if (correction.action === 'keep') {
    return { action: 'keep', confidence: 0.9, reason: '此前你选择保留同站点书签原位。' };
  }
  const target = folders.find((folder) => folder.id === correction.folderId && folder.unmodifiable !== 'managed');
  if (!target || target.id === input.currentFolderId) return null;
  return {
    action: 'move',
    targetFolderId: target.id,
    confidence: 0.93,
    reason: `按此前你确认的归类，同站点书签放入 ${target.path}。`,
  };
}

function recentUserDecisions(
  corrections: Record<string, CorrectionEntry>,
  folders: FolderSummary[],
): RecentCorrection[] {
  return Object.values(corrections)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 5)
    .map((entry) => ({
      domain: entry.domain,
      action: entry.action,
      ...(entry.folderId
        ? { folderPath: folders.find((folder) => folder.id === entry.folderId)?.path }
        : {}),
    }));
}

async function cacheResult(
  store: StateRepository,
  key: string,
  result: ClassificationResult,
  source: CacheEntry['source'],
): Promise<void> {
  await store.update((state) => {
    state.cache[key] = { key, result, source, createdAt: Date.now() };
    const keys = Object.keys(state.cache);
    for (const staleKey of keys.slice(0, Math.max(0, keys.length - 200))) delete state.cache[staleKey];
  });
}
