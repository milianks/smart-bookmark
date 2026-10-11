# Type Safety

> Type safety patterns in this project.

---

## Overview

The project uses TypeScript with `strict: true` and `noUncheckedIndexedAccess: true` in `tsconfig.json`. Shared domain shapes and runtime message contracts live in `types/`; Zod validates data at the message, settings, and AI-response boundaries.

## Type Organization

- `types/domain.ts` owns persisted/domain shapes (`BookmarkJob`, `ReviewItem`, `DashboardState`, and related types) and schemas such as `SettingsSchema` and `ClassificationResultSchema`.
- Types derived from schemas use `z.infer`, e.g. `ClassificationResult` and `Settings`.
- `types/messages.ts` owns the `RuntimeRequest` discriminated union, `RuntimeResponse`, `RuntimeData`, and page/background helpers.
- Keep component-only prop types near the component. `components/ui/field.tsx` and `button.tsx` define local prop interfaces that extend React's native element attributes where appropriate.

## Validation

TypeScript types do not validate runtime messages or model output. `entrypoints/background.ts` uses a strict Zod discriminated union for incoming runtime requests and a strict schema for settings patches. `lib/ai/openai-compatible.ts` parses provider output as `unknown` and validates it with `ClassificationResultSchema`; `services/classifier.service.ts` then verifies referenced folder IDs against the current folder summaries.

```ts
const result = ClassificationResultSchema.safeParse(parsed);
```

In `lib/ai/openai-compatible.ts`, the implementation throws a user-facing `ProviderError` when parsing fails and returns `result.data` only after successful validation. Keep invalid provider data out of decision and mutation code.

## Common Patterns

- Use discriminated unions for action/request variants (`ClassificationResultSchema` and `RuntimeRequest`) and `Record<Union, Value>` for exhaustive labels, as in `BookmarkCard`'s job status map.
- Use `unknown` for caught errors and untrusted JSON, then narrow with `instanceof Error`, structural checks, or Zod parsing.
- Reuse `PublicSettings` in UI-facing state; it omits the API key and adds `hasApiKey`.
- Use optional properties for genuinely absent values, as the persisted domain model does for `lastUndo`, `parentId`, and retry metadata.

## Forbidden Patterns

- Do not widen runtime data to `any` or treat a TypeScript annotation as runtime validation.
- Do not cast provider output directly to `ClassificationResult`; parse unknown data through the Zod schema first.
- Do not return internal `Settings` to the UI because it includes `apiKey`; use `PublicSettings`/`DashboardState`.
- Keep type assertions confined to existing interoperability boundaries. `types/messages.ts` currently asserts Chrome's `sendMessage()` result and unwraps its response; do not copy that assertion to unvalidated external data.
