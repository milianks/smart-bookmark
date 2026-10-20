import type { BookmarkJob, BookmarkMetadata } from '../types/domain';
import { Badge } from './ui/badge';
import type { BadgeTone } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';

const statusLabel: Record<BookmarkJob['status'], string> = {
  queued: '排队中', processing: '整理中', awaiting_configuration: '等待 API Key', awaiting_permission: '等待网络权限', pending_review: '待确认', completed: '已处理', failed: '未完成', skipped: '保留原位',
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

export function BookmarkCard({ job, metadata, busy, onGenerate }: { job: BookmarkJob; metadata?: BookmarkMetadata; busy?: boolean; onGenerate?: () => void }) {
  const hostname = safeHostname(job.bookmark.url);
  return <Card><CardContent className="flex items-start justify-between gap-3">
    <div className="min-w-0">
      <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{job.bookmark.title || '(无标题)'}</p>
      <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{hostname}</p>
      {job.lastError && <p className="mt-2 text-xs leading-5 text-rose-600 dark:text-rose-400">{job.lastError}</p>}
      {metadata && <div className="mt-2 text-xs leading-5 text-slate-600 dark:text-slate-300"><p>{metadata.summary}</p><div className="mt-1 flex flex-wrap gap-1">{metadata.tags.map((tag) => <span key={tag} className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">#{tag}</span>)}</div></div>}
      {onGenerate && <Button size="sm" variant="secondary" className="mt-2" disabled={busy} onClick={onGenerate}>{busy ? '生成中…' : metadata ? '重新生成' : '生成摘要与标签'}</Button>}
    </div>
    <Badge tone={statusTone[job.status]}>{statusLabel[job.status]}</Badge>
  </CardContent></Card>;
}

function safeHostname(value: string): string {
  try { return new URL(value).hostname; } catch { return value; }
}
