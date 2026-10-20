# Recent activity tooltip — technical design

## Architecture

Add one shared primitive, `components/ui/truncated-text.tsx`, and use it for both fields in `components/RecentActivity.tsx`.

```
RecentActivity
  └─ TruncatedText (title, message)
       ├─ measure truncation (ResizeObserver + text/class changes)
       ├─ hover / focus / blur / Escape state
       ├─ fixed-position tooltip rendered through createPortal(document.body)
       └─ computeTooltipPosition() pure helper
```

No background, storage, message-contract, or domain-model changes.

## Component contract

```tsx
interface TruncatedTextProps extends HTMLAttributes<HTMLParagraphElement> {
  text: string;
}
```

- Renders a `<p>` containing `text` as a normal React text node.
- Accepts `className` so the title and message keep their existing typography.
- Forwards native paragraph attributes, but owns `tabIndex`, `aria-describedby`, pointer/focus handlers, and the tooltip portal.
- `tabIndex` is `0` only while clipped, otherwise `undefined`.
- Uses `useId()` for the tooltip id and sets `aria-describedby` only while the tooltip is open, so screen readers never describe hidden content.

## Truncation detection

- Measure after layout with `useLayoutEffect`.
- Single-line fields use `element.scrollWidth > element.clientWidth + 1`.
- Re-run on `ResizeObserver` (target size and font-driven resizes), on `text` change, and on window resize.
- If the element is hidden (for example inside a closed `<details>`), the measurement is deferred until ResizeObserver reports a non-zero box.
- The unchanged behavior for non-truncated text: no tooltip, no focus target.

## Tooltip rendering and positioning

- Render through `createPortal` into `document.body` with `position: fixed` to escape card overflow and stacking contexts.
- While closed, keep the tooltip mounted only when truncated and fade it with `opacity` / `translate` transitions. It uses `pointer-events-none` and `aria-hidden` when closed.
- On open, measure the tooltip after render, then position it with the pure helper:

```ts
interface TooltipPositionInput {
  anchor: { top: number; left: number; width: number; height: number };
  tooltip: { width: number; height: number };
  viewport: { width: number; height: number };
  gap: number;    // 8px
  margin: number; // 8px
}
```

Placement rules:

1. Prefer below: `anchor.bottom + gap`.
2. Flip above when the tooltip does not fit below but fits above.
3. If neither side fits, use the side with more space and clamp the final `top` to the viewport.
4. Horizontally center on the anchor, then clamp `left` to `[margin, viewport.width - tooltip.width - margin]`.

CSS caps width at `min(320px, calc(100vw - 16px))` and height at `calc(100vh - 16px)` with `overflow-y: auto` as a last resort. Text uses `whitespace-normal break-words`.

Reposition on `resize` and capture-phase `scroll` while open. Close on `Escape`, pointer leave, and blur.

## Styling

- Dark tooltip surface (`bg-slate-900 text-white`, `dark:bg-slate-800`) with a subtle border/shadow and `rounded-lg`.
- `text-xs leading-5`, `px-2.5 py-1.5`, `z-50`.
- Opacity/transform transition around 120–150 ms.
- The tooltip never participates in layout.

## RecentActivity changes

- Title: replace the plain `<p className="truncate ...">` with `<TruncatedText className="truncate text-sm font-medium ..." />`.
- Message: replace `line-clamp-2` with `truncate` and wrap it in `TruncatedText`, satisfying the single-line requirement.
- Preserve the existing badge, spacing, `min-w-0`, dark-mode colors, and eight-item limit.

## Testing and verification

- Add a pure unit test for `computeTooltipPosition`: below, flipped above, both-sides-insufficient clamping, and left/right horizontal clamping.
- Vitest runs in Node, so the component itself is verified manually in the built extension.
- Manual verification: seed dashboard activities, open the popup, hover/focus long and short values, press `Escape`, resize the window, scroll, and repeat in the settings page and dark mode.

## Trade-offs

- No dependency added; the tooltip is small and purpose-built.
- Custom tooltip instead of native `title`: native tooltips cannot be styled, wrap inconsistently, have a long delay, and do not expose a controlled `role="tooltip"` relationship.
- Fixed portal positioning adds measurement code, but avoids clipping by the card and keeps the popup layout stable.
- The tooltip is scoped to `TruncatedText`; it is not a global tooltip framework.

## Compatibility and rollback

- Chrome 134+ supports `ResizeObserver`, `useId`, and portals.
- Rollback is limited to deleting `truncated-text.tsx` and reverting the two `RecentActivity` paragraphs.
