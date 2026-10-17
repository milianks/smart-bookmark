# Database Guidelines

> Persistence patterns and conventions for this project.

---

## Overview

There is no server, SQL database, ORM, or database migration framework in the current extension. Durable application state is stored on the user's device through `chrome.storage.local`, accessed by `ChromeStateRepository` in `lib/storage/repository.ts`. Do not document or assume tables, SQL queries, transactions, or remote persistence.

## Query Patterns

Use the `StateRepository` interface (`load()` and `update(mutator)`) rather than reading or writing the storage key from feature code. The Chrome implementation serializes writes with a promise chain, normalizes loaded state, validates persisted settings with `SettingsSchema`, and limits retained activity entries to the latest 100.

```ts
await store.update((state) => {
  state.jobs[id] = job;
});
```

This is the update style used by `OrganizerService` and `ClassificationService`. Keep the mutator synchronous and put asynchronous work before or after the repository update. Use `MemoryStateRepository` or a small `StateRepository` fake in service tests instead of requiring a browser profile.

The repository currently stores one versioned state object under `ai-bookmark-manager.state.v1`. Its fields include `settings`, `jobs`, `reviews`, `cache`, `activities`, and optional `lastUndo`, `pendingOperation`, `importStartedAt`, `settingsDraft`, `historicalScan`, and `lastHistoricalUndo`. Historical jobs and reviews may carry `scanId`; the dashboard receives a summary without internal covered IDs. The `version: 1` field is a format marker; no migration runner exists. If the persisted shape changes, preserve safe defaults/normalization in the repository and add tests for old or malformed stored values.

## Migrations

There are no SQL migrations or migration commands. Do not add migration files by analogy with a server application. Any future local-state format upgrade must be explicitly implemented in the repository's normalization path and verified against stored data shapes.

## Naming Conventions

The single Chrome storage key is an explicit lower-case, dot-separated string (`ai-bookmark-manager.state.v1`). Persisted property names follow the TypeScript domain model in `types/domain.ts` (`settings`, `jobs`, `reviews`, `cache`, `activities`, `lastUndo`, `pendingOperation`, `importStartedAt`, and `settingsDraft`). There are no table, column, or index naming conventions.

## Common Mistakes

- Do not use `chrome.storage.sync` or persist this state remotely; the product uses local extension storage.
- Do not bypass `StateRepository` and mutate `chrome.storage.local` from UI pages or feature services. The background owns persistent state.
- Do not assume browser local storage is a secret vault. The API key is stored locally by design, and the README warns users to use a revocable, low-quota key and avoid shared devices.
- Do not mistake the `version` property for an existing migration system.
