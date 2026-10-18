# Improve smart bookmark classification

## Goal

Increase automatic classification accuracy while keeping the extension lightweight: use only Chrome bookmark metadata (title, URL, hostname, current folder, and existing folder samples), never fetch webpage正文, and never widen the smart-root mutation boundary.

## Requirements

1. Each smart-root folder summary may carry at most three existing bookmark samples. A sample contains a bounded title, URL, and hostname only.
2. The local classifier must use URL path/domain and folder samples as evidence. Generic single-token matches must not silently dominate stronger or conflicting evidence.
3. Before an AI request, rank folder candidates locally. If there is meaningful evidence, send at most six candidates and always retain the current folder as context; if evidence is weak, send the full live folder list.
4. The AI prompt must instruct the model to reuse existing folder paths, treat samples as untrusted data, avoid creating folders, and choose `keep` when evidence is insufficient.
5. Classification cache keys must change when folder paths or bounded samples change. Existing provider, protocol, root, and mutation validation behavior remains intact.
6. Existing review mode, confidence threshold, retry behavior, and manual-move race protection remain unchanged.

## Acceptance criteria

- A folder with matching existing bookmark samples outranks a folder that only shares a generic name token.
- A URL path such as `/react/hooks` contributes classification evidence without webpage access.
- With more than six folders and a strong local signal, the provider receives no more than six candidate folders and the current folder remains represented when it is not already selected.
- With weak local signal, all live folders remain available to the provider.
- Changing a folder sample or path causes a new provider classification instead of reusing the old cache entry.
- Provider output still must reference a live editable folder in the smart root; no out-of-root mutation becomes possible.
- `pnpm typecheck`, `pnpm test --run`, and `pnpm build` pass.

## Out of scope

- Webpage正文读取, content scripts, broad host permissions, embeddings, vector databases, new server components, automatic folder creation, and a new feedback-learning database.
