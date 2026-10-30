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
import { correctionUrl, hostnameKey, createId } from '../utils/ids';

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

export interface StorageChanges {
  addListener(listener: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void): void;
}

interface StateSnapshot {
  state: PersistedState;
  serialized: string;
}

export class ChromeStateRepository implements StateRepository {
  private writeChain: Promise<void> = Promise.resolve();
  private reading?: Promise<StateSnapshot>;
  private cached?: StateSnapshot;
  private revision = 0;
  private readonly pendingWrites = new Set<string>();

  constructor(
    private readonly storage: LocalStorageArea = chrome.storage.local,
    private readonly changes?: StorageChanges,
  ) {
    changes?.addListener((events, area) => {
      if (area !== 'local' || !Object.prototype.hasOwnProperty.call(events, STORAGE_KEY)) return;
      const token = events[STORAGE_KEY]?.newValue?.settings?._repositoryWriteToken;
      if (typeof token === 'string' && this.pendingWrites.delete(token)) return;
      this.revision += 1;
      this.cached = undefined;
    });
  }

  async load(): Promise<PersistedState> {
    await this.writeChain;
    return structuredClone((await this.readNow()).state);
  }

  update(mutator: (state: PersistedState) => void): Promise<PersistedState> {
    const operation = this.writeChain.then(async () => {
      const writeToken = createId('write');
      try {
        const before = await this.readNow();
        const state = structuredClone(before.state);
        mutator(state);
        const validated = normalizeState(state);
        const serialized = JSON.stringify(validated);
        if (serialized === before.serialized) return structuredClone(validated);
        const revision = this.revision;
        if (this.changes) this.pendingWrites.add(writeToken);
        await this.storage.set({ [STORAGE_KEY]: {
          ...validated,
          settings: {
            ...validated.settings,
            [CACHE_SETTINGS_EPOCH]: validated.credentialGeneration,
            ...(this.changes ? { _repositoryWriteToken: writeToken } : {}),
          },
        } });
        if (this.changes && revision === this.revision) {
          this.cached = { state: structuredClone(validated), serialized };
        }
        return structuredClone(validated);
      } catch (error) {
        this.pendingWrites.delete(writeToken);
        this.cached = undefined;
        throw error;
      }
    });
    this.writeChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async readNow(): Promise<StateSnapshot> {
    if (this.cached) return this.cached;
    this.reading ??= this.readStored().finally(() => { this.reading = undefined; });
    return this.reading;
  }

  private async readStored(): Promise<StateSnapshot> {
    // A change during get() must not install an older snapshot in the worker cache.
    let revision: number;
    let record: Record<string, unknown>;
    do {
      revision = this.revision;
      record = await this.storage.get(STORAGE_KEY);
    } while (this.changes && revision !== this.revision);
    const stored = record[STORAGE_KEY];
    const input = stored && typeof stored === 'object' ? stored as Partial<PersistedState> : {};
    const settings = input.settings;
    const hasCacheEpoch = Boolean(settings && typeof settings === 'object' && !Array.isArray(settings)
      && Object.prototype.hasOwnProperty.call(settings, CACHE_SETTINGS_EPOCH)
      && (settings as unknown as Record<string, unknown>)[CACHE_SETTINGS_EPOCH] === input.credentialGeneration);
    const state = normalizeState(input);
    if (!hasCacheEpoch) state.cache = {};
    const snapshot = { state: structuredClone(state), serialized: JSON.stringify(state) };
    if (this.changes) this.cached = snapshot;
    return snapshot;
  }
}

function normalizeState(input: Partial<PersistedState>): PersistedState {
  const defaults = emptyPersistedState();
  const settings = normalizeSettings(input.settings);
  const { pageProfiles: _pageProfiles, settingsDraft: rawDraft, ...retained } = input as Partial<PersistedState> & { pageProfiles?: unknown };
  const draftInput = rawDraft && typeof rawDraft === 'object' && !Array.isArray(rawDraft)
    ? Object.fromEntries(Object.entries(rawDraft).filter(([key]) => key !== 'forceOrganize'))
    : rawDraft;
  const draft = SettingsDraftSchema.safeParse(draftInput);
  const historicalScan = normalizeHistoricalScan(input.historicalScan);
  const historicalApproval = normalizeHistoricalApproval(input.historicalApproval);
  const validCredentialGeneration = Number.isSafeInteger(input.credentialGeneration) && (input.credentialGeneration ?? -1) >= 0;
  const smartBookmarkRootId = typeof input.smartBookmarkRootId === 'string' && input.smartBookmarkRootId.trim().length > 0
    ? input.smartBookmarkRootId.trim()
    : undefined;
  return {
    ...defaults,
    ...retained,
    version: 1,
    smartBookmarkRootId,
    smartBookmarkInitialized: input.smartBookmarkInitialized === true && Boolean(smartBookmarkRootId),
    settings,
    credentialGeneration: validCredentialGeneration ? input.credentialGeneration! : 0,
    jobs: input.jobs && typeof input.jobs === 'object' ? input.jobs : {},
    reviews: normalizeReviews(input.reviews, historicalScan, input.pendingOperation?.reviewId, historicalApproval?.reviewIds),
    cache: validCredentialGeneration ? normalizeCache(input.cache) : {},
    activities: Array.isArray(input.activities) ? input.activities.slice(-100) : [],
    historicalScan,
    historicalApproval,
    lastHistoricalUndo: normalizeHistoricalUndo(input.lastHistoricalUndo),
    undoStack: normalizeUndoStack(input.undoStack, input.lastUndo),
    corrections: normalizeCorrections(input.corrections),
    bookmarkMetadata: normalizeBookmarkMetadata(input.bookmarkMetadata),
    preferences: normalizePreferences(input.preferences),
    ...(draft.success ? { settingsDraft: draft.data } : {}),
  };
}

function normalizeHistoricalApproval(input: unknown): PersistedState['historicalApproval'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.scanId !== 'string' || !value.scanId.trim() || !Array.isArray(value.reviewIds)) return undefined;
  const reviewIds = [...new Set(value.reviewIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  return reviewIds.length ? { scanId: value.scanId, reviewIds } : undefined;
}

function normalizeReviews(
  input: unknown,
  scan: HistoricalScanState | undefined,
  pendingReviewId: string | undefined,
  approvalIds: string[] = [],
): PersistedState['reviews'] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const protectedIds = new Set(approvalIds);
  if (pendingReviewId) protectedIds.add(pendingReviewId);
  const activeScanId = scan && ['scanning', 'awaiting_review'].includes(scan.status) ? scan.id : undefined;
  const retained: Array<[string, PersistedState['reviews'][string]]> = [];
  const terminal: typeof retained = [];
  for (const [id, item] of Object.entries(input as PersistedState['reviews'])) {
    if (!item || typeof item !== 'object') continue;
    if (item.status === 'pending' || item.status === 'approving' || protectedIds.has(id)
      || (activeScanId && item.scanId === activeScanId)) retained.push([id, item]);
    else terminal.push([id, item]);
  }
  terminal.sort((a, b) => b[1].createdAt - a[1].createdAt);
  return Object.fromEntries([...retained, ...terminal.slice(0, 250)]);
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
  return Object.fromEntries(Object.entries(result).sort((a, b) => b[1].generatedAt - a[1].generatedAt).slice(0, 2000));
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
  for (const [rawKey, value] of Object.entries(input as Record<string, unknown>)) {
    if (!rawKey || typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    if (entry.action !== 'move' && entry.action !== 'keep') continue;
    if (typeof entry.createdAt !== 'number' || !Number.isFinite(entry.createdAt) || entry.createdAt < 0) continue;
    if (entry.action === 'move' && (typeof entry.folderId !== 'string' || !entry.folderId.trim())) continue;
    // Domain-only legacy rules cannot safely infer which page the user corrected.
    if (typeof entry.url !== 'string') continue;
    let url: string;
    try {
      if (!['http:', 'https:'].includes(new URL(entry.url).protocol)) continue;
      url = correctionUrl(entry.url);
      if (correctionUrl(rawKey) !== url) continue;
    } catch { continue; }
    result[url] = {
      domain: hostnameKey(url),
      url,
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
  return Object.fromEntries(Object.entries(result).sort((a, b) => (b[1].lastAt ?? b[1].createdAt) - (a[1].lastAt ?? a[1].createdAt)).slice(0, 200));
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
