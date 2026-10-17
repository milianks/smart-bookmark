# Technical Design: Bookmark Architecture Refactor

## Target boundaries

    entrypoints/background.ts
      - adapters and service dependency assembly
      - synchronous Chrome listener registration
      - router.handleRequest(...)
    services/
      - organizer.service.ts: live queue, classification, review, bookmark mutation, recovery
      - scan.service.ts: scan start and batch approval coordination
      - scan-state.ts: pure historical scan state transitions and dashboard projection
      - settings.service.ts: settings, drafts, provider test
      - activity-log.ts: pure append/prune transformations
    lib/ -> types/

Organizer retains cross-domain coordination and bookmark mutation ownership. ScanService never calls chrome.bookmarks.move/create directly. Batch approval delegates each item to Organizer's validated review flow. Historical batch undo remains in Organizer because it shares the mutation lock and pending-operation recovery path with other bookmark mutations. SettingsService persists settings and tests the provider; background injects an after-update callback that resumes Organizer.

## Contracts

- StateRepository remains the only persisted-state read/write boundary. Repository mutators stay synchronous.
- ScanService depends on BookmarkPort, StateRepository, now/makeId, and narrow workflow callbacks for processPending and approveReview.
- scan-state.ts contains shared pure transitions used by Organizer and ScanService; it imports no service classes.
- SettingsService depends on StateRepository, ClassifierPort, and hasProviderPermission.
- activity-log.ts depends only on domain types, state data, and an ID factory; it does not depend on Chrome, providers, or service classes. Batch 1 extracts appendActivity for ScanService; Batch 2 completes the module with pruneJobs.
- router.ts exports strict RequestSchema and handleRequest. Routing calls service facades and does not access storage or bookmarks.

## Compatibility

- Do not change PersistedState fields, version, storage key, or the RuntimeRequest discriminated union.
- Keep bookmark mutation and recovery methods on OrganizerService.
- Keep background listener timing, storage access level, response envelope, and provider-origin normalization unchanged.
- Add no dependency, permission, network request, or storage key.

## Migration and rollback

Each child task creates one commit. Revert only the current child commit on regression; do not roll back chrome.storage.local user state or earlier completed batches. Migrate tests by an explicit case-by-case checklist and preserve existing assertions.
