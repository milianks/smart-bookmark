# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

The background worker is the sole owner of persisted state and Chrome bookmark mutations. Keep its boundaries typed and validated, and preserve failure-safe behavior: provider, permission, or stale-state failures leave the bookmark in place. There is no ESLint script or server-side test framework in this repository.

## Forbidden Patterns

- Do not mutate Chrome bookmarks from a UI page or bypass `OrganizerService` with a direct `chrome.bookmarks.move/create` call. All bookmark changes go through the worker workflow and its fresh-state checks.
- Do not trust runtime messages or AI output without strict Zod validation and current-tree target validation (`entrypoints/background.ts`, `types/domain.ts`, `services/classifier.service.ts`).
- Do not request broad static host permissions or send full bookmark trees/page content to the provider; only the current bookmark context and folder summaries are used, with optional permission for the configured API origin.
- Do not expose the API key in dashboard data, errors, notifications, logs, or synced storage. The UI receives `hasApiKey`; a replacement key crosses the runtime message boundary through `settings:update`, is stored in local extension storage, and is used by the background's configured provider.
- Do not use raw `chrome.storage.local` from feature services instead of `StateRepository`, or silently ignore a failed move without reconciling its pending intent.

## Required Patterns

- Register MV3 listeners synchronously during background evaluation, then delegate their work to services. Attach rejection handlers to fire-and-forget promises.
- Keep classification and organization dependencies behind ports (`ClassifierPort`, `BookmarkPort`, `StateRepository`, `NotificationPort`, `AlarmPort`) so service behavior can be tested without Chrome.
- Persist jobs and pending mutation intent before work that must survive worker shutdown; re-read the bookmark and target immediately before moving. Reconcile if Chrome rejects a move.
- Treat external data as untrusted: strict Zod schemas reject extra fields, confidence is bounded, and destination IDs must match the live folder tree.

## Testing Requirements

Run the repository checks after backend changes:

```bash
pnpm typecheck
pnpm test --run
pnpm build
```

Vitest runs `tests/**/*.test.ts` in the Node environment (`vitest.config.ts`). Service tests use fake bookmark ports and in-memory repositories; follow that pattern for retry, permission, duplicate-event, recovery, and mutation behavior. Existing coverage is in `tests/organizer.test.ts`, `tests/organizer.service.test.ts`, `tests/bookmark.service.test.ts`, `tests/classifier.test.ts`, and `tests/openai-compatible.test.ts`. `package.json` defines no lint command.

## Code Review Checklist

- Does the background remain the only writer of bookmarks and persistent state?
- Are runtime payloads and provider responses validated before use?
- Are permissions restricted to the configured provider origin, and is the API key absent from public response data and diagnostics?
- Are jobs/reviews idempotent and recoverable after worker restart?
- Do failure paths keep bookmarks in place and reconcile pending moves?
- Do tests assert externally observable state and Chrome calls, rather than only restating implementation details?
