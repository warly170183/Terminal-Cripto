import type { Candle } from '../types/market';

/**
 * Classic Exponential Moving Average over a numeric array.
 * Seeds with SMA of the first `period` elements once `period` samples are available.
 */
export function calculateEMA(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) {
    return result;
  }

  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  let ema = sum / period;
  result[period - 1] = ema;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
    result[i] = ema;
  }
  return result;
}

export type EmaCloudSet = {
  ema9: (number | null)[];
  ema21: (number | null)[];
  ema50: (number | null)[];
  primaryState: 'Up' | 'Down';
};

export function calculateEMAClouds(candles: Candle[]): EmaCloudSet {
  const closes = candles.map((c) => c.c);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);

  let primaryState: 'Up' | 'Down' = 'Up';
  for (let i = candles.length - 1; i >= 0; i--) {
    const f = ema9[i];
    const s = ema21[i];
    if (f !== null && s !== null) {
      primaryState = f >= s ? 'Up' : 'Down';
      break;
    }
  }

  return { ema9, ema21, ema50, primaryState };
}

/**
 * Volume-Weighted Average Price resetting daily at 00:00 UTC.
 */
export function calculateVWAP(candles: Candle[]): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null);
  let currentDayKey = '';
  let cumPV = 0;
  let cumVol = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const dayKey = new Date(c.t).toISOString().slice(0, 10);
    if (dayKey !== currentDayKey) {
      currentDayKey = dayKey;
      cumPV = 0;
      cumVol = 0;
    }

    const typicalPrice = (c.h + c.l + c.c) / 3;
    const vol = c.v > 0 ? c.v : 0;
    cumPV += typicalPrice * vol;
    cumVol += vol;

    if (cumVol > 0) {
      result[i] = cumPV / cumVol;
    } else {
      result[i] = typicalPrice;
    }
  }
  return result;
}

/**
 * Extracts previous UTC day's High and Low from candle array (works best with 1D or full intraday).
 */
export function getPreviousDayHighLow(candles: Candle[], referenceNowMs = Date.now()): {
  prevHigh: number | null;
  prevLow: number | null;
} {
  if (candles.length === 0) {
    return { prevHigh: null, prevLow: null };
  }

  const todayKey = new Date(referenceNowMs).toISOString().slice(0, 10);
  const prevDays = new Map<string, { high: number; low: number }>();

  for (const c of candles) {
    const dayKey = new Date(c.t).toISOString().slice(0, 10);
    if (dayKey >= todayKey) continue;
    const existing = prevDays.get(dayKey);
    if (!existing) {
      prevDays.set(dayKey, { high: c.h, low: c.l });
    } else {
      if (c.h > existing.high) existing.high = c.h;
      if (c.l < existing.low) existing.low = c.l;
    }
  }

  if (prevDays.size === 0) {
    return { prevHigh: null, prevLow: null };
  }

  const sortedKeys = Array.from(prevDays.keys()).sort();
  const latestPrevKey = sortedKeys[sortedKeys.length - 1];
  const entry = prevDays.get(latestPrevKey)!;
  return { prevHigh: entry.high, prevLow: entry.low };
}

/**
 * Wilder's Relative Strength Index (RSI).
 */
export function calculateRSI(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (period <= 0 || closes.length <= period) {
    return result;
  }

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum += -diff;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return result;
}

/**
 * Bollinger Bands (SMA + k * population standard deviation).
 */
export function calculateBollinger(
  closes: number[],
  period = 20,
  stdDevMult = 2
): {
  middle: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
} {
  const len = closes.length;
  const middle: (number | null)[] = new Array(len).fill(null);
  const upper: (number | null)[] = new Array(len).fill(null);
  const lower: (number | null)[] = new Array(len).fill(null);

  if (period <= 0 || len < period) {
    return { middle, upper, lower };
  }

  for (let i = period - 1; i < len; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += closes[j];
    }
    const mean = sum / period;
    let sqDiffSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - mean;
      sqDiffSum += d * d;
    }
    const sd = Math.sqrt(sqDiffSum / period);
    middle[i] = mean;
    upper[i] = mean + stdDevMult * sd;
    lower[i] = mean - stdDevMult * sd;
  }

  return { middle, upper, lower };
}
