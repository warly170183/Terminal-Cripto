import type { SymbolAsset } from '../types/market';

export type TakerTradeItem = {
  id: string;
  price: number;
  size: number;
  notionalUsd: number;
  side: 'buy' | 'sell';
  ts: number;
};

export type TakerTapeSummary = {
  trades: TakerTradeItem[];
  buyCoins: number;
  sellCoins: number;
  buyUsd: number;
  sellUsd: number;
  netDeltaCoins: number;
  netDeltaUsd: number;
  buyRatioPct: number;
  fetchedAt: number;
};

export type DepthCurvePoint = {
  price: number;
  cumulativeUsd: number;
  distancePct: number;
  side: 'bid' | 'ask';
};

export type OrderbookCurveSnapshot = {
  midPrice: number;
  spreadPct: number;
  bids: DepthCurvePoint[];
  asks: DepthCurvePoint[];
  totalBidUsd: number;
  totalAskUsd: number;
  ts: number;
};

type OkxResponse<T> = {
  code: string;
  msg: string;
  data: T[];
};

export async function fetchLiveTakerTrades(
  asset: SymbolAsset,
  signal?: AbortSignal
): Promise<TakerTapeSummary | null> {
  const res = await fetch(`/api/okx/market/trades?instId=${asset}-USDT&limit=100`, { signal });
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
    const size = Number(row.sz);
    const notionalUsd = price * size;
    if (row.side === 'buy') {
      buyCoins += size;
      buyUsd += notionalUsd;
    } else {
      sellCoins += size;
      sellUsd += notionalUsd;
    }
    return {
      id: row.tradeId,
      price,
      size,
      notionalUsd,
      side: row.side,
      ts: Number(row.ts),
    };
  });

  const totalUsd = buyUsd + sellUsd;
  return {
    trades,
    buyCoins,
    sellCoins,
    buyUsd,
    sellUsd,
    netDeltaCoins: buyCoins - sellCoins,
    netDeltaUsd: buyUsd - sellUsd,
    buyRatioPct: totalUsd > 0 ? (buyUsd / totalUsd) * 100 : 50,
    fetchedAt: Date.now(),
  };
}

export async function fetchOrderbookDepthCurve(
  asset: SymbolAsset,
  signal?: AbortSignal
): Promise<OrderbookCurveSnapshot | null> {
  const res = await fetch(`/api/okx/market/books?instId=${asset}-USDT&sz=400`, { signal });
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

  const bids: DepthCurvePoint[] = [];
  let cumBid = 0;
  for (const [pStr, szStr] of book.bids) {
    const price = Number(pStr);
    const sz = Number(szStr);
    if (!Number.isFinite(price) || !Number.isFinite(sz) || price <= 0 || sz <= 0) continue;
    cumBid += price * sz;
    bids.push({
      price,
      cumulativeUsd: cumBid,
      distancePct: ((price - midPrice) / midPrice) * 100,
      side: 'bid',
    });
  }

  const asks: DepthCurvePoint[] = [];
  let cumAsk = 0;
  for (const [pStr, szStr] of book.asks) {
    const price = Number(pStr);
    const sz = Number(szStr);
    if (!Number.isFinite(price) || !Number.isFinite(sz) || price <= 0 || sz <= 0) continue;
    cumAsk += price * sz;
    asks.push({
      price,
      cumulativeUsd: cumAsk,
      distancePct: ((price - midPrice) / midPrice) * 100,
      side: 'ask',
    });
  }

  return {
    midPrice,
    spreadPct: bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0,
    bids: bids.reverse(), // ascending price toward midPrice
    asks, // ascending price away from midPrice
    totalBidUsd: cumBid,
    totalAskUsd: cumAsk,
    ts: Number(book.ts) || Date.now(),
  };
}
