import type { DashboardState, Settings } from './domain';

export type RuntimeRequest =
  | { type: 'state:get' }
  | { type: 'settings:update'; settings: Partial<Settings> }
  | { type: 'provider:test' }
  | { type: 'review:approve'; id: string }
  | { type: 'review:reject'; id: string }
  | { type: 'undo:last' };

export type RuntimeData =
  | DashboardState
  | { saved: true }
  | { connected: true; model: string }
  | { approved: true }
  | { rejected: true }
  | { undone: true; title: string };

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
