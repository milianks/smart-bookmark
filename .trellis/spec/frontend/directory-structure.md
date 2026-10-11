# Directory Structure

> How frontend code is organized in this project.

---

## Overview

The frontend consists of three local React pages built by WXT: the action popup, options page, and review page. Page entrypoints live under `entrypoints/`; product components and shared UI primitives live under `components/`. Pages communicate with the background through the typed runtime contract rather than owning storage or bookmark mutations.

## Directory Layout

```text
entrypoints/
├── popup/      # popup HTML and main.tsx
├── options/    # settings page HTML and main.tsx
└── review/     # review page HTML and main.tsx
components/
├── PopupApp.tsx / SettingsApp.tsx / ReviewApp.tsx
├── BookmarkCard.tsx / RecentActivity.tsx
├── styles.css
└── ui/         # reusable badge, button, card, and field primitives
lib/utils/cn.ts # Tailwind class composition helper
types/          # shared domain and message types
```

## Module Organization

- Keep `entrypoints/{popup,options,review}/main.tsx` thin: import the page component and shared stylesheet, then mount it with `createRoot`.
- Put page-level composition and page-local interactions in `components/PopupApp.tsx`, `SettingsApp.tsx`, and `ReviewApp.tsx`.
- Put repeated visual primitives in `components/ui/`; current examples are `button.tsx`, `card.tsx`, `field.tsx`, and `badge.tsx`.
- Keep cross-page runtime/domain contracts in `types/`; the frontend does not have a separate hooks, features, or assets directory today.

## Naming Conventions

React component files and exported components use PascalCase (`ReviewApp.tsx`, `ReviewApp`). UI primitive filenames are lower-case (`components/ui/button.tsx`). Page bootstrap files are consistently named `main.tsx`; other library and type module filenames use lower-case names.

## Examples

- `entrypoints/popup/main.tsx` mounts `PopupApp` and imports `components/styles.css`.
- `components/SettingsApp.tsx` composes page sections from the shared `Card`, `Field`, `Input`, and `Button` primitives.
- `components/BookmarkCard.tsx` renders one typed job; shared persisted/domain shapes come from `types/domain.ts`.
