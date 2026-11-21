import { analyzeMarketLiquidity } from './liquidity';
import {
  calculateFibonacciLevels,
  calculateVolumeDeltaSeries,
  calculateVolumeProfileBuckets,
  computeTechnicalSnapshot,
  detectConfluenceZones,
  detectFairValueGaps,
  detectOscillatorDivergences,
  detectSupportResistanceZones,
} from './technicalAnalysis';
import { generateTradingOptions } from './tradeSetups';
import type {
  Candle,
  Levels,
  SymbolAsset,
  Timeframe,
  TradeOptionIdea,
} from '../types/market';

export type SignalEffectivenessStatus =
  | 'PENDIENTE'
  | 'ACTIVA'
  | 'CUMPLIDA_TP1'
  | 'CUMPLIDA_TP2'
  | 'FALLIDA_STOP'
  | 'EXPIRADA';

export type SignalTrailPoint = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type TrackedOptionSignal = {
  id: string;
  dedupKey: string;
  createdAt: number;
  candleOpenTs: number;
  asset: SymbolAsset;
  timeframe: Timeframe;
  marketMode: 'perpetual' | 'spot';
  setupId: string;
  title: string;
  category: TradeOptionIdea['category'];
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  rr1: number;
  rr2: number;
  confidenceScore: number;
  v11Score: number | null;
  verdict: 'CANDIDATA' | 'ESPERAR' | 'BLOQUEADA' | 'DESCARTADA' | null;
  operable: boolean;
  mtfAlignedCount: number;
  mtfTotal: number;
  scoreDelta: number;
  confluenceEntryTag: string | null;
  alignedFactors: string[];
  conflictingFactors: string[];
  spotAtSignal: number;
  horizonBars: number;
  origin: 'live' | 'audit';

  // Evaluation fields updated from real subsequent OKX candles
  status: SignalEffectivenessStatus;
  lastEvaluatedAt: number | null;
  lastBarTs: number | null;
  lastPrice: number | null;
  entryFilled: boolean;
  entryFilledAt: number | null;
  tp1HitAt: number | null;
  tp2HitAt: number | null;
  stopHitAt: number | null;
  resolvedAt: number | null;
  resolvedPrice: number | null;
  barsObserved: number;
  barsAfterFill: number;
  maxFavorablePct: number;
  maxAdversePct: number;
  mfeR: number;
  maeR: number;
  realizedR: number | null;
  effectivenessPoints: number | null; // 0..100 when evaluated (filled outcome), null while pending/active/unfilled
  trailBars: SignalTrailPoint[];
};

export type EffectivenessBreakdownItem = {
  key: string;
  label: string;
  total: number;
  evaluatedCount: number;
  fulfilledCount: number;
  tp2Count: number;
  tp1Count: number;
  expiredFavCount: number;
  expiredUnfavCount: number;
  stopCount: number;
  expiredCount: number;
  activeCount: number;
  pendingCount: number;
  tp2Pct: number;
  tp1Pct: number;
  expiredFavPct: number;
  expiredUnfavPct: number;
  stopPct: number;
  indexPct: number | null;
  tpHitRatePct: number | null;
  avgR: number | null;
};

export type EffectivenessTimelinePoint = {
  seq: number;
  ts: number;
  asset: SymbolAsset;
  timeframe: Timeframe;
  title: string;
  direction: 'LONG' | 'SHORT';
  status: SignalEffectivenessStatus;
  signalPoints: number;
  cumulativeIndexPct: number;
  cumulativeTpHitRatePct: number;
};

export type EffectivenessSummary = {
  totalSignals: number;
  evaluatedCount: number;
  pendingCount: number;
  activeCount: number;
  unfilledExpiredCount: number;
  tp2Count: number;
  tp1Count: number;
  fulfilledCount: number;
  stopCount: number;
  filledExpiredCount: number;
  effectivenessIndexPct: number | null; // 0..100
  tpHitRatePct: number | null; // 0..100
  fillRatePct: number | null; // 0..100
  avgRealizedR: number | null;
  avgMfePct: number | null;
  avgMaePct: number | null;
  bySignalType: EffectivenessBreakdownItem[];
  byTechnicalDriver: EffectivenessBreakdownItem[];
  byCategory: EffectivenessBreakdownItem[];
  byDirection: EffectivenessBreakdownItem[];
  byAsset: EffectivenessBreakdownItem[];
  byTechAlignment: EffectivenessBreakdownItem[];
  byVerdict: EffectivenessBreakdownItem[];
  timeline: EffectivenessTimelinePoint[];
};

export const DEFAULT_SIGNAL_HORIZON_BARS = 24;

export function buildSignalDedupKey(params: {
  origin: 'live' | 'audit';
  asset: SymbolAsset;
  timeframe: Timeframe;
  marketMode: 'perpetual' | 'spot';
  setupId: string;
  candleOpenTs: number;
}): string {
  return `${params.origin}|${params.asset}|${params.timeframe}|${params.marketMode}|${params.setupId}|${params.candleOpenTs}`;
}

export function createTrackedSignalFromIdea(
  idea: TradeOptionIdea,
  meta: {
    asset: SymbolAsset;
    timeframe: Timeframe;
    marketMode: 'perpetual' | 'spot';
    candleOpenTs: number;
    spotAtSignal: number;
    origin?: 'live' | 'audit';
    horizonBars?: number;
    createdAt?: number;
  }
): TrackedOptionSignal {
  const origin = meta.origin ?? 'live';
  const dedupKey = buildSignalDedupKey({
    origin,
    asset: meta.asset,
    timeframe: meta.timeframe,
    marketMode: meta.marketMode,
    setupId: idea.id,
    candleOpenTs: meta.candleOpenTs,
  });

  return {
    id: dedupKey,
    dedupKey,
    createdAt: meta.createdAt ?? Date.now(),
    candleOpenTs: meta.candleOpenTs,
    asset: meta.asset,
    timeframe: meta.timeframe,
    marketMode: meta.marketMode,
    setupId: idea.id,
    title: idea.title,
    category: idea.category,
    direction: idea.direction,
    entry: idea.entry,
    stopLoss: idea.stopLoss,
    takeProfit1: idea.takeProfit1,
    takeProfit2: idea.takeProfit2,
    rr1: idea.rr1,
    rr2: idea.rr2,
    confidenceScore: idea.confidenceScore,
    v11Score: idea.scoring ? Number(idea.scoring.v11Score.toFixed(1)) : null,
    verdict: idea.scoring ? idea.scoring.verdict : null,
    operable: Boolean(idea.scoring?.operable),
    mtfAlignedCount: idea.technicalAlignment?.mtfAlignedCount ?? 0,
    mtfTotal: idea.technicalAlignment?.mtfTotal ?? 0,
    scoreDelta: idea.technicalAlignment?.scoreDelta ?? 0,
    confluenceEntryTag: idea.technicalAlignment?.confluenceEntryTag ?? null,
    alignedFactors: idea.technicalAlignment?.alignedFactors.slice(0, 6) ?? [],
    conflictingFactors: idea.technicalAlignment?.conflictingFactors.slice(0, 4) ?? [],
    spotAtSignal: meta.spotAtSignal,
    horizonBars: meta.horizonBars ?? DEFAULT_SIGNAL_HORIZON_BARS,
    origin,
    status: 'PENDIENTE',
    lastEvaluatedAt: null,
    lastBarTs: null,
    lastPrice: meta.spotAtSignal,
    entryFilled: false,
    entryFilledAt: null,
    tp1HitAt: null,
    tp2HitAt: null,
    stopHitAt: null,
    resolvedAt: null,
    resolvedPrice: null,
    barsObserved: 0,
    barsAfterFill: 0,
    maxFavorablePct: 0,
    maxAdversePct: 0,
    mfeR: 0,
    maeR: 0,
    realizedR: null,
    effectivenessPoints: null,
    trailBars: [],
  };
}

/**
 * Evaluates a tracked signal strictly against subsequent OKX candles (c.t > candleOpenTs).
 * Uses conservative intrabar precedence (Stop checked before TP if both touch on same candle).
 */
export function evaluateSignalAgainstCandles(
  signal: TrackedOptionSignal,
  candles: Candle[],
  horizonBarsOverride?: number,
  evaluatedAtMs = Date.now()
): TrackedOptionSignal {
  const horizon = Math.max(4, horizonBarsOverride ?? signal.horizonBars ?? DEFAULT_SIGNAL_HORIZON_BARS);
  const futureBars = candles
    .filter((c) => c.t > signal.candleOpenTs)
    .sort((a, b) => a.t - b.t)
    .slice(0, horizon);

  if (futureBars.length === 0) {
    return {
      ...signal,
      horizonBars: horizon,
      lastEvaluatedAt: evaluatedAtMs,
    };
  }

  const isLong = signal.direction === 'LONG';
  const entry = signal.entry;
  const sl = signal.stopLoss;
  const tp1 = signal.takeProfit1;
  const tp2 = signal.takeProfit2;
  const riskDist = Math.max(entry * 0.0005, Math.abs(entry - sl));

  let entryFilled = false;
  let entryFilledAt: number | null = null;
  let fillBarIdx = -1;
  let tp1HitAt: number | null = null;
  let tp2HitAt: number | null = null;
  let stopHitAt: number | null = null;
  let resolvedAt: number | null = null;
  let resolvedPrice: number | null = null;
  let bestFavAbs = 0;
  let worstAdvAbs = 0;
  let barsAfterFill = 0;

  for (let i = 0; i < futureBars.length; i++) {
    const bar = futureBars[i];

    if (!entryFilled) {
      const touchedExact = bar.l <= entry && entry <= bar.h;
      const isSpotEntryFirstBar =
        i === 0 &&
        signal.spotAtSignal > 0 &&
        Math.abs(entry - signal.spotAtSignal) / signal.spotAtSignal <= 0.0015;
      const gappedThroughLimit =
        i === 0 && ((isLong && bar.o <= entry) || (!isLong && bar.o >= entry));

      if (touchedExact || isSpotEntryFirstBar || gappedThroughLimit) {
        entryFilled = true;
        entryFilledAt = bar.t;
        fillBarIdx = i;
      }
    }

    if (!entryFilled) continue;

    barsAfterFill++;
    const favAbs = isLong ? Math.max(0, bar.h - entry) : Math.max(0, entry - bar.l);
    const advAbs = isLong ? Math.max(0, entry - bar.l) : Math.max(0, bar.h - entry);
    if (favAbs > bestFavAbs) bestFavAbs = favAbs;
    if (advAbs > worstAdvAbs) worstAdvAbs = advAbs;

    const hitStop = isLong ? bar.l <= sl : bar.h >= sl;
    const hitTp1 = isLong ? bar.h >= tp1 : bar.l <= tp1;
    const hitTp2 = isLong ? bar.h >= tp2 : bar.l <= tp2;
    const isFillCandle = i === fillBarIdx;

    // Before TP1 is reached: conservative SL check first
    if (!tp1HitAt) {
      if (hitStop) {
        stopHitAt = bar.t;
        resolvedAt = bar.t;
        resolvedPrice = sl;
        break;
      }
      // On fill candle, only accept TP1 if candle closed favorably at/beyond TP1 without SL hit
      const allowTpOnThisBar = !isFillCandle || (isLong ? bar.c >= tp1 : bar.c <= tp1);
      if (allowTpOnThisBar && hitTp1) {
        tp1HitAt = bar.t;
        const allowTp2OnThisBar = !isFillCandle || (isLong ? bar.c >= tp2 : bar.c <= tp2);
        if (allowTp2OnThisBar && hitTp2) {
          tp2HitAt = bar.t;
          resolvedAt = bar.t;
          resolvedPrice = tp2;
          break;
        }
      }
    } else {
      // TP1 already fulfilled on an earlier bar; evaluate continuation to TP2 vs trailing back to SL
      if (hitStop) {
        stopHitAt = bar.t;
        resolvedAt = bar.t;
        resolvedPrice = tp1;
        break;
      }
      if (hitTp2) {
        tp2HitAt = bar.t;
        resolvedAt = bar.t;
        resolvedPrice = tp2;
        break;
      }
    }
  }

  const lastBar = futureBars[futureBars.length - 1];
  const trailBars: SignalTrailPoint[] = futureBars.map((b) => ({
    t: b.t,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
  }));

  const maxFavorablePct = entry > 0 ? (bestFavAbs / entry) * 100 : 0;
  const maxAdversePct = entry > 0 ? (worstAdvAbs / entry) * 100 : 0;
  const mfeR = bestFavAbs / riskDist;
  const maeR = worstAdvAbs / riskDist;

  let status: SignalEffectivenessStatus;
  let effectivenessPoints: number | null = null;
  let realizedR: number | null = null;

  if (tp2HitAt) {
    status = 'CUMPLIDA_TP2';
    effectivenessPoints = 100;
    realizedR = Math.abs(tp2 - entry) / riskDist;
  } else if (tp1HitAt) {
    status = 'CUMPLIDA_TP1';
    effectivenessPoints = 85;
    // Partial fulfillment at TP1 (85/100 index pts; if still active within horizon it may later upgrade to TP2)
    realizedR = Math.abs(tp1 - entry) / riskDist;
    if (!resolvedAt && futureBars.length >= horizon) {
      resolvedAt = lastBar.t;
      resolvedPrice = tp1;
    }
  } else if (stopHitAt) {
    status = 'FALLIDA_STOP';
    effectivenessPoints = 0;
    realizedR = -1;
  } else if (!entryFilled) {
    if (futureBars.length >= horizon) {
      status = 'EXPIRADA';
      resolvedAt = lastBar.t;
      resolvedPrice = lastBar.c;
    } else {
      status = 'PENDIENTE';
    }
  } else {
    const unrealizedMove = isLong ? lastBar.c - entry : entry - lastBar.c;
    const currentR = unrealizedMove / riskDist;
    realizedR = currentR;
    if (futureBars.length >= horizon) {
      status = 'EXPIRADA';
      resolvedAt = lastBar.t;
      resolvedPrice = lastBar.c;
      if (currentR >= 0.5) effectivenessPoints = 60;
      else if (currentR > 0.1) effectivenessPoints = 45;
      else if (currentR >= -0.25) effectivenessPoints = 25;
      else effectivenessPoints = 10;
    } else {
      status = 'ACTIVA';
    }
  }

  return {
    ...signal,
    horizonBars: horizon,
    status,
    lastEvaluatedAt: evaluatedAtMs,
    lastBarTs: lastBar.t,
    lastPrice: lastBar.c,
    entryFilled,
    entryFilledAt,
    tp1HitAt,
    tp2HitAt,
    stopHitAt,
    resolvedAt,
    resolvedPrice,
    barsObserved: futureBars.length,
    barsAfterFill,
    maxFavorablePct: Number(maxFavorablePct.toFixed(2)),
    maxAdversePct: Number(maxAdversePct.toFixed(2)),
    mfeR: Number(mfeR.toFixed(2)),
    maeR: Number(maeR.toFixed(2)),
    realizedR: realizedR !== null ? Number(realizedR.toFixed(2)) : null,
    effectivenessPoints,
    trailBars,
  };
}

export function mergeSignalsIntoHistory(
  existing: TrackedOptionSignal[],
  incoming: TrackedOptionSignal[],
  maxItems = 400
): TrackedOptionSignal[] {
  const byKey = new Map<string, TrackedOptionSignal>();

  for (const item of existing) {
    byKey.set(item.dedupKey, item);
  }

  for (const next of incoming) {
    const prev = byKey.get(next.dedupKey);
    if (!prev) {
      byKey.set(next.dedupKey, next);
    } else {
      // Enrich v1.1 / technical metadata if previously missing while keeping original timestamp & progress
      const shouldUpdateMeta =
        (prev.v11Score === null && next.v11Score !== null) ||
        (prev.status === 'PENDIENTE' && next.origin === 'live');
      if (shouldUpdateMeta) {
        byKey.set(next.dedupKey, {
          ...prev,
          confidenceScore: next.confidenceScore,
          v11Score: next.v11Score ?? prev.v11Score,
          verdict: next.verdict ?? prev.verdict,
          operable: next.operable || prev.operable,
          mtfAlignedCount: Math.max(prev.mtfAlignedCount, next.mtfAlignedCount),
          mtfTotal: Math.max(prev.mtfTotal, next.mtfTotal),
          scoreDelta: next.scoreDelta !== 0 ? next.scoreDelta : prev.scoreDelta,
          confluenceEntryTag: next.confluenceEntryTag ?? prev.confluenceEntryTag,
          alignedFactors:
            next.alignedFactors.length >= prev.alignedFactors.length
              ? next.alignedFactors
              : prev.alignedFactors,
          conflictingFactors:
            next.conflictingFactors.length > 0 ? next.conflictingFactors : prev.conflictingFactors,
        });
      }
    }
  }

  const merged = Array.from(byKey.values()).sort((a, b) => b.candleOpenTs - a.candleOpenTs || b.createdAt - a.createdAt);

  if (merged.length <= maxItems) return merged;
  // Prefer keeping live signals over older audit entries if pruning
  const live = merged.filter((s) => s.origin === 'live');
  const audit = merged.filter((s) => s.origin !== 'live');
  if (live.length >= maxItems) return live.slice(0, maxItems);
  return [...live, ...audit.slice(0, maxItems - live.length)].sort(
    (a, b) => b.candleOpenTs - a.candleOpenTs || b.createdAt - a.createdAt
  );
}

export function classifySignalStrategyType(signal: TrackedOptionSignal): {
  key: string;
  label: string;
} {
  switch (signal.setupId) {
    case 'setup-sweep-long':
      return { key: 'sweep-support', label: 'Rebote en Soporte (SSL/Bid)' };
    case 'setup-sweep-short':
      return { key: 'sweep-resistance', label: 'Rechazo en Techo (BSL/Ask)' };
    case 'setup-trend-long':
      return { key: 'breakout-bull', label: 'Ruptura / Impulso Alcista' };
    case 'setup-trend-short':
      return { key: 'seller-strength', label: 'Fuerza de Vendedor (EMA/VWAP)' };
    case 'setup-tech-confluence-long':
      return { key: 'conf-support', label: 'Rebote Confluencia Técnica' };
    case 'setup-tech-confluence-short':
      return { key: 'conf-resistance', label: 'Rechazo Confluencia Técnica' };
    case 'setup-gamma-magnet':
      return {
        key: signal.direction === 'LONG' ? 'gamma-long' : 'gamma-short',
        label:
          signal.direction === 'LONG'
            ? 'Atracción Gamma Alcista'
            : 'Atracción Gamma Bajista',
      };
    default: {
      const lower = signal.title.toLowerCase();
      if (lower.includes('ruptura') || lower.includes('breakout')) {
        return { key: 'custom-breakout', label: 'Ruptura' };
      }
      if (lower.includes('soporte') || lower.includes('ssl')) {
        return { key: 'custom-support', label: 'Rebote en Soporte' };
      }
      if (lower.includes('vendedor') || lower.includes('bajista')) {
        return { key: 'custom-seller', label: 'Fuerza de Vendedor' };
      }
      return { key: signal.setupId, label: signal.category };
    }
  }
}

export function extractTechnicalDrivers(
  signal: TrackedOptionSignal
): { key: string; label: string }[] {
  const haystack = `${signal.title} ${signal.confluenceEntryTag ?? ''} ${signal.alignedFactors.join(' ')}`.toLowerCase();
  const drivers: { key: string; label: string }[] = [];

  if (haystack.includes('clúster') || haystack.includes('cluster')) {
    drivers.push({ key: 'cluster', label: 'Clúster Multi-Factor' });
  }
  if (haystack.includes('golden pocket') || haystack.includes('fib')) {
    drivers.push({ key: 'fib', label: 'Golden Pocket Fib' });
  }
  if (haystack.includes('fvg')) {
    drivers.push({ key: 'fvg', label: 'FVG sin mitigar' });
  }
  if (haystack.includes('vpvr') || haystack.includes('poc') || haystack.includes('val') || haystack.includes('vah')) {
    drivers.push({ key: 'vpvr', label: 'Soporte/Techo VPVR' });
  }
  if (haystack.includes('matriz mtf') || signal.mtfAlignedCount >= 2) {
    drivers.push({ key: 'mtf', label: 'Alineación MTF (15m–1D)' });
  }
  if (haystack.includes('taker') || haystack.includes('absorción')) {
    drivers.push({ key: 'taker', label: 'Flujo / Absorción Taker' });
  }
  if (haystack.includes('divergencia')) {
    drivers.push({ key: 'divergence', label: 'Divergencia RSI/MACD/CVD' });
  }
  if (haystack.includes('noticias') || haystack.includes('sentimiento')) {
    drivers.push({ key: 'news', label: 'Sentimiento Noticias' });
  }
  if (drivers.length === 0) {
    drivers.push({ key: 'liquidity', label: 'Liquidez & Volatilidad Base' });
  }
  return drivers;
}

function summarizeBucket(
  key: string,
  label: string,
  items: TrackedOptionSignal[]
): EffectivenessBreakdownItem {
  const evaluated = items.filter((s) => s.effectivenessPoints !== null);
  const tp2Count = evaluated.filter((s) => s.status === 'CUMPLIDA_TP2').length;
  const tp1Count = evaluated.filter((s) => s.status === 'CUMPLIDA_TP1').length;
  const stopCount = evaluated.filter((s) => s.status === 'FALLIDA_STOP').length;
  const expiredEvaluated = evaluated.filter((s) => s.status === 'EXPIRADA');
  const expiredFavCount = expiredEvaluated.filter((s) => (s.effectivenessPoints ?? 0) >= 40).length;
  const expiredUnfavCount = expiredEvaluated.length - expiredFavCount;
  const expiredCount = expiredEvaluated.length;
  const fulfilledCount = tp2Count + tp1Count;
  const activeCount = items.filter((s) => s.status === 'ACTIVA').length;
  const pendingCount = items.filter((s) => s.status === 'PENDIENTE').length;

  const denom = evaluated.length;
  const toPct = (count: number) => (denom > 0 ? Number(((count / denom) * 100).toFixed(1)) : 0);

  const indexPct =
    denom > 0
      ? evaluated.reduce((acc, s) => acc + (s.effectivenessPoints ?? 0), 0) / denom
      : null;
  const tpHitRatePct = denom > 0 ? (fulfilledCount / denom) * 100 : null;
  const rItems = evaluated.map((s) => s.realizedR).filter((v): v is number => typeof v === 'number');
  const avgR = rItems.length > 0 ? rItems.reduce((a, b) => a + b, 0) / rItems.length : null;

  return {
    key,
    label,
    total: items.length,
    evaluatedCount: denom,
    fulfilledCount,
    tp2Count,
    tp1Count,
    expiredFavCount,
    expiredUnfavCount,
    stopCount,
    expiredCount,
    activeCount,
    pendingCount,
    tp2Pct: toPct(tp2Count),
    tp1Pct: toPct(tp1Count),
    expiredFavPct: toPct(expiredFavCount),
    expiredUnfavPct: toPct(expiredUnfavCount),
    stopPct: toPct(stopCount),
    indexPct: indexPct !== null ? Number(indexPct.toFixed(1)) : null,
    tpHitRatePct: tpHitRatePct !== null ? Number(tpHitRatePct.toFixed(1)) : null,
    avgR: avgR !== null ? Number(avgR.toFixed(2)) : null,
  };
}

function buildBreakdown(
  signals: TrackedOptionSignal[],
  classifier: (s: TrackedOptionSignal) => { key: string; label: string }
): EffectivenessBreakdownItem[] {
  const buckets = new Map<string, { label: string; items: TrackedOptionSignal[] }>();

  for (const s of signals) {
    const { key, label } = classifier(s);
    const existing = buckets.get(key);
    if (existing) existing.items.push(s);
    else buckets.set(key, { label, items: [s] });
  }

  return Array.from(buckets.entries())
    .map(([key, { label, items }]) => summarizeBucket(key, label, items))
    .sort((a, b) => (b.indexPct ?? -1) - (a.indexPct ?? -1) || b.total - a.total);
}

function buildMultiBreakdown(
  signals: TrackedOptionSignal[],
  extractor: (s: TrackedOptionSignal) => { key: string; label: string }[]
): EffectivenessBreakdownItem[] {
  const buckets = new Map<string, { label: string; items: TrackedOptionSignal[] }>();

  for (const s of signals) {
    const tags = extractor(s);
    for (const tag of tags) {
      const existing = buckets.get(tag.key);
      if (existing) existing.items.push(s);
      else buckets.set(tag.key, { label: tag.label, items: [s] });
    }
  }

  return Array.from(buckets.entries())
    .map(([key, { label, items }]) => summarizeBucket(key, label, items))
    .sort((a, b) => (b.tpHitRatePct ?? -1) - (a.tpHitRatePct ?? -1) || b.evaluatedCount - a.evaluatedCount);
}

export function computeEffectivenessSummary(signals: TrackedOptionSignal[]): EffectivenessSummary {
  const evaluated = signals
    .filter((s) => s.effectivenessPoints !== null)
    .sort((a, b) => a.candleOpenTs - b.candleOpenTs || a.createdAt - b.createdAt);

  const pendingCount = signals.filter((s) => s.status === 'PENDIENTE').length;
  const activeCount = signals.filter((s) => s.status === 'ACTIVA').length;
  const unfilledExpiredCount = signals.filter(
    (s) => s.status === 'EXPIRADA' && !s.entryFilled
  ).length;

  const tp2Count = evaluated.filter((s) => s.status === 'CUMPLIDA_TP2').length;
  const tp1Count = evaluated.filter((s) => s.status === 'CUMPLIDA_TP1').length;
  const fulfilledCount = tp2Count + tp1Count;
  const stopCount = evaluated.filter((s) => s.status === 'FALLIDA_STOP').length;
  const filledExpiredCount = evaluated.filter((s) => s.status === 'EXPIRADA').length;

  const effectivenessIndexPct =
    evaluated.length > 0
      ? Number(
          (
            evaluated.reduce((acc, s) => acc + (s.effectivenessPoints ?? 0), 0) / evaluated.length
          ).toFixed(1)
        )
      : null;

  const tpHitRatePct =
    evaluated.length > 0 ? Number(((fulfilledCount / evaluated.length) * 100).toFixed(1)) : null;

  const closedAttempts = evaluated.length + unfilledExpiredCount;
  const fillRatePct =
    closedAttempts > 0 ? Number(((evaluated.length / closedAttempts) * 100).toFixed(1)) : null;

  const rVals = evaluated.map((s) => s.realizedR).filter((v): v is number => typeof v === 'number');
  const avgRealizedR =
    rVals.length > 0 ? Number((rVals.reduce((a, b) => a + b, 0) / rVals.length).toFixed(2)) : null;

  const filledOrActive = signals.filter((s) => s.entryFilled);
  const avgMfePct =
    filledOrActive.length > 0
      ? Number(
          (
            filledOrActive.reduce((a, s) => a + s.maxFavorablePct, 0) / filledOrActive.length
          ).toFixed(2)
        )
      : null;
  const avgMaePct =
    filledOrActive.length > 0
      ? Number(
          (
            filledOrActive.reduce((a, s) => a + s.maxAdversePct, 0) / filledOrActive.length
          ).toFixed(2)
        )
      : null;

  // Build cumulative effectiveness evolution timeline
  let sumPoints = 0;
  let cumFulfilled = 0;
  const timeline: EffectivenessTimelinePoint[] = evaluated.map((s, idx) => {
    const pts = s.effectivenessPoints ?? 0;
    sumPoints += pts;
    if (s.status === 'CUMPLIDA_TP1' || s.status === 'CUMPLIDA_TP2') {
      cumFulfilled++;
    }
    const seq = idx + 1;
    return {
      seq,
      ts: s.resolvedAt ?? s.candleOpenTs,
      asset: s.asset,
      timeframe: s.timeframe,
      title: s.title,
      direction: s.direction,
      status: s.status,
      signalPoints: pts,
      cumulativeIndexPct: Number((sumPoints / seq).toFixed(1)),
      cumulativeTpHitRatePct: Number(((cumFulfilled / seq) * 100).toFixed(1)),
    };
  });

  const bySignalType = buildBreakdown(signals, classifySignalStrategyType);
  const byTechnicalDriver = buildMultiBreakdown(signals, extractTechnicalDrivers);

  const byCategory = buildBreakdown(signals, (s) => ({
    key: s.category,
    label: s.category,
  }));

  const byDirection = buildBreakdown(signals, (s) => ({
    key: s.direction,
    label: s.direction === 'LONG' ? 'Alcistas (LONG)' : 'Bajistas (SHORT)',
  }));

  const byAsset = buildBreakdown(signals, (s) => ({
    key: s.asset,
    label: `${s.asset}-USD`,
  }));

  const byTechAlignment = buildBreakdown(signals, (s) => {
    if (s.scoreDelta >= 2) {
      return { key: 'aligned', label: 'Alineadas Técnico (Δ ≥ +2)' };
    }
    if (s.scoreDelta <= -2) {
      return { key: 'conflicting', label: 'Contra Técnico (Δ ≤ -2)' };
    }
    return { key: 'neutral', label: 'Confluencia Neutral (-1..+1)' };
  });

  const byVerdict = buildBreakdown(signals, (s) => {
    if (s.verdict === 'CANDIDATA' || s.operable) {
      return { key: 'CANDIDATA', label: 'CANDIDATA v1.1 (Operables)' };
    }
    if (s.verdict === 'ESPERAR') {
      return { key: 'ESPERAR', label: 'ESPERAR v1.1' };
    }
    if (s.verdict === 'BLOQUEADA' || s.verdict === 'DESCARTADA') {
      return { key: 'BLOCKED', label: 'BLOQUEADA / DESCARTADA v1.1' };
    }
    return { key: 'BASE_TECH', label: 'Motor Técnico Base' };
  });

  return {
    totalSignals: signals.length,
    evaluatedCount: evaluated.length,
    pendingCount,
    activeCount,
    unfilledExpiredCount,
    tp2Count,
    tp1Count,
    fulfilledCount,
    stopCount,
    filledExpiredCount,
    effectivenessIndexPct,
    tpHitRatePct,
    fillRatePct,
    avgRealizedR,
    avgMfePct,
    avgMaePct,
    bySignalType,
    byTechnicalDriver,
    byCategory,
    byDirection,
    byAsset,
    byTechAlignment,
    byVerdict,
    timeline,
  };
}

const EMPTY_OPTIONS_LEVELS: Levels = {
  flip: null,
  maxPain: 0,
  callWall: 0,
  putWall: 0,
  netGex: 0,
  netGamma: 0,
};

/**
 * Walk-forward real-candle audit using OKX historical candles.
 * Generates signals strictly from candles[0..i] and compares against candles[i+1..i+horizonBars].
 */
export function auditHistoricalSignalsFromCandles(input: {
  asset: SymbolAsset;
  timeframe: Timeframe;
  marketMode: 'perpetual' | 'spot';
  candles: Candle[];
  horizonBars?: number;
  stepBars?: number;
  capitalUsd?: number;
  riskPct?: number;
  optionsLevels?: Levels;
}): TrackedOptionSignal[] {
  const {
    asset,
    timeframe,
    marketMode,
    candles,
    horizonBars = DEFAULT_SIGNAL_HORIZON_BARS,
    stepBars = 8,
    capitalUsd = 10000,
    riskPct = 0.25,
    optionsLevels = EMPTY_OPTIONS_LEVELS,
  } = input;

  if (candles.length < 90) return [];
  const sorted = candles.slice().sort((a, b) => a.t - b.t);
  const startIdx = Math.max(80, sorted.length - 220);
  const endIdx = sorted.length - Math.max(6, Math.floor(horizonBars / 3));
  if (endIdx <= startIdx) return [];

  const generated: TrackedOptionSignal[] = [];

  for (let i = startIdx; i <= endIdx; i += Math.max(2, stepBars)) {
    const slice = sorted.slice(Math.max(0, i - 180), i + 1);
    const bar = slice[slice.length - 1];
    const spot = bar.c;
    if (spot <= 0) continue;

    const volumeProfile = calculateVolumeProfileBuckets(slice.slice(-150), 28);
    const srZones = detectSupportResistanceZones(slice, spot);
    const fvgs = detectFairValueGaps(slice, spot, 5);
    const fibAnalysis = calculateFibonacciLevels(slice, 100, 'auto', spot, {
      anchorMode: 'pivots',
    });
    const deltaSeries = calculateVolumeDeltaSeries(slice);
    const liquidity = analyzeMarketLiquidity(slice, spot, optionsLevels, null, null, null);
    const techSnapshot = computeTechnicalSnapshot(
      slice,
      volumeProfile?.poc ?? liquidity.pocPrice,
      liquidity.imbalancePct
    );
    const divergences = detectOscillatorDivergences(
      slice,
      techSnapshot.rsi14,
      techSnapshot.macd.hist,
      deltaSeries
    );
    const confluences = detectConfluenceZones({
      spot,
      srZones,
      fibAnalysis,
      volumeProfile,
      liquidityLevels: liquidity.levels,
      prevDayHigh: null,
      prevDayLow: null,
    });

    const ideas = generateTradingOptions({
      asset,
      timeframe,
      candles: slice,
      spot,
      optionsLevels,
      cone: null,
      liquidity,
      capitalUsd,
      riskPct,
      scoring: null,
      volumeProfile,
      fibAnalysis,
      fvgs,
      confluences,
      divergences,
      techSnapshot,
    });

    for (const idea of ideas) {
      const tracked = createTrackedSignalFromIdea(idea, {
        asset,
        timeframe,
        marketMode,
        candleOpenTs: bar.t,
        spotAtSignal: spot,
        origin: 'audit',
        horizonBars,
        createdAt: bar.t,
      });
      generated.push(evaluateSignalAgainstCandles(tracked, sorted, horizonBars));
    }
  }

  return generated.sort((a, b) => b.candleOpenTs - a.candleOpenTs);
}
