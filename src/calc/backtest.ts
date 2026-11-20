import type {
  BacktestMetrics,
  BacktestOrder,
  BacktestOutput,
  BacktestParams,
  BacktestTrade,
  Candle,
  EquityPoint,
  Timeframe,
} from '../types/market';
import { calculateBollinger, calculateEMA, calculateRSI } from './indicators';

const BARS_PER_DAY: Record<Timeframe, number> = {
  '1m': 1440,
  '5m': 288,
  '15m': 96,
  '30m': 48,
  '1H': 24,
  '4H': 6,
  D: 1,
};

function getBarMs(timeframe: Timeframe): number {
  return (24 * 60 * 60 * 1000) / BARS_PER_DAY[timeframe];
}

export function computeMetricsFromSegment(
  points: EquityPoint[],
  trades: BacktestTrade[],
  timeframe: Timeframe
): BacktestMetrics {
  if (points.length < 2) {
    const startEq = points[0]?.equity ?? 0;
    return {
      totalReturnPct: 0,
      benchmarkReturnPct: 0,
      winDaysPct: 0,
      sharpe: 0,
      maxDrawdownPct: 0,
      avgDrawdownPct: 0,
      avgDrawdownDays: 0,
      beta: 0,
      alphaPct: 0,
      tradeCount: trades.length,
      winRatePct: 0,
      profitFactor: 0,
      expectancyUsd: 0,
      expectancyPct: 0,
      finalEquity: startEq,
    };
  }

  const startEq = points[0].equity;
  const endEq = points[points.length - 1].equity;
  const totalReturnPct = startEq > 0 ? ((endEq / startEq) - 1) * 100 : 0;

  const startBench = points[0].benchmark;
  const endBench = points[points.length - 1].benchmark;
  const benchmarkReturnPct = startBench > 0 ? ((endBench / startBench) - 1) * 100 : 0;

  // Bar returns r_s and benchmark returns r_b
  const stratReturns: number[] = [];
  const benchReturns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prevEq = points[i - 1].equity;
    const prevB = points[i - 1].benchmark;
    stratReturns.push(prevEq > 0 ? (points[i].equity - prevEq) / prevEq : 0);
    benchReturns.push(prevB > 0 ? (points[i].benchmark - prevB) / prevB : 0);
  }

  // Sharpe = sqrt(N) * mean(r) / std(r), N = 365 * barsPerDay
  const N = 365 * BARS_PER_DAY[timeframe];
  const nRet = stratReturns.length;
  const meanS = nRet > 0 ? stratReturns.reduce((a, b) => a + b, 0) / nRet : 0;
  const meanB = nRet > 0 ? benchReturns.reduce((a, b) => a + b, 0) / nRet : 0;

  let varS = 0;
  let varB = 0;
  let covSB = 0;
  for (let i = 0; i < nRet; i++) {
    const ds = stratReturns[i] - meanS;
    const db = benchReturns[i] - meanB;
    varS += ds * ds;
    varB += db * db;
    covSB += ds * db;
  }
  const stdS = nRet > 1 ? Math.sqrt(varS / (nRet - 1)) : 0;
  const sharpe = stdS > 1e-12 ? Math.sqrt(N) * (meanS / stdS) : 0;

  const beta = varB > 1e-14 ? covSB / varB : 0;
  const alphaPerBar = meanS - beta * meanB;
  const alphaPct = alphaPerBar * N * 100;

  // Drawdown over this segment (recomputed relative to segment peak)
  let peak = points[0].equity;
  let maxDd = 0;
  let ddSum = 0;
  let ddCount = 0;
  const episodeDurationsDays: number[] = [];
  let ddStartTs: number | null = null;

  for (let i = 0; i < points.length; i++) {
    const eq = points[i].equity;
    if (eq >= peak) {
      if (ddStartTs !== null) {
        episodeDurationsDays.push((points[i].t - ddStartTs) / (1000 * 60 * 60 * 24));
        ddStartTs = null;
      }
      peak = eq;
    } else {
      if (ddStartTs === null) {
        ddStartTs = points[i].t;
      }
      const dd = peak > 0 ? (eq / peak - 1) * 100 : 0;
      if (dd < maxDd) maxDd = dd;
      ddSum += dd;
      ddCount++;
    }
  }
  if (ddStartTs !== null) {
    episodeDurationsDays.push(
      (points[points.length - 1].t - ddStartTs) / (1000 * 60 * 60 * 24)
    );
  }

  const avgDrawdownPct = ddCount > 0 ? ddSum / ddCount : 0;
  const avgDrawdownDays =
    episodeDurationsDays.length > 0
      ? episodeDurationsDays.reduce((a, b) => a + b, 0) / episodeDurationsDays.length
      : 0;

  // Win days (% of UTC calendar days with positive strategy return)
  const dayBounds = new Map<string, { first: number; last: number }>();
  for (const p of points) {
    const dayKey = new Date(p.t).toISOString().slice(0, 10);
    const existing = dayBounds.get(dayKey);
    if (!existing) {
      dayBounds.set(dayKey, { first: p.equity, last: p.equity });
    } else {
      existing.last = p.equity;
    }
  }
  const dayList = Array.from(dayBounds.values());
  const winDays = dayList.filter((d) => d.last > d.first).length;
  const winDaysPct = dayList.length > 0 ? (winDays / dayList.length) * 100 : 0;

  // Trade quality metrics
  const tradeCount = trades.length;
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const winRatePct = tradeCount > 0 ? (wins.length / tradeCount) * 100 : 0;

  const grossProfit = wins.reduce((a, t) => a + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnlUsd, 0));
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.99 : 0;

  const expectancyUsd =
    tradeCount > 0 ? trades.reduce((a, t) => a + t.pnlUsd, 0) / tradeCount : 0;
  const expectancyPct =
    tradeCount > 0 ? trades.reduce((a, t) => a + t.pnlPct, 0) / tradeCount : 0;

  return {
    totalReturnPct,
    benchmarkReturnPct,
    winDaysPct,
    sharpe,
    maxDrawdownPct: maxDd,
    avgDrawdownPct,
    avgDrawdownDays,
    beta,
    alphaPct,
    tradeCount,
    winRatePct,
    profitFactor,
    expectancyUsd,
    expectancyPct,
    finalEquity: endEq,
  };
}

/**
 * Pure backtest engine.
 * - Signal calculated at bar `t` close.
 * - Order executed at bar `t + 1` open (no look-ahead bias).
 * - One position at a time, position size as % of equity, reinvesting profits, no leverage.
 */
export function runBacktest(candles: Candle[], params: BacktestParams): BacktestOutput {
  if (candles.length < 3) {
    const emptyMetrics = computeMetricsFromSegment([], [], params.timeframe);
    return {
      equityCurve: [],
      orders: [],
      trades: [],
      totalMetrics: emptyMetrics,
      inSampleMetrics: emptyMetrics,
      outOfSampleMetrics: emptyMetrics,
      splitTimestamp: candles[0]?.t ?? 0,
      candleCount: candles.length,
    };
  }

  const closes = candles.map((c) => c.c);
  const len = candles.length;

  // Precompute indicator arrays (strictly causal at index t)
  const emaFast = calculateEMA(closes, params.emaFast);
  const emaSlow = calculateEMA(closes, params.emaSlow);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const rsi = calculateRSI(closes, params.rsiPeriod);
  const bb = calculateBollinger(closes, params.bbPeriod, params.bbStdDev);

  const commRate = Math.max(0, params.commissionPct) / 100;
  const slipRate = Math.max(0, params.slippagePct) / 100;
  const sizeFrac = Math.max(0.01, Math.min(1, params.positionSizePct / 100));
  const barHours = getBarMs(params.timeframe) / (1000 * 60 * 60);

  let cash = params.initialCapital;
  let position: {
    direction: 'LONG' | 'SHORT';
    qty: number;
    entryPrice: number;
    entryTs: number;
    entryBarIdx: number;
    entryFee: number;
    collateral: number;
    stopPrice: number | null;
    targetPrice: number | null;
  } | null = null;

  type PendingAction =
    | { type: 'ENTER_LONG'; reason: string }
    | { type: 'ENTER_SHORT'; reason: string }
    | { type: 'EXIT'; reason: string }
    | null;

  let pending: PendingAction = null;

  const orders: BacktestOrder[] = [];
  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  const firstBenchPrice = candles[0].o;
  let peakEquity = params.initialCapital;
  let orderIdSeq = 1;
  let tradeIdSeq = 1;

  for (let i = 0; i < len; i++) {
    const bar = candles[i];

    // 1. Execute any pending order from bar i-1 close at bar i OPEN
    if (pending !== null) {
      if (pending.type === 'EXIT' && position !== null) {
        const execPrice =
          position.direction === 'LONG'
            ? bar.o * (1 - slipRate)
            : bar.o * (1 + slipRate);
        const exitNotional = position.qty * execPrice;
        const exitFee = exitNotional * commRate;

        const grossPnl =
          position.direction === 'LONG'
            ? (execPrice - position.entryPrice) * position.qty
            : (position.entryPrice - execPrice) * position.qty;

        cash += position.collateral + grossPnl - exitFee;
        const netPnl = grossPnl - position.entryFee - exitFee;
        const entryNotional = position.qty * position.entryPrice;
        const pnlPct = entryNotional > 0 ? (netPnl / entryNotional) * 100 : 0;

        orders.push({
          id: orderIdSeq++,
          ts: bar.t,
          side: position.direction === 'LONG' ? 'SELL' : 'BUY',
          action: position.direction === 'LONG' ? 'EXIT_LONG' : 'EXIT_SHORT',
          price: execPrice,
          qty: position.qty,
          notional: exitNotional,
          fee: exitFee,
          reason: pending.reason,
        });

        trades.push({
          id: tradeIdSeq++,
          direction: position.direction,
          entryTs: position.entryTs,
          exitTs: bar.t,
          entryPrice: position.entryPrice,
          exitPrice: execPrice,
          qty: position.qty,
          pnlUsd: netPnl,
          pnlPct,
          feesUsd: position.entryFee + exitFee,
          durationBars: i - position.entryBarIdx,
          durationHours: (i - position.entryBarIdx) * barHours,
          exitReason: pending.reason,
        });

        position = null;
      } else if (
        (pending.type === 'ENTER_LONG' || pending.type === 'ENTER_SHORT') &&
        position === null &&
        cash > 0
      ) {
        const dir: 'LONG' | 'SHORT' = pending.type === 'ENTER_LONG' ? 'LONG' : 'SHORT';
        const execPrice =
          dir === 'LONG' ? bar.o * (1 + slipRate) : bar.o * (1 - slipRate);
        const allocatedEquity = cash * sizeFrac;
        // Reserve fee inside allocated equity so total never goes negative: notional + notional * commRate = allocatedEquity
        const entryNotional = allocatedEquity / (1 + commRate);
        const qty = execPrice > 0 ? entryNotional / execPrice : 0;
        const entryFee = entryNotional * commRate;

        if (qty > 0) {
          cash -= entryNotional + entryFee;

          let stopPrice: number | null = null;
          let targetPrice: number | null = null;
          if (params.stopPct !== null && params.stopPct > 0) {
            const stopFrac = params.stopPct / 100;
            stopPrice =
              dir === 'LONG'
                ? execPrice * (1 - stopFrac)
                : execPrice * (1 + stopFrac);
            if (params.targetR !== null && params.targetR > 0) {
              const riskDist = execPrice * stopFrac;
              targetPrice =
                dir === 'LONG'
                  ? execPrice + riskDist * params.targetR
                  : execPrice - riskDist * params.targetR;
            }
          } else if (params.targetR !== null && params.targetR > 0) {
            // If no stop %, targetR acts as % target fallback
            const tFrac = params.targetR / 100;
            targetPrice =
              dir === 'LONG' ? execPrice * (1 + tFrac) : execPrice * (1 - tFrac);
          }

          position = {
            direction: dir,
            qty,
            entryPrice: execPrice,
            entryTs: bar.t,
            entryBarIdx: i,
            entryFee,
            collateral: entryNotional,
            stopPrice,
            targetPrice,
          };

          orders.push({
            id: orderIdSeq++,
            ts: bar.t,
            side: dir === 'LONG' ? 'BUY' : 'SELL',
            action: dir === 'LONG' ? 'ENTRY_LONG' : 'ENTRY_SHORT',
            price: execPrice,
            qty,
            notional: entryNotional,
            fee: entryFee,
            reason: pending.reason,
          });
        }
      }
      pending = null;
    }

    // 2. Intra-bar Stop / Target check on bar i (if position is open)
    if (position !== null) {
      let triggeredPrice: number | null = null;
      let triggeredReason: string | null = null;

      if (position.direction === 'LONG') {
        if (position.stopPrice !== null && bar.l <= position.stopPrice) {
          triggeredPrice = Math.min(bar.o, position.stopPrice) * (1 - slipRate);
          triggeredReason = 'Stop Loss';
        } else if (position.targetPrice !== null && bar.h >= position.targetPrice) {
          triggeredPrice = Math.max(bar.o, position.targetPrice) * (1 - slipRate);
          triggeredReason = 'Take Profit';
        }
      } else {
        if (position.stopPrice !== null && bar.h >= position.stopPrice) {
          triggeredPrice = Math.max(bar.o, position.stopPrice) * (1 + slipRate);
          triggeredReason = 'Stop Loss';
        } else if (position.targetPrice !== null && bar.l <= position.targetPrice) {
          triggeredPrice = Math.min(bar.o, position.targetPrice) * (1 + slipRate);
          triggeredReason = 'Take Profit';
        }
      }

      if (triggeredPrice !== null && triggeredReason !== null) {
        const exitNotional = position.qty * triggeredPrice;
        const exitFee = exitNotional * commRate;
        const grossPnl =
          position.direction === 'LONG'
            ? (triggeredPrice - position.entryPrice) * position.qty
            : (position.entryPrice - triggeredPrice) * position.qty;

        cash += position.collateral + grossPnl - exitFee;
        const netPnl = grossPnl - position.entryFee - exitFee;
        const entryNotional = position.qty * position.entryPrice;
        const pnlPct = entryNotional > 0 ? (netPnl / entryNotional) * 100 : 0;

        orders.push({
          id: orderIdSeq++,
          ts: bar.t,
          side: position.direction === 'LONG' ? 'SELL' : 'BUY',
          action: position.direction === 'LONG' ? 'EXIT_LONG' : 'EXIT_SHORT',
          price: triggeredPrice,
          qty: position.qty,
          notional: exitNotional,
          fee: exitFee,
          reason: triggeredReason,
        });

        trades.push({
          id: tradeIdSeq++,
          direction: position.direction,
          entryTs: position.entryTs,
          exitTs: bar.t,
          entryPrice: position.entryPrice,
          exitPrice: triggeredPrice,
          qty: position.qty,
          pnlUsd: netPnl,
          pnlPct,
          feesUsd: position.entryFee + exitFee,
          durationBars: i - position.entryBarIdx,
          durationHours: (i - position.entryBarIdx) * barHours,
          exitReason: triggeredReason,
        });

        position = null;
      }
    }

    // 3. Mark-to-market equity at bar i close
    let mtmEquity = cash;
    if (position !== null) {
      const unrealized =
        position.direction === 'LONG'
          ? (bar.c - position.entryPrice) * position.qty
          : (position.entryPrice - bar.c) * position.qty;
      mtmEquity += position.collateral + unrealized;
    }
    if (mtmEquity > peakEquity) peakEquity = mtmEquity;
    const ddPct = peakEquity > 0 ? (mtmEquity / peakEquity - 1) * 100 : 0;
    const benchmarkEq =
      firstBenchPrice > 0 ? params.initialCapital * (bar.c / firstBenchPrice) : params.initialCapital;

    equityCurve.push({
      t: bar.t,
      equity: mtmEquity,
      benchmark: benchmarkEq,
      drawdownPct: ddPct,
    });

    // 4. Evaluate signal at bar i close -> queued for bar i + 1 open
    if (i >= len - 1) continue; // Cannot execute past last bar

    if (params.template === 'ema_cross') {
      const f = emaFast[i];
      const s = emaSlow[i];
      const fPrev = i > 0 ? emaFast[i - 1] : null;
      const sPrev = i > 0 ? emaSlow[i - 1] : null;
      if (f !== null && s !== null && fPrev !== null && sPrev !== null) {
        if (position === null && fPrev <= sPrev && f > s) {
          pending = { type: 'ENTER_LONG', reason: `Cruce EMA ${params.emaFast}/${params.emaSlow}` };
        } else if (position !== null && f < s) {
          pending = { type: 'EXIT', reason: 'Cruce EMA inverso' };
        }
      }
    } else if (params.template === 'momentum') {
      const n = Math.max(1, params.momentumBars);
      if (i >= n) {
        const mom = bar.c - candles[i - n].c;
        if (position === null && mom > 0) {
          pending = { type: 'ENTER_LONG', reason: `Momentum (${n}) > 0` };
        } else if (position !== null && mom <= 0) {
          pending = { type: 'EXIT', reason: `Momentum (${n}) ≤ 0` };
        }
      }
    } else if (params.template === 'rsi_reversion') {
      const val = rsi[i];
      if (val !== null) {
        if (position === null) {
          if (val < params.rsiOversold) {
            pending = { type: 'ENTER_LONG', reason: `RSI < ${params.rsiOversold}` };
          } else if (params.rsiShortSymmetric && val > 100 - params.rsiOversold) {
            pending = {
              type: 'ENTER_SHORT',
              reason: `RSI > ${100 - params.rsiOversold}`,
            };
          }
        } else if (position.direction === 'LONG' && val > params.rsiExit) {
          pending = { type: 'EXIT', reason: `RSI > ${params.rsiExit}` };
        } else if (position.direction === 'SHORT' && val < 100 - params.rsiExit) {
          pending = { type: 'EXIT', reason: `RSI < ${100 - params.rsiExit}` };
        }
      }
    } else if (params.template === 'bollinger_breakout') {
      const up = bb.upper[i];
      const mid = bb.middle[i];
      if (up !== null && mid !== null) {
        if (position === null && bar.c > up) {
          pending = { type: 'ENTER_LONG', reason: 'Ruptura Bollinger Sup.' };
        } else if (position !== null && bar.c < mid) {
          pending = { type: 'EXIT', reason: 'Cierre < Media Bollinger' };
        }
      }
    } else if (params.template === 'ema_cloud') {
      const f = ema9[i];
      const s = ema21[i];
      if (f !== null && s !== null) {
        const cloudGreen = f > s;
        if (position === null && cloudGreen && bar.c > f) {
          pending = { type: 'ENTER_LONG', reason: 'Precio > Nube EMA verde' };
        } else if (position !== null && (!cloudGreen || bar.c < s)) {
          pending = { type: 'EXIT', reason: 'Salida Nube EMA' };
        }
      }
    }
  }

  // Split 70% Ajuste (In-Sample) / 30% Validación (Out-of-Sample)
  const splitIdx = Math.max(2, Math.floor(equityCurve.length * 0.7));
  const splitTimestamp = equityCurve[splitIdx]?.t ?? candles[len - 1].t;

  const inSamplePoints = equityCurve.slice(0, splitIdx);
  const outOfSamplePoints = equityCurve.slice(splitIdx);

  const inSampleTrades = trades.filter((t) => t.exitTs <= splitTimestamp);
  const outOfSampleTrades = trades.filter((t) => t.exitTs > splitTimestamp);

  const totalMetrics = computeMetricsFromSegment(equityCurve, trades, params.timeframe);
  const inSampleMetrics = computeMetricsFromSegment(
    inSamplePoints,
    inSampleTrades,
    params.timeframe
  );
  const outOfSampleMetrics = computeMetricsFromSegment(
    outOfSamplePoints,
    outOfSampleTrades,
    params.timeframe
  );

  return {
    equityCurve,
    orders,
    trades,
    totalMetrics,
    inSampleMetrics,
    outOfSampleMetrics,
    splitTimestamp,
    candleCount: candles.length,
  };
}

export type SensitivityCell = {
  xVal: number;
  yVal: number;
  totalReturnPct: number;
  inSampleSharpe: number;
  outOfSampleSharpe: number;
  inSampleReturnPct: number;
  outOfSampleReturnPct: number;
  tradeCount: number;
};

export type SensitivityGridResult = {
  xLabel: string;
  yLabel: string;
  xValues: number[];
  yValues: number[];
  cells: SensitivityCell[][]; // [yIdx][xIdx]
};

export function runSensitivitySweep(
  candles: Candle[],
  baseParams: BacktestParams
): SensitivityGridResult {
  let xLabel = 'EMA rápida';
  let yLabel = 'EMA lenta';
  let xValues: number[] = [5, 7, 9, 12, 15];
  let yValues: number[] = [18, 21, 26, 34, 50];

  const applyPair = (x: number, y: number): BacktestParams => {
    if (baseParams.template === 'ema_cross') {
      return { ...baseParams, emaFast: x, emaSlow: Math.max(x + 2, y) };
    }
    if (baseParams.template === 'momentum') {
      return { ...baseParams, momentumBars: x, stopPct: y > 0 ? y : null };
    }
    if (baseParams.template === 'rsi_reversion') {
      return { ...baseParams, rsiOversold: x, rsiExit: Math.max(x + 10, y) };
    }
    if (baseParams.template === 'bollinger_breakout') {
      return { ...baseParams, bbPeriod: x, bbStdDev: y };
    }
    // ema_cloud: sweep stop % vs target R
    return { ...baseParams, stopPct: x > 0 ? x : null, targetR: y > 0 ? y : null };
  };

  if (baseParams.template === 'momentum') {
    xLabel = 'Barras N';
    yLabel = 'Stop % (0=off)';
    xValues = [5, 8, 10, 14, 20];
    yValues = [0, 1.5, 2.5, 4, 6];
  } else if (baseParams.template === 'rsi_reversion') {
    xLabel = 'RSI entrada <';
    yLabel = 'RSI salida >';
    xValues = [20, 25, 30, 35, 40];
    yValues = [45, 50, 55, 60, 65];
  } else if (baseParams.template === 'bollinger_breakout') {
    xLabel = 'Periodo BB';
    yLabel = 'Desv. est.';
    xValues = [10, 15, 20, 25, 30];
    yValues = [1.5, 1.8, 2.0, 2.3, 2.6];
  } else if (baseParams.template === 'ema_cloud') {
    xLabel = 'Stop % (0=off)';
    yLabel = 'Objetivo R';
    xValues = [0, 1.5, 2.5, 3.5, 5];
    yValues = [1.5, 2.0, 2.5, 3.0, 4.0];
  }

  const cells: SensitivityCell[][] = yValues.map((yVal) =>
    xValues.map((xVal) => {
      const p = applyPair(xVal, yVal);
      const out = runBacktest(candles, p);
      return {
        xVal,
        yVal,
        totalReturnPct: out.totalMetrics.totalReturnPct,
        inSampleSharpe: out.inSampleMetrics.sharpe,
        outOfSampleSharpe: out.outOfSampleMetrics.sharpe,
        inSampleReturnPct: out.inSampleMetrics.totalReturnPct,
        outOfSampleReturnPct: out.outOfSampleMetrics.totalReturnPct,
        tradeCount: out.totalMetrics.tradeCount,
      };
    })
  );

  return { xLabel, yLabel, xValues, yValues, cells };
}

