import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import {
  calculateAnchoredVWAPFromTs,
  calculateFibonacciLevels,
  calculateVolumeDeltaSeries,
  calculateVolumeProfileBuckets,
  computeTechnicalSnapshot,
  detectConfluenceZones,
  detectFairValueGaps,
  detectOscillatorDivergences,
  detectSupportResistanceZones,
  evaluateMultiTimeframeMatrix,
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

  it('computes proportional Volume Profile with HVN/LVN classification and VAH >= POC >= VAL', () => {
    const vp = calculateVolumeProfileBuckets(candles, 32);
    expect(vp).not.toBeNull();
    expect(vp!.buckets.length).toBe(32);
    expect(vp!.vah).toBeGreaterThanOrEqual(vp!.poc);
    expect(vp!.poc).toBeGreaterThanOrEqual(vp!.val);
    expect(vp!.totalVol).toBeGreaterThan(0);
    expect(vp!.buckets.some((b) => b.nodeType === 'poc')).toBe(true);
  });

  it('computes Volume Delta, CVD and Anchored VWAP from arbitrary timestamp', () => {
    const vd = calculateVolumeDeltaSeries(candles);
    expect(vd.length).toBe(candles.length);
    const sumDelta = vd.reduce((acc, pt) => acc + pt.delta, 0);
    expect(vd[vd.length - 1].cvd).toBeCloseTo(sumDelta, 6);

    const anchorTs = candles[120].t;
    const avwap = calculateAnchoredVWAPFromTs(candles, anchorTs);
    expect(avwap[119]).toBeNull();
    expect(avwap[120]).not.toBeNull();
    expect(avwap[candles.length - 1]).toBeGreaterThan(0);
  });

  it('detects Fibonacci levels in window, pivots, and manual modes with Golden Pocket range', () => {
    const fibBull = calculateFibonacciLevels(candles, 120, 'bullish', spot);
    expect(fibBull).not.toBeNull();
    expect(fibBull!.direction).toBe('bullish');
    expect(fibBull!.goldenPocketHigh).toBeGreaterThan(fibBull!.goldenPocketLow);
    const lvl382 = fibBull!.levels.find((l) => l.ratio === 0.382)!;
    const lvl618 = fibBull!.levels.find((l) => l.ratio === 0.618)!;
    const lvl1618 = fibBull!.levels.find((l) => l.ratio === 1.618)!;
    expect(lvl1618.price).toBeGreaterThan(fibBull!.swingHigh);
    expect(lvl382.price).toBeGreaterThan(lvl618.price);

    const fibPivots = calculateFibonacciLevels(candles, 120, 'auto', spot, { anchorMode: 'pivots' });
    expect(fibPivots).not.toBeNull();
    expect(fibPivots!.anchorMode).toBe('pivots');

    const fibManual = calculateFibonacciLevels(candles, 120, 'bullish', spot, {
      anchorMode: 'manual',
      manualA: { price: 61000, ts: candles[20].t },
      manualB: { price: 66000, ts: candles[100].t },
    });
    expect(fibManual).not.toBeNull();
    expect(fibManual!.swingLow).toBe(61000);
    expect(fibManual!.swingHigh).toBe(66000);
  });

  it('detects Fair Value Gaps (FVG) when price gaps cleanly', () => {
    const gapped: Candle[] = [
      { t: 1000, o: 100, h: 105, l: 98, c: 104, v: 100 },
      { t: 2000, o: 104, h: 120, l: 104, c: 118, v: 250 },
      { t: 3000, o: 118, h: 124, l: 112, c: 122, v: 120 }, // prev.h=105 < next.l=112 -> bullish FVG [105..112]
      { t: 4000, o: 122, h: 126, l: 119, c: 125, v: 90 },
      { t: 5000, o: 125, h: 129, l: 121, c: 128, v: 90 },
    ];
    const fvgs = detectFairValueGaps(gapped, 128, 6);
    expect(fvgs.length).toBe(1);
    expect(fvgs[0].direction).toBe('bullish');
    expect(fvgs[0].bottom).toBe(105);
    expect(fvgs[0].top).toBe(112);
  });

  it('extracts S/R, Confluence Clusters, EMA 20/50/200, Divergences, and MTF Matrix', () => {
    const sr = detectSupportResistanceZones(candles, spot);
    expect(sr.length).toBeGreaterThan(0);

    const vp = calculateVolumeProfileBuckets(candles, 32);
    const snap = computeTechnicalSnapshot(candles, vp?.poc ?? null, 12);
    expect(snap.ema20[candles.length - 1]).not.toBeNull();
    expect(snap.ema50[candles.length - 1]).not.toBeNull();
    expect(snap.ema200[candles.length - 1]).not.toBeNull();
    expect(snap.bbWidthPct[candles.length - 1]).not.toBeNull();

    const fib = calculateFibonacciLevels(candles, 120, 'auto', spot, { anchorMode: 'pivots' });
    const confluences = detectConfluenceZones({
      spot,
      srZones: sr,
      fibAnalysis: fib,
      volumeProfile: vp,
      liquidityLevels: [],
      prevDayHigh: sr[0]?.price ?? null,
      prevDayLow: sr[sr.length - 1]?.price ?? null,
    });
    expect(Array.isArray(confluences)).toBe(true);

    const vd = calculateVolumeDeltaSeries(candles);
    const divs = detectOscillatorDivergences(candles, snap.rsi14, snap.macd.hist, vd);
    expect(Array.isArray(divs)).toBe(true);

    const mtf = evaluateMultiTimeframeMatrix({
      '15m': candles,
      '1H': candles,
      '4H': candles,
      D: candles,
    });
    expect(mtf).toHaveLength(4);
    expect(mtf.every((r) => r.rsi !== null)).toBe(true);
  });
});
