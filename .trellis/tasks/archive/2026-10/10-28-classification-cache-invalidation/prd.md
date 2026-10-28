# Refine classification cache invalidation

## Goal

Reduce unnecessary classification provider calls after folder changes that do not affect the actual classification, including historical scans, without reusing results from a different relevant context.

## Background

- The current cache key fingerprints all supplied folder summaries. Any included folder name, path, or sampled bookmark change causes a different key even when the changed folder is irrelevant to a particular provider request (`services/classifier.service.ts:172-202`). The old entry is not proactively deleted.
- Folder ranking and local rules depend on the full folder list; candidate truncation is not guaranteed, and recent corrections can reference paths outside the selected candidates (`lib/ai/rule-classifier.ts:37-69,123-178`; `services/classifier.service.ts:252-265`). Therefore a candidate-only key is not sufficient without re-evaluating the deterministic decisions and the complete provider context.
- Cache lookup currently precedes corrections, preferences and rules. Existing keys omit some inputs, including `parentId`, correction and preference state, the confidence threshold, and batch context (`services/classifier.service.ts:53-88,97-147,172-192`).
- Batch prompts contain ordered bookmarks and a shared candidate list and allow bookmarks in the same request to influence each other (`services/classifier.service.ts:125-145,164-169`; `lib/ai/prompts.ts:74-104`).
- Same-input single-bookmark cache reuse is already tested (`tests/classifier.test.ts:121-146`). Historical scans skip bookmark IDs with existing jobs or reviews, so an immediate second scan with zero calls alone does not demonstrate a cache hit (`services/scan.service.ts:40-49`).

## Requirements

1. Re-evaluate corrections, preferences and deterministic classification against the current relevant state before an AI cache hit can be accepted. Respect current permission, configuration and confidence-threshold behavior.
2. Reuse AI results only when their relevant, observable request context matches: the original bookmark input, ordered candidate summaries and recent corrections, provider configuration, request mode and, for batches, the ordered batch and its shared context. Do not persist API keys or newly persist raw page content as part of cache identity.
3. Separate single and batch AI cache identities. Reuse an AI batch only as a complete matching batch; otherwise classify the complete current AI batch. Deterministic results may be resolved separately, leaving only the remaining AI items in a provider batch.
4. Reject old or malformed cache entries that cannot prove the new context. Preserve existing extension settings, jobs and reviews, bounded cache storage, result ordering, root restrictions and live target checks. Failed, incomplete or invalid batches must not produce a reusable partial batch. Retain the existing distinction between requests resolved locally or from cache and those requiring provider-origin permission.
5. Limit the work to classification cache correctness, invalidation and its historical-scan integration. No settings or user-interface features are required.

## Acceptance Criteria

- [x] Identical eligible single and complete ordered batch requests reuse valid AI cache entries without another provider classification call. Eligibility requires a complete matching context and a proven matching provider request variant; distinguish provider calls from HTTP retries or fallback, and test the default and fallback paths across worker restart.
- [x] In an over-budget case, change a folder that remains outside the candidate set and does not alter the local decision or actual provider context; the second classification uses the cache. Record the before/after provider-call counts; show that the old full-tree key misses under the same change.
- [x] Changing relevant candidate data, candidate order, `parentId`, recent correction paths, original URL or AI batch members/order prevents an invalid AI cache hit. Recomputed rules correctly reflect changed corrections, preferences and confidence thresholds.
- [x] A mixed deterministic/AI batch sends only items still requiring AI and preserves original result order. A previously cached AI batch is reused only as a whole; a partial or invalid AI batch is reclassified as the complete current AI batch.
- [x] Invalid/deleted/managed targets, malformed and legacy entries, provider failures and incomplete batch responses cannot yield a reusable invalid result; move and review paths retain their existing live checks. Verify real batch-provider responses that contain an `index` field.
- [x] Relevant state changes during batch preparation, after cache lookup or before provider response are detected at the final comparison; stale results are discarded and boundedly retried or safely failed.
- [x] An integration test uses the real classification cache and historical scan with a fake provider, distinguishes job/review deduplication from cache hits, checks batch boundaries and counts both provider invocations and inputs per invocation.
- [x] Existing persisted state continues to load; prior cache entries are safely cold misses. Tests cover old-code access to new state, credential changes and bounded whole-batch eviction; API keys and raw page content are not introduced into cache identity, logs or public output.
- [x] Permission tests cover missing key, missing provider-origin permission, eligible single cache/local results and mixed batches. Preserve the existing batch-level permission-required behavior when any item still needs a provider.
- [x] Compare old and new cold and warm provider-call counts for fixed identical batches, changed batches, and historical scans. Report regressions where strict matching prevents partial reuse rather than claiming universal cost savings.
- [x] `pnpm test --run`, `pnpm typecheck` and `pnpm build` pass.

## Scope Exclusions

Scaffolding cleanup, dependency pinning, component tests, lint/format tooling, local models, full-text or semantic search, scan scope changes and new UI are separate work.

## Key Decision and Limitations

- The user selected strict reuse based on relevant observable context over higher hit rates that may reuse stale decisions.
- Strict batch matching means individual AI results from one request cannot be combined with a newly reduced request. Whole-batch invalidation may increase calls when a batch changes.
- If all folders are sent, an apparent unrelated folder change may still change the request and legitimately cause a miss. Remote providers may silently change behavior without a client-visible configuration change; identical input does not guarantee identical model output.
