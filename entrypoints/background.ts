import { defineBackground } from '#imports';
import { originPermissionPattern, normalizeBaseUrl } from '../lib/ai/provider-config';
import { RequestSchema, handleRequest } from './background/router';
import { OpenAICompatibleProvider } from '../lib/ai/openai-compatible';
import { ChromeStateRepository } from '../lib/storage/repository';
import { ChromeBookmarkService } from '../services/bookmark.service';
import { ClassificationService } from '../services/classifier.service';
import { BookmarkMetadataService } from '../services/bookmark-metadata.service';
import { ChromeNotificationService } from '../services/notification.service';
import { OrganizerService } from '../services/organizer.service';
import { ScanService } from '../services/scan.service';
import { SettingsService } from '../services/settings.service';
import { PageExtractorService } from '../services/page-extractor.service';
import { ChromePageExtractionPort } from '../services/page-extractor.chrome';
export default defineBackground(() => {
  const store = new ChromeStateRepository();
  const bookmarks = new ChromeBookmarkService();
  const provider = new OpenAICompatibleProvider();
  const metadata = new BookmarkMetadataService({
    bookmarks, store, provider,
    hasProviderPermission: async (baseUrl) => {
      try { return await chrome.permissions.contains({ origins: [originPermissionPattern(baseUrl)] }); } catch { return false; }
    },
  });
  const classifier = new ClassificationService(provider, store);
  const pageProfiles = new PageExtractorService({ port: new ChromePageExtractionPort() });
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
    pageProfiles,
  });
  let approvalTimer: ReturnType<typeof setTimeout> | undefined;
  const scan = new ScanService({
    bookmarks, store,
    processPending: () => organizer.processPending(),
    approveReview: (id) => organizer.approveReview(id),
    scheduleApprovalResume: async (delayMs) => {
      await chrome.alarms.create('ai-bookmark-manager.approve', { when: Date.now() + Math.max(delayMs, 30_000) });
      // Continue promptly while alive; the durable alarm recovers work if the worker is stopped.
      if (delayMs < 30_000) {
        if (approvalTimer) clearTimeout(approvalTimer);
        approvalTimer = setTimeout(() => {
          approvalTimer = undefined;
          void scan.resumeApprovals().catch((error: unknown) => reportBackgroundError(error));
        }, delayMs);
      }
    },
  });
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

  let rootInitialization: Promise<void> | undefined;
  const initializeSmartBookmarkRoot = (): Promise<void> => {
    if (!rootInitialization) {
      rootInitialization = (async () => {
        const state = await store.load();
        const result = await bookmarks.initializeSmartBookmarkRoot({
          storedRootId: state.smartBookmarkRootId,
          initializeDefaults: !state.smartBookmarkInitialized,
        });
        await store.update((next) => {
          next.smartBookmarkRootId = result.rootId;
          next.smartBookmarkInitialized = true;
        });
      })().finally(() => {
        rootInitialization = undefined;
      });
    }
    return rootInitialization;
  };

  const resumeAfterRootInitialization = (): void => {
    void initializeSmartBookmarkRoot()
      .catch((error: unknown) => reportBackgroundError(error))
      .then(async () => {
        await organizer.resume().catch((error: unknown) => reportBackgroundError(error));
        await scan.resumeApprovals().catch((error: unknown) => reportBackgroundError(error));
      });
  };

  // MV3 event listeners must be registered synchronously at worker evaluation time.
  chrome.bookmarks.onCreated.addListener((id, node) => {
    void organizer.onBookmarkCreated(id, node).catch((error: unknown) => reportBackgroundError(error));
  });
  chrome.bookmarks.onRemoved.addListener((_id, info) => {
    void organizer.onBookmarkRemoved(info.node).catch((error: unknown) => reportBackgroundError(error));
  });
  chrome.bookmarks.onImportBegan.addListener(() => {
    void organizer.onImportBegan().catch((error: unknown) => reportBackgroundError(error));
  });
  chrome.bookmarks.onImportEnded.addListener(() => {
    void organizer.onImportEnded().catch((error: unknown) => reportBackgroundError(error));
  });
  chrome.runtime.onStartup.addListener(() => {
    resumeAfterRootInitialization();
  });
  chrome.runtime.onInstalled.addListener(() => {
    resumeAfterRootInitialization();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'ai-bookmark-manager.approve') {
      void scan.resumeApprovals().catch((error: unknown) => reportBackgroundError(error));
    }
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
    void handleRequest(parsed.data, { organizer, scan, settings, metadata, normalizeBaseUrl })
      .then((data) => sendResponse({ ok: true, data }))
      .catch((error: unknown) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : '操作失败，请稍后重试。',
      }));
    return true;
  });

  // Reducing accidental exposure to content scripts; secrets stay in extension contexts.
  void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  resumeAfterRootInitialization();
});

function reportBackgroundError(error: unknown): void {
  // Never log request bodies, URLs, API keys, or provider response payloads.
  console.error('[AI Bookmark Manager] background operation failed:',
    error instanceof Error ? error.message : 'unknown error');
}
