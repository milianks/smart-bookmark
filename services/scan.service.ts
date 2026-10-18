import { appendActivity } from './activity-log';
import { enumerateHistoricalBookmarksWithinRoot, type BookmarkPort } from './bookmark.service';
import type { StateRepository } from '../lib/storage/repository';
import { createId } from '../lib/utils/ids';
import { refreshHistoricalScan } from './scan-state';

export interface ScanServiceDependencies {
  bookmarks: BookmarkPort;
  store: StateRepository;
  processPending(): Promise<void>;
  approveReview(id: string): Promise<void>;
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
      const now = this.now();
      const scan = {
        id: scanId, status: 'scanning' as const, startedAt: now, updatedAt: now,
        eligibleTotal: candidates.length, processedCount: 0, pendingReviewCount: 0,
        failedCount: 0, skippedCount: candidates.length - fresh.length,
        coveredIds: candidates.map((candidate) => candidate.id), forceOrganize: false,
      };
      await this.deps.store.update((current) => {
        current.historicalScan = scan;
        for (const candidate of fresh) {
          current.jobs[candidate.id] = {
            bookmark: candidate,
            status: current.settings.apiKey.trim() ? 'queued' : 'awaiting_configuration',
            attempts: 0, createdAt: now, updatedAt: now, scanId,
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
    if (this.approving) throw new Error('历史批量审批正在进行，请稍后重试。');
    this.approving = true;
    try {
      const state = await this.deps.store.load();
      const target = scanId ?? state.historicalScan?.id;
      if (!target) throw new Error('没有可处理的历史扫描。');
      const ids = Object.values(state.reviews)
        .filter((item) => item.scanId === target && item.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((item) => item.id);
      let count = 0;
      for (const id of ids) {
        try {
          await this.deps.approveReview(id);
          count += 1;
        } catch {
          // Each item is independently revalidated; stale or failed items do not block the batch.
        }
      }
      await this.refresh(target);
      return count;
    } finally {
      this.approving = false;
    }
  }

  async refresh(scanId: string): Promise<void> {
    await this.deps.store.update((state) => refreshHistoricalScan(state, scanId, this.now()));
  }
}
