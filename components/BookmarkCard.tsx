import type { BookmarkJob, BookmarkMetadata } from '../types/domain';
import { Badge } from './ui/badge';
import type { BadgeTone } from './ui/badge';
import { Button } from './ui/button';
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

const statusTone: Record<BookmarkJob['status'], BadgeTone> = {
  queued: 'neutral',
  processing: 'primary',
  awaiting_configuration: 'warning',
  awaiting_permission: 'warning',
  pending_review: 'warning',
  completed: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

export function BookmarkCard({
  job,
  metadata,
  busy,
  onGenerate,
}: {
  job: BookmarkJob;
  metadata?: BookmarkMetadata;
  busy?: boolean;
  onGenerate?: () => void;
}) {
  const hostname = safeHostname(job.bookmark.url);
  return <Card className="border-slate-200/70 bg-slate-50/50 shadow-none dark:border-slate-800/70 dark:bg-slate-950/40">
    <CardContent className="space-y-2.5 p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            {job.bookmark.title || '(无标题)'}
          </p>
          <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{hostname}</p>
        </div>
        <Badge tone={statusTone[job.status]} className="shrink-0">{statusLabel[job.status]}</Badge>
      </div>
      {job.lastError && <p className="rounded-lg bg-rose-50/80 px-2.5 py-1.5 text-xs leading-5 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{job.lastError}</p>}
      {metadata && <div className="rounded-xl border border-slate-200/70 bg-white/80 p-2.5 text-xs leading-5 text-slate-600 dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-300">
        <p>{metadata.summary}</p>
        {metadata.tags.length > 0 && <div className="mt-1.5 flex flex-wrap gap-1">
          {metadata.tags.map((tag) => <span key={tag} className="rounded-md border border-violet-200/60 bg-violet-50/70 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 dark:border-violet-800/50 dark:bg-violet-950/50 dark:text-violet-300">#{tag}</span>)}
        </div>}
      </div>}
      {onGenerate && <div className="pt-0.5">
        <Button size="sm" variant="secondary" disabled={busy} onClick={onGenerate}>
          {busy ? '生成中…' : metadata ? '重新生成' : '生成摘要与标签'}
        </Button>
      </div>}
    </CardContent>
  </Card>;
}

function safeHostname(value: string): string {
  try { return new URL(value).hostname; } catch { return value; }
}
