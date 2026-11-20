import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Activity, Layers, Loader2 } from 'lucide-react';
import { calculateVWAP } from '../calc/indicators';
import { analyzeMarketLiquidity } from '../calc/liquidity';
import { aggregateStrikes, calculateLevels } from '../calc/options';
import {
  calculateFibonacciLevels,
  calculateVolumeDeltaSeries,
  calculateVolumeProfileBuckets,
  computeTechnicalSnapshot,
  detectSupportResistanceZones,
  type FibDirectionMode,
} from '../calc/technicalAnalysis';
import {
  fetchLiveTakerTrades,
  fetchOrderbookDepthCurve,
  type OrderbookCurveSnapshot,
  type TakerTapeSummary,
} from '../data/okxTechnicalClient';
import { useTerminalStore } from '../store/terminalStore';
import type { Candle, SymbolAsset, Timeframe } from '../types/market';
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

type OscillatorMode = 'rsi' | 'macd';

function formatPrice(val: number, asset: SymbolAsset): string {
  return `$${val.toLocaleString('en-US', {
    minimumFractionDigits: asset === 'BTC' ? 1 : 2,
    maximumFractionDigits: asset === 'BTC' ? 1 : 2,
  })}`;
}

function formatUsdCompact(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

function InteractiveDepthChart({
  curve,
  asset,
}: {
  curve: OrderbookCurveSnapshot | null;
  asset: SymbolAsset;
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
    const maxRangePct = 2.0;
    const bids = curve.bids.filter((b) => Math.abs(b.distancePct) <= maxRangePct);
    const asks = curve.asks.filter((a) => Math.abs(a.distancePct) <= maxRangePct);
    if (bids.length < 2 && asks.length < 2) return null;

    const maxBidUsd = bids.length > 0 ? bids[0].cumulativeUsd : 0;
    const maxAskUsd = asks.length > 0 ? asks[asks.length - 1].cumulativeUsd : 0;
    const maxUsd = Math.max(1, maxBidUsd, maxAskUsd);
    const minP = curve.midPrice * (1 - maxRangePct / 100);
    const maxP = curve.midPrice * (1 + maxRangePct / 100);

    return { bids, asks, maxUsd, minP, maxP };
  }, [curve]);

  if (!curve || !points) {
    return (
      <div className="h-36 flex items-center justify-center text-xs text-slate-500 bg-[#0B0E14] rounded border border-white/[0.06]">
        Cargando profundidad del libro OKX...
      </div>
    );
  }

  const W = 360;
  const H = 136;
  const padX = 8;
  const padTop = 14;
  const padBot = 20;
  const innerW = W - padX * 2;
  const innerH = H - padTop - padBot;

  const toX = (p: number) =>
    padX + Math.min(1, Math.max(0, (p - points.minP) / (points.maxP - points.minP))) * innerW;
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
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] font-mono-tabular text-slate-400">
        <span>
          Bids ±2%: <strong className="text-emerald-300">{formatUsdCompact(curve.totalBidUsd)}</strong>
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
          Asks ±2%: <strong className="text-rose-300">{formatUsdCompact(curve.totalAskUsd)}</strong>
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverInfo(null)}
        className="w-full h-36 bg-[#0B0E14] rounded border border-white/[0.06] cursor-crosshair select-none"
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
          y={H - 5}
          fill="#64748B"
          fontSize="9"
          fontFamily="JetBrains Mono, monospace"
        >
          -2.0%
        </text>
        <text
          x={midX}
          y={H - 5}
          textAnchor="middle"
          fill="#94A3B8"
          fontSize="9"
          fontFamily="JetBrains Mono, monospace"
        >
          Spot
        </text>
        <text
          x={W - padX - 2}
          y={H - 5}
          textAnchor="end"
          fill="#64748B"
          fontSize="9"
          fontFamily="JetBrains Mono, monospace"
        >
          +2.0%
        </text>
      </svg>
    </div>
  );
}

export function TechnicalAnalysisWorkspace() {
  const {
    asset,
    setAsset,
    timeframe,
    setTimeframe,
    candles,
    candlesLoading,
    candlesDatasetKey,
    ticker,
    options,
    orderbook,
    prevDayHigh,
    prevDayLow,
  } = useTerminalStore();

  // Interactive Layer Controls
  const [showEmas, setShowEmas] = useState(true);
  const [showBollinger, setShowBollinger] = useState(false);
  const [showVwap, setShowVwap] = useState(true);
  const [showVpvr, setShowVpvr] = useState(true);
  const [showSR, setShowSR] = useState(true);
  const [showLiquidity, setShowLiquidity] = useState(true);
  const [showFib, setShowFib] = useState(true);
  const [fibLookback, setFibLookback] = useState<60 | 120 | 240>(120);
  const [fibMode, setFibMode] = useState<FibDirectionMode>('auto');
  const [oscMode, setOscMode] = useState<OscillatorMode>('rsi');
  const [rightTab, setRightTab] = useState<'levels' | 'depth' | 'fib'>('levels');

  // Live OKX Microstructure (Taker Delta + Depth Curve)
  const [takerTape, setTakerTape] = useState<TakerTapeSummary | null>(null);
  const [depthCurve, setDepthCurve] = useState<OrderbookCurveSnapshot | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    async function pollMicrostructure() {
      try {
        const [tapeRes, curveRes] = await Promise.all([
          fetchLiveTakerTrades(asset, ctrl.signal),
          fetchOrderbookDepthCurve(asset, ctrl.signal),
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
    }, 6_000);

    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, [asset]);

  const spot = ticker?.idxPx ?? candles[candles.length - 1]?.c ?? 0;

  // Derived Technical Analytics
  const allStrikes = useMemo(() => aggregateStrikes(options, spot, 'ALL'), [options, spot]);
  const optionsLevels = useMemo(
    () => calculateLevels(allStrikes, options, spot),
    [allStrikes, options, spot]
  );

  const liquidity = useMemo(
    () =>
      analyzeMarketLiquidity(candles, spot, optionsLevels, orderbook, prevDayHigh, prevDayLow),
    [candles, spot, optionsLevels, orderbook, prevDayHigh, prevDayLow]
  );

  const volumeProfile = useMemo(
    () => calculateVolumeProfileBuckets(candles.slice(-200), 36),
    [candles]
  );

  const volumeDeltaSeries = useMemo(() => calculateVolumeDeltaSeries(candles), [candles]);
  const vwapSeries = useMemo(() => calculateVWAP(candles), [candles]);
  const srZones = useMemo(() => detectSupportResistanceZones(candles, spot), [candles, spot]);
  const fibAnalysis = useMemo(
    () => calculateFibonacciLevels(candles, fibLookback, fibMode, spot),
    [candles, fibLookback, fibMode, spot]
  );

  const techSnapshot = useMemo(
    () => computeTechnicalSnapshot(candles, volumeProfile?.poc ?? null, liquidity.imbalancePct),
    [candles, volumeProfile?.poc, liquidity.imbalancePct]
  );

  // Chart Refs
  const mainContainerRef = useRef<HTMLDivElement>(null);
  const deltaContainerRef = useRef<HTMLDivElement>(null);
  const oscContainerRef = useRef<HTMLDivElement>(null);

  const mainChartRef = useRef<IChartApi | null>(null);
  const deltaChartRef = useRef<IChartApi | null>(null);
  const oscChartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ema50SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ema200SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpperSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLowerSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vpPrimitiveRef = useRef<VolumeProfilePrimitive | null>(null);
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

  // Initialize synchronized Lightweight Charts (Main + Delta/CVD + RSI/MACD)
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

    const vpPrimitive = new VolumeProfilePrimitive();
    candleSeries.attachPrimitive(vpPrimitive);

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

    // Oscillator Subchart (RSI or MACD)
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

    // Link time scales bidirectionally
    const syncRange = (source: IChartApi, targets: IChartApi[]) => {
      source.timeScale().subscribeVisibleLogicalRangeChange((range: LogicalRange | null) => {
        if (!range || isSyncingRef.current) return;
        isSyncingRef.current = true;
        for (const t of targets) {
          t.timeScale().setVisibleLogicalRange(range);
        }
        isSyncingRef.current = false;
      });
    };

    syncRange(mainChart, [deltaChart, oscChart]);
    syncRange(deltaChart, [mainChart, oscChart]);
    syncRange(oscChart, [mainChart, deltaChart]);

    mainChart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHoveredIdx(null);
        return;
      }
      const idx = candleIndexMapRef.current.get(Number(param.time));
      setHoveredIdx(idx ?? null);
    });

    mainChartRef.current = mainChart;
    deltaChartRef.current = deltaChart;
    oscChartRef.current = oscChart;

    candleSeriesRef.current = candleSeries;
    vpPrimitiveRef.current = vpPrimitive;
    ema50SeriesRef.current = ema50Series;
    ema200SeriesRef.current = ema200Series;
    bbUpperSeriesRef.current = bbUpper;
    bbLowerSeriesRef.current = bbLower;
    vwapSeriesRef.current = vwapSeries;

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

  // Push Candles + Overlays + Subcharts
  useEffect(() => {
    const cs = candleSeriesRef.current;
    const e50s = ema50SeriesRef.current;
    const e200s = ema200SeriesRef.current;
    const bbu = bbUpperSeriesRef.current;
    const bbl = bbLowerSeriesRef.current;
    const vwaps = vwapSeriesRef.current;
    const dh = deltaHistRef.current;
    const cvd = cvdLineRef.current;
    const om = oscMainLineRef.current;
    const os = oscSignalLineRef.current;
    const oh = oscHistRef.current;

    if (!cs || !e50s || !e200s || !bbu || !bbl || !vwaps || !dh || !cvd || !om || !os || !oh) {
      return;
    }

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

    e50s.applyOptions({ visible: showEmas });
    e200s.applyOptions({ visible: showEmas });
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

    bbu.applyOptions({ visible: showBollinger });
    bbl.applyOptions({ visible: showBollinger });
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

    vwaps.applyOptions({ visible: showVwap });
    vwaps.setData(
      candles
        .map((c, idx) =>
          vwapSeries[idx] !== null
            ? { time: Math.floor(c.t / 1000) as UTCTimestamp, value: vwapSeries[idx]! }
            : null
        )
        .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
    );

    vpPrimitiveRef.current?.setData(volumeProfile, showVpvr);

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

    if (oscMode === 'rsi') {
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
          price: 30,
          color: 'rgba(16, 185, 129, 0.5)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'OS 30',
        })
      );
    } else {
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
    }

    // Price Lines: S/R, Liquidity Walls & Pools, Fibonacci
    for (const ln of priceLinesRef.current) {
      cs.removePriceLine(ln);
    }
    priceLinesRef.current = [];

    if (showSR) {
      for (const z of srZones) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: z.price,
            color: z.kind === 'support' ? 'rgba(16, 185, 129, 0.68)' : 'rgba(244, 63, 94, 0.68)',
            lineWidth: 1,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: true,
            title: `${z.kind === 'support' ? 'Soporte' : 'Resist.'} (×${z.touches})`,
          })
        );
      }
    }

    if (showLiquidity) {
      if (liquidity.strongestAskWall) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: liquidity.strongestAskWall.price,
            color: '#FB7185',
            lineWidth: 2,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: `Ask Wall ${formatUsdCompact(liquidity.strongestAskWall.notionalUsd)}`,
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
            title: `Bid Wall ${formatUsdCompact(liquidity.strongestBidWall.notionalUsd)}`,
          })
        );
      }
      if (liquidity.nearestBSL) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: liquidity.nearestBSL.price,
            color: 'rgba(249, 115, 22, 0.78)',
            lineWidth: 1,
            lineStyle: LineStyle.SparseDotted,
            axisLabelVisible: true,
            title: 'BSL',
          })
        );
      }
      if (liquidity.nearestSSL) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: liquidity.nearestSSL.price,
            color: 'rgba(56, 189, 248, 0.78)',
            lineWidth: 1,
            lineStyle: LineStyle.SparseDotted,
            axisLabelVisible: true,
            title: 'SSL',
          })
        );
      }
    }

    if (showFib && fibAnalysis) {
      for (const fl of fibAnalysis.levels) {
        if (fl.ratio === 0 || fl.ratio === 1 || fl.ratio === 0.236 || fl.ratio === 1.272) continue;
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: fl.price,
            color: fl.isGolden ? '#FACC15' : 'rgba(250, 204, 21, 0.45)',
            lineWidth: fl.isGolden ? 2 : 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: `Fib ${fl.label}`,
          })
        );
      }
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
    volumeProfile,
    volumeDeltaSeries,
    srZones,
    liquidity,
    fibAnalysis,
    showEmas,
    showBollinger,
    showVwap,
    showVpvr,
    showSR,
    showLiquidity,
    showFib,
    oscMode,
  ]);

  const activeIdx =
    hoveredIdx !== null && hoveredIdx >= 0 && hoveredIdx < candles.length
      ? hoveredIdx
      : candles.length - 1;
  const activeCandle: Candle | null = activeIdx >= 0 ? candles[activeIdx] : null;
  const activeEma50 = activeIdx >= 0 ? techSnapshot.ema50[activeIdx] : null;
  const activeEma200 = activeIdx >= 0 ? techSnapshot.ema200[activeIdx] : null;
  const activeRsi = activeIdx >= 0 ? techSnapshot.rsi14[activeIdx] : null;
  const activeDelta = activeIdx >= 0 ? volumeDeltaSeries[activeIdx] : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[#0B0E14] text-slate-200 overflow-y-auto lg:overflow-hidden">
      {/* Top Interactive Technical Controls Strip */}
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

        {/* Dynamic Overlay Toggles + Fib Config */}
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="flex items-center gap-1 text-slate-400 mr-1">
            <Layers className="w-3.5 h-3.5" />
            <span>Capas:</span>
          </span>
          {(
            [
              { label: 'EMA 50/200', active: showEmas, toggle: () => setShowEmas((v) => !v) },
              {
                label: 'Bollinger',
                active: showBollinger,
                toggle: () => setShowBollinger((v) => !v),
              },
              { label: 'VWAP', active: showVwap, toggle: () => setShowVwap((v) => !v) },
              { label: 'Perfil Vol.', active: showVpvr, toggle: () => setShowVpvr((v) => !v) },
              { label: 'S/R', active: showSR, toggle: () => setShowSR((v) => !v) },
              { label: 'Liquidez', active: showLiquidity, toggle: () => setShowLiquidity((v) => !v) },
              { label: 'Fibonacci', active: showFib, toggle: () => setShowFib((v) => !v) },
            ] as const
          ).map((btn) => (
            <button
              key={btn.label}
              type="button"
              onClick={btn.toggle}
              className={`px-2 py-1 rounded border transition-colors whitespace-nowrap ${
                btn.active
                  ? 'bg-[#1F2937] border-sky-500/45 text-white'
                  : 'bg-[#0B0E14] border-white/[0.08] text-slate-400 hover:text-slate-200'
              }`}
            >
              {btn.label}
            </button>
          ))}

          {showFib && (
            <div className="flex items-center gap-1 pl-2 ml-1 border-l border-white/[0.08]">
              <select
                value={fibLookback}
                onChange={(e) => setFibLookback(Number(e.target.value) as 60 | 120 | 240)}
                className="bg-[#0B0E14] border border-white/[0.08] rounded px-1.5 py-1 text-[11px] font-mono-tabular text-slate-200 focus:outline-none"
                title="Ventana de velas para Fibonacci"
              >
                <option value={60}>Fib 60v</option>
                <option value={120}>Fib 120v</option>
                <option value={240}>Fib 240v</option>
              </select>
              <select
                value={fibMode}
                onChange={(e) => setFibMode(e.target.value as FibDirectionMode)}
                className="bg-[#0B0E14] border border-white/[0.08] rounded px-1.5 py-1 text-[11px] text-slate-200 focus:outline-none"
                title="Dirección del trazo Fibonacci"
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
        <div className="flex-1 flex flex-col min-w-0 min-h-[620px] lg:min-h-0 border-r border-white/[0.08]">
          {/* Crosshair Live OHLCV + Indicator Telemetry Strip */}
          <div className="px-3 py-1.5 bg-[#0E131C] border-b border-white/[0.06] flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono-tabular shrink-0">
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
                <span className="text-sky-300">
                  EMA50: {activeEma50 !== null ? formatPrice(activeEma50, asset) : '—'}
                </span>
                <span className="text-amber-300">
                  EMA200: {activeEma200 !== null ? formatPrice(activeEma200, asset) : '—'}
                </span>
                <span className="text-violet-300">
                  RSI(14): {activeRsi !== null ? activeRsi.toFixed(1) : '—'}
                </span>
                {activeDelta && (
                  <span
                    className={activeDelta.delta >= 0 ? 'text-emerald-300' : 'text-rose-300'}
                  >
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

          {/* 1. Primary Candlestick + EMAs + Volume Profile + Fib + S/R + Liquidity */}
          <div className="relative flex-[3] min-h-[300px]">
            <div ref={mainContainerRef} className="w-full h-full" />
            {volumeProfile && showVpvr && (
              <div className="pointer-events-none absolute top-2 left-3 bg-[#0B0E14]/80 border border-white/[0.08] rounded px-2.5 py-1 text-[11px] font-mono-tabular text-slate-300 flex flex-wrap gap-2">
                <span className="text-amber-300">POC {formatPrice(volumeProfile.poc, asset)}</span>
                <span aria-hidden="true">·</span>
                <span>VAH {formatPrice(volumeProfile.vah, asset)}</span>
                <span aria-hidden="true">·</span>
                <span>VAL {formatPrice(volumeProfile.val, asset)}</span>
              </div>
            )}
          </div>

          {/* 2. Synchronized Sub-Chart: Volume Delta & CVD */}
          <div className="border-t border-white/[0.08] flex-[1.15] min-h-[125px] flex flex-col">
            <div className="px-3 py-1 bg-[#0E131C] border-b border-white/[0.05] flex items-center justify-between text-[11px] shrink-0">
              <span className="font-medium text-slate-200">
                Delta de Volumen por barra &amp; CVD acumulado
              </span>
              <span className="font-mono-tabular text-slate-400">
                Línea azul: CVD · Barras: Delta comprador/vendedor
              </span>
            </div>
            <div ref={deltaContainerRef} className="flex-1 min-h-0" />
          </div>

          {/* 3. Synchronized Sub-Chart: RSI(14) or MACD(12/26/9) */}
          <div className="border-t border-white/[0.08] flex-[1.1] min-h-[125px] flex flex-col">
            <div className="px-3 py-1 bg-[#0E131C] border-b border-white/[0.05] flex items-center justify-between text-[11px] shrink-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-200">Oscilador de Momentum</span>
                <div className="flex bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]">
                  <button
                    type="button"
                    onClick={() => setOscMode('rsi')}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                      oscMode === 'rsi'
                        ? 'bg-[#1F2937] text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    RSI (14)
                  </button>
                  <button
                    type="button"
                    onClick={() => setOscMode('macd')}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                      oscMode === 'macd'
                        ? 'bg-[#1F2937] text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    MACD (12/26/9)
                  </button>
                </div>
              </div>
              <span className="font-mono-tabular text-slate-400">
                Sincronizado con eje temporal
              </span>
            </div>
            <div ref={oscContainerRef} className="flex-1 min-h-0" />
          </div>
        </div>

        {/* Right Telemetry Column: Technical Bias + Depth + Live Taker Tape + Levels */}
        <aside className="w-full lg:w-[390px] xl:w-[420px] shrink-0 bg-[#12161E] flex flex-col min-h-0 overflow-y-auto">
          {/* Technical Multi-Factor Summary */}
          <div className="p-4 border-b border-white/[0.08] space-y-2.5">
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

            <div className="space-y-1.5 text-xs">
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
          </div>

          {/* Interactive Orderbook Depth Curve + Live Taker Delta */}
          <div className="p-4 border-b border-white/[0.08] space-y-3">
            <h3 className="text-xs font-semibold text-white">
              Profundidad OKX en Vivo (±2%) &amp; Flujo Taker
            </h3>
            <InteractiveDepthChart curve={depthCurve} asset={asset} />

            {takerTape && (
              <div className="bg-[#0B0E14] border border-white/[0.06] rounded p-2.5 space-y-1.5 text-xs font-mono-tabular">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400 font-sans">
                    Taker Delta (últ. 100 ejecuciones OKX)
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
              </div>
            )}
          </div>

          {/* Sub-Tabs for Levels / Liquidity / Fibonacci */}
          <div className="p-4 flex-1 space-y-3">
            <div className="flex items-center bg-[#0B0E14] p-0.5 rounded border border-white/[0.08] text-xs">
              {(
                [
                  { id: 'levels', label: 'S/R & Liquidez' },
                  { id: 'fib', label: 'Fibonacci' },
                  { id: 'depth', label: 'Cinta Taker' },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setRightTab(t.id)}
                  className={`flex-1 py-1 text-[11px] font-medium rounded transition-colors ${
                    rightTab === t.id
                      ? 'bg-[#1F2937] text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {rightTab === 'levels' && (
              <div className="space-y-2 text-xs font-mono-tabular">
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
                    <span className="text-slate-300 font-sans truncate max-w-[155px]">
                      {l.label}
                    </span>
                    <span className="text-white">{formatPrice(l.price, asset)}</span>
                    <span className={l.side === 'above' ? 'text-rose-300' : 'text-emerald-300'}>
                      {spot > 0 ? `${(((l.price - spot) / spot) * 100).toFixed(2)}%` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {rightTab === 'fib' && fibAnalysis && (
              <div className="space-y-2 text-xs font-mono-tabular">
                <div className="text-[11px] text-slate-400 font-sans flex justify-between">
                  <span>
                    Impulso:{' '}
                    <strong className="text-white">
                      {fibAnalysis.direction === 'bullish' ? 'Alcista' : 'Bajista'}
                    </strong>
                  </span>
                  <span>
                    Rango: {formatPrice(fibAnalysis.swingLow, asset)} –{' '}
                    {formatPrice(fibAnalysis.swingHigh, asset)}
                  </span>
                </div>
                {fibAnalysis.levels.map((fl) => (
                  <div
                    key={fl.label}
                    className={`flex items-center justify-between rounded px-2.5 py-1.5 border ${
                      fl.isGolden
                        ? 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                        : 'bg-[#0B0E14] border-white/[0.06] text-slate-300'
                    }`}
                  >
                    <span>{fl.label}</span>
                    <span className="text-white font-semibold">{formatPrice(fl.price, asset)}</span>
                    <span className="text-slate-400">
                      {fl.distancePct >= 0 ? '+' : ''}
                      {fl.distancePct.toFixed(2)}%
                    </span>
                  </div>
                ))}
              </div>
            )}

            {rightTab === 'depth' && (
              <div className="space-y-1 text-xs font-mono-tabular">
                {takerTape && takerTape.trades.length > 0 ? (
                  takerTape.trades.slice(0, 14).map((tr) => (
                    <div
                      key={tr.id}
                      className="flex items-center justify-between py-1 px-2 rounded bg-[#0B0E14] border border-white/[0.05]"
                    >
                      <span
                        className={
                          tr.side === 'buy' ? 'text-emerald-300 font-semibold' : 'text-rose-300 font-semibold'
                        }
                      >
                        {tr.side === 'buy' ? 'COMPRA' : 'VENTA'}
                      </span>
                      <span className="text-white">{formatPrice(tr.price, asset)}</span>
                      <span className="text-slate-300">
                        {tr.size.toFixed(asset === 'BTC' ? 4 : 3)} ({formatUsdCompact(tr.notionalUsd)})
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="text-slate-500">Cargando ejecuciones en vivo...</div>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
