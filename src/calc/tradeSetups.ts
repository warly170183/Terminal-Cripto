import type {
  Candle,
  Levels,
  LiquidityAnalysis,
  SymbolAsset,
  Timeframe,
  TradeOptionIdea,
  TradeScoringAssessment,
  TradeTechnicalAlignment,
} from '../types/market';
import type { ParameterPoints, ScoringResult } from '../types/scoring';
import type { TakerTapeSummary } from '../data/okxTechnicalClient';
import { calculateTouchProbability, type ConeProjection } from './cone';
import { calculateEMAClouds, calculateRSI, calculateVWAP } from './indicators';
import type { CorrelationWindowDays } from './newsSentiment';
import type {
  ConfluenceZone,
  FairValueGap,
  FibonacciAnalysis,
  MultiTimeframeRow,
  OscillatorDivergence,
  TechnicalSnapshotSummary,
  VolumeProfileData,
} from './technicalAnalysis';

export function calculateATR(candles: Candle[], period = 14): number {
  if (candles.length < 2) {
    return candles[0] ? Math.max(1, candles[0].h - candles[0].l) : 0;
  }
  const start = Math.max(1, candles.length - period);
  let sum = 0;
  let count = 0;
  for (let i = start; i < candles.length; i++) {
    const curr = candles[i];
    const prevClose = candles[i - 1].c;
    const tr = Math.max(
      curr.h - curr.l,
      Math.abs(curr.h - prevClose),
      Math.abs(curr.l - prevClose)
    );
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : candles[candles.length - 1].c * 0.006;
}

function roundPrice(p: number, asset: SymbolAsset): number {
  const digits = asset === 'BTC' ? 1 : 2;
  const f = Math.pow(10, digits);
  return Math.round(p * f) / f;
}

function computePositionSize(
  capitalUsd: number,
  riskPct: number,
  entry: number,
  stopLoss: number
): { quantity: number; notionalUsd: number; riskUsd: number } {
  const riskUsd = Math.max(1, capitalUsd * (Math.max(0.1, riskPct) / 100));
  const stopDist = Math.max(entry * 0.001, Math.abs(entry - stopLoss));
  const quantity = riskUsd / stopDist;
  const notionalUsd = quantity * entry;
  return { quantity, notionalUsd, riskUsd };
}

function getTouchProb(
  spot: number,
  target: number,
  cone: ConeProjection | null
): number | null {
  if (!cone || spot <= 0 || target <= 0) return null;
  const years = Math.max(1e-5, (cone.expTs - Date.now()) / (365 * 24 * 60 * 60 * 1000));
  const iv = target >= spot ? cone.upsideIV : cone.downsideIV;
  return Math.round(calculateTouchProbability(spot, target, iv, years) * 100);
}

function evaluateNetExecution(
  idea: Pick<TradeOptionIdea, 'entry' | 'stopLoss' | 'takeProfit1' | 'quantity'>,
  spreadPct: number,
  feePctPerSide: number,
  slippagePctPerSide: number,
  expectedFundingCostPct: number
): { netRR: number; costToRiskPct: number } {
  const stopDist = Math.abs(idea.entry - idea.stopLoss);
  const tpDist = Math.abs(idea.takeProfit1 - idea.entry);
  if (stopDist <= 0 || idea.quantity <= 0) {
    return { netRR: 0, costToRiskPct: 100 };
  }
  const perUnitRate =
    (feePctPerSide * 2 + slippagePctPerSide * 2 + spreadPct + expectedFundingCostPct) / 100;
  const costStop = idea.quantity * ((idea.entry + idea.stopLoss) * 0.5) * perUnitRate;
  const costTarget = idea.quantity * ((idea.entry + idea.takeProfit1) * 0.5) * perUnitRate;
  const grossRisk = idea.quantity * stopDist;
  const grossReward = idea.quantity * tpDist;
  const netRisk = grossRisk + costStop;
  const netReward = grossReward - costTarget;
  const netRR = netRisk > 0 ? netReward / netRisk : 0;
  const costToRiskPct = grossRisk > 0 ? (100 * Math.max(costStop, costTarget)) / grossRisk : 100;
  return { netRR, costToRiskPct };
}

function scoreNetRRPoints(netRR: number): ParameterPoints {
  if (netRR >= 3.0) return 100;
  if (netRR >= 2.5) return 75;
  if (netRR >= 2.0) return 50;
  if (netRR >= 1.5) return 25;
  return 0;
}

function scoreCostRatioPoints(pct: number): ParameterPoints {
  if (pct <= 5) return 100;
  if (pct <= 10) return 75;
  if (pct <= 15) return 50;
  if (pct <= 20) return 25;
  return 0;
}

function classifyBand(score: number, coveragePct: number): string {
  if (coveragePct < 90) return 'INCOMPLETO';
  if (score >= 90) return 'Candidata con alta confluencia';
  if (score >= 80) return 'Candidata';
  if (score >= 70) return 'Esperar mejor confirmación';
  if (score >= 60) return 'Vigilancia';
  return 'Descartar';
}

function buildIdeaScoringAssessment(
  idea: TradeOptionIdea,
  scoring: ScoringResult,
  spreadPct: number,
  feePctPerSide: number,
  slippagePctPerSide: number
): TradeScoringAssessment {
  const isLong = idea.direction === 'LONG';
  const dirEval = isLong ? scoring.longEval : scoring.shortEval;
  const oppEval = isLong ? scoring.shortEval : scoring.longEval;

  const { netRR, costToRiskPct } = evaluateNetExecution(
    idea,
    spreadPct,
    feePctPerSide,
    slippagePctPerSide,
    scoring.mode === 'perpetual' ? 0.01 : 0
  );

  // Replace F1 (weight 8) and F2 (weight 4) with this specific trade card's actual Entry/SL/TP1 metrics
  let availableWeight = 0;
  let weightedSum = 0;
  const fulfilledConditions: string[] = [];

  for (const row of scoring.parameters) {
    const res = isLong ? row.long : row.short;
    if (!res.applicable) continue;
    if (row.id === 'F1') {
      const f1Pts = scoreNetRRPoints(netRR);
      availableWeight += row.maxWeight;
      weightedSum += (row.maxWeight * f1Pts) / 100;
      if (f1Pts >= 75) fulfilledConditions.push(`F1 RR neto (${netRR.toFixed(2)}R)`);
      continue;
    }
    if (row.id === 'F2') {
      const f2Pts = scoreCostRatioPoints(costToRiskPct);
      availableWeight += row.maxWeight;
      weightedSum += (row.maxWeight * f2Pts) / 100;
      if (f2Pts >= 75) fulfilledConditions.push(`F2 Costes (${costToRiskPct.toFixed(1)}%)`);
      continue;
    }
    if (res.missing || res.points === null) continue;
    availableWeight += row.maxWeight;
    weightedSum += res.weightedPoints;
    if (res.passed) {
      fulfilledConditions.push(`${row.id} ${row.name} (${res.points})`);
    }
  }

  const v11Score = availableWeight > 0 ? (weightedSum * 100) / availableWeight : 0;
  const diffVsOpposite = v11Score - oppEval.score;

  const a1Row = scoring.parameters.find((p) => p.id === 'A1');
  const d1Row = scoring.parameters.find((p) => p.id === 'D1');
  const a1Pts = (isLong ? a1Row?.long.points : a1Row?.short.points) ?? 0;
  const d1Pts = (isLong ? d1Row?.long.points : d1Row?.short.points) ?? 0;

  const blockReasons: string[] = [];
  let hardBlock = false;

  if (dirEval.coveragePct < 90) {
    hardBlock = true;
    blockReasons.push(`Cobertura < 90% (${dirEval.coveragePct.toFixed(1)}%)`);
  }
  if (netRR < 2.0) {
    hardBlock = true;
    blockReasons.push(`RR neto ${netRR.toFixed(2)} < 2.0 en TP1`);
  }
  if (costToRiskPct > 20) {
    hardBlock = true;
    blockReasons.push(`Costes ${costToRiskPct.toFixed(1)}% > 20% del riesgo`);
  }
  for (const b of dirEval.blocks) {
    if (b.code === 'LIMITE_DIARIO' || b.code === 'RIESGO_CARTERA' || b.code === 'LIQUIDEZ_BOOK') {
      hardBlock = true;
      blockReasons.push(b.label);
    }
  }

  if (a1Pts < 75) {
    blockReasons.push(`A1 Estructura 4h = ${a1Pts} (< 75)`);
  }
  if (d1Pts < 75) {
    blockReasons.push(`D1 Disparador 15m = ${d1Pts} (< 75)`);
  }
  if (v11Score < 80) {
    blockReasons.push(`Puntuación ${v11Score.toFixed(1)} < 80`);
  }
  if (diffVsOpposite < 15) {
    blockReasons.push(`Diferencia vs opuesta Δ ${diffVsOpposite.toFixed(1)} < 15`);
  }

  const operable =
    !hardBlock &&
    dirEval.coveragePct >= 90 &&
    v11Score >= 80 &&
    diffVsOpposite >= 15 &&
    a1Pts >= 75 &&
    d1Pts >= 75;

  const verdict: TradeScoringAssessment['verdict'] = hardBlock
    ? 'BLOQUEADA'
    : operable
    ? 'CANDIDATA'
    : v11Score < 60
    ? 'DESCARTADA'
    : 'ESPERAR';

  return {
    v11Score,
    baseDirectionScore: dirEval.score,
    band: classifyBand(v11Score, dirEval.coveragePct),
    verdict,
    operable,
    coveragePct: dirEval.coveragePct,
    diffVsOpposite,
    netRR,
    costToRiskPct,
    gates: [
      {
        id: 'score80',
        label: 'Nota ≥ 80',
        passed: v11Score >= 80,
        valueText: v11Score.toFixed(1),
      },
      {
        id: 'diff15',
        label: 'Δ Opuesta ≥ 15',
        passed: diffVsOpposite >= 15,
        valueText: `${diffVsOpposite >= 0 ? '+' : ''}${diffVsOpposite.toFixed(1)}`,
      },
      {
        id: 'a1',
        label: 'A1 4h ≥ 75',
        passed: a1Pts >= 75,
        valueText: `${a1Pts}`,
      },
      {
        id: 'd1',
        label: 'D1 15m ≥ 75',
        passed: d1Pts >= 75,
        valueText: `${d1Pts}`,
      },
      {
        id: 'rr2',
        label: 'RR Neto ≥ 2.0',
        passed: netRR >= 2.0,
        valueText: `${netRR.toFixed(2)}R`,
      },
      {
        id: 'cov90',
        label: 'Cob. ≥ 90%',
        passed: dirEval.coveragePct >= 90,
        valueText: `${dirEval.coveragePct.toFixed(0)}%`,
      },
    ],
    fulfilledConditions,
    blockReasons,
  };
}

export type MacroRegimeInput = {
  sentimentLabel: 'Alcista' | 'Bajista' | 'Neutral';
  sentimentScore: number;
  rollingR: number | null;
  windowDays: CorrelationWindowDays;
  volPct: number | null;
};

type TechnicalEnrichmentContext = {
  spot: number;
  volumeProfile?: VolumeProfileData | null;
  fibAnalysis?: FibonacciAnalysis | null;
  fvgs?: FairValueGap[];
  confluences?: ConfluenceZone[];
  divergences?: OscillatorDivergence[];
  techSnapshot?: TechnicalSnapshotSummary | null;
  mtfMatrix?: MultiTimeframeRow[];
  takerTape?: TakerTapeSummary | null;
  macroRegime?: MacroRegimeInput | null;
};

function buildTechnicalAlignmentAssessment(
  idea: TradeOptionIdea,
  ctx: TechnicalEnrichmentContext
): TradeTechnicalAlignment | undefined {
  const {
    spot,
    volumeProfile,
    fibAnalysis,
    fvgs = [],
    confluences = [],
    divergences = [],
    techSnapshot,
    mtfMatrix = [],
    takerTape,
    macroRegime,
  } = ctx;

  const hasAnyTechData =
    Boolean(volumeProfile) ||
    Boolean(fibAnalysis) ||
    fvgs.length > 0 ||
    confluences.length > 0 ||
    divergences.length > 0 ||
    Boolean(techSnapshot) ||
    mtfMatrix.length > 0 ||
    Boolean(takerTape) ||
    Boolean(macroRegime);

  if (!hasAnyTechData) return undefined;

  const isLong = idea.direction === 'LONG';
  const alignedFactors: string[] = [];
  const conflictingFactors: string[] = [];
  let scoreDelta = 0;

  // 1. Multi-Timeframe Matrix (15m / 1H / 4H / D)
  let mtfAlignedCount = 0;
  let mtfOpposeCount = 0;
  for (const row of mtfMatrix) {
    if (isLong) {
      if (row.overall === 'Alcista') mtfAlignedCount++;
      else if (row.overall === 'Bajista') mtfOpposeCount++;
    } else {
      if (row.overall === 'Bajista') mtfAlignedCount++;
      else if (row.overall === 'Alcista') mtfOpposeCount++;
    }
  }
  if (mtfMatrix.length > 0) {
    if (mtfAlignedCount >= 3) {
      scoreDelta += 8;
      alignedFactors.push(`Matriz MTF ${mtfAlignedCount}/${mtfMatrix.length} TF alineados`);
    } else if (mtfAlignedCount >= 2) {
      scoreDelta += 4;
      alignedFactors.push(`Matriz MTF ${mtfAlignedCount}/${mtfMatrix.length} TF a favor`);
    } else if (mtfOpposeCount >= 2) {
      scoreDelta -= 6;
      conflictingFactors.push(`${mtfOpposeCount}/${mtfMatrix.length} TF en dirección contraria`);
    }
  }

  // 2. Real-time Technical Snapshot (EMA/RSI/MACD/Book/BB Squeeze)
  if (techSnapshot) {
    if ((isLong && techSnapshot.overallBias === 'Alcista') || (!isLong && techSnapshot.overallBias === 'Bajista')) {
      scoreDelta += 4;
      alignedFactors.push(
        `Sesgo técnico ${techSnapshot.overallBias} (${techSnapshot.bullishSignalsCount}↑/${techSnapshot.bearishSignalsCount}↓)`
      );
    } else if (
      (isLong && techSnapshot.overallBias === 'Bajista') ||
      (!isLong && techSnapshot.overallBias === 'Alcista')
    ) {
      scoreDelta -= 4;
      conflictingFactors.push(`Sesgo multi-factor opuesto (${techSnapshot.overallBias})`);
    }
    if (techSnapshot.isSqueeze) {
      conflictingFactors.push('BB Squeeze activo: posible expansión brusca de volatilidad');
    }
  }

  // 3. Confluence Entry Tag (Cluster, Fib Golden Pocket, FVG, VPVR VAH/VAL/POC)
  let confluenceEntryTag: string | null = null;
  const entryCluster = confluences.find(
    (z) => Math.abs(z.avgPrice - idea.entry) / idea.entry <= 0.0045
  );
  if (entryCluster) {
    scoreDelta += 6;
    confluenceEntryTag = `Clúster ${entryCluster.factorCount}× (${entryCluster.factors.slice(0, 3).join(' + ')})`;
    alignedFactors.push(`Entrada sobre ${confluenceEntryTag}`);
  }

  if (fibAnalysis && idea.entry > 0) {
    const inGoldenPocket =
      idea.entry >= fibAnalysis.goldenPocketLow * 0.997 &&
      idea.entry <= fibAnalysis.goldenPocketHigh * 1.003;
    if (inGoldenPocket) {
      scoreDelta += 5;
      if (!confluenceEntryTag) confluenceEntryTag = 'Golden Pocket Fib 61.8%–65%';
      alignedFactors.push('Zona Golden Pocket Fib (61.8%–65%)');
    }
  }

  const entryFvg = fvgs.find(
    (g) =>
      ((isLong && g.direction === 'bullish') || (!isLong && g.direction === 'bearish')) &&
      idea.entry >= g.bottom * 0.996 &&
      idea.entry <= g.top * 1.004
  );
  if (entryFvg) {
    scoreDelta += 4;
    if (!confluenceEntryTag) {
      confluenceEntryTag = `FVG ${entryFvg.direction === 'bullish' ? 'alcista' : 'bajista'}`;
    }
    alignedFactors.push(`Respaldo en FVG sin mitigar (${entryFvg.direction === 'bullish' ? 'alcista' : 'bajista'})`);
  }

  if (volumeProfile && spot > 0) {
    const nearVal = Math.abs(idea.entry - volumeProfile.val) / idea.entry <= 0.0045;
    const nearVah = Math.abs(idea.entry - volumeProfile.vah) / idea.entry <= 0.0045;
    const nearPoc = Math.abs(idea.entry - volumeProfile.poc) / idea.entry <= 0.0045;
    if (isLong && nearVal) {
      scoreDelta += 3;
      alignedFactors.push(`Soporte VPVR VAL ($${Math.round(volumeProfile.val).toLocaleString('en-US')})`);
    } else if (!isLong && nearVah) {
      scoreDelta += 3;
      alignedFactors.push(`Techo VPVR VAH ($${Math.round(volumeProfile.vah).toLocaleString('en-US')})`);
    } else if (nearPoc) {
      alignedFactors.push(`Anclaje cercano a POC VPVR ($${Math.round(volumeProfile.poc).toLocaleString('en-US')})`);
    }
  }

  // Check if an opposing confluence zone sits squarely between Entry and TP1
  const minPath = Math.min(idea.entry, idea.takeProfit1);
  const maxPath = Math.max(idea.entry, idea.takeProfit1);
  const blockerCluster = confluences.find(
    (z) =>
      z.factorCount >= 3 &&
      z.avgPrice > minPath * 1.002 &&
      z.avgPrice < maxPath * 0.998 &&
      ((isLong && z.kind === 'resistencia') || (!isLong && z.kind === 'soporte'))
  );
  if (blockerCluster) {
    scoreDelta -= 3;
    conflictingFactors.push(
      `Clúster ${blockerCluster.factorCount}× intermedio antes de TP1 ($${Math.round(blockerCluster.avgPrice).toLocaleString('en-US')})`
    );
  }

  // 4. Oscillator Divergences (RSI / MACD / CVD)
  const bullDiv = divergences.find((d) => d.kind.startsWith('bullish'));
  const bearDiv = divergences.find((d) => d.kind.startsWith('bearish'));
  if (isLong && bullDiv) {
    scoreDelta += 4;
    alignedFactors.push(`${bullDiv.label} confirmada`);
  } else if (isLong && bearDiv) {
    scoreDelta -= 4;
    conflictingFactors.push(`Precaución: ${bearDiv.label} contraria`);
  } else if (!isLong && bearDiv) {
    scoreDelta += 4;
    alignedFactors.push(`${bearDiv.label} confirmada`);
  } else if (!isLong && bullDiv) {
    scoreDelta -= 4;
    conflictingFactors.push(`Precaución: ${bullDiv.label} contraria`);
  }

  // 5. Live OKX Taker Flow & Passive Absorption
  if (takerTape) {
    if (takerTape.absorption.detected) {
      const alignedAbs =
        (isLong && takerTape.absorption.side === 'compra') ||
        (!isLong && takerTape.absorption.side === 'venta');
      if (alignedAbs) {
        scoreDelta += 4;
        alignedFactors.push(`Absorción pasiva de ${takerTape.absorption.side} en cinta`);
      } else {
        scoreDelta -= 4;
        conflictingFactors.push(`Absorción pasiva contraria (${takerTape.absorption.side})`);
      }
    } else if (isLong && takerTape.buyRatioPct >= 58) {
      scoreDelta += 2;
      alignedFactors.push(`Flujo Taker comprador (${takerTape.buyRatioPct.toFixed(0)}%)`);
    } else if (!isLong && takerTape.buyRatioPct <= 42) {
      scoreDelta += 2;
      alignedFactors.push(`Flujo Taker vendedor (${(100 - takerTape.buyRatioPct).toFixed(0)}%)`);
    }
  }

  // 6. News Sentiment & Rolling Correlation Sensitivity (7D / 14D / 30D)
  let macroSensitivityNote: string | null = null;
  if (macroRegime) {
    const { sentimentLabel, sentimentScore, rollingR, windowDays, volPct } = macroRegime;
    if (
      (isLong && sentimentLabel === 'Alcista' && sentimentScore >= 15) ||
      (!isLong && sentimentLabel === 'Bajista' && sentimentScore <= -15)
    ) {
      scoreDelta += 2;
      alignedFactors.push(`Sentimiento noticias ${sentimentLabel} (${sentimentScore >= 0 ? '+' : ''}${sentimentScore})`);
    } else if (
      (isLong && sentimentLabel === 'Bajista' && sentimentScore <= -20) ||
      (!isLong && sentimentLabel === 'Alcista' && sentimentScore >= 20)
    ) {
      scoreDelta -= 2;
      conflictingFactors.push(`Titulares con sesgo opuesto (${sentimentLabel} ${sentimentScore})`);
    }

    if (rollingR !== null) {
      const volTxt = volPct !== null ? ` · Vol ${windowDays}d ${volPct.toFixed(2)}%` : '';
      if (rollingR >= 0.3) {
        macroSensitivityNote = `Sensibilidad ${windowDays}D alta (r=${rollingR >= 0 ? '+' : ''}${rollingR.toFixed(2)}${volTxt}): noticias/macro amplifican mechas; respetar holgura de SL.`;
      } else if (rollingR <= -0.25) {
        macroSensitivityNote = `Correlación inversa ${windowDays}D (r=${rollingR.toFixed(2)}${volTxt}): compresión pese a titulares; prioridad a niveles técnicos.`;
      } else {
        macroSensitivityNote = `Desacople técnico ${windowDays}D (r=${rollingR >= 0 ? '+' : ''}${rollingR.toFixed(2)}${volTxt}): prevalece estructura VPVR / liquidez.`;
      }
    }
  }

  return {
    mtfAlignedCount,
    mtfTotal: mtfMatrix.length,
    scoreDelta,
    alignedFactors,
    conflictingFactors,
    confluenceEntryTag,
    macroSensitivityNote,
  };
}

export function generateTradingOptions(input: {
  asset: SymbolAsset;
  timeframe: Timeframe;
  candles: Candle[];
  spot: number;
  optionsLevels: Levels;
  cone: ConeProjection | null;
  liquidity: LiquidityAnalysis;
  capitalUsd: number;
  riskPct: number;
  scoring?: ScoringResult | null;
  spreadPct?: number;
  feePctPerSide?: number;
  slippagePctPerSide?: number;
  volumeProfile?: VolumeProfileData | null;
  fibAnalysis?: FibonacciAnalysis | null;
  fvgs?: FairValueGap[];
  confluences?: ConfluenceZone[];
  divergences?: OscillatorDivergence[];
  techSnapshot?: TechnicalSnapshotSummary | null;
  mtfMatrix?: MultiTimeframeRow[];
  takerTape?: TakerTapeSummary | null;
  macroRegime?: MacroRegimeInput | null;
}): TradeOptionIdea[] {
  const {
    asset,
    candles,
    spot,
    optionsLevels,
    cone,
    liquidity,
    capitalUsd,
    riskPct,
    scoring = null,
    spreadPct = 0.02,
    feePctPerSide = 0.05,
    slippagePctPerSide = 0.02,
    volumeProfile = null,
    fibAnalysis = null,
    fvgs = [],
    confluences = [],
    divergences = [],
    techSnapshot = null,
    mtfMatrix = [],
    takerTape = null,
    macroRegime = null,
  } = input;

  if (candles.length < 15 || spot <= 0) return [];

  const clouds = calculateEMAClouds(candles);
  const vwapArr = calculateVWAP(candles);
  const rsiArr = calculateRSI(
    candles.map((c) => c.c),
    14
  );
  const atr = Math.max(spot * 0.0025, calculateATR(candles, 14));

  const lastIdx = candles.length - 1;
  const ema9 = clouds.ema9[lastIdx] ?? spot;
  const ema21 = clouds.ema21[lastIdx] ?? spot;
  const vwap = vwapArr[lastIdx] ?? spot;
  const rsi = rsiArr[lastIdx] ?? 50;

  const regimeDampen =
    optionsLevels.flip !== null ? spot >= optionsLevels.flip : optionsLevels.netGex >= 0;

  const aboveLiq = liquidity.levels
    .filter((l) => l.price > spot * 1.0015)
    .sort((a, b) => a.price - b.price);
  const belowLiq = liquidity.levels
    .filter((l) => l.price < spot * 0.9985)
    .sort((a, b) => b.price - a.price);

  const ideas: TradeOptionIdea[] = [];

  // ------------------------------------------------------------------
  // 1. Setup: Tendencia & Flujo (aligned with EMA Cloud + VWAP + Liquidity)
  // ------------------------------------------------------------------
  const bullishTrend = ema9 >= ema21 && spot >= ema21 * 0.997;
  const trendDir: 'LONG' | 'SHORT' = bullishTrend ? 'LONG' : 'SHORT';

  if (trendDir === 'LONG') {
    const entryRaw = Math.min(spot, Math.max(ema21, Math.min(spot, ema9)));
    const entry = roundPrice(entryRaw, asset);
    const supportGuard =
      belowLiq.find((l) => l.price < entry - atr * 0.35)?.price ?? entry - atr * 1.35;
    const stopLoss = roundPrice(Math.min(entry - atr * 0.9, supportGuard - atr * 0.25), asset);
    const riskDist = Math.max(atr * 0.5, entry - stopLoss);

    const tp1Cand = aboveLiq.find((l) => l.price >= entry + riskDist * 1.15);
    const takeProfit1 = roundPrice(
      tp1Cand ? tp1Cand.price : entry + riskDist * 1.5,
      asset
    );
    const tp2Cand = aboveLiq.find((l) => l.price >= takeProfit1 + riskDist * 0.8);
    const takeProfit2 = roundPrice(
      tp2Cand ? tp2Cand.price : Math.max(takeProfit1 + riskDist, entry + riskDist * 2.6),
      asset
    );

    const sz = computePositionSize(capitalUsd, riskPct, entry, stopLoss);
    const rr1 = (takeProfit1 - entry) / riskDist;
    const rr2 = (takeProfit2 - entry) / riskDist;

    let score = 62;
    if (spot > vwap) score += 10;
    if (liquidity.imbalancePct > 5) score += 8;
    if (rsi > 45 && rsi < 68) score += 7;
    if (regimeDampen) score += 4;

    ideas.push({
      id: 'setup-trend-long',
      title: 'Continuación Alcista en Retroceso a Nube EMA',
      category: 'Tendencia & Flujo',
      direction: 'LONG',
      confidenceScore: Math.min(94, score),
      entry,
      quantity: sz.quantity,
      notionalUsd: sz.notionalUsd,
      riskUsd: sz.riskUsd,
      takeProfit1,
      takeProfit2,
      stopLoss,
      rr1,
      rr2,
      tp1ProbPct: getTouchProb(spot, takeProfit1, cone),
      tp2ProbPct: getTouchProb(spot, takeProfit2, cone),
      tp1Reason: tp1Cand ? tp1Cand.label : 'Extensión 1.5R',
      tp2Reason: tp2Cand ? tp2Cand.label : 'Extensión 2.6R / Banda sup.',
      slReason: belowLiq[0] ? `Bajo ${belowLiq[0].label}` : 'Bajo 1.35×ATR',
      summary:
        'Busca incorporarse al flujo alcista aprovechando soporte dinámico en EMA 9/21 y protección bajo liquidez compradora.',
      confluences: [
        `Nube EMA 9/21 alcista ($${Math.round(ema9).toLocaleString('en-US')} / $${Math.round(ema21).toLocaleString('en-US')})`,
        `VWAP 00 UTC en $${Math.round(vwap).toLocaleString('en-US')} · RSI(14) ${rsi.toFixed(1)}`,
        liquidity.strongestBidWall
          ? `Muro Bid OKX en $${liquidity.strongestBidWall.price.toLocaleString('en-US')}`
          : 'Soporte estructural SSL',
        regimeDampen ? 'GEX Positivo (amortigua caídas)' : 'GEX Negativo (vigilar tamaño)',
      ],
    });
  } else {
    const entryRaw = Math.max(spot, Math.min(ema21, Math.max(spot, ema9)));
    const entry = roundPrice(entryRaw, asset);
    const resGuard =
      aboveLiq.find((l) => l.price > entry + atr * 0.35)?.price ?? entry + atr * 1.35;
    const stopLoss = roundPrice(Math.max(entry + atr * 0.9, resGuard + atr * 0.25), asset);
    const riskDist = Math.max(atr * 0.5, stopLoss - entry);

    const tp1Cand = belowLiq.find((l) => l.price <= entry - riskDist * 1.15);
    const takeProfit1 = roundPrice(
      tp1Cand ? tp1Cand.price : entry - riskDist * 1.5,
      asset
    );
    const tp2Cand = belowLiq.find((l) => l.price <= takeProfit1 - riskDist * 0.8);
    const takeProfit2 = roundPrice(
      tp2Cand ? tp2Cand.price : Math.min(takeProfit1 - riskDist, entry - riskDist * 2.6),
      asset
    );

    const sz = computePositionSize(capitalUsd, riskPct, entry, stopLoss);
    const rr1 = (entry - takeProfit1) / riskDist;
    const rr2 = (entry - takeProfit2) / riskDist;

    let score = 62;
    if (spot < vwap) score += 10;
    if (liquidity.imbalancePct < -5) score += 8;
    if (rsi < 55 && rsi > 32) score += 7;
    if (!regimeDampen) score += 5;

    ideas.push({
      id: 'setup-trend-short',
      title: 'Continuación Bajista bajo Nube EMA y VWAP',
      category: 'Tendencia & Flujo',
      direction: 'SHORT',
      confidenceScore: Math.min(94, score),
      entry,
      quantity: sz.quantity,
      notionalUsd: sz.notionalUsd,
      riskUsd: sz.riskUsd,
      takeProfit1,
      takeProfit2,
      stopLoss,
      rr1,
      rr2,
      tp1ProbPct: getTouchProb(spot, takeProfit1, cone),
      tp2ProbPct: getTouchProb(spot, takeProfit2, cone),
      tp1Reason: tp1Cand ? tp1Cand.label : 'Extensión 1.5R',
      tp2Reason: tp2Cand ? tp2Cand.label : 'Extensión 2.6R / Banda inf.',
      slReason: aboveLiq[0] ? `Sobre ${aboveLiq[0].label}` : 'Sobre 1.35×ATR',
      summary:
        'Vende rebotes hacia EMA 9/21 con presión vendedora en libro y objetivo hacia pools de liquidez inferiores.',
      confluences: [
        `Nube EMA 9/21 bajista ($${Math.round(ema9).toLocaleString('en-US')} / $${Math.round(ema21).toLocaleString('en-US')})`,
        `VWAP 00 UTC en $${Math.round(vwap).toLocaleString('en-US')} · RSI(14) ${rsi.toFixed(1)}`,
        liquidity.strongestAskWall
          ? `Muro Ask OKX en $${liquidity.strongestAskWall.price.toLocaleString('en-US')}`
          : 'Resistencia BSL cercana',
        regimeDampen ? 'GEX Positivo (resistencia en Call Wall)' : 'GEX Negativo (dealers siguen tendencia)',
      ],
    });
  }

  // ------------------------------------------------------------------
  // 2. Setup: Barrido de Liquidez (Liquidity Sweep at SSL / Bid Wall or BSL / Ask Wall)
  // ------------------------------------------------------------------
  const preferLongSweep = rsi <= 48 || liquidity.imbalancePct >= 0;
  if (preferLongSweep) {
    const anchor = liquidity.nearestSSL?.price ?? liquidity.nearestBidWall?.price ?? spot - atr * 1.2;
    const entry = roundPrice(Math.min(spot * 0.999, anchor), asset);
    const stopLoss = roundPrice(entry - atr * 1.15, asset);
    const riskDist = Math.max(atr * 0.4, entry - stopLoss);
    const tp1Target = vwap > entry + riskDist * 0.9 ? vwap : entry + riskDist * 1.6;
    const takeProfit1 = roundPrice(tp1Target, asset);
    const tp2Cand = aboveLiq.find((l) => l.price > takeProfit1 + riskDist * 0.7);
    const takeProfit2 = roundPrice(
      tp2Cand ? tp2Cand.price : entry + riskDist * 2.8,
      asset
    );
    const sz = computePositionSize(capitalUsd, riskPct, entry, stopLoss);

    ideas.push({
      id: 'setup-sweep-long',
      title: 'Barrido de Liquidez (SSL / Muro Bid)',
      category: 'Barrido de Liquidez',
      direction: 'LONG',
      confidenceScore: Math.min(90, 60 + (rsi < 38 ? 14 : 6) + (liquidity.nearestBidWall ? 10 : 0)),
      entry,
      quantity: sz.quantity,
      notionalUsd: sz.notionalUsd,
      riskUsd: sz.riskUsd,
      takeProfit1,
      takeProfit2,
      stopLoss,
      rr1: (takeProfit1 - entry) / riskDist,
      rr2: (takeProfit2 - entry) / riskDist,
      tp1ProbPct: getTouchProb(spot, takeProfit1, cone),
      tp2ProbPct: getTouchProb(spot, takeProfit2, cone),
      tp1Reason: vwap > entry ? 'Retorno a VWAP / Equilibrio' : 'Rebote 1.6R',
      tp2Reason: tp2Cand ? tp2Cand.label : 'Liquidez superior / 2.8R',
      slReason: 'Invalidación tras ruptura limpia del muro Bid / SSL',
      summary:
        'Espera captura de stops bajo el pool de liquidez vendedor y absorción en el libro de órdenes de OKX.',
      confluences: [
        liquidity.nearestSSL
          ? `Pool SSL detectado en $${Math.round(liquidity.nearestSSL.price).toLocaleString('en-US')}`
          : `Zona de soporte en $${Math.round(entry).toLocaleString('en-US')}`,
        liquidity.nearestBidWall
          ? `Profundidad Bid OKX de $${Math.round(liquidity.nearestBidWall.notionalUsd / 1000)}K`
          : 'Ordenes limitadas de compra inferiores',
        optionsLevels.putWall > 0
          ? `Put Wall (modelo) en $${optionsLevels.putWall.toLocaleString('en-US')}`
          : 'Soporte de volatilidad del cono',
      ],
    });
  } else {
    const anchor = liquidity.nearestBSL?.price ?? liquidity.nearestAskWall?.price ?? spot + atr * 1.2;
    const entry = roundPrice(Math.max(spot * 1.001, anchor), asset);
    const stopLoss = roundPrice(entry + atr * 1.15, asset);
    const riskDist = Math.max(atr * 0.4, stopLoss - entry);
    const tp1Target = vwap < entry - riskDist * 0.9 ? vwap : entry - riskDist * 1.6;
    const takeProfit1 = roundPrice(tp1Target, asset);
    const tp2Cand = belowLiq.find((l) => l.price < takeProfit1 - riskDist * 0.7);
    const takeProfit2 = roundPrice(
      tp2Cand ? tp2Cand.price : entry - riskDist * 2.8,
      asset
    );
    const sz = computePositionSize(capitalUsd, riskPct, entry, stopLoss);

    ideas.push({
      id: 'setup-sweep-short',
      title: 'Barrido de Liquidez (BSL / Muro Ask)',
      category: 'Barrido de Liquidez',
      direction: 'SHORT',
      confidenceScore: Math.min(90, 60 + (rsi > 62 ? 14 : 6) + (liquidity.nearestAskWall ? 10 : 0)),
      entry,
      quantity: sz.quantity,
      notionalUsd: sz.notionalUsd,
      riskUsd: sz.riskUsd,
      takeProfit1,
      takeProfit2,
      stopLoss,
      rr1: (entry - takeProfit1) / riskDist,
      rr2: (entry - takeProfit2) / riskDist,
      tp1ProbPct: getTouchProb(spot, takeProfit1, cone),
      tp2ProbPct: getTouchProb(spot, takeProfit2, cone),
      tp1Reason: vwap < entry ? 'Retorno a VWAP / Equilibrio' : 'Retroceso 1.6R',
      tp2Reason: tp2Cand ? tp2Cand.label : 'Liquidez inferior / 2.8R',
      slReason: 'Invalidación sobre el muro Ask / BSL',
      summary:
        'Busca rechazo tras barrido de máximos (BSL) contra concentración de ventas en el libro de órdenes y Call Wall.',
      confluences: [
        liquidity.nearestBSL
          ? `Pool BSL detectado en $${Math.round(liquidity.nearestBSL.price).toLocaleString('en-US')}`
          : `Zona de resistencia en $${Math.round(entry).toLocaleString('en-US')}`,
        liquidity.nearestAskWall
          ? `Profundidad Ask OKX de $${Math.round(liquidity.nearestAskWall.notionalUsd / 1000)}K`
          : 'Ordenes limitadas de venta superiores',
        optionsLevels.callWall > 0
          ? `Call Wall (modelo) en $${optionsLevels.callWall.toLocaleString('en-US')}`
          : 'Techo de rango del cono',
      ],
    });
  }

  // ------------------------------------------------------------------
  // 3. Setup: Convergencia Gamma / Max Pain & POC
  // ------------------------------------------------------------------
  const magnetTarget =
    optionsLevels.maxPain > 0 && Math.abs(optionsLevels.maxPain - spot) > atr * 0.8
      ? optionsLevels.maxPain
      : liquidity.pocPrice && Math.abs(liquidity.pocPrice - spot) > atr * 0.8
      ? liquidity.pocPrice
      : spot + (regimeDampen ? atr * 2 : -atr * 2);

  const magDir: 'LONG' | 'SHORT' = magnetTarget >= spot ? 'LONG' : 'SHORT';
  const magEntry = roundPrice(spot, asset);

  if (magDir === 'LONG') {
    const stopLoss = roundPrice(
      Math.min(magEntry - atr * 1.25, belowLiq[0]?.price ?? magEntry - atr * 1.4),
      asset
    );
    const riskDist = Math.max(atr * 0.5, magEntry - stopLoss);
    const midTarget = magEntry + (magnetTarget - magEntry) * 0.58;
    const takeProfit1 = roundPrice(Math.max(magEntry + riskDist * 1.1, midTarget), asset);
    const takeProfit2 = roundPrice(Math.max(takeProfit1 + riskDist * 0.8, magnetTarget), asset);
    const sz = computePositionSize(capitalUsd, riskPct, magEntry, stopLoss);

    ideas.push({
      id: 'setup-gamma-magnet',
      title: 'Atracción hacia Max Pain & POC de Volumen',
      category: 'Atracción Gamma / Rango',
      direction: 'LONG',
      confidenceScore: Math.min(88, 56 + (regimeDampen ? 16 : 6) + (cone ? 8 : 0)),
      entry: magEntry,
      quantity: sz.quantity,
      notionalUsd: sz.notionalUsd,
      riskUsd: sz.riskUsd,
      takeProfit1,
      takeProfit2,
      stopLoss,
      rr1: (takeProfit1 - magEntry) / riskDist,
      rr2: (takeProfit2 - magEntry) / riskDist,
      tp1ProbPct: getTouchProb(spot, takeProfit1, cone),
      tp2ProbPct: getTouchProb(spot, takeProfit2, cone),
      tp1Reason: 'Punto intermedio hacia imán estructural',
      tp2Reason:
        optionsLevels.maxPain > 0
          ? `Max Pain ($${optionsLevels.maxPain.toLocaleString('en-US')})`
          : 'POC Volumen',
      slReason: 'Pérdida de soporte estructural / 1.25×ATR',
      summary:
        'Estrategia de convergencia hacia el nivel de menor pago de opciones (Max Pain) y nodo de volumen institucional.',
      confluences: [
        `Max Pain (modelo): $${optionsLevels.maxPain.toLocaleString('en-US')}`,
        liquidity.pocPrice
          ? `POC Volumen en $${Math.round(liquidity.pocPrice).toLocaleString('en-US')}`
          : 'Equilibrio de rango reciente',
        cone
          ? `Probabilidad toque TP2 en cono: ${getTouchProb(spot, takeProfit2, cone) ?? '—'}%`
          : 'Rango lognormal de opciones',
      ],
    });
  } else {
    const stopLoss = roundPrice(
      Math.max(magEntry + atr * 1.25, aboveLiq[0]?.price ?? magEntry + atr * 1.4),
      asset
    );
    const riskDist = Math.max(atr * 0.5, stopLoss - magEntry);
    const midTarget = magEntry - (magEntry - magnetTarget) * 0.58;
    const takeProfit1 = roundPrice(Math.min(magEntry - riskDist * 1.1, midTarget), asset);
    const takeProfit2 = roundPrice(Math.min(takeProfit1 - riskDist * 0.8, magnetTarget), asset);
    const sz = computePositionSize(capitalUsd, riskPct, magEntry, stopLoss);

    ideas.push({
      id: 'setup-gamma-magnet',
      title: 'Atracción hacia Max Pain & POC de Volumen',
      category: 'Atracción Gamma / Rango',
      direction: 'SHORT',
      confidenceScore: Math.min(88, 56 + (regimeDampen ? 16 : 6) + (cone ? 8 : 0)),
      entry: magEntry,
      quantity: sz.quantity,
      notionalUsd: sz.notionalUsd,
      riskUsd: sz.riskUsd,
      takeProfit1,
      takeProfit2,
      stopLoss,
      rr1: (magEntry - takeProfit1) / riskDist,
      rr2: (magEntry - takeProfit2) / riskDist,
      tp1ProbPct: getTouchProb(spot, takeProfit1, cone),
      tp2ProbPct: getTouchProb(spot, takeProfit2, cone),
      tp1Reason: 'Punto intermedio hacia imán estructural',
      tp2Reason:
        optionsLevels.maxPain > 0
          ? `Max Pain ($${optionsLevels.maxPain.toLocaleString('en-US')})`
          : 'POC Volumen',
      slReason: 'Ruptura de techo estructural / 1.25×ATR',
      summary:
        'Estrategia de convergencia bajista hacia Max Pain y nodo de mayor volumen negociado (POC).',
      confluences: [
        `Max Pain (modelo): $${optionsLevels.maxPain.toLocaleString('en-US')}`,
        liquidity.pocPrice
          ? `POC Volumen en $${Math.round(liquidity.pocPrice).toLocaleString('en-US')}`
          : 'Equilibrio de rango reciente',
        cone
          ? `Probabilidad toque TP2 en cono: ${getTouchProb(spot, takeProfit2, cone) ?? '—'}%`
          : 'Rango lognormal de opciones',
      ],
    });
  }

  // ------------------------------------------------------------------
  // 4. Setup: Confluencia Técnica (Golden Pocket Fib / FVG / VPVR / Cluster)
  // ------------------------------------------------------------------
  const bestCluster = confluences[0] ?? null;
  const nearBullFvg = fvgs.find((g) => g.direction === 'bullish' && g.mid <= spot * 1.002);
  const nearBearFvg = fvgs.find((g) => g.direction === 'bearish' && g.mid >= spot * 0.998);

  const bullVotes =
    (techSnapshot?.overallBias === 'Alcista' ? 2 : techSnapshot?.overallBias === 'Bajista' ? -2 : 0) +
    mtfMatrix.reduce((acc, r) => acc + (r.overall === 'Alcista' ? 1 : r.overall === 'Bajista' ? -1 : 0), 0);
  const confDir: 'LONG' | 'SHORT' =
    bullVotes > 0
      ? 'LONG'
      : bullVotes < 0
      ? 'SHORT'
      : bestCluster?.kind === 'resistencia'
      ? 'SHORT'
      : 'LONG';

  const hasTechAnchor =
    Boolean(bestCluster) ||
    Boolean(fibAnalysis) ||
    Boolean(volumeProfile) ||
    Boolean(confDir === 'LONG' ? nearBullFvg : nearBearFvg);

  if (hasTechAnchor) {
    if (confDir === 'LONG') {
      const gpMid = fibAnalysis
        ? (fibAnalysis.goldenPocketLow + fibAnalysis.goldenPocketHigh) * 0.5
        : null;
      const supportCluster = confluences.find((z) => z.avgPrice <= spot * 1.002) ?? bestCluster;
      const rawAnchor =
        (supportCluster && supportCluster.avgPrice <= spot * 1.003 ? supportCluster.avgPrice : null) ??
        (nearBullFvg ? nearBullFvg.mid : null) ??
        (gpMid && gpMid <= spot * 1.004 ? gpMid : null) ??
        (volumeProfile && volumeProfile.val <= spot ? volumeProfile.val : spot - atr * 0.6);

      const entry = roundPrice(Math.min(spot, rawAnchor), asset);
      const fibInvalidation = fibAnalysis
        ? fibAnalysis.levels.find((l) => l.ratio === 0.786 && l.price < entry)?.price
        : undefined;
      const stopLoss = roundPrice(
        Math.min(entry - atr * 1.05, fibInvalidation ? fibInvalidation - atr * 0.25 : entry - atr * 1.2),
        asset
      );
      const riskDist = Math.max(atr * 0.45, entry - stopLoss);

      const pocAbove = volumeProfile && volumeProfile.poc > entry + riskDist * 1.2 ? volumeProfile.poc : null;
      const vahAbove = volumeProfile && volumeProfile.vah > entry + riskDist * 1.8 ? volumeProfile.vah : null;
      const tp1Raw = pocAbove ?? aboveLiq.find((l) => l.price >= entry + riskDist * 1.5)?.price ?? entry + riskDist * 2.1;
      const takeProfit1 = roundPrice(Math.max(entry + riskDist * 1.5, tp1Raw), asset);
      const tp2Raw =
        vahAbove && vahAbove > takeProfit1 + riskDist * 0.6
          ? vahAbove
          : aboveLiq.find((l) => l.price >= takeProfit1 + riskDist * 0.8)?.price ??
            Math.max(takeProfit1 + riskDist, entry + riskDist * 3.1);
      const takeProfit2 = roundPrice(tp2Raw, asset);

      const sz = computePositionSize(capitalUsd, riskPct, entry, stopLoss);
      const anchorReason = supportCluster
        ? `Clúster ${supportCluster.factorCount}× (${supportCluster.factors.slice(0, 2).join(' + ')})`
        : nearBullFvg
        ? 'FVG alcista sin mitigar'
        : gpMid
        ? 'Golden Pocket Fib (61.8%-65%)'
        : 'Soporte VPVR VAL';

      ideas.push({
        id: 'setup-tech-confluence-long',
        title: `Confluencia Técnica Alcista · ${anchorReason}`,
        category: 'Confluencia Técnica',
        direction: 'LONG',
        confidenceScore: Math.min(95, 66 + (supportCluster ? supportCluster.factorCount * 4 : 6) + (nearBullFvg ? 5 : 0)),
        entry,
        quantity: sz.quantity,
        notionalUsd: sz.notionalUsd,
        riskUsd: sz.riskUsd,
        takeProfit1,
        takeProfit2,
        stopLoss,
        rr1: (takeProfit1 - entry) / riskDist,
        rr2: (takeProfit2 - entry) / riskDist,
        tp1ProbPct: getTouchProb(spot, takeProfit1, cone),
        tp2ProbPct: getTouchProb(spot, takeProfit2, cone),
        tp1Reason: pocAbove ? `POC VPVR ($${Math.round(pocAbove).toLocaleString('en-US')})` : 'Resistencia / 2.1R',
        tp2Reason: vahAbove ? `VAH VPVR ($${Math.round(vahAbove).toLocaleString('en-US')})` : 'Extensión técnica 3.1R',
        slReason: fibInvalidation ? 'Bajo retroceso Fib 78.6%' : 'Bajo zona técnica + ATR',
        summary:
          'Planifica entrada límite sobre confluencia multi-factor de Análisis Técnico (Golden Pocket, FVG sin mitigar o Value Area VPVR).',
        confluences: [
          `Ancla técnica: ${anchorReason}`,
          volumeProfile
            ? `VPVR VAL $${Math.round(volumeProfile.val).toLocaleString('en-US')} / POC $${Math.round(volumeProfile.poc).toLocaleString('en-US')} / VAH $${Math.round(volumeProfile.vah).toLocaleString('en-US')}`
            : 'Perfil de volumen institucional',
          fibAnalysis
            ? `Golden Pocket Fib: $${Math.round(fibAnalysis.goldenPocketLow).toLocaleString('en-US')}–$${Math.round(fibAnalysis.goldenPocketHigh).toLocaleString('en-US')}`
            : 'Niveles de retroceso Fibonacci',
        ],
      });
    } else {
      const gpMid = fibAnalysis
        ? (fibAnalysis.goldenPocketLow + fibAnalysis.goldenPocketHigh) * 0.5
        : null;
      const resCluster = confluences.find((z) => z.avgPrice >= spot * 0.998) ?? bestCluster;
      const rawAnchor =
        (resCluster && resCluster.avgPrice >= spot * 0.997 ? resCluster.avgPrice : null) ??
        (nearBearFvg ? nearBearFvg.mid : null) ??
        (gpMid && gpMid >= spot * 0.996 ? gpMid : null) ??
        (volumeProfile && volumeProfile.vah >= spot ? volumeProfile.vah : spot + atr * 0.6);

      const entry = roundPrice(Math.max(spot, rawAnchor), asset);
      const fibInvalidation = fibAnalysis
        ? fibAnalysis.levels.find((l) => l.ratio === 0.786 && l.price > entry)?.price
        : undefined;
      const stopLoss = roundPrice(
        Math.max(entry + atr * 1.05, fibInvalidation ? fibInvalidation + atr * 0.25 : entry + atr * 1.2),
        asset
      );
      const riskDist = Math.max(atr * 0.45, stopLoss - entry);

      const pocBelow = volumeProfile && volumeProfile.poc < entry - riskDist * 1.2 ? volumeProfile.poc : null;
      const valBelow = volumeProfile && volumeProfile.val < entry - riskDist * 1.8 ? volumeProfile.val : null;
      const tp1Raw = pocBelow ?? belowLiq.find((l) => l.price <= entry - riskDist * 1.5)?.price ?? entry - riskDist * 2.1;
      const takeProfit1 = roundPrice(Math.min(entry - riskDist * 1.5, tp1Raw), asset);
      const tp2Raw =
        valBelow && valBelow < takeProfit1 - riskDist * 0.6
          ? valBelow
          : belowLiq.find((l) => l.price <= takeProfit1 - riskDist * 0.8)?.price ??
            Math.min(takeProfit1 - riskDist, entry - riskDist * 3.1);
      const takeProfit2 = roundPrice(tp2Raw, asset);

      const sz = computePositionSize(capitalUsd, riskPct, entry, stopLoss);
      const anchorReason = resCluster
        ? `Clúster ${resCluster.factorCount}× (${resCluster.factors.slice(0, 2).join(' + ')})`
        : nearBearFvg
        ? 'FVG bajista sin mitigar'
        : gpMid
        ? 'Golden Pocket Fib (61.8%-65%)'
        : 'Techo VPVR VAH';

      ideas.push({
        id: 'setup-tech-confluence-short',
        title: `Confluencia Técnica Bajista · ${anchorReason}`,
        category: 'Confluencia Técnica',
        direction: 'SHORT',
        confidenceScore: Math.min(95, 66 + (resCluster ? resCluster.factorCount * 4 : 6) + (nearBearFvg ? 5 : 0)),
        entry,
        quantity: sz.quantity,
        notionalUsd: sz.notionalUsd,
        riskUsd: sz.riskUsd,
        takeProfit1,
        takeProfit2,
        stopLoss,
        rr1: (entry - takeProfit1) / riskDist,
        rr2: (entry - takeProfit2) / riskDist,
        tp1ProbPct: getTouchProb(spot, takeProfit1, cone),
        tp2ProbPct: getTouchProb(spot, takeProfit2, cone),
        tp1Reason: pocBelow ? `POC VPVR ($${Math.round(pocBelow).toLocaleString('en-US')})` : 'Soporte / 2.1R',
        tp2Reason: valBelow ? `VAL VPVR ($${Math.round(valBelow).toLocaleString('en-US')})` : 'Extensión técnica 3.1R',
        slReason: fibInvalidation ? 'Sobre retroceso Fib 78.6%' : 'Sobre zona técnica + ATR',
        summary:
          'Busca rechazo en confluencia de resistencia técnica (Golden Pocket, FVG bajista sin mitigar o techo VAH) hacia nodos inferiores.',
        confluences: [
          `Ancla técnica: ${anchorReason}`,
          volumeProfile
            ? `VPVR VAL $${Math.round(volumeProfile.val).toLocaleString('en-US')} / POC $${Math.round(volumeProfile.poc).toLocaleString('en-US')} / VAH $${Math.round(volumeProfile.vah).toLocaleString('en-US')}`
            : 'Perfil de volumen institucional',
          fibAnalysis
            ? `Golden Pocket Fib: $${Math.round(fibAnalysis.goldenPocketLow).toLocaleString('en-US')}–$${Math.round(fibAnalysis.goldenPocketHigh).toLocaleString('en-US')}`
            : 'Niveles de retroceso Fibonacci',
        ],
      });
    }
  }

  const techCtx: TechnicalEnrichmentContext = {
    spot,
    volumeProfile,
    fibAnalysis,
    fvgs,
    confluences,
    divergences,
    techSnapshot,
    mtfMatrix,
    takerTape,
    macroRegime,
  };

  const withTech = ideas.map((idea) => {
    const technicalAlignment = buildTechnicalAlignmentAssessment(idea, techCtx);
    const adjustedConf = technicalAlignment
      ? Math.max(15, Math.min(98, idea.confidenceScore + technicalAlignment.scoreDelta))
      : idea.confidenceScore;
    return {
      ...idea,
      confidenceScore: adjustedConf,
      technicalAlignment,
    };
  });

  if (!scoring) {
    return withTech.sort((a, b) => b.confidenceScore - a.confidenceScore);
  }

  const enriched = withTech.map((idea) => {
    const assessment = buildIdeaScoringAssessment(
      idea,
      scoring,
      spreadPct,
      feePctPerSide,
      slippagePctPerSide
    );
    return {
      ...idea,
      confidenceScore: Math.round(assessment.v11Score),
      scoring: assessment,
    };
  });

  // Sort by operability first (CANDIDATA > ESPERAR > BLOQUEADA > DESCARTADA),
  // then exact v1.1 score, using technical alignment scoreDelta as tiebreaker.
  const rankOrder: Record<TradeScoringAssessment['verdict'], number> = {
    CANDIDATA: 0,
    ESPERAR: 1,
    BLOQUEADA: 2,
    DESCARTADA: 3,
  };

  return enriched.sort((a, b) => {
    const ra = rankOrder[a.scoring!.verdict];
    const rb = rankOrder[b.scoring!.verdict];
    if (ra !== rb) return ra - rb;
    const scoreDiff = b.scoring!.v11Score - a.scoring!.v11Score;
    if (Math.abs(scoreDiff) > 0.05) return scoreDiff;
    return (b.technicalAlignment?.scoreDelta ?? 0) - (a.technicalAlignment?.scoreDelta ?? 0);
  });
}
