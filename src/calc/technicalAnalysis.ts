import type { Candle } from '../types/market';
import { calculateBollinger, calculateEMA, calculateRSI } from './indicators';
import { calculateATRSeries, calculateMACD } from './scoringEngine';

export type VolumeProfileBucket = {
  priceLow: number;
  priceHigh: number;
  mid: number;
  buyVol: number;
  sellVol: number;
  totalVol: number;
};

export type VolumeProfileData = {
  buckets: VolumeProfileBucket[];
  maxBucketVol: number;
  poc: number;
  vah: number;
  val: number;
  totalVol: number;
};

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
  }));

  let effectiveTotal = 0;
  for (const c of candles) {
    const vol = c.v > 0 ? c.v : Math.max(0.0001, Math.abs(c.h - c.l));
    const tp = (c.h + c.l + c.c) / 3;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((tp - minP) / step)));
    const range = c.h - c.l;
    const buyFrac = range > 0 ? Math.min(1, Math.max(0, (c.c - c.l) / range)) : c.c >= c.o ? 0.6 : 0.4;
    const bVol = vol * buyFrac;
    const sVol = vol * (1 - buyFrac);

    buckets[idx].buyVol += bVol;
    buckets[idx].sellVol += sVol;
    buckets[idx].totalVol += vol;
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

  return {
    buckets,
    maxBucketVol,
    poc: buckets[pocIdx].mid,
    vah: buckets[hi].priceHigh,
    val: buckets[lo].priceLow,
    totalVol: totalVol > 0 ? totalVol : effectiveTotal,
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
      // Combine close position within range + candle body polarity
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

export type FibDirectionMode = 'auto' | 'bullish' | 'bearish';

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
  swingHigh: number;
  swingHighTs: number;
  swingLow: number;
  swingLowTs: number;
  levels: FibLevelItem[];
};

const FIB_RATIOS: { ratio: number; label: string; isGolden: boolean; isExt: boolean }[] = [
  { ratio: 0, label: '0.0% (Ancla)', isGolden: false, isExt: false },
  { ratio: 0.236, label: '23.6%', isGolden: false, isExt: false },
  { ratio: 0.382, label: '38.2%', isGolden: false, isExt: false },
  { ratio: 0.5, label: '50.0% (Equilibrio)', isGolden: false, isExt: false },
  { ratio: 0.618, label: '61.8% (Golden Pocket)', isGolden: true, isExt: false },
  { ratio: 0.786, label: '78.6%', isGolden: false, isExt: false },
  { ratio: 1, label: '100.0% (Origen)', isGolden: false, isExt: false },
  { ratio: 1.272, label: '127.2% (Ext)', isGolden: false, isExt: true },
  { ratio: 1.618, label: '161.8% (Ext)', isGolden: true, isExt: true },
];

export function calculateFibonacciLevels(
  candles: Candle[],
  lookbackBars = 120,
  mode: FibDirectionMode = 'auto',
  spotOverride?: number
): FibonacciAnalysis | null {
  if (candles.length < 15) return null;
  const slice = candles.slice(-Math.min(candles.length, lookbackBars));

  let swingHigh = -Infinity;
  let highIdx = 0;
  let swingLow = Infinity;
  let lowIdx = 0;

  for (let i = 0; i < slice.length; i++) {
    if (slice[i].h > swingHigh) {
      swingHigh = slice[i].h;
      highIdx = i;
    }
    if (slice[i].l < swingLow) {
      swingLow = slice[i].l;
      lowIdx = i;
    }
  }

  const span = swingHigh - swingLow;
  if (!Number.isFinite(span) || span <= 0) return null;

  const resolvedDir: 'bullish' | 'bearish' =
    mode === 'auto' ? (lowIdx <= highIdx ? 'bullish' : 'bearish') : mode;

  const spot = spotOverride && spotOverride > 0 ? spotOverride : slice[slice.length - 1].c;

  // For bullish impulse (Low -> High): 0% is High, 100% is Low (retracement down from High).
  // Extensions (>1) project above High or below Low? Wait: in standard Fib extensions,
  // 127.2% and 161.8% extend BEYOND the 0% target (above High in bullish, below Low in bearish).
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

  return {
    direction: resolvedDir,
    swingHigh,
    swingHighTs: slice[highIdx].t,
    swingLow,
    swingLowTs: slice[lowIdx].t,
    levels,
  };
}

export type TechnicalBiasSignal = {
  id: string;
  label: string;
  valueText: string;
  bias: 'alcista' | 'bajista' | 'neutral';
};

export type TechnicalSnapshotSummary = {
  ema50: (number | null)[];
  ema200: (number | null)[];
  bollinger: { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] };
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
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const bollinger = calculateBollinger(closes, 20, 2);
  const rsi14 = calculateRSI(closes, 14);
  const macd = calculateMACD(closes, 12, 26, 9);
  const atr14 = calculateATRSeries(candles, 14);

  const i = candles.length - 1;
  const spot = i >= 0 ? candles[i].c : 0;
  const e50 = i >= 0 ? ema50[i] : null;
  const e200 = i >= 0 ? ema200[i] : null;
  const r14 = i >= 0 ? rsi14[i] : null;
  const mHist = i >= 0 ? macd.hist[i] : null;

  const signals: TechnicalBiasSignal[] = [];

  if (e50 !== null && e200 !== null) {
    const golden = e50 > e200 && spot > e50;
    const death = e50 < e200 && spot < e50;
    signals.push({
      id: 'ema-cross',
      label: 'Tendencia EMA 50 / 200',
      valueText: `${e50 > e200 ? 'EMA50 > EMA200' : 'EMA50 < EMA200'} (${(((e50 - e200) / e200) * 100).toFixed(2)}%)`,
      bias: golden ? 'alcista' : death ? 'bajista' : 'neutral',
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

  const bullishSignalsCount = signals.filter((s) => s.bias === 'alcista').length;
  const bearishSignalsCount = signals.filter((s) => s.bias === 'bajista').length;
  const overallBias: 'Alcista' | 'Bajista' | 'Neutral' =
    bullishSignalsCount >= bearishSignalsCount + 2
      ? 'Alcista'
      : bearishSignalsCount >= bullishSignalsCount + 2
      ? 'Bajista'
      : 'Neutral';

  return {
    ema50,
    ema200,
    bollinger,
    rsi14,
    macd,
    atr14,
    signals,
    bullishSignalsCount,
    bearishSignalsCount,
    overallBias,
  };
}
