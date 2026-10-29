# Validation and delivery

## Result

Independent per-bookmark classification and cross-path cache reuse are implemented. User approved the final planning summary before execution. Implementation and final validation are complete. The user subsequently authorized committing/pushing this work and archiving the task. Release publishing remains outside scope.

## Changed files

- `services/classifier.service.ts`: common single-item lookup and dual-mode policy context; independently ranked candidate groups; provider calls for misses only; validated member aliases and complete group caches; variant and credential checks inside related cache writes.
- `lib/ai/prompts.ts`: remove same-batch topic grouping and require independent per-bookmark decisions.
- `types/domain.ts`: version-3 cache entries; version-2 entries cold-miss.
- `tests/classifier.test.ts`: overlap, both reuse directions, order, candidate groups, dual-mode policy invalidation, trusted partial success, full-batch fallback after single-entry eviction, write-time variants, and capacity.
- `tests/openai-compatible.test.ts`: independent prompt semantics, strict invalid indexes, and adjusted real-provider variant/fallback assertions.
- `tests/repository.test.ts`: new entry version fixtures and explicit version-2 cold invalidation while preserving unrelated state.
- `tests/organizer.service.test.ts`: real historical-classifier integration now submits only the changed member.
- `README.md`: user-visible independent classification, shared item cache and candidate grouping behavior.
- `.trellis/spec/backend/extension-runtime-contract.md`: revised executable cache identity/provenance, grouping, validation, storage, and regression contract.
- Task artifacts: PRD, design, execution plan, research, curated implement/check manifests, task record, and this validation record.

## Observed behavior

| Scenario | Observed provider work |
|---|---|
| Batch `[A,B]`, then overlapping `[B,C]` | First `[A,B]`, then only `[C]`; B is cache |
| Batch `[A,B]`, then single A | No single provider call; A is cache |
| Single A, then batch `[A,B]` | Batch provider receives only B |
| Reorder fully cached members | No new provider call; original outcome order preserved |
| Delete single entries but retain valid complete batch | Complete batch cache hit; `cacheValidation` remains valid |
| Complete mapped response with an invalid target sibling | Cache valid member only; no partial batch entry |
| Large-tree divergent candidates | Group identical independent contexts; candidates unchanged by companions/order/hits |
| Historical scan of 30 bookmarks, then change one | Provider input counts across cold/change calls: `[15,15,1]` |

Historical coverage clears jobs/reviews before proving warm cache reuse. The immediate repeated scan separately proves deduplication, not cache hits. Count submitted members separately from provider invocations and transport retries. No actual provider billing was measured.

## Checks

- Implementation focused gate: 5 files, 186 tests passed; typecheck and diff check passed.
- Independent review found no product-logic blocker. Reviewer added a missing positive full-batch-cache regression, then reran typecheck and the complete suite.
- Final `pnpm typecheck`: passed.
- Final `pnpm test --run`: 12 files, 248 tests passed.
- `pnpm build`: passed; `.output/chrome-mv3/`, reported total 582.61 kB. Only the existing Zod annotation warning was reported. Final later edit was test-only; no product source changed after this build.
- `git diff --check`: passed.
- No lint command exists.
- Planning manifest validation passed. Runtime spec exceeds the per-file injection size; both agents were instructed to read the full referenced file directly.

## Remaining limits

No Chrome extension smoke test or real model request was performed. Divergent candidates can split one processing batch into multiple requests. Single and complete-batch representations share the unchanged 200-result budget, so duplicate representations can evict earlier. A missing/duplicate-index or other untrustworthy provider response still fails as a whole; no parser salvage was added.

No dependencies, UI, configuration switches, organizer product logic, scan scope, or page-content collection were changed. At the validation checkpoint no commit, archive, or publish action had been taken. Commit/push and task archive were authorized in a subsequent user message.
