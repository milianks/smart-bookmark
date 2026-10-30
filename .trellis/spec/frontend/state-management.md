# State Management

> How state is managed in this project.

---

## Overview

There is no global React store, context-based state layer, router state library, or server-state cache such as React Query. React components keep only transient page state. Durable settings, jobs, review items, cache, and activity history belong to the background and are stored through `chrome.storage.local`.

## State Categories

- **Transient UI state:** local `useState` values for the loaded dashboard snapshot, form values, busy flags, selected review, and status/error text. See `components/SettingsApp.tsx` and `components/ReviewApp.tsx`.
- **Extension application state:** the `PersistedState` model in `types/domain.ts`, loaded and updated by the background through `StateRepository` in `lib/storage/repository.ts`.
- **URL state:** `ReviewApp` reads the optional `item` query parameter once on mount to select a review. There is no general URL-state system.
- **Server state:** none; the extension does not use a project backend server.

## When to Use Global State

No global state mechanism is present. Do not add a global store just to share dashboard data between pages; each extension page requests its dashboard projection from the background with `{ type: 'state:get', view: 'popup' | 'review' | 'settings' }`. Keep ephemeral state in the component that owns the interaction.

## Server State

There is no server-state cache or synchronization library. Treat background-owned extension state as the source of truth: load it with `sendMessage()`, unwrap the typed runtime response, and refresh after a mutation. Do not access `chrome.storage.local` from a component or keep a second, independently mutable copy of persistent settings in the UI.

The dashboard intentionally exposes `PublicSettings` with `hasApiKey`, not the key itself. The options page sends a replacement key through `settings:update`; the field remains a password input and does not receive a saved key back.

## Common Mistakes

- Do not add React Query/SWR terminology or cache invalidation patterns; those libraries are not dependencies.
- Do not treat the component's dashboard snapshot as durable state. A background action can change it, so refresh from `state:get` after a mutation.
- Do not promote transient busy/error/selection state into persistent storage.
- Do not read or write Chrome storage or bookmarks from the page; the background worker owns these operations.
- Do not include API key material in dashboard state, status text, notifications, or activity history.

## Dashboard projections and subscriptions

- `PopupDashboardState` omits `historicalReviews` and `folders`; `SettingsDashboardState` contains only `settings`, `activities`, and `aiStatus`. Review and requests without `view` retain `DashboardState` for compatibility.
- Popup and Review use `subscribeDashboard` to connect the `dashboard` runtime port. The only invalidation payload is `{ type: 'state:changed' }`; no persisted snapshot crosses this notification channel.
- Settings retains mount/action-driven refreshes. Subscribed pages refresh after connection and reconnect after worker disconnect. Coalesce notifications while a refresh runs; cleanup cancels timers and disconnects the port. Keep `createLatestRefresh` protection against stale response application.
- Verify coalescing, disconnect/reconnect, errors, cleanup, and projection consumers in Node tests. Browser service-worker lifecycle and Chrome event-delivery costs require separate real-browser validation.
