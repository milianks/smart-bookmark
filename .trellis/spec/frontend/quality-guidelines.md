# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

The frontend runs in local Chrome extension pages and relies on the background for persistence and bookmark operations. Keep message data typed, loading and errors visible, and API key material out of returned dashboard data. No ESLint script, component test suite, or automated accessibility test tool is configured today.

## Forbidden Patterns

- Do not access `chrome.storage.local` or call bookmark mutation APIs from components. Use `sendMessage()` and let the background validate and perform the action.
- Do not invent a global store, React Query cache, or custom hook framework; none exists in the current frontend.
- Do not display API key material, provider request details, or stack traces. Dashboard state exposes `hasApiKey`; a replacement key is entered into a password field.
- Do not render bookmark/model-provided strings as HTML or communicate state through color alone.
- Do not claim `pnpm lint` is an available check; `package.json` has no lint script.

## Required Patterns

- Use `RuntimeRequest`, `sendMessage()`, and `unwrapResponse()` from `types/messages.ts` for page/background operations.
- Show asynchronous results and errors in the page; existing pages use `role="status"` for success/status messages and `role="alert"` for errors.
- Use native form controls and labels, typed component props, and shared primitives from `components/ui/`.
- Keep the page bootstrap files thin and import the shared stylesheet.

## Testing Requirements

Run the checks available in the repository after frontend changes:

```bash
pnpm typecheck
pnpm test --run
pnpm build
```

`pnpm typecheck` checks TypeScript with strict options. Vitest is configured for `tests/**/*.test.ts` in Node; current automated tests exercise service/provider behavior rather than React components. `pnpm build` validates the WXT Chrome extension build. There is no configured browser automation, UI component test runner, lint script, or accessibility scanner, so do not claim those checks ran.

## Code Review Checklist

- Does the UI use the typed runtime message boundary for background-owned data and actions?
- Are pending, success, and error states understandable to the user, with status/alert semantics?
- Is the saved API key kept out of dashboard data and rendered output?
- Are user/model strings rendered as text and controls labeled with native semantics?
- Did the page entrypoint remain a thin mount, with shared controls reused where applicable?
