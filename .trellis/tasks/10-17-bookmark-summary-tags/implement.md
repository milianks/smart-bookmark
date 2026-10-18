# Implementation Plan

## Ordered Checklist

- [x] Add bounded strict metadata schema and backward-compatible per-bookmark persistence; test legacy normalization.
- [x] Add metadata-only provider prompt and summary/tag method using existing three protocol transport; test strict response validation and sanitized failures.
- [x] Implement background-owned metadata service: live bookmark and folder lookup, API-key/origin permission checks, same-bookmark in-flight deduplication, and write only after successful validation.
- [x] Add strict runtime request/router facade and expose metadata to Popup recent jobs and Review items without secrets/provider internals.
- [x] Add generate/regenerate controls and visible busy/error/success UI in Popup bookmark cards and Review detail.
- [x] Update README and applicable runtime/UI specs for metadata-only manual generation.
- [x] Run focused tests, `pnpm typecheck`, `pnpm test --run`, `pnpm build`, and `git diff --check`; all pass.
- [ ] Manual Chrome smoke test for generation/regeneration, failure preservation, reopen persistence, and unchanged bookmark location; browser MCP is unavailable in this session.

## Risky Files and Rollback Points

- `types/domain.ts`, `lib/storage/repository.ts`: persisted metadata shape and normalization; optional field preserves old state.
- `lib/ai/prompts.ts`, `lib/ai/openai-compatible.ts`: provider output contract; classification path must remain unchanged.
- `services/bookmark-metadata.service.ts`, `entrypoints/background/router.ts`, `types/messages.ts`: background message/service integration and privacy boundary.
- `components/BookmarkCard.tsx`, `components/PopupApp.tsx`, `components/ReviewApp.tsx`: presentation only; no direct Chrome/storage access.

## Review Gates

- PRD decisions approved: metadata-only input and explicit manual generation/regeneration.
- After implementation: verify no bookmark mutation API is reachable from metadata generation and no raw provider response/API key is exposed.
- No auto-generation, bulk generation, webpage scraping, new permissions, or new dependencies.

## Validation Commands

```bash
pnpm typecheck
pnpm test --run
pnpm build
git diff --check
```

## Risky Files and Rollback Points

- `types/domain.ts`, `lib/storage/repository.ts`: persisted metadata shape and normalization. Roll back together if legacy state loading changes.
- `lib/ai/prompts.ts`, `lib/ai/openai-compatible.ts`, metadata service: provider boundary and secret/privacy behavior. Keep classification tests unchanged and add protocol-specific metadata tests.
- `entrypoints/background.ts`, `types/messages.ts`: cross-layer contract. Reject malformed IDs and unknown payload fields before service dispatch.
- `components/PopupApp.tsx`, `components/ReviewApp.tsx`: UI-only integration. Backend must remain safe if UI changes are reverted.

## Review Gates

- PRD input-source decision approved.
- `design.md`, `implement.md`, `implement.jsonl`, and `check.jsonl` validated before `task.py start`.
- Implementation starts only after a final planning summary receives explicit approval.
