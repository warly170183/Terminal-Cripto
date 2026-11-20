import type { Candle } from '../types/market';
import type {
  BlockedCondition,
  DirectionEvaluation,
  DirectionParamResult,
  DirectionVerdict,
  FamilySummary,
  FundingStats90D,
  MultiTfScoringDataset,
  OpenInterestWindow,
  ParameterPoints,
  ParameterScoreRow,
  ScoreBandLabel,
  ScoringConfig,
  ScoringFamilyId,
  ScoringParameterId,
  ScoringResult,
  TradeExecutionPlan,
  VolumeProfile7D,
} from '../types/scoring';
import { calculateEMA, calculateRSI } from './indicators';

// ---------------------------------------------------------------------------
// 1. Technical Helpers (ATR, ADX/DMI, MACD, 2-Bar Pivots, Anchored VWAP, VP7D)
// ---------------------------------------------------------------------------

export function calculateATRSeries(candles: Candle[], period = 14): (number | null)[] {
  const len = candles.length;
  const out: (number | null)[] = new Array(len).fill(null);
  if (len <= period) return out;

  const trs: number[] = new Array(len).fill(0);
  trs[0] = Math.max(0, candles[0].h - candles[0].l);
  for (let i = 1; i < len; i++) {
    const c = candles[i];
    const pc = candles[i - 1].c;
    trs[i] = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  }

  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += trs[i];
  }
  let atr = sum / period;
  out[period] = atr;

  for (let i = period + 1; i < len; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    out[i] = atr;
  }
  return out;
}

export function calculateADXandDMI(
  candles: Candle[],
  period = 14
): {
  adx: (number | null)[];
  plusDI: (number | null)[];
  minusDI: (number | null)[];
} {
  const len = candles.length;
  const adx: (number | null)[] = new Array(len).fill(null);
  const plusDI: (number | null)[] = new Array(len).fill(null);
  const minusDI: (number | null)[] = new Array(len).fill(null);

  if (len < period * 2 + 2) {
    return { adx, plusDI, minusDI };
  }

  const tr: number[] = new Array(len).fill(0);
  const dmPlus: number[] = new Array(len).fill(0);
  const dmMinus: number[] = new Array(len).fill(0);

  for (let i = 1; i < len; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr[i] = Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
    const upMove = c.h - p.h;
    const downMove = p.l - c.l;
    dmPlus[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    dmMinus[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  let smTR = 0;
  let smPlus = 0;
  let smMinus = 0;
  for (let i = 1; i <= period; i++) {
    smTR += tr[i];
    smPlus += dmPlus[i];
    smMinus += dmMinus[i];
  }

  const dxArr: (number | null)[] = new Array(len).fill(null);
  for (let i = period; i < len; i++) {
    if (i > period) {
      smTR = smTR - smTR / period + tr[i];
      smPlus = smPlus - smPlus / period + dmPlus[i];
      smMinus = smMinus - smMinus / period + dmMinus[i];
    }
    const pdi = smTR > 0 ? (100 * smPlus) / smTR : 0;
    const mdi = smTR > 0 ? (100 * smMinus) / smTR : 0;
    plusDI[i] = pdi;
    minusDI[i] = mdi;
    const sumDI = pdi + mdi;
    dxArr[i] = sumDI > 0 ? (100 * Math.abs(pdi - mdi)) / sumDI : 0;
  }

  let dxSum = 0;
  const adxSeedIdx = period * 2 - 1;
  for (let i = period; i <= adxSeedIdx; i++) {
    dxSum += dxArr[i] ?? 0;
  }
  let adxVal = dxSum / period;
  adx[adxSeedIdx] = adxVal;

  for (let i = adxSeedIdx + 1; i < len; i++) {
    adxVal = (adxVal * (period - 1) + (dxArr[i] ?? 0)) / period;
    adx[i] = adxVal;
  }

  return { adx, plusDI, minusDI };
}

export function calculateMACD(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): {
  macd: (number | null)[];
  signal: (number | null)[];
  hist: (number | null)[];
} {
  const len = closes.length;
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  const macd: (number | null)[] = new Array(len).fill(null);

  const validMacdVals: number[] = [];
  const validStartIdx = slow - 1;
  for (let i = 0; i < len; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f !== null && s !== null) {
      const m = f - s;
      macd[i] = m;
      validMacdVals.push(m);
    }
  }

  const signalRaw = calculateEMA(validMacdVals, signalPeriod);
  const signal: (number | null)[] = new Array(len).fill(null);
  const hist: (number | null)[] = new Array(len).fill(null);

  for (let k = 0; k < validMacdVals.length; k++) {
    const idx = validStartIdx + k;
    const sig = signalRaw[k];
    if (idx < len && sig !== null && macd[idx] !== null) {
      signal[idx] = sig;
      hist[idx] = macd[idx]! - sig;
    }
  }

  return { macd, signal, hist };
}

export type PivotPoint = {
  index: number;
  price: number;
  ts: number;
  type: 'H' | 'L';
};

/**
 * Spec v1.1 §4: "pivote de dos velas a cada lado, conocido únicamente al cerrar las dos posteriores."
 */
export function findConfirmedTwoBarPivots(candles: Candle[]): PivotPoint[] {
  const pivots: PivotPoint[] = [];
  if (candles.length < 5) return pivots;

  for (let i = 2; i <= candles.length - 3; i++) {
    const c = candles[i];
    const isHigh =
      c.h >= candles[i - 1].h &&
      c.h >= candles[i - 2].h &&
      c.h > candles[i + 1].h &&
      c.h >= candles[i + 2].h;
    const isLow =
      c.l <= candles[i - 1].l &&
      c.l <= candles[i - 2].l &&
      c.l < candles[i + 1].l &&
      c.l <= candles[i + 2].l;

    if (isHigh) {
      pivots.push({ index: i, price: c.h, ts: c.t, type: 'H' });
    }
    if (isLow) {
      pivots.push({ index: i, price: c.l, ts: c.t, type: 'L' });
    }
  }
  return pivots;
}

/**
 * Spec v1.1 §6 (C3): Fixed Volume Profile over the 7 complete UTC days prior to current day,
 * with 48 price rows and 70% Value Area around POC.
 */
export function calculateSevenDayVolumeProfile(
  candles1h: Candle[],
  referenceNowMs?: number
): VolumeProfile7D | null {
  if (candles1h.length < 24) return null;
  const lastTs = referenceNowMs ?? candles1h[candles1h.length - 1].t;
  const d = new Date(lastTs);
  const todayUtcStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const sevenDaysStart = todayUtcStart - 7 * 24 * 60 * 60 * 1000;

  let windowCandles = candles1h.filter((c) => c.t >= sevenDaysStart && c.t < todayUtcStart);
  const daySet = new Set(windowCandles.map((c) => new Date(c.t).toISOString().slice(0, 10)));

  // Fallback if fewer than 3 complete UTC days exist in sample
  if (windowCandles.length < 48) {
    windowCandles = candles1h.slice(Math.max(0, candles1h.length - 168));
  }
  if (windowCandles.length < 20) return null;

  let minP = Infinity;
  let maxP = -Infinity;
  let totalVol = 0;
  for (const c of windowCandles) {
    if (c.l < minP) minP = c.l;
    if (c.h > maxP) maxP = c.h;
    totalVol += c.v;
  }
  if (totalVol <= 0 || !Number.isFinite(minP) || !Number.isFinite(maxP) || maxP <= minP) {
    return null;
  }

  const bins = 48;
  const step = (maxP - minP) / bins;
  const buckets = new Array<number>(bins).fill(0);

  for (const c of windowCandles) {
    const tp = (c.h + c.l + c.c) / 3;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((tp - minP) / step)));
    buckets[idx] += c.v;
  }

  let pocIdx = 0;
  for (let i = 1; i < bins; i++) {
    if (buckets[i] > buckets[pocIdx]) pocIdx = i;
  }

  // 70% Value Area expansion outward from POC
  const targetVaVol = totalVol * 0.7;
  let vaVol = buckets[pocIdx];
  let lowIdx = pocIdx;
  let highIdx = pocIdx;

  while (vaVol < targetVaVol && (lowIdx > 0 || highIdx < bins - 1)) {
    const upVol = highIdx < bins - 1 ? buckets[highIdx + 1] : -1;
    const dnVol = lowIdx > 0 ? buckets[lowIdx - 1] : -1;
    if (upVol >= dnVol && highIdx < bins - 1) {
      highIdx++;
      vaVol += buckets[highIdx];
    } else if (lowIdx > 0) {
      lowIdx--;
      vaVol += buckets[lowIdx];
    } else {
      break;
    }
  }

  return {
    poc: minP + (pocIdx + 0.5) * step,
    vah: minP + (highIdx + 1) * step,
    val: minP + lowIdx * step,
    daysIncluded: Math.max(1, daySet.size),
    totalVolume: totalVol,
  };
}

function calculateAnchoredVWAP(candles: Candle[], anchorIdx: number): number[] {
  const out: number[] = new Array(candles.length).fill(0);
  let cumPV = 0;
  let cumV = 0;
  const start = Math.max(0, Math.min(candles.length - 1, anchorIdx));
  for (let i = start; i < candles.length; i++) {
    const c = candles[i];
    const tp = (c.h + c.l + c.c) / 3;
    const v = Math.max(0, c.v);
    cumPV += tp * v;
    cumV += v;
    out[i] = cumV > 0 ? cumPV / cumV : tp;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Structure Helpers (A1 & A2)
// ---------------------------------------------------------------------------

type StructureAssessment = {
  longPts: ParameterPoints;
  shortPts: ParameterPoints;
  longReason: string;
  shortReason: string;
  label: 'Alcista' | 'Bajista' | 'Rango';
  lastPivotHigh: number | null;
  lastPivotLow: number | null;
};

function evaluateSwingStructure(candles: Candle[], tfLabel: string): StructureAssessment | null {
  if (candles.length < 18) return null;
  const pivots = findConfirmedTwoBarPivots(candles);
  const highs = pivots.filter((p) => p.type === 'H');
  const lows = pivots.filter((p) => p.type === 'L');
  if (highs.length < 2 || lows.length < 2) return null;

  const h1 = highs[highs.length - 2];
  const h2 = highs[highs.length - 1];
  const l1 = lows[lows.length - 2];
  const l2 = lows[lows.length - 1];
  const lastClose = candles[candles.length - 1].c;

  const hh = h2.price > h1.price;
  const hl = l2.price > l1.price;
  const lh = h2.price < h1.price;
  const ll = l2.price < l1.price;

  const lowIntact = lastClose >= l2.price;
  const highIntact = lastClose <= h2.price;
  const brokeLastHigh = lastClose > h2.price;
  const brokeLastLow = lastClose < l2.price;

  // Complete bullish sequence (HH + HL + last low intact)
  if (hh && hl && lowIntact) {
    return {
      longPts: 100,
      shortPts: 0,
      longReason: `HH + HL confirmados en ${tfLabel}; último mínimo ($${l2.price.toFixed(0)}) intacto.`,
      shortReason: `Estructura alcista completa en ${tfLabel}; operar en contra rompe secuencia.`,
      label: 'Alcista',
      lastPivotHigh: h2.price,
      lastPivotLow: l2.price,
    };
  }

  // Complete bearish sequence (LH + LL + last high intact)
  if (lh && ll && highIntact) {
    return {
      longPts: 0,
      shortPts: 100,
      longReason: `Estructura bajista completa en ${tfLabel}; máximo decreciente ($${h2.price.toFixed(0)}) vigente.`,
      shortReason: `LH + LL confirmados en ${tfLabel}; último máximo ($${h2.price.toFixed(0)}) intacto.`,
      label: 'Bajista',
      lastPivotHigh: h2.price,
      lastPivotLow: l2.price,
    };
  }

  // Recently confirmed bullish break above prior swing high
  if (brokeLastHigh) {
    return {
      longPts: 75,
      shortPts: lh && ll ? 25 : 0,
      longReason: `Ruptura alcista confirmada en ${tfLabel} sobre pivote $${h2.price.toFixed(0)} (secuencia parcial).`,
      shortReason: `Último máximo de ${tfLabel} vulnerado al alza por cierre.`,
      label: 'Alcista',
      lastPivotHigh: h2.price,
      lastPivotLow: l2.price,
    };
  }

  // Recently confirmed bearish break below prior swing low
  if (brokeLastLow) {
    return {
      longPts: hh && hl ? 25 : 0,
      shortPts: 75,
      longReason: `Último mínimo de ${tfLabel} perdido a la baja por cierre.`,
      shortReason: `Ruptura bajista confirmada en ${tfLabel} bajo pivote $${l2.price.toFixed(0)} (secuencia parcial).`,
      label: 'Bajista',
      lastPivotHigh: h2.price,
      lastPivotLow: l2.price,
    };
  }

  // Unconfirmed early shift (HL after LH or LH after HL without contrary break)
  if (hl && lh) {
    return {
      longPts: 50,
      shortPts: 50,
      longReason: `Mínimo creciente con máximo decreciente (compresión/rango en ${tfLabel}).`,
      shortReason: `Máximo decreciente con mínimo creciente (compresión/rango en ${tfLabel}).`,
      label: 'Rango',
      lastPivotHigh: h2.price,
      lastPivotLow: l2.price,
    };
  }

  if (hl && ll === false && !hh) {
    return {
      longPts: 25,
      shortPts: 50,
      longReason: `Indicio inicial alcista (HL sin ruptura de máximo $${h2.price.toFixed(0)}).`,
      shortReason: `Rango en ${tfLabel} sin ruptura bajista nueva.`,
      label: 'Rango',
      lastPivotHigh: h2.price,
      lastPivotLow: l2.price,
    };
  }

  if (lh && !ll) {
    return {
      longPts: 50,
      shortPts: 25,
      longReason: `Rango en ${tfLabel} sin ruptura alcista nueva.`,
      shortReason: `Indicio inicial bajista (LH sin ruptura de mínimo $${l2.price.toFixed(0)}).`,
      label: 'Rango',
      lastPivotHigh: h2.price,
      lastPivotLow: l2.price,
    };
  }

  return {
    longPts: 50,
    shortPts: 50,
    longReason: `Rango sin secuencia direccional completa en ${tfLabel}.`,
    shortReason: `Rango sin secuencia direccional completa en ${tfLabel}.`,
    label: 'Rango',
    lastPivotHigh: h2.price,
    lastPivotLow: l2.price,
  };
}

// ---------------------------------------------------------------------------
// 3. Band & Status Classifiers (§10 & §11)
// ---------------------------------------------------------------------------

function classifyScoreBand(score: number, coveragePct: number): ScoreBandLabel {
  if (coveragePct < 90) return 'INCOMPLETO';
  if (score >= 90) return 'Candidata con alta confluencia';
  if (score >= 80) return 'Candidata';
  if (score >= 70) return 'Esperar mejor confirmación';
  if (score >= 60) return 'Vigilancia';
  return 'Descartar';
}

function makeParamResult(
  points: ParameterPoints | null,
  maxWeight: number,
  applicable: boolean,
  missing: boolean,
  reason: string
): DirectionParamResult {
  const weighted = applicable && !missing && points !== null ? (maxWeight * points) / 100 : 0;
  return {
    points: applicable && !missing ? points : null,
    applicable,
    missing,
    weightedPoints: weighted,
    maxWeight,
    passed: applicable && !missing && points !== null && points >= 75,
    reason,
  };
}

function roundToStep(val: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.floor(val * f) / f;
}

// ---------------------------------------------------------------------------
// 4. Main v1.1 Evaluation Engine
// ---------------------------------------------------------------------------

export function evaluateScoringSystem(
  dataset: MultiTfScoringDataset,
  config: ScoringConfig
): ScoringResult {
  const { asset, instId, candles4h, candles1h, candles15m, btcCandles4h, orderbook } = dataset;
  const spot =
    candles15m[candles15m.length - 1]?.c ??
    candles1h[candles1h.length - 1]?.c ??
    candles4h[candles4h.length - 1]?.c ??
    0;

  const lastClosed4hTs = candles4h[candles4h.length - 1]?.t ?? null;
  const lastClosed1hTs = candles1h[candles1h.length - 1]?.t ?? null;
  const lastClosed15mTs = candles15m[candles15m.length - 1]?.t ?? null;

  const excludedNotes: string[] = [];

  // Series on 1H
  const closes1h = candles1h.map((c) => c.c);
  const ema20_1h = calculateEMA(closes1h, 20);
  const ema50_1h = calculateEMA(closes1h, 50);
  const ema200_1h = calculateEMA(closes1h, 200);
  const rsi1h = calculateRSI(closes1h, 14);
  const macd1h = calculateMACD(closes1h, 12, 26, 9);
  const adxDmi1h = calculateADXandDMI(candles1h, 14);
  const atr1hArr = calculateATRSeries(candles1h, 14);

  // Series on 15m
  const atr15Arr = calculateATRSeries(candles15m, 14);

  const i1 = candles1h.length - 1;
  const i15 = candles15m.length - 1;
  const atr1h = (i1 >= 0 ? atr1hArr[i1] : null) ?? (spot > 0 ? spot * 0.008 : 0);
  const atr15 = (i15 >= 0 ? atr15Arr[i15] : null) ?? (spot > 0 ? spot * 0.004 : 0);

  // -------------------------------------------------------------------------
  // FAMILY A: Contexto y Estructura (30 pts)
  // -------------------------------------------------------------------------
  const struct4h = evaluateSwingStructure(candles4h, '4h');
  const struct1h = evaluateSwingStructure(candles1h, '1h');
  const pivots1h = findConfirmedTwoBarPivots(candles1h);

  const a1Row: ParameterScoreRow = {
    id: 'A1',
    family: 'A',
    name: 'Estructura 4 h',
    timeframeLabel: '4h',
    maxWeight: 10,
    observedSummary: struct4h ? `${struct4h.label} (4h)` : 'Sin pivotes suficientes',
    long: struct4h
      ? makeParamResult(struct4h.longPts, 10, true, false, struct4h.longReason)
      : makeParamResult(null, 10, true, true, 'Datos insuficientes en velas cerradas de 4h.'),
    short: struct4h
      ? makeParamResult(struct4h.shortPts, 10, true, false, struct4h.shortReason)
      : makeParamResult(null, 10, true, true, 'Datos insuficientes en velas cerradas de 4h.'),
  };

  const a2Row: ParameterScoreRow = {
    id: 'A2',
    family: 'A',
    name: 'Estructura 1 h',
    timeframeLabel: '1h',
    maxWeight: 8,
    observedSummary: struct1h ? `${struct1h.label} (1h)` : 'Sin pivotes suficientes',
    long: struct1h
      ? makeParamResult(struct1h.longPts, 8, true, false, struct1h.longReason)
      : makeParamResult(null, 8, true, true, 'Datos insuficientes en velas cerradas de 1h.'),
    short: struct1h
      ? makeParamResult(struct1h.shortPts, 8, true, false, struct1h.shortReason)
      : makeParamResult(null, 8, true, true, 'Datos insuficientes en velas cerradas de 1h.'),
  };

  // A3: Ubicación vs Soportes & Resistencias (pivotes 1h)
  const vp7d = calculateSevenDayVolumeProfile(candles1h);
  const supportLevels = pivots1h
    .filter((p) => p.type === 'L' && p.price < spot)
    .map((p) => p.price);
  const resistLevels = pivots1h
    .filter((p) => p.type === 'H' && p.price > spot)
    .map((p) => p.price);
  if (vp7d) {
    if (vp7d.val < spot) supportLevels.push(vp7d.val);
    if (vp7d.poc < spot) supportLevels.push(vp7d.poc);
    if (vp7d.vah > spot) resistLevels.push(vp7d.vah);
    if (vp7d.poc > spot) resistLevels.push(vp7d.poc);
  }
  const nearestSup =
    supportLevels.length > 0 ? Math.max(...supportLevels) : spot - atr1h * 2.2;
  const nearestRes =
    resistLevels.length > 0 ? Math.min(...resistLevels) : spot + atr1h * 2.2;

  function scoreA3(dir: 'LONG' | 'SHORT'): DirectionParamResult {
    if (candles1h.length < 20 || atr1h <= 0 || spot <= 0) {
      return makeParamResult(null, 8, true, true, 'Sin ATR/pivotes suficientes para ubicación.');
    }
    const obstacleDistAtr =
      dir === 'LONG' ? (nearestRes - spot) / atr1h : (spot - nearestSup) / atr1h;

    // Spec priority: evaluate facing obstacle first (<= 0.25 ATR => 0; <= 1 ATR => 25)
    if (obstacleDistAtr <= 0.25) {
      return makeParamResult(
        0,
        8,
        true,
        false,
        `Obstáculo a ${obstacleDistAtr.toFixed(2)} ATR (≤ 0.25 ATR): entrada directa contra ${
          dir === 'LONG' ? 'resistencia' : 'soporte'
        }.`
      );
    }
    if (obstacleDistAtr <= 1.0) {
      return makeParamResult(
        25,
        8,
        true,
        false,
        `Obstáculo cercano a ${obstacleDistAtr.toFixed(2)} ATR (0.25–1.0 ATR): recorrido limitado.`
      );
    }

    // Check recent 1H retest or rejection at favorable S/R
    const last = candles1h[i1];
    const prev = candles1h[i1 - 1];
    const supBand = atr1h * 0.35;
    if (dir === 'LONG') {
      const touchedSup =
        Math.abs(last.l - nearestSup) <= supBand || Math.abs(prev.l - nearestSup) <= supBand;
      const retestHeld = touchedSup && last.c > nearestSup && prev.c > nearestSup;
      const wickReject =
        Math.abs(last.l - nearestSup) <= supBand * 1.3 &&
        last.c > last.o &&
        last.c - last.l > (last.h - last.l) * 0.55;
      if (retestHeld) {
        return makeParamResult(
          100,
          8,
          true,
          false,
          `Retesteo confirmado sobre soporte ($${nearestSup.toFixed(1)}) con ${obstacleDistAtr.toFixed(1)} ATR libres.`
        );
      }
      if (wickReject) {
        return makeParamResult(
          75,
          8,
          true,
          false,
          `Rechazo alcista confirmado desde zona de soporte ($${nearestSup.toFixed(1)}).`
        );
      }
      return makeParamResult(
        50,
        8,
        true,
        false,
        `Zona intermedia (${obstacleDistAtr.toFixed(1)} ATR hasta resistencia en $${nearestRes.toFixed(1)}).`
      );
    } else {
      const touchedRes =
        Math.abs(last.h - nearestRes) <= supBand || Math.abs(prev.h - nearestRes) <= supBand;
      const retestHeld = touchedRes && last.c < nearestRes && prev.c < nearestRes;
      const wickReject =
        Math.abs(last.h - nearestRes) <= supBand * 1.3 &&
        last.c < last.o &&
        last.h - last.c > (last.h - last.l) * 0.55;
      if (retestHeld) {
        return makeParamResult(
          100,
          8,
          true,
          false,
          `Retesteo confirmado bajo resistencia ($${nearestRes.toFixed(1)}) con ${obstacleDistAtr.toFixed(1)} ATR libres.`
        );
      }
      if (wickReject) {
        return makeParamResult(
          75,
          8,
          true,
          false,
          `Rechazo bajista confirmado desde resistencia ($${nearestRes.toFixed(1)}).`
        );
      }
      return makeParamResult(
        50,
        8,
        true,
        false,
        `Zona intermedia (${obstacleDistAtr.toFixed(1)} ATR hasta soporte en $${nearestSup.toFixed(1)}).`
      );
    }
  }

  const a3Row: ParameterScoreRow = {
    id: 'A3',
    family: 'A',
    name: 'Ubicación (S/R)',
    timeframeLabel: '1h',
    maxWeight: 8,
    observedSummary: `Sop $${nearestSup.toFixed(0)} · Res $${nearestRes.toFixed(0)}`,
    long: scoreA3('LONG'),
    short: scoreA3('SHORT'),
  };

  // A4: Contexto BTC & Fuerza Relativa (Desactivado cuando se analiza BTC)
  let btcContextLabel = struct4h ? struct4h.label : 'Sin datos';
  let ethRelPerf4hPct: number | null = null;
  let a4Long: DirectionParamResult;
  let a4Short: DirectionParamResult;

  if (asset === 'BTC') {
    excludedNotes.push('A4 (Contexto BTC) desactivado por diseño al analizar BTC; peso renormalizado.');
    a4Long = makeParamResult(null, 4, false, false, 'N/A · Desactivado al analizar BTC (peso renormalizado).');
    a4Short = makeParamResult(null, 4, false, false, 'N/A · Desactivado al analizar BTC (peso renormalizado).');
  } else {
    const btcStruct = evaluateSwingStructure(btcCandles4h, 'BTC 4h');
    btcContextLabel = btcStruct ? btcStruct.label : 'Sin datos';
    if (!btcStruct || btcCandles4h.length < 7 || candles4h.length < 7) {
      a4Long = makeParamResult(null, 4, true, true, 'Falta histórico 4h de BTC o del activo.');
      a4Short = makeParamResult(null, 4, true, true, 'Falta histórico 4h de BTC o del activo.');
    } else {
      const assetRet =
        ((candles4h[candles4h.length - 1].c - candles4h[candles4h.length - 7].c) /
          candles4h[candles4h.length - 7].c) *
        100;
      const btcRet =
        ((btcCandles4h[btcCandles4h.length - 1].c - btcCandles4h[btcCandles4h.length - 7].c) /
          btcCandles4h[btcCandles4h.length - 7].c) *
        100;
      ethRelPerf4hPct = assetRet - btcRet;

      const scoreA4Dir = (dir: 'LONG' | 'SHORT'): DirectionParamResult => {
        const btcState =
          btcStruct.label === 'Rango'
            ? 'neutral'
            : (dir === 'LONG' && btcStruct.label === 'Alcista') ||
              (dir === 'SHORT' && btcStruct.label === 'Bajista')
            ? 'fav'
            : 'contra';

        const rsState =
          dir === 'LONG'
            ? ethRelPerf4hPct! > 0.5
              ? 'fav'
              : ethRelPerf4hPct! < -0.5
              ? 'contra'
              : 'neutral'
            : ethRelPerf4hPct! < -0.5
            ? 'fav'
            : ethRelPerf4hPct! > 0.5
            ? 'contra'
            : 'neutral';

        let pts: ParameterPoints = 50;
        if (btcState === 'fav' && rsState === 'fav') pts = 100;
        else if ((btcState === 'fav' && rsState === 'neutral') || (btcState === 'neutral' && rsState === 'fav'))
          pts = 75;
        else if (btcState === 'neutral' && rsState === 'neutral') pts = 50;
        else if (btcState === 'contra' && rsState === 'contra') pts = 0;
        else pts = 25; // conflicto o uno contrario + otro neutral

        return makeParamResult(
          pts,
          4,
          true,
          false,
          `BTC 4h ${btcStruct.label} (${btcState}), fuerza relativa 6v ${ethRelPerf4hPct! >= 0 ? '+' : ''}${ethRelPerf4hPct!.toFixed(2)} pp (${rsState}).`
        );
      };

      a4Long = scoreA4Dir('LONG');
      a4Short = scoreA4Dir('SHORT');
    }
  }

  const a4Row: ParameterScoreRow = {
    id: 'A4',
    family: 'A',
    name: 'Contexto BTC / Fuerza Rel.',
    timeframeLabel: '4h',
    maxWeight: 4,
    observedSummary:
      asset === 'BTC'
        ? 'N/A (Activo = BTC)'
        : `BTC: ${btcContextLabel}${ethRelPerf4hPct !== null ? ` · Δ ${ethRelPerf4hPct >= 0 ? '+' : ''}${ethRelPerf4hPct.toFixed(2)} pp` : ''}`,
    long: a4Long,
    short: a4Short,
  };

  // -------------------------------------------------------------------------
  // FAMILY B: Tendencia y Momentum (20 pts, 1h)
  // -------------------------------------------------------------------------
  const e20 = i1 >= 4 ? ema20_1h[i1] : null;
  const e50 = i1 >= 4 ? ema50_1h[i1] : null;
  const e200 = i1 >= 4 ? ema200_1h[i1] : null;
  const e20Prev3 = i1 >= 4 ? ema20_1h[i1 - 3] : null;
  const e50Prev3 = i1 >= 4 ? ema50_1h[i1 - 3] : null;
  const e200Prev3 = i1 >= 4 ? ema200_1h[i1 - 3] : null;
  const e20Prev1 = i1 >= 4 ? ema20_1h[i1 - 1] : null;
  const e20Prev4 = i1 >= 4 ? ema20_1h[i1 - 4] : null;

  function scoreB1(dir: 'LONG' | 'SHORT'): DirectionParamResult {
    if (
      e20 === null ||
      e50 === null ||
      e200 === null ||
      e20Prev3 === null ||
      e50Prev3 === null ||
      e200Prev3 === null ||
      e20Prev1 === null ||
      e20Prev4 === null
    ) {
      return makeParamResult(null, 6, true, true, 'Se requieren ≥ 204 velas cerradas 1h para EMA 200.');
    }
    const c = closes1h[i1];
    const sl20 = e20 - e20Prev3;
    const sl50 = e50 - e50Prev3;
    const sl200 = e200 - e200Prev3;
    const prevSl20 = e20Prev1 - e20Prev4;

    if (dir === 'LONG') {
      if (c > e20 && e20 > e50 && e50 > e200 && sl20 > 0 && sl50 > 0 && sl200 > 0) {
        return makeParamResult(100, 6, true, false, 'Cierre > EMA20 > EMA50 > EMA200 con las 3 pendientes positivas.');
      }
      if (c > e20 && e20 > e50 && sl20 > 0 && sl50 > 0) {
        return makeParamResult(75, 6, true, false, 'EMA20/50 y pendientes alcistas sin alineación completa de EMA200.');
      }
      const fullContrary = c < e20 && e20 < e50 && e50 < e200 && sl20 < 0 && sl50 < 0 && sl200 < 0;
      if (fullContrary) {
        if (sl20 > prevSl20) {
          return makeParamResult(25, 6, true, false, 'Orden bajista completo pero pendiente EMA20 mejorando.');
        }
        return makeParamResult(0, 6, true, false, 'Orden y pendientes EMA completamente bajistas.');
      }
      return makeParamResult(50, 6, true, false, 'Medias móviles mezcladas sin alineación clara.');
    } else {
      if (c < e20 && e20 < e50 && e50 < e200 && sl20 < 0 && sl50 < 0 && sl200 < 0) {
        return makeParamResult(100, 6, true, false, 'Cierre < EMA20 < EMA50 < EMA200 con las 3 pendientes negativas.');
      }
      if (c < e20 && e20 < e50 && sl20 < 0 && sl50 < 0) {
        return makeParamResult(75, 6, true, false, 'EMA20/50 y pendientes bajistas sin alineación completa de EMA200.');
      }
      const fullContrary = c > e20 && e20 > e50 && e50 > e200 && sl20 > 0 && sl50 > 0 && sl200 > 0;
      if (fullContrary) {
        if (sl20 < prevSl20) {
          return makeParamResult(25, 6, true, false, 'Orden alcista completo pero pendiente EMA20 desacelerando.');
        }
        return makeParamResult(0, 6, true, false, 'Orden y pendientes EMA completamente alcistas.');
      }
      return makeParamResult(50, 6, true, false, 'Medias móviles mezcladas sin alineación bajista.');
    }
  }

  const b1Row: ParameterScoreRow = {
    id: 'B1',
    family: 'B',
    name: 'Medias EMA 20/50/200',
    timeframeLabel: '1h',
    maxWeight: 6,
    observedSummary:
      e20 !== null && e50 !== null && e200 !== null
        ? `20:$${e20.toFixed(0)} · 50:$${e50.toFixed(0)} · 200:$${e200.toFixed(0)}`
        : 'EMA200 N/D',
    long: scoreB1('LONG'),
    short: scoreB1('SHORT'),
  };

  // B2: ADX & DMI 14 (1h)
  const adxVal = i1 >= 0 ? adxDmi1h.adx[i1] : null;
  const pdiVal = i1 >= 0 ? adxDmi1h.plusDI[i1] : null;
  const mdiVal = i1 >= 0 ? adxDmi1h.minusDI[i1] : null;

  function scoreB2(dir: 'LONG' | 'SHORT'): DirectionParamResult {
    if (adxVal === null || pdiVal === null || mdiVal === null) {
      return makeParamResult(null, 4, true, true, 'Velas insuficientes para ADX/DMI(14).');
    }
    if (Math.abs(pdiVal - mdiVal) < 1e-6 || adxVal < 20) {
      return makeParamResult(
        50,
        4,
        true,
        false,
        `ADX ${adxVal.toFixed(1)} (< 20) o DMI empatado (+DI ${pdiVal.toFixed(1)} / -DI ${mdiVal.toFixed(1)}).`
      );
    }
    const favorableDI = dir === 'LONG' ? pdiVal > mdiVal : mdiVal > pdiVal;
    if (favorableDI && adxVal >= 25) {
      return makeParamResult(100, 4, true, false, `ADX ${adxVal.toFixed(1)} ≥ 25 con DMI favorable.`);
    }
    if (favorableDI && adxVal >= 20) {
      return makeParamResult(75, 4, true, false, `DMI favorable con ADX ${adxVal.toFixed(1)} en transición (20–25).`);
    }
    if (!favorableDI && adxVal >= 25) {
      return makeParamResult(0, 4, true, false, `ADX ${adxVal.toFixed(1)} ≥ 25 con DMI contrario.`);
    }
    return makeParamResult(25, 4, true, false, `DMI contrario con ADX ${adxVal.toFixed(1)} moderado (20–25).`);
  }

  const b2Row: ParameterScoreRow = {
    id: 'B2',
    family: 'B',
    name: 'ADX y DMI (14)',
    timeframeLabel: '1h',
    maxWeight: 4,
    observedSummary:
      adxVal !== null && pdiVal !== null && mdiVal !== null
        ? `ADX ${adxVal.toFixed(1)} · +DI ${pdiVal.toFixed(1)} / -DI ${mdiVal.toFixed(1)}`
        : 'N/D',
    long: scoreB2('LONG'),
    short: scoreB2('SHORT'),
  };

  // B3: RSI 14 (1h)
  const rsiNow = i1 >= 1 ? rsi1h[i1] : null;
  const rsiPrev = i1 >= 1 ? rsi1h[i1 - 1] : null;

  function scoreB3(dir: 'LONG' | 'SHORT'): DirectionParamResult {
    if (rsiNow === null || rsiPrev === null) {
      return makeParamResult(null, 5, true, true, 'Velas insuficientes para RSI(14).');
    }
    const rising = rsiNow > rsiPrev;
    const falling = rsiNow < rsiPrev;
    if (dir === 'LONG') {
      if (rsiNow >= 50 && rsiNow <= 65 && rising) {
        return makeParamResult(100, 5, true, false, `RSI ${rsiNow.toFixed(1)} en [50,65] y subiendo (prev ${rsiPrev.toFixed(1)}).`);
      }
      if (rsiNow >= 50 && rsiNow <= 65) {
        return makeParamResult(75, 5, true, false, `RSI ${rsiNow.toFixed(1)} en [50,65] sin expansión alcista.`);
      }
      if (rsiNow < 35 && falling) {
        return makeParamResult(0, 5, true, false, `RSI ${rsiNow.toFixed(1)} < 35 y cayendo.`);
      }
      if (rsiNow < 45 && falling) {
        return makeParamResult(25, 5, true, false, `RSI ${rsiNow.toFixed(1)} < 45 y cayendo.`);
      }
      return makeParamResult(50, 5, true, false, `RSI ${rsiNow.toFixed(1)} en zona neutral/extendida.`);
    } else {
      if (rsiNow >= 35 && rsiNow <= 50 && falling) {
        return makeParamResult(100, 5, true, false, `RSI ${rsiNow.toFixed(1)} en [35,50] y bajando (prev ${rsiPrev.toFixed(1)}).`);
      }
      if (rsiNow >= 35 && rsiNow <= 50) {
        return makeParamResult(75, 5, true, false, `RSI ${rsiNow.toFixed(1)} en [35,50] sin aceleración bajista.`);
      }
      if (rsiNow > 65 && rising) {
        return makeParamResult(0, 5, true, false, `RSI ${rsiNow.toFixed(1)} > 65 y subiendo.`);
      }
      if (rsiNow > 55 && rising) {
        return makeParamResult(25, 5, true, false, `RSI ${rsiNow.toFixed(1)} > 55 y subiendo.`);
      }
      return makeParamResult(50, 5, true, false, `RSI ${rsiNow.toFixed(1)} en zona neutral/extendida.`);
    }
  }

  const b3Row: ParameterScoreRow = {
    id: 'B3',
    family: 'B',
    name: 'RSI (14)',
    timeframeLabel: '1h',
    maxWeight: 5,
    observedSummary:
      rsiNow !== null && rsiPrev !== null
        ? `RSI ${rsiNow.toFixed(1)} ${rsiNow > rsiPrev ? '↑' : rsiNow < rsiPrev ? '↓' : '→'} (${rsiPrev.toFixed(1)})`
        : 'N/D',
    long: scoreB3('LONG'),
    short: scoreB3('SHORT'),
  };

  // B4: MACD 12/26/9 (1h)
  const macdNow = i1 >= 1 ? macd1h.macd[i1] : null;
  const sigNow = i1 >= 1 ? macd1h.signal[i1] : null;
  const histNow = i1 >= 1 ? macd1h.hist[i1] : null;
  const histPrev = i1 >= 1 ? macd1h.hist[i1 - 1] : null;

  function scoreB4(dir: 'LONG' | 'SHORT'): DirectionParamResult {
    if (macdNow === null || sigNow === null || histNow === null || histPrev === null) {
      return makeParamResult(null, 5, true, true, 'Velas insuficientes para MACD(12,26,9).');
    }
    if (Math.abs(histNow) < 1e-8) {
      return makeParamResult(50, 5, true, false, 'Histograma MACD en cero.');
    }
    if (dir === 'LONG') {
      if (macdNow > sigNow && histNow > 0) {
        if (histNow > histPrev) {
          return makeParamResult(100, 5, true, false, 'MACD > señal e histograma positivo expandiendo.');
        }
        return makeParamResult(75, 5, true, false, 'MACD > señal e histograma positivo sin expansión.');
      }
      if (macdNow < sigNow && histNow < 0) {
        if (histNow >= histPrev) {
          return makeParamResult(25, 5, true, false, 'MACD bajo señal pero histograma mejorando/estable.');
        }
        return makeParamResult(0, 5, true, false, 'MACD bajo señal con histograma negativo empeorando.');
      }
      return makeParamResult(50, 5, true, false, 'Señales de MACD y señal mezcladas.');
    } else {
      if (macdNow < sigNow && histNow < 0) {
        if (histNow < histPrev) {
          return makeParamResult(100, 5, true, false, 'MACD < señal e histograma negativo expandiendo.');
        }
        return makeParamResult(75, 5, true, false, 'MACD < señal e histograma negativo sin expansión.');
      }
      if (macdNow > sigNow && histNow > 0) {
        if (histNow <= histPrev) {
          return makeParamResult(25, 5, true, false, 'MACD sobre señal pero histograma desacelerando.');
        }
        return makeParamResult(0, 5, true, false, 'MACD sobre señal con histograma positivo creciendo.');
      }
      return makeParamResult(50, 5, true, false, 'Señales de MACD y señal mezcladas.');
    }
  }

  const b4Row: ParameterScoreRow = {
    id: 'B4',
    family: 'B',
    name: 'MACD (12/26/9)',
    timeframeLabel: '1h',
    maxWeight: 5,
    observedSummary:
      histNow !== null && histPrev !== null
        ? `Hist ${histNow >= 0 ? '+' : ''}${histNow.toFixed(2)} ${histNow > histPrev ? '↑' : '↓'}`
        : 'N/D',
    long: scoreB4('LONG'),
    short: scoreB4('SHORT'),
  };

  // -------------------------------------------------------------------------
  // FAMILY C: Participación y Volumen (15 pts)
  // -------------------------------------------------------------------------
  let relVol15: number | null = null;
  if (candles15m.length >= 21) {
    const last15 = candles15m[i15];
    let avg20 = 0;
    for (let k = i15 - 20; k < i15; k++) {
      avg20 += candles15m[k].v;
    }
    avg20 /= 20;
    if (avg20 > 0) {
      relVol15 = last15.v / avg20;
    }
  }

  function scoreC1(dir: 'LONG' | 'SHORT'): DirectionParamResult {
    if (relVol15 === null || candles15m.length < 21) {
      return makeParamResult(null, 7, true, true, 'Falta volumen de 20 velas previas en 15m.');
    }
    const last15 = candles15m[i15];
    const priceFavorable = dir === 'LONG' ? last15.c > last15.o : last15.c < last15.o;
    if (!priceFavorable) {
      return makeParamResult(
        0,
        7,
        true,
        false,
        `Última vela cerrada 15m contraria (vol rel ${relVol15.toFixed(2)}x).`
      );
    }
    let pts: ParameterPoints = 25;
    if (relVol15 >= 1.5) pts = 100;
    else if (relVol15 >= 1.2) pts = 75;
    else if (relVol15 >= 0.8) pts = 50;
    return makeParamResult(
      pts,
      7,
      true,
      false,
      `Vela 15m favorable con volumen relativo ${relVol15.toFixed(2)}x vs media 20.`
    );
  }

  const c1Row: ParameterScoreRow = {
    id: 'C1',
    family: 'C',
    name: 'Volumen relativo 15m',
    timeframeLabel: '15m',
    maxWeight: 7,
    observedSummary:
      relVol15 !== null && i15 >= 0
        ? `${relVol15.toFixed(2)}x (${candles15m[i15].c >= candles15m[i15].o ? 'Verde' : 'Roja'})`
        : 'N/D',
    long: scoreC1('LONG'),
    short: scoreC1('SHORT'),
  };

  // C2: VWAP anclado al último pivote confirmado de 1h que origina el impulso
  const anchorPivot =
    pivots1h.length > 0 ? pivots1h[pivots1h.length - 1] : null;
  const anchoredVwapSeries =
    anchorPivot && candles1h.length > 5
      ? calculateAnchoredVWAP(candles1h, anchorPivot.index)
      : null;
  const avwapNow = anchoredVwapSeries && i1 >= 1 ? anchoredVwapSeries[i1] : null;

  function scoreLevelAcceptance(
    dir: 'LONG' | 'SHORT',
    level: number | null,
    levelName: string,
    weight: number,
    seriesRef?: number[] | null
  ): DirectionParamResult {
    if (level === null || i1 < 2 || atr1h <= 0) {
      return makeParamResult(null, weight, true, true, `${levelName} no disponible.`);
    }
    const c0 = candles1h[i1];
    const c1 = candles1h[i1 - 1];
    const ref0 = seriesRef ? seriesRef[i1] : level;
    const ref1 = seriesRef ? seriesRef[i1 - 1] : level;
    const band = atr1h * 0.1;

    const favClose0 = dir === 'LONG' ? c0.c > ref0 : c0.c < ref0;
    const favClose1 = dir === 'LONG' ? c1.c > ref1 : c1.c < ref1;
    const contraAccept =
      dir === 'LONG' ? c0.c < ref0 - band && c1.c < ref1 - band : c0.c > ref0 + band && c1.c > ref1 + band;
    const retestFav =
      favClose0 &&
      favClose1 &&
      (dir === 'LONG'
        ? c0.l <= ref0 + band * 2.5 || c1.l <= ref1 + band * 2.5
        : c0.h >= ref0 - band * 2.5 || c1.h >= ref1 - band * 2.5);
    const atLevel = Math.abs(c0.c - ref0) <= band;
    const failedAttempt =
      !favClose0 && (dir === 'LONG' ? c0.h > ref0 && c0.c <= ref0 : c0.l < ref0 && c0.c >= ref0);

    // Spec v1.1 §6 priority: retesteo favorable, aceptación contraria, cierre favorable, en el nivel, intento fallido
    if (retestFav) {
      return makeParamResult(100, weight, true, false, `Retesteo confirmado sobre ${levelName} ($${ref0.toFixed(1)}).`);
    }
    if (contraAccept) {
      return makeParamResult(0, weight, true, false, `Aceptación contraria (2 cierres) frente a ${levelName}.`);
    }
    if (favClose0) {
      return makeParamResult(75, weight, true, false, `Cierre 1h favorable respecto a ${levelName} ($${ref0.toFixed(1)}).`);
    }
    if (atLevel) {
      return makeParamResult(50, weight, true, false, `Precio sobre ${levelName} (≤ 0.1 ATR 1h).`);
    }
    if (failedAttempt) {
      return makeParamResult(25, weight, true, false, `Intento fallido de recuperación en ${levelName}.`);
    }
    return makeParamResult(50, weight, true, false, `Estado neutral frente a ${levelName}.`);
  }

  const c2Row: ParameterScoreRow = {
    id: 'C2',
    family: 'C',
    name: 'VWAP anclado (pivote 1h)',
    timeframeLabel: '1h',
    maxWeight: 4,
    observedSummary:
      avwapNow !== null && anchorPivot
        ? `$${avwapNow.toFixed(1)} (desde pivote ${anchorPivot.type})`
        : 'N/D',
    long: scoreLevelAcceptance('LONG', avwapNow, 'VWAP anclado', 4, anchoredVwapSeries),
    short: scoreLevelAcceptance('SHORT', avwapNow, 'VWAP anclado', 4, anchoredVwapSeries),
  };

  // C3: Perfil de volumen fijo 7 días UTC previos (POC/VAH/VAL)
  let selectedVpLevel: number | null = null;
  let selectedVpLabel = 'N/D';
  if (vp7d && spot > 0) {
    const candidates = [
      { label: 'POC 7d', price: vp7d.poc },
      { label: 'VAH 7d', price: vp7d.vah },
      { label: 'VAL 7d', price: vp7d.val },
    ].sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot));
    selectedVpLevel = candidates[0].price;
    selectedVpLabel = candidates[0].label;
  }

  const c3Row: ParameterScoreRow = {
    id: 'C3',
    family: 'C',
    name: 'Perfil de volumen 7d',
    timeframeLabel: '1h (7d UTC)',
    maxWeight: 4,
    observedSummary: vp7d
      ? `${selectedVpLabel} $${selectedVpLevel!.toFixed(0)} (VA $${vp7d.val.toFixed(0)}–$${vp7d.vah.toFixed(0)})`
      : 'N/D',
    long: scoreLevelAcceptance('LONG', selectedVpLevel, selectedVpLabel, 4),
    short: scoreLevelAcceptance('SHORT', selectedVpLevel, selectedVpLabel, 4),
  };

  // -------------------------------------------------------------------------
  // FAMILY D: Configuración y Volatilidad (15 pts)
  // -------------------------------------------------------------------------
  // Determine pre-fixed validation breakout/pullback levels on 15m/1h
  const pivots15 = findConfirmedTwoBarPivots(candles15m);
  const recentHigh15 =
    pivots15.filter((p) => p.type === 'H').slice(-1)[0]?.price ??
    struct1h?.lastPivotHigh ??
    nearestRes;
  const recentLow15 =
    pivots15.filter((p) => p.type === 'L').slice(-1)[0]?.price ??
    struct1h?.lastPivotLow ??
    nearestSup;

  const evalTriggerD1 = (
    dir: 'LONG' | 'SHORT'
  ): { param: DirectionParamResult; validationLevel: number } => {
    if (candles15m.length < 15 || atr15 <= 0) {
      return {
        param: makeParamResult(null, 8, true, true, 'Velas 15m insuficientes para disparador.'),
        validationLevel: spot,
      };
    }
    const band = atr15 * 0.1;
    const recent = candles15m.slice(-5); // up to 4 bars window + current closed bar
    const last15 = recent[recent.length - 1];

    if (dir === 'LONG') {
      // Validation level: either breakout level (recentHigh15 if near/broken) or pullback support (recentLow15 / ema20_1h)
      const valLevel =
        last15.c > recentHigh15 - atr15 * 0.8 ? recentHigh15 : Math.max(recentLow15, e20 ?? recentLow15);

      const breakoutBarIdx = recent.findIndex((b) => b.c > valLevel + band);
      if (breakoutBarIdx !== -1 && breakoutBarIdx < recent.length - 1) {
        const afterBreak = recent.slice(breakoutBarIdx + 1);
        const retestedAndHeld = afterBreak.some(
          (b) => b.l <= valLevel + band && b.c > valLevel
        );
        if (retestedAndHeld && last15.c > valLevel) {
          return {
            param: makeParamResult(
              100,
              8,
              true,
              false,
              `Ruptura/retroceso 15m + retesteo confirmado en banda ±0.1 ATR ($${valLevel.toFixed(1)}).`
            ),
            validationLevel: valLevel,
          };
        }
      }
      if (last15.c > valLevel + band) {
        return {
          param: makeParamResult(
            75,
            8,
            true,
            false,
            `Cierre 15m favorable sobre nivel de validación ($${valLevel.toFixed(1)}) sin retesteo.`
          ),
          validationLevel: valLevel,
        };
      }
      if (last15.c > valLevel - band * 2 && last15.c > last15.o) {
        return {
          param: makeParamResult(
            50,
            8,
            true,
            false,
            `Patrón alcista 15m en desarrollo junto a $${valLevel.toFixed(1)} (sin cierre > +0.1 ATR).`
          ),
          validationLevel: valLevel,
        };
      }
      if (last15.l <= valLevel + band && last15.c > last15.l + (last15.h - last15.l) * 0.5) {
        return {
          param: makeParamResult(25, 8, true, false, `Mecha de rechazo inicial 15m, sin confirmación de cierre.`),
          validationLevel: valLevel,
        };
      }
      return {
        param: makeParamResult(0, 8, true, false, `Sin disparador 15m confirmado sobre $${valLevel.toFixed(1)}.`),
        validationLevel: valLevel,
      };
    } else {
      const valLevel =
        last15.c < recentLow15 + atr15 * 0.8 ? recentLow15 : Math.min(recentHigh15, e20 ?? recentHigh15);

      const breakoutBarIdx = recent.findIndex((b) => b.c < valLevel - band);
      if (breakoutBarIdx !== -1 && breakoutBarIdx < recent.length - 1) {
        const afterBreak = recent.slice(breakoutBarIdx + 1);
        const retestedAndHeld = afterBreak.some(
          (b) => b.h >= valLevel - band && b.c < valLevel
        );
        if (retestedAndHeld && last15.c < valLevel) {
          return {
            param: makeParamResult(
              100,
              8,
              true,
              false,
              `Ruptura/rebote 15m + retesteo bajista confirmado en $${valLevel.toFixed(1)}.`
            ),
            validationLevel: valLevel,
          };
        }
      }
      if (last15.c < valLevel - band) {
        return {
          param: makeParamResult(
            75,
            8,
            true,
            false,
            `Cierre 15m bajista confirmado bajo $${valLevel.toFixed(1)} sin retesteo.`
          ),
          validationLevel: valLevel,
        };
      }
      if (last15.c < valLevel + band * 2 && last15.c < last15.o) {
        return {
          param: makeParamResult(
            50,
            8,
            true,
            false,
            `Patrón bajista 15m incompleto junto a $${valLevel.toFixed(1)}.`
          ),
          validationLevel: valLevel,
        };
      }
      if (last15.h >= valLevel - band && last15.c < last15.h - (last15.h - last15.l) * 0.5) {
        return {
          param: makeParamResult(25, 8, true, false, `Rechazo inicial bajista 15m, aún sin cierre válido.`),
          validationLevel: valLevel,
        };
      }
      return {
        param: makeParamResult(0, 8, true, false, `Sin disparador bajista 15m confirmado bajo $${valLevel.toFixed(1)}.`),
        validationLevel: valLevel,
      };
    }
  };

  const d1LongRes = evalTriggerD1('LONG');
  const d1ShortRes = evalTriggerD1('SHORT');

  const d1Row: ParameterScoreRow = {
    id: 'D1',
    family: 'D',
    name: 'Disparador 15 min',
    timeframeLabel: '15m',
    maxWeight: 8,
    observedSummary: `Val L $${d1LongRes.validationLevel.toFixed(0)} · S $${d1ShortRes.validationLevel.toFixed(0)}`,
    long: d1LongRes.param,
    short: d1ShortRes.param,
  };

  // D2: Percentil de ATR porcentual en 1h vs 180 velas previas
  let atrPercentile: number | null = null;
  let atrPctNow: number | null = null;
  const validAtrIndices = atr1hArr
    .map((v, idx) => ({ v, idx }))
    .filter((x): x is { v: number; idx: number } => x.v !== null && candles1h[x.idx].c > 0);

  if (validAtrIndices.length >= 181) {
    const cur = validAtrIndices[validAtrIndices.length - 1];
    atrPctNow = (100 * cur.v) / candles1h[cur.idx].c;
    const prev180 = validAtrIndices.slice(validAtrIndices.length - 181, validAtrIndices.length - 1);
    const leCount = prev180.filter(
      (item) => (100 * item.v) / candles1h[item.idx].c <= atrPctNow!
    ).length;
    atrPercentile = (100 * leCount) / 180;
  }

  function scoreD2(): DirectionParamResult {
    if (atrPercentile === null || atrPctNow === null) {
      return makeParamResult(null, 4, true, true, 'Se requieren 180 velas previas con ATR(14) en 1h.');
    }
    let pts: ParameterPoints = 0;
    if (atrPercentile >= 30 && atrPercentile <= 80) pts = 100;
    else if ((atrPercentile >= 20 && atrPercentile < 30) || (atrPercentile > 80 && atrPercentile <= 90))
      pts = 75;
    else if (atrPercentile >= 10 && atrPercentile < 20) pts = 50;
    else if (atrPercentile < 10) pts = 25;
    else pts = 0;

    return makeParamResult(
      pts,
      4,
      true,
      false,
      `ATR% actual ${atrPctNow.toFixed(2)}% = Percentil ${atrPercentile.toFixed(0)} (180 velas 1h).`
    );
  }

  const d2Res = scoreD2();
  const d2Row: ParameterScoreRow = {
    id: 'D2',
    family: 'D',
    name: 'Percentil volatilidad ATR%',
    timeframeLabel: '1h (180v)',
    maxWeight: 4,
    observedSummary:
      atrPercentile !== null && atrPctNow !== null
        ? `P${atrPercentile.toFixed(0)} (${atrPctNow.toFixed(2)}%)`
        : 'N/D (<180v)',
    long: d2Res,
    short: d2Res,
  };

  // D3: Extensión (Distancia entrada al nivel de validación / ATR 15m)
  function scoreD3(entry: number, valLevel: number): DirectionParamResult {
    if (atr15 <= 0 || entry <= 0) {
      return makeParamResult(null, 3, true, true, 'ATR 15m no disponible.');
    }
    const ratio = Math.abs(entry - valLevel) / atr15;
    let pts: ParameterPoints = 0;
    if (ratio <= 0.5) pts = 100;
    else if (ratio <= 1.0) pts = 75;
    else if (ratio <= 1.5) pts = 50;
    else if (ratio <= 2.0) pts = 25;
    return makeParamResult(
      pts,
      3,
      true,
      false,
      `Distancia al nivel de validación = ${ratio.toFixed(2)} ATR(15m).`
    );
  }

  const entryLong = orderbook?.bestAsk && orderbook.bestAsk > 0 ? orderbook.bestAsk : spot;
  const entryShort = orderbook?.bestBid && orderbook.bestBid > 0 ? orderbook.bestBid : spot;

  const d3Row: ParameterScoreRow = {
    id: 'D3',
    family: 'D',
    name: 'Extensión de entrada',
    timeframeLabel: '15m',
    maxWeight: 3,
    observedSummary:
      atr15 > 0
        ? `L ${(Math.abs(entryLong - d1LongRes.validationLevel) / atr15).toFixed(2)} ATR · S ${(Math.abs(entryShort - d1ShortRes.validationLevel) / atr15).toFixed(2)} ATR`
        : 'N/D',
    long: scoreD3(entryLong, d1LongRes.validationLevel),
    short: scoreD3(entryShort, d1ShortRes.validationLevel),
  };

  // -------------------------------------------------------------------------
  // FAMILY E: Derivados (5 pts, desactivado en modo Spot)
  // -------------------------------------------------------------------------
  const derivApplicable = config.mode === 'perpetual';
  if (!derivApplicable) {
    excludedNotes.push('E1/E2 (Derivados) desactivados en modo Spot; peso renormalizado.');
  }

  let oiWindow: OpenInterestWindow | null = null;
  let e1Long: DirectionParamResult;
  let e1Short: DirectionParamResult;

  if (!derivApplicable) {
    e1Long = makeParamResult(null, 3, false, false, 'N/A · Modo Spot seleccionado.');
    e1Short = makeParamResult(null, 3, false, false, 'N/A · Modo Spot seleccionado.');
  } else if (dataset.oiSeries1h.length >= 5 && candles1h.length >= 5) {
    // Match OI timestamps against closed 1H candle closes to convert USD OI -> Coin units
    const candlePriceMap = new Map<number, number>();
    for (const c of candles1h) candlePriceMap.set(c.t, c.c);
    const closedOiPoints = dataset.oiSeries1h
      .map((pt) => {
        const px = candlePriceMap.get(pt.ts);
        return px && px > 0 ? { ts: pt.ts, oiBase: pt.oiUsd / px, oiUsd: pt.oiUsd, close: px } : null;
      })
      .filter((x): x is { ts: number; oiBase: number; oiUsd: number; close: number } => x !== null);

    if (closedOiPoints.length >= 5) {
      const curOi = closedOiPoints[closedOiPoints.length - 1];
      const prevOi = closedOiPoints[closedOiPoints.length - 5];
      const oiChgPct = ((curOi.oiBase - prevOi.oiBase) / prevOi.oiBase) * 100;
      const priceDiff = curOi.close - prevOi.close;
      oiWindow = {
        latestOiBase: curOi.oiBase,
        prev4hOiBase: prevOi.oiBase,
        changePct4h: oiChgPct,
        latestOiUsd: curOi.oiUsd,
        ts: curOi.ts,
      };

      const scoreE1Dir = (dir: 'LONG' | 'SHORT'): DirectionParamResult => {
        const significantMove = Math.abs(priceDiff) >= 0.25 * atr1h;
        const priceFav = dir === 'LONG' ? priceDiff > 0 : priceDiff < 0;
        if (!significantMove || Math.abs(oiChgPct) <= 1.0) {
          return makeParamResult(
            50,
            3,
            true,
            false,
            `Movimiento (${(priceDiff / atr1h).toFixed(2)} ATR) o OI (${oiChgPct >= 0 ? '+' : ''}${oiChgPct.toFixed(2)}%) neutral.`
          );
        }
        const oiUp = oiChgPct > 1.0;
        if (priceFav && oiUp) {
          return makeParamResult(100, 3, true, false, `Precio favorable y OI en unidades base +${oiChgPct.toFixed(2)}% (>1%).`);
        }
        if (priceFav && !oiUp) {
          return makeParamResult(75, 3, true, false, `Precio favorable con reducción de OI (${oiChgPct.toFixed(2)}%).`);
        }
        if (!priceFav && !oiUp) {
          return makeParamResult(25, 3, true, false, `Precio contrario con cierre de OI (${oiChgPct.toFixed(2)}%).`);
        }
        return makeParamResult(0, 3, true, false, `Precio contrario con OI creciente (+${oiChgPct.toFixed(2)}%).`);
      };

      e1Long = scoreE1Dir('LONG');
      e1Short = scoreE1Dir('SHORT');
    } else {
      e1Long = makeParamResult(null, 3, true, true, 'Sin al menos 5 puntos alineados de OI 1h.');
      e1Short = makeParamResult(null, 3, true, true, 'Sin al menos 5 puntos alineados de OI 1h.');
    }
  } else {
    e1Long = makeParamResult(null, 3, true, true, 'Serie histórica de Open Interest no disponible.');
    e1Short = makeParamResult(null, 3, true, true, 'Serie histórica de Open Interest no disponible.');
  }

  const e1Row: ParameterScoreRow = {
    id: 'E1',
    family: 'E',
    name: 'Precio y Open Interest',
    timeframeLabel: '4×1h',
    maxWeight: 3,
    observedSummary: !derivApplicable
      ? 'N/A (Spot)'
      : oiWindow
      ? `OI base ${oiWindow.changePct4h >= 0 ? '+' : ''}${oiWindow.changePct4h.toFixed(2)}%`
      : 'N/D',
    long: e1Long,
    short: e1Short,
  };

  // E2: Funding 8h vs Percentil 90 días
  let fundingStats90d: FundingStats90D | null = null;
  let e2Long: DirectionParamResult;
  let e2Short: DirectionParamResult;

  if (!derivApplicable) {
    e2Long = makeParamResult(null, 2, false, false, 'N/A · Modo Spot seleccionado.');
    e2Short = makeParamResult(null, 2, false, false, 'N/A · Modo Spot seleccionado.');
  } else if (dataset.fundingCurrent8h !== null && dataset.fundingHistory8h.length >= 60) {
    const cur = dataset.fundingCurrent8h;
    const hist = dataset.fundingHistory8h;
    const le = hist.filter((r) => r <= cur).length;
    const pct = (100 * le) / hist.length;
    fundingStats90d = {
      currentRate8h: cur,
      percentile: pct,
      sampleCount: hist.length,
      minRate8h: Math.min(...hist),
      maxRate8h: Math.max(...hist),
    };

    let lPts: ParameterPoints = 75;
    let sPts: ParameterPoints = 75;
    let bandDesc = 'P25–P75';
    if (pct < 10) {
      lPts = 50;
      sPts = 0;
      bandDesc = '< P10 (muy negativo)';
    } else if (pct < 25) {
      lPts = 50;
      sPts = 25;
      bandDesc = 'P10–P25';
    } else if (pct <= 75) {
      lPts = 75;
      sPts = 75;
      bandDesc = 'P25–P75 (equilibrado)';
    } else if (pct <= 90) {
      lPts = 25;
      sPts = 50;
      bandDesc = 'P75–P90';
    } else {
      lPts = 0;
      sPts = 50;
      bandDesc = '> P90 (muy positivo)';
    }
    const fundDesc = `Funding 8h ${(cur * 100).toFixed(4)}% · Percentil ${pct.toFixed(0)} (${bandDesc}).`;
    e2Long = makeParamResult(lPts, 2, true, false, fundDesc);
    e2Short = makeParamResult(sPts, 2, true, false, fundDesc);
  } else {
    e2Long = makeParamResult(null, 2, true, true, 'Sin historial suficiente de funding 90d (8h).');
    e2Short = makeParamResult(null, 2, true, true, 'Sin historial suficiente de funding 90d (8h).');
  }

  const e2Row: ParameterScoreRow = {
    id: 'E2',
    family: 'E',
    name: 'Funding 8h (vs 90d)',
    timeframeLabel: '8h / 90d',
    maxWeight: 2,
    observedSummary: !derivApplicable
      ? 'N/A (Spot)'
      : fundingStats90d
      ? `${(fundingStats90d.currentRate8h * 100).toFixed(4)}% (P${fundingStats90d.percentile.toFixed(0)})`
      : 'N/D',
    long: e2Long,
    short: e2Short,
  };

  // -------------------------------------------------------------------------
  // FAMILY F: Viabilidad y Ejecución (15 pts)
  // -------------------------------------------------------------------------
  const priceDecimals = asset === 'BTC' ? 1 : 2;
  const riskBudgetUsd = Math.max(1, config.capitalUsd * (Math.max(0.05, config.riskPct) / 100));
  const spreadPct = orderbook?.spreadPct ?? 0.02;

  function buildExecutionPlan(dir: 'LONG' | 'SHORT'): TradeExecutionPlan | null {
    if (spot <= 0 || atr15 <= 0 || atr1h <= 0) return null;
    const entry = dir === 'LONG' ? entryLong : entryShort;
    const valLevel = dir === 'LONG' ? d1LongRes.validationLevel : d1ShortRes.validationLevel;

    // Structural stop anchored on confirmed 15m/1h swing pivot with >= 0.25 ATR 15m volatility margin
    let stopRaw: number;
    let invMarginAtr = 0.4;
    if (dir === 'LONG') {
      const candidateLow =
        pivots15.filter((p) => p.type === 'L' && p.price < entry - atr15 * 0.25).slice(-1)[0]
          ?.price ?? nearestSup;
      const minStopDist = Math.max(atr15 * 1.1, atr1h * 0.55);
      stopRaw = Math.min(entry - minStopDist, candidateLow - atr15 * 0.35);
      invMarginAtr = (candidateLow - stopRaw) / atr15;
    } else {
      const candidateHigh =
        pivots15.filter((p) => p.type === 'H' && p.price > entry + atr15 * 0.25).slice(-1)[0]
          ?.price ?? nearestRes;
      const minStopDist = Math.max(atr15 * 1.1, atr1h * 0.55);
      stopRaw = Math.max(entry + minStopDist, candidateHigh + atr15 * 0.35);
      invMarginAtr = (stopRaw - candidateHigh) / atr15;
    }

    const stopLoss =
      dir === 'LONG'
        ? Math.min(entry - atr15 * 0.5, roundToStep(stopRaw, priceDecimals))
        : Math.max(entry + atr15 * 0.5, roundToStep(stopRaw, priceDecimals));

    const stopDist = Math.abs(entry - stopLoss);
    if (stopDist <= 0) return null;

    // First technically justified objective (nearest structural H/L/VP target with realistic room, never fabricated)
    let tpRaw: number;
    if (dir === 'LONG') {
      const structuralTargets = [...resistLevels, struct4h?.lastPivotHigh ?? 0].filter(
        (p) => p > entry + stopDist * 1.05
      );
      tpRaw =
        structuralTargets.length > 0
          ? Math.min(...structuralTargets)
          : entry + Math.max(stopDist * 2.2, atr1h * 2.2);
    } else {
      const structuralTargets = [...supportLevels, struct4h?.lastPivotLow ?? Infinity].filter(
        (p) => p < entry - stopDist * 1.05 && Number.isFinite(p) && p > 0
      );
      tpRaw =
        structuralTargets.length > 0
          ? Math.max(...structuralTargets)
          : entry - Math.max(stopDist * 2.2, atr1h * 2.2);
    }

    const takeProfit = roundToStep(tpRaw, priceDecimals);
    const targetDist = Math.abs(takeProfit - entry);

    // Linear contract sizing (§9): L = q * |E - S| + C_stop <= riskBudgetUsd
    const perUnitCostRate =
      (config.feePctPerSide * 2 +
        config.slippagePctPerSide * 2 +
        spreadPct +
        (derivApplicable ? config.expectedFundingCostPct : 0)) /
      100;
    const costPerUnitStop = (entry + stopLoss) * 0.5 * perUnitCostRate;
    const costPerUnitTarget = (entry + takeProfit) * 0.5 * perUnitCostRate;

    const rawQ = riskBudgetUsd / (stopDist + costPerUnitStop);
    const lotDecimals = asset === 'BTC' ? 4 : 3;
    const quantity = Math.max(0, roundToStep(rawQ, lotDecimals));
    if (quantity <= 0) return null;

    const grossRiskUsd = quantity * stopDist;
    const grossRewardUsd = quantity * targetDist;
    const stopCostUsd = quantity * costPerUnitStop;
    const targetCostUsd = quantity * costPerUnitTarget;
    const netRiskUsd = grossRiskUsd + stopCostUsd;
    const netRewardUsd = grossRewardUsd - targetCostUsd;
    const netRR = netRiskUsd > 0 ? netRewardUsd / netRiskUsd : 0;
    const costToRiskPct =
      grossRiskUsd > 0 ? (100 * Math.max(stopCostUsd, targetCostUsd)) / grossRiskUsd : 100;

    return {
      direction: dir,
      entry,
      stopLoss,
      takeProfit,
      validationLevel: valLevel,
      invalidationMarginAtr: Math.max(0, invMarginAtr),
      quantity,
      notionalUsd: quantity * entry,
      grossRiskUsd,
      grossRewardUsd,
      stopCostUsd,
      targetCostUsd,
      netRiskUsd,
      netRewardUsd,
      netRR,
      costToRiskPct,
      spreadPct,
      depthAtEntryUsd:
        dir === 'LONG' ? orderbook?.askTotalUsd ?? 0 : orderbook?.bidTotalUsd ?? 0,
    };
  }

  const longPlan = buildExecutionPlan('LONG');
  const shortPlan = buildExecutionPlan('SHORT');

  function scoreF1(plan: TradeExecutionPlan | null): DirectionParamResult {
    if (!plan) return makeParamResult(null, 8, true, true, 'Sin plan ejecutable para calcular RR neto.');
    let pts: ParameterPoints = 0;
    if (plan.netRR >= 3.0) pts = 100;
    else if (plan.netRR >= 2.5) pts = 75;
    else if (plan.netRR >= 2.0) pts = 50;
    else if (plan.netRR >= 1.5) pts = 25;
    return makeParamResult(
      pts,
      8,
      true,
      false,
      `RR neto = ${plan.netRR.toFixed(2)} (objetivo $${plan.takeProfit.toFixed(priceDecimals)} tras costes).`
    );
  }

  function scoreF2(plan: TradeExecutionPlan | null): DirectionParamResult {
    if (!plan) return makeParamResult(null, 4, true, true, 'Sin plan ejecutable para calcular costes.');
    let pts: ParameterPoints = 0;
    if (plan.costToRiskPct <= 5) pts = 100;
    else if (plan.costToRiskPct <= 10) pts = 75;
    else if (plan.costToRiskPct <= 15) pts = 50;
    else if (plan.costToRiskPct <= 20) pts = 25;
    return makeParamResult(
      pts,
      4,
      true,
      false,
      `Coste máx / riesgo bruto = ${plan.costToRiskPct.toFixed(1)}% ($${Math.max(plan.stopCostUsd, plan.targetCostUsd).toFixed(2)} / $${plan.grossRiskUsd.toFixed(2)}).`
    );
  }

  function scoreF3(plan: TradeExecutionPlan | null): DirectionParamResult {
    if (!plan) return makeParamResult(null, 3, true, true, 'Sin nivel de invalidación estructural.');
    let pts: ParameterPoints = 50;
    if (plan.invalidationMarginAtr >= 0.25) pts = 100;
    else if (plan.invalidationMarginAtr > 0) pts = 75;
    return makeParamResult(
      pts,
      3,
      true,
      false,
      `Stop estructural con margen de ${plan.invalidationMarginAtr.toFixed(2)} ATR(15m) sobre pivote.`
    );
  }

  const f1Row: ParameterScoreRow = {
    id: 'F1',
    family: 'F',
    name: 'RR neto (después de costes)',
    timeframeLabel: 'Plan',
    maxWeight: 8,
    observedSummary: `L ${longPlan ? longPlan.netRR.toFixed(2) : 'N/D'} · S ${shortPlan ? shortPlan.netRR.toFixed(2) : 'N/D'}`,
    long: scoreF1(longPlan),
    short: scoreF1(shortPlan),
  };

  const f2Row: ParameterScoreRow = {
    id: 'F2',
    family: 'F',
    name: 'Coste / Riesgo bruto',
    timeframeLabel: 'Plan',
    maxWeight: 4,
    observedSummary: `L ${longPlan ? longPlan.costToRiskPct.toFixed(1) + '%' : 'N/D'} · S ${shortPlan ? shortPlan.costToRiskPct.toFixed(1) + '%' : 'N/D'}`,
    long: scoreF2(longPlan),
    short: scoreF2(shortPlan),
  };

  const f3Row: ParameterScoreRow = {
    id: 'F3',
    family: 'F',
    name: 'Invalidación estructural',
    timeframeLabel: '15m',
    maxWeight: 3,
    observedSummary: `L $${longPlan ? longPlan.stopLoss.toFixed(priceDecimals) : '—'} · S $${shortPlan ? shortPlan.stopLoss.toFixed(priceDecimals) : '—'}`,
    long: scoreF3(longPlan),
    short: scoreF3(shortPlan),
  };

  const parameters: ParameterScoreRow[] = [
    a1Row,
    a2Row,
    a3Row,
    a4Row,
    b1Row,
    b2Row,
    b3Row,
    b4Row,
    c1Row,
    c2Row,
    c3Row,
    d1Row,
    d2Row,
    d3Row,
    e1Row,
    e2Row,
    f1Row,
    f2Row,
    f3Row,
  ];

  // -------------------------------------------------------------------------
  // 5. Totals, Coverage, Family Breakdown & §11 Blocking Checks
  // -------------------------------------------------------------------------
  function computeRawStats(dir: 'LONG' | 'SHORT') {
    let applicableWeight = 0;
    let availableWeight = 0;
    let rawWeightedSum = 0;
    let passedCount = 0;
    let partialCount = 0;
    let failedCount = 0;
    let missingCount = 0;

    for (const row of parameters) {
      const res = dir === 'LONG' ? row.long : row.short;
      if (!res.applicable) continue;
      applicableWeight += row.maxWeight;
      if (res.missing || res.points === null) {
        missingCount++;
        continue;
      }
      availableWeight += row.maxWeight;
      rawWeightedSum += res.weightedPoints;
      if (res.points >= 75) passedCount++;
      else if (res.points === 50) partialCount++;
      else failedCount++;
    }

    const score = availableWeight > 0 ? (rawWeightedSum * 100) / availableWeight : 0;
    const coveragePct = applicableWeight > 0 ? (100 * availableWeight) / applicableWeight : 0;
    return {
      applicableWeight,
      availableWeight,
      rawWeightedSum,
      score,
      coveragePct,
      passedCount,
      partialCount,
      failedCount,
      missingCount,
    };
  }

  const longStats = computeRawStats('LONG');
  const shortStats = computeRawStats('SHORT');

  function finalizeDirection(
    dir: 'LONG' | 'SHORT',
    own: ReturnType<typeof computeRawStats>,
    oppScore: number,
    plan: TradeExecutionPlan | null
  ): DirectionEvaluation {
    const a1Res = dir === 'LONG' ? a1Row.long : a1Row.short;
    const d1Res = dir === 'LONG' ? d1Row.long : d1Row.short;
    const diffVsOpposite = own.score - oppScore;
    const blocks: BlockedCondition[] = [];

    if (own.coveragePct < 90) {
      blocks.push({
        code: 'COBERTURA',
        label: `INCOMPLETO (${own.coveragePct.toFixed(1)}% < 90%)`,
        detail: 'Faltan parámetros obligatorios; no se puede habilitar operación.',
        severity: 'BLOQUEAR',
      });
    }
    if (!plan || plan.entry <= 0 || plan.stopLoss <= 0 || plan.takeProfit <= 0 || plan.quantity <= 0) {
      blocks.push({
        code: 'PLAN_INCOMPLETO',
        label: 'Entrada, stop u objetivo ausentes',
        detail: 'Datos de ejecución insuficientes para tamaño o niveles.',
        severity: 'BLOQUEAR',
      });
    } else {
      if (plan.netRR < 2.0) {
        blocks.push({
          code: 'RR_NETO',
          label: `RR neto < 2 (${plan.netRR.toFixed(2)})`,
          detail: 'El primer objetivo técnico neto tras costes no alcanza 2.0R.',
          severity: 'BLOQUEAR',
        });
      }
      if (plan.costToRiskPct > 20) {
        blocks.push({
          code: 'COSTES',
          label: `Coste / riesgo bruto > 20% (${plan.costToRiskPct.toFixed(1)}%)`,
          detail: 'Comisiones, spread/deslizamiento o funding consumen demasiado presupuesto de riesgo.',
          severity: 'BLOQUEAR',
        });
      }
      if (orderbook && (plan.spreadPct > 0.25 || plan.depthAtEntryUsd < plan.notionalUsd * 2)) {
        blocks.push({
          code: 'LIQUIDEZ_BOOK',
          label: 'Profundidad insuficiente o spread alto',
          detail: `Spread ${plan.spreadPct.toFixed(3)}% · Profundidad $${plan.depthAtEntryUsd.toFixed(0)}`,
          severity: 'BLOQUEAR',
        });
      }
    }

    if (config.dailyLossReached) {
      blocks.push({
        code: 'LIMITE_DIARIO',
        label: 'Límite diario alcanzado',
        detail: 'Bloqueo de disciplina de cartera (≥ 1% pérdida diaria).',
        severity: 'BLOQUEAR',
      });
    }
    if (config.correlatedRiskExceeded) {
      blocks.push({
        code: 'RIESGO_CARTERA',
        label: 'Riesgo de cartera superado',
        detail: 'Exposición abierta conjunta BTC+ETH supera el presupuesto permitido.',
        severity: 'BLOQUEAR',
      });
    }

    if (d1Res.points === null || d1Res.points < 75) {
      blocks.push({
        code: 'D1_SIN_CONFIRMAR',
        label: `Disparador D1 < 75 (${d1Res.points ?? 'N/D'})`,
        detail: 'Falta cierre/retesteo confirmado en 15m antes de activar entrada.',
        severity: 'ESPERAR',
      });
    }
    if (a1Res.points === null || a1Res.points < 75) {
      blocks.push({
        code: 'A1_ESTRUCTURA',
        label: `Estructura 4h A1 < 75 (${a1Res.points ?? 'N/D'})`,
        detail: 'Contexto 4h en rango o transición sin secuencia favorable ≥ 75.',
        severity: 'ESPERAR',
      });
    }
    if (own.score >= 80 && diffVsOpposite < 15) {
      blocks.push({
        code: 'CONFLICTO_DIR',
        label: `Diferencia < 15 pts (Δ ${diffVsOpposite.toFixed(1)})`,
        detail: 'Ambas direcciones tienen puntuación cercana; esperar desempate.',
        severity: 'ESPERAR',
      });
    }

    const hardBlock = blocks.some((b) => b.severity === 'BLOQUEAR');
    const waitBlock = blocks.some((b) => b.severity === 'ESPERAR');
    const operable =
      own.coveragePct >= 90 &&
      own.score >= 80 &&
      diffVsOpposite >= 15 &&
      (a1Res.points ?? 0) >= 75 &&
      (d1Res.points ?? 0) >= 75 &&
      !hardBlock;

    const verdict: DirectionVerdict = hardBlock
      ? 'BLOQUEADA'
      : operable
      ? 'CANDIDATA'
      : own.score < 60
      ? 'DESCARTADA'
      : waitBlock || own.score < 80
      ? 'ESPERAR'
      : 'ESPERAR';

    return {
      direction: dir,
      score: own.score,
      band: classifyScoreBand(own.score, own.coveragePct),
      verdict,
      operable,
      coveragePct: own.coveragePct,
      applicableWeight: own.applicableWeight,
      availableWeight: own.availableWeight,
      rawWeightedSum: own.rawWeightedSum,
      diffVsOpposite,
      passedCount: own.passedCount,
      partialCount: own.partialCount,
      failedCount: own.failedCount,
      missingCount: own.missingCount,
      plan,
      blocks,
    };
  }

  const longEval = finalizeDirection('LONG', longStats, shortStats.score, longPlan);
  const shortEval = finalizeDirection('SHORT', shortStats, longStats.score, shortPlan);

  const FAMILY_META: { id: ScoringFamilyId; name: string; maxWeight: number }[] = [
    { id: 'A', name: 'Contexto y Estructura', maxWeight: 30 },
    { id: 'B', name: 'Tendencia y Momentum', maxWeight: 20 },
    { id: 'C', name: 'Participación y Volumen', maxWeight: 15 },
    { id: 'D', name: 'Configuración y Volatilidad', maxWeight: 15 },
    { id: 'E', name: 'Derivados', maxWeight: 5 },
    { id: 'F', name: 'Viabilidad y Ejecución', maxWeight: 15 },
  ];

  const families: FamilySummary[] = FAMILY_META.map((fm) => {
    const rows = parameters.filter((p) => p.family === fm.id);
    let applicableWeight = 0;
    let longPts = 0;
    let shortPts = 0;
    let longPassedCount = 0;
    let shortPassedCount = 0;
    let totalApplicableCount = 0;

    for (const r of rows) {
      if (r.long.applicable) {
        applicableWeight += r.maxWeight;
        totalApplicableCount++;
        longPts += r.long.weightedPoints;
        shortPts += r.short.weightedPoints;
        if (r.long.passed) longPassedCount++;
        if (r.short.passed) shortPassedCount++;
      }
    }

    return {
      id: fm.id,
      name: fm.name,
      maxWeight: fm.maxWeight,
      applicableWeight,
      longPoints: longPts,
      shortPoints: shortPts,
      longPassedCount,
      shortPassedCount,
      totalApplicableCount,
    };
  });

  const dominantDirection: 'LONG' | 'SHORT' | 'NEUTRAL' =
    longEval.score - shortEval.score >= 5
      ? 'LONG'
      : shortEval.score - longEval.score >= 5
      ? 'SHORT'
      : 'NEUTRAL';

  const regimeLabel =
    struct4h?.label === 'Alcista' && (adxVal ?? 0) >= 20
      ? 'Tendencia Alcista (4h)'
      : struct4h?.label === 'Bajista' && (adxVal ?? 0) >= 20
      ? 'Tendencia Bajista (4h)'
      : 'Rango / Transición';

  return {
    version: 'v1.1',
    asset,
    instId,
    mode: config.mode,
    evaluatedAt: Date.now(),
    lastClosed4hTs,
    lastClosed1hTs,
    lastClosed15mTs,
    spot,
    btcContextLabel,
    ethRelPerf4hPct,
    volumeProfile7d: vp7d,
    fundingStats90d,
    oiWindow,
    regimeLabel,
    parameters,
    families,
    longEval,
    shortEval,
    dominantDirection,
    excludedNotes,
  };
}

export function listParameterIds(): ScoringParameterId[] {
  return [
    'A1',
    'A2',
    'A3',
    'A4',
    'B1',
    'B2',
    'B3',
    'B4',
    'C1',
    'C2',
    'C3',
    'D1',
    'D2',
    'D3',
    'E1',
    'E2',
    'F1',
    'F2',
    'F3',
  ];
}
