import type {
  Candle,
  Levels,
  LiquidityAnalysis,
  SymbolAsset,
  Timeframe,
  TradeOptionIdea,
} from '../types/market';
import { calculateTouchProbability, type ConeProjection } from './cone';
import { calculateEMAClouds, calculateRSI, calculateVWAP } from './indicators';

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

  return ideas;
}
