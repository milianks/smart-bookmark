# Implementation Plan

1. **Model and persistence:** Add the protocol union/default and settings validation; normalize legacy settings without losing existing values; extend settings patch validation; add protocol to the classification cache key.
2. **Provider adapters:** Extend `ProviderConfig`; implement endpoint/request/auth/response extraction for Anthropic Messages, Chat Completions, and Responses. Reuse prompt and Zod validation; preserve timeout, bounded response reads, permission origin checks, and safe errors.
3. **Synthetic test:** Replace the current “HTTP shape only” test with a minimal synthetic classification through the selected adapter. Verify it neither touches bookmarks nor persists classification data.
4. **Settings UI:** Add protocol selection, endpoint guidance, and the compact layout. Keep one save action, the current save-before-test flow, and all existing controls inside visible or disclosed sections.
5. **Tests:** Extend provider tests for each protocol's exact URL, headers, body, output extraction, and failure paths; add repository legacy-settings coverage and a protocol-sensitive cache test.
6. **Quality gate:** Run `pnpm typecheck`, `pnpm test --run`, and `pnpm build`; review changed UI for keyboard labels, privacy, errors, and retention of existing controls.

## Validation commands

```bash
pnpm typecheck
pnpm test --run
pnpm build
```

## Risk and rollback points

- Highest-risk files: `types/domain.ts`, `lib/storage/repository.ts`, `lib/ai/openai-compatible.ts`, `lib/ai/provider-config.ts`, `services/classifier.service.ts`, `entrypoints/background.ts`, and `components/SettingsApp.tsx`.
- Persistence rollback point: verify legacy normalization against a copied v1 state fixture before changing settings validation. Do not test migration by overwriting a live browser profile.
- Provider rollback point: retain a passing Chat Completions request fixture before adding the other adapters; all provider tests use stub fetch and do not call the test URL.
- UI rollback point: keep all previous settings controls represented and saveable before removing the duplicate save button or changing page grouping.

## Before `task.py start`

- Present the final planning summary and wait for the user's explicit approval of that summary.
- Confirm the existing unrelated `.trellis/spec/` working-tree edits remain untouched.
