# Design: Batch 1 Split Scan and Settings Services

## Service boundaries

ScanService owns historical scan start and batch-approval coordination. It persists scan/jobs and owns scan-start and batch-approval locks. It does not move bookmarks.

Dependencies:

- BookmarkPort, StateRepository, clock, and ID factory.
- processPending(): Promise<void>.
- approveReview(id): Promise<void>.

Shared pure functions:

- scan-state.ts refreshes scan counters/status and constructs dashboard summary. Organizer resume, job completion, and Review paths use the same helper.
- activity-log.ts receives appendActivity in Batch 1. Batch 2 adds pruneJobs.

Historical batch undo stays in Organizer. It shares the mutation lock, persisted pending operation, and move recovery path; moving it would expose an overly broad mutation interface.

SettingsService owns settings and draft persistence plus provider test. It depends on StateRepository, ClassifierPort, and hasProviderPermission.

Background constructs Organizer first, then ScanService and SettingsService. Narrow callbacks are injected; no service imports a concrete peer implementation. Settings update calls an injected after-update callback which resumes Organizer. Runtime scan/settings requests route directly to their new services. Organizer continues to own bookmark mutation and recovery.

## Data flow

    background -> ScanService / SettingsService / Organizer
                     |
                     v
               StateRepository
    ScanService -> Organizer callback -> existing review checks and mutation lock

Do not split PersistedState into multiple repositories.

## Test migration

- Move scan-start and batch-approval cases to tests/scan.service.test.ts.
- Keep historical undo and mutation safety cases in Organizer tests.
- Move settings/draft/provider-test cases to tests/settings.service.test.ts.
- Preserve recovery and mutation cases in Organizer tests.
- Reconcile the original 37 test cases before removing any duplicate.
