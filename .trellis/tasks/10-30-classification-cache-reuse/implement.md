# Implementation plan

## Prerequisites

The user approved independent per-bookmark semantics and subsequently approved the final PRD/design/plan. The task entered `in_progress` and implementation was dispatched. This is one coupled classifier/prompt/cache contract task; separate child tasks would not provide independently useful deliverables.

Codex mode is auto. `trellis-implement` completed product code and focused validation; `trellis-check` performed independent review and the final project gate. Main session owns coordination and spec updates. The user subsequently authorized commit/push and task archive. See `validation.md` for results.

Context validation passes, but the runtime contract exceeds the 32-KiB per-file injection limit. Dispatched agents must read the referenced contract directly when injected content is truncated; do not change global injection settings for this task.

## Ordered work

1. Recheck worktree and read curated specs/task artifacts. Establish focused regression coverage demonstrating missing overlap and bidirectional reuse.
2. Remove batch topic grouping. Derive candidates per input and group misses with equal contexts; preserve original indexes and permission checks.
3. Implement canonical shared per-item context and new policy version using existing request builders and bounded variant validation. Coordinate schema/prefix/fixtures; preserve actual-request checks before seeding aliases.
4. Add per-item lookup, request only misses, retain complete group batch caching, and persist validated individual successes. Never store invalid members or partial batch entries; use existing repository normalization and credential checks.
5. Update service/provider/storage tests. Cover divergent candidate contexts, partial target failures versus untrustworthy responses, fallback/restart, credentials, permissions, and stale cached results.
6. Update historical integration with real classifier and fake provider: 15-item boundaries, cleared deduplication state, overlap/single reuse, calls and member counts. Change obsolete whole-batch expectations without weakening live mutation/retry assertions.
7. Update README and `.trellis/spec/backend/extension-runtime-contract.md` with independent decisions, alias provenance, grouping, failure limits, versioning, and bounds.
8. Dispatch final review, resolve concrete findings, run complete gate, inspect final diff, and report exact files and observed counts. Stop before commit/archive/publish.

## Validation

Focused iteration:

```bash
pnpm test --run tests/classifier.test.ts tests/openai-compatible.test.ts tests/repository.test.ts
pnpm test --run tests/organizer.service.test.ts tests/scan.service.test.ts
```

Final gate after the final product edit:

```bash
pnpm typecheck
pnpm test --run
pnpm build
git diff --check
```

Tests run with mock providers under Node. Do not claim Chrome or live model validation.

## Impact and rollback

- Primary code: `services/classifier.service.ts`, `lib/ai/prompts.ts`, `types/domain.ts`. Change `lib/ai/openai-compatible.ts` and `lib/storage/repository.ts` only where the shared context/write contract requires it.
- Tests/fixtures: `tests/classifier.test.ts`, `tests/openai-compatible.test.ts`, `tests/repository.test.ts`, `tests/organizer.service.test.ts`, and affected scan fixtures.
- Docs: README and backend runtime contract. Preserve archived tasks and unrelated worktree edits.
- Measure shared-context and divergent-candidate cases separately. Extra requests in divergent contexts must not be hidden by weakening candidate correctness.
- Revert coordinated policy/code changes together. Cache may cold-start; no user-data cleanup is needed.

## Start gate

- [x] Product decision recorded; no unresolved user decisions.
- [x] Observable acceptance criteria and source anchors.
- [x] Design covers provenance, candidates, failures, compatibility, and limits.
- [x] Real spec/research references curated for implement and check.
- [x] Final planning summary explicitly approved in a subsequent message (user: 批准).
- [x] After approval, ran `task.py start` and dispatched `trellis-implement`.
