# Design: Batch 2 Complete Activity Log Extraction and Slim Organizer

## Boundary

activity-log.ts exports state transformations that accept PersistedState, activity/job data, a timestamp, and an ID factory. It imports no Chrome API, provider, or service class.

Organizer review approval is divided into private typed steps:

1. Load and validate the review and live bookmark.
2. Resolve or create the target folder.
3. Revalidate source and target immediately before mutation.
4. Persist PendingOperation.
5. Call the existing moveWithRecovery path.
6. Record review, job, undo, and activity state.

The mutation lock must cover the same steps as before. Never persist the move after calling the Chrome API.
