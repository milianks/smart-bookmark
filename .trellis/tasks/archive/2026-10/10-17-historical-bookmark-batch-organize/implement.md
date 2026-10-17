# Implementation Plan

## Ordered Checklist

1. Extend domain state and normalization with historical scan status, scan metadata on jobs/reviews, and latest historical batch undo records; preserve version-1 stored data and add normalization tests.
2. Extend typed runtime requests, response data, and background Zod validation for scan start, batch approval, scan undo, and dashboard scan summaries.
3. Add bookmark-tree enumeration helpers and tests for HTTP URLs, direct built-in-root children, force-mode descendants, managed folders, duplicate IDs, and unsupported nodes.
4. Refactor `OrganizerService` classification/review paths so historical jobs are durable, forced-preview, resumable, deduplicated, and progress-accounted without changing P0 new-bookmark behavior.
5. Implement sequential batch approval, durable pending-intent tagging, per-item failure isolation, worker-restart reconciliation, historical batch undo, and focused service tests for stale/manual moves, rejected moves, duplicate requests, and partial batch failure.
6. Wire background message handlers and startup/alarm recovery; verify all bookmark mutation remains behind `OrganizerService`.
7. Add popup scan controls and progress/error presentation; extend the review page with historical grouping, per-item controls, approve-all, and batch undo using shared UI primitives.
8. Update README current scope and user workflow for historical scanning, forced preview, protected scan boundary, and batch undo.
9. Run the quality gate, inspect the production manifest, review the diff, and perform a manual Chrome flow with a disposable bookmark set.

## Validation Commands

```bash
pnpm typecheck
pnpm test --run
pnpm build
```

Manual validation:

- Start a scan with no API key and confirm waiting state, no bookmark mutation, and resume after configuration.
- Scan direct children of built-in roots and confirm nested user-folder items are skipped unless force mode is enabled.
- Confirm all move/new-folder proposals appear before mutation, then approve one item and approve all remaining valid items.
- Move or delete a proposed bookmark before approval and confirm it becomes stale without overwriting the user's change.
- Restart/reload the extension during classification and during approval; confirm no duplicate reviews or moves.
- Undo the latest historical batch and confirm only still-targeted bookmarks move back; manually moved/deleted items remain untouched.

## Risky Files and Rollback Points

- `types/domain.ts`, `lib/storage/repository.ts`: persisted shape and normalization. Roll back together if old state loading fails.
- `services/organizer.service.ts`, `services/bookmark.service.ts`: classification and mutation safety. Keep focused service tests green before UI work.
- `entrypoints/background.ts`, `types/messages.ts`: runtime contract. Reject malformed requests before dispatch.
- `components/PopupApp.tsx`, `components/ReviewApp.tsx`: user-facing batch controls. Revert UI independently if backend remains safe.

## Review Gates

- Do not call `task.py start` until PRD, design, implement, and context manifests are complete and the final planning summary is approved.
- Do not report completion until typecheck, all tests, production build, and manual mutation-safety checks pass.
