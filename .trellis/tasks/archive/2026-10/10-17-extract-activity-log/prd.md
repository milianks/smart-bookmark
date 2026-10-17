# PRD: Batch 2 Complete Activity Log Extraction and Slim Organizer

## Goal

Move remaining pure activity-log and job-pruning transformations out of Organizer, then clarify the private steps in review approval.

## Requirements

- Complete services/activity-log.ts with pruneJobs; appendActivity is moved in Batch 1.
- Organizer continues to apply the helpers through StateRepository updates.
- Review approval, undo, and historical review continue using the same mutationChain and pending-operation recovery.
- Preserve activity fields, retention limits, messages, and dashboard ordering.

## Acceptance criteria

- [x] Organizer no longer defines activity-log state transformations.
- [x] Bookmark mutation and activity-write ordering match existing behavior.
- [x] Move rejection, rejected-after-success, worker recovery, and stale manual-move cases pass.
- [x] All quality checks and `git diff --check` pass.

## Out of scope

- Further scan/settings service changes, runtime router separation, or storage sharding.
