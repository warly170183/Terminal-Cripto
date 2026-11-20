import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import {
  calculateFibonacciLevels,
  calculateVolumeDeltaSeries,
  calculateVolumeProfileBuckets,
  computeTechnicalSnapshot,
  detectSupportResistanceZones,
} from '../technicalAnalysis';

function makeSampleCandles(count = 240): Candle[] {
  const out: Candle[] = [];
  const start = Date.UTC(2026, 10, 1, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    const wave = Math.sin(i * 0.22) * 400;
    const base = 60000 + i * 25 + wave;
    const o = base - 40;
    const c = base + 55;
    const h = Math.max(o, c) + 90;
    const l = Math.min(o, c) - 85;
    out.push({
      t: start + i * 3600_000,
      o,
      h,
      l,
      c,
      v: 150 + (i % 10) * 20,
    });
  }
  return out;
}

describe('Technical Analysis Engine', () => {
  const candles = makeSampleCandles(240);
  const spot = candles[candles.length - 1].c;

  it('computes Volume Profile with ordered VAH >= POC >= VAL', () => {
    const vp = calculateVolumeProfileBuckets(candles, 32);
    expect(vp).not.toBeNull();
    expect(vp!.buckets.length).toBe(32);
    expect(vp!.vah).toBeGreaterThanOrEqual(vp!.poc);
    expect(vp!.poc).toBeGreaterThanOrEqual(vp!.val);
    expect(vp!.totalVol).toBeGreaterThan(0);
  });

  it('computes Volume Delta and Cumulative Volume Delta (CVD)', () => {
    const vd = calculateVolumeDeltaSeries(candles);
    expect(vd.length).toBe(candles.length);
    const sumDelta = vd.reduce((acc, pt) => acc + pt.delta, 0);
    expect(vd[vd.length - 1].cvd).toBeCloseTo(sumDelta, 6);
  });

  it('detects Fibonacci levels cleanly in bullish & bearish directions', () => {
    const fibBull = calculateFibonacciLevels(candles, 120, 'bullish', spot);
    expect(fibBull).not.toBeNull();
    expect(fibBull!.direction).toBe('bullish');
    const lvl382 = fibBull!.levels.find((l) => l.ratio === 0.382)!;
    const lvl618 = fibBull!.levels.find((l) => l.ratio === 0.618)!;
    const lvl1618 = fibBull!.levels.find((l) => l.ratio === 1.618)!;
    expect(lvl1618.price).toBeGreaterThan(fibBull!.swingHigh);
    expect(lvl382.price).toBeGreaterThan(lvl618.price);

    const fibBear = calculateFibonacciLevels(candles, 120, 'bearish', spot);
    expect(fibBear).not.toBeNull();
    expect(fibBear!.direction).toBe('bearish');
    const bear618 = fibBear!.levels.find((l) => l.ratio === 0.618)!;
    const bear382 = fibBear!.levels.find((l) => l.ratio === 0.382)!;
    expect(bear618.price).toBeGreaterThan(bear382.price);
  });

  it('extracts Support/Resistance zones and EMA 50/200 technical snapshot', () => {
    const sr = detectSupportResistanceZones(candles, spot);
    expect(sr.length).toBeGreaterThan(0);

    const vp = calculateVolumeProfileBuckets(candles, 32);
    const snap = computeTechnicalSnapshot(candles, vp?.poc ?? null, 12);
    const lastEma50 = snap.ema50[candles.length - 1];
    const lastEma200 = snap.ema200[candles.length - 1];
    expect(lastEma50).not.toBeNull();
    expect(lastEma200).not.toBeNull();
    expect(snap.signals.length).toBeGreaterThanOrEqual(4);
  });
});
