# Implementation Plan: Bookmark Architecture Refactor

## Ordered plan

1. Review and approve the Batch 1 plan, then start 10-17-split-scan-settings.
2. Extract scan/settings services and pure helpers; keep historical undo and bookmark mutation in Organizer.
3. Pass the quality gate and commit Batch 1 with its hash and rollback point recorded.
4. Start Batch 2; complete activity-log extraction and clarify Organizer approval steps.
5. Pass the quality gate and commit Batch 2.
6. Start Batch 3; move runtime schema/router while preserving background assembly boundaries.
7. Pass the quality gate and commit Batch 3.
8. Update backend/runtime specs and run parent acceptance checks — complete.
9. Archive the parent task after all three child tasks are archived.
## Required checks per batch

    pnpm typecheck
    pnpm test --run
    pnpm build
    git diff --check

## Manual checks

- New-bookmark auto classification, confirm mode, review approve/reject, and undo.
- Historical scan start, worker restart during scan, batch approval, and historical undo.
- Missing API key, missing provider permission, and provider failure.
- Settings drafts, provider test, and malformed runtime messages.

## Stop conditions

- If PersistedState or runtime-message behavior must change, return to PRD review before continuing.
- If an existing test assertion must change, record behavioral evidence and wait for review before editing it.
- Keep untracked .claude/ and .omc/ work files outside product commits.
