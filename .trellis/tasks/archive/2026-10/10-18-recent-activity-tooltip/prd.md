# Recent activity tooltip

## Goal

Make every long field in the recent activity list readable without widening the layout: keep each field on one line with an ellipsis, and show the full value in a tooltip on hover or keyboard focus.

User value: users can identify an activity entry without opening another page, while the popup and settings card keep their current fixed width.

## Background and confirmed facts

- `components/RecentActivity.tsx:22` already renders the activity title with `truncate` (single line + ellipsis).
- `components/RecentActivity.tsx:23` renders the message with `line-clamp-2`, so long messages occupy two lines and are truncated without a full-text affordance.
- `RecentActivity` is shared by the popup (`components/PopupApp.tsx:111`) and the settings page (`components/SettingsApp.tsx:219`). A fix in the shared component covers both surfaces.
- The component renders only the fixed-width activity-kind badge, title, and message. The badge uses short fixed labels and does not overflow; the title and message are the overflow candidates.
- The repository has no tooltip component, no UI component library, and no tooltip dependency (`package.json`).
- Frontend rules require shared primitives under `components/ui/`, Tailwind utilities, dark-mode support, native semantics, and keyboard focus styles (`.trellis/spec/frontend/component-guidelines.md`; `.trellis/spec/frontend/extension-ui-contract.md`).
- There is no React component test runner or browser automation configured; Vitest runs Node tests only (`.trellis/spec/frontend/quality-guidelines.md`).

## Requirements

- **R1 — Single-line truncation.** In the recent activity list, both title and message must occupy one line, use `text-overflow: ellipsis`, and never widen or overflow their card.
- **R2 — Truncation-aware tooltip.** A tooltip must appear only when the rendered text is actually clipped. Hovering or focusing non-truncated text must not show a tooltip.
- **R3 — Full text.** The tooltip must render the complete, untruncated title or message as plain text (never HTML).
- **R4 — Tooltip layout.** The tooltip must wrap long text, cap its width (target: `min(320px, 100vw - 16px)`), stay inside the viewport, prefer placement below the field, flip above when there is not enough room below, and clamp horizontally.
- **R5 — Interaction.** Hover/focus opens the tooltip; mouse leave/blur closes it; `Escape` closes it. Open/close must be visually smooth and must not shift the surrounding layout. The tooltip must not capture pointer events.
- **R6 — Accessibility.** The truncated field must be keyboard-focusable only when truncated, expose the tooltip association via `aria-describedby`, and use `role="tooltip"`. The tooltip must not be announced while hidden.
- **R7 — Theme and surfaces.** Follow the existing light/dark theme and work in both the popup and the settings page without new dependencies.

## Acceptance Criteria

- [ ] Long activity titles and messages render on one line with an ellipsis; short values remain unchanged and untruncated.
- [ ] Hovering a truncated title/message shows a tooltip containing the exact full text; hovering a non-truncated field shows nothing.
- [ ] Focusing a truncated field with the keyboard shows the same tooltip; `Escape`, blur, and mouse leave hide it.
- [ ] A long tooltip wraps at its maximum width, remains fully inside the popup viewport, and flips above the field when the space below is insufficient.
- [ ] Showing or hiding a tooltip causes no layout shift and no clipping by cards or scrolling containers.
- [ ] Both the popup and settings recent-activity sections behave identically, in light and dark mode.
- [ ] `pnpm typecheck`, `pnpm test --run`, and `pnpm build` pass.
- [ ] Manual browser verification covers a long title, a long message, a short value, hover, keyboard focus, `Escape`, and the settings surface.

## Out of scope

- Tooltips for bookmark cards, review details, badges, or any field outside the recent activity list.
- Adding a component library or tooltip dependency.
- Background, storage, runtime-message, or data-model changes.
- Touch-specific tooltips or a global application-wide tooltip system.
- Changing the activity history length or ordering.

## Open questions

None blocking.
