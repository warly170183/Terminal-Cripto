import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import type { MultiTfScoringDataset, ScoringConfig } from '../../types/scoring';
import { evaluateScoringSystem } from '../scoringEngine';

function buildTrendingCandles(
  count: number,
  barMs: number,
  startPrice: number,
  trendPerBar: number,
  amplitude: number,
  endTs: number
): Candle[] {
  const out: Candle[] = [];
  const startTs = endTs - count * barMs;
  for (let i = 0; i < count; i++) {
    // Periodic zig-zag superimposed on trend so 2-bar swing pivots form reliably
    const wave = Math.sin((i / 7) * Math.PI * 2) * amplitude;
    const prevWave = Math.sin(((i - 1) / 7) * Math.PI * 2) * amplitude;
    const o = startPrice + (i - 1) * trendPerBar + prevWave;
    const c = startPrice + i * trendPerBar + wave;
    const hi = Math.max(o, c) + amplitude * 0.25;
    const lo = Math.min(o, c) - amplitude * 0.25;
    out.push({
      t: startTs + i * barMs,
      o,
      h: hi,
      l: lo,
      c,
      v: i === count - 1 ? 260 : 120, // elevated volume on final confirmation bar
    });
  }
  return out;
}

const DEFAULT_CONFIG: ScoringConfig = {
  mode: 'perpetual',
  capitalUsd: 10000,
  riskPct: 0.25,
  feePctPerSide: 0.05,
  slippagePctPerSide: 0.02,
  expectedFundingCostPct: 0.01,
  dailyLossReached: false,
  correlatedRiskExceeded: false,
};

describe('Sistema de Puntuación v1.1', () => {
  const now = Date.UTC(2026, 10, 19, 20, 0, 0);

  it('weights across all 19 parameters (A1..F3) sum to exactly 100', () => {
    const candles4h = buildTrendingCandles(120, 4 * 3600_000, 60000, 80, 300, now);
    const candles1h = buildTrendingCandles(280, 3600_000, 62000, 22, 160, now);
    const candles15m = buildTrendingCandles(140, 15 * 60_000, 66000, 8, 75, now);

    const ds: MultiTfScoringDataset = {
      asset: 'ETH',
      instId: 'ETH-USDT-SWAP',
      candles4h,
      candles1h,
      candles15m,
      btcCandles4h: buildTrendingCandles(120, 4 * 3600_000, 60000, 40, 220, now),
      orderbook: null,
      oiSeries1h: candles1h.slice(-10).map((c, idx) => ({ ts: c.t, oiUsd: (1000 + idx * 40) * c.c })),
      fundingCurrent8h: 0.0001,
      fundingHistory8h: Array.from({ length: 120 }, (_, i) => (i - 60) * 0.00001),
      fetchedAt: now,
    };

    const res = evaluateScoringSystem(ds, DEFAULT_CONFIG);
    const sumWeights = res.parameters.reduce((acc, p) => acc + p.maxWeight, 0);
    expect(sumWeights).toBe(100);
    expect(res.longEval.applicableWeight).toBe(100);
    expect(res.longEval.coveragePct).toBe(100);
  });

  it('evaluates bullish trend higher for LONG than SHORT, and bearish higher for SHORT than LONG', () => {
    const bull4h = buildTrendingCandles(120, 4 * 3600_000, 50000, 95, 240, now);
    const bull1h = buildTrendingCandles(280, 3600_000, 54000, 28, 120, now);
    const bull15m = buildTrendingCandles(140, 15 * 60_000, 60800, 10, 45, now);
    const bullOi = bull1h.slice(-10).map((c, idx) => ({ ts: c.t, oiUsd: (2000 + idx * 90) * c.c }));

    const bullRes = evaluateScoringSystem(
      {
        asset: 'ETH',
        instId: 'ETH-USDT-SWAP',
        candles4h: bull4h,
        candles1h: bull1h,
        candles15m: bull15m,
        btcCandles4h: buildTrendingCandles(120, 4 * 3600_000, 50000, 45, 200, now),
        orderbook: null,
        oiSeries1h: bullOi,
        fundingCurrent8h: 0.0001,
        fundingHistory8h: Array.from({ length: 120 }, (_, i) => (i - 60) * 0.00001),
        fetchedAt: now,
      },
      DEFAULT_CONFIG
    );
    expect(bullRes.longEval.score).toBeGreaterThan(bullRes.shortEval.score);
    expect(bullRes.longEval.passedCount).toBeGreaterThan(bullRes.shortEval.passedCount);

    const bear4h = buildTrendingCandles(120, 4 * 3600_000, 72000, -95, 240, now);
    const bear1h = buildTrendingCandles(280, 3600_000, 68000, -28, 120, now);
    const bear15m = buildTrendingCandles(140, 15 * 60_000, 61200, -10, 45, now);
    const bearOi = bear1h.slice(-10).map((c, idx) => ({ ts: c.t, oiUsd: (2000 + idx * 90) * c.c }));

    const bearRes = evaluateScoringSystem(
      {
        asset: 'ETH',
        instId: 'ETH-USDT-SWAP',
        candles4h: bear4h,
        candles1h: bear1h,
        candles15m: bear15m,
        btcCandles4h: buildTrendingCandles(120, 4 * 3600_000, 72000, -45, 200, now),
        orderbook: null,
        oiSeries1h: bearOi,
        fundingCurrent8h: 0.0001,
        fundingHistory8h: Array.from({ length: 120 }, (_, i) => (i - 60) * 0.00001),
        fetchedAt: now,
      },
      DEFAULT_CONFIG
    );
    expect(bearRes.shortEval.score).toBeGreaterThan(bearRes.longEval.score);
    expect(bearRes.shortEval.passedCount).toBeGreaterThan(bearRes.longEval.passedCount);
  });

  it('deactivates A4 for BTC and E1/E2 for Spot mode while renormalizing weights', () => {
    const candles4h = buildTrendingCandles(120, 4 * 3600_000, 60000, 75, 220, now);
    const candles1h = buildTrendingCandles(280, 3600_000, 62000, 22, 120, now);
    const candles15m = buildTrendingCandles(140, 15 * 60_000, 67000, 7, 45, now);

    const btcSpot = evaluateScoringSystem(
      {
        asset: 'BTC',
        instId: 'BTC-USDT-SWAP',
        candles4h,
        candles1h,
        candles15m,
        btcCandles4h: candles4h,
        orderbook: null,
        oiSeries1h: [],
        fundingCurrent8h: null,
        fundingHistory8h: [],
        fetchedAt: now,
      },
      { ...DEFAULT_CONFIG, mode: 'spot' }
    );

    const a4 = btcSpot.parameters.find((p) => p.id === 'A4')!;
    const e1 = btcSpot.parameters.find((p) => p.id === 'E1')!;
    const e2 = btcSpot.parameters.find((p) => p.id === 'E2')!;
    expect(a4.long.applicable).toBe(false);
    expect(e1.long.applicable).toBe(false);
    expect(e2.long.applicable).toBe(false);
    expect(btcSpot.longEval.applicableWeight).toBe(91);
    expect(btcSpot.longEval.coveragePct).toBe(100);
  });

  it('blocks evaluation as INCOMPLETO when coverage falls below 90%', () => {
    // Only 30 1h candles => missing EMA200 (B1: 6), ATR percentile (D2: 4), OI (E1: 3), Funding (E2: 2)
    // Available weight = 100 - 15 = 85% (< 90%)
    const candles4h = buildTrendingCandles(40, 4 * 3600_000, 60000, 75, 200, now);
    const candles1h = buildTrendingCandles(35, 3600_000, 62000, 22, 120, now);
    const candles15m = buildTrendingCandles(40, 15 * 60_000, 62800, 7, 45, now);

    const res = evaluateScoringSystem(
      {
        asset: 'ETH',
        instId: 'ETH-USDT-SWAP',
        candles4h,
        candles1h,
        candles15m,
        btcCandles4h: candles4h,
        orderbook: null,
        oiSeries1h: [],
        fundingCurrent8h: null,
        fundingHistory8h: [],
        fetchedAt: now,
      },
      DEFAULT_CONFIG
    );

    expect(res.longEval.coveragePct).toBeLessThan(90);
    expect(res.longEval.band).toBe('INCOMPLETO');
    expect(res.longEval.verdict).toBe('BLOQUEADA');
    expect(res.longEval.operable).toBe(false);
  });

  it('enforces daily loss limit hard block even on strong setups', () => {
    const bull4h = buildTrendingCandles(120, 4 * 3600_000, 50000, 95, 240, now);
    const bull1h = buildTrendingCandles(280, 3600_000, 54000, 28, 120, now);
    const bull15m = buildTrendingCandles(140, 15 * 60_000, 60800, 10, 45, now);

    const res = evaluateScoringSystem(
      {
        asset: 'ETH',
        instId: 'ETH-USDT-SWAP',
        candles4h: bull4h,
        candles1h: bull1h,
        candles15m: bull15m,
        btcCandles4h: bull4h,
        orderbook: null,
        oiSeries1h: bull1h.slice(-10).map((c, idx) => ({ ts: c.t, oiUsd: (2000 + idx * 90) * c.c })),
        fundingCurrent8h: 0.0001,
        fundingHistory8h: Array.from({ length: 120 }, (_, i) => (i - 60) * 0.00001),
        fetchedAt: now,
      },
      { ...DEFAULT_CONFIG, dailyLossReached: true }
    );

    expect(res.longEval.verdict).toBe('BLOQUEADA');
    expect(res.longEval.operable).toBe(false);
    expect(res.longEval.blocks.some((b) => b.code === 'LIMITE_DIARIO')).toBe(true);
  });
});
