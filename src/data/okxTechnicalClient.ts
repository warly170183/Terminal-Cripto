import type {
  Candle,
  OrderbookDepthData,
  OrderbookWall,
  SymbolAsset,
  Timeframe,
} from '../types/market';

export type TechnicalMarketMode = 'spot' | 'perp';

export type TakerTradeItem = {
  id: string;
  price: number;
  size: number;
  notionalUsd: number;
  side: 'buy' | 'sell';
  ts: number;
};

export type TakerTapeSummary = {
  instId: string;
  marketMode: TechnicalMarketMode;
  trades: TakerTradeItem[];
  buyCoins: number;
  sellCoins: number;
  buyUsd: number;
  sellUsd: number;
  netDeltaCoins: number;
  netDeltaUsd: number;
  buyRatioPct: number;
  priceChangePct: number;
  absorption: {
    detected: boolean;
    side: 'compra' | 'venta' | null;
    summary: string;
  };
  fetchedAt: number;
};

export type DepthCurvePoint = {
  price: number;
  cumulativeUsd: number;
  distancePct: number;
  side: 'bid' | 'ask';
};

export type OrderbookCurveSnapshot = {
  instId: string;
  marketMode: TechnicalMarketMode;
  midPrice: number;
  spreadPct: number;
  bids: DepthCurvePoint[];
  asks: DepthCurvePoint[];
  totalBidUsd: number;
  totalAskUsd: number;
  orderbookDepth: OrderbookDepthData;
  ts: number;
};

export type PerpDerivativesTelemetry = {
  oiUsd: number | null;
  oiCcy: number | null;
  fundingRatePct: number | null; // per 8h in %
  nextFundingTs: number | null;
  oiSeries: { t: number; oiUsd: number }[];
  fundingHistory: { t: number; ratePct: number }[];
};

type OkxResponse<T> = {
  code: string;
  msg: string;
  data: T[];
};

const OKX_BAR_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1H': '1H',
  '4H': '4H',
  D: '1Dutc',
};

function getSwapContractCoinVal(asset: SymbolAsset): number {
  return asset === 'BTC' ? 0.01 : 0.1;
}

export function getTechInstId(asset: SymbolAsset, mode: TechnicalMarketMode): string {
  return mode === 'perp' ? `${asset}-USDT-SWAP` : `${asset}-USDT`;
}

export async function fetchLiveTakerTrades(
  asset: SymbolAsset,
  marketMode: TechnicalMarketMode = 'spot',
  signal?: AbortSignal
): Promise<TakerTapeSummary | null> {
  const instId = getTechInstId(asset, marketMode);
  const ctVal = marketMode === 'perp' ? getSwapContractCoinVal(asset) : 1;

  const res = await fetch(`/api/okx/market/trades?instId=${instId}&limit=100`, { signal });
  if (!res.ok) return null;
  const json = (await res.json()) as OkxResponse<{
    tradeId: string;
    px: string;
    sz: string;
    side: 'buy' | 'sell';
    ts: string;
  }>;
  if (json.code !== '0' || !Array.isArray(json.data)) return null;

  let buyCoins = 0;
  let sellCoins = 0;
  let buyUsd = 0;
  let sellUsd = 0;

  const trades: TakerTradeItem[] = json.data.map((row) => {
    const price = Number(row.px);
    const sizeCoins = Number(row.sz) * ctVal;
    const notionalUsd = price * sizeCoins;
    if (row.side === 'buy') {
      buyCoins += sizeCoins;
      buyUsd += notionalUsd;
    } else {
      sellCoins += sizeCoins;
      sellUsd += notionalUsd;
    }
    return {
      id: row.tradeId,
      price,
      size: sizeCoins,
      notionalUsd,
      side: row.side,
      ts: Number(row.ts),
    };
  });

  const totalUsd = buyUsd + sellUsd;
  const buyRatioPct = totalUsd > 0 ? (buyUsd / totalUsd) * 100 : 50;

  let priceChangePct = 0;
  if (trades.length >= 2) {
    const oldest = trades[trades.length - 1].price;
    const newest = trades[0].price;
    if (oldest > 0) {
      priceChangePct = ((newest - oldest) / oldest) * 100;
    }
  }

  // Absorption: strong aggressive taker imbalance without matching price progress
  const skew = buyRatioPct - 50;
  const absorptionBuy = skew <= -16 && priceChangePct >= -0.04;
  const absorptionSell = skew >= 16 && priceChangePct <= 0.04;

  const absorption: TakerTapeSummary['absorption'] = absorptionBuy
    ? {
        detected: true,
        side: 'compra',
        summary: `Absorción pasiva compradora: fuerte presión vendedora (${(100 - buyRatioPct).toFixed(0)}%) sin desplome de precio.`,
      }
    : absorptionSell
    ? {
        detected: true,
        side: 'venta',
        summary: `Absorción pasiva vendedora: fuerte agresión compradora (${buyRatioPct.toFixed(0)}%) frenada sin avance.`,
      }
    : {
        detected: false,
        side: null,
        summary: 'Flujo balanceado o direccional sin absorción anómala.',
      };

  return {
    instId,
    marketMode,
    trades,
    buyCoins,
    sellCoins,
    buyUsd,
    sellUsd,
    netDeltaCoins: buyCoins - sellCoins,
    netDeltaUsd: buyUsd - sellUsd,
    buyRatioPct,
    priceChangePct,
    absorption,
    fetchedAt: Date.now(),
  };
}

export async function fetchOrderbookDepthCurve(
  asset: SymbolAsset,
  marketMode: TechnicalMarketMode = 'spot',
  signal?: AbortSignal
): Promise<OrderbookCurveSnapshot | null> {
  const instId = getTechInstId(asset, marketMode);
  const ctVal = marketMode === 'perp' ? getSwapContractCoinVal(asset) : 1;

  const res = await fetch(`/api/okx/market/books?instId=${instId}&sz=400`, { signal });
  if (!res.ok) return null;
  const json = (await res.json()) as OkxResponse<{
    asks: [string, string, string, string][];
    bids: [string, string, string, string][];
    ts: string;
  }>;
  if (json.code !== '0' || !json.data || json.data.length === 0) return null;

  const book = json.data[0];
  const bestAsk = book.asks[0] ? Number(book.asks[0][0]) : 0;
  const bestBid = book.bids[0] ? Number(book.bids[0][0]) : 0;
  const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestAsk || bestBid;
  if (midPrice <= 0) return null;

  const bucketStep = midPrice >= 10_000 ? 150 : 5;
  const askBuckets = new Map<number, number>();
  const bidBuckets = new Map<number, number>();

  const bids: DepthCurvePoint[] = [];
  let cumBid = 0;
  for (const [pStr, szStr] of book.bids) {
    const price = Number(pStr);
    const szCoins = Number(szStr) * ctVal;
    if (!Number.isFinite(price) || !Number.isFinite(szCoins) || price <= 0 || szCoins <= 0) continue;
    cumBid += price * szCoins;
    bids.push({
      price,
      cumulativeUsd: cumBid,
      distancePct: ((price - midPrice) / midPrice) * 100,
      side: 'bid',
    });
    const b = Math.floor(price / bucketStep) * bucketStep;
    bidBuckets.set(b, (bidBuckets.get(b) ?? 0) + szCoins);
  }

  const asks: DepthCurvePoint[] = [];
  let cumAsk = 0;
  for (const [pStr, szStr] of book.asks) {
    const price = Number(pStr);
    const szCoins = Number(szStr) * ctVal;
    if (!Number.isFinite(price) || !Number.isFinite(szCoins) || price <= 0 || szCoins <= 0) continue;
    cumAsk += price * szCoins;
    asks.push({
      price,
      cumulativeUsd: cumAsk,
      distancePct: ((price - midPrice) / midPrice) * 100,
      side: 'ask',
    });
    const b = Math.ceil(price / bucketStep) * bucketStep;
    askBuckets.set(b, (askBuckets.get(b) ?? 0) + szCoins);
  }

  const topAsks: OrderbookWall[] = Array.from(askBuckets.entries())
    .map(([price, sizeCoins]) => ({
      price,
      sizeCoins,
      notionalUsd: price * sizeCoins,
      distancePct: ((price - midPrice) / midPrice) * 100,
      side: 'ask' as const,
    }))
    .sort((a, b) => b.notionalUsd - a.notionalUsd)
    .slice(0, 6);

  const topBids: OrderbookWall[] = Array.from(bidBuckets.entries())
    .map(([price, sizeCoins]) => ({
      price,
      sizeCoins,
      notionalUsd: price * sizeCoins,
      distancePct: ((price - midPrice) / midPrice) * 100,
      side: 'bid' as const,
    }))
    .sort((a, b) => b.notionalUsd - a.notionalUsd)
    .slice(0, 6);

  const tot = cumBid + cumAsk;
  const imbalancePct = tot > 0 ? ((cumBid - cumAsk) / tot) * 100 : 0;
  const spreadPct = bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0;
  const ts = Number(book.ts) || Date.now();

  return {
    instId,
    marketMode,
    midPrice,
    spreadPct,
    bids: bids.reverse(),
    asks,
    totalBidUsd: cumBid,
    totalAskUsd: cumAsk,
    orderbookDepth: {
      bestBid,
      bestAsk,
      spreadPct,
      bidTotalUsd: cumBid,
      askTotalUsd: cumAsk,
      imbalancePct,
      walls: [...topAsks, ...topBids].sort((a, b) => b.price - a.price),
      ts,
    },
    ts,
  };
}

export async function fetchTechnicalMarketCandles(
  asset: SymbolAsset,
  timeframe: Timeframe,
  marketMode: TechnicalMarketMode,
  limit = 300,
  afterTs?: number,
  signal?: AbortSignal
): Promise<Candle[]> {
  const bar = OKX_BAR_MAP[timeframe];
  const instId = getTechInstId(asset, marketMode);
  const isSpot = marketMode === 'spot';
  const afterQ = afterTs !== undefined ? `&after=${afterTs}` : '';
  const endpoint = afterTs !== undefined ? 'history-candles' : 'candles';

  const res = await fetch(
    `/api/okx/market/${endpoint}?instId=${instId}&bar=${bar}&limit=${limit}${afterQ}`,
    { signal }
  );
  if (!res.ok) {
    throw new Error(`OKX ${instId} ${bar} HTTP ${res.status}`);
  }
  const json = (await res.json()) as OkxResponse<string[]>;
  if (json.code !== '0' || !Array.isArray(json.data)) {
    throw new Error(json.msg || `Error velas ${instId}`);
  }

  return json.data
    .map((row) => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: isSpot ? Number(row[5] ?? 0) : Number(row[6] ?? row[5] ?? 0),
    }))
    .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c) && c.c > 0)
    .sort((a, b) => a.t - b.t);
}

export async function fetchMultiTimeframeCandles(
  asset: SymbolAsset,
  marketMode: TechnicalMarketMode,
  signal?: AbortSignal
): Promise<Partial<Record<'15m' | '1H' | '4H' | 'D', Candle[]>>> {
  const tfs: ('15m' | '1H' | '4H' | 'D')[] = ['15m', '1H', '4H', 'D'];
  const results = await Promise.allSettled(
    tfs.map((tf) => fetchTechnicalMarketCandles(asset, tf, marketMode, 220, undefined, signal))
  );

  const out: Partial<Record<'15m' | '1H' | '4H' | 'D', Candle[]>> = {};
  tfs.forEach((tf, idx) => {
    const r = results[idx];
    if (r.status === 'fulfilled' && r.value.length > 0) {
      out[tf] = r.value;
    }
  });
  return out;
}

export async function fetchPerpDerivativesTelemetry(
  asset: SymbolAsset,
  timeframe: Timeframe,
  signal?: AbortSignal
): Promise<PerpDerivativesTelemetry> {
  const instId = `${asset}-USDT-SWAP`;
  const rubikPeriod =
    timeframe === '1m' || timeframe === '5m'
      ? '5m'
      : timeframe === '15m' || timeframe === '30m' || timeframe === '1H'
      ? '1H'
      : timeframe === '4H'
      ? '4H'
      : '1D';

  const [oiLiveRes, fundingRes, oiHistRes, fundHistRes] = await Promise.allSettled([
    fetch(`/api/okx/public/open-interest?instType=SWAP&instId=${instId}`, { signal }),
    fetch(`/api/okx/public/funding-rate?instId=${instId}`, { signal }),
    fetch(`/api/okx/rubik/stat/contracts/open-interest-volume?ccy=${asset}&period=${rubikPeriod}`, {
      signal,
    }),
    fetch(`/api/okx/public/funding-rate-history?instId=${instId}&limit=48`, { signal }),
  ]);

  let oiUsd: number | null = null;
  let oiCcy: number | null = null;
  if (oiLiveRes.status === 'fulfilled' && oiLiveRes.value.ok) {
    const j = (await oiLiveRes.value.json()) as OkxResponse<{
      oiCcy?: string;
      oiUsd?: string;
    }>;
    if (j.code === '0' && j.data?.[0]) {
      const ccy = Number(j.data[0].oiCcy);
      const usd = Number(j.data[0].oiUsd);
      if (Number.isFinite(ccy) && ccy > 0) oiCcy = ccy;
      if (Number.isFinite(usd) && usd > 0) oiUsd = usd;
    }
  }

  let fundingRatePct: number | null = null;
  let nextFundingTs: number | null = null;
  if (fundingRes.status === 'fulfilled' && fundingRes.value.ok) {
    const j = (await fundingRes.value.json()) as OkxResponse<{
      fundingRate: string;
      nextFundingTime: string;
    }>;
    if (j.code === '0' && j.data?.[0]) {
      const raw = Number(j.data[0].fundingRate);
      if (Number.isFinite(raw)) fundingRatePct = raw * 100;
      const nft = Number(j.data[0].nextFundingTime);
      if (Number.isFinite(nft) && nft > 0) nextFundingTs = nft;
    }
  }

  let oiSeries: { t: number; oiUsd: number }[] = [];
  if (oiHistRes.status === 'fulfilled' && oiHistRes.value.ok) {
    const j = (await oiHistRes.value.json()) as OkxResponse<string[]>;
    if (j.code === '0' && Array.isArray(j.data)) {
      oiSeries = j.data
        .map((row) => ({ t: Number(row[0]), oiUsd: Number(row[1]) }))
        .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.oiUsd) && x.oiUsd > 0)
        .sort((a, b) => a.t - b.t);
    }
  }

  let fundingHistory: { t: number; ratePct: number }[] = [];
  if (fundHistRes.status === 'fulfilled' && fundHistRes.value.ok) {
    const j = (await fundHistRes.value.json()) as OkxResponse<{
      fundingTime: string;
      realizedRate?: string;
      fundingRate: string;
    }>;
    if (j.code === '0' && Array.isArray(j.data)) {
      fundingHistory = j.data
        .map((row) => ({
          t: Number(row.fundingTime),
          ratePct: Number(row.realizedRate ?? row.fundingRate) * 100,
        }))
        .filter((x) => Number.isFinite(x.t) && Number.isFinite(x.ratePct))
        .sort((a, b) => a.t - b.t);
    }
  }

  return {
    oiUsd,
    oiCcy,
    fundingRatePct,
    nextFundingTs,
    oiSeries,
    fundingHistory,
  };
}
