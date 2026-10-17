import { z } from 'zod';
import { ProviderProtocolSchema, SettingsDraftSchema } from '../../types/domain';
import type { DashboardState, Settings, SettingsDraft } from '../../types/domain';
import type { RuntimeRequest } from '../../types/messages';

const SettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  protocol: ProviderProtocolSchema.optional(),
  baseUrl: z.string().min(1).max(2_000).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  confidenceThreshold: z.number().min(0.5).max(1).optional(),
  mode: z.enum(['automatic', 'confirm']).optional(),
  forceOrganize: z.boolean().optional(),
  notificationsEnabled: z.boolean().optional(),
  successNotifications: z.boolean().optional(),
  apiKey: z.string().max(4_000).optional(),
}).strict();

export const RequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state:get') }).strict(),
  z.object({ type: z.literal('settings:update'), settings: SettingsPatchSchema }).strict(),
  z.object({ type: z.literal('provider:test') }).strict(),
  z.object({ type: z.literal('settings-draft:get') }).strict(),
  z.object({ type: z.literal('settings-draft:set'), draft: SettingsDraftSchema }).strict(),
  z.object({ type: z.literal('settings-draft:clear') }).strict(),
  z.object({ type: z.literal('review:approve'), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('review:reject'), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('undo:last') }).strict(),
  z.object({ type: z.literal('scan:start') }).strict(),
  z.object({ type: z.literal('scan:approve-all'), scanId: z.string().min(1).optional() }).strict(),
  z.object({ type: z.literal('undo:historical-last') }).strict(),
]);

export interface OrganizerFacade {
  getDashboardState(): Promise<DashboardState>;
  approveReview(id: string): Promise<void>;
  rejectReview(id: string): Promise<void>;
  undoLastMove(): Promise<string>;
  undoHistoricalLast(): Promise<number>;
}

export interface ScanFacade {
  startHistoricalScan(): Promise<{ scanId: string; eligibleTotal: number }>;
  approveAllHistoricalReviews(scanId?: string): Promise<number>;
}

export interface SettingsFacade {
  updateSettings(patch: Partial<Omit<Settings, 'apiKey'>> & { apiKey?: string }): Promise<void>;
  testProvider(): Promise<void>;
  getSettingsDraft(): Promise<SettingsDraft | null>;
  updateSettingsDraft(draft: SettingsDraft): Promise<void>;
  clearSettingsDraft(): Promise<void>;
}

export interface RouterServices {
  organizer: OrganizerFacade;
  scan: ScanFacade;
  settings: SettingsFacade;
  normalizeBaseUrl: (baseUrl: string) => string;
}

export async function handleRequest(request: RuntimeRequest, services: RouterServices): Promise<unknown> {
  const { organizer, scan, settings, normalizeBaseUrl } = services;
  switch (request.type) {
    case 'state:get': return organizer.getDashboardState();
    case 'settings:update': {
      const patch = { ...request.settings };
      if (patch.baseUrl !== undefined) patch.baseUrl = normalizeBaseUrl(patch.baseUrl);
      await settings.updateSettings(patch);
      return { saved: true };
    }
    case 'provider:test':
      await settings.testProvider();
      return { connected: true, model: (await organizer.getDashboardState()).settings.model };
    case 'settings-draft:get': return { draft: await settings.getSettingsDraft() };
    case 'settings-draft:set':
      await settings.updateSettingsDraft(request.draft);
      return { saved: true };
    case 'settings-draft:clear':
      await settings.clearSettingsDraft();
      return { saved: true };
    case 'review:approve':
      await organizer.approveReview(request.id);
      return { approved: true };
    case 'review:reject':
      await organizer.rejectReview(request.id);
      return { rejected: true };
    case 'undo:last': return { undone: true, title: await organizer.undoLastMove() };
    case 'scan:start': return { started: true, ...(await scan.startHistoricalScan()) };
    case 'scan:approve-all': return { approved: true, count: await scan.approveAllHistoricalReviews(request.scanId) };
    case 'undo:historical-last': return { undone: true, count: await organizer.undoHistoricalLast() };
  }
}
