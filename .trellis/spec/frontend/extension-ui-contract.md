# WXT Extension UI Contract

## Scope

This project has three React extension pages: the action popup (`entrypoints/popup/`), options page (`entrypoints/options/`), and review page (`entrypoints/review/`). Their shared presentation lives in `components/`; the MV3 background remains the single owner of settings, persistence, classification, and bookmark mutations.

## Data flow and state

- Use `sendMessage()` and the `RuntimeRequest` discriminated union in `types/messages.ts` for page-to-background operations. Unwrap errors through `unwrapResponse()` and show user-facing status text in the page.
- Load the dashboard via `state:get` when a page mounts and refresh after a mutation. Keep only transient form state, busy state, selected review ID, and status/error messages in React state.
- Do not access `chrome.storage.local` from UI components or mutate bookmarks directly from a page. Send a typed message and let the background validate current state.
- Never return API key material in the dashboard payload. The UI receives only `hasApiKey`; replacement keys are write-only password inputs.

## Components and styling

- Build reusable controls under `components/ui/` and product views under `components/`. Use typed props and compose the small primitives rather than duplicate card/button/field styling.
- Tailwind CSS v4 is enabled through `@tailwindcss/vite`; shared tokens and global light/dark styles live in `components/styles.css`.
- Follow system color preference. Keep user/model-provided title, URL, reason, and folder labels as React text nodes; do not render them as HTML.
- Use Chinese user-facing labels and `role="status"` / `role="alert"` for asynchronous results and errors.

## Quality checks

- Keep page entrypoints thin: mount the corresponding exported component and shared stylesheet.
- Type-check the full workspace, including WXT-generated `.wxt/types` declarations.
- Review keyboard labels and native form semantics for controls; never rely on color alone to communicate state.
