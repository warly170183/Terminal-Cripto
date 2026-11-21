import type {
  Candle,
  OrderbookDepthData,
  OrderbookWall,
  SymbolAsset,
} from '../types/market';
import type { MultiTfScoringDataset, ScoringMode } from '../types/scoring';
import { fetchOrderbookWalls } from './okxMarketClient';

type OkxResponse<T> = {
  code: string;
  msg: string;
  data: T[];
};

async function fetchClosedMarketCandles(
  instId: string,
  bar: '4H' | '1H' | '15m',
  limit: number,
  isSpot: boolean,
  signal?: AbortSignal
): Promise<Candle[]> {
  const res = await fetch(
    `/api/okx/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`,
    { signal }
  );
  if (!res.ok) {
    throw new Error(`OKX candles ${instId} ${bar} HTTP ${res.status}`);
  }
  const json = (await res.json()) as OkxResponse<string[]>;
  if (json.code !== '0' || !Array.isArray(json.data)) {
    throw new Error(json.msg || `Error al obtener velas ${instId} ${bar}`);
  }

  // Strictly keep ONLY closed candles (confirm === '1') per v1.1 spec:
  // "Datos: Solo información disponible al decidir; velas cerradas"
  return json.data
    .filter((row) => row[8] === '1')
    .map((row) => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      // Spot candles: row[5] is base currency volume (BTC/ETH); SWAP: row[6] (volCcy) is base currency
      v: isSpot ? Number(row[5] ?? 0) : Number(row[6] ?? row[5] ?? 0),
    }))
    .filter(
      (c) =>
        Number.isFinite(c.t) &&
        Number.isFinite(c.o) &&
        Number.isFinite(c.h) &&
        Number.isFinite(c.l) &&
        Number.isFinite(c.c) &&
        c.c > 0
    )
    .sort((a, b) => a.t - b.t);
}

async function fetchOrderbookForInst(
  instId: string,
  asset: SymbolAsset,
  isSpot: boolean,
  signal?: AbortSignal
): Promise<OrderbookDepthData | null> {
  if (isSpot) {
    return fetchOrderbookWalls(asset, signal).catch(() => null);
  }
  try {
    const res = await fetch(`/api/okx/market/books?instId=${instId}&sz=400`, { signal });
    if (!res.ok) return fetchOrderbookWalls(asset, signal).catch(() => null);
    const json = (await res.json()) as OkxResponse<{
      asks: [string, string, string, string][];
      bids: [string, string, string, string][];
      ts: string;
    }>;
    if (json.code !== '0' || !json.data || json.data.length === 0) {
      return fetchOrderbookWalls(asset, signal).catch(() => null);
    }

    const book = json.data[0];
    const bestAsk = book.asks[0] ? Number(book.asks[0][0]) : 0;
    const bestBid = book.bids[0] ? Number(book.bids[0][0]) : 0;
    const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestAsk || bestBid;
    if (mid <= 0) return fetchOrderbookWalls(asset, signal).catch(() => null);

    // OKX SWAP book sz is in contracts; contract multiplier for BTC-USDT-SWAP is 0.01 BTC, ETH-USDT-SWAP is 0.1 ETH
    const ctVal = asset === 'BTC' ? 0.01 : 0.1;
    const bucketStep = mid >= 10_000 ? 150 : 5;
    const askBuckets = new Map<number, number>();
    const bidBuckets = new Map<number, number>();
    let askTotalUsd = 0;
    let bidTotalUsd = 0;

    for (const [pStr, szStr] of book.asks) {
      const p = Number(pStr);
      const szCoins = Number(szStr) * ctVal;
      if (!Number.isFinite(p) || !Number.isFinite(szCoins) || p <= 0 || szCoins <= 0) continue;
      askTotalUsd += p * szCoins;
      const bucket = Math.ceil(p / bucketStep) * bucketStep;
      askBuckets.set(bucket, (askBuckets.get(bucket) ?? 0) + szCoins);
    }

    for (const [pStr, szStr] of book.bids) {
      const p = Number(pStr);
      const szCoins = Number(szStr) * ctVal;
      if (!Number.isFinite(p) || !Number.isFinite(szCoins) || p <= 0 || szCoins <= 0) continue;
      bidTotalUsd += p * szCoins;
      const bucket = Math.floor(p / bucketStep) * bucketStep;
      bidBuckets.set(bucket, (bidBuckets.get(bucket) ?? 0) + szCoins);
    }

    const topAsks: OrderbookWall[] = Array.from(askBuckets.entries())
      .map(([price, sizeCoins]) => ({
        price,
        sizeCoins,
        notionalUsd: price * sizeCoins,
        distancePct: ((price - mid) / mid) * 100,
        side: 'ask' as const,
      }))
      .sort((a, b) => b.notionalUsd - a.notionalUsd)
      .slice(0, 6);

    const topBids: OrderbookWall[] = Array.from(bidBuckets.entries())
      .map(([price, sizeCoins]) => ({
        price,
        sizeCoins,
        notionalUsd: price * sizeCoins,
        distancePct: ((price - mid) / mid) * 100,
        side: 'bid' as const,
      }))
      .sort((a, b) => b.notionalUsd - a.notionalUsd)
      .slice(0, 6);

    const tot = bidTotalUsd + askTotalUsd;
    const imbalancePct = tot > 0 ? ((bidTotalUsd - askTotalUsd) / tot) * 100 : 0;

    return {
      bestBid,
      bestAsk,
      spreadPct: bestBid > 0 ? ((bestAsk - bestBid) / bestBid) * 100 : 0,
      bidTotalUsd,
      askTotalUsd,
      imbalancePct,
      walls: [...topAsks, ...topBids].sort((a, b) => b.price - a.price),
      ts: Number(book.ts) || Date.now(),
    };
  } catch {
    return fetchOrderbookWalls(asset, signal).catch(() => null);
  }
}

async function fetchOpenInterest1hSeries(
  asset: SymbolAsset,
  signal?: AbortSignal
): Promise<{ ts: number; oiUsd: number }[]> {
  try {
    const res = await fetch(
      `/api/okx/rubik/stat/contracts/open-interest-volume?ccy=${asset}&period=1H`,
      { signal }
    );
    if (!res.ok) return [];
    const json = (await res.json()) as OkxResponse<string[]>;
    if (json.code !== '0' || !Array.isArray(json.data)) return [];
    return json.data
      .map((row) => ({
        ts: Number(row[0]),
        oiUsd: Number(row[1]),
      }))
      .filter((r) => Number.isFinite(r.ts) && Number.isFinite(r.oiUsd) && r.oiUsd > 0)
      .sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

async function fetchSwapLiveOpenInterest(
  instId: string,
  signal?: AbortSignal
): Promise<{ oiCcy: number; oiUsd: number; ts: number } | null> {
  try {
    const res = await fetch(
      `/api/okx/public/open-interest?instType=SWAP&instId=${instId}`,
      { signal }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as OkxResponse<{
      instId: string;
      oiCcy: string;
      oiUsd?: string;
      ts: string;
    }>;
    if (json.code !== '0' || !json.data || !json.data[0]) return null;
    const row = json.data[0];
    const oiCcy = Number(row.oiCcy);
    const oiUsd = Number(row.oiUsd ?? 0);
    if (!Number.isFinite(oiCcy) || oiCcy <= 0) return null;
    return {
      oiCcy,
      oiUsd: Number.isFinite(oiUsd) ? oiUsd : 0,
      ts: Number(row.ts) || Date.now(),
    };
  } catch {
    return null;
  }
}

async function fetchFundingRateSnapshot(
  instId: string,
  signal?: AbortSignal
): Promise<{ current8h: number | null; history8h: number[] }> {
  try {
    const curRes = await fetch(`/api/okx/public/funding-rate?instId=${instId}`, { signal });
    let current8h: number | null = null;
    if (curRes.ok) {
      const curJson = (await curRes.json()) as OkxResponse<{
        fundingRate: string;
        fundingTime: string;
        nextFundingTime: string;
      }>;
      if (curJson.code === '0' && curJson.data[0]) {
        const raw = Number(curJson.data[0].fundingRate);
        if (Number.isFinite(raw)) {
          const intervalMs =
            Number(curJson.data[0].nextFundingTime) - Number(curJson.data[0].fundingTime);
          const hours = intervalMs > 0 ? intervalMs / 3_600_000 : 8;
          current8h = hours > 0 && hours !== 8 ? raw * (8 / hours) : raw;
        }
      }
    }

    // Fetch 3 pages of 100 entries (~270–300 8h periods = 90+ days)
    const history8h: number[] = [];
    let afterCursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const afterQ = afterCursor ? `&after=${afterCursor}` : '';
      const histRes = await fetch(
        `/api/okx/public/funding-rate-history?instId=${instId}&limit=100${afterQ}`,
        { signal }
      );
      if (!histRes.ok) break;
      const histJson = (await histRes.json()) as OkxResponse<{
        realizedRate?: string;
        fundingRate: string;
        fundingTime: string;
      }>;
      if (histJson.code !== '0' || !Array.isArray(histJson.data) || histJson.data.length === 0) {
        break;
      }
      for (const row of histJson.data) {
        const rate = Number(row.realizedRate ?? row.fundingRate);
        if (Number.isFinite(rate)) {
          history8h.push(rate);
        }
      }
      afterCursor = histJson.data[histJson.data.length - 1].fundingTime;
      if (histJson.data.length < 100) break;
    }

    return { current8h, history8h };
  } catch {
    return { current8h: null, history8h: [] };
  }
}

export async function fetchScoringDataset(
  asset: SymbolAsset,
  modeOrSignal?: ScoringMode | AbortSignal,
  maybeSignal?: AbortSignal
): Promise<MultiTfScoringDataset> {
  const mode: ScoringMode =
    typeof modeOrSignal === 'string' ? modeOrSignal : 'perpetual';
  const signal: AbortSignal | undefined =
    typeof modeOrSignal === 'string' ? maybeSignal : modeOrSignal;

  const isSpot = mode === 'spot';
  const instId = isSpot ? `${asset}-USDT` : `${asset}-USDT-SWAP`;
  const btcInstId = isSpot ? 'BTC-USDT' : 'BTC-USDT-SWAP';

  const [
    candles4h,
    candles1h,
    candles15m,
    btcCandles4h,
    orderbook,
    oiSeries1h,
    swapLiveOi,
    funding,
  ] = await Promise.all([
    fetchClosedMarketCandles(instId, '4H', 260, isSpot, signal),
    fetchClosedMarketCandles(instId, '1H', 300, isSpot, signal),
    fetchClosedMarketCandles(instId, '15m', 220, isSpot, signal),
    asset === 'BTC'
      ? Promise.resolve<Candle[]>([])
      : fetchClosedMarketCandles(btcInstId, '4H', 120, isSpot, signal),
    fetchOrderbookForInst(instId, asset, isSpot, signal),
    isSpot ? Promise.resolve([]) : fetchOpenInterest1hSeries(asset, signal),
    isSpot ? Promise.resolve(null) : fetchSwapLiveOpenInterest(`${asset}-USDT-SWAP`, signal),
    isSpot
      ? Promise.resolve({ current8h: null, history8h: [] })
      : fetchFundingRateSnapshot(`${asset}-USDT-SWAP`, signal),
  ]);

  return {
    asset,
    instId,
    candles4h,
    candles1h,
    candles15m,
    btcCandles4h: asset === 'BTC' ? candles4h : btcCandles4h,
    orderbook,
    oiSeries1h,
    swapLiveOi,
    fundingCurrent8h: funding.current8h,
    fundingHistory8h: funding.history8h,
    fetchedAt: Date.now(),
  };
}
