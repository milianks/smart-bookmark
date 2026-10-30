import type { BookmarkJob, DashboardState, HistoricalScanState, PersistedState } from '../types/domain';

export function refreshHistoricalScan(state: PersistedState, scanId: string, now: number): void {
  const scan = state.historicalScan;
  if (!scan || scan.id !== scanId) return;
  const jobs = scan.coveredIds.map((id) => state.jobs[id]).filter((job) => job?.scanId === scanId) as BookmarkJob[];
  const reviews = Object.values(state.reviews).filter((item) => item.scanId === scanId);
  // Completed totals outlive pruned job/review records; only reopened work changes them.
  if (['completed', 'failed'].includes(scan.status)
    && !jobs.some((job) => ['queued', 'processing', 'awaiting_configuration', 'awaiting_permission', 'pending_review'].includes(job.status))
    && !reviews.some((item) => item.status === 'pending' || item.status === 'approving')) return;
  const scanJobIds = new Set(jobs.map((job) => job.bookmark.id));
  const scanReviewIds = new Set(reviews.map((item) => item.bookmarkId));
  const alreadyCovered = scan.coveredIds.filter((id) => !scanJobIds.has(id) && !scanReviewIds.has(id)).length;
  const orphanReviews = reviews.filter((item) => scan.coveredIds.includes(item.bookmarkId) && !scanJobIds.has(item.bookmarkId));
  scan.processedCount = alreadyCovered + jobs.filter((job) => ['completed', 'failed', 'skipped', 'pending_review'].includes(job.status)).length
    + new Set(orphanReviews.map((item) => item.bookmarkId)).size;
  scan.pendingReviewCount = reviews.filter((item) => item.status === 'pending' || item.status === 'approving').length;
  scan.failedCount = jobs.filter((job) => job.status === 'failed').length;
  scan.skippedCount = alreadyCovered + jobs.filter((job) => job.status === 'skipped').length
    + new Set(orphanReviews.filter((item) => item.status === 'stale').map((item) => item.bookmarkId)).size;
  scan.updatedAt = now;
  const queued = jobs.some((job) => ['queued', 'processing', 'awaiting_configuration', 'awaiting_permission'].includes(job.status));
  if (queued) scan.status = 'scanning';
  else if (scan.pendingReviewCount > 0) scan.status = 'awaiting_review';
  else if (scan.processedCount >= scan.eligibleTotal) scan.status = scan.failedCount > 0 ? 'failed' : 'completed';
}

export function historicalScanSummary(
  scan: HistoricalScanState,
  hasUndo: boolean,
): DashboardState['historicalScan'] {
  const { coveredIds: _coveredIds, ...summary } = scan;
  return { ...summary, hasUndo };
}
