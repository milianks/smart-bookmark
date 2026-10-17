# Implementation Plan: Batch 3

1. Move the runtime schema and handleRequest into entrypoints/background/router.ts.
2. Import the router from background.ts and keep listener registration and dependency assembly there.
3. Add runtime malformed-payload and route contract tests.
4. Remove the duplicate classifier import only if this stays within the planned diff.
5. Run pnpm typecheck, pnpm test --run, pnpm build, and git diff --check.
6. Commit Batch 3 independently; revert only this commit on regression.
