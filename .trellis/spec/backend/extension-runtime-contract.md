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
- Re-evaluate domain corrections, topic/content-type preferences, and deterministic rules before looking up an AI cache entry. Rank provider folders using the estimated budget, not a fixed six-folder limit; validate destinations against the complete supplied smart-root folder set, not only the candidates. See the classification cache scenario below for the selection and reuse contract.
- Cache only eligible, validated AI results against their actual single or complete-batch request context; a folder change outside that context need not invalidate an otherwise valid hit.
- Classification output is strict Zod data: `move` requires `targetFolderId`; `suggest_folder` requires a name and `parentId`; `keep` has no destination; confidence is in `[0,1]`.
- Persist jobs, review items, settings and settings drafts, cache, activity history, import marker, undo record, and pending mutation intent through `chrome.storage.local`. Keep API keys out of sync storage, logs, errors, and notifications.
- Register Chrome listeners synchronously at background module initialization. Persist a job before classification; use bookmark ID as its idempotency key. Use alarms for finite retry and worker restart recovery.
- During `resume()`, query permission for the currently configured provider origin. Promote `awaiting_permission` jobs only when an API key exists and that exact origin is granted; clear the stale permission error before requeueing.
- Persist a pending move intent before calling `chrome.bookmarks.move`; re-read the bookmark and validate its source and destination immediately before mutation. Never delete a bookmark or folder.
- If `chrome.bookmarks.move` rejects, reconcile the persisted intent immediately against the bookmark's live parent. Treat the move as committed if the target parent is observed; clear the intent and fail safely if the source remains; mark the operation stale/skipped if the bookmark is elsewhere.
- The background initializes one account-named folder under the editable `bookmarks-bar` root, stores its ID in local state, and creates the default first-level folders once. If `chrome.identity.getProfileUserInfo()` has no email, use `bookmark` as the owner name.
- Automatic classification, manual metadata generation, historical scans, review mutations, undo, and recovery are limited to that persisted smart root and its descendants. Re-read the live tree before sending bookmark data to a provider or mutating Chrome bookmarks.
- Retain the legacy `forceOrganize` setting only for storage compatibility; it must not expand the smart-root boundary.
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
- Inspect the production manifest: required permissions are `bookmarks`, `storage`, `notifications`, `alarms`, and `identity.email`; provider origins remain optional and no static all-site permission is present.

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

Use this contract when changing folder ranking, classification inputs, learned decisions, provider request construction, cache persistence, or historical batch classification. Reuse must preserve the decision and the actual provider-request context, not merely match a bookmark URL.

### 2. Signatures

- `ClassifierPort.classify(input, folders, settings, hasProviderPermission, snapshot?): Promise<ClassifiedResult>`.
- `ClassifierPort.classifyBatch?(inputs, folders, settings, hasProviderPermission, snapshot?): Promise<BatchOutcome[]>`.
- `ClassifierProvider.getCacheRequest?(mode, inputs, folders, config, recentCorrections?): Record<string, unknown> | undefined`; `classify` and `classifyBatch` can report the successful request body through `onRequest`.
- `ClassifierProvider.getCacheVariant?(): number | undefined`; `ClassifiedResult.cacheValidation?(): boolean` is a transient check for cached outcomes and must never be persisted or exposed in dashboard data.
- `rankFolderCandidates(input: ClassificationInput, folders: FolderSummary[]): FolderSummary[]`; `trimFolderBudget(folders: FolderSummary[]): FolderSummary[]`.
- A version-2 `CacheEntry` stores `key`, the legacy-compatible first `result`, `source: 'ai'`, `createdAt`, `version: 2`, `mode`, and ordered `results`.

### 3. Contracts

- Require a configured API key first. For each input, re-evaluate the domain correction, page-profile preference, and full-folder deterministic rule in that order. Apply the current confidence threshold to the deterministic rule. These local decisions are not AI cache entries.
- Candidate selection uses an estimated 10,000-byte folder budget, not an exact serialized-byte ceiling. At or below that estimate, a single request keeps the supplied folder list in order. Above it, weak or ambiguous evidence still keeps the full list; meaningful evidence ranks folders and uses the estimate to select candidates, with a floor of 12 when enough ranked folders exist and samples stripped where necessary to meet that floor. A ranked single request retains its current folder when present, replacing the last selected folder if needed. This is neither a six-folder maximum nor a guarantee that every request is truncated.
- A batch first resolves local decisions, preserves input positions, then builds the shared candidate list from the ordered union of ranked lists for at most the first eight remaining AI inputs and applies `trimFolderBudget`. The final batch trim does not guarantee retention of every input's current folder. Recent decisions are recomputed from up to five corrections ordered by `createdAt` descending, including folder paths resolved from the supplied full folder list.
- Versioned single and batch keys use HMAC-SHA-256 over serialized context: mode, ordered original inputs including URL and optional derived profile, protocol, normalized endpoint, model, credential generation, and the provider's expected request body. The body contains the ordered serialized candidates, recent decisions, prompt, schema and request parameters. The API key is the HMAC secret, not persisted in the cache key; do not persist the request body, raw page content, or derived profile solely for matching. Remote provider behavior can change without a visible configuration change.
- A lookup is eligible only when the provider can describe the expected request and a valid matching entry exists. A fresh result is stored only when the reported successful request body matches that expected identity; fallback tool/prompt/reasoning variants may therefore miss, including after worker restart. If cryptography, identity construction, or a provable request variant is unavailable, skip reuse rather than assume equivalence. Not every successful request is cacheable.
- Cache lookup checks the expected request and monotonic provider-variant token around asynchronous hashing, with at most three attempts. A cached outcome carries a token check through the organizer's final comparison; a concurrent fallback invalidates that outcome even if the provider later returns to a previous request shape. Equivalent fallback observations do not advance the token.
- Keep single and batch namespaces separate. A batch entry represents exactly the complete ordered AI subset from one request and its shared context; never assemble a hit from individual prior requests. Merge local and AI outcomes back into original order. If any AI member is invalid or missing, do not cache a partial batch, even if another member can be returned as a per-item success. Changes to batch membership or order can increase provider calls.
- Validate cached and fresh `move` targets and `suggest_folder` parents against the complete supplied folder set, excluding managed folders; `keep` has no target. Validate and remove the provider's batch `index` values before strict result validation. The organizer's live smart-root and source/target checks still apply before review approval or mutation.
- The repository rejects legacy, malformed, mismatched, or oversized entries; old keys are cold misses. Cache at most 200 results in total and at most 64 KiB per encoded entry, evicting whole entries rather than splitting batches. Persist credential generation with settings, increment it on an actual API-key change, and recheck both generation and key in the repository update before writing a cache entry. Existing settings, jobs and reviews remain separate from cache normalization.
- The organizer shares a folder/settings/repository snapshot across a prepared batch, checks it after preparation, and compares the root, settings, corrections, preferences, credential generation, full folder summaries, and relevant job/bookmark data again before applying results. Apply the comparison to cache hits and provider responses; on a detected change, discard affected results and retry within the existing bounded limit or fail safely. Batch outcomes are applied individually, with checks before remaining outcomes.
- The classifier can write a valid AI cache entry before the organizer's final comparison; the write checks credential generation and key, not every bookmark or learning field. A later lookup must still recompute local decisions and match its own request context. Chrome bookmarks and extension storage do not share an atomic transaction: comparisons are sequential, cannot guarantee global snapshot isolation or detect every intervening change, and cannot protect against changes after the final check. Live mutation checks remain necessary.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Missing API key | Fail before local or cache classification; do not call the provider |
| Missing provider-origin permission | With a key, return an eligible local result or complete valid cache hit; otherwise fail with `PermissionRequiredError` without a provider call. A mixed batch needing AI fails at batch level, not as a silently returned subset |
| Legacy, malformed, wrong-mode, mismatched, oversized, or invalid-target entry | Treat as a miss; do not reuse any part of an invalid batch |
| Successful request variant differs from expected or cannot be proven | Do not store that response for reuse under the expected key |
| Failed, incomplete, schema-invalid, or invalid-target batch | Never persist a reusable partial batch; preserve existing per-item errors where applicable |
| Context change detected during preparation or before application | Discard affected outcomes, retry boundedly, or fail without applying them |
| Credential changes while a request is in flight | The repository update skips its cache write; the organizer separately checks the classification context |

### 5. Good / Base / Bad Cases

- **Good**: In an over-budget tree, an excluded folder changes without changing the local decision, ordered provider context, or target validity; an otherwise eligible cached result may be reused.
- **Base**: For a single request, all folders fit the budget or evidence is weak, so they are sent; a change to a sent folder can legitimately produce a miss.
- **Bad**: A batch member changes or moves position, or a stored target becomes managed/deleted; do not reuse individual members of the prior batch.

### 6. Tests Required

- Assert the local correction, preference, and threshold-aware rule run before cache lookup; verify a missing key and single/batch permission behavior.
- Cover budget-fit, weak-evidence and over-budget candidate selection, including single current-folder retention and batch union/trim behavior. Compare the old full-tree fingerprint with a stable excluded-folder change and count provider calls.
- Assert original URL, candidate order/data/parent, recent correction paths, protocol/model, request variants, and batch membership/order affect reuse; test default and fallback paths across worker restart.
- Assert complete batch hits, mixed local/AI result order, real provider `index` normalization, invalid targets, incomplete responses, and no partial batch writes.
- Cover legacy/malformed state and old-code access to new state, credential A-to-B-to-A and in-flight changes, result/encoded-size limits, whole-batch eviction, and absence of key material or request bodies in cache storage.
- Exercise preparation, post-cache and pre-response context changes, bounded retries, live source/target checks, and historical scans using the real cache. Distinguish scan job/review deduplication from cache hits and provider invocations from HTTP retries/fallback.

### 7. Wrong vs Correct

- **Wrong**: Look up a result by normalized URL and the entire folder tree before consulting current corrections, or reuse individual results from a different AI batch.
- **Correct**: Recompute local decisions first, then reuse only a validated single result or complete batch whose expected request context matches; otherwise classify the current AI subset and recheck the organizer context before application.

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
- `OrganizerService.startHistoricalScan(): Promise<{ scanId: string; eligibleTotal: number }>`.
- `OrganizerService.approveAllHistoricalReviews(scanId?: string): Promise<number>`.
- `OrganizerService.undoHistoricalLast(): Promise<number>`.
- `HistoricalScanState`: `{ id, status, startedAt, updatedAt, eligibleTotal, processedCount, pendingReviewCount, failedCount, skippedCount, coveredIds, forceOrganize }`.
- Historical `BookmarkJob` and `ReviewItem` records carry optional `scanId`; `DashboardState` exposes only the scan summary, never `coveredIds` or `forceOrganize`.

### 3. Contracts

- A scan is explicit and preview-only. It never moves a bookmark or creates a folder during classification.
- Enumeration accepts only editable HTTP(S) bookmark nodes in the persisted smart-root subtree. Managed branches, folders, and unsupported URL schemes are skipped; `forceOrganize` does not expand this boundary.
- Scan jobs persist before classification and reuse the existing classifier, cache, folder-target validation, review creation, pending move intent, and worker recovery paths.
- Historical `move` and `suggest_folder` results always become pending reviews, independent of normal automatic mode or confidence threshold. `keep` completes without mutation.
- `scan:approve-all` processes a snapshot sequentially through the same live source/target checks as per-item approval. Stale, deleted, or failed items do not abort other items. An instance lock rejects a concurrent batch request.
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
await organizer.approveAllHistoricalReviews(scanId); // sequential live checks and intents
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
