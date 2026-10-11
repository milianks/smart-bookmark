# Component Guidelines

> How components are built in this project.

---

## Overview

Pages are function components written in TypeScript and use React's built-in hooks for local interactions. Page components live in `components/`; small shared presentation primitives live in `components/ui/`. The current UI uses Tailwind CSS v4 utilities, not CSS modules or a component framework.

## Component Structure

- Export named function components, as in `export function BookmarkCard({ job }: { job: BookmarkJob })` and `export function ReviewApp()`.
- Keep page entrypoints thin and keep page workflows in their corresponding `*App.tsx` component.
- Compose shared primitives (`Card`, `CardHeader`, `CardContent`, `Button`, `Field`) instead of copying their base styles. Use `cn()` from `lib/utils/cn.ts` when conditional Tailwind classes need merging.
- Keep user- or model-provided text in normal React text nodes. The UI contract explicitly forbids rendering bookmark titles, URLs, reasons, or folder labels as HTML.

## Props Conventions

Type component props at the component boundary. Small components use an inline object type; reusable primitives define an interface and extend native element attributes when forwarding them:

```tsx
export function BookmarkCard({ job }: { job: BookmarkJob }) {
  // Render the job as text and typed status labels.
}
```

`components/BookmarkCard.tsx` follows the inline-props pattern. `components/ui/field.tsx` defines `FieldProps` with `ReactNode` label content and children; `components/ui/button.tsx` extends `ButtonHTMLAttributes<HTMLButtonElement>`.

## Styling Patterns

Use Tailwind utility classes in JSX. Global font, color scheme, dark-mode media rules, and shared base styles live in `components/styles.css`. Shared class merging is provided by `cn()` (`clsx` plus `tailwind-merge`). Keep the current responsive and light/dark variants consistent with the surrounding components.

## Accessibility

- Prefer native `button`, `input`, `select`, `label`, headings, and links. `Field` wraps its input in a label; follow that pattern or provide an explicit accessible label.
- Give asynchronous success and error messages `role="status"` and `role="alert"`, as used in `SettingsApp` and `ReviewApp`.
- Preserve visible keyboard focus styles in shared controls (`components/ui/button.tsx` uses `focus-visible` utilities); do not communicate state by color alone.
- User-facing UI copy is Chinese in the existing pages. Keep status text actionable and avoid exposing internal stack traces.

## Common Mistakes

- Do not call `chrome.storage.local` or mutate Chrome bookmarks from a React component. Use `sendMessage()` and let the background validate and perform the operation.
- Do not add `dangerouslySetInnerHTML` for bookmark or model data; render it as text.
- Do not duplicate button, card, or field styling when a shared primitive already covers the use case.
- Do not return API key material to a component. Dashboard state contains `hasApiKey`; the options page uses a blank password input for a replacement key.
