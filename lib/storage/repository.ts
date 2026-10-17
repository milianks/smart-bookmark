import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  SettingsDraftSchema,
  emptyPersistedState,
  type HistoricalBatchUndoRecord,
  type HistoricalScanState,
  type PersistedState,
} from '../../types/domain';

const STORAGE_KEY = 'ai-bookmark-manager.state.v1';

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
      await this.storage.set({ [STORAGE_KEY]: validated });
      return structuredClone(validated);
    });
    this.writeChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async readNow(): Promise<PersistedState> {
    const record = await this.storage.get(STORAGE_KEY);
    const stored = record[STORAGE_KEY];
    if (!stored || typeof stored !== 'object') return emptyPersistedState();
    return normalizeState(stored as Partial<PersistedState>);
  }
}

function normalizeState(input: Partial<PersistedState>): PersistedState {
  const defaults = emptyPersistedState();
  const settings = normalizeSettings(input.settings);
  return {
    ...defaults,
    ...input,
    version: 1,
    settings,
    jobs: input.jobs && typeof input.jobs === 'object' ? input.jobs : {},
    reviews: input.reviews && typeof input.reviews === 'object' ? input.reviews : {},
    cache: input.cache && typeof input.cache === 'object' ? input.cache : {},
    activities: Array.isArray(input.activities) ? input.activities.slice(-100) : [],
    historicalScan: normalizeHistoricalScan(input.historicalScan),
    lastHistoricalUndo: normalizeHistoricalUndo(input.lastHistoricalUndo),
    ...(SettingsDraftSchema.safeParse(input.settingsDraft).success
      ? { settingsDraft: SettingsDraftSchema.parse(input.settingsDraft) }
      : {}),
  };
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
