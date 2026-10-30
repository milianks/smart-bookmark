import type { StateRepository } from '../lib/storage/repository';
import type { ClassifierPort } from './classifier.service';
import type { Settings, SettingsDraft } from '../types/domain';

export interface SettingsServiceDependencies {
  store: StateRepository;
  classifier: ClassifierPort;
  hasProviderPermission(baseUrl: string): Promise<boolean>;
  afterUpdate(): Promise<void>;
}

export class SettingsService {
  constructor(private readonly deps: SettingsServiceDependencies) {}

  async updateSettings(patch: Partial<Omit<Settings, 'apiKey'>> & { apiKey?: string }): Promise<void> {
    await this.deps.store.update((state) => {
      const apiKey = patch.apiKey?.trim() ? patch.apiKey.trim() : state.settings.apiKey;
      if (apiKey !== state.settings.apiKey) {
        if (state.credentialGeneration >= Number.MAX_SAFE_INTEGER) {
          throw new Error('设置版本已达到上限，无法安全更换 API Key。');
        }
        state.credentialGeneration += 1;
      }
      state.settings = {
        ...state.settings,
        ...patch,
        apiKey,
      };
      if (!state.settings.enabled) {
        for (const job of Object.values(state.jobs)) {
          if (job.status === 'processing') job.status = 'queued';
        }
      }
    });
    if (patch.enabled !== false) await this.deps.afterUpdate();
  }

  async getSettingsDraft(): Promise<SettingsDraft | null> {
    const state = await this.deps.store.load();
    return state.settingsDraft ? structuredClone(state.settingsDraft) : null;
  }

  async updateSettingsDraft(draft: SettingsDraft): Promise<void> {
    await this.deps.store.update((state) => {
      state.settingsDraft = { ...(state.settingsDraft ?? {}), ...draft };
    });
  }

  async clearSettingsDraft(): Promise<void> {
    await this.deps.store.update((state) => { delete state.settingsDraft; });
  }

  async clearCorrections(): Promise<void> {
    await this.deps.store.update((state) => {
      state.corrections = {};
      state.preferences = {};
      state.cache = {};
    });
  }

  async testProvider(): Promise<void> {
    const state = await this.deps.store.load();
    if (!state.settings.apiKey.trim()) throw new Error('请先保存 API Key。');
    if (!(await this.deps.hasProviderPermission(state.settings.baseUrl))) {
      throw new Error('尚未授予此 API 地址的网络权限，请从设置页点击授权后重试。');
    }
    if (!this.deps.classifier.testProvider) throw new Error('AI 连接测试服务不可用。');
    await this.deps.classifier.testProvider(state.settings);
  }
}
