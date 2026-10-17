# Implementation Plan

1. Add a narrow parser/mapping in `lib/ai/openai-compatible.ts` for `ENDPOINT_MIGRATED` and `model_not_found`; validate migration URLs and retain all existing fallback messages/retryability.
2. Add stub-fetch tests in `tests/openai-compatible.test.ts` for valid migration URL, unsafe/missing migration URL, and model-not-found. Assert provider text and test keys are not exposed.
3. Run focused Provider tests, then `pnpm typecheck`, `pnpm test --run`, and `pnpm build`.
4. Review staged diff for settings changes, real requests, or secret exposure; none belong in scope.

## Risk and rollback

- Risky files: `lib/ai/openai-compatible.ts`, `tests/openai-compatible.test.ts`.
- Keep bookmark mutation and settings persistence untouched.
- If validation fails, revert only the provider error mapping and its tests; preserve all pre-existing user changes.
