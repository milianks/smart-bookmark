# Chrome Extension Runtime Contract

## Scenario: Persisted bookmark classification and review workflow

### 1. Scope / Trigger

Use this contract when changing the MV3 background, bookmark or folder services, local extension storage, AI provider, runtime messages, notifications, or review operations. The background service worker is the only layer allowed to mutate Chrome bookmarks.

### 2. Signatures

- `BookmarkPort.getTree(): Promise<BookmarkNode[]>`
- `BookmarkPort.isWithinRoot(nodeId: string, rootId: string): Promise<boolean>`
- `BookmarkPort.getFoldersWithinRoot(rootId: string): Promise<FolderSummary[]>`
- `BookmarkPort.isValidTargetFolder(targetFolderId: string, rootId: string): Promise<boolean>`
- `BookmarkPort.moveBookmark(bookmarkId: string, targetFolderId: string): Promise<void>`
- `BookmarkPort.createFolder(name: string, parentId: string): Promise<BookmarkNode>`
- `ClassifierPort.classify(input, folders, settings, hasProviderPermission): Promise<ClassifiedResult>`
- `OrganizerService.onBookmarkCreated(id, node): Promise<void>`
- `OrganizerService.approveReview(id): Promise<void>`
- `OrganizerService.rejectReview(id): Promise<void>`
- `OrganizerService.undoLastMove(): Promise<string>`
- `StateRepository.load(): Promise<PersistedState>` and `update(mutator): Promise<PersistedState>`
- `RequestSchema` is a strict Zod discriminated union; `handleRequest(request: RuntimeRequest, services: RouterServices): Promise<unknown>` receives Organizer, Scan, and Settings facades plus `normalizeBaseUrl(baseUrl)`. The router has no Chrome, storage, or bookmark dependency.

### 3. Contracts

- The background validates with `RequestSchema` before dispatching to `handleRequest`; the router calls only injected service facades and preserves the existing success/error envelope at the listener boundary.
  For `settings:update`, normalize a shallow copy of `request.settings` so the parsed request is not mutated; return no API key or provider payload.
- Classification input contains a bookmark's title, original URL, domain, current folder ID/path, and optional derived page profile, plus folder summaries from the persisted smart bookmark root. Each optional `samples` array contains at most three direct-child HTTP(S) bookmarks with bounded `{title, url, hostname}` fields. Never send the full bookmark tree or raw page content to the provider.
- The local classifier may use bookmark title, URL path, domain-specific hints, and bounded folder samples. A shared domain alone is not enough to trigger a local automatic move; require topical overlap from title/path/sample text or an exact sample URL. A generic folder token alone is not strong evidence.
- Corrections use `correctionUrl`: normalized URL with its fragment preserved, so SPA routes cannot share hard overrides. Legacy domain-only rules are dropped; `corrections:clear` clears corrections, preferences and AI cache.
- Re-evaluate page-URL corrections, topic/content-type preferences, and deterministic rules before looking up an AI cache entry. Rank provider folders using the estimated budget, not a fixed six-folder limit; validate destinations against the complete supplied smart-root folder set, not only the candidates. See the classification cache scenario below for the selection and reuse contract.
- Cache validated independent per-bookmark decisions across single and batch transports only under the shared decision-policy context and proven successful source request; a folder change outside that context need not invalidate a valid hit.
- Classification output is strict Zod data: `move` requires `targetFolderId`; `suggest_folder` requires a name and `parentId`; `keep` has no destination; confidence is in `[0,1]`.
- Persist jobs, review items, settings and settings drafts, cache, activity history, import marker, undo record, and pending mutation intent through `chrome.storage.local`. Keep API keys out of sync storage, logs, errors, and notifications.
- Register Chrome listeners synchronously at background module initialization. Persist a job before classification; use bookmark ID as its idempotency key. Use alarms for finite retry and worker restart recovery.
- During `resume()`, query permission for the currently configured provider origin. Promote `awaiting_permission` jobs only when an API key exists and that exact origin is granted; clear the stale permission error before requeueing.
- Persist a pending move intent before calling `chrome.bookmarks.move`; re-read the bookmark and validate its source and destination immediately before mutation. Never delete a bookmark or folder.
- If `chrome.bookmarks.move` rejects, reconcile the persisted intent immediately against the bookmark's live parent. Treat the move as committed if the target parent is observed; clear the intent and fail safely if the source remains; mark the operation stale/skipped if the bookmark is elsewhere.
- The background initializes one folder named `智能书签` under the editable `bookmarks-bar` root, stores its ID in local state, and creates default first-level folders once. Existing persisted root IDs and names are preserved; no identity API or email permission is used.
- Classification destinations, metadata and historical scans are limited to the persisted smart root. New bookmarks in built-in roots participate only when `organizeExternalRoots` is enabled. Boundary and path queries read live ancestor chains, including managed ancestors; classification context validation still uses a fresh tree before committing results. Classification and mutation checks never use the dashboard folder cache.
- Drop legacy `forceOrganize` settings and unused persisted `pageProfiles` during normalization; retain other valid draft settings.
- Automatic moves require automatic mode and confidence at or above the configured threshold. Folder creation always waits for explicit review approval. Review approval must be idempotent and revalidate live bookmark/folder state.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Folder event, unsupported URL scheme, or malformed URL | Ignore without creating a job |
| Bookmark or containing folder is outside the persisted smart root | Do not persist a new classification job, call a provider, or mutate the bookmark |
| Smart root ID is missing, deleted, or no longer resolves to an editable folder | Keep bookmarks in place; initialization may recreate/recover the root before queued work resumes |
| Import marker active | Suppress new classification; expire stale marker during recovery |
| API key missing | Persist `awaiting_configuration`; leave bookmark where it is |
| API origin permission missing | With a configured key, a local decision or valid AI cache hit can still complete; if an AI request is needed, persist `awaiting_permission` and do not call `fetch` |
| Provider-origin permission later granted | On settings update or worker resume, recheck the configured origin and requeue only if the API key and permission are both present |
| Provider timeout, HTTP failure, invalid JSON, or schema failure | Keep bookmark in place; record visible failure; retry only bounded transient errors |
| Bookmark move rejects | Immediately reconcile the pending intent against the live parent; do not leave a stale intent blocking later mutations |
| Target folder or source bookmark changed/deleted | Mark job/review stale or failed; do not move |
| Duplicate event or concurrent processing | One job and at most one move per bookmark |
| Undo source missing or bookmark manually moved | Keep current placement and report why undo was skipped |

### 5. Good / Base / Bad Cases

- **Good**: A newly created bookmark under the persisted smart root is persisted, classified with only smart-root folder summaries, matched to a real folder, and moved only after a fresh source/target check; an undo record stores both folder IDs.
- **Base**: A low-confidence match creates a durable review item and notification while the bookmark remains in its source folder.
- **Bad**: A model returns an invented folder ID, an API request fails, or a stale review is approved; the result must not mutate the bookmark.

### 6. Tests Required

- Mock `BookmarkPort`, `StateRepository`, classifier, notifications, and alarms.
- Assert existing-folder auto-move, new-folder approval, rejection, missing key, provider failure, import suppression, deleted targets, duplicate/concurrent events, worker recovery, and undo.
- Assert a rejected move clears or reconciles its pending intent immediately, including the case where the browser applied the move before the promise rejected; later mutations must not remain blocked.
- Assert missing provider permission leaves a provider-dependent job waiting, while eligible local/cache results remain available; granting the exact configured origin lets `resume()` classify waiting work once.
- Assert root-outside bookmarks and targets never reach the provider, review creation, folder creation, movement, or undo; changing folder names and nesting changes the next classification's live summaries.
- Assert every failed/stale path leaves the bookmark parent unchanged and does not call create/move unexpectedly.
- Inspect the production manifest: required permissions are `bookmarks`, `storage`, `notifications`, `alarms`, and `scripting`; provider origins remain optional and no static all-site permission is present.

### 7. Wrong vs Correct

#### Wrong

```ts
const result = await provider.classify(input, folders, settings);
await chrome.bookmarks.move(bookmarkId, { parentId: result.targetFolderId! });
```

This trusts model output, skips schema/tree validation, and bypasses the durable operation record.

#### Correct

```ts
const bookmark = await this.deps.bookmarks.getBookmark(job.bookmark.id);
const target = await this.deps.bookmarks.getFolder(targetFolderId);
const rootId = (await this.deps.store.load()).smartBookmarkRootId;
if (!rootId || !bookmark || bookmark.parentId !== job.bookmark.parentId) return;
if (!(await this.deps.bookmarks.isWithinRoot(bookmark.id, rootId))) return;
if (!(await this.deps.bookmarks.isValidTargetFolder(targetFolderId, rootId))) return;
await this.deps.store.update((state) => { state.pendingOperation = operation; });
try {
  await this.deps.bookmarks.moveBookmark(job.bookmark.id, targetFolderId);
} catch (error) {
  await this.reconcilePendingOperation();
  throw error;
}
```

This is the live-source/target and durable-intent sequence used by `OrganizerService.automaticMove`. A rejected call can still have changed the browser state, so reconciliation compares the actual parent with both recorded parents before deciding whether the operation completed or failed. Keep Chrome API mutation inside the organizer and validate every ID against the current smart-root subtree.

## Scenario: Classification candidates and AI cache reuse

### 1. Scope / Trigger

Use this contract when changing classification inputs, candidates, learned decisions, provider requests, cache storage, or historical batch processing. One bookmark is the reusable decision unit. The user approved independent classification across single and batch paths: a batch combines transport work, without same-batch topic grouping. Reuse does not promise identical stochastic output to a new model call.

### 2. Signatures

- `ClassifierPort.classify(input, folders, settings, hasProviderPermission, snapshot?): Promise<ClassifiedResult>`.
- `ClassifierPort.classifyBatch?(inputs, folders, settings, hasProviderPermission, snapshot?): Promise<BatchOutcome[]>`.
- `ClassifierProvider.getCacheRequest?(mode, inputs, folders, config, recentCorrections?): Record<string, unknown> | undefined`; `classify` and `classifyBatch` report the successful request body through `onRequest`.
- `ClassifierProvider.getCacheVariant?(): number | undefined`; `ClassifiedResult.cacheValidation?(): boolean` is a transient check, never persisted or exposed in dashboard data.
- `rankFolderCandidates(input: ClassificationInput, folders: FolderSummary[]): FolderSummary[]`.
- Version-3 cache entries contain `key: classification-v3:{single|batch}:{64 lowercase hex HMAC characters}`, first `result`, `source: 'ai'`, `createdAt`, `version: 3`, `mode: 'single' | 'batch'`, and ordered `results`. Version-2 whole-batch-policy entries are cold misses.

### 3. Contracts

- Require a configured API key first. For every input re-evaluate page-URL corrections, page-profile preferences, and full-folder deterministic rules, with the current threshold. These local decisions are not AI cache entries.
- Rank candidates independently for each AI input, identically in single and batch processing. Selection uses an estimated 10,000-byte folder budget; under budget, or with weak/ambiguous evidence, it retains the supplied folders in order. Meaningful evidence can rank/select candidates with a floor of 12 and stripped samples; retain the current folder when present. This is not a six-folder limit or exact serialized-size guarantee.
- Resolve local outcomes, then check per-item `single` entries. Partition only misses by equal ordered candidate context into provider groups. Ordinary shared candidates produce one request; divergent contexts may need several. Neither cache hits nor companions may change another item's candidates. Preserve original outcome indexes across groups.
- Recompute recent decisions from up to five corrections by descending `createdAt`, resolving folder paths against the complete supplied folder list. Key the original input, including original URL and optional profile, protocol, normalized endpoint, model, credential generation, and output-affecting request context. Use HMAC-SHA-256 with the API key as secret; never persist secret material, request bodies, raw content, or derived profiles solely to match cache entries.
- A canonical per-item context covers the independent decision policy and expected single and singleton-batch descriptions, including prompts, schemas, candidates, corrections, and parameters. Both fresh single and validated batch-member results use this `single` identity. Complete batch identities include their expected group request plus each member's canonical description, so they cannot bypass invalidation when only one path's policy changes. A batch-derived entry is an explicit decision-policy alias; it is not proof that an actual single request occurred. If safe context/cryptography cannot be described, skip reuse.
- Before seeding entries, prove that the actual successful source request matches its expected description. For a batch alias, additionally prove that the member's independent candidates match the group's candidates and its canonical description is still stable. An unexpected tool/prompt/reasoning fallback cannot populate the old expected identity; subsequent requests may use the now-known shape. Do not hash an actual batch body as though it were an actual single request.
- Keep bounded lookup attempts (at most three) and monotonic provider-variant checks around asynchronous hashing. Carry `cacheValidation` on cached outcomes through the organizer's final checks. A concurrent fallback invalidates those outcomes, even if the request shape later returns to a prior shape. Worker restart may cold-miss incompatible variants.
- Retain complete ordered group `batch` entries as an additional optimization. A group hit must validate every member. A group result can seed individually valid members only with a complete trustworthy input mapping. A complete batch entry is written only if every member validates; never persist a partial batch entry. Entries from unrelated calls may now satisfy separate items under the approved shared policy.
- Validate cached and fresh `move` targets and `suggest_folder` parents against the complete supplied folder set, excluding managed folders. `keep` has no target. Preserve strict provider batch-index normalization before service result validation; do not salvage unmappable members from malformed/missing/duplicate indexes or provider exceptions.
- The repository rejects obsolete, malformed, mismatched and oversized entries. Preserve settings, jobs, reviews, and learned state when cache cold-starts. Retain at most 200 stored results and 64 KiB per encoded entry; batch plus single duplicates count toward the same bound. Normalize related writes through the existing repository boundary, checking API key and credential generation inside the mutator. Prefer one update for a related write set over one write per member.
- With a key, all-local/cache batches can finish without provider-origin permission. Any miss needing a provider requires permission before submitting requests; preserve batch-level failure rather than silently returning a subset.
- The organizer keeps its shared preparation snapshot and final checks of root, settings, corrections, preferences, credential generation, full folder summaries, and relevant job/bookmark state. Discard stale outcomes and retry boundedly or fail safely; check cache and AI outcomes before review/mutation. Do not weaken these checks to increase hits.
- Cache writes can precede organizer final checks; subsequent lookups must recompute local decisions and match current context. Chrome bookmarks and storage do not share a transaction; sequential comparisons cannot detect every intervening change or protect against changes after the final check. Live mutation checks remain required.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Missing API key | Fail before local/cache classification; no provider call |
| Missing provider-origin permission | All items must resolve locally/from cache; otherwise throw `PermissionRequiredError` before any provider call |
| Obsolete, malformed, wrong-mode, mismatched, oversized, invalid-target entry | Treat the entry as a miss; do not extract members from an invalid batch entry |
| Actual successful request differs from expected, or variant/context is unstable | Do not write under the old expected identity or seed per-item aliases |
| Complete mapped response with an individually invalid target/schema | Preserve per-member errors; cache validated successes only; omit the complete batch entry |
| Missing/duplicate/malformed indexes, incomplete response, or provider exception | Fail safely; do not infer/cache members without a trustworthy mapping |
| Relevant context changes before application | Discard affected outcomes, retry boundedly, or fail without applying |
| Credentials change in flight | Repository mutator skips writes; organizer independently rechecks context |

### 5. Good / Base / Bad Cases

- **Good**: Cold `[A,B]` followed by `[B,C]` returns B from cache and submits only C. Single A after the first batch also hits cache.
- **Base**: Every item shares ordered candidates, so all misses form one batch. A sent candidate or relevant correction changes and legitimately causes a miss.
- **Bad**: Combine companions' ranked candidates, write results under hypothetical single keys without proving the actual source request, or reuse an invalid/managed target. Independent identity does not excuse incompatible source context.
- **Limit**: Divergent large-folder candidates may produce several requests, and duplicated single/batch entries can evict sooner. Report observed counts rather than promising universal savings.

### 6. Tests Required

- Assert local correction/preference/threshold precedence and key/permission behavior for both paths and mixed results.
- Cover overlap, reordered/all-hit batches, batch-to-single and single-to-batch reuse, outcome source/order, and actual provider member counts.
- Demonstrate independent candidates under an over-budget tree when companions/order/cache-hit availability vary. A folder outside unchanged candidate context can preserve a hit; a relevant candidate/input/configuration/correction change cannot.
- Verify actual source request checks, single AND batch policy-description changes, monotonic variants during hashing/final validation, default/fallback/restart behavior, and absence of false aliases after unexpected fallback.
- Cover complete group-batch hits, independently valid members beside an invalid target, provider index normalization, missing/duplicate responses, and no partial batch entry.
- Cover obsolete/malformed state, unrelated-state preservation, credential A-to-B-to-A and in-flight changes, encoded-size/result-count limits including duplicate representations, and absence of request/secret material in storage.
- Retain stale preparation/post-cache/pre-response checks, bounded retries, live mutation validation, and historical integration using the real classifier. Clear deduplication state before proving scan cache reuse. Distinguish provider invocations from HTTP retries/fallback.

### 7. Wrong vs Correct

- **Wrong**: Key by URL alone, check cache before current corrections, or take a shared candidate union whose contents change with remaining misses.
- **Correct**: Resolve local decisions, derive independent candidates, validate canonical single entries, batch only compatible misses, prove the successful source request, and preserve organizer final/live checks.

## Scenario: Multi-protocol AI provider and connection test

### 1. Scope / Trigger

Use this contract when changing provider protocol selection, provider request construction, saved settings, or the settings-page connection test. The background remains the only owner of stored settings and provider requests.

### 2. Signatures

- `ProviderProtocol`: `anthropic-messages | openai-chat-completions | openai-responses`.
- `ProviderConfig`: `{ protocol, baseUrl, model, apiKey }`.
- `ClassifierProvider.classify(input, folders, config): Promise<ClassificationResult>`.
- `ClassifierProvider.test(config): Promise<void>` sends one synthetic classification and has no bookmark or persistence dependency.

### 3. Contracts

- `baseUrl` is user-entered, HTTPS except loopback HTTP, and may include a version prefix such as `/v1`. Append `/messages`, `/chat/completions`, or `/responses` according to `protocol`; strip a recognized endpoint suffix first so it is not duplicated.
- Anthropic Messages uses `x-api-key`, `anthropic-version: 2023-06-01`, `system`, one user message, and text content blocks. The two OpenAI protocols use bearer auth; Chat Completions uses `messages` and `choices[0].message.content`, while Responses uses `instructions`/`input` and assistant `output_text` content blocks.
- All protocols share the same classification prompt and strict `ClassificationResultSchema`. A successful HTTP status or parseable provider envelope alone is not success.
- The test uses a synthetic `example.test` bookmark and `synthetic-folder`; it must not read or mutate real bookmarks, write cache/activity, or accept a destination outside the synthetic folder set.
- Missing legacy `protocol` normalizes to `openai-chat-completions`. Keep the API key local and write-only; never expose it through dashboard data, logs, notifications, or provider errors. Request only the configured origin permission.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Invalid base URL or unsupported protocol | Reject before sending a request |
| Configured origin permission missing | Do not fetch; keep the bookmark in place |
| Timeout, network failure, 429, or 5xx | Return a sanitized bounded error; retry only transient failures |
| Non-2xx response, invalid envelope/JSON, or invalid classification schema | Fail safely without exposing response text or API key |
| Test result references a non-synthetic destination | Reject the test; do not touch user bookmark state |

### 5. Good / Base / Bad Cases

- **Good**: `https://provider.example/v1` with `openai-responses` calls `/v1/responses`, extracts assistant text, validates the result, and caches it only when its normal classification request is eligible for reuse.
- **Base**: Legacy settings omit `protocol`; load keeps the existing URL, model, key, and organization preferences while selecting Chat Completions.
- **Bad**: A 200 response contains malformed or schema-invalid output; report a safe failure and leave the bookmark unchanged.

### 6. Tests Required

- Stub `fetch`; never send automated tests to a configured external provider.
- For each protocol, assert exact URL, auth/version headers, request body, response text extraction, and strict result validation.
- Assert endpoint suffix de-duplication, legacy setting preservation, protocol-sensitive cache keys, synthetic-only test input, and no test writes to cache/activity or bookmark ports.
- Assert timeout, network/HTTP errors, malformed JSON, oversized or invalid provider output, and invalid synthetic destinations fail safely without revealing secrets.

### 7. Wrong vs Correct

#### Wrong

```ts
const response = await fetch(`${baseUrl}/chat/completions`, request);
if (response.ok) return;
```

This ignores the selected protocol and treats HTTP success as a valid classification.

#### Correct

```ts
const endpoint = providerUrl(config.baseUrl, config.protocol);
const response = await fetch(endpoint, requestFor(config.protocol, messages));
const payload = await readProviderPayload(response);
const result = ClassificationResultSchema.parse(extractText(payload, config.protocol));
```

Dispatch endpoint, headers, body, and extraction together by the saved protocol, then validate the shared result contract before the organizer can use it.

## Scenario: Historical scan and batch review workflow

### 1. Scope / Trigger

Use this contract when adding or changing the explicit scan of existing bookmarks, historical review items, batch approval, or historical batch undo. The worker remains the sole owner of scan persistence and Chrome bookmark mutations.

### 2. Signatures

- `enumerateHistoricalBookmarksWithinRoot(tree: BookmarkNode[], rootId: string): HistoricalBookmarkCandidate[]`.
- `ScanService.startHistoricalScan(): Promise<{ scanId: string; eligibleTotal: number }>`.
- `ScanService.approveAllHistoricalReviews(scanId?: string): Promise<number>`.
- `OrganizerService.undoHistoricalLast(): Promise<number>`.
- `HistoricalScanState`: `{ id, status, startedAt, updatedAt, eligibleTotal, processedCount, pendingReviewCount, failedCount, skippedCount, coveredIds }`.
- Historical `BookmarkJob` and `ReviewItem` records carry optional `scanId`; `DashboardState` exposes only the scan summary, never `coveredIds` or approval queue IDs.

### 3. Contracts

- A scan is explicit and preview-only. It never moves a bookmark or creates a folder during classification.
- Enumeration accepts only editable HTTP(S) bookmark nodes in the persisted smart-root subtree. Managed branches, folders, and unsupported URL schemes are skipped.
- Scan jobs persist before classification and reuse the existing classifier, cache, folder-target validation, review creation, pending move intent, and worker recovery paths.
- Historical `move` and `suggest_folder` results always become pending reviews, independent of normal automatic mode or confidence threshold. `keep` completes without mutation.
- `scan:approve-all` durably enqueues review IDs and returns the queued count immediately. `ScanService.resumeApprovals` arms a recovery alarm before processing, handles at most 10 items or 10 seconds per wake, and checkpoints each item through the existing serialized approval/WAL path. While the worker is alive a short timer continues the next chunk; the already-armed alarm and startup recover remaining IDs after shutdown; approved items are skipped after checkpoint failures. The persisted queue rejects duplicate batches; individual failures restore pending state for manual retry. If reconciliation fails, the item stays queued for the recovery alarm. Batch undo is blocked while approval remains queued.
- Completed/failed scan totals survive terminal job/review pruning; do not recompute old approvals as skipped merely because records expired.
- Historical successful moves append to the latest batch undo record. `undo:historical-last` revalidates every recorded bookmark and moves back only items still in the recorded destination; it never deletes empty folders or overwrites manual moves.
- Missing scan fields in existing version-1 local state normalize to empty/undefined values. API keys and provider payloads never enter scan state, dashboard data, activity messages, or diagnostics.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| A second scan starts while status is `scanning` or `awaiting_review` | Reject without replacing the active scan |
| A scan request arrives concurrently with another start | Reject through the in-memory start lock |
| No API key, or missing provider origin permission when AI is needed | Persist waiting jobs; leave bookmarks in place; resume after settings/permission recovery |
| AI returns `move` or `suggest_folder` | Persist a pending review; do not mutate during scan |
| Bookmark moved/deleted before approval | Mark review/job stale or skipped; do not overwrite the live placement |
| Batch approval request repeats or overlaps another batch | Reject concurrent request; never perform a second move for an approved review |
| Chrome move rejects or worker shuts down around a move | Reconcile `pendingOperation` against the live parent before clearing or retrying |
| Historical undo sees a deleted/manual-moved bookmark or missing source folder | Record a bounded skip activity and continue remaining items |

### 5. Good / Base / Bad Cases

- **Good**: A bookmark under the persisted smart root is classified, shown in Review, approved once, moved after fresh checks, and recorded in the latest batch undo list.
- **Base**: A scan finds bookmarks under another Chrome root; it excludes them without calling the provider.
- **Bad**: A provider suggests a managed/nonexistent destination or a user moves the bookmark before approval; the scan leaves the bookmark untouched and exposes a stale/failure status.

### 6. Tests Required

- Enumeration: smart-root isolation, managed branches, HTTP(S) filtering, folders, and duplicate IDs.
- Persistence: valid historical scan/undo normalization and safe loading of legacy state without these fields.
- Service: preview-only classification, scan start idempotency/concurrency, worker restart recovery, missing key/permission waiting, stale/manual move handling, batch approval isolation, and batch undo skips.
- Router tests must cover strict rejection of malformed/extra-field requests, every RuntimeRequest route and facade argument, copy-based URL normalization, API-key isolation, and unchanged error propagation.
- Runtime/UI boundary: Zod rejects unknown or malformed scan messages; dashboard omits covered IDs, force flags, API keys, and provider payloads.
- Mutation assertions: no `move`/`create` during scan; at most one move per approved bookmark; pending intents reconcile after rejected Chrome calls.

### 7. Wrong vs Correct

#### Wrong

```ts
for (const bookmark of await bookmarks.getTree()) {
  const result = await classifier.classify(bookmark);
  if (result.action === 'move') await bookmarks.moveBookmark(bookmark.id, result.targetFolderId);
}
```

This bypasses the protection boundary, preview requirement, durable scan job, live-state checks, and recovery intent.

#### Correct

```ts
const candidates = enumerateHistoricalBookmarksWithinRoot(tree, smartBookmarkRootId);
await store.update((state) => persistScanJobs(state, candidates, scanId));
await classifyHistoricalJobs(scanId); // move/suggest_folder -> durable pending review
await scan.approveAllHistoricalReviews(scanId); // durable queue; alarms run live checks and intents
```

Separate enumeration/classification from mutation, persist before work, and route every approved move through the existing organizer recovery contract.

## Scenario: Manual bookmark summary and tags

### 1. Scope / Trigger

Use this contract when adding user-triggered summary/tag generation for an existing bookmark. The background owns provider calls and persistence; Popup and Review pages only send runtime messages and render projected metadata.

### 2. Signatures

- `BookmarkMetadataService.generate(bookmarkId: string): Promise<BookmarkMetadata>`
- `ClassifierProvider.generateMetadata(input: BookmarkMetadataInput, config: ProviderConfig): Promise<SummaryTagResult>`
- Runtime request: `{ type: 'bookmark:metadata:generate'; bookmarkId: string }`
- Persisted shape: `bookmarkMetadata: Record<string, BookmarkMetadata>`, where each record contains `summary`, `tags`, and `generatedAt`.

### 3. Contracts

- Resolve one live bookmark and its current folder path. Send only `{ title, url, domain, currentFolder }` to the configured provider.
- Require the configured API key and permission for the configured provider origin before making the request.
- Accept only a strict object with a non-empty summary of at most 500 characters and 1-8 unique tags of at most 32 characters each. Reject unknown fields.
- Persist only after validation, replacing only the selected bookmark's metadata. Normalize legacy state without `bookmarkMetadata` to an empty map.
- Deduplicate concurrent requests for the same bookmark ID; requests for different IDs may proceed independently.
- Project metadata only onto matching `recentJobs`, `pendingReviews`, and `historicalReviews` items. Do not expose the full metadata index, API key, prompt, raw provider response, or unbounded provider data.
- The service must not call bookmark or folder mutation APIs. Do not add webpage access, static host permissions, dependencies, or automatic generation.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Malformed runtime request or empty/oversized bookmark ID | Reject before dispatch |
| API key missing or provider-origin permission absent | Return a bounded user-facing error; do not call the provider or replace existing metadata |
| Bookmark is outside the smart root or its containing folder no longer exists | Fail before provider call; preserve existing metadata |
| Provider request fails or returns invalid JSON/schema/extra fields | Return a sanitized error; preserve existing metadata |
| Valid provider response | Persist one validated record for the selected bookmark and return it |
| Concurrent request for the same bookmark ID | Share the in-flight result; do not issue duplicate provider calls |

### 5. Good / Base / Bad Cases

- **Good**: A user generates a summary for a live bookmark under the smart root; only the root-scoped folder path and allowed bookmark metadata are sent, strict output is validated, local state is updated, and the bookmark remains in the same folder.
- **Base**: The provider origin is not permitted; the UI shows an error and any previous summary/tag record remains visible.
- **Bad**: Provider output contains extra fields, oversized values, or duplicate tags; reject it without persisting provider data or changing bookmark state.

### 6. Tests Required

- Assert prompt input contains only title, URL, domain, and a folder path from `getFoldersWithinRoot(rootId)`; reject root-outside bookmarks before provider calls and validate strict output bounds, uniqueness, and extra-field rejection.
- Assert legacy state normalization, metadata persistence, and malformed-record dropping without changing storage version.
- Assert missing permission/provider failure/invalid output preserve previous metadata; assert same-ID concurrency deduplicates and no bookmark mutation method is called.
- Assert strict runtime request routing and dashboard projection onto matching job/review items without exposing the complete metadata map.

### 7. Wrong vs Correct

#### Wrong

```ts
const response = await provider.generateMetadata(bookmark, settings);
state.bookmarkMetadata[bookmark.id] = response;
await chrome.bookmarks.move(bookmark.id, { parentId: response.folderId });
```

This sends an unrestricted object, trusts unvalidated output, and couples metadata generation to bookmark mutation.

#### Correct

```ts
const input = { title, url, domain, currentFolder };
const result = SummaryTagResultSchema.parse(await provider.generateMetadata(input, config));
await store.update((state) => {
  state.bookmarkMetadata[bookmarkId] = { ...result, generatedAt: now() };
});
```

This persists only bounded validated metadata for the requested bookmark and leaves all bookmark/folder state untouched.


## Scenario: Storage and dashboard performance

### 1. Scope / Trigger

Use when changing repository snapshot caching, dashboard views, notifications, or folder-list reuse. Preserve the single-key atomic snapshot and durable move intent ordering.

### 2. Signatures

- `new ChromeStateRepository(storage, changes?)`: optional `StorageChanges` subscribes to state-key events.
- `OrganizerService.getDashboardState(view?)`: `popup`, `settings`, `review`, or omitted.
- `OrganizerService.invalidateFolders(): void`.
- `registerDashboardNotifications(runtime, storage): () => void`: returns a notification scheduler.

### 3. Contracts

- Keep `ai-bookmark-manager.state.v1` and version 1. Internal write tokens live in settings and are removed by settings normalization, including old-version whitelists. Preserve the separate classification credential epoch.
- Cache validated snapshots only with an injected change subscription. External writes invalidate; reads interrupted by a change retry before installing a snapshot. Without a subscription, later calls read storage again.
- Return independent clones. Mutate a private copy, normalize, compare its serialized value, and await each changed snapshot's `storage.set`. No deferred persistence; pending move intents must reach storage before bookmark mutation.
- Public `popup` responses omit `historicalReviews` and `folders`; `settings` returns only public settings, activities, and AI status. `review` and omitted views retain the complete existing dashboard contract. Unknown view values fail strict request validation.
- Only the worker listens to storage changes. Popup and Review connect a `dashboard` port and receive `{ type: 'state:changed' }` after coalescing. Storage changes, including external writes, and bookmark-tree invalidations schedule notification.
- Cache dashboard folder queries by root ID; invalidate on bookmark create/remove/change/move/reorder/import-end. Never use this cache for classification or mutation safety checks. Failed queries are not permanently cached.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Mutator throws or storage write fails | Reject, discard cache, preserve durable state; subsequent queued updates can run |
| External state write or removal | Invalidate cached state; next load observes normalized storage |
| External change while reading or writing | Do not install a stale snapshot over invalidation |
| No storage subscription | Fall back to fresh reads, including direct-write test adapters |
| Dashboard port disconnects | Page reconnects and refreshes; cleanup stops retries |
| Folder tree changes or smart root changes | Next dashboard folder request queries the current root; stale in-flight results cannot replace the new cache |

### 5. Good / Base / Bad Cases

- Good: repeated dashboard requests reuse a validated snapshot and one folder query until an event invalidates them.
- Base: a legacy snapshot without internal markers still loads with existing normalization and classification-cache safety.
- Bad: returning cached objects directly lets callers mutate durable state outside `update`; cloning remains mandatory.

### 6. Tests Required

- Repository: repeated reads, clone isolation, external writes, event/read/write races, serialized updates, mutator failure, storage failure, and old-format round trips.
- Dashboard: strict view routing, omitted-view compatibility, public-field projections, folder invalidation/root changes/failure recovery, constant notification payload, reconnect and cleanup.
- `tests/perf/state-scale.test.ts`: 5000-bookmark queue, batch updates and repeated dashboard reads; assert deterministic I/O/size limits and snapshot peak below 5 MB. Wall-clock timings are diagnostic only. Record before/after measurements in the task validation artifact.
- Node checks do not establish real Chrome service-worker lifecycle behavior or prove eliminated browser-internal storage-event serialization.

### 7. Wrong vs Correct

- Wrong: cache storage without invalidation, merge writes across a bookmark move, or send the persisted state over a dashboard port.
- Correct: invalidate on external events, persist every safety-critical update before mutation, and send only a fixed-size invalidation before a view-specific request.
