# Classification cache interoperability design

## Decision boundary

The reusable unit is one bookmark under its independent classification context. Single and batch transports can supply that decision under the approved policy. A batch-derived single entry is an explicit policy alias, not proof that an identical single HTTP request occurred. Retain complete batch entries as an additional optimization.

Remove same-batch topic grouping from `buildBatchMessages`; preserve independent suggestions, untrusted-data handling, real-folder restrictions, strict schemas, and provider adapters.

## Candidate context and grouping

1. Resolve local decisions using the current full folder list and snapshot.
2. Independently derive ordered candidates with `rankFolderCandidates`, recent corrections, configuration, and credential generation for each remaining input.
3. Check canonical single entries using bounded request/variant stability checks; retain original indexes and `cacheValidation`.
4. Return if everything resolves. Otherwise preserve batch-level permission failure before requesting any miss.
5. Partition misses with identical ordered candidate context into groups. Each group uses the same candidates its members would receive in single requests. Preserve first-occurrence group order and original member order; add no concurrent provider scheduling.
6. Look up each complete group batch; otherwise call `provider.classifyBatch` once for that group. Scatter results to original positions.

Replace companion-dependent `batchProviderFolders`; do not change the ranking algorithm or its budget. Normal small folder trees share one group. Divergent large-tree candidates may produce multiple calls. Avoid repeated full per-item folder payloads, new provider payload schemas, and mixing incompatible contexts merely to force one call.

## Identity and provenance

Use a new cache policy/key version; old entries become cold misses. Preserve HMAC-SHA-256 and original input/profile, protocol, normalized endpoint, model, credential generation, ordered candidate context, and recent decisions. Persist neither secrets nor request bodies as cache metadata.

Keep a shared `single` per-item namespace. Its context must cover the independent policy and output-affecting single AND batch prompt/schema descriptions so a change to either path invalidates affected aliases. Prefer composing existing expected single and singleton-batch descriptions with an explicit policy version; do not duplicate provider serialization. An unavailable safe descriptor means no cache reuse. Complete batch keys remain tied to the ordered group and expected group request.

Before storing a fresh single result, compare the successful actual single request to the expected single request. Before storing batch/group or derived member entries, compare the actual successful group request to the expected group request. Seed an alias only when the member's independently selected candidates equal the group candidates, its canonical descriptor remains stable, and variant/configuration/credential checks hold. Never hash an actual batch body as if it were an actual single request.

Retain three-attempt lookup bounds and `cacheVariantCheck`; validate descriptions and monotonic variants around asynchronous hashing and before alias creation. An unexpected successful fallback must not seed entries under the old identity; a later request can cache the now-known variant. Preserve organizer final snapshot and live mutation checks.

## Validation and storage

- Keep provider index normalization and service cardinality checks. Missing, duplicate, or malformed provider responses fail safely; do not invent successes from an exception.
- Validate mapped members against strict result schemas and the complete supplied folder set. When mapping is complete, valid members may be stored despite another member's invalid target/schema at the service boundary; retain per-member errors.
- Store a complete batch entry only if every member validates. Never persist a partial batch entry.
- Accumulate eligible related entries and use the existing repository update/normalization boundary, preferably one update per related write set. Recheck key and credential generation inside the mutator. Avoid repeated per-member storage rewrites.
- Retain 200 stored results and 64 KiB per entry. Single/batch duplicates count normally. No limit increase or new storage layer.
- Preserve permission failures, provider/storage error handling, and bookmark retention. Adjust organizer logic only if a regression demonstrates a required change; do not rewrite snapshot/retry machinery.

## Compatibility and rollback

Coordinate cache policy prefix/version in schema, service, storage fixtures, and tests. Old entries cold-miss while settings, jobs, reviews, metadata, and learning survive. A code rollback can also cold-start cache; never require clearing extension storage. Update README and current runtime contract; archived tasks stay unchanged.

## Verification and stop condition

Test overlapping/reordered batches, both single/batch directions, full hits, mixed sources, invalid targets, incomplete/index failures, divergent candidates, fallback/restart, credential changes, in-flight changes, bounded eviction, and real historical processing with fake providers. Count calls AND members; immediate scan deduplication is not cache evidence. Run the full project gate after focused tests pass. No live provider calls, Chrome smoke testing, commits, or release are included.
