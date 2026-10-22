import type {
  CacheEntry,
  ClassifiedResult,
  ClassificationResult,
  CorrectionEntry,
  FolderSummary,
  PreferenceRule,
  Settings,
} from '../types/domain';
import type { StateRepository } from '../lib/storage/repository';
import { hostnameKey, normalizedUrl, stableFingerprint } from '../lib/utils/ids';
import type { ClassificationInput, RecentCorrection } from '../lib/ai/prompts';
import type { ClassifierProvider } from '../lib/ai/openai-compatible';
import { ProviderError } from '../lib/ai/openai-compatible';
import { classifyWithRules, rankFolderCandidates, trimFolderBudget } from '../lib/ai/rule-classifier';
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
  classifyBatch?(
    inputs: ClassificationInput[],
    folders: FolderSummary[],
    settings: Settings,
    hasProviderPermission: boolean,
  ): Promise<BatchOutcome[]>;
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
    const preferred = applyPreference(snapshot.preferences, input, folders);
    if (preferred) return { result: preferred, source: 'rule' };

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

  async classifyBatch(
    inputs: ClassificationInput[],
    folders: FolderSummary[],
    settings: Settings,
    hasProviderPermission: boolean,
  ): Promise<BatchOutcome[]> {
    if (!settings.apiKey.trim()) throw new ProviderError('请先在设置中配置 API Key。', false);
    const snapshot = await this.store.load();
    const outcomes: BatchOutcome[] = new Array<BatchOutcome>(inputs.length);
    const pendingInputs: ClassificationInput[] = [];
    const pendingPositions: number[] = [];
    for (const [index, input] of inputs.entries()) {
      const cacheKey = makeCacheKey(input, folders, settings);
      const cached = snapshot.cache[cacheKey];
      if (cached && resultReferencesFolders(cached.result, folders)) {
        outcomes[index] = { result: { result: cached.result, source: 'cache' } };
        continue;
      }
      const corrected = applyCorrection(snapshot.corrections[hostnameKey(input.domain)], input, folders);
      if (corrected) {
        outcomes[index] = { result: { result: corrected, source: 'rule' } };
        continue;
      }
      const preferred = applyPreference(snapshot.preferences, input, folders);
      if (preferred) {
        outcomes[index] = { result: { result: preferred, source: 'rule' } };
        continue;
      }
      const localResult = classifyWithRules(input, folders);
      if (localResult && localResult.confidence >= settings.confidenceThreshold) {
        await cacheResult(this.store, cacheKey, localResult, 'cache');
        outcomes[index] = { result: { result: localResult, source: 'rule' } };
        continue;
      }
      pendingInputs.push(input);
      pendingPositions.push(index);
    }
    if (pendingInputs.length === 0) return outcomes;
    if (!hasProviderPermission) throw new PermissionRequiredError();

    const providerFolders = batchProviderFolders(pendingInputs, folders);
    const results = await this.provider.classifyBatch?.(pendingInputs, providerFolders, {
      protocol: settings.protocol,
      baseUrl: normalizeBaseUrl(settings.baseUrl),
      model: settings.model,
      apiKey: settings.apiKey,
    }, recentUserDecisions(snapshot.corrections, folders));
    if (!results) throw new ProviderError('当前分类服务不支持批量分类。', false);
    for (const [position, result] of results.entries()) {
      const index = pendingPositions[position]!;
      if (!resultReferencesFolders(result, folders)) {
        outcomes[index] = { error: new ProviderError('AI 推荐了当前书签树中不存在的文件夹，书签已保留原位。', false) };
        continue;
      }
      await cacheResult(this.store, makeCacheKey(pendingInputs[position]!, folders, settings), result, 'ai');
      outcomes[index] = { result: { result, source: 'ai' } };
    }
    return outcomes;
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

export type BatchOutcome = { result: ClassifiedResult } | { error: ProviderError };

function batchProviderFolders(inputs: ClassificationInput[], folders: FolderSummary[]): FolderSummary[] {
  const union = new Map<string, FolderSummary>();
  for (const input of inputs.slice(0, 8)) {
    for (const folder of rankFolderCandidates(input, folders)) union.set(folder.id, folder);
  }
  return trimFolderBudget([...union.values()]);
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
  const profileFingerprint = input.pageProfile
    ? stableFingerprint([input.pageProfile.contentType, input.pageProfile.topics.join('\u001f'), input.pageProfile.summary])
    : '';
  return `${normalizedUrl(input.url)}|${input.title}|${input.domain}|${input.currentFolderId ?? ''}|${input.currentFolder}|${folderFingerprint}|${provider}|${profileFingerprint}`;
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

function applyPreference(
  preferences: Record<string, PreferenceRule>,
  input: ClassificationInput,
  folders: FolderSummary[],
): ClassificationResult | null {
  const profile = input.pageProfile;
  if (!profile) return null;
  const topics = new Set(profile.topics.map((topic) => topic.toLocaleLowerCase()));
  if (topics.size === 0) return null;
  let best: { score: number; target: FolderSummary; weight: number } | null = null;
  for (const rule of Object.values(preferences)) {
    if (rule.weight < 1) continue;
    if (rule.contentType && profile.contentType && rule.contentType !== profile.contentType) continue;
    const overlap = rule.topics.filter((topic) => topics.has(topic.toLocaleLowerCase())).length;
    if (overlap === 0) continue;
    const target = folders.find((folder) => folder.id === rule.folderId && folder.unmodifiable !== 'managed');
    if (!target || target.id === input.currentFolderId) continue;
    const score = overlap + Math.min(rule.weight, 5) * 0.1;
    if (!best || score > best.score) best = { score, target, weight: rule.weight };
  }
  if (!best) return null;
  return {
    action: 'move',
    targetFolderId: best.target.id,
    confidence: Math.min(0.9, 0.6 + best.weight * 0.05),
    reason: `按此前同类书签的纠错偏好放入 ${best.target.path}。`,
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
