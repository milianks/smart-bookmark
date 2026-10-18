# Technical design

## Boundaries

- `services/bookmark.service.ts` remains the owner of reading Chrome's tree and building root-scoped folder summaries.
- `types/domain.ts` owns the shared `BookmarkSample` and `FolderSummary` contract.
- `lib/ai/rule-classifier.ts` owns local evidence scoring and candidate ranking.
- `services/classifier.service.ts` owns candidate selection, cache identity, provider dispatch, and full-tree target validation.
- `lib/ai/prompts.ts` owns the AI instruction and bounded serialization.

## Data flow

`Chrome bookmark tree -> root-scoped FolderSummary.samples -> local ranking -> bounded provider folder list -> strict ClassificationResult -> full live-folder target validation -> existing OrganizerService mutation/review flow`.

Samples are direct children of each folder, capped at three, and truncated before serialization. The root folder can be represented but is not a writable target outside existing validation rules.

## Candidate selection

The ranker combines normalized title/domain/URL-path tokens with folder name/path tokens and sample title/URL-path tokens. Shared domain is a ranking hint but cannot alone trigger a local automatic move. A strong, unambiguous signal is required before truncating the list; otherwise the complete folder list is retained to avoid false negatives. The current folder is appended to the candidate list when truncation would remove it.

## Compatibility and safety

`FolderSummary.samples` is optional, so existing fake ports, stored state, and test fixtures remain compatible. Provider target validation continues to use the complete live folder set rather than the candidate subset. Cache identity includes serialized bounded samples and folder metadata. No new permission, storage schema, Chrome mutation, or external dependency is introduced.

## Rollback

The change is isolated to classifier inputs and scoring. Reverting the changed files restores the prior prompt and local rule behavior; Chrome bookmark state is unaffected by classification failures.
