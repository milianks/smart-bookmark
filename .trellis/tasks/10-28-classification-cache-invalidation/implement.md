# Implementation checklist

## Before implementation

- [x] Resume the existing `in_progress` task. Planning artifacts and production changes already existed at session entry; no new task or planning phase was created.
- [x] Read curated implementation context and the backend runtime, persistence and quality specifications; verify current git status and any new local changes.
- [x] Confirm the request-identity and credential-generation design against the actual provider/repository interfaces. If an implementation cannot establish strict context equivalence, skip that cache hit instead of weakening the requirement.

## Implementation order

1. Add focused regression fixtures for deterministic precedence, raw input and provider-visible folder/correction/batch changes. Include a stable over-budget irrelevant-folder case with call-count comparison.
2. Refactor single and batch classification to re-evaluate corrections, preferences and rules before looking up AI cache; preserve existing permission/configuration/failure contracts.
3. Add versioned privacy-preserving single and whole-batch request identity and safe persistence, old-entry cold misses, capacity handling, credential-change protection, result normalization and target validation.
4. Handle provider request variants conservatively and account for in-flight state changes. Keep cache reads/writes unable to produce partial successful batches.
5. Add integration coverage using the real cache during historical scan, including deduplication and batch-boundary assertions.
6. Update the backend runtime spec's blanket full-tree invalidation contract to match the approved behavior; also reconcile its existing candidate-budget description with the actual implementation and regression tests without silently changing the ranking policy.
7. Compare old/new cold and warm call counts for fixed and changed batches and historical scans; report the whole-batch trade-off, permission behavior, cache-size bounds, credential races and downgrade compatibility.
8. Run independent review and resolve findings before concluding.

## Validation

```bash
pnpm test --run tests/classifier.test.ts tests/organizer.service.test.ts tests/scan.service.test.ts tests/openai-compatible.test.ts
pnpm test --run
pnpm typecheck
pnpm build
```

Count provider classification calls and input items separately from HTTP fallback/retries. Include legacy persisted-state loading and privacy checks. Verify that the irrelevant-folder fixture would miss under the prior key, and that a repeated scan actually invokes the classifier rather than merely skipping existing jobs.

## Risk and rollback

Changes to `services/classifier.service.ts`, `lib/ai/openai-compatible.ts`, `lib/storage/repository.ts`, `types/domain.ts`, and batch preparation in `services/organizer.service.ts` require particular review. Preserve the old persisted state and use versioned cache misses so rolling code back does not lose bookmarks, settings, jobs or reviews. If strict equivalence or safe cache persistence cannot be established, disable reuse for the affected request instead of accepting stale results.

## Completion evidence

Implementation steps 1–8 and automated acceptance criteria are verified. See [validation.md](./validation.md) for independent review, the complete quality gate, actual old/new provider-call measurements, affected files and remaining limits. The user approved the work commit and task archival. Record the session journal after archival; no push was requested.
