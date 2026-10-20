import { useCallback, useEffect, useState } from 'react';
import type { DashboardState } from '../types/domain';
import { sendMessage, unwrapResponse } from '../types/messages';
import { BookmarkCard } from './BookmarkCard';
import { RecentActivity, activityLabels } from './RecentActivity';
import { SettingsApp } from './SettingsApp';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent } from './ui/card';
import { Disclosure } from './ui/disclosure';
import { Notice } from './ui/notice';
import { Skeleton } from './ui/skeleton';
import { Stat } from './ui/stat';
import { Switch } from './ui/switch';

export function PopupApp() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [view, setView] = useState<'main' | 'settings'>('main');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanBusy, setScanBusy] = useState(false);
  const [metadataBusyId, setMetadataBusyId] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      setState(unwrapResponse<DashboardState>(await sendMessage({ type: 'state:get' })));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取扩展状态。');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    void sendMessage({ type: 'settings-draft:get' }).then((response) => {
      if (unwrapResponse<{ draft: unknown }>(response).draft) setView('settings');
    }).catch(() => undefined);
  }, []);

  async function toggleAutomation() {
    if (!state) return;
    setBusy(true);
    try {
      unwrapResponse(await sendMessage({ type: 'settings:update', settings: { enabled: !state.settings.enabled } }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '设置保存失败。');
    } finally { setBusy(false); }
  }

  async function undo() {
    setBusy(true);
    try {
      unwrapResponse(await sendMessage({ type: 'undo:last' }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '撤销失败。');
    } finally { setBusy(false); }
  }

  async function startScan() {
    setScanBusy(true);
    setError('');
    try {
      unwrapResponse(await sendMessage({ type: 'scan:start' }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '历史扫描启动失败。');
    } finally { setScanBusy(false); }
  }

  async function undoHistorical() {
    setScanBusy(true);
    try {
      unwrapResponse(await sendMessage({ type: 'undo:historical-last' }));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '历史批量撤销失败。');
    } finally { setScanBusy(false); }
  }
  async function generateMetadata(bookmarkId: string) {
    setMetadataBusyId(bookmarkId);
    setError('');
    setNotice('');
    try {
      unwrapResponse(await sendMessage({ type: 'bookmark:metadata:generate', bookmarkId }));
      setNotice('摘要与标签已生成。');
      await refresh();
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : '摘要标签生成失败。'); }
    finally { setMetadataBusyId(''); }
  }

  if (view === 'settings') return <SettingsApp embedded onBack={() => { setView('main'); void refresh(); }} />;

  if (!state) return <main className="w-[390px] space-y-4 p-4">
    {error ? <Notice tone="error">{error}</Notice> : <>
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-2xl" />
        <div className="flex-1 space-y-2"><Skeleton className="h-4 w-24" /><Skeleton className="h-3 w-36" /></div>
      </div>
      <Skeleton className="h-20" />
      <Skeleton className="h-24" />
      <Skeleton className="h-16" />
      <p role="status" className="sr-only">正在读取书签整理状态…</p>
    </>}
  </main>;

  const aiStatus = {
    configured: { label: 'AI 配置完成 · 未测试', tone: 'success' as const },
    'missing-key': { label: '需要配置 API Key', tone: 'warning' as const },
    'permission-needed': { label: '需要授予 API 权限', tone: 'warning' as const },
  }[state.aiStatus];

  const pendingCount = state.pendingReviews.length;
  const scan = state.historicalScan;
  const scanActive = scan?.status === 'scanning' || scan?.status === 'awaiting_review';
  const latestActivity = state.activities[0];
  const reviewUrl = chrome.runtime.getURL('/review.html');

  return <main className="w-[390px] space-y-4 p-4">
    <header className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <img src={chrome.runtime.getURL('/icon/128.png')} alt="" className="size-10 shrink-0 rounded-2xl" />
        <div className="min-w-0"><h1 className="truncate text-base font-semibold">智能书签</h1><p className="truncate text-xs text-slate-500 dark:text-slate-400">让收藏自动归位</p></div>
      </div>
      <Badge tone={aiStatus.tone} className="shrink-0 whitespace-nowrap">{aiStatus.label}</Badge>
    </header>

    <Card><CardContent className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold">自动整理</p>
        <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{state.settings.hasApiKey ? '新书签将优先复用现有分类' : '配置 API Key 后即可开始处理'}</p>
      </div>
      <Switch checked={state.settings.enabled} disabled={busy} label="自动整理开关" onCheckedChange={() => void toggleAutomation()} />
    </CardContent></Card>

    <Card><CardContent className="grid grid-cols-3 gap-2 p-3">
      <Stat
        label="待确认"
        value={pendingCount}
        hint={pendingCount > 0 ? '查看建议' : '暂无待办'}
        href={pendingCount > 0 ? reviewUrl : undefined}
        tone={pendingCount > 0 ? 'primary' : 'neutral'}
      />
      <Stat
        label="历史扫描"
        value={scan ? historicalStatusLabel(scan.status) : '未开始'}
        hint={scan ? `${scan.processedCount}/${scan.eligibleTotal} 已处理` : '先预览再确认'}
        tone={scanActive ? 'primary' : scan?.status === 'failed' ? 'warning' : 'neutral'}
      />
      <Stat
        label="最近结果"
        value={latestActivity ? activityLabels[latestActivity.kind] : '暂无记录'}
        hint={latestActivity ? latestActivity.title : '收藏网页后显示'}
      />
    </CardContent></Card>

    {error && <Notice tone="error">{error}</Notice>}
    {notice && <Notice tone="success">{notice}</Notice>}

    {(state.awaitingConfigurationCount > 0 || state.awaitingPermissionCount > 0) && <Card className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40">
      <CardContent className="space-y-1 text-sm leading-6 text-amber-900 dark:text-amber-200">
        {state.awaitingConfigurationCount > 0 && <p>{state.awaitingConfigurationCount} 条新书签等待配置 API Key。</p>}
        {state.awaitingPermissionCount > 0 && <p>{state.awaitingPermissionCount} 条新书签等待 AI 地址权限。</p>}
        <button type="button" onClick={() => setView('settings')} className="mt-1 rounded font-semibold underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-amber-50 dark:focus-visible:ring-offset-amber-950">前往设置</button>
      </CardContent>
    </Card>}

    <Card><CardContent>
      <Disclosure
        title="历史书签整理"
        description="扫描已有书签，全部先预览再确认"
        meta={<Badge tone={scanActive ? 'primary' : scan?.status === 'failed' ? 'danger' : 'neutral'}>{scan ? historicalStatusLabel(scan.status) : '未开始'}</Badge>}
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">扫描只生成预览，不会自动移动书签。</p>
            <Button size="sm" disabled={scanBusy || scanActive} onClick={() => void startScan()}>{scanBusy ? '处理中…' : scan?.status === 'scanning' ? '扫描中…' : scan?.status === 'awaiting_review' ? '等待确认' : '开始扫描'}</Button>
          </div>
          {scan && <div className="space-y-1 rounded-xl bg-slate-50 p-3 text-xs leading-5 text-slate-600 dark:bg-slate-950/50 dark:text-slate-300">
            <p>已处理 {scan.processedCount}/{scan.eligibleTotal}</p>
            <p>待确认 {scan.pendingReviewCount} · 失败 {scan.failedCount} · 跳过 {scan.skippedCount}</p>
            {scan.lastError && <p className="text-rose-600 dark:text-rose-400">{scan.lastError}</p>}
            <div className="flex flex-wrap gap-3 pt-1">
              {scan.pendingReviewCount > 0 && <a className="font-semibold text-violet-700 underline underline-offset-4 dark:text-violet-300" href={chrome.runtime.getURL(`/review.html?scan=${encodeURIComponent(scan.id)}`)}>查看历史建议 →</a>}
              {state.historicalUndoAvailable && <button type="button" disabled={scanBusy} onClick={() => void undoHistorical()} className="rounded font-semibold text-slate-700 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-50 dark:text-slate-300">撤销最近批量整理</button>}
            </div>
          </div>}
        </div>
      </Disclosure>
    </CardContent></Card>

    <Card><CardContent>
      <Disclosure title="最近书签" description="最近 3 条整理状态" meta={<Badge>{state.recentJobs.length}</Badge>}>
        <div className="space-y-3">
          <div className="flex justify-end"><Button variant="ghost" size="sm" onClick={() => void refresh()}>刷新</Button></div>
          {state.recentJobs.length === 0 ? <p className="py-4 text-sm text-slate-500 dark:text-slate-400">收藏网页后，整理状态会显示在这里。</p> : <div className="space-y-2">
            {state.recentJobs.slice(0, 3).map((job) => <BookmarkCard key={job.bookmark.id} job={job} metadata={job.metadata} busy={metadataBusyId === job.bookmark.id} onGenerate={() => void generateMetadata(job.bookmark.id)} />)}
          </div>}
        </div>
      </Disclosure>
    </CardContent></Card>

    <Card><CardContent>
      <Disclosure title="最近操作" meta={<Badge>{state.activities.length}</Badge>}>
        <RecentActivity activities={state.activities} />
      </Disclosure>
    </CardContent></Card>

    <footer className="flex items-center justify-between gap-2">
      {state.lastUndo ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void undo()}>撤销上次归档</Button> : <span className="text-xs text-slate-500 dark:text-slate-400">暂无可撤销操作</span>}
      <Button variant="ghost" size="sm" onClick={() => setView('settings')}>设置</Button>
    </footer>
  </main>;
}

function historicalStatusLabel(status: NonNullable<DashboardState['historicalScan']>['status']): string {
  return { idle: '未开始', scanning: '扫描中', awaiting_review: '等待确认', completed: '已完成', failed: '失败' }[status];
}
