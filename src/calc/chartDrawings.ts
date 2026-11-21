export function projectTimeSecFromLogical(
  logical: number,
  barTimesSec: number[],
  stepSec: number
): number | null {
  if (barTimesSec.length === 0 || !Number.isFinite(logical)) return null;
  const safeStep = Math.max(60, Math.round(stepSec));
  const lastIdx = barTimesSec.length - 1;
  if (logical <= 0) {
    return Math.round(barTimesSec[0] + logical * safeStep);
  }
  if (logical >= lastIdx) {
    return Math.round(barTimesSec[lastIdx] + (logical - lastIdx) * safeStep);
  }
  const lowIdx = Math.floor(logical);
  const highIdx = Math.min(lastIdx, lowIdx + 1);
  const frac = logical - lowIdx;
  return Math.round(barTimesSec[lowIdx] + frac * (barTimesSec[highIdx] - barTimesSec[lowIdx]));
}

export function resolveLogicalFromTimeSec(
  timeSec: number,
  barTimesSec: number[],
  stepSec: number
): number | null {
  if (barTimesSec.length === 0 || !Number.isFinite(timeSec)) return null;
  const safeStep = Math.max(60, Math.round(stepSec));
  const firstSec = barTimesSec[0];
  const lastIdx = barTimesSec.length - 1;
  const lastSec = barTimesSec[lastIdx];

  if (timeSec <= firstSec) {
    return (timeSec - firstSec) / safeStep;
  }
  if (timeSec >= lastSec) {
    return lastIdx + (timeSec - lastSec) / safeStep;
  }

  // Binary search bracketing index [lo, lo + 1]
  let lo = 0;
  let hi = lastIdx;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (barTimesSec[mid] <= timeSec) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const t0 = barTimesSec[lo];
  const t1 = barTimesSec[hi];
  const span = Math.max(1, t1 - t0);
  return lo + (timeSec - t0) / span;
}

export function distanceToSegmentPx(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-6) {
    return Math.hypot(px - x1, py - y1);
  }
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  const projX = x1 + t * dx;
  const projY = y1 + t * dy;
  return Math.hypot(px - projX, py - projY);
}

/**
 * Extends a ray starting at (x1, y1) and passing through (x2, y2)
 * out to the viewport boundary [0, width] x [0, height].
 */
export function computeRayEndpointPx(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  height: number
): { x2: number; y2: number } | null {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.hypot(dx, dy) < 0.5) return null;

  const candidates: number[] = [];

  if (Math.abs(dx) > 1e-6) {
    const tx0 = (0 - x1) / dx;
    const txW = (width - x1) / dx;
    if (tx0 > 0) candidates.push(tx0);
    if (txW > 0) candidates.push(txW);
  }
  if (Math.abs(dy) > 1e-6) {
    const ty0 = (0 - y1) / dy;
    const tyH = (height - y1) / dy;
    if (ty0 > 0) candidates.push(ty0);
    if (tyH > 0) candidates.push(tyH);
  }

  // Pick the largest positive t that keeps the point within padded bounds or simply farthest edge t
  const valid = candidates.filter((t) => {
    const rx = x1 + t * dx;
    const ry = y1 + t * dy;
    return rx >= -2 && rx <= width + 2 && ry >= -2 && ry <= height + 2;
  });

  if (valid.length === 0) {
    // Origin is outside viewport or pointing away from viewport: fall back to a large extension
    const scale = (Math.max(width, height) * 2) / Math.hypot(dx, dy);
    return { x2: x1 + dx * Math.max(1, scale), y2: y1 + dy * Math.max(1, scale) };
  }

  const maxT = Math.max(...valid);
  const clampedT = Math.max(1, maxT);
  return {
    x2: x1 + clampedT * dx,
    y2: y1 + clampedT * dy,
  };
}

export function distanceToRayPx(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  height: number
): number {
  const end = computeRayEndpointPx(x1, y1, x2, y2, width, height);
  if (!end) return Math.hypot(px - x1, py - y1);
  return distanceToSegmentPx(px, py, x1, y1, end.x2, end.y2);
}
