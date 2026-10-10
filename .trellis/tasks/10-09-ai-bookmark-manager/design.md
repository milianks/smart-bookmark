# Design: AI Bookmark Manager MVP

## Architecture

Build one WXT Chrome-only extension with React pages and a Manifest V3 background service worker. Keep domain logic independent of browser globals so Vitest can inject fake bookmark, storage, permission, alarm, and notification adapters.

```text
Chrome bookmark events
  → synchronous WXT background listeners
  → durable per-bookmark job queue (chrome.storage.local)
  → eligible-source check + bookmark-tree snapshot
  → local classification cache → deterministic rules → configured AI provider if still uncertain
  → Zod result validation + live folder ID validation
  → automatic move OR durable review suggestion
  → notification click opens review page
  → operation log + undo record

Popup / Settings / Review
  → typed chrome.runtime messages
  → background-owned settings, queue, provider, and bookmark operations
```

WXT entrypoints are `entrypoints/background.ts`, `entrypoints/popup/`, `entrypoints/options/`, and `entrypoints/review/`. Shared UI primitives/components live under `components/`; contracts, providers, storage, and business services are separated into `types/`, `lib/`, and `services/`. The extension has one cohesive deliverable rather than parent/child tasks because the listener, queue, review flow, and UI only meet their acceptance criteria when integrated.

## Boundaries and data contracts

- `BookmarkService` owns Chrome bookmark API access: tree/folder traversal, path calculation, bookmark/folder lookups, move, create, and existence checks. The organizer receives this service through an interface and never calls Chrome APIs through model output.
- `StorageRepository` owns versioned `chrome.storage.local` records: settings, a job keyed by bookmark ID, review items, a classification cache, bounded activity history, and the latest undoable automatic move. Use local storage only; keep the API key out of `storage.sync`, logs, notification text, and source control. Set storage access to trusted extension contexts.
- `Classifier` accepts one bookmark's title, URL/domain, source folder, and folder `{id,name,path}` summaries. Do not send page content or other bookmarks' URLs/titles. Keep `ClassificationResult` schema strict: confidence is 0–1; `move` requires a target folder ID; `suggest_folder` requires a name and parent ID; `keep` has no destination.
- Classification pipeline: require a configured API key before automatic processing; check a local normalized-URL cache and deterministic domain/title-to-folder rules first; only a high-confidence match can be applied from those sources without an API request. Label cache/rule/AI provenance in UI and history. When local matching is inconclusive, call the configured provider. Cache validated AI results by normalized URL + folder-tree fingerprint + provider/model identity; invalidate them when the bookmark/folder context changes or a target folder disappears.
- `OpenAICompatibleProvider` performs one bounded request to the configured `/chat/completions` endpoint. The prompt treats title and URL as quoted data, rejects embedded instructions, requests JSON only, and imposes response size and timeout limits. Model output is parsed by Zod before any decision. Without a key, persist new jobs as `awaiting_configuration`, leave bookmarks in place, and show the setup state; once settings are saved, resume only those queued new-bookmark jobs. If local preclassification is inconclusive but API-origin access is missing, keep the job pending and ask the user to grant access. If the remote request then fails or returns invalid data, leave the bookmark in place and record/show the error; do not invent a new rule-based move after the failed request.
- `Organizer` re-reads the new bookmark and tree before acting. It only considers a bookmark still under its original source parent. By default, use `folderType` values `bookmarks-bar`, `other`, and `mobile` to identify eligible built-in source roots (Chrome 134+). A nested/user folder is preserved unless force-organize is on. Never target a non-folder, missing ID, managed/unmodifiable folder, the source itself, or an invalid/cyclic destination. Existing-folder moves may be automatic only when mode is automatic and confidence meets the configured threshold; every new-folder suggestion and every confirmation-mode result stays pending until the user approves it.
- `NotificationService` stores review state before showing a notification. A notification click is a user gesture that opens the extension review page with the pending item ID; no side-panel assumption is used.
- UI pages communicate through a discriminated, typed `runtime.sendMessage` contract. The background is the single writer for browser mutations and durable task transitions. Review approval revalidates the bookmark, parent folder, and requested destination before moving/creating.

## Background lifecycle and failure handling

1. Register `bookmarks.onCreated`, `onImportBegan`, `onImportEnded`, startup/install, alarm, notification, and runtime-message listeners synchronously at background module initialization, before any awaited storage work.
2. On `onCreated`, reject folders, unsupported URL schemes, disabled automation, ineligible source folders, and active imports. Put a job in local storage before starting classification. Use an in-memory in-flight map only as a same-worker optimization; the persisted bookmark ID is the idempotency key.
3. Persist import start time and suppress new-bookmark classification until `onImportEnded`. Expire a stale import marker after a conservative timeout. The import signal covers Chrome's import flow, not arbitrary rapid API-created batches; cap concurrent requests and apply a burst guard as a second safety net.
4. On worker startup and alarms, resume queued/retryable jobs from storage. Retry transient provider/network errors a small bounded number of times with alarms; do not retry schema-invalid output or stale/deleted bookmarks indefinitely. Preserve the bookmark on every error. Register the alarm listener synchronously and recreate required alarms after worker startup because alarm persistence may vary by Chrome version.
5. For a move, persist an operation intent `{operationId, bookmarkId, fromFolderId, toFolderId, state}` before calling the API; mark it complete after the move response. On recovery, compare the bookmark's actual parent with both recorded parents and reconcile instead of moving twice. Undo only the latest completed automatic move, verify the bookmark and original folder still exist, then move back and consume the undo record. If undo cannot safely complete, retain current placement and show the reason.
6. Make review approval idempotent by suggestion ID. Before creating a folder, check for an existing child with the suggested normalized name; persist its ID before moving the bookmark. A repeated approval reuses the folder and completes the same suggestion rather than creating duplicate folders.

## Manifest and privacy decisions

- Required permissions: `bookmarks`, `storage`, `notifications`, and `alarms` (alarms are used for bounded retry/resume). Do not request `tabs`, `activeTab`, or website access for bookmark classification.
- Declare no static `host_permissions`. For a configured provider, declare `optional_host_permissions` broad enough for HTTPS plus loopback HTTP, then request only the entered API origin from a user-click handler in Settings. Restrict remote cleartext HTTP; support HTTPS endpoints and loopback HTTP endpoints for local compatible servers. Host permission patterns cannot be narrowed by URL path, but can specify scheme/host/port; request that exact origin and document that the key is sent to it.
- On first run, the automatic-organization preference defaults on with threshold `0.85`, root-only source eligibility, automatic existing-folder moves, new-folder confirmation, and notifications enabled. Effective processing remains blocked until an API key is configured; after that, local cache/rules can run without host access, while AI-bound jobs wait for the configured origin permission. The UI shows each setup state. All settings can be changed from the options page.
- Store a bounded recent activity log (for example, the latest 100 records) and no full bookmark tree snapshot beyond the short-lived classification job. A tree snapshot is held only in memory for one request.
- Chrome 134+ is declared as the minimum supported version to rely on the documented `BookmarkTreeNode.folderType` field rather than guess from localized folder names or hard-coded IDs.

## UI behavior

- Popup: automation switch, provider/rules status, pending count, recent bookmark/action cards, undo-last-move control, and settings link.
- Settings: required provider URL/model/key form, exact-origin permission request and connection test, threshold, automatic/confirm mode, force-organize, separate review/failure and optional success notifications, and recent log. Show a persistent Chinese warning that local extension storage is not high-security key management.
- Review: show title, URL, recommendation, reason, classifier source, and the valid primary action for that recommendation (`移动到文件夹` or `创建文件夹并归档`) plus `保留原位`. If the bookmark or target folder disappeared, disable approval and offer a clear status.
- Follow the system light/dark preference. UI strings are Chinese and React renders user text as escaped text; do not render AI/user text as HTML.

## Compatibility and rollout

This is a local, single-browser extension with no server migration or cloud data. `pnpm dev` uses WXT's Chrome dev target; production artifact is `.output/chrome-mv3/` and is loaded with Chrome's developer-mode “Load unpacked”. Replacing the extension build preserves Chrome bookmarks because the extension only uses the Bookmarks API; local extension settings/activity are browser-local and may be reset if the extension ID/profile storage changes.

## Key trade-offs

- The accepted root-only policy is a safe approximation because Chrome does not expose whether a built-in root was chosen deliberately. Users who want every location reorganized can opt into force-organize; user-created folders otherwise remain authoritative.
- Custom OpenAI-compatible endpoints need an optional permission declaration broad enough to cover an unknown host, but permission is not granted at install. At runtime ask only for the configured origin from a user action, and do not add static website access.
- Local cache and deterministic rules reduce remote API calls after the required key is configured. A configured AI provider failing after those checks is different: preserve the bookmark instead of turning a provider outage into an unreviewed rule-based move. Pure local-only mode is deferred to P2.
