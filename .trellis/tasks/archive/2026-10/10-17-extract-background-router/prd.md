# PRD: Batch 3 Extract Background Message Router

## Goal

Move the runtime Zod schema and request switch from entrypoints/background.ts to entrypoints/background/router.ts, leaving the entrypoint responsible for dependency assembly, Chrome listener registration, and the error boundary.

## Requirements

- router.ts exports strict RequestSchema, handleRequest, and required types.
- The router receives service facades and provider URL normalization; it does not access Chrome storage or bookmarks directly.
- Preserve request discriminants, field constraints, response shape, error text, and API-key isolation.
- Register background listeners synchronously during module evaluation.

## Acceptance criteria

- [x] background.ts no longer defines RequestSchema or handleRequest.
- [x] Strict validation continues to reject malformed and unknown runtime messages.
- [x] Every existing message route has equivalent direct router test coverage.
- [x] `pnpm typecheck`, `pnpm test --run`, `pnpm build`, and `git diff --check` pass.

## Out of scope

- UI message renames, runtime contract expansion, permission changes, or classifier behavior changes.
