import type { OptionRow } from '../types/market';
import { normCDF } from './blackScholes';

export const CONE_Z = {
  p50: 0.674,
  p80: 1.282,
  p95: 1.96,
} as const;

export type ConeBandPoint = {
  stepFraction: number; // 0 to 1
  ts: number; // ms
  upper50: number;
  lower50: number;
  upper80: number;
  lower80: number;
  upper95: number;
  lower95: number;
};

export type ConeProjection = {
  expiry: string;
  expTs: number;
  atmIV: number;
  upsideIV: number;
  downsideIV: number;
  spot: number;
  maxPain: number;
  points: ConeBandPoint[];
  endpoints: {
    upper50: number;
    lower50: number;
    upper80: number;
    lower80: number;
    upper95: number;
    lower95: number;
    touchProbUpper50: number;
    touchProbLower50: number;
    touchProbUpper80: number;
    touchProbLower80: number;
    touchProbUpper95: number;
    touchProbLower95: number;
    touchProbMaxPain: number;
  };
};

/**
 * Finds the At-The-Money implied volatility for a given expiry.
 */
export function getAtTheMoneyIV(options: OptionRow[], spot: number, expiry: string): number {
  const filtered = options.filter((o) => o.expiry === expiry && o.iv > 0 && o.iv < 5);
  if (filtered.length === 0 || spot <= 0) {
    return 0.5;
  }

  let minDist = Infinity;
  for (const opt of filtered) {
    const d = Math.abs(opt.strike - spot);
    if (d < minDist) minDist = d;
  }

  const atmOptions = filtered.filter((o) => Math.abs(Math.abs(o.strike - spot) - minDist) < 1e-6);
  const sumIv = atmOptions.reduce((acc, o) => acc + o.iv, 0);
  return sumIv / atmOptions.length;
}

/**
 * Linearly interpolates implied volatility across the strike smile for a given expiry.
 * Prefers OTM calls above spot and OTM puts below spot for cleaner market quotes.
 */
export function getStrikeIV(
  options: OptionRow[],
  spot: number,
  expiry: string,
  targetStrike: number
): number {
  const filtered = options.filter((o) => o.expiry === expiry && o.iv > 0 && o.iv < 5);
  if (filtered.length === 0) return 0.5;

  const byStrike = new Map<number, number[]>();
  for (const opt of filtered) {
    // Prefer OTM option quote at each strike when spot is known
    const isPreferredOtm =
      spot <= 0 ||
      (opt.strike >= spot && opt.type === 'C') ||
      (opt.strike <= spot && opt.type === 'P');
    const arr = byStrike.get(opt.strike) ?? [];
    if (isPreferredOtm) {
      arr.push(opt.iv);
    }
    byStrike.set(opt.strike, arr);
  }

  // Fallback if a strike only had ITM quote
  for (const opt of filtered) {
    const arr = byStrike.get(opt.strike)!;
    if (arr.length === 0) arr.push(opt.iv);
  }

  const curve = Array.from(byStrike.entries())
    .map(([strike, ivs]) => ({
      strike,
      iv: ivs.reduce((a, b) => a + b, 0) / ivs.length,
    }))
    .sort((a, b) => a.strike - b.strike);

  if (curve.length === 0) return 0.5;
  if (targetStrike <= curve[0].strike) return curve[0].iv;
  if (targetStrike >= curve[curve.length - 1].strike) return curve[curve.length - 1].iv;

  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1];
    const curr = curve[i];
    if (targetStrike <= curr.strike) {
      const span = curr.strike - prev.strike;
      const t = span > 0 ? (targetStrike - prev.strike) / span : 0;
      return prev.iv + t * (curr.iv - prev.iv);
    }
  }
  return curve[curve.length - 1].iv;
}

/**
 * Touch probability before expiry using the reflection principle:
 * P_touch(K) ≈ 2 * (1 - N(|ln(K / S_0)| / (sigma * sqrt(T))))
 */
export function calculateTouchProbability(
  spot: number,
  levelPrice: number,
  iv: number,
  yearsToExpiry: number
): number {
  if (spot <= 0 || levelPrice <= 0 || iv <= 0 || yearsToExpiry <= 0) {
    return levelPrice === spot ? 1 : 0;
  }
  if (Math.abs(levelPrice - spot) < 1e-9) {
    return 1;
  }
  const sigmaSqrtT = iv * Math.sqrt(yearsToExpiry);
  if (sigmaSqrtT <= 0) return 0;
  const z = Math.abs(Math.log(levelPrice / spot)) / sigmaSqrtT;
  const prob = 2 * (1 - normCDF(z));
  return Math.max(0, Math.min(1, prob));
}

/**
 * Computes lognormal expected range bands (50%, 80%, 95%) from `nowMs` to `expTs`.
 * If `optionsForExpiry` is supplied, uses smile-interpolated upside and downside IVs
 * to capture market volatility skew.
 */
export function calculateExpectedRangeCone(
  spot: number,
  atmIV: number,
  nowMs: number,
  expTs: number,
  expiry: string,
  maxPain: number,
  steps = 24,
  optionsForExpiry?: OptionRow[]
): ConeProjection {
  const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
  const totalMs = Math.max(60_000, expTs - nowMs);
  const totalT = totalMs / MS_PER_YEAR;

  let upsideIV = atmIV;
  let downsideIV = atmIV;
  if (optionsForExpiry && optionsForExpiry.length > 0 && spot > 0) {
    const oneSigmaUp = spot * Math.exp(atmIV * Math.sqrt(totalT));
    const oneSigmaDown = spot * Math.exp(-atmIV * Math.sqrt(totalT));
    upsideIV = getStrikeIV(optionsForExpiry, spot, expiry, oneSigmaUp);
    downsideIV = getStrikeIV(optionsForExpiry, spot, expiry, oneSigmaDown);
  }

  const points: ConeBandPoint[] = [];

  for (let i = 0; i <= steps; i++) {
    const frac = i / steps;
    const t = totalT * frac;
    const sqrtT = Math.sqrt(t);
    const upVolSqrtT = upsideIV * sqrtT;
    const dnVolSqrtT = downsideIV * sqrtT;

    points.push({
      stepFraction: frac,
      ts: nowMs + totalMs * frac,
      upper50: spot * Math.exp(CONE_Z.p50 * upVolSqrtT),
      lower50: spot * Math.exp(-CONE_Z.p50 * dnVolSqrtT),
      upper80: spot * Math.exp(CONE_Z.p80 * upVolSqrtT),
      lower80: spot * Math.exp(-CONE_Z.p80 * dnVolSqrtT),
      upper95: spot * Math.exp(CONE_Z.p95 * upVolSqrtT),
      lower95: spot * Math.exp(-CONE_Z.p95 * dnVolSqrtT),
    });
  }

  const last = points[points.length - 1];
  const mpIV =
    optionsForExpiry && optionsForExpiry.length > 0
      ? getStrikeIV(optionsForExpiry, spot, expiry, maxPain)
      : atmIV;

  return {
    expiry,
    expTs,
    atmIV,
    upsideIV,
    downsideIV,
    spot,
    maxPain,
    points,
    endpoints: {
      upper50: last.upper50,
      lower50: last.lower50,
      upper80: last.upper80,
      lower80: last.lower80,
      upper95: last.upper95,
      lower95: last.lower95,
      touchProbUpper50: calculateTouchProbability(spot, last.upper50, upsideIV, totalT),
      touchProbLower50: calculateTouchProbability(spot, last.lower50, downsideIV, totalT),
      touchProbUpper80: calculateTouchProbability(spot, last.upper80, upsideIV, totalT),
      touchProbLower80: calculateTouchProbability(spot, last.lower80, downsideIV, totalT),
      touchProbUpper95: calculateTouchProbability(spot, last.upper95, upsideIV, totalT),
      touchProbLower95: calculateTouchProbability(spot, last.lower95, downsideIV, totalT),
      touchProbMaxPain: calculateTouchProbability(spot, maxPain, mpIV, totalT),
    },
  };
}
