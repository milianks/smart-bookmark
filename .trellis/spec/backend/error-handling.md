# Error Handling

> How errors are handled in this project.

---

## Overview

Errors cross three boundaries: provider/storage/Chrome operations inside services, page-to-background runtime requests, and background event listeners. Preserve useful user-facing reasons while keeping provider payloads and secrets out of logs and responses. This project has no server request/response error format.

## Error Types

- `ProviderError` in `lib/ai/openai-compatible.ts` carries a user-safe message and a `retryable` flag for provider/network failures.
- `PermissionRequiredError` in `services/classifier.service.ts` represents a missing optional API-origin permission.
- Other service operations currently use normal `Error` instances; there is no shared error hierarchy for every Chrome API failure.

## Error Handling Patterns

- Validate external shapes at entry: `RequestSchema.safeParse(message)` validates runtime messages, and `ClassificationResultSchema.safeParse(parsed)` validates model output. Validate suggested folder IDs against the current folder list before any mutation.
- Catch errors where the system can choose recovery behavior. `OrganizerService.processJob` persists `awaiting_permission`, schedules bounded retryable provider failures, or marks a job failed while leaving the bookmark in place.
- For service work started by Chrome event listeners in `entrypoints/background.ts`, attach `.catch(reportBackgroundError)` so rejected service promises are observed. The notification-click listener currently opens the review page without handling a rejected tab-creation promise; do not copy that exception for service work.
- At UI-triggered runtime requests, return `{ ok: false, error }` from the background boundary; UI components catch `unknown`, convert it to display text, and refresh stale state when appropriate.
- Preserve the original error when rethrowing after cleanup or reconciliation. Do not turn every failure into success or silently continue after a failed mutation.

```ts
void organizer.onBookmarkCreated(id, node)
  .catch((error: unknown) => reportBackgroundError(error));
```

`entrypoints/background.ts` uses this pattern for asynchronous Chrome event callbacks. The runtime message listener separately resolves to `{ ok: true, data }` or `{ ok: false, error }`.

## API Error Responses

There is no HTTP API server. Runtime requests use the `RuntimeRequest` union in `types/messages.ts`; successful replies have `{ ok: true, data }`, and rejected handled requests have `{ ok: false, error: string }`. A malformed incoming request fails `RequestSchema.safeParse` and is not dispatched. Do not invent REST status codes or a server error envelope.

`types/messages.ts` provides `unwrapResponse()` for pages; it throws the returned error string so the component can display it. The background currently returns `Error.message` verbatim (or a generic fallback for non-`Error` values), so errors crossing this boundary must already be safe and suitable for display. Provider errors use concise status text, and failures must not cause unsafe bookmark moves.

For non-2xx provider responses, parse only bounded JSON fields needed for explicitly recognized error codes. Map those codes to fixed user-safe messages; never reflect arbitrary provider `message` fields or response bodies. A provider-suggested replacement base URL is display-only: require HTTPS, reject credentials/query/fragment, and pass the existing `normalizeBaseUrl()` validation before including it in an error. Never follow the suggested URL or update saved settings automatically. Preserve current status-based fallback and retryability for unrecognized errors.

## Common Mistakes

- Do not trust an AI response merely because JSON parsing succeeded; require strict Zod validation and current-folder ID validation.
- Do not swallow an error around bookmark mutation without reconciling the actual bookmark parent. `OrganizerService` reconciles a persisted pending operation because Chrome may apply a move before its promise rejects.
- Do not use `void` to suppress rejection handling for service or repository work; attach a rejection handler as the bookmark, import, startup, and alarm listeners do. The notification-click tab creation and the `setAccessLevel` setup call are current fire-and-forget exceptions, not patterns to copy for new work.
- Do not place API keys, request bodies, provider response payloads, or full URLs in diagnostic errors. `reportBackgroundError` logs `Error.message` verbatim, so every error passed to it must already be safe to log.
