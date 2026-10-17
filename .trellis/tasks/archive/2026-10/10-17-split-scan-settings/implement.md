# Implementation Plan: Batch 1

1. Define typed dependency interfaces for ScanService and SettingsService.
2. Add scan-state.ts and move appendActivity to activity-log.ts. Preserve counters, messages, fields, and ID prefixes.
3. Move scan-start/batch-approval and settings/draft/provider-test method bodies. Keep historical undo and all bookmark mutation in Organizer.
4. Route scan/settings requests from background to the new services. Use scan-state helpers from Organizer recovery paths.
5. Migrate tests and reconcile all 37 existing Organizer cases.
6. Run:

    pnpm typecheck
    pnpm test --run
    pnpm build
    git diff --check

7. Verify rg chrome.bookmarks.(move|create|remove) services/scan.service.ts services/settings.service.ts returns no matches.
8. Commit Batch 1 independently; revert only this commit on regression.
