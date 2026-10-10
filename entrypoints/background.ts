import { defineBackground } from '#imports';
import { z } from 'zod';
import { originPermissionPattern, normalizeBaseUrl } from '../lib/ai/provider-config';
import { OpenAICompatibleProvider } from '../lib/ai/openai-compatible';
import { ChromeStateRepository } from '../lib/storage/repository';
import { ChromeBookmarkService } from '../services/bookmark.service';
import { ClassificationService } from '../services/classifier.service';
import { ChromeNotificationService } from '../services/notification.service';
import { OrganizerService } from '../services/organizer.service';
import type { RuntimeRequest } from '../types/messages';

const SettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
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
  z.object({ type: z.literal('review:approve'), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('review:reject'), id: z.string().min(1) }).strict(),
  z.object({ type: z.literal('undo:last') }).strict(),
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
    } else if (notificationId.startsWith('failure:')) {
      void chrome.runtime.openOptionsPage();
    }
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const parsed = RequestSchema.safeParse(message);
    if (!parsed.success) return false;
    void handleRequest(parsed.data, organizer)
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

async function handleRequest(request: RuntimeRequest, organizer: OrganizerService): Promise<unknown> {
  switch (request.type) {
    case 'state:get':
      return organizer.getDashboardState();
    case 'settings:update': {
      const patch = request.settings;
      if (patch.baseUrl !== undefined) patch.baseUrl = normalizeBaseUrl(patch.baseUrl);
      await organizer.updateSettings(patch);
      return { saved: true };
    }
    case 'provider:test':
      await organizer.testProvider();
      return { connected: true, model: (await organizer.getDashboardState()).settings.model };
    case 'review:approve':
      await organizer.approveReview(request.id);
      return { approved: true };
    case 'review:reject':
      await organizer.rejectReview(request.id);
      return { rejected: true };
    case 'undo:last':
      return { undone: true, title: await organizer.undoLastMove() };
  }
}

function reportBackgroundError(error: unknown): void {
  // Never log request bodies, URLs, API keys, or provider response payloads.
  console.error('[AI Bookmark Manager] background operation failed:',
    error instanceof Error ? error.message : 'unknown error');
}
