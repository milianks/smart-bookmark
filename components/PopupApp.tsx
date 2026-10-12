import { useCallback, useEffect, useState } from 'react';
import type { DashboardState } from '../types/domain';
import { sendMessage, unwrapResponse } from '../types/messages';
import { BookmarkCard } from './BookmarkCard';
import { RecentActivity } from './RecentActivity';
import { SettingsApp } from './SettingsApp';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';

export function PopupApp() {
  const [state, setState] = useState<DashboardState | null>(null);
  const [view, setView] = useState<'main' | 'settings'>('main');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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

  if (view === 'settings') return <SettingsApp embedded onBack={() => { setView('main'); void refresh(); }} />;
  if (!state) return <main className="w-[390px] p-5"><p className="text-sm text-slate-500">{error || '正在读取书签整理状态…'}</p></main>;

  const aiStatus = {
    configured: { label: 'AI 配置完成 · 未测试', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' },
    'missing-key': { label: '需要配置 API Key', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
    'permission-needed': { label: '需要授予 API 权限', cls: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300' },
  }[state.aiStatus];

  return <main className="w-[390px] space-y-4 p-4">
    <header className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3"><img src={chrome.runtime.getURL('/icon/128.png')} alt="" className="size-10 rounded-2xl" /><div><h1 className="text-base font-semibold">智能书签</h1><p className="text-xs text-slate-500 dark:text-slate-400">让收藏自动归位</p></div></div>
      <Badge className={aiStatus.cls}>{aiStatus.label}</Badge>
    </header>
    <Card><CardContent className="flex items-center justify-between gap-3 p-4"><div><p className="text-sm font-semibold">自动整理</p><p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{state.settings.hasApiKey ? '新书签将优先复用现有分类' : '配置 API Key 后即可开始处理'}</p></div><button type="button" role="switch" aria-checked={state.settings.enabled} aria-label="自动整理开关" disabled={busy} onClick={() => void toggleAutomation()} className={`relative h-7 w-12 rounded-full ${state.settings.enabled ? 'bg-violet-600' : 'bg-slate-300 dark:bg-slate-700'}`}><span className={`absolute top-1 size-5 rounded-full bg-white shadow ${state.settings.enabled ? 'left-6' : 'left-1'}`} /></button></CardContent></Card>
    {error && <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>}
    {(state.awaitingConfigurationCount > 0 || state.awaitingPermissionCount > 0) && <Card className="border-amber-200 bg-amber-50"><CardContent className="p-4 text-sm leading-6 text-amber-900">{state.awaitingConfigurationCount > 0 && <p>{state.awaitingConfigurationCount} 条新书签等待配置 API Key。</p>}{state.awaitingPermissionCount > 0 && <p>{state.awaitingPermissionCount} 条新书签等待 AI 地址权限。</p>}<button type="button" className="mt-2 font-semibold underline" onClick={() => setView('settings')}>前往设置</button></CardContent></Card>}
    <Card><CardHeader className="flex items-center justify-between py-3"><div><h2 className="text-sm font-semibold">待确认</h2><p className="text-xs text-slate-500">新目录与低置信度建议</p></div><Badge>{state.pendingReviews.length}</Badge></CardHeader><CardContent className="p-4">{state.pendingReviews.length > 0 ? <a className="flex justify-between rounded-xl bg-violet-50 px-3 py-3 text-sm font-medium text-violet-700" href={chrome.runtime.getURL('/review.html')}>查看分类建议 <span aria-hidden="true">→</span></a> : <p className="text-sm text-slate-500">目前没有需要确认的整理。</p>}</CardContent></Card>
    <section className="space-y-2"><div className="flex items-center justify-between px-1"><h2 className="text-sm font-semibold">最近书签</h2><button type="button" onClick={() => void refresh()} className="text-xs text-violet-700">刷新</button></div>{state.recentJobs.length === 0 ? <Card><CardContent className="p-4 text-sm text-slate-500">收藏网页后，整理状态会显示在这里。</CardContent></Card> : state.recentJobs.slice(0, 3).map((job) => <BookmarkCard key={job.bookmark.id} job={job} />)}</section>
    <Card><CardHeader className="py-3"><h2 className="text-sm font-semibold">最近操作</h2></CardHeader><CardContent className="p-4"><RecentActivity activities={state.activities} /></CardContent></Card>
    <footer className="flex items-center justify-between gap-2">{state.lastUndo ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => void undo()}>撤销上次归档</Button> : <span className="text-xs text-slate-400">暂无可撤销操作</span>}<button type="button" className="rounded-lg px-3 py-2 text-xs font-medium text-slate-600" onClick={() => setView('settings')}>设置</button></footer>
  </main>;
}
