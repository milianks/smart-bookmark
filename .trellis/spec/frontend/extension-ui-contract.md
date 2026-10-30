# WXT Extension UI Contract

## Scope

This project has three React extension pages: the action popup (`entrypoints/popup/`), options page (`entrypoints/options/`), and review page (`entrypoints/review/`). Their shared presentation lives in `components/`; the MV3 background remains the single owner of settings, persistence, classification, and bookmark mutations.

## Data flow and state

- Use `sendMessage()` and the `RuntimeRequest` discriminated union in `types/messages.ts` for page-to-background operations. Unwrap errors through `unwrapResponse()` and show user-facing status text in the page.
- Load the dashboard via `state:get` when a page mounts and refresh after a mutation. Pages select their `state:get` view. Popup and Review subscribe through the `dashboard` runtime port to `{ type: 'state:changed' }`; coalesce notifications, reconnect after disconnect, remove listeners on cleanup, and ignore out-of-order responses. Settings retains mount/action-driven refreshes. Pages must not subscribe to storage change payloads. Keep only transient form state, busy state, selected review ID, and status/error messages in React state.
- Do not access `chrome.storage.local` from UI components or mutate bookmarks directly from a page. Send a typed message and let the background validate current state.
- Never return API key material in the dashboard payload. The UI receives only `hasApiKey`; replacement keys are write-only password inputs.

## Components and styling

- Build reusable controls under `components/ui/` and product views under `components/`. Use typed props and compose the small primitives rather than duplicate card/button/field styling.
- Tailwind CSS v4 is enabled through `@tailwindcss/vite`; shared tokens and global light/dark styles live in `components/styles.css`.
- Follow system color preference. Keep user/model-provided title, URL, reason, and folder labels as React text nodes; do not render them as HTML.
- Use Chinese user-facing labels and `role="status"` / `role="alert"` for asynchronous results and errors.

## Navigation between extension pages

- Settings are the second view inside the action popup. Switch views in React without opening a tab or Chrome window.
- Chrome MV3 derives popup width from its rendered content: keep the popup main view and embedded settings view at the same fixed `390px` width in both loading and loaded states. Keep the options page's responsive `max-w-5xl` layout separate; do not set a global `html` or `body` width to size one popup view.
- Debounce editable settings drafts for 300 ms, serialize writes, and flush before saving, pagehide and component cleanup; use typed background runtime messages; never read or write extension storage from UI components. Clear the draft after formal settings save succeeds.

## Quality checks

- Keep page entrypoints thin: mount the corresponding exported component and shared stylesheet.
- Type-check the full workspace, including WXT-generated `.wxt/types` declarations.
- Review keyboard labels and native form semantics for controls; never rely on color alone to communicate state.

## Historical scan UI contract

- Start historical scans, batch approval, and historical undo only through `RuntimeRequest` messages. The popup renders scan status/counts from `DashboardState`; it does not enumerate bookmarks or inspect storage.
- Historical scan status `scanning` and `awaiting_review` disable the start control. Review pages may show per-item status and a guarded approve-all action; refresh dashboard state after every mutation.
- The background may return `historicalReviews` for status display, but must omit scan internals (`coveredIds`, force flags), API keys, provider payloads, and raw errors.
- Batch approval returns a queued count; show background progress via dashboard refresh. Disable duplicate batch approval and historical undo while `historicalApprovalPending` is true.
- Batch actions must expose `role="status"` success text and `role="alert"` errors. Stale/manual-move outcomes remain visible as item status rather than disappearing silently.

## Manual bookmark metadata UI

- Popup recent bookmark cards and Review detail may render optional persisted summary/tag metadata projected onto matching `recentJobs`, `pendingReviews`, and `historicalReviews` items by bookmark ID.
- Generate and regenerate actions use `bookmark:metadata:generate`; pages keep only per-bookmark busy state and transient success/error text, then refresh `state:get` after success.
- Show asynchronous errors with `role="alert"` and success with `role="status"`. UI must not read extension storage or call bookmark mutation APIs.
