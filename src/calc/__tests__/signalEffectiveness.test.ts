import { describe, expect, it } from 'vitest';
import {
  auditHistoricalSignalsFromCandles,
  classifySignalStrategyType,
  computeEffectivenessSummary,
  createTrackedSignalFromIdea,
  evaluateSignalAgainstCandles,
  extractTechnicalDrivers,
  mergeSignalsIntoHistory,
} from '../signalEffectiveness';
import type { Candle, TradeOptionIdea } from '../../types/market';

function makeIdea(overrides?: Partial<TradeOptionIdea>): TradeOptionIdea {
  return {
    id: 'setup-tech-confluence-long',
    title: 'Confluencia Técnica Alcista · Golden Pocket Fib',
    category: 'Confluencia Técnica',
    direction: 'LONG',
    confidenceScore: 84,
    entry: 100000,
    quantity: 0.025,
    notionalUsd: 2500,
    riskUsd: 25,
    takeProfit1: 102000,
    takeProfit2: 104000,
    stopLoss: 99000,
    rr1: 2.0,
    rr2: 4.0,
    tp1ProbPct: 48,
    tp2ProbPct: 26,
    tp1Reason: 'POC VPVR',
    tp2Reason: 'VAH VPVR',
    slReason: 'Bajo Fib 78.6%',
    summary: 'Setup de prueba',
    confluences: ['Golden Pocket'],
    scoring: {
      v11Score: 84,
      baseDirectionScore: 80,
      band: 'Candidata',
      verdict: 'CANDIDATA',
      operable: true,
      coveragePct: 95,
      diffVsOpposite: 20,
      netRR: 2.1,
      costToRiskPct: 4,
      gates: [],
      fulfilledConditions: ['F1'],
      blockReasons: [],
    },
    technicalAlignment: {
      mtfAlignedCount: 3,
      mtfTotal: 4,
      scoreDelta: 8,
      alignedFactors: ['Golden Pocket Fib', 'Matriz MTF 3/4'],
      conflictingFactors: [],
      confluenceEntryTag: 'Golden Pocket Fib',
      macroSensitivityNote: null,
    },
    ...overrides,
  };
}

const BASE_TS = 1_760_000_000_000;
const BAR_MS = 15 * 60_000;

describe('signalEffectiveness engine', () => {
  it('grades entry fill followed by TP1 and TP2 as CUMPLIDA_TP2 with 100% index score', () => {
    const sig = createTrackedSignalFromIdea(makeIdea(), {
      asset: 'BTC',
      timeframe: '15m',
      marketMode: 'perpetual',
      candleOpenTs: BASE_TS,
      spotAtSignal: 100400,
      origin: 'live',
    });

    const candles: Candle[] = [
      { t: BASE_TS, o: 100300, h: 100600, l: 100200, c: 100400, v: 10 }, // signal candle (must be ignored)
      { t: BASE_TS + BAR_MS, o: 100350, h: 100450, l: 99900, c: 100500, v: 12 }, // fills 100000 without hitting SL 99000
      { t: BASE_TS + BAR_MS * 2, o: 100500, h: 102200, l: 100400, c: 102100, v: 18 }, // hits TP1 102000
      { t: BASE_TS + BAR_MS * 3, o: 102100, h: 104300, l: 101900, c: 104100, v: 20 }, // hits TP2 104000
    ];

    const graded = evaluateSignalAgainstCandles(sig, candles, 24);
    expect(graded.entryFilled).toBe(true);
    expect(graded.status).toBe('CUMPLIDA_TP2');
    expect(graded.effectivenessPoints).toBe(100);
    expect(graded.tp1HitAt).toBe(BASE_TS + BAR_MS * 2);
    expect(graded.tp2HitAt).toBe(BASE_TS + BAR_MS * 3);
    expect(graded.realizedR).toBe(4);
    expect(graded.trailBars).toHaveLength(3);
  });

  it('grades TP1 hit followed by stop pullback as CUMPLIDA_TP1 with 85% partial fulfillment', () => {
    const sig = createTrackedSignalFromIdea(makeIdea(), {
      asset: 'BTC',
      timeframe: '15m',
      marketMode: 'perpetual',
      candleOpenTs: BASE_TS,
      spotAtSignal: 100200,
    });

    const candles: Candle[] = [
      { t: BASE_TS + BAR_MS, o: 100200, h: 100300, l: 99950, c: 100250, v: 10 }, // fills entry
      { t: BASE_TS + BAR_MS * 2, o: 100250, h: 102150, l: 100100, c: 101900, v: 15 }, // hits TP1
      { t: BASE_TS + BAR_MS * 3, o: 101900, h: 101950, l: 98900, c: 99000, v: 20 }, // retraces to SL before TP2
    ];

    const graded = evaluateSignalAgainstCandles(sig, candles, 24);
    expect(graded.status).toBe('CUMPLIDA_TP1');
    expect(graded.effectivenessPoints).toBe(85);
    expect(graded.realizedR).toBe(2);
  });

  it('uses conservative intrabar stop-first evaluation when SL and TP touch on the same bar', () => {
    const sig = createTrackedSignalFromIdea(makeIdea(), {
      asset: 'BTC',
      timeframe: '15m',
      marketMode: 'perpetual',
      candleOpenTs: BASE_TS,
      spotAtSignal: 100200,
    });

    const candles: Candle[] = [
      { t: BASE_TS + BAR_MS, o: 100200, h: 102500, l: 98800, c: 101000, v: 25 },
    ];

    const graded = evaluateSignalAgainstCandles(sig, candles, 24);
    expect(graded.entryFilled).toBe(true);
    expect(graded.status).toBe('FALLIDA_STOP');
    expect(graded.effectivenessPoints).toBe(0);
    expect(graded.realizedR).toBe(-1);
  });

  it('marks unfilled limit entries after horizonBars as EXPIRADA with null effectivenessPoints', () => {
    const sig = createTrackedSignalFromIdea(makeIdea({ entry: 96000, stopLoss: 95000 }), {
      asset: 'BTC',
      timeframe: '15m',
      marketMode: 'perpetual',
      candleOpenTs: BASE_TS,
      spotAtSignal: 100000,
    });

    const candles: Candle[] = Array.from({ length: 12 }, (_, idx) => ({
      t: BASE_TS + BAR_MS * (idx + 1),
      o: 100000 + idx * 50,
      h: 100200 + idx * 50,
      l: 99800 + idx * 50,
      c: 100100 + idx * 50,
      v: 10,
    }));

    const graded = evaluateSignalAgainstCandles(sig, candles, 12);
    expect(graded.entryFilled).toBe(false);
    expect(graded.status).toBe('EXPIRADA');
    expect(graded.effectivenessPoints).toBeNull();
  });

  it('deduplicates signals cleanly and computes accurate 0-100% summary breakdowns', () => {
    const sigA = createTrackedSignalFromIdea(makeIdea({ id: 'a' }), {
      asset: 'BTC',
      timeframe: '15m',
      marketMode: 'perpetual',
      candleOpenTs: BASE_TS,
      spotAtSignal: 100100,
    });
    const sigACopy = createTrackedSignalFromIdea(makeIdea({ id: 'a' }), {
      asset: 'BTC',
      timeframe: '15m',
      marketMode: 'perpetual',
      candleOpenTs: BASE_TS,
      spotAtSignal: 100100,
    });
    const sigB = createTrackedSignalFromIdea(
      makeIdea({
        id: 'b',
        category: 'Tendencia & Flujo',
        direction: 'SHORT',
        entry: 100000,
        stopLoss: 101000,
        takeProfit1: 98000,
        takeProfit2: 96000,
        technicalAlignment: {
          mtfAlignedCount: 1,
          mtfTotal: 4,
          scoreDelta: -4,
          alignedFactors: [],
          conflictingFactors: ['Contra MTF'],
          confluenceEntryTag: null,
          macroSensitivityNote: null,
        },
      }),
      {
        asset: 'ETH',
        timeframe: '1H',
        marketMode: 'perpetual',
        candleOpenTs: BASE_TS + BAR_MS,
        spotAtSignal: 100000,
      }
    );

    const merged = mergeSignalsIntoHistory([sigA], [sigACopy, sigB]);
    expect(merged).toHaveLength(2);

    const evalA = evaluateSignalAgainstCandles(sigA, [
      { t: BASE_TS + BAR_MS, o: 100000, h: 104500, l: 99900, c: 104200, v: 10 },
      { t: BASE_TS + BAR_MS * 2, o: 104200, h: 104800, l: 103900, c: 104500, v: 10 },
    ]);
    const evalB = evaluateSignalAgainstCandles(sigB, [
      { t: BASE_TS + BAR_MS * 2, o: 100000, h: 101200, l: 99800, c: 101100, v: 10 },
    ]);

    const summary = computeEffectivenessSummary([evalA, evalB]);
    expect(summary.evaluatedCount).toBe(2);
    expect(summary.fulfilledCount).toBe(1);
    expect(summary.stopCount).toBe(1);
    // sigA: TP2 (100), sigB: STOP (0) -> 50%
    expect(summary.effectivenessIndexPct).toBe(50);
    expect(summary.tpHitRatePct).toBe(50);
    expect(summary.byAsset).toHaveLength(2);
    expect(summary.byTechAlignment).toHaveLength(2);
    expect(summary.timeline).toHaveLength(2);
    expect(summary.timeline[0].cumulativeIndexPct).toBe(100);
    expect(summary.timeline[1].cumulativeIndexPct).toBe(50);
  });

  it('generates and grades historical signals walk-forward from OHLCV candles', () => {
    const candles: Candle[] = Array.from({ length: 160 }, (_, idx) => {
      const wave = Math.sin(idx / 8) * 1200 + idx * 35;
      const base = 90000 + wave;
      return {
        t: BASE_TS + idx * BAR_MS,
        o: base - 120,
        h: base + 350,
        l: base - 320,
        c: base + 90,
        v: 100 + (idx % 12) * 15,
      };
    });

    const audited = auditHistoricalSignalsFromCandles({
      asset: 'BTC',
      timeframe: '15m',
      marketMode: 'perpetual',
      candles,
      horizonBars: 20,
      stepBars: 10,
    });

    expect(audited.length).toBeGreaterThan(0);
    expect(audited.every((s) => s.origin === 'audit')).toBe(true);
    expect(audited.some((s) => s.barsObserved > 0)).toBe(true);
  });

  it('classifies strategy signal types, extracts technical drivers, and computes stacked percentages summing to 100%', () => {
    const sigSupport = createTrackedSignalFromIdea(
      makeIdea({
        id: 'setup-sweep-long',
        title: 'Barrido de Liquidez (SSL / Muro Bid)',
        category: 'Barrido de Liquidez',
      }),
      {
        asset: 'BTC',
        timeframe: '15m',
        marketMode: 'perpetual',
        candleOpenTs: BASE_TS,
        spotAtSignal: 100100,
      }
    );
    const sigSeller = createTrackedSignalFromIdea(
      makeIdea({
        id: 'setup-trend-short',
        title: 'Continuación Bajista bajo Nube EMA y VWAP',
        category: 'Tendencia & Flujo',
        direction: 'SHORT',
        entry: 100000,
        stopLoss: 101000,
        takeProfit1: 98000,
        takeProfit2: 96000,
        technicalAlignment: {
          mtfAlignedCount: 3,
          mtfTotal: 4,
          scoreDelta: 6,
          alignedFactors: ['Matriz MTF 3/4 TF alineados', 'Flujo Taker vendedor (64%)'],
          conflictingFactors: [],
          confluenceEntryTag: null,
          macroSensitivityNote: null,
        },
      }),
      {
        asset: 'ETH',
        timeframe: '15m',
        marketMode: 'perpetual',
        candleOpenTs: BASE_TS,
        spotAtSignal: 100000,
      }
    );

    expect(classifySignalStrategyType(sigSupport).label).toBe('Rebote en Soporte (SSL/Bid)');
    expect(classifySignalStrategyType(sigSeller).label).toBe('Fuerza de Vendedor (EMA/VWAP)');
    expect(extractTechnicalDrivers(sigSeller).map((d) => d.key)).toEqual(
      expect.arrayContaining(['mtf', 'taker'])
    );

    const evalSupport = evaluateSignalAgainstCandles(sigSupport, [
      { t: BASE_TS + BAR_MS, o: 100100, h: 102200, l: 99950, c: 102050, v: 10 },
      { t: BASE_TS + BAR_MS * 2, o: 102050, h: 104200, l: 101900, c: 104100, v: 12 },
    ]);
    const evalSeller = evaluateSignalAgainstCandles(sigSeller, [
      { t: BASE_TS + BAR_MS, o: 100000, h: 101200, l: 99700, c: 101050, v: 10 },
    ]);

    const summary = computeEffectivenessSummary([evalSupport, evalSeller]);
    expect(summary.bySignalType).toHaveLength(2);
    expect(summary.byTechnicalDriver.length).toBeGreaterThanOrEqual(2);

    for (const item of summary.bySignalType) {
      const pctSum =
        item.tp2Pct +
        item.tp1Pct +
        item.expiredFavPct +
        item.expiredUnfavPct +
        item.stopPct;
      expect(pctSum).toBeCloseTo(100, 1);
    }
  });
});
