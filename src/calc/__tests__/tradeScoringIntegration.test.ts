import { describe, expect, it } from 'vitest';
import type { Candle, Levels } from '../../types/market';
import type { ScoringResult } from '../../types/scoring';
import { analyzeMarketLiquidity } from '../liquidity';
import { evaluateScoringSystem } from '../scoringEngine';
import { generateTradingOptions } from '../tradeSetups';

import {
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

function buildBullCandles(
  count: number,
  barMs: number,
  startPrice: number,
  step: number,
  amp: number,
  endTs: number
): Candle[] {
  const out: Candle[] = [];
  const t0 = endTs - count * barMs;
  for (let i = 0; i < count; i++) {
    const wave = Math.sin((i / 7) * Math.PI * 2) * amp;
    const prevWave = Math.sin(((i - 1) / 7) * Math.PI * 2) * amp;
    const o = startPrice + (i - 1) * step + prevWave;
    const c = startPrice + i * step + wave;
    out.push({
      t: t0 + i * barMs,
      o,
      h: Math.max(o, c) + amp * 0.25,
      l: Math.min(o, c) - amp * 0.25,
      c,
      v: i === count - 1 ? 260 : 120,
    });
  }
  return out;
}

describe('Trade Options + Scoring v1.1 + Technical Analysis Integration', () => {
  const now = Date.UTC(2026, 10, 20, 12, 0, 0);
  const c4h = buildBullCandles(120, 4 * 3600_000, 52000, 85, 220, now);
  const c1h = buildBullCandles(280, 3600_000, 56000, 25, 110, now);
  const c15m = buildBullCandles(140, 15 * 60_000, 61600, 10, 45, now);
  const spot = c15m[c15m.length - 1].c;

  const optLevels: Levels = {
    flip: spot - 500,
    maxPain: spot + 800,
    callWall: spot + 2500,
    putWall: spot - 2500,
    netGex: 12_000_000,
    netGamma: 120,
  };

  const liquidity = analyzeMarketLiquidity(c15m, spot, optLevels, null, spot + 600, spot - 600);

  const scoringResult: ScoringResult = evaluateScoringSystem(
    {
      asset: 'BTC',
      instId: 'BTC-USDT-SWAP',
      candles4h: c4h,
      candles1h: c1h,
      candles15m: c15m,
      btcCandles4h: c4h,
      orderbook: null,
      oiSeries1h: c1h.slice(-10).map((c, idx) => ({ ts: c.t, oiUsd: (1500 + idx * 80) * c.c })),
      fundingCurrent8h: 0.0001,
      fundingHistory8h: Array.from({ length: 120 }, (_, i) => (i - 60) * 0.00001),
      fetchedAt: now,
    },
    {
      mode: 'perpetual',
      capitalUsd: 10000,
      riskPct: 0.5,
      feePctPerSide: 0.05,
      slippagePctPerSide: 0.02,
      expectedFundingCostPct: 0.01,
      dailyLossReached: false,
      correlatedRiskExceeded: false,
    }
  );

  it('attaches exact v1.1 scoring assessment, netRR, and 6 opening gates to every trade option', () => {
    const ideas = generateTradingOptions({
      asset: 'BTC',
      timeframe: '15m',
      candles: c15m,
      spot,
      optionsLevels: optLevels,
      cone: null,
      liquidity,
      capitalUsd: 10000,
      riskPct: 0.5,
      scoring: scoringResult,
    });

    expect(ideas.length).toBe(3);
    for (const idea of ideas) {
      expect(idea.scoring).toBeDefined();
      expect(idea.scoring!.gates.length).toBe(6);
      expect(idea.scoring!.netRR).toBeLessThanOrEqual(idea.rr1);
      expect(idea.scoring!.coveragePct).toBe(100);
      expect(typeof idea.scoring!.operable).toBe('boolean');
    }
  });

  it('sorts ideas by operability and v1.1 score and blocks ideas with netRR < 2.0', () => {
    const ideas = generateTradingOptions({
      asset: 'BTC',
      timeframe: '15m',
      candles: c15m,
      spot,
      optionsLevels: optLevels,
      cone: null,
      liquidity,
      capitalUsd: 10000,
      riskPct: 0.5,
      scoring: scoringResult,
    });

    for (const idea of ideas) {
      if (idea.scoring!.netRR < 2.0) {
        expect(idea.scoring!.verdict).toBe('BLOQUEADA');
        expect(idea.scoring!.operable).toBe(false);
      }
    }

    const rank: Record<string, number> = { CANDIDATA: 0, ESPERAR: 1, BLOQUEADA: 2, DESCARTADA: 3 };
    for (let i = 1; i < ideas.length; i++) {
      const prevRank = rank[ideas[i - 1].scoring!.verdict];
      const curRank = rank[ideas[i].scoring!.verdict];
      expect(prevRank).toBeLessThanOrEqual(curRank);
    }
  });

  it('enriches trading options with Confluencia Técnica setup, MTF alignment, VPVR/Fib zones, and rolling macro sensitivity', () => {
    const vp = calculateVolumeProfileBuckets(c15m, 36);
    const sr = detectSupportResistanceZones(c15m, spot);
    const fvgs = detectFairValueGaps(c15m, spot, 6);
    const fib = calculateFibonacciLevels(c15m, 120, 'auto', spot, { anchorMode: 'pivots' });
    const snap = computeTechnicalSnapshot(c15m, vp?.poc ?? null, 12);
    const divs = detectOscillatorDivergences(
      c15m,
      snap.rsi14,
      snap.macd.hist,
      calculateVolumeDeltaSeries(c15m)
    );
    const mtf = evaluateMultiTimeframeMatrix({ '15m': c15m, '1H': c1h, '4H': c4h });
    const confluences = detectConfluenceZones({
      spot,
      srZones: sr,
      fibAnalysis: fib,
      volumeProfile: vp,
      liquidityLevels: liquidity.levels,
      prevDayHigh: spot + 600,
      prevDayLow: spot - 600,
    });

    const ideas = generateTradingOptions({
      asset: 'BTC',
      timeframe: '15m',
      candles: c15m,
      spot,
      optionsLevels: optLevels,
      cone: null,
      liquidity,
      capitalUsd: 10000,
      riskPct: 0.5,
      scoring: scoringResult,
      volumeProfile: vp,
      fibAnalysis: fib,
      fvgs,
      confluences,
      divergences: divs,
      techSnapshot: snap,
      mtfMatrix: mtf,
      macroRegime: {
        sentimentLabel: 'Alcista',
        sentimentScore: 28,
        rollingR: 0.42,
        windowDays: 14,
        volPct: 3.1,
      },
    });

    expect(ideas.length).toBe(4);
    expect(ideas.some((i) => i.category === 'Confluencia Técnica')).toBe(true);
    for (const idea of ideas) {
      expect(idea.technicalAlignment).toBeDefined();
      expect(idea.technicalAlignment!.mtfTotal).toBe(4);
      expect(idea.technicalAlignment!.macroSensitivityNote).toContain('Sensibilidad 14D alta');
    }
  });
});
