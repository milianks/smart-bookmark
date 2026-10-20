export interface TooltipPositionInput {
  anchor: { top: number; left: number; width: number; height: number };
  tooltip: { width: number; height: number };
  viewport: { width: number; height: number };
  gap: number;
  margin: number;
}

export interface TooltipPosition {
  top: number;
  left: number;
}

export function computeTooltipPosition({ anchor, tooltip, viewport, gap, margin }: TooltipPositionInput): TooltipPosition {
  const belowTop = anchor.top + anchor.height + gap;
  const aboveTop = anchor.top - tooltip.height - gap;
  const belowSpace = viewport.height - margin - belowTop;
  const aboveSpace = anchor.top - margin - gap;
  const fitsBelow = belowSpace >= tooltip.height;
  const fitsAbove = aboveSpace >= tooltip.height;

  const preferredTop = fitsBelow
    ? belowTop
    : fitsAbove
      ? aboveTop
      : belowSpace >= aboveSpace
        ? belowTop
        : aboveTop;
  const maxTop = Math.max(margin, viewport.height - tooltip.height - margin);
  const top = Math.min(Math.max(preferredTop, margin), maxTop);

  const centeredLeft = anchor.left + (anchor.width - tooltip.width) / 2;
  const maxLeft = Math.max(margin, viewport.width - tooltip.width - margin);
  const left = Math.min(Math.max(centeredLeft, margin), maxLeft);

  return { top, left };
}
