import type {
  Candle,
  Levels,
  LiquidityAnalysis,
  LiquidityLevel,
  OrderbookDepthData,
  OrderbookWall,
} from '../types/market';

function formatCompactUsd(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(0)}K`;
  return `$${abs.toFixed(0)}`;
}

/**
 * Estimates Point of Control (POC) — price level with highest traded volume across visible candles.
 */
export function calculateVolumePOC(candles: Candle[], bins = 36): number | null {
  if (candles.length < 5) return null;
  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of candles) {
    if (c.l < minP) minP = c.l;
    if (c.h > maxP) maxP = c.h;
  }
  const span = maxP - minP;
  if (!Number.isFinite(span) || span <= 0) return candles[candles.length - 1].c;

  const buckets = new Array<number>(bins).fill(0);
  const step = span / bins;

  for (const c of candles) {
    const tp = (c.h + c.l + c.c) / 3;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((tp - minP) / step)));
    const weight = c.v > 0 ? c.v : Math.abs(c.h - c.l);
    buckets[idx] += weight;
  }

  let bestIdx = 0;
  let bestVal = -1;
  for (let i = 0; i < bins; i++) {
    if (buckets[i] > bestVal) {
      bestVal = buckets[i];
      bestIdx = i;
    }
  }
  return minP + (bestIdx + 0.5) * step;
}

/**
 * Extracts Buy-Side Liquidity (BSL above spot) and Sell-Side Liquidity (SSL below spot)
 * from swing pivot highs/lows and clustered equal levels in historical candles.
 */
export function findSwingLiquidityPools(
  candles: Candle[],
  spot: number
): { bsl: LiquidityLevel[]; ssl: LiquidityLevel[] } {
  if (candles.length < 15 || spot <= 0) return { bsl: [], ssl: [] };

  const lookback = 4;
  const rawHighs: { price: number; touches: number; vol: number }[] = [];
  const rawLows: { price: number; touches: number; vol: number }[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const h = candles[i].h;
    const l = candles[i].l;
    let isPivotHigh = true;
    let isPivotLow = true;

    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].h > h) isPivotHigh = false;
      if (candles[j].l < l) isPivotLow = false;
    }

    if (isPivotHigh && h > spot * 1.0005) {
      const cluster = rawHighs.find((p) => Math.abs(p.price - h) / h < 0.0028);
      if (cluster) {
        cluster.touches += 1;
        cluster.price = Math.max(cluster.price, h);
        cluster.vol += candles[i].v;
      } else {
        rawHighs.push({ price: h, touches: 1, vol: candles[i].v });
      }
    }

    if (isPivotLow && l < spot * 0.9995) {
      const cluster = rawLows.find((p) => Math.abs(p.price - l) / l < 0.0028);
      if (cluster) {
        cluster.touches += 1;
        cluster.price = Math.min(cluster.price, l);
        cluster.vol += candles[i].v;
      } else {
        rawLows.push({ price: l, touches: 1, vol: candles[i].v });
      }
    }
  }

  const bsl: LiquidityLevel[] = rawHighs
    .sort((a, b) => a.price - b.price)
    .slice(0, 4)
    .map((p, idx) => ({
      id: `bsl-${idx}-${Math.round(p.price)}`,
      price: p.price,
      type: 'BSL',
      side: 'above',
      strength: Math.min(95, 50 + p.touches * 16),
      label: p.touches > 1 ? `BSL (×${p.touches} máximos)` : 'BSL (Swing High)',
      detail: `Liquidez compradora / stops sobre $${p.price.toLocaleString('en-US', {
        maximumFractionDigits: 1,
      })}`,
    }));

  const ssl: LiquidityLevel[] = rawLows
    .sort((a, b) => b.price - a.price)
    .slice(0, 4)
    .map((p, idx) => ({
      id: `ssl-${idx}-${Math.round(p.price)}`,
      price: p.price,
      type: 'SSL',
      side: 'below',
      strength: Math.min(95, 50 + p.touches * 16),
      label: p.touches > 1 ? `SSL (×${p.touches} mínimos)` : 'SSL (Swing Low)',
      detail: `Liquidez vendedora / stops bajo $${p.price.toLocaleString('en-US', {
        maximumFractionDigits: 1,
      })}`,
    }));

  return { bsl, ssl };
}

/**
 * Unifies live OKX orderbook depth walls, candle liquidity pools (BSL/SSL/POC),
 * previous day High/Low, and options GEX walls into a single market liquidity map.
 */
export function analyzeMarketLiquidity(
  candles: Candle[],
  spot: number,
  optionsLevels: Levels,
  orderbook: OrderbookDepthData | null,
  prevDayHigh: number | null,
  prevDayLow: number | null
): LiquidityAnalysis {
  const levels: LiquidityLevel[] = [];

  let nearestAskWall: OrderbookWall | null = null;
  let nearestBidWall: OrderbookWall | null = null;
  let strongestAskWall: OrderbookWall | null = null;
  let strongestBidWall: OrderbookWall | null = null;

  if (orderbook && orderbook.walls.length > 0) {
    const asks = orderbook.walls.filter((w) => w.side === 'ask' && w.price >= spot);
    const bids = orderbook.walls.filter((w) => w.side === 'bid' && w.price <= spot);

    if (asks.length > 0) {
      nearestAskWall = [...asks].sort((a, b) => a.price - b.price)[0];
      strongestAskWall = [...asks].sort((a, b) => b.notionalUsd - a.notionalUsd)[0];
      const maxAskUsd = strongestAskWall.notionalUsd || 1;
      for (const w of asks.slice(0, 4)) {
        levels.push({
          id: `ob-ask-${w.price}`,
          price: w.price,
          type: 'ASK_WALL',
          side: 'above',
          strength: Math.max(35, Math.round((w.notionalUsd / maxAskUsd) * 100)),
          label: 'Muro Ask OKX',
          detail: `${w.sizeCoins.toFixed(2)} unidades (${formatCompactUsd(w.notionalUsd)})`,
          notionalUsd: w.notionalUsd,
        });
      }
    }

    if (bids.length > 0) {
      nearestBidWall = [...bids].sort((a, b) => b.price - a.price)[0];
      strongestBidWall = [...bids].sort((a, b) => b.notionalUsd - a.notionalUsd)[0];
      const maxBidUsd = strongestBidWall.notionalUsd || 1;
      for (const w of bids.slice(0, 4)) {
        levels.push({
          id: `ob-bid-${w.price}`,
          price: w.price,
          type: 'BID_WALL',
          side: 'below',
          strength: Math.max(35, Math.round((w.notionalUsd / maxBidUsd) * 100)),
          label: 'Muro Bid OKX',
          detail: `${w.sizeCoins.toFixed(2)} unidades (${formatCompactUsd(w.notionalUsd)})`,
          notionalUsd: w.notionalUsd,
        });
      }
    }
  }

  const { bsl, ssl } = findSwingLiquidityPools(candles, spot);
  levels.push(...bsl, ...ssl);

  const pocPrice = calculateVolumePOC(candles);
  if (pocPrice !== null && spot > 0) {
    levels.push({
      id: 'liq-poc',
      price: pocPrice,
      type: 'POC',
      side: pocPrice >= spot ? 'above' : 'below',
      strength: 78,
      label: 'POC Volumen',
      detail: 'Nodo de mayor volumen negociado en el rango visible',
    });
  }

  if (prevDayHigh !== null && spot > 0) {
    levels.push({
      id: 'liq-pdh',
      price: prevDayHigh,
      type: 'PDH',
      side: prevDayHigh >= spot ? 'above' : 'below',
      strength: 82,
      label: 'PDH (Máx. ayer UTC)',
      detail: 'Liquidez diaria previa al alza',
    });
  }
  if (prevDayLow !== null && spot > 0) {
    levels.push({
      id: 'liq-pdl',
      price: prevDayLow,
      type: 'PDL',
      side: prevDayLow >= spot ? 'above' : 'below',
      strength: 82,
      label: 'PDL (Mín. ayer UTC)',
      detail: 'Liquidez diaria previa a la baja',
    });
  }

  if (optionsLevels.callWall > 0 && spot > 0) {
    levels.push({
      id: 'liq-cw',
      price: optionsLevels.callWall,
      type: 'CALL_WALL',
      side: optionsLevels.callWall >= spot ? 'above' : 'below',
      strength: 88,
      label: 'Call Wall (modelo)',
      detail: 'Mayor concentración positiva de GEX en opciones',
    });
  }
  if (optionsLevels.putWall > 0 && spot > 0) {
    levels.push({
      id: 'liq-pw',
      price: optionsLevels.putWall,
      type: 'PUT_WALL',
      side: optionsLevels.putWall >= spot ? 'above' : 'below',
      strength: 88,
      label: 'Put Wall (modelo)',
      detail: 'Mayor concentración negativa de GEX en opciones',
    });
  }
  if (optionsLevels.flip !== null && spot > 0) {
    levels.push({
      id: 'liq-flip',
      price: optionsLevels.flip,
      type: 'GEX_FLIP',
      side: optionsLevels.flip >= spot ? 'above' : 'below',
      strength: 84,
      label: 'GEX Flip (modelo)',
      detail: 'Umbral de cambio de régimen de cobertura de dealers',
    });
  }

  const sorted = levels.sort((a, b) => b.price - a.price);

  return {
    levels: sorted,
    nearestAskWall,
    nearestBidWall,
    strongestAskWall,
    strongestBidWall,
    nearestBSL: bsl[0] ?? null,
    nearestSSL: ssl[0] ?? null,
    pocPrice,
    bidTotalUsd: orderbook?.bidTotalUsd ?? 0,
    askTotalUsd: orderbook?.askTotalUsd ?? 0,
    imbalancePct: orderbook?.imbalancePct ?? 0,
  };
}
