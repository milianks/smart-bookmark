# Technical Design

## Architecture Boundary

Add a dedicated background-owned `BookmarkMetadataService`; keep classification and organizer flows unchanged. UI requests generation through strict runtime messages and renders metadata returned in `DashboardState`. Only background service may read bookmark tree, provider settings/permissions, or persist metadata. Generation never invokes bookmark mutation APIs.

## Input and Provider Contract

- Add `SummaryTagResultSchema` as a strict object: bounded non-empty summary plus a bounded list of unique, non-empty tags. Set conservative explicit limits in code (summary <= 500 chars, <= 8 tags, each <= 32 chars); reject extra fields.
- Define `BookmarkMetadataInput` with only title, URL, domain, and current folder path. Build prompt from this typed projection; no arbitrary Chrome objects, page content, folder tree, or existing generated text.
- Add a provider method using the configured protocol/configuration and existing endpoint/auth/permission conventions. Parse the protocol envelope, extract assistant text, parse JSON, validate schema, and return sanitized errors. Classification request/prompt/schema/cache remain unchanged.
- Do not add a metadata cache initially: explicit regeneration is expected to call provider, and simple bounded local storage avoids duplicating cache invalidation semantics.

## Persistence and Service Flow

- Add optional `bookmarkMetadata: Record<string, BookmarkMetadata>` on `PersistedState`, keyed by bookmark ID; each record contains validated summary/tags and `generatedAt`. Normalize absent/malformed legacy data to `{}` without changing storage version.
- `BookmarkMetadataService.generate(bookmarkId)` serializes requests per ID in memory, checks existing work, loads configured settings, requires API key and permission for configured origin, obtains the live bookmark and folder path, and sends metadata-only input.
- On successful schema validation, update only that bookmark's metadata record. On every failure, preserve prior metadata. Missing/deleted bookmark fails safely. No durable processing job is needed: manual operation may be retried after worker restart; successful records already persist.
- On concurrent same-ID requests, return/reuse the in-flight promise. Different bookmark IDs remain independent.
- Project metadata into dashboard/review output by bookmark ID; never include API key, prompt, raw payload, or provider fingerprint.

## Runtime and UI

- Add strict `bookmark:metadata:generate` request with non-empty bookmark ID; handler delegates to service and returns success. `state:get` projection exposes metadata in recent jobs and review items through their existing bookmark IDs.
- Popup `BookmarkCard` accepts optional metadata and generate callback; expose “生成摘要与标签” / “重新生成”, busy and error/status feedback. Keep existing card status and refresh after success.
- Review detail renders metadata for selected item and offers the same manual generation action, with per-item busy state; review approve/reject behavior remains untouched.
- Never persist UI request state or add page-side Chrome API access.

## Compatibility, Privacy, and Failure Behavior

- No new permissions, dependencies, storage key/version, or auto-generation. Prompt sends only title, URL, domain, folder path.
- Missing key, missing origin permission, stale bookmark, transient provider failure, malformed JSON, or invalid/oversized schema yields bounded sanitized user-visible error and leaves stored metadata unchanged.
- Existing P0/P1 classification, scan, review, undo and provider behavior remain unchanged.

## Verification and Rollback

- Unit tests: schema bounds/strictness; provider protocol path and malformed response; repository normalization; service input privacy, permission/error preservation, concurrent same-ID requests, persistence and deleted bookmark; router contract; UI flow state.
- Run focused tests, `pnpm typecheck`, `pnpm test --run`, `pnpm build`, and `git diff --check`; manually exercise generate/regenerate, failure preservation, restart/reopen, and confirm bookmark location unchanged.
- Revert metadata domain/storage/provider/service/runtime/UI changes together; backward-compatible optional storage field means old state remains readable.
