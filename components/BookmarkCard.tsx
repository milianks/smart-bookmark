import type { BookmarkJob } from '../types/domain';
import { Badge } from './ui/badge';
import { Card, CardContent } from './ui/card';

const statusLabel: Record<BookmarkJob['status'], string> = {
  queued: '排队中',
  processing: '整理中',
  awaiting_configuration: '等待 API Key',
  awaiting_permission: '等待网络权限',
  pending_review: '待确认',
  completed: '已处理',
  failed: '未完成',
  skipped: '保留原位',
};

export function BookmarkCard({ job }: { job: BookmarkJob }) {
  const hostname = safeHostname(job.bookmark.url);
  return <Card>
    <CardContent className="flex items-start justify-between gap-3 p-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{job.bookmark.title || '(无标题)'}</p>
        <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{hostname}</p>
        {job.lastError && <p className="mt-2 text-xs leading-5 text-rose-600 dark:text-rose-400">{job.lastError}</p>}
      </div>
      <Badge className={job.status === 'failed' ? 'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300' : ''}>
        {statusLabel[job.status]}
      </Badge>
    </CardContent>
  </Card>;
}

function safeHostname(value: string): string {
  try { return new URL(value).hostname; } catch { return value; }
}
