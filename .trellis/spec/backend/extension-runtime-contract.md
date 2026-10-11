# Chrome Extension Runtime Contract

## Scenario: Persisted bookmark classification and review workflow

### 1. Scope / Trigger

Use this contract when changing the MV3 background, bookmark or folder services, local extension storage, AI provider, runtime messages, notifications, or review operations. The background service worker is the only layer allowed to mutate Chrome bookmarks.

### 2. Signatures

- `BookmarkPort.getTree(): Promise<BookmarkNode[]>`
- `BookmarkPort.getFolders(): Promise<FolderSummary[]>`
- `BookmarkPort.moveBookmark(bookmarkId: string, targetFolderId: string): Promise<void>`
- `BookmarkPort.createFolder(name: string, parentId: string): Promise<BookmarkNode>`
- `ClassifierPort.classify(input, folders, settings, hasProviderPermission): Promise<ClassifiedResult>`
- `OrganizerService.onBookmarkCreated(id, node): Promise<void>`
- `OrganizerService.approveReview(id): Promise<void>`
- `OrganizerService.rejectReview(id): Promise<void>`
- `OrganizerService.undoLastMove(): Promise<string>`
- `StateRepository.load(): Promise<PersistedState>` and `update(mutator): Promise<PersistedState>`

### 3. Contracts

- Runtime requests are a discriminated union: `state:get`, `settings:update`, `settings-draft:get`, `settings-draft:set`, `settings-draft:clear`, `provider:test`, `review:approve`, `review:reject`, and `undo:last`. Validate incoming messages with Zod before dispatch; settings drafts are persisted locally through the same repository.
- Classification input contains one new bookmark's title, URL, domain, current folder ID/path, and folder `{id, name, path}` summaries. Never send the full bookmark tree or page content to the provider.
- Classification output is strict Zod data: `move` requires `targetFolderId`; `suggest_folder` requires a name and `parentId`; `keep` has no destination; confidence is in `[0,1]`.
- Persist jobs, review items, settings and settings drafts, cache, activity history, import marker, undo record, and pending mutation intent through `chrome.storage.local`. Keep API keys out of sync storage, logs, errors, and notifications.
- Register Chrome listeners synchronously at background module initialization. Persist a job before classification; use bookmark ID as its idempotency key. Use alarms for finite retry and worker restart recovery.
- During `resume()`, query permission for the currently configured provider origin. Promote `awaiting_permission` jobs only when an API key exists and that exact origin is granted; clear the stale permission error before requeueing.
- Persist a pending move intent before calling `chrome.bookmarks.move`; re-read the bookmark and validate its source and destination immediately before mutation. Never delete a bookmark or folder.
- If `chrome.bookmarks.move` rejects, reconcile the persisted intent immediately against the bookmark's live parent. Treat the move as committed if the target parent is observed; clear the intent and fail safely if the source remains; mark the operation stale/skipped if the bookmark is elsewhere.
- Default processing accepts only direct children of built-in roots detected through `folderType`. Treat nested user folders as intentional and preserve them unless force mode is enabled.
- Automatic moves require automatic mode and confidence at or above the configured threshold. Folder creation always waits for explicit review approval. Review approval must be idempotent and revalidate live bookmark/folder state.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Folder event, unsupported URL scheme, or malformed URL | Ignore without creating a job |
| Import marker active | Suppress new classification; expire stale marker during recovery |
| API key missing | Persist `awaiting_configuration`; leave bookmark where it is |
| API origin permission missing | Persist `awaiting_permission`; do not call `fetch` |
| Provider-origin permission later granted | On settings update or worker resume, recheck the configured origin and requeue only if the API key and permission are both present |
| Provider timeout, HTTP failure, invalid JSON, or schema failure | Keep bookmark in place; record visible failure; retry only bounded transient errors |
| Bookmark move rejects | Immediately reconcile the pending intent against the live parent; do not leave a stale intent blocking later mutations |
| Target folder or source bookmark changed/deleted | Mark job/review stale or failed; do not move |
| Duplicate event or concurrent processing | One job and at most one move per bookmark |
| Undo source missing or bookmark manually moved | Keep current placement and report why undo was skipped |

### 5. Good / Base / Bad Cases

- **Good**: A newly created bookmark under `bookmarks-bar` is persisted, classified, matched to a real folder, and moved only after a fresh source/target check; an undo record stores both folder IDs.
- **Base**: A low-confidence match creates a durable review item and notification while the bookmark remains in its source folder.
- **Bad**: A model returns an invented folder ID, an API request fails, or a stale review is approved; the result must not mutate the bookmark.

### 6. Tests Required

- Mock `BookmarkPort`, `StateRepository`, classifier, notifications, and alarms.
- Assert existing-folder auto-move, new-folder approval, rejection, missing key, provider failure, import suppression, deleted targets, duplicate/concurrent events, worker recovery, and undo.
- Assert a rejected move clears or reconciles its pending intent immediately, including the case where the browser applied the move before the promise rejected; later mutations must not remain blocked.
- Assert missing provider permission leaves the job waiting and granting the exact configured origin lets `resume()` classify it once.
- Assert every failed/stale path leaves the bookmark parent unchanged and does not call create/move unexpectedly.
- Inspect the production manifest: required permissions are `bookmarks`, `storage`, `notifications`, and `alarms`; provider origins remain optional and no static all-site permission is present.

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
if (!bookmark || bookmark.parentId !== job.bookmark.parentId) return;
if (!target || target.unmodifiable === 'managed') return;
await this.deps.store.update((state) => { state.pendingOperation = operation; });
try {
  await this.deps.bookmarks.moveBookmark(job.bookmark.id, targetFolderId);
} catch (error) {
  await this.reconcilePendingOperation();
  throw error;
}
```

This is the live-source/target and durable-intent sequence used by `OrganizerService.automaticMove`. A rejected call can still have changed the browser state, so reconciliation compares the actual parent with both recorded parents before deciding whether the operation completed or failed. Keep Chrome API mutation inside the organizer and validate every ID against the current bookmark tree.

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

- **Good**: `https://provider.example/v1` with `openai-responses` calls `/v1/responses`, extracts assistant text, validates the result, and caches only normal classification output.
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
