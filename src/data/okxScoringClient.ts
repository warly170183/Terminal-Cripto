import type { Candle, SymbolAsset } from '../types/market';
import type { MultiTfScoringDataset } from '../types/scoring';
import { fetchOrderbookWalls } from './okxMarketClient';

type OkxResponse<T> = {
  code: string;
  msg: string;
  data: T[];
};

async function fetchClosedSwapCandles(
  instId: string,
  bar: '4H' | '1H' | '15m',
  limit: number,
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
      // row[6] is volCcy (base currency volume, e.g. BTC or ETH)
      v: Number(row[6] ?? row[5] ?? 0),
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
          // OKX perpetual funding is settled every 8h; normalize if interval differs
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
  signal?: AbortSignal
): Promise<MultiTfScoringDataset> {
  const instId = `${asset}-USDT-SWAP`;

  const [
    candles4h,
    candles1h,
    candles15m,
    btcCandles4h,
    orderbook,
    oiSeries1h,
    funding,
  ] = await Promise.all([
    fetchClosedSwapCandles(instId, '4H', 260, signal),
    fetchClosedSwapCandles(instId, '1H', 300, signal),
    fetchClosedSwapCandles(instId, '15m', 220, signal),
    asset === 'BTC'
      ? Promise.resolve<Candle[]>([])
      : fetchClosedSwapCandles('BTC-USDT-SWAP', '4H', 120, signal),
    fetchOrderbookWalls(asset, signal).catch(() => null),
    fetchOpenInterest1hSeries(asset, signal),
    fetchFundingRateSnapshot(instId, signal),
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
    fundingCurrent8h: funding.current8h,
    fundingHistory8h: funding.history8h,
    fetchedAt: Date.now(),
  };
}
