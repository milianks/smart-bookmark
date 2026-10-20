import { describe, expect, it, vi } from 'vitest';
import {
  handleRequest,
  RequestSchema,
  type OrganizerFacade,
  type RouterServices,
  type ScanFacade,
  type SettingsFacade,
} from '../entrypoints/background/router';
import { DEFAULT_SETTINGS, type DashboardState, type SettingsDraft } from '../types/domain';
import type { RuntimeRequest } from '../types/messages';

const dashboard: DashboardState = {
  settings: {
    enabled: DEFAULT_SETTINGS.enabled,
    protocol: DEFAULT_SETTINGS.protocol,
    baseUrl: DEFAULT_SETTINGS.baseUrl,
    model: 'test-model',
    confidenceThreshold: DEFAULT_SETTINGS.confidenceThreshold,
    mode: DEFAULT_SETTINGS.mode,
    forceOrganize: DEFAULT_SETTINGS.forceOrganize,
    notificationsEnabled: DEFAULT_SETTINGS.notificationsEnabled,
    successNotifications: DEFAULT_SETTINGS.successNotifications,
    organizeExternalRoots: DEFAULT_SETTINGS.organizeExternalRoots,
    hasApiKey: true,
  },
  pendingReviews: [],
  historicalReviews: [],
  recentJobs: [],
  activities: [],
  awaitingConfigurationCount: 0,
  awaitingPermissionCount: 0,
  undoStackCount: 0,
  folders: [],
  aiStatus: 'configured',
  historicalUndoAvailable: false,
};

function makeServices() {
  const calls = {
    getDashboardState: 0,
    updateSettings: [] as Parameters<SettingsFacade['updateSettings']>[0][],
    testProvider: 0,
    getSettingsDraft: 0,
    updateSettingsDraft: [] as SettingsDraft[],
    clearSettingsDraft: 0,
    approveReview: [] as string[],
    rejectReview: [] as string[],
    undoLastMove: 0,
    undoHistoricalLast: 0,
    startHistoricalScan: 0,
    approveAllHistoricalReviews: [] as (string | undefined)[],
    generateMetadata: [] as string[],
  };
  const organizer: OrganizerFacade = {
    getDashboardState: async () => { calls.getDashboardState += 1; return dashboard; },
    approveReview: async (id) => { calls.approveReview.push(id); },
    rejectReview: async (id) => { calls.rejectReview.push(id); },
    undoLastMove: async () => { calls.undoLastMove += 1; return 'moved title'; },
    undoHistoricalLast: async () => { calls.undoHistoricalLast += 1; return 2; },
  };
  const scan: ScanFacade = {
    startHistoricalScan: async () => { calls.startHistoricalScan += 1; return { scanId: 'scan-1', eligibleTotal: 3 }; },
    approveAllHistoricalReviews: async (scanId) => { calls.approveAllHistoricalReviews.push(scanId); return 2; },
  };
  const settings: SettingsFacade = {
    updateSettings: async (patch) => { calls.updateSettings.push(patch); },
    testProvider: async () => { calls.testProvider += 1; },
    getSettingsDraft: async () => { calls.getSettingsDraft += 1; return { model: 'draft-model' }; },
    updateSettingsDraft: async (draft) => { calls.updateSettingsDraft.push(draft); },
    clearSettingsDraft: async () => { calls.clearSettingsDraft += 1; },
  };
  const normalizeBaseUrl = vi.fn((baseUrl: string) => `${baseUrl}/normalized`);
  const metadata = { generate: async (bookmarkId: string) => { calls.generateMetadata.push(bookmarkId); return { summary: 'Summary', tags: ['tag'], generatedAt: 10 }; } };
  const services: RouterServices = { organizer, scan, settings, metadata, normalizeBaseUrl };
  return { calls, services, organizer, scan, settings, normalizeBaseUrl };
}

describe('background runtime router', () => {
  it('strictly rejects malformed and unknown-field requests', () => {
    const malformed: unknown[] = [
      {},
      { type: 'state:get', extra: true },
      { type: 'settings:update' },
      { type: 'settings:update', settings: { model: 'model', extra: true } },
      { type: 'settings:update', settings: { baseUrl: '' } },
      { type: 'settings-draft:set', draft: { extra: true } },
      { type: 'review:approve', id: '' },
      { type: 'scan:approve-all', scanId: '' },
      { type: 'bookmark:metadata:generate', bookmarkId: '' },
      { type: 'bookmark:metadata:generate', bookmarkId: 'bookmark-1', extra: true },
      { type: 'unknown' },
    ];

    for (const request of malformed) expect(RequestSchema.safeParse(request).success).toBe(false);
    expect(RequestSchema.safeParse({ type: 'state:get' }).success).toBe(true);
    expect(RequestSchema.safeParse({ type: 'settings:update', settings: { model: 'model' } }).success).toBe(true);
    expect(RequestSchema.safeParse({ type: 'scan:approve-all' }).success).toBe(true);
  });

  it('routes every RuntimeRequest variant through typed service facades', async () => {
    const { calls, services } = makeServices();
    const draft: SettingsDraft = { model: 'draft-model' };
    const requests: RuntimeRequest[] = [
      { type: 'state:get' },
      { type: 'settings:update', settings: { model: 'new-model', apiKey: 'secret' } },
      { type: 'provider:test' },
      { type: 'settings-draft:get' },
      { type: 'settings-draft:set', draft },
      { type: 'settings-draft:clear' },
      { type: 'review:approve', id: 'review-1' },
      { type: 'review:reject', id: 'review-2' },
      { type: 'undo:last' },
      { type: 'scan:start' },
      { type: 'scan:approve-all', scanId: 'scan-1' },
      { type: 'undo:historical-last' },
      { type: 'bookmark:metadata:generate', bookmarkId: 'bookmark-1' },
    ];
    for (const request of requests) expect(RequestSchema.safeParse(request).success).toBe(true);

    await expect(handleRequest(requests[0]!, services)).resolves.toBe(dashboard);
    await expect(handleRequest(requests[1]!, services)).resolves.toEqual({ saved: true });
    await expect(handleRequest(requests[2]!, services)).resolves.toEqual({ connected: true, model: 'test-model' });
    await expect(handleRequest(requests[3]!, services)).resolves.toEqual({ draft: { model: 'draft-model' } });
    await expect(handleRequest(requests[4]!, services)).resolves.toEqual({ saved: true });
    await expect(handleRequest(requests[5]!, services)).resolves.toEqual({ saved: true });
    await expect(handleRequest(requests[6]!, services)).resolves.toEqual({ approved: true });
    await expect(handleRequest(requests[7]!, services)).resolves.toEqual({ rejected: true });
    await expect(handleRequest(requests[8]!, services)).resolves.toEqual({ undone: true, title: 'moved title' });
    await expect(handleRequest(requests[9]!, services)).resolves.toEqual({ started: true, scanId: 'scan-1', eligibleTotal: 3 });
    await expect(handleRequest(requests[10]!, services)).resolves.toEqual({ approved: true, count: 2 });
    await expect(handleRequest({ type: 'scan:approve-all' }, services)).resolves.toEqual({ approved: true, count: 2 });
    await expect(handleRequest(requests[11]!, services)).resolves.toEqual({ undone: true, count: 2 });
    await expect(handleRequest(requests[12]!, services)).resolves.toEqual({ generated: true, metadata: { summary: 'Summary', tags: ['tag'], generatedAt: 10 } });

    expect(calls.updateSettings).toEqual([{ model: 'new-model', apiKey: 'secret' }]);
    expect(calls.getDashboardState).toBe(2);
    expect(calls.getSettingsDraft).toBe(1);
    expect(calls.updateSettingsDraft).toEqual([draft]);
    expect(calls.clearSettingsDraft).toBe(1);
    expect(calls.approveReview).toEqual(['review-1']);
    expect(calls.rejectReview).toEqual(['review-2']);
    expect(calls.undoLastMove).toBe(1);
    expect(calls.undoHistoricalLast).toBe(1);
    expect(calls.startHistoricalScan).toBe(1);
    expect(calls.approveAllHistoricalReviews).toEqual(['scan-1', undefined]);
    expect(calls.generateMetadata).toEqual(['bookmark-1']);
  });

  it('normalizes a settings copy and keeps API keys out of responses', async () => {
    const { calls, services, normalizeBaseUrl } = makeServices();
    const request: RuntimeRequest = {
      type: 'settings:update',
      settings: { baseUrl: 'https://provider.test/v1', apiKey: 'secret' },
    };

    await expect(handleRequest(request, services)).resolves.toEqual({ saved: true });
    expect(normalizeBaseUrl).toHaveBeenCalledWith('https://provider.test/v1');
    expect(calls.updateSettings).toEqual([{
      baseUrl: 'https://provider.test/v1/normalized',
      apiKey: 'secret',
    }]);
    expect(request.settings).toEqual({ baseUrl: 'https://provider.test/v1', apiKey: 'secret' });

    const state = await handleRequest({ type: 'state:get' }, services);
    const providerTest = await handleRequest({ type: 'provider:test' }, services);
    expect(state).not.toHaveProperty('settings.apiKey');
    expect(providerTest).not.toHaveProperty('apiKey');
    expect(providerTest).toEqual({ connected: true, model: 'test-model' });
  });

  it('propagates service errors unchanged', async () => {
    const { services } = makeServices();
    const error = new Error('service failure');
    services.settings.testProvider = async () => { throw error; };

    await expect(handleRequest({ type: 'provider:test' }, services)).rejects.toBe(error);
  });
});
