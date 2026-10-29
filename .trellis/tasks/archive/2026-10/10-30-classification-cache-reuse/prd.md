# Reuse classification results across single and batch requests

## Goal

Avoid paying repeatedly to classify the same bookmark through single processing, historical scans, reordered batches, and overlapping batches. Send only cache misses to the provider while preserving validation and bookmark mutation safeguards.

## Background

- Current related commit: `8f95335`. Single requests read/write single keys (`services/classifier.service.ts:71-98`); batches require an entire ordered pending batch and write only when all members are valid (`services/classifier.service.ts:132-174`).
- Tests require reclassification after reordering/changing a batch and after switching from batch to single (`tests/classifier.test.ts:424-440`), and reject caching partial invalid/missing batches (`tests/classifier.test.ts:580-602`). Initial inspection ran these two tests: 2 passed.
- Batch prompts combine independent suggestions with same-batch topic grouping (`lib/ai/prompts.ts:83-86`). Shared candidates derive from up to eight pending inputs (`services/classifier.service.ts:192-197`), unlike single candidates.
- Single/batch prompts, schemas, and token parameters differ (`lib/ai/openai-compatible.ts:120-137`). The current runtime contract requires separate provenance and whole-batch reuse (`.trellis/spec/backend/extension-runtime-contract.md:128-131`); this task intentionally revises that policy.

## Confirmed Product Decision

The user approved independent per-bookmark classification. Remove same-batch topic grouping; batching combines requests for transport efficiency. Eligible prior results can be reused across paths. This accepts a shared decision policy, without claiming identical single/batch HTTP requests or identical stochastic model output.

## Requirements

- R1: Preserve corrections, preferences, and deterministic-rule precedence. Look up eligible single-item entries for remaining inputs; request only misses.
- R2: Retain complete batch caching and store each validated successful member under the same single-item identity used by `classify`. Per-member success survives another member's invalid target when response mapping is trustworthy. Never cache an invalid member or an incomplete/misindexed response whose mapping cannot be established.
- R3: Preserve outcome order, source labels, `cacheValidation`, permissions, credential isolation, and live pre-mutation checks. Independently derive each bookmark's candidates so its context does not depend on other misses. Existing safeguards: `services/classifier.service.ts:213-268,335-344`.
- R4: Preserve settings, jobs, reviews, and storage bounds (`types/domain.ts:231-246`). Old entries may become cold misses. Update conflicting tests, README behavior, and runtime contracts.
- R5: Prove actual reuse in historical processing. Distinguish job/review deduplication from cache hits; count calls and submitted inputs.

## Acceptance Criteria

- AC1 (R1, R2): After `[A,B]`, `[B,C]` returns B from cache; the second provider batch contains only C. Outcomes remain in B,C order.
- AC2 (R1, R2): Batch `[A,B]` then single A produces a cache hit without a single provider call. Single A then batch `[A,B]` submits only B.
- AC3 (R1, R3): Warm identical batches and reordered cached inputs need no calls. Mixed rule/cache/AI outcomes retain positions. All-hit batches work without provider-origin permission; a miss requires permission before any provider request.
- AC4 (R2-R4): Deleted/managed targets, malformed entries, changed relevant candidates/input/configuration/corrections, credentials, and variants cannot produce invalid hits. Cover partial target failure, missing/duplicate indexes, fallback, worker restart, and in-flight changes.
- AC5 (R4, R5): Historical integration uses the real classifier with a fake provider, verifies scan boundaries and submitted members, and proves reuse after clearing only deduplication state.
- AC6 (R3): An over-budget folder fixture proves each bookmark retains its own ordered candidates when companions, order, or cache hits change. Incompatible candidate contexts are not falsely equivalent.
- AC7 (R4): Combined batch and single entries obey 200 stored results and 64 KiB per entry. Old entries are not silently reinterpreted; unrelated state survives.
- AC8 (R1-R5): `pnpm typecheck`, `pnpm test --run`, `pnpm build`, and `git diff --check` pass.

## Out of Scope

New dependencies, UI, configuration switches, scan scope changes, new page-content collection, provider parser salvage after an untrustworthy response, real provider calls, commits, and publishing.

## Risks and Limits

- A provider request can still fail as a whole; salvage only validated returned members with trustworthy mapping.
- Different per-item candidates may need several transport batches. Ordinary shared candidates remain one batch; report divergent cases honestly.
- Batch plus single representations consume the existing cache budget faster, causing legitimate eviction misses.
- Removing grouping instructions cannot guarantee a nondeterministic model ignores every neighboring input; approved reuse does not promise equality to fresh inference.

## Artifact Status

PRD convergence pass complete. The user explicitly approved the final planning summary, the task entered `in_progress`, and implementation is complete. Design, execution plan, research, and curated dispatch manifests accompany this PRD. Independent review and final validation are recorded in `validation.md`; the user subsequently authorized commit/push and task archive; release publishing remains outside scope.
