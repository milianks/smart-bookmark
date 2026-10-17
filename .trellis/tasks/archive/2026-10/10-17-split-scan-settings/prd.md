# PRD: Batch 1 Split Scan and Settings Services

## Goal

Extract historical scan and settings responsibilities from the 1063-line OrganizerService while preserving current behavior and runtime contracts.

## Requirements

- Move scan start and batch-approval orchestration to services/scan.service.ts.
- Move scan progress transitions and dashboard projection to services/scan-state.ts.
- Move appendActivity to services/activity-log.ts for use by Organizer and ScanService.
- Move settings update, draft read/write, and provider test to services/settings.service.ts.
- Keep bookmark move/create, pending-operation recovery, historical batch undo, and mutation lock in Organizer.
- ScanService performs no Chrome mutation; batch approval calls Organizer approveReview through a narrow callback.
- Do not change PersistedState, runtime request union, dashboard projection, or error behavior.

## Acceptance criteria

- [x] Organizer no longer implements scan start/batch approval or settings/draft/provider-test behavior; historical undo and all bookmark mutation remain in Organizer.
- [x] New services have direct unit tests; all existing Organizer assertions are accounted for and no assertions are removed.
- [x] Scan and batch-approval concurrency locks, scan state refresh, worker recovery, and historical undo skip behavior remain unchanged.
- [x] Settings update still triggers Organizer resume; drafts and provider test do not write extra state.
- [x] `pnpm typecheck`, `pnpm test --run`, `pnpm build`, and `git diff --check` pass.

## Out of scope

- Completing activity-log extraction, background router separation, storage sharding, or UI changes.
