import type { RawNewsHeadline } from '../calc/newsSentiment';
import type { Candle, SymbolAsset } from '../types/market';

export type NewsFeedPayload = {
  updatedAt: number;
  sources: string[];
  items: RawNewsHeadline[];
};

export type DailySentimentPoint = {
  ts: number;
  value: number; // 0..100 Fear & Greed
  classification: string;
};

export async function fetchNewsFeed(
  forceRefresh = false,
  signal?: AbortSignal
): Promise<NewsFeedPayload> {
  const q = forceRefresh ? '?refresh=1' : '';
  const res = await fetch(`/api/news${q}`, { cache: 'no-store', signal });
  if (!res.ok) {
    throw new Error(`Error al cargar noticias (${res.status})`);
  }
  const json = (await res.json()) as Partial<NewsFeedPayload>;
  return {
    updatedAt: json.updatedAt ?? Date.now(),
    sources: Array.isArray(json.sources) ? json.sources : [],
    items: Array.isArray(json.items) ? json.items : [],
  };
}

/**
 * Fetches 300 1H OKX index candles (~12.5 days) so news headlines across recent days
 * can always be matched accurately against hourly price action regardless of chart timeframe.
 */
export async function fetchNewsCorrelationCandles1h(
  asset: SymbolAsset,
  signal?: AbortSignal
): Promise<Candle[]> {
  const res = await fetch(
    `/api/okx/market/index-candles?instId=${asset}-USD&bar=1H&limit=300`,
    { signal }
  );
  if (!res.ok) return [];
  const json = (await res.json()) as { code: string; data: string[][] };
  if (json.code !== '0' || !Array.isArray(json.data)) return [];
  return json.data
    .map((row) => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: 0,
    }))
    .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c) && c.c > 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Fetches 100-day daily sentiment intensity series from /api/sentiment-history.
 */
export async function fetchDailySentimentHistory(
  signal?: AbortSignal
): Promise<DailySentimentPoint[]> {
  const res = await fetch('/api/sentiment-history', { cache: 'no-store', signal });
  if (!res.ok) return [];
  const json = (await res.json()) as { items?: DailySentimentPoint[] };
  return Array.isArray(json.items) ? json.items : [];
}

async function fetchSingleDailyIndexCandles(
  asset: SymbolAsset,
  limit = 110,
  signal?: AbortSignal
): Promise<Candle[]> {
  const res = await fetch(
    `/api/okx/market/index-candles?instId=${asset}-USD&bar=1Dutc&limit=${limit}`,
    { signal }
  );
  if (!res.ok) return [];
  const json = (await res.json()) as { code: string; data: string[][] };
  if (json.code !== '0' || !Array.isArray(json.data)) return [];
  return json.data
    .map((row) => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: 0,
    }))
    .filter((c) => Number.isFinite(c.t) && Number.isFinite(c.c) && c.c > 0)
    .sort((a, b) => a.t - b.t);
}

/**
 * Fetches 110 daily OKX candles for both BTC and ETH in parallel
 * for rolling 30-day volatility vs macro/news sentiment correlation.
 */
export async function fetchBtcEthDailyCandles(
  limit = 110,
  signal?: AbortSignal
): Promise<{ btcDaily: Candle[]; ethDaily: Candle[] }> {
  const [btcDaily, ethDaily] = await Promise.all([
    fetchSingleDailyIndexCandles('BTC', limit, signal),
    fetchSingleDailyIndexCandles('ETH', limit, signal),
  ]);
  return { btcDaily, ethDaily };
}
