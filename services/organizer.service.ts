import { ProviderError } from '../lib/ai/openai-compatible';
import { PermissionRequiredError, type ClassifierPort } from './classifier.service';
import type { BookmarkPort, BookmarkNode } from './bookmark.service';
import type { StateRepository } from '../lib/storage/repository';
import { createId } from '../lib/utils/ids';
import type {
  ActivityRecord,
  BookmarkJob,
  BookmarkSnapshot,
  ClassifiedResult,
  DashboardState,
  FolderSummary,
  PendingOperation,
  PersistedState,
  ReviewItem,
  Settings,
  SettingsDraft,
  UndoRecord,
} from '../types/domain';
import { DEFAULT_SETTINGS } from '../types/domain';
import type { NotificationPort } from './notification.service';

export interface RetryAlarmPort {
  schedule(delayMs: number): Promise<void> | void;
}

export interface OrganizerDependencies {
  bookmarks: BookmarkPort;
  store: StateRepository;
  classifier: ClassifierPort;
  notifications: NotificationPort;
  alarms: RetryAlarmPort;
  hasProviderPermission(baseUrl: string): Promise<boolean>;
  now?: () => number;
  makeId?: (prefix: string) => string;
}

const MAX_CONCURRENT_CLASSIFICATIONS = 2;
const MAX_RETRIES = 2;
const IMPORT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export class OrganizerService {
  private readonly inFlight = new Set<string>();
  private activeClassifications = 0;
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly makeId: (prefix: string) => string;

  constructor(private readonly deps: OrganizerDependencies) {
    this.now = deps.now ?? Date.now;
    this.makeId = deps.makeId ?? createId;
  }

  async onBookmarkCreated(id: string, node: BookmarkNode): Promise<void> {
    if (!node.url || !isHttpUrl(node.url) || !node.parentId) return;
    const state = await this.deps.store.load();
    const importActive = state.importStartedAt !== undefined
      && this.now() - state.importStartedAt < IMPORT_STALE_AFTER_MS;
    if (state.importStartedAt !== undefined && !importActive) {
      await this.deps.store.update((current) => { delete current.importStartedAt; });
    }
    if (importActive) return;
    if (state.jobs[id]) return;

    const snapshot: BookmarkSnapshot = {
      id,
      title: node.title || '(无标题)',
      url: node.url,
      parentId: node.parentId,
      ...(node.dateAdded ? { dateAdded: node.dateAdded } : {}),
    };
    if (!state.settings.enabled) {
      await this.appendActivity({
        kind: 'skipped', bookmarkId: id, title: snapshot.title, url: snapshot.url,
        message: '自动整理已关闭，新书签保留原位。',
      });
      return;
    }
    if (!state.settings.forceOrganize && !(await this.deps.bookmarks.isEligibleRoot(node.parentId))) {
      await this.appendActivity({
        kind: 'skipped', bookmarkId: id, title: snapshot.title, url: snapshot.url,
        message: '书签位于自建文件夹中，已尊重当前分类并保留原位。',
      });
      return;
    }

    const job: BookmarkJob = {
      bookmark: snapshot,
      status: state.settings.apiKey.trim() ? 'queued' : 'awaiting_configuration',
      attempts: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    await this.deps.store.update((current) => {
      if (current.jobs[id]) return;
      current.jobs[id] = job;
      appendActivity(current, {
        kind: 'received', bookmarkId: id, title: snapshot.title, url: snapshot.url,
        message: current.settings.apiKey.trim()
          ? '已加入自动分类队列。'
          : '等待在设置中配置 API Key；书签保持原位。',
      }, this.now(), this.makeId);
      pruneJobs(current);
    });
    if (job.status === 'queued') await this.processJob(id);
  }

  async onImportBegan(): Promise<void> {
    await this.deps.store.update((state) => { state.importStartedAt = this.now(); });
  }

  async onImportEnded(): Promise<void> {
    await this.deps.store.update((state) => { delete state.importStartedAt; });
  }

  async resume(): Promise<void> {
    await this.reconcilePendingOperation();
    const now = this.now();
    const snapshot = await this.deps.store.load();
    let hasProviderPermission = false;
    if (snapshot.settings.apiKey.trim()) {
      try {
        hasProviderPermission = await this.deps.hasProviderPermission(snapshot.settings.baseUrl);
      } catch {
        hasProviderPermission = false;
      }
    }
    await this.deps.store.update((state) => {
      if (state.importStartedAt !== undefined && now - state.importStartedAt >= IMPORT_STALE_AFTER_MS) {
        delete state.importStartedAt;
      }
      for (const job of Object.values(state.jobs)) {
        if (job.status === 'processing') {
          job.status = 'queued';
          job.updatedAt = now;
        }
        if (job.status === 'awaiting_configuration' && state.settings.apiKey.trim()) {
          job.status = 'queued';
          job.updatedAt = now;
        }
        if (job.status === 'awaiting_permission'
          && hasProviderPermission
          && state.settings.apiKey.trim()
          && state.settings.baseUrl === snapshot.settings.baseUrl) {
          job.status = 'queued';
          delete job.nextAttemptAt;
          delete job.lastError;
          job.updatedAt = now;
        }
      }
    });
    await this.processPending();
  }

  async onSettingsUpdated(): Promise<void> {
    await this.resume();
  }

  async processPending(): Promise<void> {
    const state = await this.deps.store.load();
    if (!state.settings.enabled) return;
    const readyJobs = Object.values(state.jobs)
      .filter((job) => job.status === 'queued'
        && (job.nextAttemptAt === undefined || job.nextAttemptAt <= this.now()))
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, MAX_CONCURRENT_CLASSIFICATIONS);
    await Promise.allSettled(readyJobs.map((job) => this.processJob(job.bookmark.id)));
    const latest = await this.deps.store.load();
    const queued = Object.values(latest.jobs).filter((job) => job.status === 'queued');
    const hasDueJobs = queued.some((job) => job.nextAttemptAt === undefined || job.nextAttemptAt <= this.now());
    if (hasDueJobs) {
      await this.deps.alarms.schedule(2_000);
    } else if (queued.length > 0) {
      const nextAttemptAt = Math.min(...queued.map((job) => job.nextAttemptAt ?? this.now()));
      await this.deps.alarms.schedule(Math.max(1_000, nextAttemptAt - this.now()));
    }
  }

  async getDashboardState(): Promise<DashboardState> {
    const state = await this.deps.store.load();
    const configured = Boolean(state.settings.apiKey.trim());
    let permission = false;
    if (configured) {
      try {
        permission = await this.deps.hasProviderPermission(state.settings.baseUrl);
      } catch {
        permission = false;
      }
    }
    const { apiKey: _apiKey, ...settings } = state.settings;
    return {
      settings: { ...settings, hasApiKey: configured },
      pendingReviews: Object.values(state.reviews)
        .filter((item) => item.status === 'pending' || item.status === 'approving')
        .sort((a, b) => b.createdAt - a.createdAt),
      recentJobs: Object.values(state.jobs)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 8),
      activities: state.activities.slice(-20).reverse(),
      awaitingConfigurationCount: Object.values(state.jobs).filter((job) => job.status === 'awaiting_configuration').length,
      awaitingPermissionCount: Object.values(state.jobs).filter((job) => job.status === 'awaiting_permission').length,
      ...(state.lastUndo ? { lastUndo: state.lastUndo } : {}),
      aiStatus: configured ? (permission ? 'configured' : 'permission-needed') : 'missing-key',
    };
  }

  async updateSettings(patch: Partial<Omit<Settings, 'apiKey'>> & { apiKey?: string }): Promise<void> {
    await this.deps.store.update((state) => {
      state.settings = {
        ...state.settings,
        ...patch,
        apiKey: patch.apiKey?.trim() ? patch.apiKey.trim() : state.settings.apiKey,
      };
      if (!state.settings.enabled) {
        for (const job of Object.values(state.jobs)) {
          if (job.status === 'processing') job.status = 'queued';
        }
      }
    });
    if (patch.enabled !== false) await this.onSettingsUpdated();
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

  async testProvider(): Promise<void> {
    const state = await this.deps.store.load();
    if (!state.settings.apiKey.trim()) throw new Error('请先保存 API Key。');
    if (!(await this.deps.hasProviderPermission(state.settings.baseUrl))) {
      throw new Error('尚未授予此 API 地址的网络权限，请从设置页点击授权后重试。');
    }
    if (!this.deps.classifier.testProvider) throw new Error('AI 连接测试服务不可用。');
    await this.deps.classifier.testProvider(state.settings);
  }

  async approveReview(id: string): Promise<void> {
    await this.withMutationLock(async () => {
      await this.reconcilePendingOperation();
      let state = await this.deps.store.load();
      let item = state.reviews[id];
      if (!item) throw new Error('这条建议不存在或已过期。');
      if (item.status === 'approved') return;
      if (item.status === 'rejected' || item.status === 'stale') throw new Error('这条建议已关闭。');
      const bookmark = await this.deps.bookmarks.getBookmark(item.bookmarkId);
      if (!bookmark || bookmark.parentId !== item.sourceParentId) {
        await this.markReviewStale(item, '书签已被删除或手动移动，未执行建议。');
        throw new Error('书签位置已变化，建议已标记为过期。');
      }

      await this.deps.store.update((current) => {
        const review = current.reviews[id];
        if (review) review.status = 'approving';
      });
      state = await this.deps.store.load();
      item = state.reviews[id];
      if (!item) throw new Error('建议状态已变化。');

      let targetFolderId: string;
      let targetName: string;
      if (item.classification.action === 'suggest_folder') {
        const { name, parentId } = item.classification.suggestedFolder;
        const parent = await this.deps.bookmarks.getFolder(parentId);
        if (!parent || parent.unmodifiable === 'managed') {
          await this.markReviewStale(item, '建议的新目录上级已不存在或不可修改。');
          throw new Error('建议的新目录上级已不存在或不可修改。');
        }
        targetName = name.trim().slice(0, 64);
        const tree = await this.deps.bookmarks.getTree();
        const parentNode = findNode(tree, parentId);
        const existing = parentNode?.children?.find((child) => !child.url
          && child.title.trim().toLocaleLowerCase() === targetName.toLocaleLowerCase());
        const target = item.targetFolderId
          ? await this.deps.bookmarks.getFolder(item.targetFolderId)
          : existing ?? await this.deps.bookmarks.createFolder(targetName, parentId);
        if (!target || target.unmodifiable === 'managed') throw new Error('无法创建或找到建议文件夹。');
        targetFolderId = target.id;
        await this.deps.store.update((current) => {
          const review = current.reviews[id];
          if (review) {
            review.targetFolderId = targetFolderId;
            review.status = 'approving';
          }
        });
      } else if (item.classification.action === 'move') {
        targetFolderId = item.classification.targetFolderId;
        const target = await this.deps.bookmarks.getFolder(targetFolderId);
        if (!target || target.unmodifiable === 'managed') {
          await this.markReviewStale(item, '推荐文件夹已不存在或不可修改。');
          throw new Error('推荐文件夹已不存在或不可修改。');
        }
        targetName = target.title;
      } else {
        await this.closeReview(item, 'approved', '用户确认保留原位。', 'kept');
        return;
      }

      const latestBookmark = await this.deps.bookmarks.getBookmark(item.bookmarkId);
      if (!latestBookmark || latestBookmark.parentId !== item.sourceParentId) {
        await this.markReviewStale(item, '书签位置在确认过程中发生变化，未执行移动。');
        throw new Error('书签位置发生变化，未执行移动。');
      }
      if (targetFolderId === item.sourceParentId) {
        await this.closeReview(item, 'approved', '书签已位于推荐文件夹，无需移动。', 'review_approved');
        return;
      }

      const operation: PendingOperation = {
        bookmarkId: item.bookmarkId,
        title: item.title,
        fromFolderId: item.sourceParentId,
        toFolderId: targetFolderId,
        movedAt: this.now(),
        operationId: this.makeId('op'),
        state: 'prepared',
        kind: 'review',
        reviewId: id,
      };
      await this.deps.store.update((current) => { current.pendingOperation = operation; });
      if (await this.moveWithRecovery(operation)) return;
      await this.deps.store.update((current) => {
        const review = current.reviews[id];
        if (review) review.status = 'approved';
        const job = current.jobs[item.bookmarkId];
        if (job) job.status = 'completed';
        current.pendingOperation = undefined;
        appendActivity(current, {
          kind: 'review_approved', bookmarkId: item.bookmarkId, title: item.title, url: item.url,
          message: `已移动到 ${targetName}。`, source: item.source,
          fromFolderId: item.sourceParentId, toFolderId: targetFolderId,
        }, this.now(), this.makeId);
      });
    });
  }

  async rejectReview(id: string): Promise<void> {
    await this.withMutationLock(async () => {
      const state = await this.deps.store.load();
      const item = state.reviews[id];
      if (!item || item.status === 'rejected') return;
      if (item.status === 'approved' || item.status === 'stale') throw new Error('这条建议已经关闭。');
      await this.closeReview(item, 'rejected', '用户选择保留书签原位。', 'review_rejected');
    });
  }

  async undoLastMove(): Promise<string> {
    return this.withMutationLock(async () => {
      const state = await this.deps.store.load();
      const record = state.lastUndo;
      if (!record) throw new Error('没有可以撤销的自动归档操作。');
      const bookmark = await this.deps.bookmarks.getBookmark(record.bookmarkId);
      if (!bookmark) throw new Error('书签已不存在，无法撤销。');
      if (bookmark.parentId !== record.toFolderId) {
        throw new Error('书签已被手动移动，为避免覆盖你的操作，无法撤销。');
      }
      if (!(await this.deps.bookmarks.folderExists(record.fromFolderId))) throw new Error('原文件夹已不存在，无法撤销。');
      const operation: PendingOperation = {
        ...record,
        fromFolderId: record.toFolderId,
        toFolderId: record.fromFolderId,
        movedAt: this.now(),
        operationId: this.makeId('undo'),
        state: 'prepared',
        kind: 'undo',
      };
      await this.deps.store.update((current) => { current.pendingOperation = operation; });
      if (await this.moveWithRecovery(operation)) return record.title;
      await this.deps.store.update((current) => {
        current.pendingOperation = undefined;
        current.lastUndo = undefined;
        appendActivity(current, {
          kind: 'undone', bookmarkId: record.bookmarkId, title: record.title,
          message: '已撤销最近一次自动归档。',
        }, this.now(), this.makeId);
      });
      return record.title;
    });
  }

  private async processJob(id: string): Promise<void> {
    if (this.inFlight.has(id)) return;
    if (this.activeClassifications >= MAX_CONCURRENT_CLASSIFICATIONS) {
      await this.deps.alarms.schedule(1_000);
      return;
    }
    this.inFlight.add(id);
    this.activeClassifications += 1;
    try {
      let state = await this.deps.store.load();
      let job = state.jobs[id];
      if (!job || !['queued', 'processing'].includes(job.status)) return;
      if (job.nextAttemptAt !== undefined && job.nextAttemptAt > this.now()) return;
      if (!state.settings.enabled) return;
      if (!state.settings.apiKey.trim()) {
        await this.updateJob(id, (current) => { current.status = 'awaiting_configuration'; });
        return;
      }
      const bookmark = await this.deps.bookmarks.getBookmark(id);
      if (!bookmark) {
        await this.failJob(id, '书签已不存在，未执行任何移动。', false);
        return;
      }
      if (bookmark.parentId !== job.bookmark.parentId) {
        await this.skipJob(id, '书签已被手动移动，已尊重当前目录。');
        return;
      }
      if (!state.settings.forceOrganize && !(await this.deps.bookmarks.isEligibleRoot(bookmark.parentId ?? ''))) {
        await this.skipJob(id, '书签不在可自动整理的内置目录中。');
        return;
      }
      await this.updateJob(id, (current) => { current.status = 'processing'; current.updatedAt = this.now(); });
      state = await this.deps.store.load();
      job = state.jobs[id];
      if (!job) return;
      const folders = await this.deps.bookmarks.getFolders();
      const currentFolder = folders.find((folder) => folder.id === bookmark.parentId);
      if (!currentFolder) {
        await this.failJob(id, '当前文件夹已不存在，书签保持原位。', false);
        return;
      }
      let classified: ClassifiedResult;
      try {
        const hasPermission = await this.deps.hasProviderPermission(state.settings.baseUrl);
        classified = await this.deps.classifier.classify({
          title: bookmark.title || '(无标题)',
          url: bookmark.url ?? '',
          domain: new URL(bookmark.url ?? '').hostname,
          currentFolder: currentFolder.path,
          currentFolderId: currentFolder.id,
        }, folders, state.settings, hasPermission);
      } catch (error) {
        if (error instanceof PermissionRequiredError) {
          await this.updateJob(id, (current) => {
            current.status = 'awaiting_permission';
            current.lastError = error.message;
            current.updatedAt = this.now();
          });
          await this.notifyFailure(id, state.settings);
          return;
        }
        if (error instanceof ProviderError && error.retryable && job.attempts < MAX_RETRIES) {
          const delay = 1_500 * (2 ** job.attempts);
          await this.updateJob(id, (current) => {
            current.status = 'queued';
            current.attempts += 1;
            current.nextAttemptAt = this.now() + delay;
            current.lastError = error.message;
            current.updatedAt = this.now();
          });
          await this.deps.alarms.schedule(delay);
          return;
        }
        await this.failJob(id, error instanceof Error ? error.message : 'AI 分类失败，书签保持原位。', false, state.settings);
        return;
      }
      if (!validResultTargets(classified, folders)) {
        await this.failJob(id, '分类建议中的文件夹已不存在，书签保持原位。', false, state.settings);
        return;
      }
      await this.updateJob(id, (current) => {
        current.classification = classified.result;
        current.classificationSource = classified.source;
        current.updatedAt = this.now();
      });

      const result = classified.result;
      if (result.action === 'keep') {
        await this.updateJob(id, (current) => { current.status = 'completed'; });
        await this.appendActivity({
          kind: 'kept', bookmarkId: id, title: job.bookmark.title, url: job.bookmark.url,
          message: result.reason, source: classified.source,
        });
        return;
      }
      if (result.action === 'suggest_folder'
        || result.action === 'move'
          && (state.settings.mode === 'confirm' || result.confidence < state.settings.confidenceThreshold)) {
        await this.createReview(job, result, classified.source, folders, state.settings);
        return;
      }
      if (result.action === 'move') {
        await this.automaticMove(job, result.targetFolderId, result.reason, classified.source, result.confidence);
      }
    } catch (error) {
      const state = await this.deps.store.load();
      if (state.jobs[id]?.status === 'skipped') return;
      await this.failJob(id, error instanceof Error ? error.message : '整理任务发生未知错误，书签保持原位。', false, state.settings);
    } finally {
      this.inFlight.delete(id);
      this.activeClassifications -= 1;
      void this.processPending();
    }
  }

  private async automaticMove(
    job: BookmarkJob,
    targetFolderId: string,
    reason: string,
    source: ClassifiedResult['source'],
    confidence: number,
  ): Promise<void> {
    await this.withMutationLock(async () => {
      const state = await this.deps.store.load();
      if (state.pendingOperation) throw new Error('另一项书签移动仍在恢复中，当前书签保持原位。');
      if (!state.settings.enabled) {
        await this.skipJob(job.bookmark.id, '自动整理已关闭，书签保留原位。');
        return;
      }
      const bookmark = await this.deps.bookmarks.getBookmark(job.bookmark.id);
      if (!bookmark || bookmark.parentId !== job.bookmark.parentId) {
        await this.skipJob(job.bookmark.id, '移动前书签位置发生变化，未覆盖当前操作。');
        return;
      }
      if (!state.settings.forceOrganize && !(await this.deps.bookmarks.isEligibleRoot(bookmark.parentId ?? ''))) {
        await this.skipJob(job.bookmark.id, '书签已不在可自动整理的内置目录中。');
        return;
      }
      if (state.settings.mode !== 'automatic' || confidence < state.settings.confidenceThreshold) {
        await this.createReview(job, {
          action: 'move', targetFolderId,
          confidence,
          reason,
        }, source, await this.deps.bookmarks.getFolders(), state.settings);
        return;
      }
      const target = await this.deps.bookmarks.getFolder(targetFolderId);
      if (!target || target.unmodifiable === 'managed') {
        await this.failJob(job.bookmark.id, '推荐文件夹已删除或不可修改，书签保持原位。', false, state.settings);
        return;
      }
      if (targetFolderId === bookmark.parentId) {
        await this.updateJob(job.bookmark.id, (current) => { current.status = 'completed'; });
        return;
      }
      const operation: PendingOperation = {
        bookmarkId: job.bookmark.id,
        title: job.bookmark.title,
        fromFolderId: bookmark.parentId ?? job.bookmark.parentId,
        toFolderId: targetFolderId,
        movedAt: this.now(),
        operationId: this.makeId('op'),
        state: 'prepared',
        kind: 'automatic',
      };
      const targetPath = await this.deps.bookmarks.getFolderPath(targetFolderId) ?? target.title;
      await this.deps.store.update((current) => { current.pendingOperation = operation; });

      // Re-read durable settings and bookmark state after persisting the operation intent.
      // Classification can take seconds, during which the user may change the policy or
      // move the bookmark manually. Do not commit using the earlier snapshot.
      const latestState = await this.deps.store.load();
      const latestBookmark = await this.deps.bookmarks.getBookmark(job.bookmark.id);
      if (!latestState.settings.enabled) {
        await this.clearPendingOperation(operation.operationId);
        await this.skipJob(job.bookmark.id, '自动整理已关闭，书签保留原位。');
        return;
      }
      if (!latestBookmark || latestBookmark.parentId !== operation.fromFolderId) {
        await this.clearPendingOperation(operation.operationId);
        await this.skipJob(job.bookmark.id, '移动前书签位置发生变化，未覆盖当前操作。');
        return;
      }
      if (!latestState.settings.forceOrganize
        && !(await this.deps.bookmarks.isEligibleRoot(latestBookmark.parentId ?? ''))) {
        await this.clearPendingOperation(operation.operationId);
        await this.skipJob(job.bookmark.id, '书签已不在可自动整理的内置目录中。');
        return;
      }
      if (latestState.settings.mode !== 'automatic' || confidence < latestState.settings.confidenceThreshold) {
        await this.clearPendingOperation(operation.operationId);
        await this.createReview(job, {
          action: 'move', targetFolderId,
          confidence,
          reason,
        }, source, await this.deps.bookmarks.getFolders(), latestState.settings);
        return;
      }
      if (await this.moveWithRecovery(operation)) {
        const recoveredSettings = (await this.deps.store.load()).settings;
        if (recoveredSettings.notificationsEnabled && recoveredSettings.successNotifications) {
          await this.deps.notifications.moved(job.bookmark.id, job.bookmark.title);
        }
        return;
      }
      await this.deps.store.update((current) => {
        current.pendingOperation = undefined;
        current.jobs[job.bookmark.id] && (current.jobs[job.bookmark.id]!.status = 'completed');
        current.lastUndo = {
          bookmarkId: operation.bookmarkId,
          title: operation.title,
          fromFolderId: operation.fromFolderId,
          toFolderId: operation.toFolderId,
          movedAt: operation.movedAt,
          operationId: operation.operationId,
        };
        appendActivity(current, {
          kind: 'moved', bookmarkId: job.bookmark.id, title: job.bookmark.title, url: job.bookmark.url,
          message: `已自动归档到 ${targetPath}。${reason ? ` ${reason}` : ''}`,
          source, fromFolderId: operation.fromFolderId, toFolderId: operation.toFolderId,
        }, this.now(), this.makeId);
      });
      const latestSettings = (await this.deps.store.load()).settings;
      if (latestSettings.notificationsEnabled && latestSettings.successNotifications) {
        await this.deps.notifications.moved(job.bookmark.id, job.bookmark.title);
      }
    });
  }

  private async createReview(
    job: BookmarkJob,
    result: Exclude<BookmarkJob['classification'], undefined>,
    source: ClassifiedResult['source'],
    folders: FolderSummary[],
    settings: Settings,
  ): Promise<void> {
    const review: ReviewItem = {
      id: job.bookmark.id,
      bookmarkId: job.bookmark.id,
      title: job.bookmark.title,
      url: job.bookmark.url,
      sourceParentId: job.bookmark.parentId,
      classification: result,
      source,
      ...(result.action === 'move'
        ? { targetFolderPath: folders.find((folder) => folder.id === result.targetFolderId)?.path }
        : result.action === 'suggest_folder'
          ? { parentFolderPath: folders.find((folder) => folder.id === result.suggestedFolder.parentId)?.path }
          : {}),
      createdAt: this.now(),
      status: 'pending',
    };
    await this.deps.store.update((state) => {
      if (state.reviews[review.id]?.status === 'pending') return;
      state.reviews[review.id] = review;
      const currentJob = state.jobs[job.bookmark.id];
      if (currentJob) currentJob.status = 'pending_review';
      appendActivity(state, {
        kind: 'review_created', bookmarkId: job.bookmark.id, title: job.bookmark.title,
        url: job.bookmark.url, message: '有一条分类建议等待确认。', source,
      }, this.now(), this.makeId);
    });
    if (settings.notificationsEnabled) await this.deps.notifications.reviewNeeded(review.id);
  }

  private async failJob(id: string, message: string, retryable: boolean, settings?: Settings): Promise<void> {
    await this.deps.store.update((state) => {
      const job = state.jobs[id];
      if (job) {
        job.status = 'failed';
        job.lastError = message;
        job.updatedAt = this.now();
      }
      appendActivity(state, {
        kind: 'failed', bookmarkId: id, title: job?.bookmark.title ?? '书签',
        url: job?.bookmark.url, message,
      }, this.now(), this.makeId);
    });
    void retryable;
    const currentSettings = settings ?? (await this.deps.store.load()).settings;
    await this.notifyFailure(id, currentSettings);
  }

  private async notifyFailure(id: string, settings: Settings): Promise<void> {
    if (settings.notificationsEnabled) await this.deps.notifications.processingFailed(id);
  }

  private async skipJob(id: string, message: string): Promise<void> {
    await this.deps.store.update((state) => {
      const job = state.jobs[id];
      if (job) {
        job.status = 'skipped';
        job.lastError = message;
        job.updatedAt = this.now();
      }
      appendActivity(state, {
        kind: 'skipped', bookmarkId: id, title: job?.bookmark.title ?? '书签',
        url: job?.bookmark.url, message,
      }, this.now(), this.makeId);
    });
  }

  private async updateJob(id: string, update: (job: BookmarkJob) => void): Promise<void> {
    await this.deps.store.update((state) => {
      const job = state.jobs[id];
      if (job) update(job);
    });
  }

  private async appendActivity(activity: Omit<ActivityRecord, 'id' | 'at'>): Promise<void> {
    await this.deps.store.update((state) => appendActivity(state, activity, this.now(), this.makeId));
  }

  private async clearPendingOperation(operationId: string): Promise<void> {
    await this.deps.store.update((state) => {
      if (state.pendingOperation?.operationId === operationId) state.pendingOperation = undefined;
    });
  }

  /**
   * Chrome may reject a move after the browser has already applied it. Reconcile
   * the durable intent immediately so this worker does not block later mutations.
   * Returns true when reconciliation finalized the operation.
   */
  private async moveWithRecovery(operation: PendingOperation): Promise<boolean> {
    try {
      const bookmark = await this.deps.bookmarks.getBookmark(operation.bookmarkId);
      if (!bookmark || bookmark.parentId !== operation.fromFolderId) {
        throw new Error('书签位置已变化，未执行移动。');
      }
      await this.deps.bookmarks.moveBookmark(operation.bookmarkId, operation.toFolderId);
      return false;
    } catch (error) {
      await this.reconcilePendingOperation();
      const bookmark = await this.deps.bookmarks.getBookmark(operation.bookmarkId);
      if (bookmark?.parentId === operation.toFolderId) return true;
      throw error;
    }
  }

  private async closeReview(
    item: ReviewItem,
    status: ReviewItem['status'],
    message: string,
    kind: 'kept' | 'review_approved' | 'review_rejected',
  ): Promise<void> {
    await this.deps.store.update((state) => {
      const review = state.reviews[item.id];
      if (review) review.status = status;
      const job = state.jobs[item.bookmarkId];
      if (job) job.status = 'completed';
      appendActivity(state, {
        kind, bookmarkId: item.bookmarkId, title: item.title, url: item.url, message, source: item.source,
      }, this.now(), this.makeId);
    });
  }

  private async markReviewStale(item: ReviewItem, message: string): Promise<void> {
    await this.deps.store.update((state) => {
      const review = state.reviews[item.id];
      if (review) review.status = 'stale';
      const job = state.jobs[item.bookmarkId];
      if (job) {
        job.status = 'skipped';
        job.lastError = message;
      }
      appendActivity(state, {
        kind: 'skipped', bookmarkId: item.bookmarkId, title: item.title, url: item.url,
        message, source: item.source,
      }, this.now(), this.makeId);
    });
  }

  private async reconcilePendingOperation(): Promise<void> {
    const initial = await this.deps.store.load();
    const operation = initial.pendingOperation;
    if (!operation) return;
    const bookmark = await this.deps.bookmarks.getBookmark(operation.bookmarkId);
    const actualParent = bookmark?.parentId;
    await this.deps.store.update((state) => {
      const pending = state.pendingOperation;
      if (!pending || pending.operationId !== operation.operationId) return;
      const job = state.jobs[pending.bookmarkId];
      const review = pending.reviewId ? state.reviews[pending.reviewId] : undefined;
      if (actualParent === pending.toFolderId) {
        if (pending.kind === 'automatic') {
          state.lastUndo = {
            bookmarkId: pending.bookmarkId,
            title: pending.title,
            fromFolderId: pending.fromFolderId,
            toFolderId: pending.toFolderId,
            movedAt: pending.movedAt,
            operationId: pending.operationId,
          };
          appendActivity(state, {
            kind: 'moved', bookmarkId: pending.bookmarkId, title: pending.title,
            message: 'Service Worker 恢复时确认自动归档已完成。',
            fromFolderId: pending.fromFolderId, toFolderId: pending.toFolderId,
          }, this.now(), this.makeId);
        } else if (pending.kind === 'review' && review) {
          review.status = 'approved';
          appendActivity(state, {
            kind: 'review_approved', bookmarkId: pending.bookmarkId, title: pending.title,
            message: '确认的归档操作已完成。',
            fromFolderId: pending.fromFolderId, toFolderId: pending.toFolderId,
          }, this.now(), this.makeId);
        } else if (pending.kind === 'undo') {
          state.lastUndo = undefined;
          appendActivity(state, {
            kind: 'undone', bookmarkId: pending.bookmarkId, title: pending.title,
            message: 'Service Worker 恢复时确认撤销已完成。',
          }, this.now(), this.makeId);
        }
        if (job) job.status = 'completed';
      } else if (actualParent === pending.fromFolderId) {
        if (pending.kind === 'review' && review?.status === 'approving') review.status = 'pending';
        if (pending.kind === 'undo') {
          // The undo move never happened; keep the original undo record available.
        } else if (job?.status === 'processing') {
          job.status = 'queued';
        }
      } else {
        if (review) review.status = 'stale';
        if (job) {
          job.status = 'skipped';
          job.lastError = '恢复时发现书签已位于其他目录，未覆盖当前状态。';
        }
        if (pending.kind === 'undo') state.lastUndo = undefined;
      }
      state.pendingOperation = undefined;
    });
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(operation, operation);
    this.mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validResultTargets(classified: ClassifiedResult, folders: FolderSummary[]): boolean {
  const validFolder = (id: string) => folders.some((folder) => folder.id === id && folder.unmodifiable !== 'managed');
  const result = classified.result;
  if (result.action === 'move') return validFolder(result.targetFolderId);
  if (result.action === 'suggest_folder') return validFolder(result.suggestedFolder.parentId);
  return true;
}

function appendActivity(
  state: PersistedState,
  activity: Omit<ActivityRecord, 'id' | 'at'>,
  at: number,
  makeId: (prefix: string) => string,
): void {
  state.activities.push({ ...activity, id: makeId('activity'), at });
  state.activities = state.activities.slice(-100);
}

function pruneJobs(state: PersistedState): void {
  const ids = Object.values(state.jobs)
    .filter((job) => job.status !== 'pending_review')
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, Math.max(0, Object.keys(state.jobs).length - 250))
    .map((job) => job.bookmark.id);
  for (const id of ids) delete state.jobs[id];
}

function findNode(nodes: BookmarkNode[], id: string): BookmarkNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = node.children ? findNode(node.children, id) : null;
    if (found) return found;
  }
  return null;
}
