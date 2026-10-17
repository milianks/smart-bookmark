# PRD: Bookmark Architecture Refactor

## Goal

Implement the architecture plan in product code. Split historical scan, settings, and activity-log responsibilities out of Organizer, then move background runtime message routing into its own module. Preserve current bookmark behavior, persisted format, runtime contract, and permission boundaries.

## Confirmed facts

- services/organizer.service.ts is 1063 lines and owns event handling, job recovery, historical scan, review approval, settings, undo, and activity logging.
- entrypoints/background.ts is 154 lines and combines dependency assembly, Zod runtime schema, request routing, and Chrome listeners.
- Scan, settings, and Organizer share one PersistedState through StateRepository; writes must continue through load/update.
- Existing Organizer coverage has 37 tests across tests/organizer.test.ts and tests/organizer.service.test.ts.
- Task 10-17-arch-plan delivered planning only. This follow-up implements the planned refactor in three independently revertible tasks.

## Requirements

- R1. Split responsibilities in three batches: scan/settings, activity logging/Organizer pipeline, and background message routing.
- R2. Preserve dependency direction entrypoints -> services -> lib -> types. Do not create service cycles through global state or imports of concrete peer implementations.
- R3. Organizer remains the sole owner of bookmark moves, folder creation, pending-operation recovery, and mutation locking.
- R4. Keep PersistedState, storage key/version, runtime request/response shapes, API-key isolation, and provider-origin permission behavior compatible.
- R5. Each batch passes pnpm typecheck, pnpm test --run, pnpm build, and git diff --check and can be reverted independently.
- R6. Test migration must not remove existing assertions. New service boundaries need direct tests for concurrency, worker recovery, and stale state.

## Scope

### In scope

- Batch 1: scan.service.ts, scan-state.ts, settings.service.ts, and shared activity append helper.
- Batch 2: complete activity-log.ts and clarify private steps in Organizer review approval.
- Batch 3: entrypoints/background/router.ts, leaving background focused on assembly and listener registration.
- Related test migration, boundary tests, spec updates, and one commit per batch.

### Out of scope

- Summary/tag generation, webpage extraction, UI redesign, multiple providers, or synchronization.
- Splitting PersistedState into multiple storage keys; create a separate task only if the documented size/latency trigger is met.
- Changes to classification policy, review semantics, provider protocols, or permission scope.
- Cleanup of untracked .claude/ and .omc/ work files; they are outside the product architecture scope.

## Acceptance criteria

- [x] Batch 1 places scan-start/batch-approval orchestration and settings behavior in separate services while preserving runtime messages.
- [x] Batch 2 moves remaining activity-log transformations out of Organizer; approval and undo retain the same mutation lock and pending-intent recovery.
- [x] Batch 3 removes RequestSchema and handleRequest definitions from background.ts while preserving strict validation and the error boundary.
- [x] All existing and new tests pass; no API keys, provider payloads, or full bookmark trees cross public boundaries.
- [x] Each child task has an independent commit, verification record, and rollback point. Archive the parent after all three children finish.

## Ordering and decisions

- Required order: Batch 1, then Batch 2, then Batch 3.
- Cross-service cooperation uses narrow typed callbacks/ports assembled by Organizer or background.
- Keep bookmark mutation in Organizer; historical batch undo remains in Organizer because it shares mutation locking and pending-operation recovery.
- Batch 3 moves routing without changing the request union.
- Review each child plan before starting implementation. Parent remains in planning.
