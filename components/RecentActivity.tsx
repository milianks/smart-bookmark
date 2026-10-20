import type { ActivityRecord } from '../types/domain';
import { Badge } from './ui/badge';
import type { BadgeTone } from './ui/badge';
import { TruncatedText } from './ui/truncated-text';

export const activityLabels: Record<ActivityRecord['kind'], string> = {
  received: '新书签',
  moved: '自动归档',
  review_created: '等待确认',
  review_approved: '已确认',
  review_rejected: '已保留',
  kept: '保留原位',
  failed: '处理失败',
  skipped: '跳过',
  undone: '已撤销',
};

const activityTone: Record<ActivityRecord['kind'], BadgeTone> = {
  received: 'primary',
  moved: 'success',
  review_created: 'warning',
  review_approved: 'success',
  review_rejected: 'neutral',
  kept: 'neutral',
  failed: 'danger',
  skipped: 'neutral',
  undone: 'neutral',
};

export function RecentActivity({ activities }: { activities: ActivityRecord[] }) {
  if (activities.length === 0) return <p className="py-4 text-sm text-slate-500 dark:text-slate-400">还没有操作记录。</p>;
  return <div className="divide-y divide-slate-100 dark:divide-slate-800">
    {activities.slice(0, 8).map((activity) => <div key={activity.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <Badge tone={activityTone[activity.kind]} className="w-[4.5rem] shrink-0 justify-center px-0">{activityLabels[activity.kind]}</Badge>
      <div className="min-w-0">
        <TruncatedText text={activity.title} className="truncate text-sm font-medium text-slate-800 dark:text-slate-200" />
        <TruncatedText text={activity.message} className="mt-0.5 truncate text-xs leading-5 text-slate-500 dark:text-slate-400" />
      </div>
    </div>)}
  </div>;
}
