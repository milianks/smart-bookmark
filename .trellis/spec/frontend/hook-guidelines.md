# Hook Guidelines

> How hooks are used in this project.

---

## Overview

The application currently uses React built-in hooks only. There are no custom hooks or shared data-fetching hooks in the repository. Page-specific state and effects live in the page components.

## Custom Hook Patterns

No custom hook pattern, naming example, or hooks directory is established. Existing examples keep `useState`, `useEffect`, `useCallback`, and `useMemo` in `SettingsApp`, `PopupApp`, and `ReviewApp`. Do not assume a project-specific custom-hook location or convention.

## Data Fetching

There is no React Query, SWR, or custom fetch abstraction. Components call `sendMessage()` from `types/messages.ts` to request background state or actions. `useEffect` loads initial state, and pages refresh after successful mutations. Convert rejected or `{ ok: false }` responses to visible status text; do not access the local repository from the UI.

Example from `components/ReviewApp.tsx`:

```tsx
const refresh = useCallback(async () => {
  const response = await sendMessage({ type: 'state:get' });
  setState(unwrapResponse<DashboardState>(response));
}, []);
```

## Naming Conventions

React built-in hooks retain their standard names (`useState`, `useEffect`, etc.). There are no project custom-hook filenames or naming examples beyond this.

## Common Mistakes

- Do not call hooks conditionally or from event handlers; current components call built-in hooks at the top level.
- Do not assume a query cache exists. Refresh the relevant page state after a background mutation as current pages do.
- Do not put bookmark mutation or persistent-state ownership into a hook; those operations belong to the background service worker.
