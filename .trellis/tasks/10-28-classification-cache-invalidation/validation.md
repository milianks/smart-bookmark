# Classification cache validation

## Result

Implementation and automated acceptance checks passed on 2026-10-28. The existing implementation required no additional production-code changes during this continuation. Independent `trellis-check` review found no confirmed defect. The user approved the work commit and task archival; archival and journal recording follow the work commit.

## Quality gate

- `pnpm test --run`: 12 files, 238 tests passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed; output `.output/chrome-mv3/`. Rollup reported dependency comment-annotation warnings in Zod; the production build completed successfully.
- `git diff --check`: passed.
- `python3 ./.trellis/scripts/task.py validate .trellis/tasks/10-28-classification-cache-invalidation`: passed. The runtime spec exceeds the automatic per-file injection limit; reviewers must read the full referenced spec when injection is truncated.
- No lint script exists. Chrome extension smoke testing and live provider calls were not performed.

## Old/new provider-call comparison

Baseline: actual classifier and organizer source from Git `7ad60e2` (`HEAD` at validation time). Comparison: the current working-tree implementation. A temporary Vitest harness used a fake provider with a stable observable request variant, the real classifier, repository, organizer and scan service, and controlled bookmark fixtures. The one benchmark test passed; temporary source/test copies were removed afterward. No production API key or network request was used.

Each table cell reports **additional provider classification invocations / input items**, relative to the previous phase in that scenario. HTTP retries/fallback requests are not provider classification invocations; separate tests cover them.

| Scenario / phase | Old implementation | New implementation |
| --- | --- | --- |
| Single request, cold | 1 / 1 | 1 / 1 |
| Same single request, change only an excluded folder sample | 1 / 1 | 0 / 0 |
| Ordered 15-item batch, cold | 1 / 15 | 1 / 15 |
| Identical batch, warm | 0 / 0 | 0 / 0 |
| Change one member of that batch | 1 / 1 | 1 / 15 |
| Reverse the resulting batch order | 0 / 0 | 1 / 15 |
| Historical scan of 30 items, cold | 2 / 30 | 2 / 30 |
| Repeat scan with existing jobs/reviews | 0 / 0 | 0 / 0 |
| Clear jobs/reviews, repeat scan with cache retained | 0 / 0 | 0 / 0 |
| Change one title, clear jobs/reviews, scan again | 1 / 1 | 1 / 15 |

The single-request fixture asserts equal deterministic decisions and equal ordered provider candidates before/after changing the excluded folder. The baseline performs two total provider calls; the new implementation performs one.

Historical scans use two 15-item boundaries. The immediate repeat skips 30 existing jobs, demonstrating deduplication rather than a cache hit. After clearing jobs/reviews, the scan skips zero items and still makes no new provider call, demonstrating actual cache reuse. Changing item 8 invalidates the first new batch while the second remains cached. Total scan call sizes are `[15, 15, 1]` for old code and `[15, 15, 15]` for new code.

Strict whole-batch matching improves context correctness rather than guaranteeing lower cost for every workload. A changed member reclassifies 15 items instead of one, and reordering adds a call that the old per-item cache avoided.

## Acceptance evidence

- `tests/classifier.test.ts`: deterministic precedence; original URL, candidate order/parent and correction paths; complete ordered batches and mixed local/AI ordering; malformed, deleted/managed and incomplete results; excluded-folder hits; credential A→B→A, in-flight writes, crypto-unavailable misses, and cache privacy.
- `tests/openai-compatible.test.ts`: default/fallback request bodies, restart behavior, reasoning/tool capability changes, concurrent variant invalidation and real transport `index` normalization.
- `tests/repository.test.ts`: legacy/malformed cache cold misses, old-code A→B→A writes, unrelated state preservation, 200-result capacity, whole-batch eviction and the 64 KiB entry ceiling.
- `tests/settings.service.test.ts`: persisted credential generation changes only for actual key changes.
- `tests/organizer.service.test.ts`: preparation, post-cache and pre-response state changes, bounded retries, live source/target checks, real adapter/provider races, and 30-item historical-scan cache integration.
- `tests/scan.service.test.ts`: scan counters and review state remain consistent.

## Limits

- Fallback variants can miss after worker restart until the expected request variant is established again.
- Chrome bookmarks and extension storage do not provide a shared transaction; sequential final checks cannot guarantee global snapshot isolation.
- Browser behavior, real gateway compatibility and real-world token-cost savings remain unverified.

## Approved commit

`fix(classifier): 优化分类缓存失效并保持整批上下文一致`

The user confirmed inclusion of the following reviewed changes in one work commit:

- `lib/ai/openai-compatible.ts`
- `lib/storage/repository.ts`
- `services/activity-log.ts`
- `services/classifier.service.ts`
- `services/organizer.service.ts`
- `services/scan-state.ts`
- `services/settings.service.ts`
- `types/domain.ts`
- `tests/classifier.test.ts`
- `tests/openai-compatible.test.ts`
- `tests/organizer.service.test.ts`
- `tests/organizer.test.ts`
- `tests/repository.test.ts`
- `tests/scan.service.test.ts`
- `tests/settings.service.test.ts`
- `README.md`
- `.trellis/spec/backend/extension-runtime-contract.md`
- `.trellis/tasks/10-28-classification-cache-invalidation/task.json`
- `.trellis/tasks/10-28-classification-cache-invalidation/prd.md`
- `.trellis/tasks/10-28-classification-cache-invalidation/design.md`
- `.trellis/tasks/10-28-classification-cache-invalidation/implement.md`
- `.trellis/tasks/10-28-classification-cache-invalidation/implement.jsonl`
- `.trellis/tasks/10-28-classification-cache-invalidation/check.jsonl`
- `.trellis/tasks/10-28-classification-cache-invalidation/validation.md`

No unrelated dirty files were identified. After the approved work commit, archive this task and record the session journal using the standard Trellis commands. The user did not request a push.
