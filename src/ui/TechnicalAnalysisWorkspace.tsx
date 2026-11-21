import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import {
  Activity,
  Anchor,
  ArrowUpRight,
  Compass,
  Crosshair,
  Layers,
  Loader2,
  Minus,
  Ruler,
  Target,
  Trash2,
  X,
} from 'lucide-react';
import { calculateVWAP } from '../calc/indicators';
import { analyzeMarketLiquidity } from '../calc/liquidity';
import { aggregateStrikes, calculateLevels } from '../calc/options';
import {
  calculateAnchoredVWAPFromTs,
  calculateFibonacciLevels,
  calculateVolumeDeltaSeries,
  calculateVolumeProfileBuckets,
  computeTechnicalSnapshot,
  detectConfluenceZones,
  detectFairValueGaps,
  detectOscillatorDivergences,
  detectSupportResistanceZones,
  evaluateMultiTimeframeMatrix,
  type FibAnchorMode,
  type FibDirectionMode,
  type FibManualAnchor,
} from '../calc/technicalAnalysis';
import { TIMEFRAME_MS, fetchIndexCandles } from '../data/okxMarketClient';
import {
  fetchLiveTakerTrades,
  fetchMultiTimeframeCandles,
  fetchOrderbookDepthCurve,
  fetchPerpDerivativesTelemetry,
  fetchTechnicalMarketCandles,
  type OrderbookCurveSnapshot,
  type PerpDerivativesTelemetry,
  type TakerTapeSummary,
  type TechnicalMarketMode,
} from '../data/okxTechnicalClient';
import { useTerminalStore } from '../store/terminalStore';
import type { Candle, SymbolAsset, Timeframe } from '../types/market';
import {
  TechnicalZonesPrimitive,
  type RrPlannerOverlay,
  type RulerOverlayState,
  type TechnicalSessionSpan,
} from './primitives/TechnicalZonesPrimitive';
import type { CorrelationWindowDays } from '../calc/newsSentiment';
import { MacroVolCorrelationSubpanel } from './components/MacroVolCorrelationSubpanel';
import { VolumeProfilePrimitive } from './primitives/VolumeProfilePrimitive';

const QUICK_TFS: { value: Timeframe; label: string }[] = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '30m', label: '30m' },
  { value: '1H', label: '1h' },
  { value: '4H', label: '4h' },
  { value: 'D', label: '1d' },
];

type OscillatorMode = 'rsi' | 'macd' | 'atr_bbw' | 'oi_funding';
type VpvrScope = 'visible' | 'session' | 'fixed200';
type DepthRangePct = 0.5 | 1 | 2 | 5;
type WhaleMinUsd = 0 | 10000 | 50000 | 100000;
type ChartToolMode = 'crosshair' | 'ruler' | 'horizontal' | 'avwap' | 'fib_manual';

const PREFS_STORAGE_KEY = 'wterm_tech_prefs_v1';

type TechPrefs = {
  marketMode: TechnicalMarketMode;
  showEmas: boolean;
  showBollinger: boolean;
  showVwap: boolean;
  showAvwap: boolean;
  showVpvr: boolean;
  vpvrScope: VpvrScope;
  showSR: boolean;
  showLiquidity: boolean;
  showFib: boolean;
  fibLookback: 60 | 120 | 240;
  fibMode: FibDirectionMode;
  fibAnchorMode: FibAnchorMode;
  showFvg: boolean;
  showSessions: boolean;
  showConfluence: boolean;
  showMacroCorr30d: boolean;
  corrWindowDays: CorrelationWindowDays;
  cleanAxis: boolean;
  oscMode: OscillatorMode;
  depthRangePct: DepthRangePct;
  whaleMinUsd: WhaleMinUsd;
  rightTab: 'levels' | 'fib' | 'depth';
};

const DEFAULT_PREFS: TechPrefs = {
  marketMode: 'perp',
  showEmas: true,
  showBollinger: false,
  showVwap: true,
  showAvwap: false,
  showVpvr: true,
  vpvrScope: 'visible',
  showSR: true,
  showLiquidity: true,
  showFib: true,
  fibLookback: 120,
  fibMode: 'auto',
  fibAnchorMode: 'pivots',
  showFvg: true,
  showSessions: false,
  showConfluence: true,
  showMacroCorr30d: true,
  corrWindowDays: 30,
  cleanAxis: true,
  oscMode: 'rsi',
  depthRangePct: 2,
  whaleMinUsd: 0,
  rightTab: 'levels',
};

function loadTechPrefs(): TechPrefs {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<TechPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

function formatPrice(val: number, asset: SymbolAsset): string {
  return `$${val.toLocaleString('en-US', {
    minimumFractionDigits: asset === 'BTC' ? 1 : 2,
    maximumFractionDigits: asset === 'BTC' ? 1 : 2,
  })}`;
}

function formatUsdCompact(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1_000_000_000) return `$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

function computeSessionSpans(candles: Candle[], timeframe: Timeframe): TechnicalSessionSpan[] {
  if (candles.length < 10 || timeframe === 'D' || timeframe === '4H') return [];
  const spans: TechnicalSessionSpan[] = [];

  const classify = (utcHour: number): 'ASIA' | 'LON' | 'NY' | null => {
    if (utcHour >= 0 && utcHour < 8) return 'ASIA';
    if (utcHour >= 8 && utcHour < 13) return 'LON';
    if (utcHour >= 13 && utcHour < 21) return 'NY';
    return null;
  };

  let cur: TechnicalSessionSpan | null = null;
  for (const c of candles.slice(-260)) {
    const h = new Date(c.t).getUTCHours();
    const s = classify(h);
    if (!s) {
      if (cur) {
        spans.push(cur);
        cur = null;
      }
      continue;
    }
    if (cur && cur.session === s && c.t - cur.endTs <= 4 * 3600_000) {
      cur.endTs = c.t;
    } else {
      if (cur) spans.push(cur);
      cur = { startTs: c.t, endTs: c.t, session: s };
    }
  }
  if (cur) spans.push(cur);
  return spans.slice(-12);
}

function InteractiveDepthChart({
  curve,
  asset,
  rangePct,
  onChangeRangePct,
}: {
  curve: OrderbookCurveSnapshot | null;
  asset: SymbolAsset;
  rangePct: DepthRangePct;
  onChangeRangePct: (r: DepthRangePct) => void;
}) {
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    price: number;
    cumUsd: number;
    distPct: number;
    side: 'bid' | 'ask';
  } | null>(null);

  const points = useMemo(() => {
    if (!curve) return null;
    const bids = curve.bids.filter((b) => Math.abs(b.distancePct) <= rangePct);
    const asks = curve.asks.filter((a) => Math.abs(a.distancePct) <= rangePct);
    if (bids.length < 2 && asks.length < 2) return null;

    const maxBidUsd = bids.length > 0 ? bids[0].cumulativeUsd : 0;
    const maxAskUsd = asks.length > 0 ? asks[asks.length - 1].cumulativeUsd : 0;
    const maxUsd = Math.max(1, maxBidUsd, maxAskUsd);
    const minP = curve.midPrice * (1 - rangePct / 100);
    const maxP = curve.midPrice * (1 + rangePct / 100);

    return { bids, asks, maxBidUsd, maxAskUsd, maxUsd, minP, maxP };
  }, [curve, rangePct]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-1 bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]">
          {([0.5, 1, 2, 5] as DepthRangePct[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onChangeRangePct(r)}
              className={`px-1.5 py-0.5 rounded font-mono-tabular text-[10px] transition-colors ${
                rangePct === r
                  ? 'bg-[#1F2937] text-white font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              ±{r}%
            </button>
          ))}
        </div>
        {curve && (
          <span className="font-mono-tabular text-[10px] text-slate-400">
            Spread {curve.spreadPct.toFixed(3)}%
          </span>
        )}
      </div>

      {!curve || !points ? (
        <div className="h-32 flex items-center justify-center text-xs text-slate-500 bg-[#0B0E14] rounded border border-white/[0.06]">
          Cargando profundidad {curve ? 'en rango...' : 'del libro OKX...'}
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between text-[11px] font-mono-tabular text-slate-400">
            <span>
              Bids:{' '}
              <strong className="text-emerald-300">{formatUsdCompact(points.maxBidUsd)}</strong>
            </span>
            <span>
              {hoverInfo ? (
                <span className={hoverInfo.side === 'bid' ? 'text-emerald-300' : 'text-rose-300'}>
                  {formatPrice(hoverInfo.price, asset)} ({hoverInfo.distPct >= 0 ? '+' : ''}
                  {hoverInfo.distPct.toFixed(2)}%) · {formatUsdCompact(hoverInfo.cumUsd)}
                </span>
              ) : (
                <span>Mid {formatPrice(curve.midPrice, asset)}</span>
              )}
            </span>
            <span>
              Asks:{' '}
              <strong className="text-rose-300">{formatUsdCompact(points.maxAskUsd)}</strong>
            </span>
          </div>

          {(() => {
            const W = 360;
            const H = 128;
            const padX = 8;
            const padTop = 12;
            const padBot = 18;
            const innerW = W - padX * 2;
            const innerH = H - padTop - padBot;

            const toX = (p: number) =>
              padX +
              Math.min(1, Math.max(0, (p - points.minP) / (points.maxP - points.minP))) * innerW;
            const toY = (usd: number) =>
              padTop + innerH - Math.min(1, Math.max(0, usd / points.maxUsd)) * innerH;

            const bidPath =
              points.bids.length > 0
                ? [
                    `M ${toX(points.bids[0].price)} ${padTop + innerH}`,
                    ...points.bids.map((b) => `L ${toX(b.price)} ${toY(b.cumulativeUsd)}`),
                    `L ${toX(points.bids[points.bids.length - 1].price)} ${padTop + innerH}`,
                    'Z',
                  ].join(' ')
                : '';

            const askPath =
              points.asks.length > 0
                ? [
                    `M ${toX(points.asks[0].price)} ${padTop + innerH}`,
                    ...points.asks.map((a) => `L ${toX(a.price)} ${toY(a.cumulativeUsd)}`),
                    `L ${toX(points.asks[points.asks.length - 1].price)} ${padTop + innerH}`,
                    'Z',
                  ].join(' ')
                : '';

            const midX = toX(curve.midPrice);

            const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = ((e.clientX - rect.left) / rect.width) * W;
              const price =
                points.minP +
                Math.min(1, Math.max(0, (relX - padX) / innerW)) * (points.maxP - points.minP);

              if (price <= curve.midPrice && points.bids.length > 0) {
                let closest = points.bids[0];
                for (const b of points.bids) {
                  if (Math.abs(b.price - price) < Math.abs(closest.price - price)) closest = b;
                }
                setHoverInfo({
                  x: toX(closest.price),
                  price: closest.price,
                  cumUsd: closest.cumulativeUsd,
                  distPct: closest.distancePct,
                  side: 'bid',
                });
              } else if (points.asks.length > 0) {
                let closest = points.asks[0];
                for (const a of points.asks) {
                  if (Math.abs(a.price - price) < Math.abs(closest.price - price)) closest = a;
                }
                setHoverInfo({
                  x: toX(closest.price),
                  price: closest.price,
                  cumUsd: closest.cumulativeUsd,
                  distPct: closest.distancePct,
                  side: 'ask',
                });
              }
            };

            return (
              <svg
                viewBox={`0 0 ${W} ${H}`}
                onMouseMove={handleMouseMove}
                onMouseLeave={() => setHoverInfo(null)}
                className="w-full h-32 bg-[#0B0E14] rounded border border-white/[0.06] cursor-crosshair select-none"
              >
                <line
                  x1={midX}
                  y1={padTop}
                  x2={midX}
                  y2={padTop + innerH}
                  stroke="rgba(255,255,255,0.22)"
                  strokeDasharray="3 3"
                />
                {bidPath && (
                  <path
                    d={bidPath}
                    fill="rgba(16, 185, 129, 0.22)"
                    stroke="#10B981"
                    strokeWidth="1.5"
                  />
                )}
                {askPath && (
                  <path
                    d={askPath}
                    fill="rgba(244, 63, 94, 0.22)"
                    stroke="#F43F5E"
                    strokeWidth="1.5"
                  />
                )}
                {hoverInfo && (
                  <line
                    x1={hoverInfo.x}
                    y1={padTop}
                    x2={hoverInfo.x}
                    y2={padTop + innerH}
                    stroke="#E2E8F0"
                    strokeWidth="1"
                    strokeDasharray="2 2"
                  />
                )}
                <text
                  x={padX + 2}
                  y={H - 4}
                  fill="#64748B"
                  fontSize="9"
                  fontFamily="JetBrains Mono, monospace"
                >
                  -{rangePct}%
                </text>
                <text
                  x={midX}
                  y={H - 4}
                  textAnchor="middle"
                  fill="#94A3B8"
                  fontSize="9"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {curve.marketMode === 'perp' ? 'SWAP' : 'Spot'}
                </text>
                <text
                  x={W - padX - 2}
                  y={H - 4}
                  textAnchor="end"
                  fill="#64748B"
                  fontSize="9"
                  fontFamily="JetBrains Mono, monospace"
                >
                  +{rangePct}%
                </text>
              </svg>
            );
          })()}
        </>
      )}
    </div>
  );
}

export function TechnicalAnalysisWorkspace() {
  const {
    asset,
    setAsset,
    timeframe,
    setTimeframe,
    candles: storeCandles,
    candlesLoading: storeCandlesLoading,
    candlesDatasetKey: storeDatasetKey,
    prependCandles,
    ticker,
    options,
    orderbook: storeOrderbook,
    prevDayHigh,
    prevDayLow,
    userLevels,
    addUserLevel,
    removeUserLevel,
    setActiveTab,
  } = useTerminalStore();

  const [prefs, setPrefs] = useState<TechPrefs>(loadTechPrefs);
  const updatePref = <K extends keyof TechPrefs>(key: K, val: TechPrefs[K]) => {
    setPrefs((prev) => {
      const next = { ...prev, [key]: val };
      try {
        localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore quota errors
      }
      return next;
    });
  };

  // Interactive Chart Tool State
  const [toolMode, setToolMode] = useState<ChartToolMode>('crosshair');
  const toolModeRef = useRef<ChartToolMode>('crosshair');
  toolModeRef.current = toolMode;

  const [avwapAnchorTs, setAvwapAnchorTs] = useState<number | null>(null);
  const [fibManualA, setFibManualA] = useState<FibManualAnchor | null>(null);
  const [fibManualB, setFibManualB] = useState<FibManualAnchor | null>(null);
  const [rulerPoints, setRulerPoints] = useState<{
    a: { ts: number; price: number } | null;
    b: { ts: number; price: number } | null;
  }>({ a: null, b: null });
  const [rrEnabled, setRrEnabled] = useState(false);
  const [rrDirOverride, setRrDirOverride] = useState<'AUTO' | 'LONG' | 'SHORT'>('AUTO');

  // Visible Logical Range for Dynamic VPVR
  const [visibleLogicalRange, setVisibleLogicalRange] = useState<{ from: number; to: number } | null>(
    null
  );

  // Perp Candles & Microstructure State
  const [perpCandles, setPerpCandles] = useState<Candle[]>([]);
  const [perpCandlesLoading, setPerpCandlesLoading] = useState(false);
  const [perpDatasetKey, setPerpDatasetKey] = useState('');
  const [takerTape, setTakerTape] = useState<TakerTapeSummary | null>(null);
  const [depthCurve, setDepthCurve] = useState<OrderbookCurveSnapshot | null>(null);
  const [perpTelemetry, setPerpTelemetry] = useState<PerpDerivativesTelemetry | null>(null);
  const [mtfCandles, setMtfCandles] = useState<
    Partial<Record<'15m' | '1H' | '4H' | 'D', Candle[]>>
  >({});
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Reset asset-bound manual anchors when switching asset
  useEffect(() => {
    setAvwapAnchorTs(null);
    setFibManualA(null);
    setFibManualB(null);
    setRulerPoints({ a: null, b: null });
    setPerpCandles([]);
  }, [asset]);

  // Load Perp candles when marketMode === 'perp'
  useEffect(() => {
    if (prefs.marketMode !== 'perp') return;
    let cancelled = false;
    const ctrl = new AbortController();

    async function loadPerp() {
      setPerpCandlesLoading(true);
      try {
        const list = await fetchTechnicalMarketCandles(asset, timeframe, 'perp', 300, undefined, ctrl.signal);
        if (!cancelled && list.length > 0) {
          setPerpCandles(list);
          setPerpDatasetKey(`perp|${asset}|${timeframe}`);
        }
      } catch {
        // Fallback to store candles cleanly if transient
      } finally {
        if (!cancelled) setPerpCandlesLoading(false);
      }
    }

    void loadPerp();
    const id = setInterval(() => {
      void loadPerp();
    }, 10_000);

    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, [asset, timeframe, prefs.marketMode]);

  // Poll Live Orderbook Depth + Taker Tape (Spot or SWAP)
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    async function pollMicrostructure() {
      try {
        const [tapeRes, curveRes] = await Promise.all([
          fetchLiveTakerTrades(asset, prefs.marketMode, ctrl.signal),
          fetchOrderbookDepthCurve(asset, prefs.marketMode, ctrl.signal),
        ]);
        if (cancelled) return;
        if (tapeRes) setTakerTape(tapeRes);
        if (curveRes) setDepthCurve(curveRes);
      } catch {
        // Ignore transient network errors
      }
    }

    void pollMicrostructure();
    const id = setInterval(() => {
      void pollMicrostructure();
    }, 5_000);

    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, [asset, prefs.marketMode]);

  // Poll Multi-Timeframe Matrix & Perp Derivatives (OI + Funding)
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    async function pollContext() {
      try {
        const [mtfRes, derivRes] = await Promise.all([
          fetchMultiTimeframeCandles(asset, prefs.marketMode, ctrl.signal),
          fetchPerpDerivativesTelemetry(asset, timeframe, ctrl.signal),
        ]);
        if (cancelled) return;
        setMtfCandles(mtfRes);
        setPerpTelemetry(derivRes);
      } catch {
        // Ignore transient network errors
      }
    }

    void pollContext();
    const id = setInterval(() => {
      void pollContext();
    }, 25_000);

    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, [asset, timeframe, prefs.marketMode]);

  const candles = useMemo(
    () => (prefs.marketMode === 'perp' && perpCandles.length > 0 ? perpCandles : storeCandles),
    [prefs.marketMode, perpCandles, storeCandles]
  );
  const candlesDatasetKey =
    prefs.marketMode === 'perp' && perpCandles.length > 0 ? perpDatasetKey : storeDatasetKey;
  const candlesLoading = prefs.marketMode === 'perp' ? perpCandlesLoading : storeCandlesLoading;
  const activeOrderbook = depthCurve?.orderbookDepth ?? storeOrderbook;

  const spot =
    prefs.marketMode === 'perp' && depthCurve?.midPrice
      ? depthCurve.midPrice
      : ticker?.idxPx ?? candles[candles.length - 1]?.c ?? 0;

  // Derived Technical Analytics
  const allStrikes = useMemo(() => aggregateStrikes(options, spot, 'ALL'), [options, spot]);
  const optionsLevels = useMemo(
    () => calculateLevels(allStrikes, options, spot),
    [allStrikes, options, spot]
  );

  const liquidity = useMemo(
    () =>
      analyzeMarketLiquidity(
        candles,
        spot,
        optionsLevels,
        activeOrderbook,
        prevDayHigh,
        prevDayLow
      ),
    [candles, spot, optionsLevels, activeOrderbook, prevDayHigh, prevDayLow]
  );

  // Scoped VPVR (Visible Range / UTC Session / Fixed 200)
  const vpvrSliceCandles = useMemo(() => {
    if (candles.length < 10) return candles;
    if (prefs.vpvrScope === 'session') {
      const now = candles[candles.length - 1].t;
      const d = new Date(now);
      const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const sessionBars = candles.filter((c) => c.t >= dayStart);
      return sessionBars.length >= 10 ? sessionBars : candles.slice(-96);
    }
    if (prefs.vpvrScope === 'visible' && visibleLogicalRange) {
      const start = Math.max(0, Math.floor(visibleLogicalRange.from));
      const end = Math.min(candles.length - 1, Math.ceil(visibleLogicalRange.to));
      if (end - start >= 12) {
        return candles.slice(start, end + 1);
      }
    }
    return candles.slice(-200);
  }, [candles, prefs.vpvrScope, visibleLogicalRange]);

  const volumeProfile = useMemo(
    () => calculateVolumeProfileBuckets(vpvrSliceCandles, 38),
    [vpvrSliceCandles]
  );

  const volumeDeltaSeries = useMemo(() => calculateVolumeDeltaSeries(candles), [candles]);
  const vwapSeries = useMemo(() => calculateVWAP(candles), [candles]);
  const avwapSeries = useMemo(
    () => calculateAnchoredVWAPFromTs(candles, prefs.showAvwap ? avwapAnchorTs : null),
    [candles, prefs.showAvwap, avwapAnchorTs]
  );
  const srZones = useMemo(() => detectSupportResistanceZones(candles, spot), [candles, spot]);
  const fvgs = useMemo(() => detectFairValueGaps(candles, spot, 6), [candles, spot]);
  const fibAnalysis = useMemo(
    () =>
      calculateFibonacciLevels(candles, prefs.fibLookback, prefs.fibMode, spot, {
        anchorMode: prefs.fibAnchorMode,
        manualA: fibManualA,
        manualB: fibManualB,
      }),
    [candles, prefs.fibLookback, prefs.fibMode, spot, prefs.fibAnchorMode, fibManualA, fibManualB]
  );

  const techSnapshot = useMemo(
    () => computeTechnicalSnapshot(candles, volumeProfile?.poc ?? null, liquidity.imbalancePct),
    [candles, volumeProfile?.poc, liquidity.imbalancePct]
  );

  const divergences = useMemo(
    () =>
      detectOscillatorDivergences(
        candles,
        techSnapshot.rsi14,
        techSnapshot.macd.hist,
        volumeDeltaSeries
      ),
    [candles, techSnapshot.rsi14, techSnapshot.macd.hist, volumeDeltaSeries]
  );

  const confluenceZones = useMemo(
    () =>
      detectConfluenceZones({
        spot,
        srZones,
        fibAnalysis,
        volumeProfile,
        liquidityLevels: liquidity.levels,
        prevDayHigh,
        prevDayLow,
      }),
    [spot, srZones, fibAnalysis, volumeProfile, liquidity.levels, prevDayHigh, prevDayLow]
  );

  const mtfMatrix = useMemo(() => evaluateMultiTimeframeMatrix(mtfCandles), [mtfCandles]);
  const sessionSpans = useMemo(() => computeSessionSpans(candles, timeframe), [candles, timeframe]);

  // R/R Simulator Projection based on current bias + ATR(14)
  const rrPlannerOverlay = useMemo<RrPlannerOverlay | null>(() => {
    if (!rrEnabled || candles.length < 15 || spot <= 0) return null;
    const atr = techSnapshot.atr14[candles.length - 1] ?? spot * 0.012;
    const direction: 'LONG' | 'SHORT' =
      rrDirOverride !== 'AUTO'
        ? rrDirOverride
        : techSnapshot.overallBias === 'Bajista'
        ? 'SHORT'
        : 'LONG';
    const anchorTs = candles[Math.max(0, candles.length - 14)].t;
    const stopDist = atr * 1.35;
    if (direction === 'LONG') {
      return {
        direction,
        entry: spot,
        stopLoss: spot - stopDist,
        tp1: spot + stopDist * 1.5,
        tp2: spot + stopDist * 2.5,
        anchorTs,
      };
    }
    return {
      direction,
      entry: spot,
      stopLoss: spot + stopDist,
      tp1: spot - stopDist * 1.5,
      tp2: spot - stopDist * 2.5,
      anchorTs,
    };
  }, [rrEnabled, rrDirOverride, candles, spot, techSnapshot.atr14, techSnapshot.overallBias]);

  const activeRuler = useMemo<RulerOverlayState | null>(() => {
    if (!rulerPoints.a || !rulerPoints.b) return null;
    const atr = techSnapshot.atr14[candles.length - 1] ?? null;
    const barMs = TIMEFRAME_MS[timeframe] || 900_000;
    const barsBetween = Math.max(
      1,
      Math.round(Math.abs(rulerPoints.b.ts - rulerPoints.a.ts) / barMs)
    );
    return {
      a: rulerPoints.a,
      b: rulerPoints.b,
      atr14: atr,
      barsBetween,
    };
  }, [rulerPoints, techSnapshot.atr14, candles.length, timeframe]);

  // Refs for Chart Interaction & Syncing
  const candlesRef = useRef<Candle[]>(candles);
  candlesRef.current = candles;
  const marketModeRef = useRef<TechnicalMarketMode>(prefs.marketMode);
  marketModeRef.current = prefs.marketMode;
  const assetTfRef = useRef({ asset, timeframe });
  assetTfRef.current = { asset, timeframe };
  const loadingOlderRef = useRef(false);
  const noMoreOlderRef = useRef(false);
  const earliestTsRef = useRef(0);

  useEffect(() => {
    noMoreOlderRef.current = false;
    loadingOlderRef.current = false;
  }, [asset, timeframe, prefs.marketMode]);

  // Chart Refs
  const mainContainerRef = useRef<HTMLDivElement>(null);
  const deltaContainerRef = useRef<HTMLDivElement>(null);
  const oscContainerRef = useRef<HTMLDivElement>(null);

  const mainChartRef = useRef<IChartApi | null>(null);
  const deltaChartRef = useRef<IChartApi | null>(null);
  const oscChartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const candleMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const ema20SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ema200SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpperSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLowerSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const avwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vpPrimitiveRef = useRef<VolumeProfilePrimitive | null>(null);
  const zonesPrimitiveRef = useRef<TechnicalZonesPrimitive | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const deltaHistRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const cvdLineRef = useRef<ISeriesApi<'Line'> | null>(null);

  const oscMainLineRef = useRef<ISeriesApi<'Line'> | null>(null);
  const oscSignalLineRef = useRef<ISeriesApi<'Line'> | null>(null);
  const oscHistRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const oscLinesRef = useRef<IPriceLine[]>([]);

  const isSyncingRef = useRef(false);
  const lastScrolledRef = useRef('');
  const candleIndexMapRef = useRef<Map<number, number>>(new Map());
  const rulerStepRef = useRef<'A' | 'B'>('A');
  const fibStepRef = useRef<'A' | 'B'>('A');

  // Initialize synchronized Lightweight Charts
  useEffect(() => {
    const mainEl = mainContainerRef.current;
    const deltaEl = deltaContainerRef.current;
    const oscEl = oscContainerRef.current;
    if (!mainEl || !deltaEl || !oscEl) return;

    const baseOpts = {
      layout: {
        background: { type: ColorType.Solid, color: '#0B0E14' },
        textColor: '#94A3B8',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.035)' },
        horzLines: { color: 'rgba(255,255,255,0.035)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(148,163,184,0.35)', labelBackgroundColor: '#1E293B' },
        horzLine: { color: 'rgba(148,163,184,0.35)', labelBackgroundColor: '#1E293B' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        minimumWidth: 74,
      },
    };

    const mainChart = createChart(mainEl, {
      ...baseOpts,
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 10,
      },
    });
    const deltaChart = createChart(deltaEl, {
      ...baseOpts,
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        visible: false,
        rightOffset: 10,
      },
    });
    const oscChart = createChart(oscEl, {
      ...baseOpts,
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 10,
      },
    });

    const candleSeries = mainChart.addSeries(CandlestickSeries, {
      upColor: '#10B981',
      downColor: '#F43F5E',
      borderUpColor: '#10B981',
      borderDownColor: '#F43F5E',
      wickUpColor: '#10B981',
      wickDownColor: '#F43F5E',
    });

    const candleMarkers = createSeriesMarkers(candleSeries, []);
    const vpPrimitive = new VolumeProfilePrimitive();
    const zonesPrimitive = new TechnicalZonesPrimitive();
    candleSeries.attachPrimitive(zonesPrimitive);
    candleSeries.attachPrimitive(vpPrimitive);

    const ema20Series = mainChart.addSeries(LineSeries, {
      color: '#2DD4BF',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'EMA 20',
    });
    const ema50Series = mainChart.addSeries(LineSeries, {
      color: '#38BDF8',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'EMA 50',
    });
    const ema200Series = mainChart.addSeries(LineSeries, {
      color: '#F59E0B',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'EMA 200',
    });
    const bbUpper = mainChart.addSeries(LineSeries, {
      color: 'rgba(148, 163, 184, 0.55)',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const bbLower = mainChart.addSeries(LineSeries, {
      color: 'rgba(148, 163, 184, 0.55)',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const vwapSeries = mainChart.addSeries(LineSeries, {
      color: '#C084FC',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'VWAP',
    });
    const avwapSeries = mainChart.addSeries(LineSeries, {
      color: '#F472B6',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'AVWAP',
    });

    // Delta & CVD Subchart
    const deltaHist = deltaChart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
    });
    const cvdLine = deltaChart.addSeries(LineSeries, {
      color: '#38BDF8',
      lineWidth: 2,
      priceScaleId: 'left',
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'CVD',
    });
    deltaChart.priceScale('left').applyOptions({
      visible: false,
    });

    // Oscillator Subchart
    const oscHist = oscChart.addSeries(HistogramSeries, {
      priceLineVisible: false,
    });
    const oscMain = oscChart.addSeries(LineSeries, {
      color: '#A78BFA',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    const oscSig = oscChart.addSeries(LineSeries, {
      color: '#F59E0B',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    // Link time scales bidirectionally + track visible logical range for dynamic VPVR + scroll-back loading
    const syncRange = (source: IChartApi, targets: IChartApi[], isPrimary: boolean) => {
      source.timeScale().subscribeVisibleLogicalRangeChange((range: LogicalRange | null) => {
        if (!range) return;
        if (!isSyncingRef.current) {
          isSyncingRef.current = true;
          for (const t of targets) {
            t.timeScale().setVisibleLogicalRange(range);
          }
          isSyncingRef.current = false;
        }
        if (isPrimary) {
          setVisibleLogicalRange({ from: range.from, to: range.to });

          if (
            range.from < 10 &&
            !loadingOlderRef.current &&
            !noMoreOlderRef.current &&
            earliestTsRef.current > 0
          ) {
            loadingOlderRef.current = true;
            const snapAsset = assetTfRef.current.asset;
            const snapTf = assetTfRef.current.timeframe;
            const snapMode = marketModeRef.current;
            const after = earliestTsRef.current;

            const loaderPromise =
              snapMode === 'perp'
                ? fetchTechnicalMarketCandles(snapAsset, snapTf, 'perp', 200, after)
                : fetchIndexCandles(snapAsset, snapTf, 200, after);

            void loaderPromise
              .then((older) => {
                if (
                  assetTfRef.current.asset !== snapAsset ||
                  assetTfRef.current.timeframe !== snapTf ||
                  marketModeRef.current !== snapMode
                ) {
                  return;
                }
                const filtered = older.filter((c) => c.t < after);
                if (filtered.length === 0) {
                  noMoreOlderRef.current = true;
                  return;
                }
                if (snapMode === 'perp') {
                  setPerpCandles((prev) => {
                    const map = new Map<number, Candle>();
                    for (const c of filtered) map.set(c.t, c);
                    for (const c of prev) map.set(c.t, c);
                    return Array.from(map.values()).sort((a, b) => a.t - b.t);
                  });
                } else {
                  prependCandles(filtered);
                }
              })
              .catch(() => {
                // ignore transient backfill errors
              })
              .finally(() => {
                loadingOlderRef.current = false;
              });
          }
        }
      });
    };

    syncRange(mainChart, [deltaChart, oscChart], true);
    syncRange(deltaChart, [mainChart, oscChart], false);
    syncRange(oscChart, [mainChart, deltaChart], false);

    mainChart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHoveredIdx(null);
        return;
      }
      const idx = candleIndexMapRef.current.get(Number(param.time));
      setHoveredIdx(idx ?? null);
    });

    // Interactive Click Handling (Horizontal level, Anchored VWAP, Ruler, Manual Fib)
    mainChart.subscribeClick((param) => {
      const mode = toolModeRef.current;
      if (mode === 'crosshair' || !param.point) return;

      const clickedPrice = candleSeries.coordinateToPrice(param.point.y);
      if (clickedPrice === null || !Number.isFinite(clickedPrice) || clickedPrice <= 0) return;

      const list = candlesRef.current;
      const clickSec = param.time ? Number(param.time) : null;
      const matchedIdx =
        clickSec !== null ? candleIndexMapRef.current.get(clickSec) : undefined;
      const clickedTs =
        matchedIdx !== undefined && list[matchedIdx]
          ? list[matchedIdx].t
          : list[list.length - 1]?.t ?? Date.now();

      if (mode === 'horizontal') {
        addUserLevel(Number(clickedPrice.toFixed(assetTfRef.current.asset === 'BTC' ? 1 : 2)));
        setToolMode('crosshair');
      } else if (mode === 'avwap') {
        setAvwapAnchorTs(clickedTs);
        updatePref('showAvwap', true);
        setToolMode('crosshair');
      } else if (mode === 'ruler') {
        if (rulerStepRef.current === 'A') {
          setRulerPoints({ a: { ts: clickedTs, price: clickedPrice }, b: null });
          rulerStepRef.current = 'B';
        } else {
          setRulerPoints((prev) => ({
            a: prev.a,
            b: { ts: clickedTs, price: clickedPrice },
          }));
          rulerStepRef.current = 'A';
          setToolMode('crosshair');
        }
      } else if (mode === 'fib_manual') {
        if (fibStepRef.current === 'A') {
          setFibManualA({ ts: clickedTs, price: clickedPrice });
          setFibManualB(null);
          fibStepRef.current = 'B';
        } else {
          setFibManualB({ ts: clickedTs, price: clickedPrice });
          fibStepRef.current = 'A';
          updatePref('fibAnchorMode', 'manual');
          updatePref('showFib', true);
          setToolMode('crosshair');
        }
      }
    });

    mainChartRef.current = mainChart;
    deltaChartRef.current = deltaChart;
    oscChartRef.current = oscChart;

    candleSeriesRef.current = candleSeries;
    candleMarkersRef.current = candleMarkers;
    vpPrimitiveRef.current = vpPrimitive;
    zonesPrimitiveRef.current = zonesPrimitive;
    ema20SeriesRef.current = ema20Series;
    ema50SeriesRef.current = ema50Series;
    ema200SeriesRef.current = ema200Series;
    bbUpperSeriesRef.current = bbUpper;
    bbLowerSeriesRef.current = bbLower;
    vwapSeriesRef.current = vwapSeries;
    avwapSeriesRef.current = avwapSeries;

    deltaHistRef.current = deltaHist;
    cvdLineRef.current = cvdLine;

    oscHistRef.current = oscHist;
    oscMainLineRef.current = oscMain;
    oscSignalLineRef.current = oscSig;

    const ro = new ResizeObserver(() => {
      mainChart.applyOptions({ width: mainEl.clientWidth, height: mainEl.clientHeight });
      deltaChart.applyOptions({ width: deltaEl.clientWidth, height: deltaEl.clientHeight });
      oscChart.applyOptions({ width: oscEl.clientWidth, height: oscEl.clientHeight });
    });
    ro.observe(mainEl);
    ro.observe(deltaEl);
    ro.observe(oscEl);

    return () => {
      ro.disconnect();
      mainChart.remove();
      deltaChart.remove();
      oscChart.remove();
      mainChartRef.current = null;
      deltaChartRef.current = null;
      oscChartRef.current = null;
    };
  }, []);

  // Push Candles + Overlays + Primitives + Subcharts
  useEffect(() => {
    const cs = candleSeriesRef.current;
    const e20s = ema20SeriesRef.current;
    const e50s = ema50SeriesRef.current;
    const e200s = ema200SeriesRef.current;
    const bbu = bbUpperSeriesRef.current;
    const bbl = bbLowerSeriesRef.current;
    const vwaps = vwapSeriesRef.current;
    const avwaps = avwapSeriesRef.current;
    const dh = deltaHistRef.current;
    const cvd = cvdLineRef.current;
    const om = oscMainLineRef.current;
    const os = oscSignalLineRef.current;
    const oh = oscHistRef.current;

    if (
      !cs ||
      !e20s ||
      !e50s ||
      !e200s ||
      !bbu ||
      !bbl ||
      !vwaps ||
      !avwaps ||
      !dh ||
      !cvd ||
      !om ||
      !os ||
      !oh
    ) {
      return;
    }

    earliestTsRef.current = candles[0]?.t ?? 0;

    const idxMap = new Map<number, number>();
    candles.forEach((c, idx) => idxMap.set(Math.floor(c.t / 1000), idx));
    candleIndexMapRef.current = idxMap;

    cs.setData(
      candles.map((c) => ({
        time: Math.floor(c.t / 1000) as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      }))
    );

    // Divergence Markers on Candlestick Series
    if (candleMarkersRef.current) {
      const candleTsSet = new Set(candles.map((c) => Math.floor(c.t / 1000)));
      const markers: SeriesMarker<Time>[] = divergences
        .filter((d) => candleTsSet.has(Math.floor(d.ts / 1000)))
        .sort((a, b) => a.ts - b.ts)
        .map((d) => {
          const isBull = d.kind.startsWith('bullish');
          return {
            time: Math.floor(d.ts / 1000) as UTCTimestamp,
            position: isBull ? 'belowBar' : 'aboveBar',
            color: isBull ? '#34D399' : '#FB7185',
            shape: isBull ? 'arrowUp' : 'arrowDown',
            text: d.label,
          };
        });
      candleMarkersRef.current.setMarkers(markers);
    }

    e20s.applyOptions({ visible: prefs.showEmas });
    e50s.applyOptions({ visible: prefs.showEmas });
    e200s.applyOptions({ visible: prefs.showEmas });
    e20s.setData(
      candles
        .map((c, idx) =>
          techSnapshot.ema20[idx] !== null
            ? { time: Math.floor(c.t / 1000) as UTCTimestamp, value: techSnapshot.ema20[idx]! }
            : null
        )
        .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
    );
    e50s.setData(
      candles
        .map((c, idx) =>
          techSnapshot.ema50[idx] !== null
            ? { time: Math.floor(c.t / 1000) as UTCTimestamp, value: techSnapshot.ema50[idx]! }
            : null
        )
        .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
    );
    e200s.setData(
      candles
        .map((c, idx) =>
          techSnapshot.ema200[idx] !== null
            ? { time: Math.floor(c.t / 1000) as UTCTimestamp, value: techSnapshot.ema200[idx]! }
            : null
        )
        .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
    );

    bbu.applyOptions({ visible: prefs.showBollinger });
    bbl.applyOptions({ visible: prefs.showBollinger });
    bbu.setData(
      candles
        .map((c, idx) =>
          techSnapshot.bollinger.upper[idx] !== null
            ? {
                time: Math.floor(c.t / 1000) as UTCTimestamp,
                value: techSnapshot.bollinger.upper[idx]!,
              }
            : null
        )
        .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
    );
    bbl.setData(
      candles
        .map((c, idx) =>
          techSnapshot.bollinger.lower[idx] !== null
            ? {
                time: Math.floor(c.t / 1000) as UTCTimestamp,
                value: techSnapshot.bollinger.lower[idx]!,
              }
            : null
        )
        .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
    );

    vwaps.applyOptions({ visible: prefs.showVwap });
    vwaps.setData(
      candles
        .map((c, idx) =>
          vwapSeries[idx] !== null
            ? { time: Math.floor(c.t / 1000) as UTCTimestamp, value: vwapSeries[idx]! }
            : null
        )
        .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
    );

    avwaps.applyOptions({ visible: prefs.showAvwap && avwapAnchorTs !== null });
    avwaps.setData(
      candles
        .map((c, idx) =>
          avwapSeries[idx] !== null
            ? { time: Math.floor(c.t / 1000) as UTCTimestamp, value: avwapSeries[idx]! }
            : null
        )
        .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
    );

    vpPrimitiveRef.current?.setData(volumeProfile, prefs.showVpvr);
    zonesPrimitiveRef.current?.setData({
      showFibGolden: prefs.showFib,
      fib: fibAnalysis,
      showFvg: prefs.showFvg,
      fvgs,
      showConfluence: prefs.showConfluence,
      confluences: confluenceZones,
      showSessions: prefs.showSessions,
      sessions: sessionSpans,
      ruler: activeRuler,
      rrPlanner: rrPlannerOverlay,
    });

    // Delta & CVD
    dh.setData(
      volumeDeltaSeries.map((pt) => ({
        time: Math.floor(pt.t / 1000) as UTCTimestamp,
        value: pt.delta,
        color: pt.delta >= 0 ? 'rgba(16, 185, 129, 0.72)' : 'rgba(244, 63, 94, 0.72)',
      }))
    );
    cvd.setData(
      volumeDeltaSeries.map((pt) => ({
        time: Math.floor(pt.t / 1000) as UTCTimestamp,
        value: pt.cvd,
      }))
    );

    // Clear old oscillator price lines
    for (const ln of oscLinesRef.current) {
      om.removePriceLine(ln);
    }
    oscLinesRef.current = [];

    if (prefs.oscMode === 'rsi') {
      oh.setData([]);
      os.setData([]);
      om.applyOptions({ color: '#A78BFA', title: 'RSI 14' });
      om.setData(
        candles
          .map((c, idx) =>
            techSnapshot.rsi14[idx] !== null
              ? { time: Math.floor(c.t / 1000) as UTCTimestamp, value: techSnapshot.rsi14[idx]! }
              : null
          )
          .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
      );
      oscLinesRef.current.push(
        om.createPriceLine({
          price: 70,
          color: 'rgba(244, 63, 94, 0.5)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'OB 70',
        }),
        om.createPriceLine({
          price: 50,
          color: 'rgba(148, 163, 184, 0.35)',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: false,
          title: '50',
        }),
        om.createPriceLine({
          price: 30,
          color: 'rgba(16, 185, 129, 0.5)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'OS 30',
        })
      );
    } else if (prefs.oscMode === 'macd') {
      om.applyOptions({ color: '#38BDF8', title: 'MACD' });
      os.applyOptions({ color: '#F59E0B', title: 'Señal' });
      om.setData(
        candles
          .map((c, idx) =>
            techSnapshot.macd.macd[idx] !== null
              ? {
                  time: Math.floor(c.t / 1000) as UTCTimestamp,
                  value: techSnapshot.macd.macd[idx]!,
                }
              : null
          )
          .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
      );
      os.setData(
        candles
          .map((c, idx) =>
            techSnapshot.macd.signal[idx] !== null
              ? {
                  time: Math.floor(c.t / 1000) as UTCTimestamp,
                  value: techSnapshot.macd.signal[idx]!,
                }
              : null
          )
          .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
      );
      oh.setData(
        candles
          .map((c, idx) => {
            const h = techSnapshot.macd.hist[idx];
            if (h === null) return null;
            return {
              time: Math.floor(c.t / 1000) as UTCTimestamp,
              value: h,
              color: h >= 0 ? 'rgba(16, 185, 129, 0.55)' : 'rgba(244, 63, 94, 0.55)',
            };
          })
          .filter((x): x is { time: UTCTimestamp; value: number; color: string } => x !== null)
      );
      oscLinesRef.current.push(
        om.createPriceLine({
          price: 0,
          color: 'rgba(148, 163, 184, 0.45)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: '0',
        })
      );
    } else if (prefs.oscMode === 'atr_bbw') {
      om.applyOptions({ color: '#FBBF24', title: 'BBW %' });
      os.applyOptions({ color: '#38BDF8', title: 'ATR %' });
      om.setData(
        candles
          .map((c, idx) =>
            techSnapshot.bbWidthPct[idx] !== null
              ? {
                  time: Math.floor(c.t / 1000) as UTCTimestamp,
                  value: techSnapshot.bbWidthPct[idx]!,
                }
              : null
          )
          .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
      );
      os.setData(
        candles
          .map((c, idx) => {
            const a = techSnapshot.atr14[idx];
            if (a === null || c.c <= 0) return null;
            return { time: Math.floor(c.t / 1000) as UTCTimestamp, value: (a / c.c) * 100 };
          })
          .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
      );
      oh.setData([]);
    } else {
      // OI & Funding
      os.setData([]);
      oh.setData([]);
      if (perpTelemetry && perpTelemetry.oiSeries.length > 0) {
        om.applyOptions({ color: '#38BDF8', title: 'OI ($M)' });
        om.setData(
          perpTelemetry.oiSeries.map((pt) => ({
            time: Math.floor(pt.t / 1000) as UTCTimestamp,
            value: pt.oiUsd / 1_000_000,
          }))
        );
      } else {
        om.setData([]);
      }
    }

    // Main Price Lines: clean prioritized axis when cleanAxis = true
    for (const ln of priceLinesRef.current) {
      cs.removePriceLine(ln);
    }
    priceLinesRef.current = [];

    const showDetailedLabels = !prefs.cleanAxis;

    // Shared manual horizontal levels
    for (const lvl of userLevels) {
      priceLinesRef.current.push(
        cs.createPriceLine({
          price: lvl.price,
          color: '#E2E8F0',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: lvl.label ? `★ ${lvl.label}` : '★ Nivel',
        })
      );
    }

    if (prefs.showSR) {
      for (const z of srZones) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: z.price,
            color: z.kind === 'support' ? 'rgba(16, 185, 129, 0.68)' : 'rgba(244, 63, 94, 0.68)',
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: showDetailedLabels || z.touches >= 2,
            title: `${z.kind === 'support' ? 'Sop.' : 'Res.'} (×${z.touches})`,
          })
        );
      }
    }

    if (prefs.showLiquidity) {
      if (liquidity.strongestAskWall) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: liquidity.strongestAskWall.price,
            color: '#FB7185',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `Ask ${formatUsdCompact(liquidity.strongestAskWall.notionalUsd)}`,
          })
        );
      }
      if (liquidity.strongestBidWall) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: liquidity.strongestBidWall.price,
            color: '#34D399',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `Bid ${formatUsdCompact(liquidity.strongestBidWall.notionalUsd)}`,
          })
        );
      }
      if (prevDayHigh) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: prevDayHigh,
            color: 'rgba(251, 146, 60, 0.72)',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: showDetailedLabels,
            title: 'PDH',
          })
        );
      }
      if (prevDayLow) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: prevDayLow,
            color: 'rgba(56, 189, 248, 0.72)',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: showDetailedLabels,
            title: 'PDL',
          })
        );
      }
      if (liquidity.nearestBSL && showDetailedLabels) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: liquidity.nearestBSL.price,
            color: 'rgba(249, 115, 22, 0.7)',
            lineWidth: 1,
            lineStyle: LineStyle.SparseDotted,
            axisLabelVisible: true,
            title: 'BSL',
          })
        );
      }
      if (liquidity.nearestSSL && showDetailedLabels) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: liquidity.nearestSSL.price,
            color: 'rgba(56, 189, 248, 0.7)',
            lineWidth: 1,
            lineStyle: LineStyle.SparseDotted,
            axisLabelVisible: true,
            title: 'SSL',
          })
        );
      }
    }

    if (prefs.showFib && fibAnalysis) {
      for (const fl of fibAnalysis.levels) {
        if (fl.ratio === 0 || fl.ratio === 1 || fl.ratio === 0.236 || fl.ratio === 0.65 || fl.ratio === 1.272) {
          continue;
        }
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: fl.price,
            color: fl.isGolden ? '#FACC15' : 'rgba(250, 204, 21, 0.42)',
            lineWidth: fl.isGolden ? 2 : 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: fl.isGolden || showDetailedLabels,
            title: `Fib ${(fl.ratio * 100).toFixed(1)}%`,
          })
        );
      }
    }

    if (rrPlannerOverlay) {
      priceLinesRef.current.push(
        cs.createPriceLine({
          price: rrPlannerOverlay.stopLoss,
          color: '#F43F5E',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'SL R/R',
        }),
        cs.createPriceLine({
          price: rrPlannerOverlay.tp2,
          color: '#10B981',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'TP2 R/R',
        })
      );
    }

    if (candles.length > 0 && candlesDatasetKey !== lastScrolledRef.current) {
      lastScrolledRef.current = candlesDatasetKey;
      mainChartRef.current?.timeScale().scrollToRealTime();
    }
  }, [
    candles,
    candlesDatasetKey,
    techSnapshot,
    vwapSeries,
    avwapSeries,
    avwapAnchorTs,
    volumeProfile,
    volumeDeltaSeries,
    srZones,
    fvgs,
    confluenceZones,
    sessionSpans,
    divergences,
    liquidity,
    fibAnalysis,
    prevDayHigh,
    prevDayLow,
    userLevels,
    activeRuler,
    rrPlannerOverlay,
    perpTelemetry,
    prefs,
  ]);

  const activeIdx =
    hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < candles.length
      ? hoveredIdx
      : candles.length - 1;
  const activeCandle: Candle | null = activeIdx >= 0 ? candles[activeIdx] : null;
  const activeEma20 = activeIdx >= 0 ? techSnapshot.ema20[activeIdx] : null;
  const activeEma50 = activeIdx >= 0 ? techSnapshot.ema50[activeIdx] : null;
  const activeEma200 = activeIdx >= 0 ? techSnapshot.ema200[activeIdx] : null;
  const activeRsi = activeIdx >= 0 ? techSnapshot.rsi14[activeIdx] : null;
  const activeDelta = activeIdx >= 0 ? volumeDeltaSeries[activeIdx] : null;

  const filteredTakerTrades = useMemo(() => {
    if (!takerTape) return [];
    return takerTape.trades.filter((t) => t.notionalUsd >= prefs.whaleMinUsd);
  }, [takerTape, prefs.whaleMinUsd]);

  const mtfBullCount = mtfMatrix.filter((r) => r.overall === 'Alcista').length;
  const mtfBearCount = mtfMatrix.filter((r) => r.overall === 'Bajista').length;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0B0E14] text-slate-200 overflow-y-auto lg:overflow-hidden">
      {/* Row 1: Asset, Spot/Perp Switch, Timeframes, Perp OI/Funding */}
      <div className="px-3 sm:px-4 py-2 bg-[#111621] border-b border-white/[0.08] flex flex-wrap items-center justify-between gap-2.5 shrink-0">
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Asset */}
          <div className="flex items-center bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]">
            {(['BTC', 'ETH'] as SymbolAsset[]).map((sym) => (
              <button
                key={sym}
                type="button"
                onClick={() => setAsset(sym)}
                className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors ${
                  asset === sym ? 'bg-[#3B82F6] text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {sym}
              </button>
            ))}
          </div>

          {/* Spot vs Perpetuo (SWAP) Mode */}
          <div className="flex items-center bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]">
            <button
              type="button"
              onClick={() => updatePref('marketMode', 'perp')}
              className={`px-2 py-1 text-[11px] font-medium rounded transition-colors ${
                prefs.marketMode === 'perp'
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Perpetuo (SWAP)
            </button>
            <button
              type="button"
              onClick={() => updatePref('marketMode', 'spot')}
              className={`px-2 py-1 text-[11px] font-medium rounded transition-colors ${
                prefs.marketMode === 'spot'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Spot
            </button>
          </div>

          <span className="text-sm font-mono-tabular font-semibold text-white">
            {spot > 0 ? formatPrice(spot, asset) : '—'}
          </span>

          {/* Quick Timeframes */}
          <div className="flex items-center gap-0.5 bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]">
            {QUICK_TFS.map((tf) => (
              <button
                key={tf.value}
                type="button"
                onClick={() => setTimeframe(tf.value)}
                className={`px-2 py-1 text-[11px] font-mono-tabular rounded transition-colors ${
                  timeframe === tf.value
                    ? 'bg-[#1F2937] text-white font-semibold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>

          {candlesLoading && (
            <span className="flex items-center gap-1 text-[11px] text-sky-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Actualizando</span>
            </span>
          )}
        </div>

        {/* Live Derivatives Telemetry + Bridge Shortcuts */}
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono-tabular">
          {perpTelemetry?.oiUsd && (
            <span className="text-slate-300">
              OI SWAP:{' '}
              <strong className="text-sky-300">{formatUsdCompact(perpTelemetry.oiUsd)}</strong>
            </span>
          )}
          {perpTelemetry?.fundingRatePct !== null && perpTelemetry?.fundingRatePct !== undefined && (
            <span className="text-slate-300">
              Funding 8h:{' '}
              <strong
                className={
                  perpTelemetry.fundingRatePct > 0.025
                    ? 'text-amber-300'
                    : perpTelemetry.fundingRatePct < 0
                    ? 'text-emerald-300'
                    : 'text-slate-200'
                }
              >
                {perpTelemetry.fundingRatePct >= 0 ? '+' : ''}
                {perpTelemetry.fundingRatePct.toFixed(4)}%
              </strong>
            </span>
          )}
          <button
            type="button"
            onClick={() => setActiveTab('scoring')}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#0B0E14] border border-sky-500/35 text-sky-300 hover:bg-sky-500/10 transition-colors font-sans"
          >
            <span>Puntuación v1.1</span>
            <ArrowUpRight className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('trading_options')}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#0B0E14] border border-white/[0.1] text-slate-300 hover:text-white transition-colors font-sans"
          >
            <span>Opciones Trading</span>
            <ArrowUpRight className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Row 2: Interactive Drawing Tools + Dynamic Layer Controls */}
      <div className="px-3 sm:px-4 py-1.5 bg-[#0E131C] border-b border-white/[0.07] flex flex-wrap items-center justify-between gap-2 text-[11px] shrink-0">
        {/* Interactive Chart Tools */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-slate-400 mr-1">Herramientas:</span>
          {(
            [
              { id: 'crosshair', label: 'Cursor', icon: Crosshair },
              { id: 'ruler', label: 'Regla ATR/%', icon: Ruler },
              { id: 'horizontal', label: 'Nivel H', icon: Minus },
              { id: 'avwap', label: 'Anclar AVWAP', icon: Anchor },
              { id: 'fib_manual', label: 'Fib A-B', icon: Compass },
            ] as const
          ).map((t) => {
            const Icon = t.icon;
            const active = toolMode === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  if (t.id === 'ruler') rulerStepRef.current = 'A';
                  if (t.id === 'fib_manual') fibStepRef.current = 'A';
                  setToolMode(active ? 'crosshair' : t.id);
                }}
                className={`flex items-center gap-1 px-2 py-0.5 rounded border transition-colors ${
                  active
                    ? 'bg-amber-500/15 border-amber-500/50 text-amber-200'
                    : 'bg-[#0B0E14] border-white/[0.08] text-slate-400 hover:text-white'
                }`}
              >
                <Icon className="w-3 h-3" />
                <span>{t.label}</span>
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => setRrEnabled((v) => !v)}
            className={`flex items-center gap-1 px-2 py-0.5 rounded border transition-colors ${
              rrEnabled
                ? 'bg-emerald-500/15 border-emerald-500/45 text-emerald-300'
                : 'bg-[#0B0E14] border-white/[0.08] text-slate-400 hover:text-white'
            }`}
          >
            <Target className="w-3 h-3" />
            <span>Caja R/R</span>
          </button>

          {rrEnabled && (
            <select
              value={rrDirOverride}
              onChange={(e) => setRrDirOverride(e.target.value as 'AUTO' | 'LONG' | 'SHORT')}
              className="bg-[#0B0E14] border border-white/[0.08] rounded px-1.5 py-0.5 text-[10px] text-slate-200 focus:outline-none"
            >
              <option value="AUTO">R/R Auto</option>
              <option value="LONG">LONG</option>
              <option value="SHORT">SHORT</option>
            </select>
          )}

          {(activeRuler || avwapAnchorTs || (fibManualA && fibManualB)) && (
            <button
              type="button"
              onClick={() => {
                setRulerPoints({ a: null, b: null });
                setAvwapAnchorTs(null);
                updatePref('showAvwap', false);
                setFibManualA(null);
                setFibManualB(null);
                if (prefs.fibAnchorMode === 'manual') updatePref('fibAnchorMode', 'pivots');
              }}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#0B0E14] border border-white/[0.08] text-slate-400 hover:text-rose-300"
              title="Limpiar regla / AVWAP / Fib manual"
            >
              <X className="w-3 h-3" />
              <span>Reset trazos</span>
            </button>
          )}

          {toolMode !== 'crosshair' && (
            <span className="ml-1 text-[10px] text-amber-300 font-medium">
              {toolMode === 'ruler'
                ? rulerStepRef.current === 'A'
                  ? 'Clic en punto A de medición'
                  : 'Clic en punto B de medición'
                : toolMode === 'horizontal'
                ? 'Clic en precio para fijar Nivel H compartido'
                : toolMode === 'avwap'
                ? 'Clic en vela para anclar AVWAP'
                : fibStepRef.current === 'A'
                ? 'Clic en origen A de Fibonacci'
                : 'Clic en extremo B de Fibonacci'}
            </span>
          )}
        </div>

        {/* Layer Toggles */}
        <div className="flex flex-wrap items-center gap-1">
          <span className="flex items-center gap-1 text-slate-400 mr-1">
            <Layers className="w-3 h-3" />
            <span>Capas:</span>
          </span>
          {(
            [
              { key: 'showEmas', label: 'EMA 20/50/200' },
              { key: 'showBollinger', label: 'Bollinger' },
              { key: 'showVwap', label: 'VWAP' },
              { key: 'showVpvr', label: 'VPVR' },
              { key: 'showConfluence', label: 'Confluencias' },
              { key: 'showSR', label: 'S/R' },
              { key: 'showLiquidity', label: 'Liquidez/PDH' },
              { key: 'showFib', label: 'Fib' },
              { key: 'showFvg', label: 'FVG' },
              { key: 'showSessions', label: 'Sesiones' },
              { key: 'showMacroCorr30d', label: `Corr. ${prefs.corrWindowDays}D` },
              { key: 'cleanAxis', label: 'Eje Limpio' },
            ] as const
          ).map((item) => {
            const active = prefs[item.key];
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => updatePref(item.key, !active)}
                className={`px-2 py-0.5 rounded border transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-[#1F2937] border-sky-500/45 text-white'
                    : 'bg-[#0B0E14] border-white/[0.08] text-slate-400 hover:text-slate-200'
                }`}
              >
                {item.label}
              </button>
            );
          })}

          {prefs.showVpvr && (
            <select
              value={prefs.vpvrScope}
              onChange={(e) => updatePref('vpvrScope', e.target.value as VpvrScope)}
              className="bg-[#0B0E14] border border-white/[0.08] rounded px-1.5 py-0.5 text-[10px] text-slate-200 focus:outline-none"
              title="Rango de cálculo del Perfil de Volumen"
            >
              <option value="visible">VPVR Visible</option>
              <option value="session">VPVR Sesión</option>
              <option value="fixed200">VPVR 200v</option>
            </select>
          )}

          {prefs.showFib && (
            <div className="flex items-center gap-1 pl-1.5 border-l border-white/[0.08]">
              <select
                value={prefs.fibAnchorMode}
                onChange={(e) => updatePref('fibAnchorMode', e.target.value as FibAnchorMode)}
                className="bg-[#0B0E14] border border-white/[0.08] rounded px-1.5 py-0.5 text-[10px] text-slate-200 focus:outline-none"
                title="Modo de anclaje Fibonacci"
              >
                <option value="pivots">Fib Pivotes</option>
                <option value="window">Fib Ventana</option>
                <option value="manual">Fib Manual</option>
              </select>
              <select
                value={prefs.fibLookback}
                onChange={(e) => updatePref('fibLookback', Number(e.target.value) as 60 | 120 | 240)}
                className="bg-[#0B0E14] border border-white/[0.08] rounded px-1.5 py-0.5 text-[10px] font-mono-tabular text-slate-200 focus:outline-none"
              >
                <option value={60}>60v</option>
                <option value={120}>120v</option>
                <option value={240}>240v</option>
              </select>
              <select
                value={prefs.fibMode}
                onChange={(e) => updatePref('fibMode', e.target.value as FibDirectionMode)}
                className="bg-[#0B0E14] border border-white/[0.08] rounded px-1.5 py-0.5 text-[10px] text-slate-200 focus:outline-none"
              >
                <option value="auto">Auto</option>
                <option value="bullish">Alcista</option>
                <option value="bearish">Bajista</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Main Split Body */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        {/* Left Interactive Charts Stack */}
        <div className="flex-1 flex flex-col min-w-0 min-h-[720px] lg:min-h-0 lg:overflow-y-auto border-r border-white/[0.08]">
          {/* Crosshair Live OHLCV + Indicator Telemetry Strip */}
          <div className="px-3 py-1.5 bg-[#0E131C] border-b border-white/[0.06] flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] font-mono-tabular shrink-0">
            {activeCandle ? (
              <>
                <span className="text-slate-300">
                  O <strong className="text-white">{formatPrice(activeCandle.o, asset)}</strong> · H{' '}
                  <strong className="text-white">{formatPrice(activeCandle.h, asset)}</strong> · L{' '}
                  <strong className="text-white">{formatPrice(activeCandle.l, asset)}</strong> · C{' '}
                  <strong
                    className={
                      activeCandle.c >= activeCandle.o ? 'text-emerald-300' : 'text-rose-300'
                    }
                  >
                    {formatPrice(activeCandle.c, asset)}
                  </strong>
                </span>
                <span className="text-teal-300">
                  EMA20: {activeEma20 !== null ? formatPrice(activeEma20, asset) : '—'}
                </span>
                <span className="text-sky-300">
                  EMA50: {activeEma50 !== null ? formatPrice(activeEma50, asset) : '—'}
                </span>
                <span className="text-amber-300">
                  EMA200: {activeEma200 !== null ? formatPrice(activeEma200, asset) : '—'}
                </span>
                <span className="text-violet-300">
                  RSI(14): {activeRsi !== null ? activeRsi.toFixed(1) : '—'}
                </span>
                {techSnapshot.isSqueeze && (
                  <span className="text-amber-300 font-semibold">SQUEEZE BB</span>
                )}
                {activeDelta && (
                  <span className={activeDelta.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}>
                    Delta: {activeDelta.delta >= 0 ? '+' : ''}
                    {activeDelta.delta.toFixed(1)} {asset} · CVD:{' '}
                    {activeDelta.cvd >= 0 ? '+' : ''}
                    {activeDelta.cvd.toFixed(0)}
                  </span>
                )}
              </>
            ) : (
              <span className="text-slate-500">Esperando velas en vivo...</span>
            )}
          </div>

          {/* 1. Primary Candlestick + EMAs + Dynamic VPVR + Technical Zones */}
          <div className="relative flex-[3] min-h-[270px]">
            <div ref={mainContainerRef} className="w-full h-full" />
            {volumeProfile && prefs.showVpvr && (
              <div className="pointer-events-none absolute top-2 left-3 bg-[#0B0E14]/85 border border-white/[0.08] rounded px-2.5 py-1 text-[11px] font-mono-tabular text-slate-300 flex flex-wrap gap-2">
                <span className="text-slate-400 font-sans">
                  VPVR ({prefs.vpvrScope === 'visible' ? 'Visible' : prefs.vpvrScope === 'session' ? 'Sesión' : '200v'}):
                </span>
                <span className="text-amber-300">POC {formatPrice(volumeProfile.poc, asset)}</span>
                <span aria-hidden="true">·</span>
                <span>VAH {formatPrice(volumeProfile.vah, asset)}</span>
                <span aria-hidden="true">·</span>
                <span>VAL {formatPrice(volumeProfile.val, asset)}</span>
                {volumeProfile.hvnPrices.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-sky-300">HVN {volumeProfile.hvnPrices.length}</span>
                  </>
                )}
              </div>
            )}
          </div>

          {/* 2. Synchronized Sub-Chart: Volume Delta & CVD */}
          <div className="border-t border-white/[0.08] flex-[1.05] min-h-[110px] flex flex-col">
            <div className="px-3 py-1 bg-[#0E131C] border-b border-white/[0.05] flex items-center justify-between text-[11px] shrink-0">
              <span className="font-medium text-slate-200">
                Delta de Volumen ({prefs.marketMode === 'perp' ? 'SWAP' : 'Spot'}) &amp; CVD acumulado
              </span>
              <span className="font-mono-tabular text-slate-400">
                Línea azul: CVD · Barras: Presión compradora/vendedora
              </span>
            </div>
            <div ref={deltaContainerRef} className="flex-1 min-h-0" />
          </div>

          {/* 3. Synchronized Sub-Chart: RSI / MACD / ATR+Squeeze / OI+Funding */}
          <div className="border-t border-white/[0.08] flex-[1.05] min-h-[115px] flex flex-col">
            <div className="px-3 py-1 bg-[#0E131C] border-b border-white/[0.05] flex flex-wrap items-center justify-between gap-2 text-[11px] shrink-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-200">Sub-gráfico</span>
                <div className="flex bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]">
                  {(
                    [
                      { id: 'rsi', label: 'RSI (14)' },
                      { id: 'macd', label: 'MACD' },
                      { id: 'atr_bbw', label: 'ATR & Squeeze' },
                      { id: 'oi_funding', label: 'OI SWAP' },
                    ] as const
                  ).map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => updatePref('oscMode', mode.id)}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                        prefs.oscMode === mode.id
                          ? 'bg-[#1F2937] text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
              </div>
              <span className="font-mono-tabular text-slate-400">
                {divergences.length > 0
                  ? `${divergences.length} divergencia(s) detectada(s)`
                  : 'Sincronizado con eje temporal'}
              </span>
            </div>
            <div ref={oscContainerRef} className="flex-1 min-h-0" />
          </div>

          {/* 4. Dedicated Sub-Panel: Rolling Macro/Sentiment Intensity vs BTC/ETH Volatility */}
          {prefs.showMacroCorr30d && (
            <MacroVolCorrelationSubpanel
              windowDays={prefs.corrWindowDays}
              onChangeWindowDays={(w) => updatePref('corrWindowDays', w)}
            />
          )}
        </div>

        {/* Right Telemetry Column */}
        <aside className="w-full lg:w-[400px] xl:w-[430px] shrink-0 bg-[#12161E] flex flex-col min-h-0 overflow-y-auto">
          {/* Technical Multi-Factor Summary + Active Divergences */}
          <div className="p-3.5 border-b border-white/[0.08] space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-white">
                <Activity className="w-4 h-4 text-sky-400" />
                <span>Resumen Técnico Multi-Factor</span>
              </div>
              <span
                className={`text-xs font-semibold font-mono-tabular ${
                  techSnapshot.overallBias === 'Alcista'
                    ? 'text-emerald-300'
                    : techSnapshot.overallBias === 'Bajista'
                    ? 'text-rose-300'
                    : 'text-amber-300'
                }`}
              >
                {techSnapshot.overallBias} ({techSnapshot.bullishSignalsCount}↑ /{' '}
                {techSnapshot.bearishSignalsCount}↓)
              </span>
            </div>

            <div className="space-y-1 text-xs">
              {techSnapshot.signals.map((sig) => (
                <div
                  key={sig.id}
                  className="flex items-center justify-between gap-2 py-1 border-b border-white/[0.04] last:border-b-0"
                >
                  <span className="text-slate-400">{sig.label}</span>
                  <span
                    className={`font-mono-tabular text-right ${
                      sig.bias === 'alcista'
                        ? 'text-emerald-300'
                        : sig.bias === 'bajista'
                        ? 'text-rose-300'
                        : 'text-slate-300'
                    }`}
                  >
                    {sig.valueText}
                  </span>
                </div>
              ))}
            </div>

            {/* MTF Matrix 15m / 1h / 4h / 1d */}
            <div className="bg-[#0B0E14] border border-white/[0.06] rounded p-2 space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold text-slate-200">Matriz Multi-Timeframe (MTF)</span>
                <span className="font-mono-tabular text-slate-400">
                  {mtfBullCount}↑ · {mtfBearCount}↓
                </span>
              </div>
              <div className="grid grid-cols-5 gap-1 text-[10px] font-mono-tabular text-slate-500 border-b border-white/[0.05] pb-1">
                <span>TF</span>
                <span>EMA</span>
                <span>RSI</span>
                <span>MACD</span>
                <span className="text-right">Sesgo</span>
              </div>
              {mtfMatrix.map((row) => (
                <div
                  key={row.tf}
                  className="grid grid-cols-5 gap-1 text-[11px] font-mono-tabular items-center"
                >
                  <span className="text-white font-semibold">{row.label}</span>
                  <span
                    className={
                      row.emaBias === 'alcista'
                        ? 'text-emerald-300'
                        : row.emaBias === 'bajista'
                        ? 'text-rose-300'
                        : 'text-slate-400'
                    }
                  >
                    {row.emaBias === 'alcista' ? 'Alc.' : row.emaBias === 'bajista' ? 'Baj.' : 'Neu.'}
                  </span>
                  <span className="text-slate-300">
                    {row.rsi !== null ? row.rsi.toFixed(0) : '—'}
                  </span>
                  <span
                    className={
                      row.macdHist === null
                        ? 'text-slate-500'
                        : row.macdHist >= 0
                        ? 'text-emerald-300'
                        : 'text-rose-300'
                    }
                  >
                    {row.macdHist !== null ? (row.macdHist >= 0 ? '+' : '-') : '—'}
                  </span>
                  <span
                    className={`text-right font-semibold ${
                      row.overall === 'Alcista'
                        ? 'text-emerald-300'
                        : row.overall === 'Bajista'
                        ? 'text-rose-300'
                        : 'text-slate-400'
                    }`}
                  >
                    {row.overall}
                  </span>
                </div>
              ))}
            </div>

            {divergences.length > 0 && (
              <div className="bg-[#0B0E14] border border-white/[0.06] rounded p-2 space-y-1 text-[11px]">
                <div className="font-semibold text-slate-200">Divergencias Recientes</div>
                {divergences.slice(0, 3).map((d) => (
                  <div
                    key={d.id}
                    className={`flex items-center justify-between font-mono-tabular ${
                      d.kind.startsWith('bullish') ? 'text-emerald-300' : 'text-rose-300'
                    }`}
                  >
                    <span>{d.label}</span>
                    <span>{formatPrice(d.price, asset)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Interactive Orderbook Depth Curve + Taker Flow + Absorption */}
          <div className="p-3.5 border-b border-white/[0.08] space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-white">
                Profundidad OKX ({prefs.marketMode === 'perp' ? 'SWAP' : 'Spot'}) &amp; Taker
              </h3>
              <span className="text-[10px] font-mono-tabular text-slate-400">
                Imbalance{' '}
                <strong
                  className={
                    liquidity.imbalancePct >= 0 ? 'text-emerald-300' : 'text-rose-300'
                  }
                >
                  {liquidity.imbalancePct >= 0 ? '+' : ''}
                  {liquidity.imbalancePct.toFixed(1)}%
                </strong>
              </span>
            </div>

            <InteractiveDepthChart
              curve={depthCurve}
              asset={asset}
              rangePct={prefs.depthRangePct}
              onChangeRangePct={(r) => updatePref('depthRangePct', r)}
            />

            {takerTape && (
              <div className="bg-[#0B0E14] border border-white/[0.06] rounded p-2.5 space-y-1.5 text-xs font-mono-tabular">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 font-sans text-[11px]">
                    Taker Delta ({takerTape.instId})
                  </span>
                  <span
                    className={
                      takerTape.netDeltaUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'
                    }
                  >
                    {takerTape.netDeltaUsd >= 0 ? '+' : '-'}
                    {formatUsdCompact(Math.abs(takerTape.netDeltaUsd))}
                  </span>
                </div>
                <div className="h-2 bg-rose-500/40 rounded overflow-hidden flex">
                  <div
                    className="h-full bg-emerald-400"
                    style={{ width: `${takerTape.buyRatioPct.toFixed(1)}%` }}
                  />
                </div>
                <div className="flex justify-between text-[11px] text-slate-400">
                  <span className="text-emerald-300">
                    Compras {takerTape.buyRatioPct.toFixed(1)}% ({formatUsdCompact(takerTape.buyUsd)})
                  </span>
                  <span className="text-rose-300">
                    Ventas {(100 - takerTape.buyRatioPct).toFixed(1)}% (
                    {formatUsdCompact(takerTape.sellUsd)})
                  </span>
                </div>
                {takerTape.absorption.detected && (
                  <div
                    className={`mt-1 px-2 py-1 rounded text-[11px] font-sans border ${
                      takerTape.absorption.side === 'compra'
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                        : 'bg-rose-500/10 border-rose-500/30 text-rose-200'
                    }`}
                  >
                    {takerTape.absorption.summary}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Bottom Tabbed Panel: Confluences & S/R | Fib & FVG | Whale Taker Tape */}
          <div className="p-3.5 flex-1 space-y-3">
            <div className="flex items-center bg-[#0B0E14] p-0.5 rounded border border-white/[0.08] text-xs">
              {(
                [
                  { id: 'levels', label: 'Confluencias & S/R' },
                  { id: 'fib', label: 'Fib & FVG' },
                  { id: 'depth', label: 'Cinta Ballenas' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => updatePref('rightTab', t.id)}
                  className={`flex-1 py-1 text-[11px] font-medium rounded transition-colors ${
                    prefs.rightTab === t.id
                      ? 'bg-[#1F2937] text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {prefs.rightTab === 'levels' && (
              <div className="space-y-2.5 text-xs font-mono-tabular">
                {confluenceZones.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] font-sans font-semibold text-sky-300">
                      Zonas de Alta Confluencia (Clusters)
                    </div>
                    {confluenceZones.map((cz) => (
                      <div
                        key={cz.id}
                        className="bg-[#0B0E14] border border-sky-500/25 rounded px-2.5 py-1.5 space-y-0.5"
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={
                              cz.kind === 'soporte'
                                ? 'text-emerald-300 font-semibold'
                                : cz.kind === 'resistencia'
                                ? 'text-rose-300 font-semibold'
                                : 'text-sky-300 font-semibold'
                            }
                          >
                            {cz.kind.toUpperCase()} ×{cz.factorCount}
                          </span>
                          <span className="text-white font-semibold">
                            {formatPrice(cz.avgPrice, asset)}
                          </span>
                          <span className="text-slate-400">
                            {cz.distancePct >= 0 ? '+' : ''}
                            {cz.distancePct.toFixed(2)}%
                          </span>
                        </div>
                        <div className="text-[10px] font-sans text-slate-400 truncate">
                          {cz.factors.join(' + ')}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {userLevels.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] font-sans font-semibold text-slate-300">
                      Niveles Manuales Compartidos
                    </div>
                    {userLevels.map((lvl) => (
                      <div
                        key={lvl.id}
                        className="flex items-center justify-between bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-1"
                      >
                        <span className="text-slate-200 font-sans">
                          {lvl.label || 'Nivel manual'}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className="text-white">{formatPrice(lvl.price, asset)}</span>
                          <button
                            type="button"
                            onClick={() => removeUserLevel(lvl.id)}
                            className="text-slate-500 hover:text-rose-300"
                            title="Eliminar nivel"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="space-y-1">
                  <div className="text-[11px] font-sans font-semibold text-slate-300">
                    Soportes, Resistencias &amp; Liquidez
                  </div>
                  {srZones.map((z) => (
                    <div
                      key={z.id}
                      className="flex items-center justify-between bg-[#0B0E14] border border-white/[0.06] rounded px-2.5 py-1.5"
                    >
                      <span
                        className={z.kind === 'support' ? 'text-emerald-300' : 'text-rose-300'}
                      >
                        {z.kind === 'support' ? 'Soporte' : 'Resistencia'} (×{z.touches})
                      </span>
                      <span className="text-white">{formatPrice(z.price, asset)}</span>
                      <span className="text-slate-400">
                        {z.distancePct >= 0 ? '+' : ''}
                        {z.distancePct.toFixed(2)}%
                      </span>
                    </div>
                  ))}

                  {liquidity.levels.slice(0, 8).map((l) => (
                    <div
                      key={l.id}
                      className="flex items-center justify-between bg-[#0B0E14] border border-white/[0.06] rounded px-2.5 py-1.5"
                    >
                      <span className="text-slate-300 font-sans truncate max-w-[165px]">
                        {l.label}
                      </span>
                      <span className="text-white">{formatPrice(l.price, asset)}</span>
                      <span className={l.side === 'above' ? 'text-rose-300' : 'text-emerald-300'}>
                        {spot > 0 ? `${(((l.price - spot) / spot) * 100).toFixed(2)}%` : '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {prefs.rightTab === 'fib' && (
              <div className="space-y-3 text-xs font-mono-tabular">
                {fibAnalysis && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-slate-400 font-sans flex justify-between">
                      <span>
                        Impulso ({fibAnalysis.anchorMode}):{' '}
                        <strong className="text-white">
                          {fibAnalysis.direction === 'bullish' ? 'Alcista' : 'Bajista'}
                        </strong>
                      </span>
                      <span>
                        {formatPrice(fibAnalysis.swingLow, asset)} –{' '}
                        {formatPrice(fibAnalysis.swingHigh, asset)}
                      </span>
                    </div>
                    {fibAnalysis.levels.map((fl) => (
                      <div
                        key={fl.label}
                        className={`flex items-center justify-between rounded px-2.5 py-1 border ${
                          fl.isGolden
                            ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                            : 'bg-[#0B0E14] border-white/[0.06] text-slate-300'
                        }`}
                      >
                        <span>{fl.label}</span>
                        <span className="text-white font-semibold">
                          {formatPrice(fl.price, asset)}
                        </span>
                        <span className="text-slate-400">
                          {fl.distancePct >= 0 ? '+' : ''}
                          {fl.distancePct.toFixed(2)}%
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="space-y-1">
                  <div className="text-[11px] font-sans font-semibold text-slate-300">
                    Fair Value Gaps (FVG sin mitigar)
                  </div>
                  {fvgs.length === 0 ? (
                    <div className="text-[11px] text-slate-500 font-sans">
                      Sin imbalances activos en este rango.
                    </div>
                  ) : (
                    fvgs.map((g) => (
                      <div
                        key={g.id}
                        className="flex items-center justify-between bg-[#0B0E14] border border-white/[0.06] rounded px-2.5 py-1.5"
                      >
                        <span
                          className={
                            g.direction === 'bullish' ? 'text-emerald-300' : 'text-rose-300'
                          }
                        >
                          {g.direction === 'bullish' ? 'FVG Alcista' : 'FVG Bajista'}
                        </span>
                        <span className="text-white">
                          {formatPrice(g.bottom, asset)} – {formatPrice(g.top, asset)}
                        </span>
                        <span className="text-slate-400">
                          {g.distancePct >= 0 ? '+' : ''}
                          {g.distancePct.toFixed(2)}%
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {prefs.rightTab === 'depth' && (
              <div className="space-y-2 text-xs font-mono-tabular">
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-sans text-slate-400">Filtro tamaño:</span>
                  <div className="flex bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]">
                    {(
                      [
                        { v: 0, l: 'Todas' },
                        { v: 10000, l: '≥$10K' },
                        { v: 50000, l: '≥$50K' },
                        { v: 100000, l: '≥$100K' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => updatePref('whaleMinUsd', opt.v)}
                        className={`px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                          prefs.whaleMinUsd === opt.v
                            ? 'bg-[#1F2937] text-white font-semibold'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {opt.l}
                      </button>
                    ))}
                  </div>
                </div>

                {filteredTakerTrades.length > 0 ? (
                  <div className="space-y-1">
                    {filteredTakerTrades.slice(0, 18).map((tr) => {
                      const isWhale = tr.notionalUsd >= 50_000;
                      return (
                        <div
                          key={tr.id}
                          className={`flex items-center justify-between py-1 px-2 rounded border ${
                            isWhale
                              ? tr.side === 'buy'
                                ? 'bg-emerald-500/10 border-emerald-500/35'
                                : 'bg-rose-500/10 border-rose-500/35'
                              : 'bg-[#0B0E14] border-white/[0.05]'
                          }`}
                        >
                          <span
                            className={
                              tr.side === 'buy'
                                ? 'text-emerald-300 font-semibold'
                                : 'text-rose-300 font-semibold'
                            }
                          >
                            {tr.side === 'buy' ? 'COMPRA' : 'VENTA'}
                            {isWhale ? ' · BALLENA' : ''}
                          </span>
                          <span className="text-white">{formatPrice(tr.price, asset)}</span>
                          <span className="text-slate-300">
                            {tr.size.toFixed(asset === 'BTC' ? 4 : 3)} ({formatUsdCompact(tr.notionalUsd)})
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-slate-500 font-sans text-[11px] py-2">
                    {takerTape
                      ? 'Sin ejecuciones recientes por encima del filtro seleccionado.'
                      : 'Cargando ejecuciones en vivo...'}
                  </div>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
