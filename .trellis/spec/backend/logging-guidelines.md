# Logging Guidelines

> How diagnostics and user-visible activity are recorded in this project.

---

## Overview

There is no logging library, structured logger, or configured log-level system. The background has one diagnostic boundary in `entrypoints/background.ts`; separately, `ActivityRecord[]` in persisted state is a user-visible operation history, not a diagnostic log stream.

## Log Levels

No project-wide levels are defined. The current diagnostic path uses `console.error` when a background event or startup operation rejects. Do not claim that `debug`, `info`, or `warn` are standardized here.

## Structured Logging

There is no structured log schema. Keep the existing diagnostic concise and pass only an error whose message is safe to log. The helper prints `Error.message` verbatim (or `unknown error` for non-`Error` values); it does not redact arbitrary text:

```ts
console.error('[AI Bookmark Manager] background operation failed:',
  error instanceof Error ? error.message : 'unknown error');
```

This is the `reportBackgroundError` implementation in `entrypoints/background.ts`. Do not pass request or provider payloads to it.

## What to Log

Use the persisted activity feed for user-facing lifecycle events such as received, moved, review created, failed, skipped, and undone. `OrganizerService` appends typed `ActivityRecord`s; the popup/options UI renders them through `RecentActivity`. Keep these messages short and useful to the extension user. They are product state and can include bookmark title or URL where the activity model supplies it; do not treat them as private diagnostic telemetry.

For diagnostics, report only that a background operation failed and a safe, concise message, following `reportBackgroundError`.

## What NOT to Log

- Never pass API keys, request bodies, full request URLs, or raw provider response payloads to the background diagnostic helper; it does not redact the supplied message.
- Do not turn the user-facing activity list into a dump of Chrome objects, provider prompts, or stack traces.
- Do not add external analytics or remote logging. The current dependency list contains no analytics SDK, and the README documents that persisted activity is stored locally.
