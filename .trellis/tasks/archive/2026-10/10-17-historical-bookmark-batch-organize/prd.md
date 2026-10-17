# 历史书签扫描与批量整理

## Goal

为已有 Chrome 书签提供可预览、可确认、可撤销的批量分类整理能力。

## Background and Confirmed Facts

- Current P0 only handles one `chrome.bookmarks.onCreated` event at a time.
- `ChromeBookmarkService.getTree()` already exposes the complete bookmark tree.
- `OrganizerService` owns classification, review creation, bookmark mutation, recovery, undo, and persisted job state.
- The background service worker is the only layer allowed to mutate Chrome bookmarks.
- Runtime messages currently have no scan, batch, or bulk-review operation.
- The popup shows recent jobs and pending reviews; the review page approves or rejects one review item at a time.
- Persistent state is versioned local `chrome.storage.local` state. Existing jobs are keyed by bookmark ID and existing reviews are durable.
- Existing safety rule preserves bookmarks in user-created folders unless force mode is enabled; managed folders remain unmodifiable.

## Requirements

- Add an explicit user-triggered historical scan entry point from the extension UI.
- Enumerate eligible existing bookmark items from the current Chrome bookmark tree and deduplicate against existing jobs/reviews or a completed scan record.
- Reuse the existing folder discovery, rule/cache/AI classifier, target validation, review, mutation recovery, activity, and undo mechanisms.
- Persist scan progress and per-bookmark outcomes so worker restarts do not silently lose work or reprocess the same bookmark.
- Show a preview containing each proposed action, source folder, target folder or new-folder suggestion, confidence, reason, and current status before any destructive move.
- Support explicit approval/rejection for proposed moves and new-folder suggestions; preserve the bookmark when rejected, stale, deleted, or otherwise unsafe.
- Provide batch-level progress, counts, and failure visibility in the popup or review page.
- Keep API keys out of UI state, logs, notifications, and persisted records outside the existing local settings field.

## Key Product Decision

- Historical scans always run in preview/confirm mode, regardless of the normal new-bookmark automatic mode. A scan never moves a bookmark or creates a folder until the user approves the proposed operation.
- Historical scans use the existing protection boundary: direct children of editable built-in roots are eligible by default; bookmarks inside user-created folders are included only when force mode is enabled. Managed folders and non-HTTP URLs remain excluded.
- Review supports both per-item approval/rejection and a guarded action to approve all currently valid proposals. Each item is still revalidated before mutation, so stale or manually moved bookmarks are skipped without blocking the rest of the batch.

## Acceptance Criteria

- [ ] User can start a historical scan from the extension UI without a new tab or direct bookmark mutation from the UI.
- [ ] Scan enumerates supported existing bookmarks, skips folders, managed roots, unsupported URLs, and items already covered by the scan/job state according to the documented scope.
- [ ] Scan progress and per-item results survive a service-worker restart and remain visible after reopening the popup/review page.
- [ ] No bookmark moves or folder creations occur before the user approves a proposed operation.
- [ ] Preview shows source and destination information plus confidence, reason, and actionable status for each item.
- [ ] Approving a valid proposal moves the bookmark or creates the proposed folder through `OrganizerService`; rejecting it leaves the bookmark in place.
- [ ] Deleted or manually moved bookmarks become stale and are not overwritten; failed provider calls leave the bookmark in place and expose a bounded error.
- [ ] Batch review and individual review paths cannot duplicate a move, folder creation, or review outcome.
- [ ] Existing P0 new-bookmark processing, review approval, undo, import suppression, and provider-permission behavior remain unchanged.
- [ ] `pnpm typecheck`, `pnpm test --run`, and `pnpm build` pass with focused tests for scan enumeration, persistence/recovery, preview-only behavior, approval/rejection, stale items, and duplicate/concurrent requests.

## Out of Scope

- Web-page content extraction, semantic search, knowledge-base Q&A, multi-provider support, and cross-device synchronization.
- Automatic background rescans or scheduled library reorganization.
- Permanent deletion, bookmark deduplication, or folder renaming.
