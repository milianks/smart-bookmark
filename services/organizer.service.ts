import { appendActivity, pruneJobs } from './activity-log';
import { historicalScanSummary, refreshHistoricalScan } from './scan-state';
import { ProviderError } from '../lib/ai/openai-compatible';
import { PermissionRequiredError, type BatchOutcome, type ClassifierPort } from './classifier.service';
import { type BookmarkPort, type BookmarkNode, SMART_ARCHIVE_FOLDER_NAME } from './bookmark.service';
import type { StateRepository } from '../lib/storage/repository';
import { createId, hostnameKey } from '../lib/utils/ids';
import type {
  ActivityRecord,
  CorrectionEntry,
  BookmarkJob,
  BookmarkSnapshot,
  ClassifiedResult,
  DashboardState,
  FolderSummary,
  PendingOperation,
  PersistedState,
  ReviewItem,
  Settings,
  UndoRecord,
} from '../types/domain';
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
const MAX_BATCH_CLASSIFICATIONS = 15;
const IMPORT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

interface PreparedJob {
  id: string;
  job: BookmarkJob;
  bookmark: BookmarkNode;
  folders: FolderSummary[];
  currentFolder: FolderSummary;
  settings: Settings;
}

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

    const rootId = state.smartBookmarkRootId;
    if (!rootId || !this.deps.bookmarks.isWithinRoot) return;
    const externalEligible = state.settings.organizeExternalRoots
      && Boolean(this.deps.bookmarks.isEligibleRoot)
      && node.parentId !== rootId
      && (await this.deps.bookmarks.isEligibleRoot?.(node.parentId ?? '')) === true;
    if (!externalEligible && !(await this.isWithinSmartRoot(node.parentId, rootId))) return;

    const externalRoot = !(await this.isWithinSmartRoot(node.parentId, rootId));

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
    const job: BookmarkJob = {
      bookmark: snapshot,
      status: state.settings.apiKey.trim() ? 'queued' : 'awaiting_configuration',
      attempts: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
      ...(externalRoot ? { externalRoot: true } : {}),
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


  async undoHistoricalLast(): Promise<number> {
    return this.withMutationLock(async () => {
      const state = await this.deps.store.load();
      const record = state.lastHistoricalUndo;
      if (!record || record.moved.length === 0) throw new Error('没有可以撤销的历史批量归档。');
      const rootId = await this.getSmartRootId();
      if (!rootId) throw new Error('智能书签目录不可用，无法撤销历史归档。');
      let count = 0;
      for (const move of record.moved) {
        const bookmark = await this.deps.bookmarks.getBookmark(move.bookmarkId);
        if (!bookmark || bookmark.parentId !== move.toFolderId
          || !(await this.isWithinSmartRoot(bookmark.id, rootId))
          || !(await this.isValidSmartTarget(move.toFolderId, rootId))
          || !(await this.isValidSmartTarget(move.fromFolderId, rootId))) {
          await this.appendActivity({
            kind: 'skipped', bookmarkId: move.bookmarkId, title: move.title,
            message: '历史批量撤销跳过：书签已删除、手动移动或原文件夹不存在。',
          });
          continue;
        }
        const operation: PendingOperation = {
          ...move,
          fromFolderId: move.toFolderId,
          toFolderId: move.fromFolderId,
          movedAt: this.now(), operationId: this.makeId('undo'), state: 'prepared', kind: 'undo', scanId: record.scanId,
        };
        await this.deps.store.update((current) => { current.pendingOperation = operation; });
        try {
          await this.moveWithRecovery(operation);
          count += 1;
        } catch {
          // Leave manually changed or failed items untouched.
        }
      }
      await this.deps.store.update((current) => {
        current.lastHistoricalUndo = undefined;
        current.pendingOperation = undefined;
        appendActivity(current, { kind: 'undone', title: '历史批量归档', message: `已撤销 ${count} 条历史归档。` }, this.now(), this.makeId);
      });
      return count;
    });
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
    const historicalScanId = (await this.deps.store.load()).historicalScan?.id;
    if (historicalScanId) await this.refreshHistoricalScan(historicalScanId);
  }


  async processPending(): Promise<void> {
    const state = await this.deps.store.load();
    const readyJobs = Object.values(state.jobs)
      .filter((job) => job.status === 'queued'
        && (state.settings.enabled || Boolean(job.scanId))
        && (job.nextAttemptAt === undefined || job.nextAttemptAt <= this.now()))
      .sort((a, b) => a.createdAt - b.createdAt);
    const scanReady = readyJobs.filter((job) => job.scanId).slice(0, MAX_BATCH_CLASSIFICATIONS);
    const others = readyJobs.filter((job) => !job.scanId).slice(0, MAX_CONCURRENT_CLASSIFICATIONS);
    const tasks: Array<Promise<void>> = [];
    if (scanReady.length > 1 && this.deps.classifier.classifyBatch) {
      tasks.push(this.processBatch(scanReady.map((job) => job.bookmark.id)));
    } else {
      tasks.push(...scanReady.slice(0, MAX_CONCURRENT_CLASSIFICATIONS).map((job) => this.processJob(job.bookmark.id)));
    }
    tasks.push(...others.map((job) => this.processJob(job.bookmark.id)));
    await Promise.allSettled(tasks);
    const latest = await this.deps.store.load();
    const queued = Object.values(latest.jobs).filter((job) => job.status === 'queued' && (latest.settings.enabled || Boolean(job.scanId)));
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
    const folderOptions = state.smartBookmarkRootId
      ? ((await this.getFoldersWithinSmartRoot(state.smartBookmarkRootId)) ?? [])
        .filter((folder) => folder.unmodifiable !== 'managed')
        .map((folder) => ({ id: folder.id, path: folder.path }))
      : [];
    return {
      settings: { ...settings, hasApiKey: configured },
      pendingReviews: Object.values(state.reviews)
        .filter((item) => item.status === 'pending' || item.status === 'approving')
        .map((item) => ({ ...item, ...(state.bookmarkMetadata[item.bookmarkId] ? { metadata: state.bookmarkMetadata[item.bookmarkId] } : {}) }))
        .sort((a, b) => b.createdAt - a.createdAt),
      historicalReviews: Object.values(state.reviews)
        .filter((item) => Boolean(item.scanId))
        .map((item) => ({ ...item, ...(state.bookmarkMetadata[item.bookmarkId] ? { metadata: state.bookmarkMetadata[item.bookmarkId] } : {}) }))
        .sort((a, b) => b.createdAt - a.createdAt),
      recentJobs: Object.values(state.jobs)
        .map((job) => ({ ...job, ...(state.bookmarkMetadata[job.bookmark.id] ? { metadata: state.bookmarkMetadata[job.bookmark.id] } : {}) }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 8),
      activities: state.activities.slice(-20).reverse(),
      awaitingConfigurationCount: Object.values(state.jobs).filter((job) => job.status === 'awaiting_configuration').length,
      awaitingPermissionCount: Object.values(state.jobs).filter((job) => job.status === 'awaiting_permission').length,
      ...(state.lastUndo ? { lastUndo: state.lastUndo } : {}),
      undoStackCount: state.undoStack.length,
      folders: folderOptions,
      aiStatus: configured ? (permission ? 'configured' : 'permission-needed') : 'missing-key',
      ...(state.historicalScan ? {
        historicalScan: historicalScanSummary(state.historicalScan, Boolean(state.lastHistoricalUndo?.moved.length)),
      } : {}),
      historicalUndoAvailable: Boolean(state.lastHistoricalUndo?.moved.length),
    };
  }



  async approveReview(id: string, overrideFolderId?: string): Promise<void> {
    await this.withMutationLock(async () => {
      await this.reconcilePendingOperation();
      const item = await this.loadReviewForApproval(id);
      if (!item) return;
      const target = await this.resolveReviewTarget(item, overrideFolderId);
      if (!target) return;
      if (!(await this.revalidateReviewBeforeMove(item, target.folderId))) return;
      const operation = await this.prepareReviewMove(item, id, target.folderId);
      if (await this.moveWithRecovery(operation)) return;
      await this.recordApprovedReview(item, operation, target.name, overrideFolderId);
    });
  }

  private async loadReviewForApproval(id: string): Promise<ReviewItem | null> {
    const item = (await this.deps.store.load()).reviews[id];
    if (!item) throw new Error('这条建议不存在或已过期。');
    if (item.status === 'approved') return null;
    if (item.status === 'rejected' || item.status === 'stale') throw new Error('这条建议已关闭。');
    const bookmark = await this.deps.bookmarks.getBookmark(item.bookmarkId);
    const rootId = await this.getSmartRootId();
    if (!rootId || !bookmark || bookmark.parentId !== item.sourceParentId
      || !(await this.isWithinSmartRoot(bookmark.id, rootId))
        && !(await this.isExternalSourceFolder(bookmark.parentId))
      || !(await this.isValidSourceFolder(item.sourceParentId, rootId))) {
      await this.markReviewStale(item, '书签已被删除或手动移动，未执行建议。');
      throw new Error('书签位置已变化，建议已标记为过期。');
    }
    await this.deps.store.update((current) => {
      const review = current.reviews[id];
      if (review) review.status = 'approving';
    });
    const approvingItem = (await this.deps.store.load()).reviews[id];
    if (!approvingItem) throw new Error('建议状态已变化。');
    return approvingItem;
  }

  private async resolveReviewTarget(item: ReviewItem, overrideFolderId?: string): Promise<{ folderId: string; name: string } | null> {
    const rootId = await this.getSmartRootId();
    if (!rootId) {
      await this.markReviewStale(item, '智能书签目录不可用，未执行建议。');
      throw new Error('智能书签目录不可用，未执行建议。');
    }
    if (overrideFolderId) {
      const overrideTarget = await this.deps.bookmarks.getFolder(overrideFolderId);
      if (!overrideTarget || overrideTarget.unmodifiable === 'managed'
        || !(await this.isValidSmartTarget(overrideFolderId, rootId))) {
        await this.markReviewStale(item, '改选的文件夹不存在或不可用，未执行移动。');
        throw new Error('改选的文件夹不存在或不可用。');
      }
      return { folderId: overrideTarget.id, name: overrideTarget.title };
    }
    if (item.classification.action === 'suggest_folder') {
      const { name, parentId } = item.classification.suggestedFolder;
      const parent = await this.deps.bookmarks.getFolder(parentId);
      if (!parent || parent.unmodifiable === 'managed' || !(await this.isValidSmartTarget(parentId, rootId))) {
        await this.markReviewStale(item, '建议的新目录上级已不存在或不可修改。');
        throw new Error('建议的新目录上级已不存在或不可修改。');
      }
      const targetName = name.trim().slice(0, 64);
      const tree = await this.deps.bookmarks.getTree();
      const parentNode = findNode(tree, parentId);
      const existing = parentNode?.children?.find((child) => !child.url
        && child.title.trim().toLocaleLowerCase() === targetName.toLocaleLowerCase());
      const target = item.targetFolderId
        ? await this.deps.bookmarks.getFolder(item.targetFolderId)
        : existing ?? await this.deps.bookmarks.createFolder(targetName, parentId);
      if (!target || target.unmodifiable === 'managed' || !(await this.isValidSmartTarget(target.id, rootId))) {
        await this.markReviewStale(item, '建议的新目录不在智能书签目录内。');
        throw new Error('无法创建或找到建议文件夹。');
      }
      await this.deps.store.update((current) => {
        const review = current.reviews[item.id];
        if (review) {
          review.targetFolderId = target.id;
          review.status = 'approving';
        }
      });
      return { folderId: target.id, name: targetName };
    }
    if (item.classification.action === 'move') {
      const targetFolderId = item.classification.targetFolderId;
      const target = await this.deps.bookmarks.getFolder(targetFolderId);
      if (!target || target.unmodifiable === 'managed' || !(await this.isValidSmartTarget(targetFolderId, rootId))) {
        await this.markReviewStale(item, '推荐文件夹已不存在或不可修改。');
        throw new Error('推荐文件夹已不存在或不可修改。');
      }
      return { folderId: targetFolderId, name: target.title };
    }
    await this.closeReview(item, 'approved', '用户确认保留原位。', 'kept');
    if (item.scanId) await this.refreshHistoricalScan(item.scanId);
    return null;
  }

  private async revalidateReviewBeforeMove(item: ReviewItem, targetFolderId: string): Promise<boolean> {
    const latestBookmark = await this.deps.bookmarks.getBookmark(item.bookmarkId);
    const rootId = await this.getSmartRootId();
    if (!rootId || !latestBookmark || latestBookmark.parentId !== item.sourceParentId
      || !(await this.isWithinSmartRoot(latestBookmark.id, rootId))
        && !(await this.isExternalSourceFolder(latestBookmark.parentId))
      || !(await this.isValidSourceFolder(item.sourceParentId, rootId))) {
      await this.markReviewStale(item, '书签位置在确认过程中发生变化，未执行移动。');
      throw new Error('书签位置发生变化，未执行移动。');
    }
    if (targetFolderId === item.sourceParentId) {
      await this.closeReview(item, 'approved', '书签已位于推荐文件夹，无需移动。', 'review_approved');
      if (item.scanId) await this.refreshHistoricalScan(item.scanId);
      return false;
    }
    const target = await this.deps.bookmarks.getFolder(targetFolderId);
    if (!target || target.unmodifiable === 'managed' || !(await this.isValidSmartTarget(targetFolderId, rootId))) {
      await this.markReviewStale(item, '推荐文件夹已不存在或不可修改。');
      throw new Error('推荐文件夹已不存在或不可修改。');
    }
    return true;
  }

  private async prepareReviewMove(item: ReviewItem, id: string, targetFolderId: string): Promise<PendingOperation> {
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
      ...(item.scanId ? { scanId: item.scanId } : {}),
    };
    await this.deps.store.update((current) => { current.pendingOperation = operation; });
    return operation;
  }

  private async recordApprovedReview(item: ReviewItem, operation: PendingOperation, targetName: string, overrideFolderId?: string): Promise<void> {
    await this.deps.store.update((current) => {
      const review = current.reviews[item.id];
      if (review) review.status = 'approved';
      const job = current.jobs[item.bookmarkId];
      if (job) job.status = 'completed';
      current.pendingOperation = undefined;
      if (overrideFolderId) recordCorrection(current, item.url, { action: 'move', folderId: overrideFolderId }, this.now());
      if (item.scanId) {
        const previous = current.lastHistoricalUndo?.scanId === item.scanId
          ? current.lastHistoricalUndo
          : { scanId: item.scanId, moved: [], createdAt: this.now() };
        previous.moved.push({
          bookmarkId: operation.bookmarkId,
          title: operation.title,
          fromFolderId: operation.fromFolderId,
          toFolderId: operation.toFolderId,
          movedAt: operation.movedAt,
          operationId: operation.operationId,
        });
        current.lastHistoricalUndo = previous;
      }
      appendActivity(current, {
        kind: 'review_approved', bookmarkId: item.bookmarkId, title: item.title, url: item.url,
        message: `已移动到 ${targetName}。`, source: item.source,
        fromFolderId: item.sourceParentId, toFolderId: operation.toFolderId,
      }, this.now(), this.makeId);
    });
    if (item.scanId) await this.refreshHistoricalScan(item.scanId);
  }

  async rejectReview(id: string): Promise<void> {
    await this.withMutationLock(async () => {
      const state = await this.deps.store.load();
      const item = state.reviews[id];
      if (!item || item.status === 'rejected') return;
      if (item.status === 'approved' || item.status === 'stale') throw new Error('这条建议已经关闭。');
      await this.closeReview(item, 'rejected', '用户选择保留书签原位。', 'review_rejected');
      await this.deps.store.update((current) => recordCorrection(current, item.url, { action: 'keep' }, this.now()));
      if (item.scanId) await this.refreshHistoricalScan(item.scanId);
    });
  }

  async undoLastMove(): Promise<string> {
    return this.withMutationLock(async () => {
      const state = await this.deps.store.load();
      const stack = state.undoStack.length > 0 ? state.undoStack : (state.lastUndo ? [state.lastUndo] : []);
      const record = stack[stack.length - 1];
      if (!record) throw new Error('没有可以撤销的自动归档操作。');
      const rootId = await this.getSmartRootId();
      if (!rootId) throw new Error('智能书签目录不可用，无法撤销。');
      const bookmark = await this.deps.bookmarks.getBookmark(record.bookmarkId);
      if (!bookmark) throw new Error('书签已不存在，无法撤销。');
      if (bookmark.parentId !== record.toFolderId) {
        throw new Error('书签已被手动移动，为避免覆盖你的操作，无法撤销。');
      }
      if (!(await this.isWithinSmartRoot(bookmark.id, rootId))
        || !(await this.isValidSmartTarget(record.toFolderId, rootId))
        || !(await this.isValidSourceFolder(record.fromFolderId, rootId))) {
        throw new Error('撤销目标不在智能书签目录内，已保留当前状态。');
      }
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
        current.undoStack = current.undoStack.filter((entry) => entry.operationId !== record.operationId);
        current.lastUndo = current.undoStack[current.undoStack.length - 1];
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
      const prepared = await this.prepareJob(id);
      if (!prepared) return;
      const classified = prepared.job.duplicateOf
        ? await this.classifyDuplicate(prepared.id, prepared.job, prepared.folders, prepared.settings)
        : await this.classifyViaProvider(prepared.id, prepared.job, prepared.bookmark, prepared.currentFolder, prepared.folders, prepared.settings);
      if (!classified) return;
      await this.applyClassification(prepared, classified);
    } catch (error) {
      const state = await this.deps.store.load();
      if (state.jobs[id]?.status === 'skipped') return;
      await this.failJob(id, error instanceof Error ? error.message : '整理任务发生未知错误，书签保持原位。', false, state.settings);
    } finally {
      this.inFlight.delete(id);
      this.activeClassifications -= 1;
      const historical = (await this.deps.store.load()).jobs[id]?.scanId;
      if (historical) await this.refreshHistoricalScan(historical);
      void this.processPending();
    }
  }

  private async processBatch(ids: string[]): Promise<void> {
    const batchKey = `batch:${ids.join(',')}`;
    if (this.inFlight.has(batchKey)) return;
    this.inFlight.add(batchKey);
    this.activeClassifications += 1;
    const prepared: PreparedJob[] = [];
    try {
      for (const id of ids) {
        if (this.inFlight.has(id)) continue;
        this.inFlight.add(id);
        const item = await this.prepareJob(id);
        if (item) prepared.push(item);
        else this.inFlight.delete(id);
      }
      for (const item of prepared) {
        if (!item.job.duplicateOf) continue;
        const classified = await this.classifyDuplicate(item.id, item.job, item.folders, item.settings);
        if (classified) await this.applyClassification(item, classified);
      }
      const batchPrepared = prepared.filter((item) => !item.job.duplicateOf);
      if (batchPrepared.length === 0) return;
      if (!this.deps.classifier.classifyBatch) {
        for (const item of batchPrepared) {
          const classified = await this.classifyViaProvider(item.id, item.job, item.bookmark, item.currentFolder, item.folders, item.settings);
          if (classified) await this.applyClassification(item, classified);
        }
        return;
      }
      let outcomes: BatchOutcome[] | undefined;
      try {
        const hasPermission = await this.deps.hasProviderPermission(batchPrepared[0]!.settings.baseUrl);
        outcomes = await this.deps.classifier.classifyBatch(
          batchPrepared.map((item) => ({
            title: item.bookmark.title || '(无标题)',
            url: item.bookmark.url ?? '',
            domain: new URL(item.bookmark.url ?? '').hostname,
            currentFolder: item.currentFolder.path,
            currentFolderId: item.currentFolder.id,
          })),
          batchPrepared[0]!.folders,
          batchPrepared[0]!.settings,
          hasPermission,
        );
      } catch (error) {
        for (const item of batchPrepared) await this.handleClassifyError(item.id, item.job, item.settings, error);
        return;
      }
      for (const [index, item] of batchPrepared.entries()) {
        const outcome = outcomes[index];
        if (!outcome) continue;
        if ('error' in outcome) {
          await this.handleClassifyError(item.id, item.job, item.settings, outcome.error);
          continue;
        }
        try {
          await this.applyClassification(item, outcome.result);
        } catch (error) {
          await this.handleClassifyError(item.id, item.job, item.settings, error);
        }
      }
    } finally {
      this.inFlight.delete(batchKey);
      for (const id of ids) this.inFlight.delete(id);
      this.activeClassifications -= 1;
      const scanId = (await this.deps.store.load()).jobs[ids[0] ?? '']?.scanId;
      if (scanId) await this.refreshHistoricalScan(scanId);
      void this.processPending();
    }
  }

  private async prepareJob(id: string): Promise<PreparedJob | null> {
    let state = await this.deps.store.load();
    let job = state.jobs[id];
    if (!job || !['queued', 'processing'].includes(job.status)) return null;
    if (job.nextAttemptAt !== undefined && job.nextAttemptAt > this.now()) return null;
    if (!state.settings.enabled && !job.scanId) return null;
    if (!state.settings.apiKey.trim()) {
      await this.updateJob(id, (current) => { current.status = 'awaiting_configuration'; });
      return null;
    }
    const bookmark = await this.deps.bookmarks.getBookmark(id);
    if (!bookmark) {
      await this.failJob(id, '书签已不存在，未执行任何移动。', false);
      return null;
    }
    if (bookmark.parentId !== job.bookmark.parentId) {
      await this.skipJob(id, '书签已被手动移动，已尊重当前目录。');
      return null;
    }
    const rootId = state.smartBookmarkRootId;
    if (!rootId || !this.deps.bookmarks.isWithinRoot
      || !(await this.isBookmarkInScope(bookmark, rootId, Boolean(job.externalRoot)))) {
      await this.skipJob(id, '书签不在智能书签目录内，已保留原位。');
      return null;
    }
    await this.updateJob(id, (current) => { current.status = 'processing'; current.updatedAt = this.now(); });
    state = await this.deps.store.load();
    job = state.jobs[id];
    if (!job) return null;
    const latestRootId = state.smartBookmarkRootId;
    if (!latestRootId || !this.deps.bookmarks.isWithinRoot
      || !(await this.isBookmarkInScope(bookmark, latestRootId, Boolean(job.externalRoot)))) {
      await this.skipJob(id, '智能书签目录已变化，书签保留原位。');
      return null;
    }
    const folders = await this.getFoldersWithinSmartRoot(latestRootId);
    if (!folders) {
      await this.failJob(id, '智能书签目录结构不可用，书签保持原位。', false, state.settings);
      return null;
    }
    let currentFolder = folders.find((folder) => folder.id === bookmark.parentId);
    if (!currentFolder && job.externalRoot) {
      const parent = await this.deps.bookmarks.getFolder(bookmark.parentId ?? '');
      if (parent && await this.isExternalSourceFolder(parent.id)) {
        currentFolder = { id: parent.id, name: parent.title, path: parent.title };
      }
    }
    if (!currentFolder) {
      await this.failJob(id, '当前文件夹已不存在，书签保持原位。', false);
      return null;
    }
    return { id, job, bookmark, folders, currentFolder, settings: state.settings };
  }

  private async applyClassification(prepared: PreparedJob, classified: ClassifiedResult): Promise<void> {
    const { id, job, folders, settings } = prepared;
    if (!validResultTargets(classified, folders)) {
      await this.failJob(id, '分类建议中的文件夹已不存在，书签保持原位。', false, settings);
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
    if (job.scanId) {
      await this.createReview(job, result, classified.source, folders, settings);
      return;
    }
    if (result.action === 'suggest_folder'
      || result.action === 'move'
        && (settings.mode === 'confirm' || result.confidence < settings.confidenceThreshold)) {
      await this.createReview(job, result, classified.source, folders, settings);
      return;
    }
    if (result.action === 'move') {
      await this.automaticMove(job, result.targetFolderId, result.reason, classified.source, result.confidence);
    }
  }

  private async classifyViaProvider(
    id: string,
    job: BookmarkJob,
    bookmark: BookmarkNode,
    currentFolder: FolderSummary,
    folders: FolderSummary[],
    settings: Settings,
  ): Promise<ClassifiedResult | undefined> {
    try {
      const hasPermission = await this.deps.hasProviderPermission(settings.baseUrl);
      return await this.deps.classifier.classify({
        title: bookmark.title || '(无标题)',
        url: bookmark.url ?? '',
        domain: new URL(bookmark.url ?? '').hostname,
        currentFolder: currentFolder.path,
        currentFolderId: currentFolder.id,
      }, folders, settings, hasPermission);
    } catch (error) {
      await this.handleClassifyError(id, job, settings, error);
      return undefined;
    }
  }

  private async handleClassifyError(id: string, job: BookmarkJob, settings: Settings, error: unknown): Promise<void> {
    const current = (await this.deps.store.load()).jobs[id];
    if (current?.status === 'skipped') return;
    if (error instanceof PermissionRequiredError) {
      await this.updateJob(id, (pending) => {
        pending.status = 'awaiting_permission';
        pending.lastError = error.message;
        pending.updatedAt = this.now();
      });
      await this.notifyFailure(id, settings);
      return;
    }
    if (error instanceof ProviderError && error.retryable && job.attempts < MAX_RETRIES) {
      const delay = 1_500 * (2 ** job.attempts);
      await this.updateJob(id, (pending) => {
        pending.status = 'queued';
        pending.attempts += 1;
        pending.nextAttemptAt = this.now() + delay;
        pending.lastError = error.message;
        pending.updatedAt = this.now();
      });
      await this.deps.alarms.schedule(delay);
      return;
    }
    await this.failJob(id, error instanceof Error ? error.message : 'AI 分类失败，书签保持原位。', false, settings);
  }


  private async classifyDuplicate(
    id: string,
    job: BookmarkJob,
    folders: FolderSummary[],
    settings: Settings,
  ): Promise<ClassifiedResult | undefined> {
    const archive = folders.find((folder) =>
      folder.name === SMART_ARCHIVE_FOLDER_NAME && folder.unmodifiable !== 'managed');
    if (!archive) {
      await this.failJob(id, '未找到“🗄️ 归档”目录，重复书签保持原位。', false, settings);
      return undefined;
    }
    const keptTitle = (await this.deps.bookmarks.getBookmark(job.duplicateOf!))?.title.trim();
    return {
      result: {
        action: 'move', targetFolderId: archive.id, confidence: 1,
        reason: keptTitle ? `重复书签：与“${keptTitle}”相同，建议移入归档。` : '重复书签：保留最早一条，其余移入归档。',
      },
      source: 'rule',
    };
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
      const rootId = state.smartBookmarkRootId;
      if (!rootId || !this.deps.bookmarks.isWithinRoot || !this.deps.bookmarks.isValidTargetFolder
        || !(await this.isBookmarkInScope(job.bookmark, rootId, Boolean(job.externalRoot)))) {
        await this.skipJob(job.bookmark.id, '智能书签目录不可用或书签已在目录外，已保留原位。');
        return;
      }
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
      if (!(await this.isBookmarkInScope(bookmark, rootId, Boolean(job.externalRoot)))) {
        await this.skipJob(job.bookmark.id, '书签已移出智能书签目录，未覆盖当前操作。');
        return;
      }
      if (!(await this.isValidSmartTarget(targetFolderId, rootId))) {
        await this.failJob(job.bookmark.id, '推荐文件夹已删除、不可修改或位于智能书签目录外，书签保持原位。', false, state.settings);
        return;
      }
      if (state.settings.mode !== 'automatic' || confidence < state.settings.confidenceThreshold) {
        await this.createReview(job, {
          action: 'move', targetFolderId,
          confidence,
          reason,
        }, source, await this.getFoldersWithinSmartRoot(rootId) ?? [], state.settings);
        return;
      }
      const target = await this.deps.bookmarks.getFolder(targetFolderId);
      if (!target || target.unmodifiable === 'managed' || !(await this.isValidSmartTarget(targetFolderId, rootId))) {
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
        ...(job.externalRoot ? { externalSource: true } : {}),
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
      const latestRootId = latestState.smartBookmarkRootId;
      if (!latestRootId || !this.deps.bookmarks.isWithinRoot
        || !(await this.isBookmarkInScope(latestBookmark, latestRootId, Boolean(job.externalRoot)))
        || !(await this.isValidSmartTarget(operation.toFolderId, latestRootId))) {
        await this.clearPendingOperation(operation.operationId);
        await this.skipJob(job.bookmark.id, '移动目标已不在智能书签目录内。');
        return;
      }
      if (latestState.settings.mode !== 'automatic' || confidence < latestState.settings.confidenceThreshold) {
        await this.clearPendingOperation(operation.operationId);
        await this.createReview(job, {
          action: 'move', targetFolderId,
          confidence,
          reason,
        }, source, await this.getFoldersWithinSmartRoot(latestRootId) ?? [], latestState.settings);
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
        pushUndoRecord(current, {
          bookmarkId: operation.bookmarkId,
          title: operation.title,
          fromFolderId: operation.fromFolderId,
          toFolderId: operation.toFolderId,
          movedAt: operation.movedAt,
          operationId: operation.operationId,
        });
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
      ...(job.scanId ? { scanId: job.scanId } : {}),
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
  private async refreshHistoricalScan(scanId: string): Promise<void> {
    await this.deps.store.update((state) => refreshHistoricalScan(state, scanId, this.now()));
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
      const rootId = await this.getSmartRootId();
      if (!rootId || !this.deps.bookmarks.isValidTargetFolder) {
        throw new Error('移动目标不在智能书签目录内。');
      }
      const toValid = await this.isValidSmartTarget(operation.toFolderId, rootId)
        || (operation.kind === 'undo' && await this.isExternalSourceFolder(operation.toFolderId));
      if (!toValid) {
        throw new Error('移动目标不在智能书签目录内。');
      }
      const fromValid = await this.isValidSourceFolder(operation.fromFolderId, rootId);
      if (!fromValid) {
        throw new Error('移动目标不在智能书签目录内。');
      }
      const bookmark = await this.deps.bookmarks.getBookmark(operation.bookmarkId);
      if (!bookmark || bookmark.parentId !== operation.fromFolderId
        || !(await this.isBookmarkInScope(bookmark, rootId, Boolean(operation.externalSource)))
          && !(await this.isExternalSourceFolder(bookmark.parentId))) {
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
    const rootId = initial.smartBookmarkRootId;
    const fromValid = await this.isValidSourceFolder(operation.fromFolderId, rootId!);
    const toValidForRecovery = await this.isValidSmartTarget(operation.toFolderId, rootId!)
      || (operation.kind === 'undo' && await this.isExternalSourceFolder(operation.toFolderId));
    const boundaryValid = Boolean(rootId && this.deps.bookmarks.isWithinRoot && this.deps.bookmarks.isValidTargetFolder)
      && fromValid
      && toValidForRecovery
      && Boolean(bookmark && (
        await this.isBookmarkInScope(bookmark, rootId!, Boolean(operation.externalSource))
        || await this.isExternalSourceFolder(bookmark.parentId)
      ));
    await this.deps.store.update((state) => {
      const pending = state.pendingOperation;
      if (!pending || pending.operationId !== operation.operationId) return;
      const job = state.jobs[pending.bookmarkId];
      const review = pending.reviewId ? state.reviews[pending.reviewId] : undefined;
      if (!boundaryValid) {
        if (review) review.status = 'stale';
        if (job) {
          job.status = 'skipped';
          job.lastError = '智能书签目录边界已变化，未覆盖当前状态。';
        }
      } else if (actualParent === pending.toFolderId) {
        if (pending.kind === 'automatic') {
          pushUndoRecord(state, {
            bookmarkId: pending.bookmarkId,
            title: pending.title,
            fromFolderId: pending.fromFolderId,
            toFolderId: pending.toFolderId,
            movedAt: pending.movedAt,
            operationId: pending.operationId,
          });
          appendActivity(state, {
            kind: 'moved', bookmarkId: pending.bookmarkId, title: pending.title,
            message: 'Service Worker 恢复时确认自动归档已完成。',
            fromFolderId: pending.fromFolderId, toFolderId: pending.toFolderId,
          }, this.now(), this.makeId);
        } else if (pending.kind === 'review' && review) {
          review.status = 'approved';
          if (pending.scanId) {
            const previous = state.lastHistoricalUndo?.scanId === pending.scanId
              ? state.lastHistoricalUndo
              : { scanId: pending.scanId, moved: [], createdAt: this.now() };
            if (!previous.moved.some((move) => move.operationId === pending.operationId)) {
              previous.moved.push({
                bookmarkId: pending.bookmarkId, title: pending.title,
                fromFolderId: pending.fromFolderId, toFolderId: pending.toFolderId,
                movedAt: pending.movedAt, operationId: pending.operationId,
              });
            }
            state.lastHistoricalUndo = previous;
          }
          appendActivity(state, {
            kind: 'review_approved', bookmarkId: pending.bookmarkId, title: pending.title,
            message: '确认的归档操作已完成。',
            fromFolderId: pending.fromFolderId, toFolderId: pending.toFolderId,
          }, this.now(), this.makeId);
        } else if (pending.kind === 'undo') {
          removeUndoRecord(state, pending.bookmarkId, pending.fromFolderId);
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
        if (pending.kind === 'undo') removeUndoRecord(state, pending.bookmarkId, pending.fromFolderId);
      }
      state.pendingOperation = undefined;
    });
  }

  private withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationChain.then(operation, operation);
    this.mutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  private async getSmartRootId(): Promise<string | null> {
    const rootId = (await this.deps.store.load()).smartBookmarkRootId;
    return rootId && this.deps.bookmarks.isWithinRoot && this.deps.bookmarks.isValidTargetFolder
      && this.deps.bookmarks.getFoldersWithinRoot ? rootId : null;
  }

  private async isWithinSmartRoot(nodeId: string, rootId: string): Promise<boolean> {
    if (!this.deps.bookmarks.isWithinRoot) return false;
    try {
      return await this.deps.bookmarks.isWithinRoot(nodeId, rootId);
    } catch {
      return false;
    }
  }

  private async isValidSmartTarget(folderId: string, rootId: string): Promise<boolean> {
    if (!this.deps.bookmarks.isValidTargetFolder) return false;
    try {
      return await this.deps.bookmarks.isValidTargetFolder(folderId, rootId);
    } catch {
      return false;
    }
  }

  private async isExternalSourceFolder(folderId: string | undefined): Promise<boolean> {
    if (!folderId || !this.deps.bookmarks.isEligibleRoot) return false;
    try {
      return await this.deps.bookmarks.isEligibleRoot(folderId);
    } catch {
      return false;
    }
  }

  /** Smart-root folders and (for external-root jobs) builtin roots are both valid sources. */
  private async isValidSourceFolder(folderId: string | undefined, rootId: string): Promise<boolean> {
    if (folderId && await this.isValidSmartTarget(folderId, rootId)) return true;
    return await this.isExternalSourceFolder(folderId);
  }

  private async isBookmarkInScope(
    bookmark: Pick<BookmarkNode, 'id' | 'parentId'>,
    rootId: string,
    externalRoot: boolean,
  ): Promise<boolean> {
    if (await this.isWithinSmartRoot(bookmark.id, rootId)) return true;
    return externalRoot && await this.isExternalSourceFolder(bookmark.parentId);
  }

  private async getFoldersWithinSmartRoot(rootId: string): Promise<FolderSummary[] | null> {
    if (!this.deps.bookmarks.getFoldersWithinRoot) return null;
    try {
      return await this.deps.bookmarks.getFoldersWithinRoot(rootId);
    } catch {
      return null;
    }
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

const MAX_UNDO_STACK = 10;

function pushUndoRecord(state: PersistedState, record: UndoRecord): void {
  state.undoStack = [...state.undoStack.filter((entry) => entry.operationId !== record.operationId), record]
    .slice(-MAX_UNDO_STACK);
  state.lastUndo = record;
}

const MAX_CORRECTIONS = 50;

function recordCorrection(
  state: PersistedState,
  url: string,
  entry: { action: CorrectionEntry['action']; folderId?: string },
  now: number,
): void {
  const domain = hostnameKey(url);
  state.corrections[domain] = { domain, ...entry, createdAt: now };
  const keys = Object.keys(state.corrections)
    .sort((a, b) => state.corrections[a]!.createdAt - state.corrections[b]!.createdAt);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CORRECTIONS))) delete state.corrections[key];
}

function removeUndoRecord(state: PersistedState, bookmarkId: string, originalToFolderId: string): void {
  state.undoStack = state.undoStack.filter((entry) =>
    !(entry.bookmarkId === bookmarkId && entry.toFolderId === originalToFolderId));
  state.lastUndo = state.undoStack[state.undoStack.length - 1];
}

function validResultTargets(classified: ClassifiedResult, folders: FolderSummary[]): boolean {
  const validFolder = (id: string) => folders.some((folder) => folder.id === id && folder.unmodifiable !== 'managed');
  const result = classified.result;
  if (result.action === 'move') return validFolder(result.targetFolderId);
  if (result.action === 'suggest_folder') return validFolder(result.suggestedFolder.parentId);
  return true;
}


function findNode(nodes: BookmarkNode[], id: string): BookmarkNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = node.children ? findNode(node.children, id) : null;
    if (found) return found;
  }
  return null;
}
