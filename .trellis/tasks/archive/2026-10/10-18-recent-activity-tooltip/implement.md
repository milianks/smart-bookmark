# Recent activity tooltip — implementation plan

## Ordered checklist

1. Add `components/ui/tooltip-position.ts` with the pure `computeTooltipPosition` helper and typed input/output.
2. Add `tests/tooltip-position.test.ts` covering:
   - below placement when it fits;
   - flip above when below is insufficient;
   - vertical clamping when neither side fits;
   - horizontal clamping at the left and right viewport edges.
3. Add `components/ui/truncated-text.tsx`:
   - `ResizeObserver` truncation measurement;
   - hover/focus/Escape state;
   - portal tooltip with measured fixed positioning;
   - `role="tooltip"`, `aria-describedby`, conditional `tabIndex`;
   - opacity/transform transition and `pointer-events-none`.
4. Update `components/RecentActivity.tsx`:
   - title uses `TruncatedText` with `truncate`;
   - message changes from `line-clamp-2` to `truncate` and uses `TruncatedText`;
   - keep the badge, row spacing, colors, and eight-item cap unchanged.
5. Run the quality gates.
6. Smoke-test the built extension with seeded activities in the popup and settings page, in light and dark mode.

## Validation commands

```bash
pnpm typecheck
pnpm test --run
pnpm build
```

## Manual verification

- Seed at least one activity with a title and message longer than the popup width and one short activity.
- Popup → 最近操作: long fields show one line with `…`; short fields do not.
- Hover a truncated field: full text appears, wraps at the maximum width, and stays inside the viewport.
- Focus the field with the keyboard: tooltip appears; `Escape` and blur hide it.
- Resize narrower, scroll, and verify the tooltip repositions or closes without layout shift.
- Settings → 最近操作: same behavior.
- Toggle dark mode and confirm contrast.

## Risky files / rollback points

- `components/ui/truncated-text.tsx` — new file; main risk is stale positioning after scroll/resize or measurement inside a closed `<details>`.
- `components/RecentActivity.tsx` — two-line message becomes one line; verify the row still reads well and no `min-w-0` regression appears.
- `components/ui/tooltip-position.ts` — keep it pure so Node tests can cover edge cases.

## Follow-up checks before `task.py start`

- Confirm the final summary is approved by the user.
- Confirm no new dependency is required.
- Confirm `implement.jsonl` and `check.jsonl` reference the relevant frontend specs.
