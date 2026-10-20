import { useCallback, useEffect, useRef, useState } from 'react';
import type { DashboardState, ProviderProtocol, PublicSettings, SettingsDraft } from '../types/domain';
import { sendMessage, unwrapResponse } from '../types/messages';
import { normalizeBaseUrl, originPermissionPattern } from '../lib/ai/provider-config';
import { RecentActivity } from './RecentActivity';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardHeader } from './ui/card';
import { Disclosure } from './ui/disclosure';
import { Field, Input, Select } from './ui/field';
import { Notice } from './ui/notice';
import { Skeleton } from './ui/skeleton';
import { Switch } from './ui/switch';

type FormSettings = Omit<PublicSettings, 'hasApiKey'>;

interface SettingsAppProps {
  embedded?: boolean;
  onBack?: () => void;
}

const backLinkClass = 'inline-flex rounded text-xs font-medium text-violet-700 underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:text-violet-300 dark:focus-visible:ring-offset-slate-950';

export function SettingsApp({ embedded = false, onBack }: SettingsAppProps) {
  const [form, setForm] = useState<FormSettings | null>(null);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [state, setState] = useState<DashboardState | null>(null);
  const [connectionTested, setConnectionTested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const draftWrite = useRef(Promise.resolve());
  const savedForm = useRef<FormSettings | null>(null);

  const refresh = useCallback(async () => {
    const response = await sendMessage({ type: 'state:get' });
    const dashboard = unwrapResponse<DashboardState>(response);
    const { hasApiKey: configured, ...settings } = dashboard.settings;
    const draftResponse = await sendMessage({ type: 'settings-draft:get' });
    const draft = unwrapResponse<{ draft: SettingsDraft | null }>(draftResponse).draft;
    const { apiKey: draftApiKey, ...draftSettings } = draft ?? {};
    setForm({ ...settings, ...draftSettings });
    savedForm.current = settings;
    if (draftApiKey !== undefined) setApiKey(draftApiKey);
    setHasApiKey(configured);
    setState(dashboard);
    setDraftReady(true);
  }, []);

  useEffect(() => { void refresh().catch((reason: unknown) => setError(messageOf(reason))); }, [refresh]);

  function change<K extends keyof FormSettings>(key: K, value: FormSettings[K]) {
    if (key === 'protocol' || key === 'baseUrl' || key === 'model') setConnectionTested(false);
    setForm((current) => {
      const next = current ? { ...current, [key]: value } : current;
      if (next && draftReady) void persistDraft(next, apiKey);
      return next;
    });
  }

  async function persistDraft(nextForm: FormSettings, nextApiKey: string): Promise<void> {
    const draft: SettingsDraft = { ...nextForm, apiKey: nextApiKey };
    try {
      draftWrite.current = draftWrite.current.catch(() => undefined).then(async () => {
        unwrapResponse(await sendMessage({ type: 'settings-draft:set', draft }));
      });
      await draftWrite.current;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '设置草稿保存失败，仍可继续编辑。');
    }
  }

  async function save(announce = true): Promise<void> {
    if (!form) return;
    const baseUrl = normalizeBaseUrl(form.baseUrl);
    if (!hasApiKey && !apiKey.trim()) throw new Error('启用自动整理前必须配置 API Key。');
    const settings = { ...form, baseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
    await draftWrite.current;
    const response = await sendMessage({ type: 'settings:update', settings });
    unwrapResponse(response);
    unwrapResponse(await sendMessage({ type: 'settings-draft:clear' }));
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
    setConnectionTested(false);
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
      setConnectionTested(true);
      setMessage('连接成功，AI 分类服务已就绪。');
    } catch (reason) {
      setError(messageOf(reason));
      setMessage('');
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled() {
    if (!form || busy) return;
    const previousEnabled = form.enabled;
    const enabled = !previousEnabled;
    change('enabled', enabled);
    setBusy(true);
    try {
      const response = await sendMessage({ type: 'settings:update', settings: { enabled } });
      unwrapResponse(response);
      savedForm.current = savedForm.current ? { ...savedForm.current, enabled } : savedForm.current;
      setMessage(enabled ? '自动整理已开启。' : '自动整理已关闭，新书签将保留原位。');
    } catch (reason) {
      setError(messageOf(reason));
      setForm((current) => current ? { ...current, enabled: previousEnabled } : current);
    } finally {
      setBusy(false);
    }
  }

  if (!form) return <main className={embedded ? 'w-[390px] space-y-4 p-4' : 'mx-auto w-full max-w-3xl space-y-4 px-5 py-7 sm:px-8 lg:px-10'}>
    {error ? <Notice tone="error" className="text-sm">{error}</Notice> : <>
      <div className="flex items-center gap-3"><Skeleton className="size-10 rounded-2xl" /><div className="flex-1 space-y-2"><Skeleton className="h-5 w-24" /><Skeleton className="h-3 w-40" /></div></div>
      <Skeleton className="h-36" />
      <Skeleton className="h-24" />
      <p role="status" className="sr-only">正在加载设置…</p>
    </>}
  </main>;

  const connected = connectionTested || state?.aiStatus === 'configured';
  const connectionLabel = connectionTested ? '连接测试通过' : state?.aiStatus === 'configured' ? '配置完成，尚未验证连接' : state?.aiStatus === 'permission-needed' ? '等待 API 来源授权' : '必须配置 API Key';
  const missingApiKey = !hasApiKey && !apiKey.trim();
  const dirty = JSON.stringify(form) !== JSON.stringify(savedForm.current) || apiKey.trim().length > 0;
  const actionHint = missingApiKey ? '填写 API Key 后可保存' : dirty ? '有未应用的更改' : '设置已同步';

  return <main className={embedded ? 'w-[390px] space-y-4 p-4' : 'mx-auto w-full max-w-3xl space-y-4 px-5 py-7 sm:px-8 lg:px-10'}>
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        {embedded ? <button type="button" onClick={onBack} className={backLinkClass}>← 返回书签管理</button> : <a href={chrome.runtime.getURL('/popup.html')} className={backLinkClass}>← 返回书签管理</a>}
        <h1 className="mt-3 text-xl font-semibold tracking-tight">设置</h1>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">配置 AI 服务和书签整理方式。</p>
      </div>
      <Badge tone={connected ? 'success' : 'warning'} className="shrink-0 whitespace-nowrap">{connectionLabel}</Badge>
    </header>

    {error && <Notice tone="error" className="text-sm">{error}</Notice>}
    {message && <Notice tone="success" className="text-sm">{message}</Notice>}

    <Card>
      <CardHeader><h2 className="font-semibold">AI 服务</h2><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">选择 API 协议，并填写基础地址、模型和密钥。</p></CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="API 协议">
            <Select value={form.protocol} disabled={busy} onChange={(event) => change('protocol', event.target.value as ProviderProtocol)}>
              <option value="anthropic-messages">Anthropic Messages</option>
              <option value="openai-chat-completions">OpenAI 兼容（Chat Completions）</option>
              <option value="openai-responses">OpenAI Responses API</option>
            </Select>
          </Field>
          <Field label="模型名称">
            <Input value={form.model} disabled={busy} onChange={(event) => change('model', event.target.value)} placeholder="模型名称" />
          </Field>
        </div>
        <Field label="基础 API 地址" hint="填写服务基础地址，例如 https://api.openai.com/v1；不要填写 /messages、/chat/completions 或 /responses。只会申请该来源的可选权限。">
          <Input value={form.baseUrl} disabled={busy} onChange={(event) => change('baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" autoComplete="url" />
        </Field>
        <Field label={hasApiKey ? '替换 API Key（留空保持当前密钥）' : 'API Key'} hint={hasApiKey ? '已保存的密钥不会回填到页面。' : '未配置密钥时，新书签会保留原位。'}>
          <Input type="password" value={apiKey} disabled={busy} onChange={(event) => { const value = event.target.value; setApiKey(value); setConnectionTested(false); if (form && draftReady) void persistDraft(form, value); }} placeholder={hasApiKey ? '输入新密钥以替换' : '粘贴 API Key'} autoComplete="new-password" />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4 dark:border-slate-800">
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || missingApiKey || !dirty} onClick={() => void save().catch((reason: unknown) => setError(messageOf(reason)))}>保存设置</Button>
            <Button variant="secondary" disabled={busy || missingApiKey} onClick={() => void saveAndTest()}>授权并测试 AI</Button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">{actionHint}</p>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader><h2 className="font-semibold">书签整理</h2><p className="mt-1 text-sm text-slate-500 dark:text-slate-400">高置信度建议可自动归档；新建目录仍需确认。</p></CardHeader>
      <CardContent className="space-y-4">
        <Switch checked={form.enabled} disabled={busy} label="自动整理开关" title="自动整理" description="关闭后新收藏会保留原位。" onCheckedChange={() => void toggleEnabled()} />
        <div className="border-t border-slate-100 pt-4 dark:border-slate-800">
          <Disclosure title="整理偏好">
            <div className="grid gap-5">
              <Field label={`自动移动置信度阈值：${form.confidenceThreshold.toFixed(2)}`}>
                <input type="range" min="0.5" max="1" step="0.01" value={form.confidenceThreshold} aria-valuetext={form.confidenceThreshold.toFixed(2)} onChange={(event) => change('confidenceThreshold', Number(event.target.value))} className="w-full accent-violet-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-950" />
              </Field>
              <Field label="整理模式">
                <Select value={form.mode} onChange={(event) => change('mode', event.target.value as FormSettings['mode'])}>
                  <option value="automatic">自动模式（高置信度自动移动）</option>
                  <option value="confirm">每次确认后移动</option>
                </Select>
              </Field>
            </div>
          </Disclosure>
        </div>
      </CardContent>
    </Card>

    <Card><CardContent>
      <Disclosure title="通知设置">
        <div className="space-y-2">
          <Switch checked={form.notificationsEnabled} label="待确认与失败通知" title="待确认与失败通知" description="待确认建议或处理失败时显示桌面通知。" onCheckedChange={(checked) => change('notificationsEnabled', checked)} />
          <Switch checked={form.successNotifications} label="归档成功通知" title="归档成功通知" description="自动归档成功时显示通知（默认关闭）。" onCheckedChange={(checked) => change('successNotifications', checked)} />
        </div>
      </Disclosure>
    </CardContent></Card>

    <Card><CardContent>
      <Disclosure title="隐私、权限与密钥存储">
        <div className="space-y-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
          <p>分类只发送当前书签的标题、URL、域名和文件夹清单，不读取网页正文，也不上传整套书签库。</p>
          <p>扩展不申请访问所有网页。点击“授权并测试 AI”时，Chrome 只请求上方 API 地址的来源权限。</p>
          <p>API Key 保存在扩展本地存储中。请使用可撤销、低额度的密钥，避免在共享设备上保存。</p>
          <p>默认仅整理“智能书签”目录及其子目录中的新增项。</p>
        </div>
      </Disclosure>
    </CardContent></Card>

    <Card><CardContent>
      <Disclosure title="最近操作">
        <RecentActivity activities={state?.activities ?? []} />
      </Disclosure>
    </CardContent></Card>
  </main>;
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : '操作失败，请检查设置后重试。';
}
