import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DashboardState, ReviewItem } from '../types/domain';
import { sendMessage, unwrapResponse } from '../types/messages';
import { cn } from '../lib/utils/cn';
import { Badge } from './ui/badge';
import type { BadgeTone } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';
import { Notice } from './ui/notice';
import { Skeleton } from './ui/skeleton';

const statusTone: Record<ReviewItem['status'], BadgeTone> = {
  pending: 'warning',
  approving: 'primary',
  approved: 'success',
  rejected: 'neutral',
  stale: 'neutral',
};

const statusDot: Record<ReviewItem['status'], string> = {
  pending: 'bg-amber-500',
  approving: 'bg-violet-500',
  approved: 'bg-emerald-500',
  rejected: 'bg-slate-400',
  stale: 'bg-slate-400',
};

export function ReviewApp() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [selected, setSelected] = useState('');
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [metadataBusyId, setMetadataBusyId] = useState('');
  const [scanId, setScanId] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);

  const refresh = useCallback(async () => {
    const response = await sendMessage({ type: 'state:get' });
    setState(unwrapResponse<DashboardState>(response));
  }, []);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setSelected(query.get('item') ?? '');
    setScanId(query.get('scan') ?? '');
    void refresh().catch((reason: unknown) => setError(messageOf(reason)));
  }, [refresh]);

  const items = useMemo(() => {
    const all = scanId ? (state?.historicalReviews ?? []) : (state?.pendingReviews ?? []);
    return scanId ? all.filter((item) => item.scanId === scanId) : all;
  }, [state, scanId]);
  const active = items.find((item) => item.id === selected) ?? items[0];
  const pendingCount = items.filter((item) => item.status === 'pending').length;
  const canApproveAll = items.some((item) => item.scanId && item.status === 'pending');

  async function decide(item: ReviewItem, action: 'approve' | 'reject') {
    setBusyId(item.id);
    setError('');
    setNotice('');
    try {
      const response = await sendMessage({ type: action === 'approve' ? 'review:approve' : 'review:reject', id: item.id });
      unwrapResponse(response);
      setNotice(action === 'approve' ? '已按建议整理书签。' : '已保留书签原位。');
      await refresh();
    } catch (reason) {
      setError(messageOf(reason));
      await refresh().catch(() => undefined);
    } finally {
      setBusyId('');
    }
  }

  async function approveAll() {
    setBatchBusy(true);
    setError('');
    try {
      const response = await sendMessage({ type: 'scan:approve-all', ...(scanId ? { scanId } : {}) });
      const result = unwrapResponse<{ approved: true; count: number }>(response);
      setNotice(`已处理 ${result.count} 条有效建议。`);
      await refresh();
    } catch (reason) {
      setError(messageOf(reason));
    } finally { setBatchBusy(false); }
  }

  async function undoHistorical() {
    setBatchBusy(true);
    try {
      unwrapResponse(await sendMessage({ type: 'undo:historical-last' }));
      setNotice('已撤销最近历史批量整理。');
      await refresh();
    } catch (reason) { setError(messageOf(reason)); }
    finally { setBatchBusy(false); }
  }
  async function generateMetadata(bookmarkId: string) {
    setMetadataBusyId(bookmarkId);
    setError('');
    try { unwrapResponse(await sendMessage({ type: 'bookmark:metadata:generate', bookmarkId })); setNotice('摘要与标签已生成。'); await refresh(); }
    catch (reason) { setError(messageOf(reason)); }
    finally { setMetadataBusyId(''); }
  }

  return <main className="mx-auto w-full max-w-5xl space-y-4 px-5 py-7 sm:px-8 lg:px-10" aria-busy={!state}>
    <header>
      <a href={chrome.runtime.getURL('/popup.html')} className="inline-flex rounded text-xs font-medium text-violet-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:text-violet-300 dark:focus-visible:ring-offset-slate-950">← 返回书签管理</a>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">待确认的整理</h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">确认后才会创建新目录或移动低置信度书签。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={pendingCount > 0 ? 'primary' : 'neutral'}>{pendingCount} 条待处理</Badge>
          {canApproveAll && <Button size="sm" disabled={batchBusy} onClick={() => void approveAll()}>{batchBusy ? '处理中…' : '批准当前全部'}</Button>}
          {state?.historicalUndoAvailable && <Button size="sm" variant="secondary" disabled={batchBusy} onClick={() => void undoHistorical()}>撤销批量整理</Button>}
        </div>
      </div>
    </header>

    {notice && <Notice tone="success" className="text-sm">{notice}</Notice>}
    {error && <Notice tone="error" className="text-sm">{error}</Notice>}

    {!state ? <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Skeleton className="h-64" />
      <Skeleton className="h-96" />
      <p role="status" className="sr-only">正在读取建议…</p>
    </div> : items.length === 0 ? <Card>
      <CardContent className="p-8 text-center">
        <p className="font-medium">当前没有待确认的分类建议</p>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">新目录建议和需要确认的分类会显示在这里。</p>
      </CardContent>
    </Card> : <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Card className="h-fit min-w-0 lg:sticky lg:top-6">
        <CardHeader className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">建议列表</h2>
          <Badge>{items.length}</Badge>
        </CardHeader>
        <div className="flex gap-2 overflow-x-auto p-2 lg:block">
          {items.map((item) => <button
            key={item.id}
            type="button"
            aria-current={active?.id === item.id ? 'true' : undefined}
            onClick={() => setSelected(item.id)}
            className={cn(
              'mb-1 w-56 shrink-0 rounded-xl border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white lg:w-full dark:focus-visible:ring-offset-slate-950',
              active?.id === item.id
                ? 'border-violet-200 bg-violet-50 dark:border-violet-800 dark:bg-violet-950/50'
                : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-800',
            )}
          >
            <span className="block truncate text-sm font-medium">{item.title}</span>
            <span className="mt-1 block truncate text-xs text-slate-500 dark:text-slate-400">{safeHostname(item.url)}</span>
            <span className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              <span aria-hidden="true" className={cn('size-1.5 rounded-full', statusDot[item.status])} />
              {reviewStatusLabel(item.status)}
            </span>
          </button>)}
        </div>
      </Card>
      {active && <ReviewDetail item={active} metadata={active.metadata} busy={busyId === active.id} metadataBusy={metadataBusyId === active.bookmarkId} onGenerateMetadata={() => void generateMetadata(active.bookmarkId)} onApprove={() => void decide(active, 'approve')} onReject={() => void decide(active, 'reject')} />}
    </div>}
  </main>;
}

function ReviewDetail({ item, metadata, busy, metadataBusy, onGenerateMetadata, onApprove, onReject }: {
  item: ReviewItem;
  metadata?: ReviewItem['metadata'];
  busy: boolean;
  metadataBusy: boolean;
  onGenerateMetadata: () => void;
  onApprove: () => void;
  onReject: () => void;
}) {
  const recommendation = item.classification.action === 'move'
    ? `移动到：${item.targetFolderPath ?? item.classification.targetFolderId}`
    : item.classification.action === 'suggest_folder'
      ? `创建文件夹：${item.classification.suggestedFolder.name} · ${item.parentFolderPath ?? item.classification.suggestedFolder.parentId}`
      : '保留在当前位置';
  const sourceLabel = { cache: '本地缓存', rule: '本地规则', ai: 'AI 建议' }[item.source];
  const confidence = Math.round(item.classification.confidence * 100);

  return <Card className="min-w-0">
    <CardHeader className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="primary">{sourceLabel}</Badge>
          {item.status !== 'pending' && <Badge tone={statusTone[item.status]}>{reviewStatusLabel(item.status)}</Badge>}
          {item.scanId && <Badge>历史扫描</Badge>}
        </div>
        <h2 className="mt-2 break-words text-lg font-semibold">{item.title}</h2>
        <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{safeHostname(item.url)}</p>
      </div>
      <div className="min-w-[7rem] shrink-0">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-slate-500 dark:text-slate-400">置信度</span>
          <span className="text-sm font-semibold">{confidence}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="分类置信度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={confidence}
          className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
        >
          <div className="h-full rounded-full bg-violet-600" style={{ width: `${confidence}%` }} />
        </div>
      </div>
    </CardHeader>
    <CardContent className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">网页地址</p>
        <a href={item.url} target="_blank" rel="noreferrer" className="mt-1 block break-all rounded text-sm text-violet-700 underline decoration-violet-200 underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-violet-300 dark:decoration-violet-800 dark:focus-visible:ring-offset-slate-950">{item.url}</a>
      </div>
      {metadata && <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3 dark:border-emerald-900 dark:bg-emerald-950/30">
        <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300">摘要与标签</p>
        <p className="mt-1 text-sm leading-6 text-slate-800 dark:text-slate-200">{metadata.summary}</p>
        <div className="mt-2 flex flex-wrap gap-1">{metadata.tags.map((tag) => <span key={tag} className="rounded bg-white px-1.5 py-0.5 text-xs text-slate-600 dark:bg-slate-900 dark:text-slate-300">#{tag}</span>)}</div>
      </div>}
      <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950">
        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">推荐操作</p>
        <p className="mt-1 break-words text-sm font-semibold">{recommendation}</p>
        <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{item.classification.reason}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {item.status === 'pending' && item.classification.action !== 'keep' && <Button disabled={busy} onClick={onApprove}>{busy ? '正在处理…' : item.classification.action === 'suggest_folder' ? '创建文件夹并归档' : '移动到推荐文件夹'}</Button>}
        {item.status === 'pending' && <Button variant="secondary" disabled={busy} onClick={onReject}>保留原位</Button>}
        <Button variant="ghost" disabled={metadataBusy || busy} onClick={onGenerateMetadata}>{metadataBusy ? '生成中…' : metadata ? '重新生成摘要与标签' : '生成摘要与标签'}</Button>
      </div>
    </CardContent>
  </Card>;
}

function reviewStatusLabel(status: ReviewItem['status']): string {
  return { pending: '待确认', approving: '处理中', approved: '已批准', rejected: '已拒绝', stale: '已过期' }[status];
}

function safeHostname(value: string): string {
  try { return new URL(value).hostname; } catch { return value; }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : '操作失败，请稍后重试。';
}
