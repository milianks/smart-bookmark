# GitHub classification patterns

## Repositories reviewed

- `deltartificial/bookmarks-classification-ts`
  - Separates bookmark classification from folder grouping.
  - Allows a maximum number of top-level folders and merges similar groups.
  - Supports custom classification and grouping instructions.
  - Useful lesson: keep candidate taxonomy bounded; not suitable for live Chrome mutation.

- `PanHywel/TidyMark`
  - Uses deterministic keyword and URL rules before optional AI refinement.
  - AI receives the current categories and bookmark rows, then may reassign only to known categories.
  - Low-confidence rows are retained instead of being force-moved.
  - Useful lesson: rules narrow or seed the decision; AI remains a second pass.

- `Lling0000/SiftMarks`
  - Builds reviewable cleanup suggestions and requires user approval before sync-back.
  - Reuses existing folder taxonomy and falls back to title/URL keyword evidence when richer metadata is unavailable.
  - Useful lesson: examples from the existing library and conservative fallback improve trust.

- `filtercodes/Semantic-Bookmarks`, `CesurPolat/VectorMark`, `shaun-mathew/Goodmarks`
  - Use page content or local embeddings for semantic search/classification.
  - These add content fetching, model files, indexes, or a local service.
  - Excluded from this change because the product constraint is lightweight and title/URL/domain only.

## Current-project gap

The classifier currently sends folder names and paths but no examples of what a folder already contains. The local rule classifier can return a high-confidence result from a single generic token, and the cache fingerprint does not change when folder examples change. The provider also receives every folder even when a small lexical signal can identify a smaller candidate set.

## Adopted decisions

1. Add up to three bounded bookmark samples per folder. Samples contain only title, URL, and hostname; no webpage body is fetched.
2. Rank folders locally using title/domain/URL tokens plus sample evidence. If the evidence is weak, keep the complete folder list; otherwise pass only the strongest candidates (plus the current folder) to AI.
3. Make the prompt explicitly prefer existing paths and samples, and choose `keep` when the evidence cannot distinguish folders.
4. Include samples in the cache fingerprint so folder edits and new examples invalidate stale classifications.
5. Preserve root isolation, provider validation, review thresholds, and manual-move protections.
