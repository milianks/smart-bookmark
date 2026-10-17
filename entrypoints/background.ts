import { defineBackground } from '#imports';
import { z } from 'zod';
import { originPermissionPattern, normalizeBaseUrl } from '../lib/ai/provider-config';
import { OpenAICompatibleProvider } from '../lib/ai/openai-compatible';
import { ChromeStateRepository } from '../lib/storage/repository';
import { ChromeBookmarkService } from '../services/bookmark.service';
import { ClassificationService } from '../services/classifier.service';
import { ChromeNotificationService } from '../services/notification.service';
import { OrganizerService } from '../services/organizer.service';
import { ScanService } from '../services/scan.service';
import { SettingsService } from '../services/settings.service';
import { ProviderProtocolSchema, SettingsDraftSchema } from '../types/domain';
import type { RuntimeRequest } from '../types/messages';

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

const RequestSchema = z.discriminatedUnion('type', [
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

export default defineBackground(() => {
  const store = new ChromeStateRepository();
  const bookmarks = new ChromeBookmarkService();
  const provider = new OpenAICompatibleProvider();
  const classifier = new ClassificationService(provider, store);
  const notifications = new ChromeNotificationService();
  const organizer = new OrganizerService({
    bookmarks,
    store,
    classifier,
    notifications,
    alarms: {
      schedule: async (delayMs) => {
        await chrome.alarms.create('ai-bookmark-manager.resume', { when: Date.now() + delayMs });
      },
    },
    hasProviderPermission: async (baseUrl) => {
      try {
        return await chrome.permissions.contains({ origins: [originPermissionPattern(baseUrl)] });
      } catch {
        return false;
      }
    },
  });
  const scan = new ScanService({ bookmarks, store, processPending: () => organizer.processPending(), approveReview: (id) => organizer.approveReview(id) });
  const settings = new SettingsService({
    store, classifier,
    hasProviderPermission: async (baseUrl) => {
      try {
        return await chrome.permissions.contains({ origins: [originPermissionPattern(baseUrl)] });
      } catch {
        return false;
      }
    },
    afterUpdate: () => organizer.resume(),
  });

  // MV3 event listeners must be registered synchronously at worker evaluation time.
  chrome.bookmarks.onCreated.addListener((id, node) => {
    void organizer.onBookmarkCreated(id, node).catch((error: unknown) => reportBackgroundError(error));
  });
  chrome.bookmarks.onImportBegan.addListener(() => {
    void organizer.onImportBegan().catch((error: unknown) => reportBackgroundError(error));
  });
  chrome.bookmarks.onImportEnded.addListener(() => {
    void organizer.onImportEnded().catch((error: unknown) => reportBackgroundError(error));
  });
  chrome.runtime.onStartup.addListener(() => {
    void organizer.resume().catch((error: unknown) => reportBackgroundError(error));
  });
  chrome.runtime.onInstalled.addListener(() => {
    void store.update(() => undefined)
      .then(() => organizer.resume())
      .catch((error: unknown) => reportBackgroundError(error));
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'ai-bookmark-manager.resume') {
      void organizer.resume().catch((error: unknown) => reportBackgroundError(error));
    }
  });
  chrome.notifications.onClicked.addListener((notificationId) => {
    if (notificationId.startsWith('review:')) {
      const id = encodeURIComponent(notificationId.slice('review:'.length));
      void chrome.tabs.create({ url: chrome.runtime.getURL(`/review.html?item=${id}`) });
    }
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const parsed = RequestSchema.safeParse(message);
    if (!parsed.success) return false;
    void handleRequest(parsed.data, organizer, scan, settings)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error: unknown) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : '操作失败，请稍后重试。',
      }));
    return true;
  });

  // Reducing accidental exposure to content scripts; secrets stay in extension contexts.
  void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  void organizer.resume().catch((error: unknown) => reportBackgroundError(error));
});

async function handleRequest(request: RuntimeRequest, organizer: OrganizerService, scan: ScanService, settings: SettingsService): Promise<unknown> {
  switch (request.type) {
    case 'state:get': return organizer.getDashboardState();
    case 'settings:update': {
      const patch = request.settings;
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

function reportBackgroundError(error: unknown): void {
  // Never log request bodies, URLs, API keys, or provider response payloads.
  console.error('[AI Bookmark Manager] background operation failed:',
    error instanceof Error ? error.message : 'unknown error');
}
