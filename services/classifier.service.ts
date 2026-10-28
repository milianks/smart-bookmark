import {
  CACHE_ENTRY_MAX_BYTES,
  CacheEntrySchema,
  ClassificationResultSchema,
  type ClassifiedResult,
  type ClassificationResult,
  type CorrectionEntry,
  type FolderSummary,
  type PersistedState,
  type PreferenceRule,
  type Settings,
} from '../types/domain';
import { normalizeCache, type StateRepository } from '../lib/storage/repository';
import { hostnameKey } from '../lib/utils/ids';
import type { ClassificationInput, RecentCorrection } from '../lib/ai/prompts';
import type { ClassifierProvider } from '../lib/ai/openai-compatible';
import { ProviderError } from '../lib/ai/openai-compatible';
import { classifyWithRules, rankFolderCandidates, trimFolderBudget } from '../lib/ai/rule-classifier';
import { normalizeBaseUrl, providerUrl, type ProviderConfig } from '../lib/ai/provider-config';

const MAX_CACHE_LOOKUP_ATTEMPTS = 3;

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
    snapshot?: PersistedState,
  ): Promise<ClassifiedResult>;
  classifyBatch?(
    inputs: ClassificationInput[],
    folders: FolderSummary[],
    settings: Settings,
    hasProviderPermission: boolean,
    snapshot?: PersistedState,
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
    snapshot?: PersistedState,
  ): Promise<ClassifiedResult> {
    if (!settings.apiKey.trim()) throw new ProviderError('请先在设置中配置 API Key。', false);
    const state = snapshot ?? await this.store.load();
    const local = localDecision(input, folders, settings, state);
    if (local) return { result: local, source: 'rule' };

    const providerFolders = rankFolderCandidates(input, folders);
    const recentCorrections = recentUserDecisions(state.corrections, folders);
    const config = providerConfig(settings);
    let key: string | undefined;
    for (let attempt = 0; attempt < MAX_CACHE_LOOKUP_ATTEMPTS; attempt += 1) {
      const variant = this.provider.getCacheVariant?.();
      const request = this.provider.getCacheRequest?.('single', [input], providerFolders, config, recentCorrections);
      const requestIdentity = serializeCacheRequest(request);
      key = Number.isSafeInteger(variant) && variant! >= 0 && request && requestIdentity !== undefined
        ? await makeCacheKey('single', [input], config, request, state.credentialGeneration)
        : undefined;
      if (!key) break;
      const cached = validCacheResults(state.cache[key], key, 'single', 1, folders);
      if (serializeCacheRequest(this.provider.getCacheRequest?.('single', [input], providerFolders, config, recentCorrections)) !== requestIdentity
        || this.provider.getCacheVariant?.() !== variant) {
        key = undefined;
        continue;
      }
      if (cached) return { result: cached[0]!, source: 'cache', cacheValidation: cacheVariantCheck(this.provider, variant!) };
      break;
    }
    if (!hasProviderPermission) throw new PermissionRequiredError();

    let actualRequest: Record<string, unknown> | undefined;
    const rawResult = await this.provider.classify(input, providerFolders, config, recentCorrections, (body) => { actualRequest = body; });
    const parsed = ClassificationResultSchema.safeParse(rawResult);
    if (!parsed.success) throw new ProviderError('AI 分类结果不符合安全格式，书签已保留原位。', false);
    const result = parsed.data;
    if (!resultReferencesFolders(result, folders)) {
      throw new ProviderError('AI 推荐了当前书签树中不存在的文件夹，书签已保留原位。', false);
    }
    if (key && actualRequest && await makeCacheKey('single', [input], config, actualRequest, state.credentialGeneration) === key) {
      await cacheResults(this.store, key, 'single', [result], state.settings.apiKey, state.credentialGeneration);
    }
    return { result, source: 'ai' };
  }

  async classifyBatch(
    inputs: ClassificationInput[],
    folders: FolderSummary[],
    settings: Settings,
    hasProviderPermission: boolean,
    snapshot?: PersistedState,
  ): Promise<BatchOutcome[]> {
    if (!settings.apiKey.trim()) throw new ProviderError('请先在设置中配置 API Key。', false);
    const state = snapshot ?? await this.store.load();
    const outcomes: BatchOutcome[] = new Array<BatchOutcome>(inputs.length);
    const pendingInputs: ClassificationInput[] = [];
    const pendingPositions: number[] = [];
    for (const [index, input] of inputs.entries()) {
      const local = localDecision(input, folders, settings, state);
      if (local) {
        outcomes[index] = { result: { result: local, source: 'rule' } };
      } else {
        pendingInputs.push(input);
        pendingPositions.push(index);
      }
    }
    if (pendingInputs.length === 0) return outcomes;

    const providerFolders = batchProviderFolders(pendingInputs, folders);
    const recentCorrections = recentUserDecisions(state.corrections, folders);
    const config = providerConfig(settings);
    let key: string | undefined;
    for (let attempt = 0; attempt < MAX_CACHE_LOOKUP_ATTEMPTS; attempt += 1) {
      const variant = this.provider.getCacheVariant?.();
      const request = this.provider.getCacheRequest?.('batch', pendingInputs, providerFolders, config, recentCorrections);
      const requestIdentity = serializeCacheRequest(request);
      key = Number.isSafeInteger(variant) && variant! >= 0 && request && requestIdentity !== undefined
        ? await makeCacheKey('batch', pendingInputs, config, request, state.credentialGeneration)
        : undefined;
      if (!key) break;
      const cached = validCacheResults(state.cache[key], key, 'batch', pendingInputs.length, folders);
      if (serializeCacheRequest(this.provider.getCacheRequest?.('batch', pendingInputs, providerFolders, config, recentCorrections)) !== requestIdentity
        || this.provider.getCacheVariant?.() !== variant) {
        key = undefined;
        continue;
      }
      if (cached) {
        const cacheValidation = cacheVariantCheck(this.provider, variant!);
        cached.forEach((result, position) => { outcomes[pendingPositions[position]!] = { result: { result, source: 'cache', cacheValidation } }; });
        return outcomes;
      }
      break;
    }
    if (!hasProviderPermission) throw new PermissionRequiredError();

    let actualRequest: Record<string, unknown> | undefined;
    const results = await this.provider.classifyBatch?.(pendingInputs, providerFolders, config, recentCorrections, (body) => { actualRequest = body; });
    if (!results) throw new ProviderError('当前分类服务不支持批量分类。', false);
    if (!Array.isArray(results) || results.length !== pendingInputs.length) {
      throw new ProviderError('AI 批量结果缺少某些书签', true);
    }
    const validResults: ClassificationResult[] = [];
    for (const [position, rawResult] of results.entries()) {
      const index = pendingPositions[position]!;
      const parsed = ClassificationResultSchema.safeParse(rawResult);
      if (!parsed.success) {
        outcomes[index] = { error: new ProviderError('AI 批量结果不符合安全格式', false) };
      } else if (!resultReferencesFolders(parsed.data, folders)) {
        outcomes[index] = { error: new ProviderError('AI 推荐了当前书签树中不存在的文件夹，书签已保留原位。', false) };
      } else {
        validResults.push(parsed.data);
        outcomes[index] = { result: { result: parsed.data, source: 'ai' } };
      }
    }
    if (validResults.length === pendingInputs.length && key && actualRequest
      && await makeCacheKey('batch', pendingInputs, config, actualRequest, state.credentialGeneration) === key) {
      await cacheResults(this.store, key, 'batch', validResults, state.settings.apiKey, state.credentialGeneration);
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

function providerConfig(settings: Settings): ProviderConfig {
  return { protocol: settings.protocol, baseUrl: normalizeBaseUrl(settings.baseUrl), model: settings.model, apiKey: settings.apiKey };
}

function localDecision(input: ClassificationInput, folders: FolderSummary[], settings: Settings, state: PersistedState): ClassificationResult | null {
  const correction = applyCorrection(state.corrections[hostnameKey(input.domain)], input, folders);
  if (correction) return correction;
  const preference = applyPreference(state.preferences, input, folders);
  if (preference) return preference;
  const result = classifyWithRules(input, folders);
  return result && result.confidence >= settings.confidenceThreshold && resultReferencesFolders(result, folders) ? result : null;
}

function cacheVariantCheck(provider: ClassifierProvider, variant: number): () => boolean {
  return () => {
    try {
      return provider.getCacheVariant?.() === variant;
    } catch {
      return false;
    }
  };
}

function serializeCacheRequest(request: Record<string, unknown> | undefined): string | undefined {
  if (!request) return undefined;
  try {
    return JSON.stringify(request);
  } catch {
    return undefined;
  }
}

async function makeCacheKey(
  mode: 'single' | 'batch', inputs: ClassificationInput[], config: ProviderConfig,
  request: Record<string, unknown>, credentialGeneration: number,
): Promise<string | undefined> {
  try {
    if (!Number.isSafeInteger(credentialGeneration) || credentialGeneration < 0 || !globalThis.crypto?.subtle) return undefined;
    const identity = JSON.stringify({ version: 2, mode, inputs, protocol: config.protocol,
      endpoint: providerUrl(config.baseUrl, config.protocol), model: config.model, credentialGeneration, request });
    if (typeof identity !== 'string') return undefined;
    const secret = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(config.apiKey),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = await globalThis.crypto.subtle.sign('HMAC', secret, new TextEncoder().encode(identity));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `classification-v2:${mode}:${hex}`;
  } catch {
    return undefined;
  }
}

function validCacheResults(
  value: unknown, key: string, mode: 'single' | 'batch', count: number, folders: FolderSummary[],
): ClassificationResult[] | undefined {
  const entry = CacheEntrySchema.safeParse(value);
  if (!entry.success || entry.data.key !== key || entry.data.mode !== mode || entry.data.results.length !== count
    || new TextEncoder().encode(JSON.stringify(entry.data)).byteLength > CACHE_ENTRY_MAX_BYTES
    || !entry.data.results.every((result) => resultReferencesFolders(result, folders))) return undefined;
  return entry.data.results;
}

function resultReferencesFolders(result: ClassificationResult, folders: FolderSummary[]): boolean {
  if (result.action === 'move') {
    return folders.some((folder) => folder.id === result.targetFolderId && folder.unmodifiable !== 'managed' && folder.folderType !== 'managed');
  }
  if (result.action === 'suggest_folder') {
    return folders.some((folder) => folder.id === result.suggestedFolder.parentId && folder.unmodifiable !== 'managed' && folder.folderType !== 'managed');
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
  const target = folders.find((folder) => folder.id === correction.folderId && folder.unmodifiable !== 'managed' && folder.folderType !== 'managed');
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
    const target = folders.find((folder) => folder.id === rule.folderId && folder.unmodifiable !== 'managed' && folder.folderType !== 'managed');
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

async function cacheResults(
  store: StateRepository, key: string, mode: 'single' | 'batch', results: ClassificationResult[],
  apiKey: string, credentialGeneration: number,
): Promise<void> {
  const entry = { key, result: results[0], source: 'ai' as const, createdAt: Date.now(), version: 2 as const, mode, results };
  if (!CacheEntrySchema.safeParse(entry).success || new TextEncoder().encode(JSON.stringify(entry)).byteLength > CACHE_ENTRY_MAX_BYTES) return;
  await store.update((state) => {
    if (state.credentialGeneration !== credentialGeneration || state.settings.apiKey !== apiKey) return;
    state.cache = normalizeCache({ [key]: entry, ...Object.fromEntries(Object.entries(state.cache).filter(([existingKey]) => existingKey !== key)) });
  });
}
