import type {
  Candle,
  OrderbookDepthData,
  OrderbookWall,
  SymbolAsset,
  TickerSnapshot,
  Timeframe,
} from '../types/market';

const OKX_BAR_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1H': '1H',
  '4H': '4H',
  D: '1Dutc',
};

const OKX_WS_CHANNEL_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1H': '1H',
  '4H': '4H',
  D: '1Dutc',
};

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1H': 60 * 60_000,
  '4H': 4 * 60 * 60_000,
  D: 24 * 60 * 60_000,
};

type OkxResponse<T> = {
  code: string;
  msg: string;
  data: T[];
};

export async function fetchIndexCandles(
  asset: SymbolAsset,
  timeframe: Timeframe,
  limit = 300,
  afterTs?: number,
  signal?: AbortSignal
): Promise<Candle[]> {
  const bar = OKX_BAR_MAP[timeframe];
  const indexInstId = `${asset}-USD`;
  const spotInstId = `${asset}-USDT`;
  const afterQuery = afterTs !== undefined ? `&after=${afterTs}` : '';

  const [idxRes, spotRes] = await Promise.all([
    fetch(
      `/api/okx/market/index-candles?instId=${indexInstId}&bar=${bar}&limit=${limit}${afterQuery}`,
      { signal }
    ),
    fetch(
      `/api/okx/market/candles?instId=${spotInstId}&bar=${bar}&limit=${limit}${afterQuery}`,
      { signal }
    ).catch(() => null),
  ]);

  if (!idxRes.ok) {
    throw new Error(`OKX index-candles HTTP ${idxRes.status}`);
  }
  const idxJson = (await idxRes.json()) as OkxResponse<string[]>;
  if (idxJson.code !== '0') {
    throw new Error(idxJson.msg || 'Error al obtener velas de OKX');
  }

  // Build volume map from spot OKX candles (volCcy = base currency volume)
  const volMap = new Map<number, number>();
  if (spotRes && spotRes.ok) {
    try {
      const spotJson = (await spotRes.json()) as OkxResponse<string[]>;
      if (spotJson.code === '0' && Array.isArray(spotJson.data)) {
        for (const row of spotJson.data) {
          const ts = Number(row[0]);
          const vol = Number(row[5]); // base currency volume (BTC/ETH)
          if (Number.isFinite(ts) && Number.isFinite(vol)) {
            volMap.set(ts, vol);
          }
        }
      }
    } catch {
      // Non-fatal: continue with 0 volume fallback if spot volume temporarily unavailable
    }
  }

  // OKX returns newest first; sort ascending by timestamp
  return idxJson.data
    .map((row) => {
      const t = Number(row[0]);
      return {
        t,
        o: Number(row[1]),
        h: Number(row[2]),
        l: Number(row[3]),
        c: Number(row[4]),
        v: volMap.get(t) ?? 0,
      };
    })
    .sort((a, b) => a.t - b.t);
}

export async function fetchPrevDayCandles(
  asset: SymbolAsset,
  signal?: AbortSignal
): Promise<Candle[]> {
  const res = await fetch(
    `/api/okx/market/index-candles?instId=${asset}-USD&bar=1Dutc&limit=5`,
    { signal }
  );
  if (!res.ok) return [];
  const json = (await res.json()) as OkxResponse<string[]>;
  if (json.code !== '0') return [];
  return json.data
    .map((row) => ({
      t: Number(row[0]),
      o: Number(row[1]),
      h: Number(row[2]),
      l: Number(row[3]),
      c: Number(row[4]),
      v: 0,
    }))
    .sort((a, b) => a.t - b.t);
}

export async function fetchIndexTicker(
  asset: SymbolAsset,
  signal?: AbortSignal
): Promise<TickerSnapshot | null> {
  const res = await fetch(`/api/okx/market/index-tickers?instId=${asset}-USD`, { signal });
  if (!res.ok) return null;
  const json = (await res.json()) as OkxResponse<{
    instId: string;
    idxPx: string;
    high24h: string;
    low24h: string;
    open24h: string;
    sodUtc0: string;
    ts: string;
  }>;
  if (json.code !== '0' || json.data.length === 0) return null;
  const d = json.data[0];
  return {
    instId: d.instId,
    idxPx: Number(d.idxPx),
    high24h: Number(d.high24h),
    low24h: Number(d.low24h),
    open24h: Number(d.open24h),
    sodUtc0: Number(d.sodUtc0),
    ts: Number(d.ts),
  };
}

export async function fetchOrderbookWalls(
  asset: SymbolAsset,
  signal?: AbortSignal
): Promise<OrderbookDepthData | null> {
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
  const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestAsk || bestBid;
  if (mid <= 0) return null;

  const bucketStep = mid >= 10_000 ? 150 : 5;
  const askBuckets = new Map<number, number>();
  const bidBuckets = new Map<number, number>();
  let askTotalUsd = 0;
  let bidTotalUsd = 0;

  for (const [pStr, szStr] of book.asks) {
    const p = Number(pStr);
    const sz = Number(szStr);
    if (!Number.isFinite(p) || !Number.isFinite(sz) || p <= 0 || sz <= 0) continue;
    askTotalUsd += p * sz;
    const bucket = Math.ceil(p / bucketStep) * bucketStep;
    askBuckets.set(bucket, (askBuckets.get(bucket) ?? 0) + sz);
  }

  for (const [pStr, szStr] of book.bids) {
    const p = Number(pStr);
    const sz = Number(szStr);
    if (!Number.isFinite(p) || !Number.isFinite(sz) || p <= 0 || sz <= 0) continue;
    bidTotalUsd += p * sz;
    const bucket = Math.floor(p / bucketStep) * bucketStep;
    bidBuckets.set(bucket, (bidBuckets.get(bucket) ?? 0) + sz);
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
}

/**
 * Paginates backward through OKX /api/v5/market/history-candles for backtesting.
 */
export async function fetchHistoryCandlesPaginated(
  instId: string,
  timeframe: Timeframe,
  startTs: number,
  endTs: number,
  onProgress?: (pct: number, loadedCount: number) => void,
  signal?: AbortSignal
): Promise<Candle[]> {
  const bar = OKX_BAR_MAP[timeframe];
  const barMs = TIMEFRAME_MS[timeframe];
  const collected = new Map<number, Candle>();

  let cursorAfter: number | undefined = endTs + barMs;
  const totalSpan = Math.max(barMs, endTs - startTs);
  let pages = 0;
  const MAX_PAGES = 60; // up to 18,000 candles safety cap

  while (pages < MAX_PAGES) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const params = new URLSearchParams({
      instId,
      bar,
      limit: '300',
    });
    if (cursorAfter !== undefined) {
      params.set('after', String(cursorAfter));
    }

    const res = await fetch(`/api/okx/market/history-candles?${params.toString()}`, { signal });
    if (!res.ok) {
      throw new Error(`Error OKX history-candles HTTP ${res.status}`);
    }
    const json = (await res.json()) as OkxResponse<string[]>;
    if (json.code !== '0') {
      throw new Error(json.msg || 'Error al descargar velas históricas');
    }
    if (!json.data || json.data.length === 0) {
      break;
    }

    let oldestTsInPage = Infinity;
    for (const row of json.data) {
      const t = Number(row[0]);
      if (t < oldestTsInPage) oldestTsInPage = t;
      if (t >= startTs && t <= endTs) {
        collected.set(t, {
          t,
          o: Number(row[1]),
          h: Number(row[2]),
          l: Number(row[3]),
          c: Number(row[4]),
          v: Number(row[5] || 0),
        });
      }
    }

    pages++;
    const coveredSpan = Math.max(0, endTs - oldestTsInPage);
    const pct = Math.min(99, Math.round((coveredSpan / totalSpan) * 100));
    onProgress?.(pct, collected.size);

    if (oldestTsInPage <= startTs || oldestTsInPage >= (cursorAfter ?? Infinity)) {
      break;
    }

    cursorAfter = oldestTsInPage;
    // Gentle throttle to stay well within OKX public rate limits
    await new Promise((r) => setTimeout(r, 90));
  }

  onProgress?.(100, collected.size);
  return Array.from(collected.values()).sort((a, b) => a.t - b.t);
}

export type StreamConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export type LiveStreamCallbacks = {
  onTicker: (ticker: TickerSnapshot) => void;
  onIndexCandle: (candle: Omit<Candle, 'v'>) => void;
  onSpotVolume: (ts: number, vol: number) => void;
  onStatusChange: (status: StreamConnectionStatus) => void;
};

/**
 * Dual WebSocket client for OKX public index-tickers and business index-candle/spot volume.
 * Automatically reconnects with exponential backoff.
 */
export class OkxLiveStream {
  private asset: SymbolAsset;
  private timeframe: Timeframe;
  private callbacks: LiveStreamCallbacks;
  private publicWs: WebSocket | null = null;
  private businessWs: WebSocket | null = null;
  private stopped = false;
  private retryAttempt = 0;
  private retryTimerPublic: ReturnType<typeof setTimeout> | null = null;
  private retryTimerBiz: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private publicConnected = false;
  private bizConnected = false;

  constructor(asset: SymbolAsset, timeframe: Timeframe, callbacks: LiveStreamCallbacks) {
    this.asset = asset;
    this.timeframe = timeframe;
    this.callbacks = callbacks;
  }

  start() {
    this.stopped = false;
    this.callbacks.onStatusChange('connecting');
    this.connectPublic();
    this.connectBusiness();

    this.pingInterval = setInterval(() => {
      if (this.publicWs?.readyState === WebSocket.OPEN) {
        this.publicWs.send('ping');
      }
      if (this.businessWs?.readyState === WebSocket.OPEN) {
        this.businessWs.send('ping');
      }
    }, 20_000);
  }

  updateSubscription(asset: SymbolAsset, timeframe: Timeframe) {
    this.asset = asset;
    this.timeframe = timeframe;
    this.stop();
    this.start();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimerPublic) clearTimeout(this.retryTimerPublic);
    if (this.retryTimerBiz) clearTimeout(this.retryTimerBiz);
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.retryTimerPublic = null;
    this.retryTimerBiz = null;
    this.pingInterval = null;

    if (this.publicWs) {
      this.publicWs.onclose = null;
      this.publicWs.onerror = null;
      this.publicWs.onmessage = null;
      this.publicWs.close();
      this.publicWs = null;
    }
    if (this.businessWs) {
      this.businessWs.onclose = null;
      this.businessWs.onerror = null;
      this.businessWs.onmessage = null;
      this.businessWs.close();
      this.businessWs = null;
    }
    this.publicConnected = false;
    this.bizConnected = false;
  }

  private emitCombinedStatus() {
    if (this.stopped) return;
    if (this.publicConnected && this.bizConnected) {
      this.retryAttempt = 0;
      this.callbacks.onStatusChange('connected');
    } else if (!this.publicConnected && !this.bizConnected) {
      this.callbacks.onStatusChange('disconnected');
    } else {
      this.callbacks.onStatusChange('connecting');
    }
  }

  private connectPublic() {
    if (this.stopped) return;
    try {
      const ws = new WebSocket('wss://ws.okx.com/ws/v5/public');
      this.publicWs = ws;

      ws.onopen = () => {
        if (this.stopped) {
          ws.close();
          return;
        }
        this.publicConnected = true;
        this.emitCombinedStatus();
        ws.send(
          JSON.stringify({
            op: 'subscribe',
            args: [{ channel: 'index-tickers', instId: `${this.asset}-USD` }],
          })
        );
      };

      ws.onmessage = (ev) => {
        if (ev.data === 'pong') return;
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.arg?.channel === 'index-tickers' && Array.isArray(msg.data) && msg.data[0]) {
            const d = msg.data[0];
            this.callbacks.onTicker({
              instId: d.instId,
              idxPx: Number(d.idxPx),
              high24h: Number(d.high24h),
              low24h: Number(d.low24h),
              open24h: Number(d.open24h),
              sodUtc0: Number(d.sodUtc0),
              ts: Number(d.ts),
            });
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onerror = () => {
        this.publicConnected = false;
        this.emitCombinedStatus();
      };

      ws.onclose = () => {
        this.publicConnected = false;
        this.emitCombinedStatus();
        if (!this.stopped) {
          const delay = Math.min(15_000, 1000 * Math.pow(2, this.retryAttempt));
          this.retryAttempt = Math.min(this.retryAttempt + 1, 5);
          this.retryTimerPublic = setTimeout(() => this.connectPublic(), delay);
        }
      };
    } catch {
      this.publicConnected = false;
      this.emitCombinedStatus();
    }
  }

  private connectBusiness() {
    if (this.stopped) return;
    try {
      const ws = new WebSocket('wss://ws.okx.com/ws/v5/business');
      this.businessWs = ws;
      const suffix = OKX_WS_CHANNEL_MAP[this.timeframe];
      const idxChan = `index-candle${suffix}`;
      const spotChan = `candle${suffix}`;

      ws.onopen = () => {
        if (this.stopped) {
          ws.close();
          return;
        }
        this.bizConnected = true;
        this.emitCombinedStatus();
        ws.send(
          JSON.stringify({
            op: 'subscribe',
            args: [
              { channel: idxChan, instId: `${this.asset}-USD` },
              { channel: spotChan, instId: `${this.asset}-USDT` },
            ],
          })
        );
      };

      ws.onmessage = (ev) => {
        if (ev.data === 'pong') return;
        try {
          const msg = JSON.parse(String(ev.data));
          if (!Array.isArray(msg.data) || msg.data.length === 0) return;
          const row = msg.data[0] as string[];
          if (msg.arg?.channel === idxChan) {
            this.callbacks.onIndexCandle({
              t: Number(row[0]),
              o: Number(row[1]),
              h: Number(row[2]),
              l: Number(row[3]),
              c: Number(row[4]),
            });
          } else if (msg.arg?.channel === spotChan) {
            this.callbacks.onSpotVolume(Number(row[0]), Number(row[5] || 0));
          }
        } catch {
          // ignore malformed frames
        }
      };

      ws.onerror = () => {
        this.bizConnected = false;
        this.emitCombinedStatus();
      };

      ws.onclose = () => {
        this.bizConnected = false;
        this.emitCombinedStatus();
        if (!this.stopped) {
          const delay = Math.min(15_000, 1000 * Math.pow(2, this.retryAttempt));
          this.retryTimerBiz = setTimeout(() => this.connectBusiness(), delay);
        }
      };
    } catch {
      this.bizConnected = false;
      this.emitCombinedStatus();
    }
  }
}
