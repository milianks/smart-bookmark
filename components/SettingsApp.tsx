import { useCallback, useEffect, useState } from 'react';
import type { DashboardState, PublicSettings } from '../types/domain';
import { sendMessage, unwrapResponse } from '../types/messages';
import { normalizeBaseUrl, originPermissionPattern } from '../lib/ai/provider-config';
import { RecentActivity } from './RecentActivity';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';
import { Field, Input } from './ui/field';

type FormSettings = Omit<PublicSettings, 'hasApiKey'>;

export function SettingsApp() {
  const [form, setForm] = useState<FormSettings | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [state, setState] = useState<DashboardState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const response = await sendMessage({ type: 'state:get' });
    const dashboard = unwrapResponse<DashboardState>(response);
    const { hasApiKey: configured, ...settings } = dashboard.settings;
    setForm(settings);
    setHasApiKey(configured);
    setState(dashboard);
  }, []);

  useEffect(() => { void refresh().catch((reason: unknown) => setError(messageOf(reason))); }, [refresh]);

  function change<K extends keyof FormSettings>(key: K, value: FormSettings[K]) {
    setForm((current) => current ? { ...current, [key]: value } : current);
  }

  async function save(announce = true): Promise<void> {
    if (!form) return;
    const baseUrl = normalizeBaseUrl(form.baseUrl);
    if (!hasApiKey && !apiKey.trim()) throw new Error('启用自动整理前必须配置 API Key。');
    const settings = { ...form, baseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
    const response = await sendMessage({ type: 'settings:update', settings });
    unwrapResponse(response);
    setApiKey('');
    await refresh();
    if (announce) setMessage('设置已保存到此浏览器。');
  }

  async function saveAndTest() {
    if (!form) return;
    if (!hasApiKey && !apiKey.trim()) {
      setError('启用自动整理前必须配置 API Key。');
      setMessage('');
      return;
    }
    setBusy(true);
    setError('');
    setMessage('正在请求 API 来源权限…');
    try {
      const pattern = originPermissionPattern(form.baseUrl);
      // Call permissions.request directly from this click handler to preserve user activation.
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) throw new Error('未授予 API 地址权限，书签仍会保留原位。');
      await save(false);
      setMessage('正在测试 AI 服务连接…');
      const response = await sendMessage({ type: 'provider:test' });
      unwrapResponse(response);
      setMessage('连接成功，AI 分类服务已就绪。');
      await refresh();
    } catch (reason) {
      setError(messageOf(reason));
      setMessage('');
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled() {
    if (!form) return;
    change('enabled', !form.enabled);
    setBusy(true);
    try {
      const response = await sendMessage({ type: 'settings:update', settings: { enabled: !form.enabled } });
      unwrapResponse(response);
      await refresh();
      setMessage(!form.enabled ? '自动整理已开启。' : '自动整理已关闭，新书签将保留原位。');
    } catch (reason) {
      setError(messageOf(reason));
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  if (!form) return <main className="mx-auto max-w-4xl p-6"><p>{error || '正在加载设置…'}</p></main>;

  return <main className="mx-auto max-w-4xl space-y-6 px-5 py-8 sm:px-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><a href={chrome.runtime.getURL('/popup.html')} className="text-xs font-medium text-violet-700 dark:text-violet-300">← 返回书签管理</a><h1 className="mt-3 text-2xl font-semibold tracking-tight">设置</h1><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">控制何时归档、使用哪个 AI 服务，以及如何确认更改。</p></div>
      <Badge className={state?.aiStatus === 'configured' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'}>
        {state?.aiStatus === 'configured' ? '配置完成，尚未验证连接' : state?.aiStatus === 'permission-needed' ? '等待 API 来源授权' : '必须配置 API Key'}
      </Badge>
    </header>

    {error && <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/50 dark:text-rose-200">{error}</p>}
    {message && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200">{message}</p>}

    <div className="grid gap-5 lg:grid-cols-[1.4fr_0.8fr]">
      <div className="space-y-5">
        <Card>
          <CardHeader><h2 className="font-semibold">AI 服务</h2><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">支持 OpenAI 兼容的 Chat Completions 接口。</p></CardHeader>
          <CardContent className="grid gap-4">
            <Field label="API 地址" hint="非本机地址必须使用 HTTPS；只会申请此来源的可选权限。">
              <Input value={form.baseUrl} onChange={(event) => change('baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" autoComplete="url" />
            </Field>
            <Field label="模型名称">
              <Input value={form.model} onChange={(event) => change('model', event.target.value)} placeholder="gpt-4o-mini" />
            </Field>
            <Field label={hasApiKey ? '替换 API Key（留空保持当前密钥）' : 'API Key（必填）'} hint={hasApiKey ? '出于安全考虑，已保存的密钥不会回填到页面。' : '没有 API Key 时，新书签会留在原位并等待设置完成。'}>
              <Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={hasApiKey ? '已保存，请输入新密钥以替换' : '粘贴你的 API Key'} autoComplete="new-password" />
            </Field>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              API Key 保存在浏览器扩展的本地存储中。这不是高安全级别的密钥管理方案；请使用可撤销、低额度的密钥，不要在共享设备上保存。
            </div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy} onClick={() => void save().catch((reason: unknown) => setError(messageOf(reason)))}>保存配置</Button>
              <Button variant="secondary" disabled={busy} onClick={() => void saveAndTest()}>授权并测试 AI</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><h2 className="font-semibold">整理策略</h2><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">高置信度现有目录建议可自动归档；新建目录始终需要确认。</p></CardHeader>
          <CardContent className="grid gap-5">
            <label className="flex items-center justify-between gap-4">
              <span><span className="block text-sm font-medium">自动整理开关</span><span className="mt-1 block text-xs text-slate-500">关闭后新收藏会保留原位。</span></span>
              <input type="checkbox" checked={form.enabled} onChange={() => void toggleEnabled()} className="size-4 accent-violet-600" />
            </label>
            <Field label={`自动移动置信度阈值：${form.confidenceThreshold.toFixed(2)}`}>
              <input type="range" min="0.5" max="1" step="0.01" value={form.confidenceThreshold} onChange={(event) => change('confidenceThreshold', Number(event.target.value))} className="w-full accent-violet-600" />
            </Field>
            <Field label="整理模式">
              <select value={form.mode} onChange={(event) => change('mode', event.target.value as FormSettings['mode'])} className="min-h-10 rounded-xl border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
                <option value="automatic">自动模式（高置信度自动移动）</option>
                <option value="confirm">每次确认后移动</option>
              </select>
            </Field>
            <label className="flex items-start gap-3">
              <input type="checkbox" checked={form.forceOrganize} onChange={(event) => change('forceOrganize', event.target.checked)} className="mt-1 size-4 accent-violet-600" />
              <span><span className="block text-sm font-medium">强制整理自建文件夹中的书签</span><span className="mt-1 block text-xs leading-5 text-slate-500">默认尊重书签当前所在的用户文件夹。开启后也会整理这些位置。</span></span>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><h2 className="font-semibold">通知</h2></CardHeader>
          <CardContent className="grid gap-4">
            <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={form.notificationsEnabled} onChange={(event) => change('notificationsEnabled', event.target.checked)} className="size-4 accent-violet-600" />待确认建议和失败时显示桌面通知</label>
            <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={form.successNotifications} onChange={(event) => change('successNotifications', event.target.checked)} className="size-4 accent-violet-600" />自动归档成功时显示通知（默认关闭）</label>
          </CardContent>
        </Card>
        <div className="flex justify-end"><Button disabled={busy} onClick={() => void save().catch((reason: unknown) => setError(messageOf(reason)))}>保存所有设置</Button></div>
      </div>

      <aside className="space-y-5">
        <Card><CardHeader><h2 className="font-semibold">隐私与权限</h2></CardHeader><CardContent className="space-y-3 text-sm leading-6 text-slate-600 dark:text-slate-300">
          <p>分类只发送当前书签的标题、URL、域名和文件夹清单，不读取网页正文，也不上传整套书签库。</p>
          <p>扩展不申请访问所有网页。点击“授权并测试 AI”时，Chrome 只会请求上方 API 地址的来源权限。</p>
          <p>Chrome 书签事件无法识别用户是否主动选了内置目录；默认仅整理直接保存在书签栏、其他书签或移动设备书签根目录的新增项。</p>
        </CardContent></Card>
        <Card><CardHeader><h2 className="font-semibold">最近操作日志</h2></CardHeader><CardContent><RecentActivity activities={state?.activities ?? []} /></CardContent></Card>
      </aside>
    </div>
  </main>;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : '操作失败，请检查设置后重试。';
}
