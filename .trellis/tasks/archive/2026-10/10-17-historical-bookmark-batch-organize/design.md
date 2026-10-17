# Technical Design

## Architecture

The feature stays inside the existing MV3 boundaries. React pages request scan state and actions through the typed runtime-message union. `OrganizerService` owns scan enumeration, classification, review creation, batch approval, bookmark mutation, recovery, and undo. `ChromeBookmarkService` remains the only adapter around `chrome.bookmarks`; `StateRepository` remains the only persistence boundary.

## State and Contracts

- Add a durable `HistoricalScanState` to `PersistedState` with scan ID, status, timestamps, eligible total, processed counts, pending-review count, failure/skipped counts, and the IDs covered by the run. New fields remain backward-compatible with existing version-1 state normalization.
- Add optional `scanId` metadata to historical `BookmarkJob` and `ReviewItem` records. Existing realtime jobs and reviews remain valid without this field.
- Add the latest historical batch undo record containing the scan ID and successful move records. Keep existing `lastUndo` behavior for automatic new-bookmark moves.
- Extend `DashboardState` with a public scan summary and historical undo availability. Never include the API key.
- Add validated runtime requests for starting a scan, approving all currently valid proposals for a scan, and undoing the latest historical batch. Existing per-item review messages continue to work.

## Scan Flow

1. `scan:start` acquires a scan lock and rejects a second active scan.
2. The background reads the current tree, walks it once, and selects HTTP(S) bookmark nodes whose parent satisfies the existing protection rule: direct children of editable built-in roots by default; descendants only when `forceOrganize` is enabled; managed folders excluded.
3. Existing jobs/reviews and IDs already covered by the active or completed scan are deduplicated. New historical jobs persist before classification and carry the scan ID.
4. Historical jobs reuse the classifier and folder validation but always route `move` and `suggest_folder` results to durable pending reviews. A `keep` result completes without a move. Missing configuration or provider permission keeps the job in the existing waiting state and allows `resume()` to continue later.
5. Progress is derived from persisted scan-tagged jobs/reviews after every item, so a service-worker restart can resume queued historical jobs without duplicating classification or review creation.

## Approval and Undo

- Existing per-item approval revalidates the live bookmark source and destination before every mutation.
- `scan:approve-all` snapshots pending reviews for the scan and processes them sequentially through the same internal approval path. Each item can become approved, rejected/stale, or failed independently; one failure does not abort the remainder.
- Before each move, persist the existing pending mutation intent. Tag it with the scan/batch context. On restart or rejected Chrome calls, reconcile against the live parent before updating review, job, scan, and undo state.
- Successful historical moves append to a durable latest-batch undo record. `undo:historical-last` revalidates every recorded bookmark and moves only bookmarks still in the recorded target folder; manually moved or deleted items are skipped with an activity record. Empty folders are not deleted.

## UI

- Popup gains a scan action, current scan counts/status, and a link to the review page. It shows configuration/permission errors using existing dashboard state.
- Review page groups or labels historical proposals, shows source and destination paths, confidence, reason, stale/error status, per-item controls, and a guarded “approve all current valid proposals” action. It exposes latest historical-batch undo status.
- Components keep transient busy, selection, and error state locally. All durable reads and writes use `state:get` and typed runtime messages.

## Compatibility and Recovery

- Existing P0 new-bookmark automatic mode, import suppression, provider permission flow, review approval, and automatic undo remain unchanged.
- Repository normalization treats missing historical fields as idle/empty. No API key or provider payload enters scan records, dashboard state, activity messages, or diagnostics.
- A stale scan is resumed on worker startup when queued historical jobs remain; completed scans are not silently re-run. A second scan requires the previous run to reach a terminal state.

## Risks and Trade-offs

- Large libraries can produce many provider calls. Reuse rule/cache classification, cap active classifications at the existing limit, persist bounded progress, and expose waiting/failure counts.
- Batch approval increases mutation volume. Forced preview, per-item live checks, durable intents, sequential execution, and batch undo limit accidental or unrecoverable moves.
- Existing single-record job retention can prune historical terminal jobs. The scan's covered ID list and scan summary preserve deduplication for the active/completed run without making the global job log unbounded.
