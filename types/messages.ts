import type { BookmarkMetadata, DashboardResponse, DashboardView, Settings, SettingsDraft } from './domain';

export type RuntimeRequest =
  | { type: 'state:get'; view?: DashboardView }
  | { type: 'settings:update'; settings: Partial<Settings> }
  | { type: 'provider:test' }
  | { type: 'settings-draft:get' }
  | { type: 'settings-draft:set'; draft: SettingsDraft }
  | { type: 'settings-draft:clear' }
  | { type: 'corrections:clear' }
  | { type: 'review:approve'; id: string; overrideFolderId?: string }
  | { type: 'review:reject'; id: string }
  | { type: 'undo:last' }
  | { type: 'scan:start' }
  | { type: 'scan:approve-all'; scanId?: string }
  | { type: 'undo:historical-last' }
  | { type: 'bookmark:metadata:generate'; bookmarkId: string };

export type RuntimeData =
  | DashboardResponse
  | { saved: true }
  | { connected: true; model: string }
  | { draft: SettingsDraft | null }
  | { approved: true }
  | { rejected: true }
  | { undone: true; title: string }
  | { started: true; scanId: string; eligibleTotal: number }
  | { approved: true; count: number }
  | { undone: true; count: number }
  | { generated: true; metadata: BookmarkMetadata };

export type RuntimeResponse =
  | { ok: true; data: RuntimeData }
  | { ok: false; error: string };

export async function sendMessage<T extends RuntimeRequest>(request: T): Promise<RuntimeResponse> {
  return chrome.runtime.sendMessage(request) as Promise<RuntimeResponse>;
}

export function unwrapResponse<T>(response: RuntimeResponse): T {
  if (!response.ok) throw new Error(response.error);
  return response.data as T;
}
