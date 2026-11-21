import type { Candle, LiquidityLevel } from '../types/market';
import { calculateBollinger, calculateEMA, calculateRSI, calculateVWAP } from './indicators';
import {
  calculateATRSeries,
  calculateMACD,
  findConfirmedTwoBarPivots,
  type PivotPoint,
} from './scoringEngine';

export type VolumeProfileBucket = {
  priceLow: number;
  priceHigh: number;
  mid: number;
  buyVol: number;
  sellVol: number;
  totalVol: number;
  nodeType: 'poc' | 'hvn' | 'lvn' | 'normal';
};

export type VolumeProfileData = {
  buckets: VolumeProfileBucket[];
  maxBucketVol: number;
  poc: number;
  vah: number;
  val: number;
  totalVol: number;
  hvnPrices: number[];
  lvnPrices: number[];
};

/**
 * Distributes candle volume across price buckets intersecting [low, high]
 * and classifies POC, High Volume Nodes (HVN) and Low Volume Nodes (LVN).
 */
export function calculateVolumeProfileBuckets(
  candles: Candle[],
  bins = 36
): VolumeProfileData | null {
  if (candles.length < 10) return null;
  let minP = Infinity;
  let maxP = -Infinity;
  let totalVol = 0;

  for (const c of candles) {
    if (c.l < minP) minP = c.l;
    if (c.h > maxP) maxP = c.h;
    totalVol += Math.max(0, c.v);
  }
  const span = maxP - minP;
  if (!Number.isFinite(span) || span <= 0) return null;

  const step = span / bins;
  const buckets: VolumeProfileBucket[] = Array.from({ length: bins }, (_, i) => ({
    priceLow: minP + i * step,
    priceHigh: minP + (i + 1) * step,
    mid: minP + (i + 0.5) * step,
    buyVol: 0,
    sellVol: 0,
    totalVol: 0,
    nodeType: 'normal',
  }));

  let effectiveTotal = 0;
  for (const c of candles) {
    const vol = c.v > 0 ? c.v : Math.max(0.0001, Math.abs(c.h - c.l));
    const range = c.h - c.l;
    const buyFrac =
      range > 0
        ? Math.min(0.95, Math.max(0.05, (c.c - c.l) / range))
        : c.c >= c.o
        ? 0.6
        : 0.4;

    if (range <= 0) {
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((c.c - minP) / step)));
      buckets[idx].buyVol += vol * buyFrac;
      buckets[idx].sellVol += vol * (1 - buyFrac);
      buckets[idx].totalVol += vol;
      effectiveTotal += vol;
      continue;
    }

    const startIdx = Math.min(bins - 1, Math.max(0, Math.floor((c.l - minP) / step)));
    const endIdx = Math.min(bins - 1, Math.max(startIdx, Math.floor((c.h - minP) / step)));

    let overlapSum = 0;
    const weights: { idx: number; w: number }[] = [];
    for (let bIdx = startIdx; bIdx <= endIdx; bIdx++) {
      const bLow = buckets[bIdx].priceLow;
      const bHigh = buckets[bIdx].priceHigh;
      const overlap = Math.max(0, Math.min(c.h, bHigh) - Math.max(c.l, bLow));
      const w = overlap > 0 ? overlap : step * 0.25;
      weights.push({ idx: bIdx, w });
      overlapSum += w;
    }

    for (const item of weights) {
      const share = overlapSum > 0 ? (item.w / overlapSum) * vol : vol / weights.length;
      buckets[item.idx].buyVol += share * buyFrac;
      buckets[item.idx].sellVol += share * (1 - buyFrac);
      buckets[item.idx].totalVol += share;
    }
    effectiveTotal += vol;
  }

  let pocIdx = 0;
  let maxBucketVol = 0;
  for (let i = 0; i < bins; i++) {
    if (buckets[i].totalVol > maxBucketVol) {
      maxBucketVol = buckets[i].totalVol;
      pocIdx = i;
    }
  }

  // 70% Value Area
  const targetVa = effectiveTotal * 0.7;
  let vaVol = buckets[pocIdx].totalVol;
  let lo = pocIdx;
  let hi = pocIdx;
  while (vaVol < targetVa && (lo > 0 || hi < bins - 1)) {
    const up = hi < bins - 1 ? buckets[hi + 1].totalVol : -1;
    const dn = lo > 0 ? buckets[lo - 1].totalVol : -1;
    if (up >= dn && hi < bins - 1) {
      hi++;
      vaVol += buckets[hi].totalVol;
    } else if (lo > 0) {
      lo--;
      vaVol += buckets[lo].totalVol;
    } else {
      break;
    }
  }

  // Classify POC / HVN / LVN nodes
  const hvnPrices: number[] = [];
  const lvnPrices: number[] = [];
  buckets[pocIdx].nodeType = 'poc';

  for (let i = 0; i < bins; i++) {
    if (i === pocIdx) continue;
    const v = buckets[i].totalVol;
    const ratio = maxBucketVol > 0 ? v / maxBucketVol : 0;
    const prevV = i > 0 ? buckets[i - 1].totalVol : v;
    const nextV = i < bins - 1 ? buckets[i + 1].totalVol : v;

    if (ratio >= 0.72 && v >= prevV * 0.96 && v >= nextV * 0.96) {
      buckets[i].nodeType = 'hvn';
      hvnPrices.push(buckets[i].mid);
    } else if (
      i > 1 &&
      i < bins - 2 &&
      ratio <= 0.34 &&
      ratio >= 0.03 &&
      v <= prevV &&
      v <= nextV
    ) {
      buckets[i].nodeType = 'lvn';
      lvnPrices.push(buckets[i].mid);
    }
  }

  return {
    buckets,
    maxBucketVol,
    poc: buckets[pocIdx].mid,
    vah: buckets[hi].priceHigh,
    val: buckets[lo].priceLow,
    totalVol: totalVol > 0 ? totalVol : effectiveTotal,
    hvnPrices,
    lvnPrices,
  };
}

export type VolumeDeltaPoint = {
  t: number;
  delta: number;
  cvd: number;
  buyVol: number;
  sellVol: number;
};

/**
 * Estimates per-bar buy/sell volume delta and cumulative volume delta (CVD)
 * across the candle history using intrabar closing position.
 */
export function calculateVolumeDeltaSeries(candles: Candle[]): VolumeDeltaPoint[] {
  const out: VolumeDeltaPoint[] = [];
  let cvd = 0;

  for (const c of candles) {
    const vol = Math.max(0, c.v);
    const range = c.h - c.l;
    let buyFrac = 0.5;
    if (range > 0) {
      const closePos = (c.c - c.l) / range;
      const bodyBias = c.c >= c.o ? 0.55 : 0.45;
      buyFrac = Math.min(0.95, Math.max(0.05, closePos * 0.75 + bodyBias * 0.25));
    } else {
      buyFrac = c.c >= c.o ? 0.65 : 0.35;
    }
    const buyVol = vol * buyFrac;
    const sellVol = vol * (1 - buyFrac);
    const delta = buyVol - sellVol;
    cvd += delta;
    out.push({
      t: c.t,
      delta,
      cvd,
      buyVol,
      sellVol,
    });
  }

  return out;
}

/**
 * Computes Anchored VWAP from a specific timestamp forward.
 */
export function calculateAnchoredVWAPFromTs(
  candles: Candle[],
  anchorTs: number | null
): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  if (!anchorTs || candles.length === 0) return out;

  const startIdx = candles.findIndex((c) => c.t >= anchorTs);
  if (startIdx < 0) return out;

  let cumPV = 0;
  let cumV = 0;
  for (let i = startIdx; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.h + c.l + c.c) / 3;
    const v = Math.max(0, c.v);
    cumPV += tp * v;
    cumV += v;
    out[i] = cumV > 0 ? cumPV / cumV : tp;
  }
  return out;
}

export type SupportResistanceZone = {
  id: string;
  price: number;
  kind: 'support' | 'resistance';
  touches: number;
  strength: number; // 1..100
  distancePct: number;
};

export function detectSupportResistanceZones(
  candles: Candle[],
  spot: number
): SupportResistanceZone[] {
  if (candles.length < 20 || spot <= 0) return [];

  const lookback = 3;
  const rawLevels: { price: number; touches: number }[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].h;
    const l = candles[i].l;
    let isHigh = true;
    let isLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].h > h) isHigh = false;
      if (candles[j].l < l) isLow = false;
    }

    if (isHigh) {
      const match = rawLevels.find((lvl) => Math.abs(lvl.price - h) / h < 0.0032);
      if (match) {
        match.price = (match.price * match.touches + h) / (match.touches + 1);
        match.touches += 1;
      } else {
        rawLevels.push({ price: h, touches: 1 });
      }
    }

    if (isLow) {
      const match = rawLevels.find((lvl) => Math.abs(lvl.price - l) / l < 0.0032);
      if (match) {
        match.price = (match.price * match.touches + l) / (match.touches + 1);
        match.touches += 1;
      } else {
        rawLevels.push({ price: l, touches: 1 });
      }
    }
  }

  const supports = rawLevels
    .filter((l) => l.price < spot * 0.9985)
    .sort((a, b) => b.touches - a.touches || b.price - a.price)
    .slice(0, 3)
    .map((l, idx) => ({
      id: `sr-sup-${idx}-${Math.round(l.price)}`,
      price: l.price,
      kind: 'support' as const,
      touches: l.touches,
      strength: Math.min(98, 48 + l.touches * 15),
      distancePct: ((l.price - spot) / spot) * 100,
    }));

  const resistances = rawLevels
    .filter((l) => l.price > spot * 1.0015)
    .sort((a, b) => b.touches - a.touches || a.price - b.price)
    .slice(0, 3)
    .map((l, idx) => ({
      id: `sr-res-${idx}-${Math.round(l.price)}`,
      price: l.price,
      kind: 'resistance' as const,
      touches: l.touches,
      strength: Math.min(98, 48 + l.touches * 15),
      distancePct: ((l.price - spot) / spot) * 100,
    }));

  return [...resistances, ...supports].sort((a, b) => b.price - a.price);
}

export type FairValueGap = {
  id: string;
  direction: 'bullish' | 'bearish';
  top: number;
  bottom: number;
  mid: number;
  createdTs: number;
  mitigated: boolean;
  mitigatedTs: number | null;
  distancePct: number;
};

/**
 * Detects 3-candle Fair Value Gaps (FVG / Imbalances) and tracks whether price mitigated them.
 */
export function detectFairValueGaps(
  candles: Candle[],
  spot: number,
  maxActive = 6
): FairValueGap[] {
  if (candles.length < 5 || spot <= 0) return [];
  const gaps: FairValueGap[] = [];
  const minGapPct = 0.0008; // ignore microscopic noise < 0.08%

  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const next = candles[i + 1];

    // Bullish FVG: prev.high < next.low
    if (next.l > prev.h && (next.l - prev.h) / curr.c >= minGapPct) {
      const bottom = prev.h;
      const top = next.l;
      let mitigated = false;
      let mitigatedTs: number | null = null;
      for (let k = i + 2; k < candles.length; k++) {
        if (candles[k].l <= bottom) {
          mitigated = true;
          mitigatedTs = candles[k].t;
          break;
        }
      }
      if (!mitigated) {
        const mid = (top + bottom) / 2;
        gaps.push({
          id: `fvg-bull-${curr.t}`,
          direction: 'bullish',
          top,
          bottom,
          mid,
          createdTs: curr.t,
          mitigated,
          mitigatedTs,
          distancePct: ((mid - spot) / spot) * 100,
        });
      }
    }

    // Bearish FVG: prev.low > next.high
    if (prev.l > next.h && (prev.l - next.h) / curr.c >= minGapPct) {
      const top = prev.l;
      const bottom = next.h;
      let mitigated = false;
      let mitigatedTs: number | null = null;
      for (let k = i + 2; k < candles.length; k++) {
        if (candles[k].h >= top) {
          mitigated = true;
          mitigatedTs = candles[k].t;
          break;
        }
      }
      if (!mitigated) {
        const mid = (top + bottom) / 2;
        gaps.push({
          id: `fvg-bear-${curr.t}`,
          direction: 'bearish',
          top,
          bottom,
          mid,
          createdTs: curr.t,
          mitigated,
          mitigatedTs,
          distancePct: ((mid - spot) / spot) * 100,
        });
      }
    }
  }

  return gaps
    .sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct))
    .slice(0, maxActive);
}

export type FibDirectionMode = 'auto' | 'bullish' | 'bearish';
export type FibAnchorMode = 'pivots' | 'window' | 'manual';

export type FibManualAnchor = {
  price: number;
  ts: number;
};

export type FibLevelItem = {
  ratio: number;
  label: string;
  price: number;
  distancePct: number;
  isGolden: boolean;
  isExtension: boolean;
};

export type FibonacciAnalysis = {
  direction: 'bullish' | 'bearish';
  anchorMode: FibAnchorMode;
  swingHigh: number;
  swingHighTs: number;
  swingLow: number;
  swingLowTs: number;
  goldenPocketLow: number;
  goldenPocketHigh: number;
  levels: FibLevelItem[];
};

const FIB_RATIOS: { ratio: number; label: string; isGolden: boolean; isExt: boolean }[] = [
  { ratio: 0, label: '0.0% (Ancla)', isGolden: false, isExt: false },
  { ratio: 0.236, label: '23.6%', isGolden: false, isExt: false },
  { ratio: 0.382, label: '38.2%', isGolden: false, isExt: false },
  { ratio: 0.5, label: '50.0% (Equilibrio)', isGolden: false, isExt: false },
  { ratio: 0.618, label: '61.8% (Golden Pocket)', isGolden: true, isExt: false },
  { ratio: 0.65, label: '65.0% (Golden Pocket)', isGolden: true, isExt: false },
  { ratio: 0.786, label: '78.6%', isGolden: false, isExt: false },
  { ratio: 1, label: '100.0% (Origen)', isGolden: false, isExt: false },
  { ratio: 1.272, label: '127.2% (Ext)', isGolden: false, isExt: true },
  { ratio: 1.618, label: '161.8% (Ext)', isGolden: true, isExt: true },
];

export function calculateFibonacciLevels(
  candles: Candle[],
  lookbackBars = 120,
  mode: FibDirectionMode = 'auto',
  spotOverride?: number,
  options?: {
    anchorMode?: FibAnchorMode;
    manualA?: FibManualAnchor | null;
    manualB?: FibManualAnchor | null;
  }
): FibonacciAnalysis | null {
  if (candles.length < 15) return null;
  const anchorMode: FibAnchorMode = options?.anchorMode ?? 'window';
  const slice = candles.slice(-Math.min(candles.length, lookbackBars));

  let swingHigh = -Infinity;
  let highTs = slice[0].t;
  let highIdx = 0;
  let swingLow = Infinity;
  let lowTs = slice[0].t;
  let lowIdx = 0;

  if (anchorMode === 'manual' && options?.manualA && options?.manualB) {
    const a = options.manualA;
    const b = options.manualB;
    if (a.price >= b.price) {
      swingHigh = a.price;
      highTs = a.ts;
      swingLow = b.price;
      lowTs = b.ts;
    } else {
      swingHigh = b.price;
      highTs = b.ts;
      swingLow = a.price;
      lowTs = a.ts;
    }
    highIdx = highTs;
    lowIdx = lowTs;
  } else if (anchorMode === 'pivots') {
    const pivots = findConfirmedTwoBarPivots(slice);
    const pivotHighs = pivots.filter((p) => p.type === 'H');
    const pivotLows = pivots.filter((p) => p.type === 'L');

    if (pivotHighs.length > 0 && pivotLows.length > 0) {
      const topHigh = pivotHighs.reduce((best, p) => (p.price > best.price ? p : best), pivotHighs[0]);
      const botLow = pivotLows.reduce((best, p) => (p.price < best.price ? p : best), pivotLows[0]);
      swingHigh = topHigh.price;
      highTs = topHigh.ts;
      highIdx = topHigh.index;
      swingLow = botLow.price;
      lowTs = botLow.ts;
      lowIdx = botLow.index;
    }
  }

  // Fallback to window extremes if pivots didn't populate
  if (!Number.isFinite(swingHigh) || !Number.isFinite(swingLow) || swingHigh <= swingLow) {
    swingHigh = -Infinity;
    swingLow = Infinity;
    for (let i = 0; i < slice.length; i++) {
      if (slice[i].h > swingHigh) {
        swingHigh = slice[i].h;
        highTs = slice[i].t;
        highIdx = i;
      }
      if (slice[i].l < swingLow) {
        swingLow = slice[i].l;
        lowTs = slice[i].t;
        lowIdx = i;
      }
    }
  }

  const span = swingHigh - swingLow;
  if (!Number.isFinite(span) || span <= 0) return null;

  const resolvedDir: 'bullish' | 'bearish' =
    mode === 'auto' ? (lowIdx <= highIdx ? 'bullish' : 'bearish') : mode;

  const spot = spotOverride && spotOverride > 0 ? spotOverride : slice[slice.length - 1].c;

  const levels: FibLevelItem[] = FIB_RATIOS.map((cfg) => {
    let price: number;
    if (!cfg.isExt) {
      price =
        resolvedDir === 'bullish'
          ? swingHigh - span * cfg.ratio
          : swingLow + span * cfg.ratio;
    } else {
      const extSpan = cfg.ratio - 1;
      price =
        resolvedDir === 'bullish'
          ? swingHigh + span * extSpan
          : swingLow - span * extSpan;
    }

    return {
      ratio: cfg.ratio,
      label: cfg.label,
      price,
      distancePct: spot > 0 ? ((price - spot) / spot) * 100 : 0,
      isGolden: cfg.isGolden,
      isExtension: cfg.isExt,
    };
  }).sort((a, b) => b.price - a.price);

  const p618 = levels.find((l) => l.ratio === 0.618)?.price ?? swingLow;
  const p65 = levels.find((l) => l.ratio === 0.65)?.price ?? swingLow;

  return {
    direction: resolvedDir,
    anchorMode,
    swingHigh,
    swingHighTs: highTs,
    swingLow,
    swingLowTs: lowTs,
    goldenPocketLow: Math.min(p618, p65),
    goldenPocketHigh: Math.max(p618, p65),
    levels,
  };
}

export type OscillatorDivergence = {
  id: string;
  ts: number;
  prevTs: number;
  price: number;
  prevPrice: number;
  oscType: 'RSI' | 'MACD' | 'CVD';
  kind: 'bullish_regular' | 'bearish_regular' | 'bullish_hidden' | 'bearish_hidden';
  label: string;
  summary: string;
};

/**
 * Compares recent confirmed 2-bar pivots against RSI(14), MACD histogram and CVD
 * to flag regular and hidden divergences.
 */
export function detectOscillatorDivergences(
  candles: Candle[],
  rsi14: (number | null)[],
  macdHist: (number | null)[],
  cvdSeries: VolumeDeltaPoint[]
): OscillatorDivergence[] {
  if (candles.length < 30) return [];
  const pivots = findConfirmedTwoBarPivots(candles);
  const lows = pivots.filter((p) => p.type === 'L');
  const highs = pivots.filter((p) => p.type === 'H');
  const out: OscillatorDivergence[] = [];

  const checkSeries = (
    oscType: 'RSI' | 'MACD' | 'CVD',
    getVal: (idx: number) => number | null,
    minDeltaAbs: number
  ) => {
    // Bullish on lows
    for (let k = Math.max(1, lows.length - 4); k < lows.length; k++) {
      const p2: PivotPoint = lows[k];
      const p1: PivotPoint = lows[k - 1];
      if (p2.index - p1.index < 4 || p2.index - p1.index > 55) continue;
      const v1 = getVal(p1.index);
      const v2 = getVal(p2.index);
      if (v1 === null || v2 === null) continue;

      // Regular Bullish: Price LL, Osc HL
      if (p2.price < p1.price * 0.999 && v2 > v1 + minDeltaAbs) {
        out.push({
          id: `div-${oscType}-reg-bull-${p2.ts}`,
          ts: p2.ts,
          prevTs: p1.ts,
          price: p2.price,
          prevPrice: p1.price,
          oscType,
          kind: 'bullish_regular',
          label: `Div+ ${oscType}`,
          summary: `Divergencia alcista regular en ${oscType}: precio hace mínimo menor mientras ${oscType} sube.`,
        });
      } else if (p2.price > p1.price * 1.001 && v2 < v1 - minDeltaAbs) {
        // Hidden Bullish: Price HL, Osc LL
        out.push({
          id: `div-${oscType}-hid-bull-${p2.ts}`,
          ts: p2.ts,
          prevTs: p1.ts,
          price: p2.price,
          prevPrice: p1.price,
          oscType,
          kind: 'bullish_hidden',
          label: `Div+ Oc. ${oscType}`,
          summary: `Divergencia alcista oculta en ${oscType} (continuación).`,
        });
      }
    }

    // Bearish on highs
    for (let k = Math.max(1, highs.length - 4); k < highs.length; k++) {
      const p2: PivotPoint = highs[k];
      const p1: PivotPoint = highs[k - 1];
      if (p2.index - p1.index < 4 || p2.index - p1.index > 55) continue;
      const v1 = getVal(p1.index);
      const v2 = getVal(p2.index);
      if (v1 === null || v2 === null) continue;

      // Regular Bearish: Price HH, Osc LH
      if (p2.price > p1.price * 1.001 && v2 < v1 - minDeltaAbs) {
        out.push({
          id: `div-${oscType}-reg-bear-${p2.ts}`,
          ts: p2.ts,
          prevTs: p1.ts,
          price: p2.price,
          prevPrice: p1.price,
          oscType,
          kind: 'bearish_regular',
          label: `Div- ${oscType}`,
          summary: `Divergencia bajista regular en ${oscType}: precio hace máximo mayor mientras ${oscType} cae.`,
        });
      } else if (p2.price < p1.price * 0.999 && v2 > v1 + minDeltaAbs) {
        // Hidden Bearish: Price LH, Osc HH
        out.push({
          id: `div-${oscType}-hid-bear-${p2.ts}`,
          ts: p2.ts,
          prevTs: p1.ts,
          price: p2.price,
          prevPrice: p1.price,
          oscType,
          kind: 'bearish_hidden',
          label: `Div- Oc. ${oscType}`,
          summary: `Divergencia bajista oculta en ${oscType} (continuación).`,
        });
      }
    }
  };

  checkSeries('RSI', (i) => rsi14[i] ?? null, 2.0);
  checkSeries('MACD', (i) => macdHist[i] ?? null, 0.05);
  checkSeries('CVD', (i) => (cvdSeries[i] ? cvdSeries[i].cvd : null), 1.0);

  return out.sort((a, b) => b.ts - a.ts).slice(0, 8);
}

export type ConfluenceZone = {
  id: string;
  avgPrice: number;
  lowPrice: number;
  highPrice: number;
  factors: string[];
  factorCount: number;
  strength: number;
  kind: 'soporte' | 'resistencia' | 'pivote';
  distancePct: number;
};

/**
 * Groups overlapping technical levels (S/R, Fib, VPVR POC/VAH/VAL, Orderbook Walls, BSL/SSL, PDH/PDL)
 * within ±0.30% into high-conviction Confluence Clusters to prevent chart clutter.
 */
export function detectConfluenceZones(params: {
  spot: number;
  srZones: SupportResistanceZone[];
  fibAnalysis: FibonacciAnalysis | null;
  volumeProfile: VolumeProfileData | null;
  liquidityLevels: LiquidityLevel[];
  prevDayHigh: number | null;
  prevDayLow: number | null;
}): ConfluenceZone[] {
  const { spot, srZones, fibAnalysis, volumeProfile, liquidityLevels, prevDayHigh, prevDayLow } =
    params;
  if (spot <= 0) return [];

  type TaggedLvl = { price: number; label: string; weight: number };
  const items: TaggedLvl[] = [];

  for (const z of srZones) {
    items.push({
      price: z.price,
      label: `${z.kind === 'support' ? 'Soporte' : 'Resistencia'} ×${z.touches}`,
      weight: 22,
    });
  }
  if (fibAnalysis) {
    for (const fl of fibAnalysis.levels) {
      if ([0.382, 0.5, 0.618, 0.786, 1.618].includes(fl.ratio)) {
        items.push({
          price: fl.price,
          label: `Fib ${(fl.ratio * 100).toFixed(1)}%`,
          weight: fl.isGolden ? 26 : 16,
        });
      }
    }
  }
  if (volumeProfile) {
    items.push({ price: volumeProfile.poc, label: 'POC VPVR', weight: 28 });
    items.push({ price: volumeProfile.vah, label: 'VAH', weight: 18 });
    items.push({ price: volumeProfile.val, label: 'VAL', weight: 18 });
  }
  if (prevDayHigh) items.push({ price: prevDayHigh, label: 'PDH', weight: 22 });
  if (prevDayLow) items.push({ price: prevDayLow, label: 'PDL', weight: 22 });

  for (const l of liquidityLevels) {
    if (l.type === 'POC' || l.type === 'PDH' || l.type === 'PDL') continue;
    items.push({
      price: l.price,
      label: l.label,
      weight: l.type === 'ASK_WALL' || l.type === 'BID_WALL' ? 24 : 18,
    });
  }

  const sorted = items.filter((i) => i.price > 0).sort((a, b) => a.price - b.price);
  const clusters: { items: TaggedLvl[]; avg: number }[] = [];

  for (const it of sorted) {
    const match = clusters.find((cl) => Math.abs(cl.avg - it.price) / cl.avg <= 0.003);
    if (match) {
      match.items.push(it);
      match.avg = match.items.reduce((s, x) => s + x.price, 0) / match.items.length;
    } else {
      clusters.push({ items: [it], avg: it.price });
    }
  }

  return clusters
    .map((cl, idx) => {
      const uniqueFactors = Array.from(new Set(cl.items.map((x) => x.label)));
      if (uniqueFactors.length < 2) return null;
      const prices = cl.items.map((x) => x.price);
      const lowPrice = Math.min(...prices);
      const highPrice = Math.max(...prices);
      const distPct = ((cl.avg - spot) / spot) * 100;
      const rawScore = cl.items.reduce((s, x) => s + x.weight, 0);
      const kind: ConfluenceZone['kind'] =
        distPct > 0.12 ? 'resistencia' : distPct < -0.12 ? 'soporte' : 'pivote';

      return {
        id: `conf-${idx}-${Math.round(cl.avg)}`,
        avgPrice: cl.avg,
        lowPrice,
        highPrice,
        factors: uniqueFactors,
        factorCount: uniqueFactors.length,
        strength: Math.min(99, Math.round(rawScore)),
        kind,
        distancePct: distPct,
      };
    })
    .filter((x): x is ConfluenceZone => x !== null)
    .sort((a, b) => b.factorCount - a.factorCount || Math.abs(a.distancePct) - Math.abs(b.distancePct))
    .slice(0, 6);
}

export type TechnicalBiasSignal = {
  id: string;
  label: string;
  valueText: string;
  bias: 'alcista' | 'bajista' | 'neutral';
};

export type TechnicalSnapshotSummary = {
  ema20: (number | null)[];
  ema50: (number | null)[];
  ema200: (number | null)[];
  bollinger: { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] };
  bbWidthPct: (number | null)[];
  isSqueeze: boolean;
  rsi14: (number | null)[];
  macd: { macd: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] };
  atr14: (number | null)[];
  signals: TechnicalBiasSignal[];
  bullishSignalsCount: number;
  bearishSignalsCount: number;
  overallBias: 'Alcista' | 'Bajista' | 'Neutral';
};

export function computeTechnicalSnapshot(
  candles: Candle[],
  poc: number | null,
  bookImbalancePct: number
): TechnicalSnapshotSummary {
  const closes = candles.map((c) => c.c);
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const bollinger = calculateBollinger(closes, 20, 2);
  const bbWidthPct: (number | null)[] = bollinger.middle.map((mid, idx) => {
    const up = bollinger.upper[idx];
    const lo = bollinger.lower[idx];
    if (mid === null || up === null || lo === null || mid <= 0) return null;
    return ((up - lo) / mid) * 100;
  });
  const validWidths = bbWidthPct.slice(-100).filter((v): v is number => v !== null);
  const lastWidth = bbWidthPct[bbWidthPct.length - 1] ?? null;
  let isSqueeze = false;
  if (lastWidth !== null && validWidths.length >= 20) {
    const sortedW = [...validWidths].sort((a, b) => a - b);
    const pct20 = sortedW[Math.floor(sortedW.length * 0.2)];
    isSqueeze = lastWidth <= pct20;
  }

  const rsi14 = calculateRSI(closes, 14);
  const macd = calculateMACD(closes, 12, 26, 9);
  const atr14 = calculateATRSeries(candles, 14);

  const i = candles.length - 1;
  const spot = i >= 0 ? candles[i].c : 0;
  const e20 = i >= 0 ? ema20[i] : null;
  const e50 = i >= 0 ? ema50[i] : null;
  const e200 = i >= 0 ? ema200[i] : null;
  const r14 = i >= 0 ? rsi14[i] : null;
  const mHist = i >= 0 ? macd.hist[i] : null;

  const signals: TechnicalBiasSignal[] = [];

  if (e20 !== null && e50 !== null && e200 !== null) {
    const bullStack = spot > e20 && e20 > e50 && e50 > e200;
    const bearStack = spot < e20 && e20 < e50 && e50 < e200;
    signals.push({
      id: 'ema-cross',
      label: 'Alineación EMA 20/50/200',
      valueText: bullStack
        ? 'Alcista perfecta (20>50>200)'
        : bearStack
        ? 'Bajista perfecta (20<50<200)'
        : `${e50 > e200 ? 'EMA50 > 200' : 'EMA50 < 200'} (${(((e50 - e200) / e200) * 100).toFixed(2)}%)`,
      bias: bullStack || (e50 > e200 && spot > e50) ? 'alcista' : bearStack || (e50 < e200 && spot < e50) ? 'bajista' : 'neutral',
    });
  } else if (e50 !== null) {
    signals.push({
      id: 'ema-50',
      label: 'Posición vs EMA 50',
      valueText: `Precio ${spot >= e50 ? 'sobre' : 'bajo'} $${e50.toFixed(1)}`,
      bias: spot >= e50 ? 'alcista' : 'bajista',
    });
  }

  if (r14 !== null) {
    signals.push({
      id: 'rsi',
      label: 'Momentum RSI (14)',
      valueText: `${r14.toFixed(1)}`,
      bias: r14 >= 55 ? 'alcista' : r14 <= 45 ? 'bajista' : 'neutral',
    });
  }

  if (mHist !== null) {
    signals.push({
      id: 'macd',
      label: 'Histograma MACD',
      valueText: `${mHist >= 0 ? '+' : ''}${mHist.toFixed(2)}`,
      bias: mHist > 0 ? 'alcista' : mHist < 0 ? 'bajista' : 'neutral',
    });
  }

  if (poc !== null && spot > 0) {
    signals.push({
      id: 'poc',
      label: 'Aceptación vs POC Volumen',
      valueText: `POC $${poc.toFixed(1)} (${spot >= poc ? '+' : ''}${(((spot - poc) / poc) * 100).toFixed(2)}%)`,
      bias: spot > poc * 1.001 ? 'alcista' : spot < poc * 0.999 ? 'bajista' : 'neutral',
    });
  }

  signals.push({
    id: 'book',
    label: 'Desequilibrio Libro OKX',
    valueText: `${bookImbalancePct >= 0 ? '+' : ''}${bookImbalancePct.toFixed(1)}%`,
    bias: bookImbalancePct >= 6 ? 'alcista' : bookImbalancePct <= -6 ? 'bajista' : 'neutral',
  });

  if (lastWidth !== null) {
    signals.push({
      id: 'bb-squeeze',
      label: 'Volatilidad BB Width',
      valueText: `${lastWidth.toFixed(2)}%${isSqueeze ? ' (SQUEEZE)' : ''}`,
      bias: 'neutral',
    });
  }

  const bullishSignalsCount = signals.filter((s) => s.bias === 'alcista').length;
  const bearishSignalsCount = signals.filter((s) => s.bias === 'bajista').length;
  const overallBias: 'Alcista' | 'Bajista' | 'Neutral' =
    bullishSignalsCount >= bearishSignalsCount + 2
      ? 'Alcista'
      : bearishSignalsCount >= bullishSignalsCount + 2
      ? 'Bajista'
      : 'Neutral';

  return {
    ema20,
    ema50,
    ema200,
    bollinger,
    bbWidthPct,
    isSqueeze,
    rsi14,
    macd,
    atr14,
    signals,
    bullishSignalsCount,
    bearishSignalsCount,
    overallBias,
  };
}

export type MultiTimeframeRow = {
  tf: '15m' | '1H' | '4H' | 'D';
  label: string;
  emaBias: 'alcista' | 'bajista' | 'neutral';
  rsi: number | null;
  macdHist: number | null;
  vsVwap: 'sobre' | 'bajo' | 'n/a';
  overall: 'Alcista' | 'Bajista' | 'Neutral';
};

export function evaluateMultiTimeframeMatrix(
  candlesByTf: Partial<Record<'15m' | '1H' | '4H' | 'D', Candle[]>>
): MultiTimeframeRow[] {
  const defs: { tf: '15m' | '1H' | '4H' | 'D'; label: string }[] = [
    { tf: '15m', label: '15m' },
    { tf: '1H', label: '1h' },
    { tf: '4H', label: '4h' },
    { tf: 'D', label: '1d' },
  ];

  const rows: MultiTimeframeRow[] = [];

  for (const def of defs) {
    const arr = candlesByTf[def.tf];
    if (!arr || arr.length < 30) {
      rows.push({
        tf: def.tf,
        label: def.label,
        emaBias: 'neutral',
        rsi: null,
        macdHist: null,
        vsVwap: 'n/a',
        overall: 'Neutral',
      });
      continue;
    }

    const closes = arr.map((c) => c.c);
    const e20 = calculateEMA(closes, 20)[closes.length - 1];
    const e50 = calculateEMA(closes, 50)[closes.length - 1];
    const e200 = calculateEMA(closes, 200)[closes.length - 1];
    const rsi = calculateRSI(closes, 14)[closes.length - 1];
    const macdHist = calculateMACD(closes, 12, 26, 9).hist[closes.length - 1];
    const vwapArr = calculateVWAP(arr);
    const vwap = vwapArr[vwapArr.length - 1];
    const spot = closes[closes.length - 1];

    let bull = 0;
    let bear = 0;
    let emaBias: MultiTimeframeRow['emaBias'] = 'neutral';
    if (e20 !== null && e50 !== null) {
      if (spot > e20 && e20 > e50 && (e200 === null || e50 > e200)) {
        emaBias = 'alcista';
        bull += 2;
      } else if (spot < e20 && e20 < e50 && (e200 === null || e50 < e200)) {
        emaBias = 'bajista';
        bear += 2;
      } else if (spot > e50) {
        emaBias = 'alcista';
        bull += 1;
      } else if (spot < e50) {
        emaBias = 'bajista';
        bear += 1;
      }
    }

    if (rsi !== null) {
      if (rsi >= 55) bull += 1;
      else if (rsi <= 45) bear += 1;
    }
    if (macdHist !== null) {
      if (macdHist > 0) bull += 1;
      else if (macdHist < 0) bear += 1;
    }

    const vsVwap: MultiTimeframeRow['vsVwap'] =
      vwap === null ? 'n/a' : spot >= vwap ? 'sobre' : 'bajo';
    if (vsVwap === 'sobre') bull += 1;
    else if (vsVwap === 'bajo') bear += 1;

    const overall: MultiTimeframeRow['overall'] =
      bull >= bear + 2 ? 'Alcista' : bear >= bull + 2 ? 'Bajista' : 'Neutral';

    rows.push({
      tf: def.tf,
      label: def.label,
      emaBias,
      rsi,
      macdHist,
      vsVwap,
      overall,
    });
  }

  return rows;
}
