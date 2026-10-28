import type { ActivityRecord, PersistedState } from '../types/domain';

export function appendActivity(
  state: PersistedState,
  activity: Omit<ActivityRecord, 'id' | 'at'>,
  at: number,
  makeId: (prefix: string) => string,
): void {
  state.activities.push({ ...activity, id: makeId('activity'), at });
  state.activities = state.activities.slice(-100);
}

export function pruneJobs(state: PersistedState): void {
  const openReviewIds = new Set(Object.values(state.reviews)
    .filter((review) => review.status === 'pending' || review.status === 'approving')
    .map((review) => review.bookmarkId));
  const ids = Object.values(state.jobs)
    .filter((job) => ['completed', 'failed', 'skipped'].includes(job.status) && !openReviewIds.has(job.bookmark.id))
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, Math.max(0, Object.keys(state.jobs).length - 250))
    .map((job) => job.bookmark.id);
  for (const id of ids) delete state.jobs[id];
}
