# Implementation Plan

## Ordered work

1. **Initialize the extension:** Use the latest stable WXT React/TypeScript starter with pnpm. Add Tailwind CSS and shadcn/ui primitives, WXT entrypoints for background/popup/options/review, strict TypeScript settings, Vitest, and `pnpm dev` / `pnpm build` / `pnpm test` / `pnpm typecheck` scripts. Configure Manifest V3, minimum Chrome 134, required `bookmarks`, `storage`, `notifications`, and `alarms` permissions, and optional HTTPS/loopback host patterns solely to enable a user-selected provider origin. Request only the exact configured origin at runtime. Inspect the generated manifest for accidental static host access.
2. **Define contracts and browser boundaries:** Add typed settings, classification results, queue/review/activity/cache/undo records, and a discriminated runtime-message contract. Implement bookmark-tree/folder operations, storage repository, and permission adapter behind injectable interfaces. API Key is required for processing; store key/settings/jobs/cache/logs locally, never in source, logs, or test fixtures.
3. **Implement cost-controlled classification:** Add strict Zod result schemas, an injection-resistant prompt, OpenAI-compatible chat-completions provider with timeout and bounded response parsing, normalized-URL/folder-fingerprint cache, conservative deterministic domain/title rules, and folder-context mapping. Run cache/rules before network calls, but require the key before any automatic classification. Settings request the exact configured host permission from a user gesture. A configured provider failure remains preserve-in-place and visible; jobs without a key wait for configuration.
4. **Implement the durable organizer:** Synchronously register MV3 bookmark/import/startup/alarm/message/notification listeners. Persist import suppression state and per-bookmark jobs before work, add `awaiting_configuration` handling, deduplication, bounded concurrency/retries, eligible-root and force-mode checks, live target-folder validation, confidence/mode policy, idempotent review approval/rejection, notifications, bounded activity history, and undo of the latest automatic move. Reconcile incomplete operations after worker restart.
5. **Build the extension pages:** Implement Chinese popup dashboard, settings and provider test, operation log, and review page with actionable existing-folder/new-folder recommendations. Persist and reload settings, require API credentials before processing, show pending/setup/provider state and last automatic move, expose undo, support optional success notices separately from review/error notices, and render AI/user data as text. Apply system light/dark styling.
6. **Add tests and documentation:** Mock Chrome APIs and cover all acceptance cases: missing-key setup blocking, cache/rule preclassification, existing-folder auto-move, new-folder suggestion, confirmation, rejection, provider failure, import suppression, deleted folders, duplicate/concurrent events, root-versus-nested policy, restart/retry recovery, and undo. Write README instructions for dev/build, loading unpacked output, mandatory AI configuration, permissions/privacy, root-folder behavior, and current limitations.
7. **Verify and finish:** Run typecheck, Vitest, and production build. Inspect `.output/chrome-mv3/manifest.json`; confirm only intended required permissions and no default host access. Start `pnpm dev` as a smoke check if the environment supports launching the Chrome target. Review the full diff and `git diff --check`, update relevant Trellis specs, then follow the project finish workflow.

## Validation commands

```sh
pnpm install
pnpm typecheck
pnpm test --run
pnpm build
pnpm dev
```

`pnpm dev` is a local smoke check, not a substitute for the mocked service tests. If Chrome cannot be launched in the development environment, verify the WXT dev build output and document the manual `chrome://extensions` loading step.

## Risk and recovery points

- **Manifest/host permissions:** `wxt.config.ts` and generated `manifest.json` determine install-time access. Inspect the output before proceeding; remove any static website host permission. Request only the configured API origin at runtime.
- **MV3 lifecycle:** `entrypoints/background.ts` and persistent job/import state are high-risk. Keep listener registration synchronous and test worker restart reconciliation through injected storage/API mocks.
- **Bookmark mutation:** `services/organizer.service.ts` is the only layer allowed to move/create. Revalidate source, target, parent, and status immediately before each mutation. Never delete. Keep every auto move recoverable through the stored undo record.
- **Provider data/key handling:** `lib/ai/` must send only the new bookmark and folder metadata. Never log keys or request/response authorization headers. Invalid output and failed requests must leave the bookmark unchanged.
- **Rollback:** The extension can be removed without changing Chrome's existing bookmarks. If a shipped build moves an item incorrectly, use the stored undo action when possible or manually move it in Chrome; disable automatic organization in settings while investigating.

## Review gate before activation

- [ ] PRD acceptance criteria are mapped to meaningful tests or a documented manual check.
- [ ] The generated manifest contains no static all-site permissions.
- [ ] New-folder approval, rejection, provider error, and undo paths never delete or lose a bookmark.
- [ ] Popup/settings/review all use the same typed background message contract.
- [ ] README states the Chrome 134+ minimum, required API Key, cache/rule pre-match behavior, API-key storage limitation, and root-folder approximation.
- [ ] README states that pure local-only mode is deferred and remote errors preserve the bookmark in place.
