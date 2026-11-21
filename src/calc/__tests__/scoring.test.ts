import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import type { MultiTfScoringDataset, ScoringConfig } from '../../types/scoring';
import {
  autoGradeJournalEntry,
  computeCalibrationDashboard,
} from '../scoringJournal';
import { evaluateHistoricalAudit, evaluateScoringSystem } from '../scoringEngine';

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
        instId: 'BTC-USDT',
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

  it('enforces §11 hard blocks for daily loss, high-impact macro event, stale data, and liquidation before stop', () => {
    const bull4h = buildTrendingCandles(120, 4 * 3600_000, 50000, 95, 1200, now);
    const bull1h = buildTrendingCandles(280, 3600_000, 54000, 28, 1600, now);
    const bull15m = buildTrendingCandles(140, 15 * 60_000, 60800, 10, 1400, now);
    const ds: MultiTfScoringDataset = {
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
    };

    const blockedRes = evaluateScoringSystem(ds, {
      ...DEFAULT_CONFIG,
      dailyLossReached: true,
      leverage: 50,
      macroEventWindowHours: 2,
      upcomingEvents: [{ id: 'ev1', date: '2026-11-19', timeUtc: '21:00', ts: now + 3600_000, name: 'CPI US' }],
    });

    expect(blockedRes.longEval.verdict).toBe('BLOQUEADA');
    expect(blockedRes.longEval.blocks.some((b) => b.code === 'LIMITE_DIARIO')).toBe(true);
    expect(blockedRes.longEval.blocks.some((b) => b.code === 'EVENTO_MACRO')).toBe(true);
    expect(blockedRes.longEval.blocks.some((b) => b.code === 'LIQUIDACION_STOP')).toBe(true);

    const staleRes = evaluateScoringSystem({ ...ds, fetchedAt: now + 60 * 60_000 }, DEFAULT_CONFIG);
    expect(staleRes.longEval.blocks.some((b) => b.code === 'DATOS_DESACTUALIZADOS')).toBe(true);
  });

  it('supports pre-locked C3/C2 anchors, Gap-to-80 analysis, causal historical audit, and §14 calibration stats', () => {
    const bull4h = buildTrendingCandles(120, 4 * 3600_000, 50000, 95, 240, now);
    const bull1h = buildTrendingCandles(280, 3600_000, 54000, 28, 120, now);
    const bull15m = buildTrendingCandles(140, 15 * 60_000, 60800, 10, 45, now);

    const ds: MultiTfScoringDataset = {
      asset: 'BTC',
      instId: 'BTC-USDT-SWAP',
      candles4h: bull4h,
      candles1h: bull1h,
      candles15m: bull15m,
      btcCandles4h: bull4h,
      orderbook: null,
      oiSeries1h: bull1h.slice(-10).map((c, idx) => ({ ts: c.t, oiUsd: (2000 + idx * 90) * c.c })),
      fundingCurrent8h: 0.0001,
      fundingHistory8h: Array.from({ length: 120 }, (_, i) => (i - 60) * 0.00001),
      fetchedAt: now,
    };

    const res = evaluateScoringSystem(ds, { ...DEFAULT_CONFIG, vpLevelLock: 'VAH' });
    expect(res.activeVpSelection.lock).toBe('VAH');
    expect(res.activeVpSelection.usedLabel).toContain('VAH');
    expect(res.shortEval.gapTo80.pointsNeeded).toBeGreaterThan(0);

    const audit = evaluateHistoricalAudit(ds, DEFAULT_CONFIG, 12);
    expect(audit.evaluatedBars).toBeGreaterThan(0);
    expect(audit.rows[0].forwardOutcome).not.toBe('PENDIENTE');

    // Auto-grade a sample open journal entry across 16 closed 15m bars & compute §14 calibration
    const entryTs = bull15m[bull15m.length - 20].t;
    const entryPx = bull15m[bull15m.length - 20].c;
    const graded = autoGradeJournalEntry(
      {
        id: 'j-1',
        ts: entryTs,
        asset: 'BTC',
        mode: 'perpetual',
        spot: entryPx,
        longScore: 84,
        shortScore: 40,
        longVerdict: 'CANDIDATA',
        shortVerdict: 'DESCARTADA',
        dominant: 'LONG',
        coveragePct: 100,
        netRR: 2.4,
        entry: entryPx,
        stopLoss: entryPx - 120,
        takeProfit: entryPx + 260,
        blockSummary: 'Sin bloqueos',
        directionTaken: 'LONG',
        chosenScore: 84,
        isControlGroup: false,
        status: 'ABIERTA',
        riskBudgetUsd: 25,
      },
      bull15m,
      0.05,
      0.02,
      0.01
    );
    expect(graded).not.toBeNull();
    expect(graded!.status).toBe('CERRADA');
    expect(typeof graded!.resultR).toBe('number');

    const cal = computeCalibrationDashboard([graded!]);
    expect(cal.closedCount).toBe(1);
    expect(cal.filteredStats.closedTrades).toBe(1);
    expect(cal.bandStats.find((b) => b.bandLabel === '[80, 90)')?.closedTrades).toBe(1);
  });
});
