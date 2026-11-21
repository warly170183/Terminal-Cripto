import type { Candle } from '../types/market';
import type {
  CalibrationBandStats,
  CalibrationDashboardStats,
  CalibrationGroupStats,
  JournalExitReason,
  ScoringJournalEntry,
} from '../types/scoring';

export function resolveChosenDirection(entry: ScoringJournalEntry): 'LONG' | 'SHORT' {
  if (entry.directionTaken) return entry.directionTaken;
  return entry.shortScore > entry.longScore ? 'SHORT' : 'LONG';
}

export function resolveChosenScore(entry: ScoringJournalEntry): number {
  if (typeof entry.chosenScore === 'number') return entry.chosenScore;
  const dir = resolveChosenDirection(entry);
  return dir === 'SHORT' ? entry.shortScore : entry.longScore;
}

export function resolveIsControlGroup(entry: ScoringJournalEntry): boolean {
  if (typeof entry.isControlGroup === 'boolean') return entry.isControlGroup;
  const dir = resolveChosenDirection(entry);
  const verdict = dir === 'SHORT' ? entry.shortVerdict : entry.longVerdict;
  return verdict !== 'CANDIDATA';
}

/**
 * Evaluates a logged journal entry against subsequent closed 15m OKX candles
 * using the v1.1 §13 16-bar (4h) time-stop horizon.
 */
export function autoGradeJournalEntry(
  entry: ScoringJournalEntry,
  candles15m: Candle[],
  feePctPerSide: number,
  slippagePctPerSide: number,
  expectedFundingCostPct: number
): ScoringJournalEntry | null {
  if (entry.entry == null || entry.stopLoss == null || entry.takeProfit == null) {
    return null;
  }
  const dir = resolveChosenDirection(entry);
  const isLong = dir === 'LONG';

  // Only inspect closed 15m candles whose open timestamp is strictly after evaluation snapshot
  const futureBars = candles15m.filter((c) => c.t > entry.ts).slice(0, 16);
  if (futureBars.length === 0) return null;

  const entryPx = entry.entry;
  const stopPx = entry.stopLoss;
  const tpPx = entry.takeProfit;
  const stopDist = Math.abs(entryPx - stopPx);
  if (stopDist <= 0) return null;

  const roundTripCostRate =
    (feePctPerSide * 2 +
      slippagePctPerSide * 2 +
      (entry.mode === 'perpetual' ? expectedFundingCostPct : 0)) /
    100;
  const costPerUnit = entryPx * roundTripCostRate;
  const netRiskPerUnit = stopDist + costPerUnit;
  const costsInR = netRiskPerUnit > 0 ? costPerUnit / netRiskPerUnit : 0;

  let exitReason: JournalExitReason | null = null;
  let exitPrice = futureBars[futureBars.length - 1].c;
  let closedAt = futureBars[futureBars.length - 1].t + 15 * 60_000;
  let worstAdverse = 0;
  let bestFavorable = 0;

  for (const bar of futureBars) {
    const fav = isLong ? bar.h - entryPx : entryPx - bar.l;
    const adv = isLong ? entryPx - bar.l : bar.h - entryPx;
    if (fav > bestFavorable) bestFavorable = fav;
    if (adv > worstAdverse) worstAdverse = adv;

    const hitStop = isLong ? bar.l <= stopPx : bar.h >= stopPx;
    const hitTp = isLong ? bar.h >= tpPx : bar.l <= tpPx;
    if (hitStop) {
      exitReason = 'STOP';
      exitPrice = stopPx;
      closedAt = bar.t + 15 * 60_000;
      break;
    }
    if (hitTp) {
      exitReason = 'TP1';
      exitPrice = tpPx;
      closedAt = bar.t + 15 * 60_000;
      break;
    }
  }

  if (!exitReason) {
    if (futureBars.length < 16) {
      // Still open within the 16-bar window; update interim MAE/MFE
      return {
        ...entry,
        directionTaken: dir,
        chosenScore: resolveChosenScore(entry),
        isControlGroup: resolveIsControlGroup(entry),
        status: 'ABIERTA',
        maeR: Number((worstAdverse / netRiskPerUnit).toFixed(2)),
        mfeR: Number((bestFavorable / netRiskPerUnit).toFixed(2)),
        costsInR: Number(costsInR.toFixed(3)),
      };
    }
    exitReason = 'TEMPORAL_16V';
  }

  const grossMove = isLong ? exitPrice - entryPx : entryPx - exitPrice;
  const resultR = Number(((grossMove - costPerUnit) / netRiskPerUnit).toFixed(2));
  const riskBudget = entry.riskBudgetUsd ?? 25;
  const pnlUsd = Number((resultR * riskBudget).toFixed(2));

  return {
    ...entry,
    directionTaken: dir,
    chosenScore: resolveChosenScore(entry),
    isControlGroup: resolveIsControlGroup(entry),
    status: 'CERRADA',
    exitReason,
    exitPrice,
    closedAt,
    resultR,
    pnlUsd,
    costsInR: Number(costsInR.toFixed(3)),
    maeR: Number((worstAdverse / netRiskPerUnit).toFixed(2)),
    mfeR: Number((bestFavorable / netRiskPerUnit).toFixed(2)),
  };
}

function computeGroupStats(label: string, entries: ScoringJournalEntry[]): CalibrationGroupStats {
  const closed = entries
    .filter((e) => e.status === 'CERRADA' && typeof e.resultR === 'number')
    .sort((a, b) => a.ts - b.ts);

  if (closed.length === 0) {
    return {
      label,
      closedTrades: 0,
      wins: 0,
      winRatePct: 0,
      expectancyR: 0,
      profitFactor: null,
      maxDrawdownR: 0,
      avgCostsR: 0,
      totalPnlUsd: 0,
      totalR: 0,
    };
  }

  let wins = 0;
  let grossWinR = 0;
  let grossLossR = 0;
  let totalR = 0;
  let totalPnlUsd = 0;
  let totalCostsR = 0;
  let costCount = 0;

  let cumR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;

  for (const e of closed) {
    const r = e.resultR ?? 0;
    totalR += r;
    totalPnlUsd += e.pnlUsd ?? 0;
    if (r > 0) {
      wins++;
      grossWinR += r;
    } else if (r < 0) {
      grossLossR += Math.abs(r);
    }
    if (typeof e.costsInR === 'number') {
      totalCostsR += e.costsInR;
      costCount++;
    }
    cumR += r;
    if (cumR > peakR) peakR = cumR;
    const dd = peakR - cumR;
    if (dd > maxDrawdownR) maxDrawdownR = dd;
  }

  return {
    label,
    closedTrades: closed.length,
    wins,
    winRatePct: (100 * wins) / closed.length,
    expectancyR: totalR / closed.length,
    profitFactor: grossLossR > 0 ? grossWinR / grossLossR : grossWinR > 0 ? Infinity : null,
    maxDrawdownR,
    avgCostsR: costCount > 0 ? totalCostsR / costCount : 0,
    totalPnlUsd,
    totalR,
  };
}

export function computeCalibrationDashboard(
  entries: ScoringJournalEntry[]
): CalibrationDashboardStats {
  const closedEntries = entries.filter(
    (e) => e.status === 'CERRADA' && typeof e.resultR === 'number'
  );
  const openCount = entries.filter((e) => (e.status ?? 'ABIERTA') === 'ABIERTA').length;

  const filteredEntries = closedEntries.filter((e) => !resolveIsControlGroup(e));
  const controlEntries = closedEntries.filter((e) => resolveIsControlGroup(e));

  const bands: CalibrationBandStats['bandLabel'][] = [
    '[90, 100]',
    '[80, 90)',
    '[70, 80)',
    '< 70',
  ];

  const bandStats: CalibrationBandStats[] = bands.map((bandLabel) => {
    const matching = closedEntries.filter((e) => {
      const s = resolveChosenScore(e);
      if (bandLabel === '[90, 100]') return s >= 90;
      if (bandLabel === '[80, 90)') return s >= 80 && s < 90;
      if (bandLabel === '[70, 80)') return s >= 70 && s < 80;
      return s < 70;
    });

    if (matching.length === 0) {
      return {
        bandLabel,
        closedTrades: 0,
        winRatePct: 0,
        expectancyR: 0,
        avgMaeR: 0,
        avgMfeR: 0,
      };
    }

    const wins = matching.filter((e) => (e.resultR ?? 0) > 0).length;
    const sumR = matching.reduce((s, e) => s + (e.resultR ?? 0), 0);
    const maes = matching.map((e) => e.maeR).filter((v): v is number => typeof v === 'number');
    const mfes = matching.map((e) => e.mfeR).filter((v): v is number => typeof v === 'number');

    return {
      bandLabel,
      closedTrades: matching.length,
      winRatePct: (100 * wins) / matching.length,
      expectancyR: sumR / matching.length,
      avgMaeR: maes.length > 0 ? maes.reduce((a, b) => a + b, 0) / maes.length : 0,
      avgMfeR: mfes.length > 0 ? mfes.reduce((a, b) => a + b, 0) / mfes.length : 0,
    };
  });

  return {
    totalEntries: entries.length,
    openCount,
    closedCount: closedEntries.length,
    filteredStats: computeGroupStats('Sistema v1.1 (Filtradas)', filteredEntries),
    controlStats: computeGroupStats('Grupo de Control', controlEntries),
    bandStats,
  };
}
