import { useEffect, useMemo, useState } from 'react';
import type { DashboardState, ReviewItem } from '../types/domain';
import { sendMessage, unwrapResponse } from '../types/messages';
import { createLatestRefresh, subscribeDashboard } from './dashboard-subscription';
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

const backLinkClass = 'inline-flex cursor-pointer items-center gap-1 rounded-lg bg-slate-100/80 px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-violet-50 hover:text-violet-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:bg-slate-800/80 dark:text-slate-300 dark:hover:bg-violet-950/60 dark:hover:text-violet-300 dark:focus-visible:ring-offset-slate-950';

export function ReviewApp({ embedded = false, scanId: initialScanId, onBack }: {
  embedded?: boolean;
  scanId?: string;
  onBack?: () => void;
}) {
  const [state, setState] = useState<DashboardState | null>(null);
  const [selected, setSelected] = useState('');
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [metadataBusyId, setMetadataBusyId] = useState('');
  const [scanId, setScanId] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [overrideFolder, setOverrideFolder] = useState('');

  const [refresh] = useState(() => createLatestRefresh(
    async () => unwrapResponse<DashboardState>(await sendMessage({ type: 'state:get', view: 'review' })),
    setState,
    (reason) => setError(messageOf(reason)),
  ));

  useEffect(() => {
    const query = embedded ? new URLSearchParams() : new URLSearchParams(window.location.search);
    setSelected(query.get('item') ?? '');
    setScanId(initialScanId ?? query.get('scan') ?? '');
    void refresh().catch((reason: unknown) => setError(messageOf(reason)));
  }, [embedded, initialScanId, refresh]);

  useEffect(() => subscribeDashboard(refresh, (reason) => setError(messageOf(reason))), [refresh]);

  const items = useMemo(() => {
    const all = scanId ? (state?.historicalReviews ?? []) : (state?.pendingReviews ?? []);
    return scanId ? all.filter((item) => item.scanId === scanId) : all;
  }, [state, scanId]);
  const active = items.find((item) => item.id === selected) ?? items[0];
  useEffect(() => { setOverrideFolder(''); }, [active?.id]);
  const groups = useMemo(() => {
    const map = new Map<string, ReviewItem[]>();
    for (const item of items) {
      const key = groupKeyOf(item);
      const group = map.get(key);
      if (group) group.push(item);
      else map.set(key, [item]);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [items]);
  const pendingCount = items.filter((item) => item.status === 'pending').length;
  const canApproveAll = items.some((item) => item.scanId && item.status === 'pending');

  async function decide(item: ReviewItem, action: 'approve' | 'reject') {
    setBusyId(item.id);
    setError('');
    setNotice('');
    try {
      const response = await sendMessage(
        action === 'approve'
          ? { type: 'review:approve', id: item.id, ...(overrideFolder ? { overrideFolderId: overrideFolder } : {}) }
          : { type: 'review:reject', id: item.id },
      );
      unwrapResponse(response);
      setNotice(action === 'approve' ? '已按建议整理书签。' : '已保留书签原位。');
      if (action === 'approve') setOverrideFolder('');
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
      setNotice(`已加入后台审批队列 ${result.count} 条，进度会自动更新。`);
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

  async function approveGroup(group: ReviewItem[]) {
    setBatchBusy(true);
    setError('');
    let approved = 0;
    for (const item of group) {
      if (item.status !== 'pending') continue;
      try {
        unwrapResponse(await sendMessage({ type: 'review:approve', id: item.id }));
        approved += 1;
      } catch {
        // Stale or independently failed items do not block the group.
      }
    }
    setBatchBusy(false);
    setNotice(`本组已批准 ${approved} 条建议。`);
    await refresh().catch(() => undefined);
  }

  return <main className={embedded ? 'flex h-[580px] w-[390px] flex-col overflow-hidden p-4' : 'mx-auto w-full max-w-3xl space-y-5 px-5 py-8 sm:px-8 lg:px-10'} aria-busy={!state}>
    <header className={embedded ? 'shrink-0 pb-3' : undefined}>
      {embedded ? <button type="button" onClick={onBack} className={backLinkClass}>← 返回书签管理</button> : <a href={chrome.runtime.getURL('/popup.html')} className={backLinkClass}>← 返回书签管理</a>}
      <div className={cn('mt-3 flex flex-wrap items-start justify-between', embedded ? 'gap-3' : 'gap-4')}>
        <div className="min-w-0">
          <h1 className={cn('font-semibold tracking-tight text-slate-900 dark:text-slate-100', embedded ? 'text-base' : 'text-xl')}>待确认的整理</h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">确认后才会创建新目录或移动低置信度书签。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={pendingCount > 0 ? 'primary' : 'neutral'}>{pendingCount} 条待处理</Badge>
          {canApproveAll && <Button size="sm" disabled={batchBusy || state?.historicalApprovalPending} onClick={() => void approveAll()}>{state?.historicalApprovalPending ? '后台处理中…' : batchBusy ? '处理中…' : '批准当前全部'}</Button>}
          {state?.historicalUndoAvailable && <Button size="sm" variant="secondary" disabled={batchBusy || state?.historicalApprovalPending} onClick={() => void undoHistorical()}>撤销批量整理</Button>}
        </div>
      </div>
    </header>

    <div className={embedded ? 'scroll-region flex-1 space-y-4 overflow-y-auto overscroll-contain pr-0.5' : 'space-y-5'}>
    {state?.historicalApprovalPending && <Notice>后台正在审批，进度会自动更新。</Notice>}
    {notice && <Notice tone="success" className="text-sm">{notice}</Notice>}
    {error && <Notice tone="error" className="text-sm">{error}</Notice>}

    {!state ? <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Skeleton className="h-64" />
      <Skeleton className="h-96" />
      <p role="status" className="sr-only">正在读取建议…</p>
    </div> : items.length === 0 ? <Card>
      <CardContent className="p-8 text-center">
        <p className="font-medium text-slate-900 dark:text-slate-100">当前没有待确认的分类建议</p>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">新目录建议和需要确认的分类会显示在这里。</p>
      </CardContent>
    </Card> : <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Card className="h-fit min-w-0 lg:sticky lg:top-6">
        <CardHeader className="flex items-center justify-between gap-3">
          <h2 className={cn('font-semibold tracking-tight text-slate-900 dark:text-slate-100', embedded ? 'text-sm' : 'text-base')}>建议列表</h2>
          <Badge>{items.length}</Badge>
        </CardHeader>
        <div className={embedded ? 'scroll-region max-h-48 space-y-2 overflow-y-auto overscroll-contain p-2.5' : 'scroll-region flex gap-2 overflow-x-auto p-2.5 lg:block lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto lg:overscroll-contain'}>
          {groups.map(([label, group]) => <div key={label} className={cn('mb-2.5 last:mb-0', embedded ? 'w-full' : 'w-56 shrink-0 lg:w-full')}>
            <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
              <span className="min-w-0 truncate text-[11px] font-semibold tracking-tight text-slate-500 dark:text-slate-400" title={label}>{label} · {group.length}</span>
              {group.length > 1 && group.some((item) => item.status === 'pending') && <button type="button" disabled={batchBusy || state?.historicalApprovalPending} onClick={() => void approveGroup(group)} className="shrink-0 cursor-pointer rounded text-[11px] font-semibold text-violet-700 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-50 dark:text-violet-300">批准本组</button>}
            </div>
            {group.map((item) => <button
              key={item.id}
              type="button"
              aria-current={active?.id === item.id ? 'true' : undefined}
              onClick={() => setSelected(item.id)}
              className={cn(
                'mb-1.5 w-full cursor-pointer rounded-xl border p-3 text-left transition-all duration-150 last:mb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-950',
                active?.id === item.id
                  ? 'border-violet-200/90 bg-gradient-to-br from-violet-50/90 to-indigo-50/50 shadow-2xs dark:border-violet-800/70 dark:from-violet-950/60 dark:to-indigo-950/30'
                  : 'border-transparent hover:border-slate-200/70 hover:bg-slate-50/80 dark:hover:border-slate-800 dark:hover:bg-slate-800/60',
              )}
            >
              <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">{item.title}</span>
              <span className="mt-0.5 block truncate text-xs text-slate-500 dark:text-slate-400">{safeHostname(item.url)}</span>
              <span className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                <span aria-hidden="true" className={cn('size-1.5 rounded-full', statusDot[item.status])} />
                {reviewStatusLabel(item.status)}
              </span>
            </button>)}
          </div>)}
        </div>
      </Card>
      {active && <ReviewDetail compact={embedded} item={active} metadata={active.metadata} busy={busyId === active.id} metadataBusy={metadataBusyId === active.bookmarkId} folders={state.folders} overrideFolder={overrideFolder} onOverrideChange={setOverrideFolder} onGenerateMetadata={() => void generateMetadata(active.bookmarkId)} onApprove={() => void decide(active, 'approve')} onReject={() => void decide(active, 'reject')} />}
    </div>}
    </div>
  </main>;
}

function ReviewDetail({ compact, item, metadata, busy, metadataBusy, folders, overrideFolder, onOverrideChange, onGenerateMetadata, onApprove, onReject }: {
  compact: boolean;
  item: ReviewItem;
  metadata?: ReviewItem['metadata'];
  busy: boolean;
  metadataBusy: boolean;
  folders: Array<{ id: string; path: string }>;
  overrideFolder: string;
  onOverrideChange: (value: string) => void;
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
    <CardHeader className={cn('flex flex-wrap justify-between', compact ? 'flex-col items-stretch gap-2.5' : 'items-start gap-4')}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="primary">{sourceLabel}</Badge>
          {item.status !== 'pending' && <Badge tone={statusTone[item.status]}>{reviewStatusLabel(item.status)}</Badge>}
          {item.scanId && <Badge>历史扫描</Badge>}
        </div>
        <h2 className={cn('mt-2 break-words font-semibold tracking-tight text-slate-900 dark:text-slate-100', compact ? 'text-base' : 'text-lg')}>{item.title}</h2>
        <p className="mt-1 truncate text-xs text-slate-500 dark:text-slate-400">{safeHostname(item.url)}</p>
      </div>
      <div className={cn('rounded-xl border border-slate-200/70 bg-slate-50/70 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/50', compact ? 'w-full' : 'min-w-[8rem] shrink-0')}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">置信度</span>
          <span className="text-sm font-semibold text-violet-700 dark:text-violet-300">{confidence}%</span>
        </div>
        <div
          role="progressbar"
          aria-label="分类置信度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={confidence}
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800"
        >
          <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-500 transition-all duration-300" style={{ width: `${confidence}%` }} />
        </div>
      </div>
    </CardHeader>
    <CardContent className={compact ? 'space-y-3' : 'space-y-4'}>
      <div className="rounded-xl border border-slate-200/70 bg-slate-50/50 p-3 dark:border-slate-800/80 dark:bg-slate-950/40">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">网页地址</p>
        <a href={item.url} target="_blank" rel="noreferrer" className="mt-1 block break-all rounded text-xs font-medium text-violet-700 underline decoration-violet-200 underline-offset-4 transition-colors hover:text-violet-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-violet-300 dark:decoration-violet-800 dark:hover:text-violet-200 dark:focus-visible:ring-offset-slate-950">{item.url}</a>
      </div>
      {metadata && <div className="rounded-xl border border-emerald-200/80 bg-emerald-50/70 p-3.5 dark:border-emerald-900/70 dark:bg-emerald-950/30">
        <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">摘要与标签</p>
        <p className={cn('mt-1 text-sm text-slate-800 dark:text-slate-200', compact ? 'leading-5' : 'leading-6')}>{metadata.summary}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">{metadata.tags.map((tag) => <span key={tag} className="rounded-md border border-emerald-200/70 bg-white/90 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:border-emerald-800/60 dark:bg-slate-900 dark:text-emerald-300">#{tag}</span>)}</div>
      </div>}
      <div className="rounded-xl border border-violet-200/70 bg-gradient-to-br from-violet-50/60 to-indigo-50/30 p-3.5 dark:border-violet-900/50 dark:from-violet-950/40 dark:to-indigo-950/20">
        <p className="text-xs font-semibold text-violet-700 dark:text-violet-300">推荐操作</p>
        <p className="mt-1 break-words text-sm font-semibold text-slate-900 dark:text-slate-100">{recommendation}</p>
        <p className={cn('mt-1.5 text-xs text-slate-600 dark:text-slate-300', compact ? 'leading-5' : 'leading-6')}>{item.classification.reason}</p>
      </div>
      {item.status === 'pending' && folders.length > 0 && <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">
        改选目标文件夹
        <select
          value={overrideFolder}
          onChange={(event) => onOverrideChange(event.target.value)}
          className="mt-1.5 min-h-9 w-full rounded-xl border border-slate-200/90 bg-slate-50/50 px-3 py-1.5 text-sm text-slate-800 shadow-2xs outline-none transition-all focus:border-violet-500 focus:bg-white focus:ring-3 focus:ring-violet-500/15 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:border-violet-400"
        >
          <option value="">按上方推荐处理</option>
          {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
        </select>
      </label>}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        {item.status === 'pending' && (item.classification.action !== 'keep' || overrideFolder) && <Button size={compact ? 'sm' : 'md'} disabled={busy} onClick={onApprove}>{busy ? '正在处理…' : overrideFolder ? '移动到所选文件夹' : item.classification.action === 'suggest_folder' ? '创建文件夹并归档' : '移动到推荐文件夹'}</Button>}
        {item.status === 'pending' && <Button size={compact ? 'sm' : 'md'} variant="secondary" disabled={busy} onClick={onReject}>保留原位</Button>}
        <Button size={compact ? 'sm' : 'md'} variant="ghost" disabled={metadataBusy || busy} onClick={onGenerateMetadata}>{metadataBusy ? '生成中…' : metadata ? '重新生成摘要与标签' : '生成摘要与标签'}</Button>
      </div>
    </CardContent>
  </Card>;
}

function reviewStatusLabel(status: ReviewItem['status']): string {
  return { pending: '待确认', approving: '处理中', approved: '已批准', rejected: '已拒绝', stale: '已过期' }[status];
}

function groupKeyOf(item: ReviewItem): string {
  if (item.classification.action === 'move') {
    return item.targetFolderPath ?? `文件夹 ${item.classification.targetFolderId}`;
  }
  if (item.classification.action === 'suggest_folder') {
    return `新建：${item.classification.suggestedFolder.name}${item.parentFolderPath ? `（位于 ${item.parentFolderPath}）` : ''}`;
  }
  return '保留原位';
}

function safeHostname(value: string): string {
  try { return new URL(value).hostname; } catch { return value; }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : '操作失败，请稍后重试。';
}
