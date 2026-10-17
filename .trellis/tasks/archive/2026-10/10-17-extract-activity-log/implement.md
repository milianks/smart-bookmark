# Implementation Plan: Batch 2

1. Move pruneJobs to activity-log.ts and update Organizer imports.
2. Split approveReview into private typed steps while preserving errors and stale paths.
3. Reconcile duplicate test cases before any consolidation; do not reduce assertions.
4. Run pnpm typecheck, pnpm test --run, pnpm build, and git diff --check.
5. Verify all bookmark mutation remains in Organizer/BookmarkService paths.
6. Commit Batch 2 independently; revert only this commit on regression.
