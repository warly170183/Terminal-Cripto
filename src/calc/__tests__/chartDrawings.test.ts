import { describe, expect, it } from 'vitest';
import {
  computeRayEndpointPx,
  distanceToRayPx,
  distanceToSegmentPx,
  projectTimeSecFromLogical,
  resolveLogicalFromTimeSec,
} from '../chartDrawings';

describe('chartDrawings geometry & future cone coordinate projection', () => {
  const barTimesSec = [1000, 1900, 2800, 3700]; // 15m (900s) spacing
  const stepSec = 900;

  it('projects timestamps into future Prediction Cone space beyond last bar', () => {
    const projected = projectTimeSecFromLogical(13, barTimesSec, stepSec);
    // lastIdx = 3 (time 3700), +10 bars * 900s = 12700
    expect(projected).toBe(12700);
  });

  it('round-trips future Prediction Cone timestamps back to logical index', () => {
    const futureSec = projectTimeSecFromLogical(15.5, barTimesSec, stepSec)!;
    const logical = resolveLogicalFromTimeSec(futureSec, barTimesSec, stepSec);
    expect(logical).toBeCloseTo(15.5, 2);
  });

  it('interpolates timestamps between bars across timeframe changes', () => {
    const logical = resolveLogicalFromTimeSec(2350, barTimesSec, stepSec);
    expect(logical).toBeCloseTo(1.5, 4);
  });

  it('computes segment distance accurately for trendline hit-testing', () => {
    expect(distanceToSegmentPx(50, 10, 0, 0, 100, 0)).toBe(10);
    expect(distanceToSegmentPx(120, 0, 0, 0, 100, 0)).toBe(20);
  });

  it('extends rays cleanly to the chart right boundary into the cone', () => {
    const end = computeRayEndpointPx(100, 200, 200, 150, 1000, 500);
    expect(end).not.toBeNull();
    expect(end!.x2).toBeCloseTo(500, 1);
    expect(end!.y2).toBeCloseTo(0, 1);

    const distOnExtendedRay = distanceToRayPx(400, 50, 100, 200, 200, 150, 1000, 500);
    // Point (400, 50) lies at slope -0.5: 200 - 0.5*(400-100) = 50 -> distance 0
    expect(distOnExtendedRay).toBeCloseTo(0, 4);
  });
});
