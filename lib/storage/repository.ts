import {
  CACHE_ENTRY_MAX_BYTES,
  CACHE_RESULT_LIMIT,
  CacheEntrySchema,
  DEFAULT_SETTINGS,
  SettingsSchema,
  SettingsDraftSchema,
  emptyPersistedState,
  type HistoricalBatchUndoRecord,
  type HistoricalScanState,
  type PersistedState,
  type UndoRecord,
} from '../../types/domain';
import { hostnameKey } from '../utils/ids';

const STORAGE_KEY = 'ai-bookmark-manager.state.v1';
// Legacy repository writes rebuild settings from a whitelist, dropping this marker.
const CACHE_SETTINGS_EPOCH = '_classificationCacheEpoch';

export interface StateRepository {
  load(): Promise<PersistedState>;
  update(mutator: (state: PersistedState) => void): Promise<PersistedState>;
}

export interface LocalStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class ChromeStateRepository implements StateRepository {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly storage: LocalStorageArea = chrome.storage.local) {}

  async load(): Promise<PersistedState> {
    await this.writeChain;
    return this.readNow();
  }

  update(mutator: (state: PersistedState) => void): Promise<PersistedState> {
    const operation = this.writeChain.then(async () => {
      const state = await this.readNow();
      mutator(state);
      const validated = normalizeState(state);
      await this.storage.set({ [STORAGE_KEY]: {
        ...validated,
        settings: { ...validated.settings, [CACHE_SETTINGS_EPOCH]: validated.credentialGeneration },
      } });
      return structuredClone(validated);
    });
    this.writeChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async readNow(): Promise<PersistedState> {
    const record = await this.storage.get(STORAGE_KEY);
    const stored = record[STORAGE_KEY];
    if (!stored || typeof stored !== 'object') return emptyPersistedState();
    const input = stored as Partial<PersistedState>;
    const settings = input.settings;
    const hasCacheEpoch = Boolean(settings && typeof settings === 'object' && !Array.isArray(settings)
      && Object.prototype.hasOwnProperty.call(settings, CACHE_SETTINGS_EPOCH)
      && (settings as unknown as Record<string, unknown>)[CACHE_SETTINGS_EPOCH] === input.credentialGeneration);
    const state = normalizeState(input);
    if (!hasCacheEpoch) state.cache = {};
    return state;
  }
}

function normalizeState(input: Partial<PersistedState>): PersistedState {
  const defaults = emptyPersistedState();
  const settings = normalizeSettings(input.settings);
  const validCredentialGeneration = Number.isSafeInteger(input.credentialGeneration) && (input.credentialGeneration ?? -1) >= 0;
  const smartBookmarkRootId = typeof input.smartBookmarkRootId === 'string' && input.smartBookmarkRootId.trim().length > 0
    ? input.smartBookmarkRootId.trim()
    : undefined;
  return {
    ...defaults,
    ...input,
    version: 1,
    smartBookmarkRootId,
    smartBookmarkInitialized: input.smartBookmarkInitialized === true && Boolean(smartBookmarkRootId),
    settings,
    credentialGeneration: validCredentialGeneration ? input.credentialGeneration! : 0,
    jobs: input.jobs && typeof input.jobs === 'object' ? input.jobs : {},
    reviews: input.reviews && typeof input.reviews === 'object' ? input.reviews : {},
    cache: validCredentialGeneration ? normalizeCache(input.cache) : {},
    activities: Array.isArray(input.activities) ? input.activities.slice(-100) : [],
    historicalScan: normalizeHistoricalScan(input.historicalScan),
    lastHistoricalUndo: normalizeHistoricalUndo(input.lastHistoricalUndo),
    undoStack: normalizeUndoStack(input.undoStack, input.lastUndo),
    corrections: normalizeCorrections(input.corrections),
    bookmarkMetadata: normalizeBookmarkMetadata(input.bookmarkMetadata),
    preferences: normalizePreferences(input.preferences),
    pageProfiles: normalizePageProfiles(input.pageProfiles),
    ...(SettingsDraftSchema.safeParse(input.settingsDraft).success
      ? { settingsDraft: SettingsDraftSchema.parse(input.settingsDraft) }
      : {}),
  };
}

export function normalizeCache(input: unknown): PersistedState['cache'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const entries: Array<[string, PersistedState['cache'][string]]> = [];
  for (const [key, value] of Object.entries(input)) {
    const parsed = CacheEntrySchema.safeParse(value);
    if (!parsed.success || parsed.data.key !== key) continue;
    if (new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength > CACHE_ENTRY_MAX_BYTES) continue;
    entries.push([key, parsed.data]);
  }
  entries.sort((a, b) => b[1].createdAt - a[1].createdAt);
  const selected: Array<[string, PersistedState['cache'][string]]> = [];
  let count = 0;
  for (const [key, entry] of entries) {
    if (count + entry.results.length > CACHE_RESULT_LIMIT) break;
    selected.push([key, entry]);
    count += entry.results.length;
  }
  return Object.fromEntries(selected);
}

function normalizeBookmarkMetadata(input: unknown): PersistedState['bookmarkMetadata'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: PersistedState['bookmarkMetadata'] = {};
  for (const [id, value] of Object.entries(input)) {
    if (!id || typeof value !== 'object' || value === null) continue;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.summary !== 'string' || candidate.summary.trim().length === 0 || candidate.summary.length > 500) continue;
    if (!Array.isArray(candidate.tags) || candidate.tags.length > 8 || candidate.tags.some((tag) => typeof tag !== 'string' || tag.trim().length === 0 || tag.length > 32)) continue;
    const tags = candidate.tags.map((tag) => tag.trim());
    if (new Set(tags.map((tag) => tag.toLocaleLowerCase())).size !== tags.length) continue;
    if (typeof candidate.generatedAt !== 'number' || !Number.isFinite(candidate.generatedAt) || candidate.generatedAt < 0) continue;
    result[id] = { summary: candidate.summary.trim(), tags, generatedAt: candidate.generatedAt };
  }
  return result;
}

function normalizeHistoricalScan(input: unknown): HistoricalScanState | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const id = typeof value.id === 'string' ? value.id : '';
  const status = value.status;
  if (!id || !['idle', 'scanning', 'awaiting_review', 'completed', 'failed'].includes(String(status))) return undefined;
  const number = (key: string) => typeof value[key] === 'number' && Number.isFinite(value[key]) ? Math.max(0, Math.floor(value[key] as number)) : 0;
  const coveredIds = Array.isArray(value.coveredIds) ? value.coveredIds.filter((id): id is string => typeof id === 'string') : [];
  return {
    id,
    status: status as HistoricalScanState['status'],
    startedAt: number('startedAt'),
    updatedAt: number('updatedAt'),
    eligibleTotal: number('eligibleTotal'),
    processedCount: number('processedCount'),
    pendingReviewCount: number('pendingReviewCount'),
    failedCount: number('failedCount'),
    skippedCount: number('skippedCount'),
    coveredIds: [...new Set(coveredIds)],
    forceOrganize: value.forceOrganize === true,
    ...(typeof value.lastError === 'string' ? { lastError: value.lastError.slice(0, 500) } : {}),
  };
}

function normalizeUndoStack(stack: unknown, lastUndo: unknown): UndoRecord[] {
  const source = Array.isArray(stack) && stack.length > 0 ? stack
    : lastUndo && typeof lastUndo === 'object' ? [lastUndo as UndoRecord]
    : [];
  return source.slice(-10);
}

function normalizeCorrections(input: unknown): PersistedState['corrections'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: PersistedState['corrections'] = {};
  for (const [rawDomain, value] of Object.entries(input as Record<string, unknown>)) {
    if (!rawDomain || typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (entry.action !== 'move' && entry.action !== 'keep') continue;
    if (typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt) || entry.createdAt < 0) continue;
    if (entry.action === 'move' && typeof entry.folderId !== 'string') continue;
    const domain = hostnameKey(rawDomain);
    result[domain] = {
      domain,
      action: entry.action,
      ...(entry.action === 'move' ? { folderId: entry.folderId as string } : {}),
      createdAt: entry.createdAt,
      ...(Array.isArray(entry.topics)
        ? { topics: entry.topics.filter((topic): topic is string => typeof topic === 'string' && topic.trim().length > 0).slice(0, 8) }
        : {}),
      ...(typeof entry.contentType === 'string' ? { contentType: entry.contentType.slice(0, 32) } : {}),
      ...(typeof entry.count === 'number' && Number.isFinite(entry.count) && entry.count >= 0 ? { count: Math.floor(entry.count) } : {}),
      ...(typeof entry.lastAt === 'number' && Number.isFinite(entry.lastAt) && entry.lastAt >= 0 ? { lastAt: entry.lastAt } : {}),
    };
  }
  return result;
}

function normalizePreferences(input: unknown): PersistedState['preferences'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: PersistedState['preferences'] = {};
  const entries: Array<[string, PersistedState['preferences'][string]]> = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!key || typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.folderId !== 'string' || entry.folderId.trim().length === 0) continue;
    if (typeof entry.contentType !== 'string') continue;
    if (!Array.isArray(entry.topics)) continue;
    const topics = entry.topics.filter((topic): topic is string => typeof topic === 'string' && topic.trim().length > 0).slice(0, 8);
    const weight = typeof entry.weight === 'number' && Number.isFinite(entry.weight) ? entry.weight : 0;
    const count = typeof entry.count === 'number' && Number.isFinite(entry.count) ? Math.max(0, Math.floor(entry.count)) : 0;
    const createdAt = typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now();
    const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : createdAt;
    entries.push([key, { key, topics, contentType: entry.contentType.slice(0, 32), folderId: entry.folderId, weight, count, createdAt, updatedAt }]);
  }
  entries.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const [key, entry] of entries.slice(0, 200)) result[key] = entry;
  return result;
}

function normalizePageProfiles(input: unknown): PersistedState['pageProfiles'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: PersistedState['pageProfiles'] = {};
  const entries: Array<[string, PersistedState['pageProfiles'][string]]> = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!key || typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (typeof entry.summary !== 'string' || entry.summary.trim().length === 0 || entry.summary.length > 500) continue;
    if (!Array.isArray(entry.topics)) continue;
    const topics = entry.topics.filter((topic): topic is string => typeof topic === 'string' && topic.trim().length > 0 && topic.length <= 32).slice(0, 8);
    if (typeof entry.contentType !== 'string') continue;
    if (typeof entry.generatedAt !== 'number' || !Number.isFinite(entry.generatedAt)) continue;
    const charCount = typeof entry.charCount === 'number' && Number.isFinite(entry.charCount) ? Math.max(0, Math.floor(entry.charCount)) : 0;
    entries.push([key, {
      summary: entry.summary.trim(),
      topics,
      contentType: entry.contentType.slice(0, 32),
      charCount,
      generatedAt: entry.generatedAt,
    }]);
  }
  entries.sort((a, b) => b[1].generatedAt - a[1].generatedAt);
  for (const [key, entry] of entries.slice(0, 100)) result[key] = entry;
  return result;
}

function normalizeHistoricalUndo(input: unknown): HistoricalBatchUndoRecord | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.scanId !== 'string' || !Array.isArray(value.moved)) return undefined;
  const moved = value.moved.filter((record): record is HistoricalBatchUndoRecord['moved'][number] => {
    if (!record || typeof record !== 'object') return false;
    const item = record as Record<string, unknown>;
    return ['bookmarkId', 'title', 'fromFolderId', 'toFolderId', 'operationId'].every((key) => typeof item[key] === 'string')
      && typeof item.movedAt === 'number';
  }).slice(-500);
  return { scanId: value.scanId, moved, createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now() };
}

function normalizeSettings(input: unknown): PersistedState['settings'] {
  const candidate: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const stored = input as Record<string, unknown>;
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof typeof DEFAULT_SETTINGS>) {
      const parsed = SettingsSchema.shape[key].safeParse(stored[key]);
      if (parsed.success) candidate[key] = parsed.data;
    }
  }
  const parsed = SettingsSchema.safeParse(candidate);
  return parsed.success ? parsed.data : { ...DEFAULT_SETTINGS };
}

export class MemoryStateRepository implements StateRepository {
  private state: PersistedState;
  private chain: Promise<void> = Promise.resolve();

  constructor(initial = emptyPersistedState()) {
    this.state = structuredClone(initial);
  }

  async load(): Promise<PersistedState> {
    await this.chain;
    return structuredClone(this.state);
  }

  update(mutator: (state: PersistedState) => void): Promise<PersistedState> {
    const operation = this.chain.then(() => {
      const next = structuredClone(this.state);
      mutator(next);
      this.state = next;
      return structuredClone(next);
    });
    this.chain = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
