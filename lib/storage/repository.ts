import {
  DEFAULT_SETTINGS,
  SettingsSchema,
  emptyPersistedState,
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
  const parsedSettings = SettingsSchema.safeParse(input.settings);
  return {
    ...defaults,
    ...input,
    version: 1,
    settings: parsedSettings.success
      ? parsedSettings.data
      : { ...DEFAULT_SETTINGS },
    jobs: input.jobs && typeof input.jobs === 'object' ? input.jobs : {},
    reviews: input.reviews && typeof input.reviews === 'object' ? input.reviews : {},
    cache: input.cache && typeof input.cache === 'object' ? input.cache : {},
    activities: Array.isArray(input.activities) ? input.activities.slice(-100) : [],
  };
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
