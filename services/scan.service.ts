import { appendActivity } from './activity-log';
import {
  SMART_ARCHIVE_FOLDER_NAME,
  enumerateHistoricalBookmarksWithinRoot,
  type BookmarkPort,
  type HistoricalBookmarkCandidate,
} from './bookmark.service';
import type { StateRepository } from '../lib/storage/repository';
import { createId, normalizedUrl } from '../lib/utils/ids';
import { refreshHistoricalScan } from './scan-state';

export interface ScanServiceDependencies {
  bookmarks: BookmarkPort;
  store: StateRepository;
  processPending(): Promise<void>;
  approveReview(id: string): Promise<void>;
  scheduleApprovalResume(delayMs: number): Promise<void>;
  now?: () => number;
  makeId?: (prefix: string) => string;
}

export class ScanService {
  private starting = false;
  private approving = false;
  private readonly now: () => number;
  private readonly makeId: (prefix: string) => string;

  constructor(private readonly deps: ScanServiceDependencies) {
    this.now = deps.now ?? Date.now;
    this.makeId = deps.makeId ?? createId;
  }

  async startHistoricalScan(): Promise<{ scanId: string; eligibleTotal: number }> {
    if (this.starting) throw new Error('已有历史扫描正在启动，请稍后重试。');
    this.starting = true;
    try {
      const state = await this.deps.store.load();
      if (state.historicalScan && ['scanning', 'awaiting_review'].includes(state.historicalScan.status)) {
        throw new Error('已有历史扫描正在进行，请先处理当前扫描。');
      }
      const rootId = state.smartBookmarkRootId;
      const candidates = rootId
        ? enumerateHistoricalBookmarksWithinRoot(await this.deps.bookmarks.getTree(), rootId)
        : [];
      const existing = new Set<string>();
      for (const id of Object.keys(state.jobs)) existing.add(id);
      for (const id of Object.keys(state.reviews)) existing.add(id);
      const scanId = this.makeId('scan');
      const fresh = candidates.filter((candidate) => !existing.has(candidate.id));
      const duplicateOf = await this.markDuplicates(fresh, rootId);
      const now = this.now();
      const scan = {
        id: scanId, status: 'scanning' as const, startedAt: now, updatedAt: now,
        eligibleTotal: candidates.length, processedCount: 0, pendingReviewCount: 0,
        failedCount: 0, skippedCount: candidates.length - fresh.length,
        coveredIds: candidates.map((candidate) => candidate.id),
      };
      await this.deps.store.update((current) => {
        current.historicalScan = scan;
        for (const candidate of fresh) {
          current.jobs[candidate.id] = {
            bookmark: candidate,
            status: current.settings.apiKey.trim() ? 'queued' : 'awaiting_configuration',
            attempts: 0, createdAt: now, updatedAt: now, scanId,
            ...(duplicateOf.get(candidate.id) ? { duplicateOf: duplicateOf.get(candidate.id)! } : {}),
          };
        }
        appendActivity(current, {
          kind: 'received', title: '历史书签扫描', message: `已发现 ${candidates.length} 个可扫描书签。`,
        }, now, this.makeId);
      });
      if (state.settings.apiKey.trim()) await this.deps.processPending();
      await this.refresh(scanId);
      return { scanId, eligibleTotal: candidates.length };
    } finally {
      this.starting = false;
    }
  }

  async approveAllHistoricalReviews(scanId?: string): Promise<number> {
    let count = 0;
    await this.deps.store.update((state) => {
      if (state.historicalApproval) throw new Error('历史批量审批正在进行，请稍后重试。');
      const target = scanId ?? state.historicalScan?.id;
      if (!target) throw new Error('没有可处理的历史扫描。');
      const reviewIds = Object.values(state.reviews)
        .filter((item) => item.scanId === target && item.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((item) => item.id);
      count = reviewIds.length;
      if (count > 0) state.historicalApproval = { scanId: target, reviewIds };
    });
    if (count > 0) await this.deps.scheduleApprovalResume(1);
    return count;
  }

  async resumeApprovals(): Promise<void> {
    if (this.approving) return;
    this.approving = true;
    try {
      const initial = await this.deps.store.load();
      if (!initial.historicalApproval) return;
      // Arm recovery before moving anything; each item retains the organizer's WAL and lock.
      await this.deps.scheduleApprovalResume(30_000);
      const startedAt = this.now();
      for (let processed = 0; processed < 10 && this.now() - startedAt < 10_000; processed += 1) {
        const state = await this.deps.store.load();
        const queue = state.historicalApproval;
        const id = queue?.reviewIds[0];
        if (!queue || !id) break;
        const review = state.reviews[id];
        if (review?.scanId === queue.scanId && ['pending', 'approving'].includes(review.status)) {
          try {
            await this.deps.approveReview(id);
          } catch (error) {
            const latest = await this.deps.store.load();
            // Unreconciled work stays queued for the recovery alarm; settled failures can be retried manually.
            if (latest.pendingOperation?.reviewId === id || latest.reviews[id]?.status === 'approving') throw error;
          }
        }
        await this.deps.store.update((current) => {
          if (current.historicalApproval?.scanId !== queue.scanId) return;
          current.historicalApproval.reviewIds = current.historicalApproval.reviewIds.filter((item) => item !== id);
          if (current.historicalApproval.reviewIds.length === 0) delete current.historicalApproval;
          refreshHistoricalScan(current, queue.scanId, this.now());
        });
      }
      if ((await this.deps.store.load()).historicalApproval) await this.deps.scheduleApprovalResume(1);
    } finally {
      this.approving = false;
    }
  }

  async refresh(scanId: string): Promise<void> {
    await this.deps.store.update((state) => refreshHistoricalScan(state, scanId, this.now()));
  }

  private async markDuplicates(
    fresh: HistoricalBookmarkCandidate[],
    rootId: string | undefined,
  ): Promise<Map<string, string>> {
    if (!rootId || !this.deps.bookmarks.getFoldersWithinRoot) return new Map();
    try {
      const folders = await this.deps.bookmarks.getFoldersWithinRoot(rootId);
      if (!folders.some((folder) => folder.name === SMART_ARCHIVE_FOLDER_NAME)) return new Map();
      return groupDuplicateTargets(fresh);
    } catch {
      return new Map();
    }
  }
}

/** Map duplicate bookmark id -> kept bookmark id by normalized URL; keeps the oldest add date. */
export function groupDuplicateTargets(candidates: HistoricalBookmarkCandidate[]): Map<string, string> {
  const groups = new Map<string, HistoricalBookmarkCandidate[]>();
  for (const candidate of candidates) {
    const key = safeNormalizedUrl(candidate.url);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }
  const duplicateOf = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) =>
      (a.dateAdded ?? Number.MAX_SAFE_INTEGER) - (b.dateAdded ?? Number.MAX_SAFE_INTEGER));
    const kept = sorted[0]!;
    for (const duplicate of sorted.slice(1)) duplicateOf.set(duplicate.id, kept.id);
  }
  return duplicateOf;
}

function safeNormalizedUrl(rawUrl: string): string {
  try {
    return normalizedUrl(rawUrl);
  } catch {
    return '';
  }
}
