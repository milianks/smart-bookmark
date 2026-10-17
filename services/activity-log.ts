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
