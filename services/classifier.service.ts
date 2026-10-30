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
import { correctionUrl } from '../lib/utils/ids';
import type { ClassificationInput, RecentCorrection } from '../lib/ai/prompts';
import type { ClassifierProvider } from '../lib/ai/openai-compatible';
import { ProviderError } from '../lib/ai/openai-compatible';
import { classifyWithRules, rankFolderCandidates } from '../lib/ai/rule-classifier';
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
    const cached = await lookupCache(this.provider, 'single', [input], providerFolders, folders, config, recentCorrections, state);
    if (cached?.results) {
      return { result: cached.results[0]!, source: 'cache', cacheValidation: cacheVariantCheck(this.provider, cached.variant) };
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
    if (cached && serializeCacheRequest(actualRequest) === cached.requestIdentity) {
      await cacheResults(this.store, [{ key: cached.key, mode: 'single', results: [result],
        isCurrent: () => cacheContextMatches(this.provider, cached, 'single', [input], providerFolders, config, recentCorrections),
      }], state.settings.apiKey, state.credentialGeneration);
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
    const pending: Array<{ input: ClassificationInput; index: number }> = [];
    for (const [index, input] of inputs.entries()) {
      const local = localDecision(input, folders, settings, state);
      if (local) outcomes[index] = { result: { result: local, source: 'rule' } };
      else pending.push({ input, index });
    }
    if (pending.length === 0) return outcomes;
    const recentCorrections = recentUserDecisions(state.corrections, folders);
    const config = providerConfig(settings);
    const groups = new Map<string, { folders: FolderSummary[]; members: Array<{ input: ClassificationInput; index: number; cache?: CacheLookup }>; cache?: CacheLookup }>();
    const validations = new Map<number, () => boolean>();
    const cacheValidation = (variant: number) => {
      if (!validations.has(variant)) validations.set(variant, cacheVariantCheck(this.provider, variant));
      return validations.get(variant)!;
    };
    for (const { input, index } of pending) {
      const candidates = rankFolderCandidates(input, folders);
      const cache = await lookupCache(this.provider, 'single', [input], candidates, folders, config, recentCorrections, state);
      if (cache?.results) {
        outcomes[index] = { result: { result: cache.results[0]!, source: 'cache', cacheValidation: cacheValidation(cache.variant) } };
        continue;
      }
      const identity = JSON.stringify(candidates);
      let group = groups.get(identity);
      if (!group) {
        group = { folders: candidates, members: [] };
        groups.set(identity, group);
      }
      group.members.push({ input, index, cache });
    }
    for (const [identity, group] of groups) {
      group.cache = await lookupCache(this.provider, 'batch', group.members.map((member) => member.input), group.folders, folders, config, recentCorrections, state);
      if (group.cache?.results) {
        const validation = cacheValidation(group.cache.variant);
        group.cache.results.forEach((result, position) => { outcomes[group.members[position]!.index] = { result: { result, source: 'cache', cacheValidation: validation } }; });
        groups.delete(identity);
      }
    }
    if (groups.size > 0 && !hasProviderPermission) throw new PermissionRequiredError();

    for (const group of groups.values()) {
      const pendingInputs = group.members.map((member) => member.input);
      let actualRequest: Record<string, unknown> | undefined;
      const results = await this.provider.classifyBatch?.(pendingInputs, group.folders, config, recentCorrections, (body) => { actualRequest = body; });
      if (!results) throw new ProviderError('当前分类服务不支持批量分类。', false);
      if (!Array.isArray(results) || results.length !== pendingInputs.length) {
        throw new ProviderError('AI 批量结果缺少某些书签', true);
      }
      const validResults: ClassificationResult[] = [];
      const writes: CacheWrite[] = [];
      const batchCache = group.cache;
      const batchCurrent = () => Boolean(batchCache && serializeCacheRequest(actualRequest) === batchCache.requestIdentity
        && cacheContextMatches(this.provider, batchCache, 'batch', pendingInputs, group.folders, config, recentCorrections));
      for (const [position, rawResult] of results.entries()) {
        const member = group.members[position]!;
        const parsed = ClassificationResultSchema.safeParse(rawResult);
        if (!parsed.success) {
          outcomes[member.index] = { error: new ProviderError('AI 批量结果不符合安全格式', false) };
        } else if (!resultReferencesFolders(parsed.data, folders)) {
          outcomes[member.index] = { error: new ProviderError('AI 推荐了当前书签树中不存在的文件夹，书签已保留原位。', false) };
        } else {
          validResults.push(parsed.data);
          outcomes[member.index] = { result: { result: parsed.data, source: 'ai' } };
          const memberCache = member.cache;
          if (memberCache) writes.push({ key: memberCache.key, mode: 'single', results: [parsed.data],
            isCurrent: () => batchCurrent() && cacheContextMatches(this.provider, memberCache, 'single', [member.input], group.folders, config, recentCorrections),
          });
        }
      }
      if (validResults.length === pendingInputs.length && batchCache) {
        writes.push({ key: batchCache.key, mode: 'batch', results: validResults, isCurrent: batchCurrent });
      }
      await cacheResults(this.store, writes, state.settings.apiKey, state.credentialGeneration);
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

interface CacheLookup {
  key: string;
  requestIdentity: string;
  contextIdentity: string;
  variant: number;
  results?: ClassificationResult[];
}

interface CacheWrite {
  key: string;
  mode: 'single' | 'batch';
  results: ClassificationResult[];
  isCurrent: () => boolean;
}

function cacheContext(
  provider: ClassifierProvider, mode: 'single' | 'batch', inputs: ClassificationInput[],
  folders: FolderSummary[], config: ProviderConfig, corrections: RecentCorrection[],
): { requestIdentity: string; context: Record<string, unknown>; contextIdentity: string } | undefined {
  const request = provider.getCacheRequest?.(mode, inputs, folders, config, corrections);
  const requestIdentity = serializeCacheRequest(request);
  if (!request || requestIdentity === undefined) return undefined;
  // Cross-path reuse is an independent-decision policy, not identical transport bodies.
  const batch = mode === 'single' ? provider.getCacheRequest?.('batch', inputs, folders, config, corrections) : undefined;
  if (mode === 'single' && (!batch || serializeCacheRequest(batch) === undefined)) return undefined;
  const singles = mode === 'batch' ? inputs.map((input) => cacheContext(provider, 'single', [input], folders, config, corrections)?.context) : undefined;
  if (singles?.some((single) => !single)) return undefined;
  const context = mode === 'single' ? { single: request, batch } : { batch: request, singles };
  const contextIdentity = serializeCacheRequest(context);
  return contextIdentity === undefined ? undefined : { requestIdentity, context, contextIdentity };
}

async function lookupCache(
  provider: ClassifierProvider, mode: 'single' | 'batch', inputs: ClassificationInput[],
  candidates: FolderSummary[], folders: FolderSummary[], config: ProviderConfig,
  corrections: RecentCorrection[], state: PersistedState,
): Promise<CacheLookup | undefined> {
  for (let attempt = 0; attempt < MAX_CACHE_LOOKUP_ATTEMPTS; attempt += 1) {
    const variant = provider.getCacheVariant?.();
    if (!Number.isSafeInteger(variant) || variant! < 0) return undefined;
    const expected = cacheContext(provider, mode, inputs, candidates, config, corrections);
    if (!expected) return undefined;
    const key = await makeCacheKey(mode, inputs, config, expected.context, state.credentialGeneration);
    if (!key) return undefined;
    const lookup = { key, requestIdentity: expected.requestIdentity, contextIdentity: expected.contextIdentity, variant: variant! };
    if (!cacheContextMatches(provider, lookup, mode, inputs, candidates, config, corrections)) continue;
    return { ...lookup, results: validCacheResults(state.cache[key], key, mode, inputs.length, folders) };
  }
  return undefined;
}

function cacheContextMatches(
  provider: ClassifierProvider, lookup: CacheLookup, mode: 'single' | 'batch', inputs: ClassificationInput[],
  folders: FolderSummary[], config: ProviderConfig, corrections: RecentCorrection[],
): boolean {
  try {
    const expected = cacheContext(provider, mode, inputs, folders, config, corrections);
    return expected?.contextIdentity === lookup.contextIdentity && provider.getCacheVariant?.() === lookup.variant;
  } catch {
    return false;
  }
}

function providerConfig(settings: Settings): ProviderConfig {
  return { protocol: settings.protocol, baseUrl: normalizeBaseUrl(settings.baseUrl), model: settings.model, apiKey: settings.apiKey };
}

function localDecision(input: ClassificationInput, folders: FolderSummary[], settings: Settings, state: PersistedState): ClassificationResult | null {
  const correction = applyCorrection(state.corrections[correctionUrl(input.url)], input, folders);
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
    const identity = JSON.stringify({ version: 3, mode, inputs, protocol: config.protocol,
      endpoint: providerUrl(config.baseUrl, config.protocol), model: config.model, credentialGeneration, request });
    if (typeof identity !== 'string') return undefined;
    const secret = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(config.apiKey),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = await globalThis.crypto.subtle.sign('HMAC', secret, new TextEncoder().encode(identity));
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return `classification-v3:${mode}:${hex}`;
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
  if (!correction?.url || correction.url !== correctionUrl(input.url)) return null;
  if (correction.action === 'keep') {
    return { action: 'keep', confidence: 0.9, reason: '此前你选择保留此页面书签原位。' };
  }
  const target = folders.find((folder) => folder.id === correction.folderId && folder.unmodifiable !== 'managed' && folder.folderType !== 'managed');
  if (!target || target.id === input.currentFolderId) return null;
  return {
    action: 'move',
    targetFolderId: target.id,
    confidence: 0.93,
    reason: `按此前你确认的归类，此页面书签放入 ${target.path}。`,
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
      ...(entry.url ? { url: entry.url } : {}),
      action: entry.action,
      ...(entry.folderId
        ? { folderPath: folders.find((folder) => folder.id === entry.folderId)?.path }
        : {}),
    }));
}

async function cacheResults(
  store: StateRepository, writes: CacheWrite[], apiKey: string, credentialGeneration: number,
): Promise<void> {
  const entries = writes.filter((write) => write.isCurrent()).map((write) => ({
    ...write, entry: { key: write.key, result: write.results[0], source: 'ai' as const,
      createdAt: Date.now(), version: 3 as const, mode: write.mode, results: write.results },
  })).filter(({ entry }) => CacheEntrySchema.safeParse(entry).success
    && new TextEncoder().encode(JSON.stringify(entry)).byteLength <= CACHE_ENTRY_MAX_BYTES);
  if (entries.length === 0) return;
  await store.update((state) => {
    if (state.credentialGeneration !== credentialGeneration || state.settings.apiKey !== apiKey) return;
    const current = entries.filter(({ isCurrent }) => isCurrent());
    state.cache = normalizeCache({ ...Object.fromEntries(current.map(({ entry }) => [entry.key, entry])),
      ...Object.fromEntries(Object.entries(state.cache).filter(([key]) => !current.some(({ entry }) => entry.key === key))) });
  });
}
