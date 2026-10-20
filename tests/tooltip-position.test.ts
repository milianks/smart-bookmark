import { describe, expect, it } from 'vitest';
import { computeTooltipPosition } from '../components/ui/tooltip-position';

describe('computeTooltipPosition', () => {
  it('places the tooltip below the anchor when it fits', () => {
    expect(computeTooltipPosition({
      anchor: { top: 100, left: 100, width: 100, height: 20 },
      tooltip: { width: 120, height: 40 },
      viewport: { width: 400, height: 400 },
      gap: 8,
      margin: 8,
    })).toEqual({ top: 128, left: 90 });
  });

  it('flips above when the tooltip does not fit below', () => {
    expect(computeTooltipPosition({
      anchor: { top: 300, left: 100, width: 100, height: 20 },
      tooltip: { width: 120, height: 100 },
      viewport: { width: 400, height: 400 },
      gap: 8,
      margin: 8,
    })).toEqual({ top: 192, left: 90 });
  });

  it('clamps vertically when neither side has enough space', () => {
    expect(computeTooltipPosition({
      anchor: { top: 140, left: 100, width: 100, height: 20 },
      tooltip: { width: 120, height: 180 },
      viewport: { width: 400, height: 200 },
      gap: 8,
      margin: 8,
    })).toEqual({ top: 8, left: 90 });
  });

  it('clamps horizontal placement at both viewport edges', () => {
    const input = {
      tooltip: { width: 100, height: 40 },
      viewport: { width: 200, height: 400 },
      gap: 8,
      margin: 8,
    };

    expect(computeTooltipPosition({
      ...input,
      anchor: { top: 100, left: 0, width: 40, height: 20 },
    }).left).toBe(8);
    expect(computeTooltipPosition({
      ...input,
      anchor: { top: 100, left: 180, width: 40, height: 20 },
    }).left).toBe(92);
  });
});
