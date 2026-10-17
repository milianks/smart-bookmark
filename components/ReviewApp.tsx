import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DashboardState, ReviewItem } from '../types/domain';
import { sendMessage, unwrapResponse } from '../types/messages';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';

export function ReviewApp() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [selected, setSelected] = useState('');
  const [busyId, setBusyId] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
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

  return <main className="mx-auto max-w-5xl space-y-6 px-5 py-8 sm:px-8">
    <header>
      <a href={chrome.runtime.getURL('/popup.html')} className="text-xs font-medium text-violet-700 dark:text-violet-300">← 返回书签管理</a>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl font-semibold tracking-tight">待确认的整理</h1><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">确认后才会创建新目录或移动低置信度书签。</p></div>
        <div className="flex items-center gap-2"><Badge>{items.filter((item) => item.status === 'pending').length} 条待处理</Badge>{items.some((item) => item.scanId && item.status === 'pending') && <Button size="sm" disabled={batchBusy} onClick={() => void approveAll()}>{batchBusy ? '处理中…' : '批准当前全部'}</Button>}{state?.historicalUndoAvailable && <Button size="sm" variant="secondary" disabled={batchBusy} onClick={() => void undoHistorical()}>撤销批量整理</Button>}</div>
      </div>
    </header>
    {notice && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200">{notice}</p>}
    {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200">{error}</p>}

    {!state ? <p className="text-sm text-slate-500">正在读取建议…</p> : items.length === 0 ? <Card><CardContent className="p-8 text-center"><p className="font-medium">当前没有待确认的分类建议</p><p className="mt-2 text-sm text-slate-500">新目录建议和需要确认的分类会显示在这里。</p></CardContent></Card> : <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
      <Card className="h-fit">
        <CardHeader><h2 className="text-sm font-semibold">建议列表</h2></CardHeader>
        <div className="p-2">
          {items.map((item) => <button key={item.id} onClick={() => setSelected(item.id)} className={`mb-1 w-full rounded-xl p-3 text-left transition ${active?.id === item.id ? 'bg-violet-50 dark:bg-violet-950/50' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
            <span className="block truncate text-sm font-medium">{item.title}</span>
            <span className="mt-1 block truncate text-xs text-slate-500">{safeHostname(item.url)}</span>
          </button>)}
        </div>
      </Card>
      {active && <ReviewDetail item={active} busy={busyId === active.id} onApprove={() => void decide(active, 'approve')} onReject={() => void decide(active, 'reject')} />}
    </div>}
  </main>;
}

function ReviewDetail({ item, busy, onApprove, onReject }: {
  item: ReviewItem;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const recommendation = item.classification.action === 'move'
    ? `移动到：${item.targetFolderPath ?? item.classification.targetFolderId}`
    : item.classification.action === 'suggest_folder'
      ? `创建文件夹：${item.classification.suggestedFolder.name} · ${item.parentFolderPath ?? item.classification.suggestedFolder.parentId}`
      : '保留在当前位置';
  const sourceLabel = { cache: '本地缓存', rule: '本地规则', ai: 'AI 建议' }[item.source];
  return <Card>
    <CardHeader className="flex flex-wrap items-start justify-between gap-3"><div><Badge className="bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300">{sourceLabel}</Badge><h2 className="mt-3 text-lg font-semibold">{item.title}</h2></div><span className="text-sm text-slate-500">置信度 {(item.classification.confidence * 100).toFixed(0)}%</span></CardHeader>
    <CardContent className="space-y-5">
      <div><p className="text-xs font-medium uppercase tracking-wide text-slate-500">网页地址</p><a href={item.url} target="_blank" rel="noreferrer" className="mt-1 block break-all text-sm text-violet-700 underline decoration-violet-200 underline-offset-4 dark:text-violet-300">{item.url}</a></div>
      <div className="rounded-2xl bg-slate-50 p-4 dark:bg-slate-950"><p className="text-xs font-medium text-slate-500">推荐操作</p><p className="mt-1 text-sm font-semibold">{recommendation}</p><p className="mt-3 text-sm leading-6 text-slate-600 dark:text-slate-300">{item.classification.reason}</p></div>
      <p className="text-xs leading-5 text-slate-500">只有点击确认后才会执行目录创建或移动。拒绝后书签保持当前所在位置。</p>
      <div className="flex flex-wrap gap-2">
        {item.status !== 'pending' && <Badge className="bg-slate-100 text-slate-600">{reviewStatusLabel(item.status)}</Badge>}
        {item.status === 'pending' && item.classification.action !== 'keep' && <Button disabled={busy} onClick={onApprove}>{busy ? '正在处理…' : item.classification.action === 'suggest_folder' ? '创建文件夹并归档' : '移动到推荐文件夹'}</Button>}
        {item.status === 'pending' && <Button variant="secondary" disabled={busy} onClick={onReject}>保留原位</Button>}
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
