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
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Info,
  Loader2,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import {
  distanceToRayPx,
  distanceToSegmentPx,
  projectTimeSecFromLogical,
} from '../calc/chartDrawings';
import { calculateExpectedRangeCone, getAtTheMoneyIV } from '../calc/cone';
import { calculateHedgeFlowSeries, calculateOnePercentMoveImpact } from '../calc/hedgeFlow';
import { calculateEMAClouds, calculateVWAP } from '../calc/indicators';
import { analyzeMarketLiquidity } from '../calc/liquidity';
import { aggregateStrikes, calculateLevels } from '../calc/options';
import { TIMEFRAME_MS, fetchIndexCandles } from '../data/okxMarketClient';
import { useTerminalStore } from '../store/terminalStore';
import type {
  Candle,
  ChartAnchorPoint,
  MarkerFollowStatus,
  Timeframe,
} from '../types/market';
import { EmaCloudPrimitive } from './primitives/EmaCloudPrimitive';
import { ExpectedRangeConePrimitive } from './primitives/ExpectedRangeConePrimitive';
import { MacroEventsPrimitive, type ChartEventBadge } from './primitives/MacroEventsPrimitive';
import { UserDrawingsPrimitive, type PreviewTrendLine } from './primitives/UserDrawingsPrimitive';

const QUICK_TIMEFRAMES: { value: Timeframe; label: string }[] = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1H', label: '1h' },
  { value: '4H', label: '4h' },
  { value: 'D', label: '1d' },
];

function formatUsdCompact(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

function formatBarCountdown(barStartMs: number, timeframeMs: number, nowMs: number): string {
  const remaining = Math.max(0, barStartMs + timeframeMs - nowMs);
  const totalSec = Math.floor(remaining / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (hrs > 0) return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  return `${pad(mins)}:${pad(secs)}`;
}

const DRAWING_COLOR_SWATCHES = ['#FACC15', '#38BDF8', '#10B981', '#F43F5E', '#A78BFA'] as const;

const MARKER_QUICK_TAGS = ['Objetivo Cono', 'Ruptura', 'Rechazo', 'Soporte'] as const;

function formatMarkerTime(timeSec: number): string {
  const dt = new Date(timeSec * 1000);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('es-ES', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ChartWorkspace({ mainChartOnly = false }: { mainChartOnly?: boolean }) {
  const {
    asset,
    timeframe,
    setTimeframe,
    candles,
    candlesLoading,
    candlesDatasetKey,
    prependCandles,
    candlesError,
    ticker,
    layers,
    toggleLayer,
    legendCollapsed,
    setLegendCollapsed,
    candleTheme,
    drawMode,
    setDrawMode,
    addUserLevel,
    updateUserLevelLabel,
    removeUserLevel,
    userLevels,
    selectedLevelId,
    setSelectedLevelId,
    userTrendLines,
    userMarkers,
    selectedTrendLineId,
    selectedMarkerId,
    addUserTrendLine,
    updateUserTrendLine,
    removeUserTrendLine,
    setSelectedTrendLineId,
    addUserMarker,
    updateUserMarker,
    removeUserMarker,
    setSelectedMarkerId,
    prevDayHigh,
    prevDayLow,
    options,
    orderbook,
    selectedExpiry,
    events,
  } = useTerminalStore();

  const mainContainerRef = useRef<HTMLDivElement>(null);
  const subContainerRef = useRef<HTMLDivElement>(null);

  const mainChartRef = useRef<IChartApi | null>(null);
  const subChartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ema9SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ema21SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const vwapSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const hedgeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  const cloud921Ref = useRef<EmaCloudPrimitive | null>(null);
  const cloud2150Ref = useRef<EmaCloudPrimitive | null>(null);
  const conePrimitiveRef = useRef<ExpectedRangeConePrimitive | null>(null);
  const eventsPrimitiveRef = useRef<MacroEventsPrimitive | null>(null);
  const drawingsPrimitiveRef = useRef<UserDrawingsPrimitive | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const isSyncingRangeRef = useRef(false);
  const drawModeRef = useRef(drawMode);
  drawModeRef.current = drawMode;
  const userLevelsRef = useRef(userLevels);
  userLevelsRef.current = userLevels;
  const userTrendLinesRef = useRef(userTrendLines);
  userTrendLinesRef.current = userTrendLines;
  const userMarkersRef = useRef(userMarkers);
  userMarkersRef.current = userMarkers;
  const barTimesSecRef = useRef<number[]>([]);
  const stepSecRef = useRef<number>(Math.max(60, Math.round(TIMEFRAME_MS[timeframe] / 1000)));
  stepSecRef.current = Math.max(60, Math.round(TIMEFRAME_MS[timeframe] / 1000));
  const candlesBySecRef = useRef<Map<number, Candle>>(new Map());
  const lastScrolledDatasetRef = useRef<string>('');
  const earliestTsRef = useRef<number>(0);
  const loadingOlderRef = useRef<boolean>(false);
  const noMoreOlderRef = useRef<boolean>(false);
  const assetTfRef = useRef({ asset, timeframe });
  assetTfRef.current = { asset, timeframe };

  const [pendingAnchor, setPendingAnchor] = useState<ChartAnchorPoint | null>(null);
  const [hoverAnchor, setHoverAnchor] = useState<ChartAnchorPoint | null>(null);
  const pendingAnchorRef = useRef<ChartAnchorPoint | null>(null);
  pendingAnchorRef.current = pendingAnchor;

  const [hoveredCandle, setHoveredCandle] = useState<Candle | null>(null);
  const [subPanelMobileOpen, setSubPanelMobileOpen] = useState(true);
  const [hedgeTooltipOpen, setHedgeTooltipOpen] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Reset in-progress 2-click line when changing drawMode or asset, and support Escape to cancel
  useEffect(() => {
    if (drawMode !== 'trendline' && drawMode !== 'ray') {
      setPendingAnchor(null);
      setHoverAnchor(null);
    }
  }, [drawMode]);

  useEffect(() => {
    setPendingAnchor(null);
    setHoverAnchor(null);
  }, [asset]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pendingAnchorRef.current) {
        setPendingAnchor(null);
        setHoverAnchor(null);
      } else if (drawModeRef.current !== 'crosshair') {
        setDrawMode('crosshair');
      } else {
        setSelectedLevelId(null);
        setSelectedTrendLineId(null);
        setSelectedMarkerId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setDrawMode, setSelectedLevelId, setSelectedMarkerId, setSelectedTrendLineId]);

  useEffect(() => {
    noMoreOlderRef.current = false;
    loadingOlderRef.current = false;
  }, [asset, timeframe]);

  const spot = ticker?.idxPx ?? candles[candles.length - 1]?.c ?? 0;

  // Derived indicators
  const clouds = useMemo(() => calculateEMAClouds(candles), [candles]);
  const vwap = useMemo(() => calculateVWAP(candles), [candles]);

  // Derived options & cone calculations
  const expiryOptions = useMemo(() => {
    if (!selectedExpiry) return [];
    return options.filter((o) => o.expiry === selectedExpiry);
  }, [options, selectedExpiry]);

  const allStrikesAsc = useMemo(() => aggregateStrikes(options, spot, 'ALL'), [options, spot]);
  const allLevels = useMemo(
    () => calculateLevels(allStrikesAsc, options, spot),
    [allStrikesAsc, options, spot]
  );

  const expStrikesAsc = useMemo(
    () => aggregateStrikes(expiryOptions, spot, 'ALL'),
    [expiryOptions, spot]
  );

  const coneProjection = useMemo(() => {
    if (!selectedExpiry || expiryOptions.length === 0 || spot <= 0) return null;
    const expTs = expiryOptions[0].expTs;
    const now = Date.now();
    if (expTs <= now) return null;

    const expLevels = calculateLevels(expStrikesAsc, expiryOptions, spot);
    const atmIV = getAtTheMoneyIV(expiryOptions, spot, selectedExpiry);
    return calculateExpectedRangeCone(
      spot,
      atmIV,
      now,
      expTs,
      selectedExpiry,
      expLevels.maxPain,
      24,
      expiryOptions
    );
  }, [expStrikesAsc, expiryOptions, selectedExpiry, spot]);

  const hedgeFlowSeries = useMemo(
    () => calculateHedgeFlowSeries(candles, allLevels.netGamma),
    [candles, allLevels.netGamma]
  );

  const onePctImpact = useMemo(
    () => calculateOnePercentMoveImpact(options, spot, allLevels.netGex),
    [options, spot, allLevels.netGex]
  );

  const liquidityAnalysis = useMemo(
    () =>
      analyzeMarketLiquidity(candles, spot, allLevels, orderbook, prevDayHigh, prevDayLow),
    [candles, spot, allLevels, orderbook, prevDayHigh, prevDayLow]
  );

  // Initialize Charts once
  useEffect(() => {
    const mainEl = mainContainerRef.current;
    const subEl = subContainerRef.current;
    if (!mainEl || !subEl) return;

    const commonLayout = {
      background: { type: ColorType.Solid, color: '#0B0E11' },
      textColor: '#94A3B8',
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 11,
    };

    const mainChart = createChart(mainEl, {
      layout: commonLayout,
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.035)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.035)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(148, 163, 184, 0.35)', width: 1, style: LineStyle.Dashed },
        horzLine: { color: 'rgba(148, 163, 184, 0.35)', width: 1, style: LineStyle.Dashed },
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 48,
        barSpacing: 6.5,
      },
      autoSize: true,
    });

    const candleSeries = mainChart.addSeries(CandlestickSeries, {
      upColor: '#00E676',
      downColor: '#2997FF',
      borderVisible: false,
      wickUpColor: '#00E676',
      wickDownColor: '#2997FF',
    });

    const volumeSeries = mainChart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    mainChart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.80, bottom: 0 },
    });

    const ema9Series = mainChart.addSeries(LineSeries, {
      color: '#38BDF8',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const ema21Series = mainChart.addSeries(LineSeries, {
      color: '#F59E0B',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const vwapSeries = mainChart.addSeries(LineSeries, {
      color: '#A78BFA',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    const cloud921 = new EmaCloudPrimitive(
      'rgba(16, 185, 129, 0.34)',
      'rgba(220, 38, 38, 0.42)',
      'rgba(16, 185, 129, 0.58)',
      'rgba(239, 68, 68, 0.65)'
    );
    const cloud2150 = new EmaCloudPrimitive(
      'rgba(5, 150, 105, 0.18)',
      'rgba(153, 27, 27, 0.24)',
      'rgba(16, 185, 129, 0.28)',
      'rgba(220, 38, 38, 0.35)'
    );
    const conePrim = new ExpectedRangeConePrimitive();
    const eventsPrim = new MacroEventsPrimitive();
    const drawingsPrim = new UserDrawingsPrimitive();

    candleSeries.attachPrimitive(cloud2150);
    candleSeries.attachPrimitive(cloud921);
    candleSeries.attachPrimitive(conePrim);
    candleSeries.attachPrimitive(eventsPrim);
    candleSeries.attachPrimitive(drawingsPrim);

    // Subpanel chart: Dealer Hedge Flow (model)
    const subChart = createChart(subEl, {
      layout: commonLayout,
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.03)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.03)' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: 'rgba(148, 163, 184, 0.35)', width: 1, style: LineStyle.Dashed },
        horzLine: { color: 'rgba(148, 163, 184, 0.35)', width: 1, style: LineStyle.Dashed },
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        scaleMargins: { top: 0.14, bottom: 0.1 },
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.08)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 48,
        barSpacing: 6.5,
      },
      autoSize: true,
    });

    const hedgeSeries = subChart.addSeries(HistogramSeries, {
      priceFormat: {
        type: 'custom',
        formatter: (v: number) => {
          const abs = Math.abs(v);
          const s = v < 0 ? '-' : '';
          if (abs >= 1_000_000) return `${s}$${(abs / 1_000_000).toFixed(1)}M`;
          if (abs >= 1_000) return `${s}$${(abs / 1_000).toFixed(0)}K`;
          return `${s}$${abs.toFixed(0)}`;
        },
      },
      base: 0,
      lastValueVisible: false,
      priceLineVisible: false,
    });

    const syncRange = (source: 'main' | 'sub', range: LogicalRange | null) => {
      if (!range || isSyncingRangeRef.current) return;
      isSyncingRangeRef.current = true;
      try {
        if (source === 'main') {
          subChart.timeScale().setVisibleLogicalRange(range);
        } else {
          mainChart.timeScale().setVisibleLogicalRange(range);
        }
      } finally {
        isSyncingRangeRef.current = false;
      }

      // Infinite left-scroll historical loading
      if (
        source === 'main' &&
        range.from < 12 &&
        earliestTsRef.current > 0 &&
        !loadingOlderRef.current &&
        !noMoreOlderRef.current
      ) {
        const { asset: curAsset, timeframe: curTf } = assetTfRef.current;
        const cursor = earliestTsRef.current;
        loadingOlderRef.current = true;
        setLoadingOlder(true);

        fetchIndexCandles(curAsset, curTf, 300, cursor)
          .then((older) => {
            if (assetTfRef.current.asset !== curAsset || assetTfRef.current.timeframe !== curTf) {
              return;
            }
            const strictlyOlder = older.filter((c) => c.t < cursor);
            if (strictlyOlder.length === 0) {
              noMoreOlderRef.current = true;
            } else {
              prependCandles(strictlyOlder);
            }
          })
          .catch(() => {
            // ignore transient left-scroll errors
          })
          .finally(() => {
            loadingOlderRef.current = false;
            setLoadingOlder(false);
          });
      }
    };

    mainChart.timeScale().subscribeVisibleLogicalRangeChange((r) => syncRange('main', r));
    subChart.timeScale().subscribeVisibleLogicalRangeChange((r) => syncRange('sub', r));

    const resolveAnchorFromPoint = (point: { x: number; y: number }): ChartAnchorPoint | null => {
      const priceRaw = candleSeries.coordinateToPrice(point.y);
      if (priceRaw === null || !Number.isFinite(priceRaw) || priceRaw <= 0) return null;
      const price = Number(priceRaw.toFixed(2));

      const ts = mainChart.timeScale();
      const directTime = ts.coordinateToTime(point.x);
      if (typeof directTime === 'number' && Number.isFinite(directTime)) {
        return { timeSec: Math.round(directTime), price };
      }

      // Future Prediction Cone zone (to the right of the last candle) or gap interpolation
      const logical = ts.coordinateToLogical(point.x);
      if (logical === null || !Number.isFinite(logical)) return null;
      const projectedSec = projectTimeSecFromLogical(
        logical,
        barTimesSecRef.current,
        stepSecRef.current
      );
      if (projectedSec === null) return null;
      return { timeSec: projectedSec, price };
    };

    mainChart.subscribeCrosshairMove((param) => {
      if (param.time && typeof param.time === 'number') {
        const found = candlesBySecRef.current.get(param.time) ?? null;
        setHoveredCandle(found);
      } else {
        setHoveredCandle(null);
      }

      if (
        (drawModeRef.current === 'trendline' || drawModeRef.current === 'ray') &&
        pendingAnchorRef.current &&
        param.point
      ) {
        const hoverPt = resolveAnchorFromPoint(param.point);
        if (hoverPt) {
          setHoverAnchor(hoverPt);
        }
      }
    });

    // Click handler: place horizontal level / marker / 2-click trendline or select existing drawing
    mainChart.subscribeClick((param) => {
      if (!param.point) return;
      const mode = drawModeRef.current;

      if (mode === 'horizontal') {
        const price = candleSeries.coordinateToPrice(param.point.y);
        if (price !== null && Number.isFinite(price) && price > 0) {
          addUserLevel(Number(price.toFixed(2)));
        }
        return;
      }

      if (mode === 'marker') {
        const pt = resolveAnchorFromPoint(param.point);
        if (pt) {
          addUserMarker(pt, 'Seg. Cono', '#FACC15');
        }
        return;
      }

      if (mode === 'trendline' || mode === 'ray') {
        const pt = resolveAnchorFromPoint(param.point);
        if (!pt) return;
        if (!pendingAnchorRef.current) {
          setPendingAnchor(pt);
          setHoverAnchor(pt);
        } else {
          const startPt = pendingAnchorRef.current;
          setPendingAnchor(null);
          setHoverAnchor(null);
          addUserTrendLine(
            mode === 'ray' ? 'ray' : 'segment',
            startPt,
            pt,
            mode === 'ray' ? '#A78BFA' : '#38BDF8'
          );
        }
        return;
      }

      // Selection hit-testing in 'crosshair' mode (priority: Markers -> TrendLines -> Levels)
      const px = param.point.x;
      const py = param.point.y;

      let hitMarkerId: string | null = null;
      let bestMarkerDist = 16;
      for (const mk of userMarkersRef.current) {
        const screen = drawingsPrim.pointToScreen({ timeSec: mk.timeSec, price: mk.price });
        if (!screen) continue;
        const d = Math.hypot(px - screen.x, py - screen.y);
        if (d < bestMarkerDist) {
          bestMarkerDist = d;
          hitMarkerId = mk.id;
        }
      }
      if (hitMarkerId) {
        setSelectedMarkerId(hitMarkerId);
        return;
      }

      const paneW = mainEl.clientWidth || 1200;
      const paneH = mainEl.clientHeight || 600;
      let hitLineId: string | null = null;
      let bestLineDist = 10;
      for (const tl of userTrendLinesRef.current) {
        const s1 = drawingsPrim.pointToScreen(tl.p1);
        const s2 = drawingsPrim.pointToScreen(tl.p2);
        if (!s1 || !s2) continue;
        const d =
          tl.kind === 'ray'
            ? distanceToRayPx(px, py, s1.x, s1.y, s2.x, s2.y, paneW, paneH)
            : distanceToSegmentPx(px, py, s1.x, s1.y, s2.x, s2.y);
        if (d < bestLineDist) {
          bestLineDist = d;
          hitLineId = tl.id;
        }
      }
      if (hitLineId) {
        setSelectedTrendLineId(hitLineId);
        return;
      }

      // Check proximity to an existing user-drawn horizontal level (within 10px)
      let closestId: string | null = null;
      let bestDist = 11;
      for (const lvl of userLevelsRef.current) {
        const ly = candleSeries.priceToCoordinate(lvl.price);
        if (ly === null) continue;
        const d = Math.abs(ly - py);
        if (d < bestDist) {
          bestDist = d;
          closestId = lvl.id;
        }
      }
      setSelectedLevelId(closestId);
    });

    mainChartRef.current = mainChart;
    subChartRef.current = subChart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;
    ema9SeriesRef.current = ema9Series;
    ema21SeriesRef.current = ema21Series;
    vwapSeriesRef.current = vwapSeries;
    hedgeSeriesRef.current = hedgeSeries;
    cloud921Ref.current = cloud921;
    cloud2150Ref.current = cloud2150;
    conePrimitiveRef.current = conePrim;
    eventsPrimitiveRef.current = eventsPrim;
    drawingsPrimitiveRef.current = drawingsPrim;

    return () => {
      mainChart.remove();
      subChart.remove();
      mainChartRef.current = null;
      subChartRef.current = null;
    };
  }, [
    addUserLevel,
    addUserMarker,
    addUserTrendLine,
    prependCandles,
    setSelectedLevelId,
    setSelectedMarkerId,
    setSelectedTrendLineId,
  ]);

  // Apply candle palette theme dynamically
  useEffect(() => {
    const cs = candleSeriesRef.current;
    if (!cs) return;
    if (candleTheme === 'photo') {
      cs.applyOptions({
        upColor: '#00E676',
        downColor: '#2997FF',
        wickUpColor: '#00E676',
        wickDownColor: '#2997FF',
      });
    } else {
      cs.applyOptions({
        upColor: '#22C55E',
        downColor: '#EF4444',
        wickUpColor: '#22C55E',
        wickDownColor: '#EF4444',
      });
    }
  }, [candleTheme]);

  // Update Candles, Indicators, Clouds, Volume, and Hedge Flow Data
  useEffect(() => {
    const cs = candleSeriesRef.current;
    const vs = volumeSeriesRef.current;
    const e9 = ema9SeriesRef.current;
    const e21 = ema21SeriesRef.current;
    const vw = vwapSeriesRef.current;
    const hs = hedgeSeriesRef.current;
    if (!cs || !vs || !e9 || !e21 || !vw || !hs) return;

    const map = new Map<number, Candle>();
    const barTimesSec: number[] = [];
    for (const c of candles) {
      const sec = Math.floor(c.t / 1000);
      map.set(sec, c);
      barTimesSec.push(sec);
    }
    candlesBySecRef.current = map;
    barTimesSecRef.current = barTimesSec;
    earliestTsRef.current = candles[0]?.t ?? 0;

    if (candles.length === 0) {
      cs.setData([]);
      vs.setData([]);
      e9.setData([]);
      e21.setData([]);
      vw.setData([]);
      hs.setData([]);
      cloud921Ref.current?.setData([], false);
      cloud2150Ref.current?.setData([], false);
      return;
    }

    cs.setData(
      candles.map((c) => ({
        time: (c.t / 1000) as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      }))
    );

    vs.applyOptions({ visible: layers.volume });
    vs.setData(
      candles.map((c) => ({
        time: (c.t / 1000) as UTCTimestamp,
        value: c.v,
        color: c.c >= c.o ? 'rgba(16, 185, 129, 0.35)' : 'rgba(220, 38, 38, 0.35)',
      }))
    );

    e9.applyOptions({ visible: layers.ema9 });
    e9.setData(
      candles
        .map((c, i) =>
          clouds.ema9[i] !== null
            ? { time: (c.t / 1000) as UTCTimestamp, value: clouds.ema9[i]! }
            : null
        )
        .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
    );

    e21.applyOptions({ visible: layers.ema21 });
    e21.setData(
      candles
        .map((c, i) =>
          clouds.ema21[i] !== null
            ? { time: (c.t / 1000) as UTCTimestamp, value: clouds.ema21[i]! }
            : null
        )
        .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
    );

    vw.applyOptions({ visible: layers.vwap });
    vw.setData(
      candles
        .map((c, i) =>
          vwap[i] !== null ? { time: (c.t / 1000) as UTCTimestamp, value: vwap[i]! } : null
        )
        .filter((x): x is { time: UTCTimestamp; value: number } => x !== null)
    );

    const cloud921Pts = candles
      .map((c, i) =>
        clouds.ema9[i] !== null && clouds.ema21[i] !== null
          ? { time: (c.t / 1000) as UTCTimestamp, fast: clouds.ema9[i]!, slow: clouds.ema21[i]! }
          : null
      )
      .filter((x): x is { time: UTCTimestamp; fast: number; slow: number } => x !== null);
    cloud921Ref.current?.setData(cloud921Pts, layers.emaClouds);

    const cloud2150Pts = candles
      .map((c, i) =>
        clouds.ema21[i] !== null && clouds.ema50[i] !== null
          ? { time: (c.t / 1000) as UTCTimestamp, fast: clouds.ema21[i]!, slow: clouds.ema50[i]! }
          : null
      )
      .filter((x): x is { time: UTCTimestamp; fast: number; slow: number } => x !== null);
    cloud2150Ref.current?.setData(cloud2150Pts, layers.emaClouds);

    hs.setData(
      hedgeFlowSeries.map((pt) => ({
        time: (pt.t / 1000) as UTCTimestamp,
        value: pt.flowUsd,
        color: pt.flowUsd >= 0 ? 'rgba(16, 185, 129, 0.85)' : 'rgba(239, 68, 68, 0.85)',
      }))
    );

    if (candlesDatasetKey && lastScrolledDatasetRef.current !== candlesDatasetKey) {
      lastScrolledDatasetRef.current = candlesDatasetKey;
      mainChartRef.current?.timeScale().applyOptions({ rightOffset: 48, barSpacing: 6.5 });
      mainChartRef.current?.timeScale().scrollToRealTime();
      subChartRef.current?.timeScale().applyOptions({ rightOffset: 48, barSpacing: 6.5 });
      subChartRef.current?.timeScale().scrollToRealTime();
    }
  }, [candlesDatasetKey, candles, clouds, vwap, layers, hedgeFlowSeries]);

  // Update Cone Primitive
  useEffect(() => {
    const strikesForCone = expStrikesAsc.length > 0 ? expStrikesAsc : allStrikesAsc;
    const lastCandle = candles[candles.length - 1];
    const lastBarTime = lastCandle ? ((lastCandle.t / 1000) as UTCTimestamp) : null;
    conePrimitiveRef.current?.setData(
      coneProjection,
      strikesForCone,
      expiryOptions,
      Math.max(0, candles.length - 1),
      lastBarTime,
      layers.cone
    );
  }, [coneProjection, expStrikesAsc, allStrikesAsc, expiryOptions, candles, layers.cone]);

  // Update Macro Event Badges Primitive
  useEffect(() => {
    if (!eventsPrimitiveRef.current || candles.length === 0) return;
    const minT = candles[0].t;
    const maxT = candles[candles.length - 1].t;
    const now = Date.now();
    const badges: ChartEventBadge[] = [];

    for (const evt of events) {
      if (evt.ts > now || evt.ts < minT || evt.ts > maxT) continue;
      let nearest = candles[0].t;
      let bestDiff = Infinity;
      for (const c of candles) {
        const d = Math.abs(c.t - evt.ts);
        if (d < bestDiff) {
          bestDiff = d;
          nearest = c.t;
        }
      }
      badges.push({
        id: evt.id,
        time: (nearest / 1000) as UTCTimestamp,
        name: evt.name,
      });
    }

    eventsPrimitiveRef.current.setData(badges, layers.events);
  }, [events, candles, layers.events]);

  // Update User TrendLines & Prediction Cone Markers Primitive
  useEffect(() => {
    const prim = drawingsPrimitiveRef.current;
    if (!prim) return;
    const barTimesSec = candles.map((c) => Math.floor(c.t / 1000));
    const stepSec = Math.max(60, Math.round(TIMEFRAME_MS[timeframe] / 1000));
    const previewLine: PreviewTrendLine | null =
      pendingAnchor && hoverAnchor && (drawMode === 'trendline' || drawMode === 'ray')
        ? {
            kind: drawMode === 'ray' ? 'ray' : 'segment',
            p1: pendingAnchor,
            p2: hoverAnchor,
            color: drawMode === 'ray' ? '#A78BFA' : '#38BDF8',
          }
        : null;

    prim.setData({
      trendLines: userTrendLines,
      markers: userMarkers,
      previewLine,
      selectedTrendLineId,
      selectedMarkerId,
      barTimesSec,
      stepSec,
      visible: layers.levels,
    });
  }, [
    candles,
    timeframe,
    userTrendLines,
    userMarkers,
    pendingAnchor,
    hoverAnchor,
    drawMode,
    selectedTrendLineId,
    selectedMarkerId,
    layers.levels,
  ]);

  // Update Horizontal Price Lines (PDH, PDL, User Levels, and Option Walls/Flip)
  useEffect(() => {
    const cs = candleSeriesRef.current;
    if (!cs) return;

    for (const pl of priceLinesRef.current) {
      cs.removePriceLine(pl);
    }
    priceLinesRef.current = [];

    if (layers.levels) {
      if (prevDayHigh !== null) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: prevDayHigh,
            color: '#D97706',
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'PDH',
          })
        );
      }

      if (prevDayLow !== null) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: prevDayLow,
            color: '#94A3B8',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'PDL',
          })
        );
      }

      for (const lvl of userLevels) {
        const isActive = lvl.id === selectedLevelId;
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: lvl.price,
            color: '#FACC15',
            lineWidth: isActive ? 2 : 1,
            lineStyle: isActive ? LineStyle.Solid : LineStyle.Dashed,
            axisLabelVisible: true,
            title: lvl.label || 'L',
          })
        );
      }
    }

    if (layers.optionLevels && options.length > 0 && spot > 0) {
      if (allLevels.flip !== null) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: allLevels.flip,
            color: 'rgba(250, 204, 21, 0.75)',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Flip (modelo)',
          })
        );
      }
      if (allLevels.callWall > 0) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: allLevels.callWall,
            color: 'rgba(0, 230, 118, 0.65)',
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'CW (modelo)',
          })
        );
      }
      if (allLevels.putWall > 0) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: allLevels.putWall,
            color: 'rgba(239, 68, 68, 0.65)',
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'PW (modelo)',
          })
        );
      }
    }

    if (layers.liquidityLevels && spot > 0) {
      if (liquidityAnalysis.strongestAskWall) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: liquidityAnalysis.strongestAskWall.price,
            color: 'rgba(244, 63, 94, 0.55)',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Ask Wall OKX',
          })
        );
      }
      if (liquidityAnalysis.strongestBidWall) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: liquidityAnalysis.strongestBidWall.price,
            color: 'rgba(16, 185, 129, 0.55)',
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: 'Bid Wall OKX',
          })
        );
      }
      if (liquidityAnalysis.nearestBSL) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: liquidityAnalysis.nearestBSL.price,
            color: 'rgba(251, 146, 60, 0.65)',
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'BSL',
          })
        );
      }
      if (liquidityAnalysis.nearestSSL) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: liquidityAnalysis.nearestSSL.price,
            color: 'rgba(45, 212, 191, 0.65)',
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'SSL',
          })
        );
      }
      if (liquidityAnalysis.pocPrice !== null) {
        priceLinesRef.current.push(
          cs.createPriceLine({
            price: liquidityAnalysis.pocPrice,
            color: 'rgba(56, 189, 248, 0.6)',
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'POC Vol',
          })
        );
      }
    }
  }, [
    layers.levels,
    layers.optionLevels,
    layers.liquidityLevels,
    prevDayHigh,
    prevDayLow,
    userLevels,
    selectedLevelId,
    options.length,
    spot,
    allLevels.flip,
    allLevels.callWall,
    allLevels.putWall,
    liquidityAnalysis.strongestAskWall,
    liquidityAnalysis.strongestBidWall,
    liquidityAnalysis.nearestBSL,
    liquidityAnalysis.nearestSSL,
    liquidityAnalysis.pocPrice,
  ]);

  const activeBar = hoveredCandle ?? candles[candles.length - 1] ?? null;
  const barChange = activeBar ? activeBar.c - activeBar.o : 0;
  const barChangePct = activeBar && activeBar.o > 0 ? (barChange / activeBar.o) * 100 : 0;
  const latestCandle = candles[candles.length - 1] ?? null;
  const countdownStr = latestCandle
    ? formatBarCountdown(latestCandle.t, TIMEFRAME_MS[timeframe], nowMs)
    : '—';

  const latestHedgeUsd = hedgeFlowSeries[hedgeFlowSeries.length - 1]?.flowUsd ?? 0;
  const selectedUserLevel = userLevels.find((l) => l.id === selectedLevelId) ?? null;
  const selectedTrendLine = userTrendLines.find((tl) => tl.id === selectedTrendLineId) ?? null;
  const selectedMarker = userMarkers.find((mk) => mk.id === selectedMarkerId) ?? null;

  const legendItems: {
    key: keyof typeof layers;
    label: string;
    extra?: string;
    extraColor?: string;
  }[] = [
    { key: 'vwap', label: 'VWAP', extra: '00 UTC', extraColor: 'text-purple-300' },
    { key: 'ema9', label: 'EMA 9', extraColor: 'text-sky-400' },
    { key: 'ema21', label: 'EMA 21', extraColor: 'text-amber-400' },
    {
      key: 'emaClouds',
      label: 'EM Clouds',
      extra: clouds.primaryState,
      extraColor: clouds.primaryState === 'Up' ? 'text-emerald-400' : 'text-rose-400',
    },
    { key: 'cone', label: 'Expected range (modelo)' },
    { key: 'optionLevels', label: 'Muros opciones (modelo)' },
    { key: 'liquidityLevels', label: 'Liquidez (Book/BSL/SSL)' },
    { key: 'volume', label: 'Volumen' },
    { key: 'levels', label: 'Niveles y dibujos' },
    { key: 'events', label: 'Economic events' },
  ];

  const isDampen = onePctImpact.regime === 'dampen';

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0 bg-[#0B0E11]">
      {/* Quick Timeframe Bar at the Top of the Chart */}
      <div className="flex items-center justify-between gap-2 px-3 py-1 bg-[#111621]/90 border-b border-white/[0.06] shrink-0">
        <div className="flex items-center gap-2 overflow-x-auto">
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-400 whitespace-nowrap">
            <Clock className="w-3 h-3 text-slate-500" />
            <span className="hidden sm:inline">Temporalidad</span>
          </span>
          <div className="flex items-center gap-0.5 bg-[#0B0E11] p-0.5 rounded border border-white/[0.08]">
            {QUICK_TIMEFRAMES.map((tf) => {
              const active = timeframe === tf.value;
              return (
                <button
                  key={tf.value}
                  type="button"
                  onClick={() => setTimeframe(tf.value)}
                  className={`px-2 py-0.5 text-[11px] font-mono-tabular font-semibold rounded transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-[#3B82F6] text-white'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-white/[0.05]'
                  }`}
                >
                  {tf.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex items-center gap-2 text-[11px] font-mono-tabular shrink-0">
          {candlesLoading ? (
            <span className="inline-flex items-center gap-1.5 text-sky-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Actualizando OKX...</span>
            </span>
          ) : (
            <span className="text-slate-500 hidden sm:inline">
              {asset}-USD · {candles.length} velas
            </span>
          )}
        </div>
      </div>

      {/* Main Chart Container */}
      <div className="relative flex-1 min-h-[340px] lg:min-h-0">
        {candlesError && candles.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0B0E11]/90 p-6">
            <div className="text-center max-w-sm space-y-2">
              <p className="text-sm font-medium text-rose-400">
                No se pudieron cargar las velas de OKX
              </p>
              <p className="text-xs text-slate-400">{candlesError}</p>
            </div>
          </div>
        )}

        {drawMode !== 'crosshair' && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 px-3 py-1 bg-[#161D2B]/95 border border-white/[0.15] text-slate-100 text-xs font-medium rounded shadow-lg pointer-events-none flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                drawMode === 'horizontal'
                  ? 'bg-amber-400'
                  : drawMode === 'trendline'
                  ? 'bg-sky-400'
                  : drawMode === 'ray'
                  ? 'bg-violet-400'
                  : 'bg-emerald-400'
              }`}
            />
            <span>
              {drawMode === 'horizontal' && 'Haz clic en el gráfico para fijar un nivel horizontal'}
              {drawMode === 'marker' &&
                'Haz clic sobre velas o dentro del Cono para dejar una marca de seguimiento'}
              {(drawMode === 'trendline' || drawMode === 'ray') &&
                (!pendingAnchor
                  ? `Clic 1: punto de origen de ${drawMode === 'ray' ? 'rayo' : 'línea'} (Esc cancelar)`
                  : `Clic 2: punto destino (puedes fijarlo dentro del Cono · Esc cancelar)`)}
            </span>
          </div>
        )}

        {loadingOlder && (
          <div className="absolute top-2 right-16 z-20 px-2.5 py-1 bg-[#12161E]/90 border border-white/[0.1] rounded text-[11px] text-slate-300 pointer-events-none">
            Cargando histórico...
          </div>
        )}

        {/* Selected User Level Inline Editor */}
        {selectedUserLevel && (
          <div className="absolute bottom-14 left-3 z-20 flex items-center gap-2 px-2.5 py-1.5 bg-[#12161E]/95 border border-[#FACC15]/40 rounded-md shadow-xl text-xs">
            <span className="font-mono-tabular text-[#FACC15] font-semibold">
              ${selectedUserLevel.price.toLocaleString('en-US')}
            </span>
            <input
              type="text"
              placeholder="Etiqueta..."
              value={selectedUserLevel.label ?? ''}
              onChange={(e) => updateUserLevelLabel(selectedUserLevel.id, e.target.value)}
              className="w-28 bg-[#0B0E11] border border-white/[0.12] rounded px-1.5 py-0.5 text-xs text-slate-200 focus:outline-none focus:border-[#FACC15]"
            />
            <button
              type="button"
              onClick={() => removeUserLevel(selectedUserLevel.id)}
              className="text-rose-400 hover:text-rose-300 p-0.5"
              title="Eliminar nivel"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setSelectedLevelId(null)}
              className="text-slate-400 hover:text-white p-0.5"
              title="Cerrar"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Selected Trendline / Ray Inline Editor */}
        {selectedTrendLine && (
          <div className="absolute bottom-14 left-3 z-20 flex flex-wrap items-center gap-2 px-3 py-2 bg-[#12161E]/95 border border-sky-400/40 rounded-md shadow-xl text-xs max-w-[92vw]">
            <span className="font-mono-tabular font-semibold text-sky-300 whitespace-nowrap">
              {selectedTrendLine.kind === 'ray' ? 'Rayo' : 'Línea'} · $
              {selectedTrendLine.p1.price.toLocaleString('en-US')} → $
              {selectedTrendLine.p2.price.toLocaleString('en-US')}
            </span>
            <input
              type="text"
              placeholder="Etiqueta (ej. Directriz Cono)..."
              value={selectedTrendLine.label ?? ''}
              onChange={(e) =>
                updateUserTrendLine(selectedTrendLine.id, { label: e.target.value })
              }
              className="w-36 bg-[#0B0E11] border border-white/[0.12] rounded px-2 py-0.5 text-xs text-slate-200 focus:outline-none focus:border-sky-400"
            />
            <div className="flex items-center gap-1">
              {DRAWING_COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => updateUserTrendLine(selectedTrendLine.id, { color: swatch })}
                  className={`w-4 h-4 rounded-full border transition-transform ${
                    selectedTrendLine.color === swatch
                      ? 'border-white scale-110'
                      : 'border-white/20 hover:scale-105'
                  }`}
                  style={{ backgroundColor: swatch }}
                  title={`Color ${swatch}`}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => removeUserTrendLine(selectedTrendLine.id)}
              className="text-rose-400 hover:text-rose-300 p-0.5"
              title="Eliminar línea"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setSelectedTrendLineId(null)}
              className="text-slate-400 hover:text-white p-0.5"
              title="Cerrar"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Selected Prediction Cone Marker Inline Editor */}
        {selectedMarker && (
          <div className="absolute bottom-14 left-3 z-20 flex flex-col gap-2 px-3 py-2.5 bg-[#12161E]/95 border border-emerald-400/40 rounded-md shadow-xl text-xs max-w-[92vw]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 font-mono-tabular">
                <span className="font-semibold text-amber-300">
                  ${selectedMarker.price.toLocaleString('en-US')}
                </span>
                <span className="text-slate-400 text-[11px]">
                  · {formatMarkerTime(selectedMarker.timeSec)}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => removeUserMarker(selectedMarker.id)}
                  className="text-rose-400 hover:text-rose-300 p-0.5"
                  title="Eliminar marca"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMarkerId(null)}
                  className="text-slate-400 hover:text-white p-0.5"
                  title="Cerrar"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                placeholder="Etiqueta de seguimiento..."
                value={selectedMarker.label}
                onChange={(e) => updateUserMarker(selectedMarker.id, { label: e.target.value })}
                className="w-36 bg-[#0B0E11] border border-white/[0.12] rounded px-2 py-0.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-400"
              />
              <div className="flex items-center gap-1">
                {MARKER_QUICK_TAGS.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => updateUserMarker(selectedMarker.id, { label: tag })}
                    className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                      selectedMarker.label === tag
                        ? 'bg-white/15 border-white/30 text-white'
                        : 'bg-[#0B0E11] border-white/[0.08] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                {(
                  [
                    { id: 'pendiente', label: 'Pendiente', Icon: Clock, activeCls: 'bg-amber-500/20 border-amber-400 text-amber-300' },
                    { id: 'cumplido', label: 'Cumplido', Icon: CheckCircle2, activeCls: 'bg-emerald-500/20 border-emerald-400 text-emerald-300' },
                    { id: 'invalidado', label: 'Invalidado', Icon: XCircle, activeCls: 'bg-rose-500/20 border-rose-400 text-rose-300' },
                  ] as {
                    id: MarkerFollowStatus;
                    label: string;
                    Icon: typeof Clock;
                    activeCls: string;
                  }[]
                ).map(({ id, label, Icon, activeCls }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => updateUserMarker(selectedMarker.id, { status: id })}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium transition-colors ${
                      selectedMarker.status === id
                        ? activeCls
                        : 'bg-[#0B0E11] border-white/[0.08] text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <Icon className="w-3 h-3" />
                    <span>{label}</span>
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-1">
                {DRAWING_COLOR_SWATCHES.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    onClick={() => updateUserMarker(selectedMarker.id, { color: swatch })}
                    className={`w-4 h-4 rounded-full border transition-transform ${
                      selectedMarker.color === swatch
                        ? 'border-white scale-110'
                        : 'border-white/20 hover:scale-105'
                    }`}
                    style={{ backgroundColor: swatch }}
                    title={`Color ${swatch}`}
                  />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Top-Left Floating OHLCV Readout + Clean Unboxed Layer Legend */}
        <div className="absolute top-2 left-3 z-10 select-none pointer-events-auto">
          {activeBar && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono-tabular mb-1 pointer-events-none">
              <span className="text-slate-400">
                O{' '}
                <span className={barChange >= 0 ? 'text-[#00E676]' : 'text-[#2997FF]'}>
                  {activeBar.o.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
              </span>
              <span className="text-slate-400">
                H{' '}
                <span className={barChange >= 0 ? 'text-[#00E676]' : 'text-[#2997FF]'}>
                  {activeBar.h.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
              </span>
              <span className="text-slate-400">
                L{' '}
                <span className={barChange >= 0 ? 'text-[#00E676]' : 'text-[#2997FF]'}>
                  {activeBar.l.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
              </span>
              <span className="text-slate-400">
                C{' '}
                <span className={barChange >= 0 ? 'text-[#00E676]' : 'text-[#2997FF]'}>
                  {activeBar.c.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
              </span>
              <span className={barChange >= 0 ? 'text-[#00E676]' : 'text-rose-400'}>
                {barChange >= 0 ? '+' : ''}
                {barChange.toFixed(1)} ({barChangePct >= 0 ? '+' : ''}
                {barChangePct.toFixed(2)}%)
              </span>
              <span className="text-slate-400">
                Vol <span className="text-slate-200">{activeBar.v.toFixed(2)}</span>
              </span>
              <span className="text-slate-500">· Cierre vela {countdownStr}</span>
            </div>
          )}

          <div className="flex flex-col items-start gap-0.5 text-[11px]">
            {!legendCollapsed &&
              legendItems.map((item) => {
                const active = layers[item.key];
                return (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => toggleLayer(item.key)}
                    className={`flex items-center gap-2 py-0.5 px-1 rounded transition-colors hover:bg-white/[0.06] ${
                      active ? 'text-slate-300' : 'text-slate-600 line-through'
                    }`}
                  >
                    <span
                      className={
                        item.key === 'emaClouds' && active ? 'text-[#00E676] font-medium' : ''
                      }
                    >
                      {item.label}
                    </span>
                    {item.extra && active && (
                      <span className={`font-medium ${item.extraColor || 'text-slate-400'}`}>
                        {item.extra}
                      </span>
                    )}
                  </button>
                );
              })}

            <button
              type="button"
              onClick={() => setLegendCollapsed(!legendCollapsed)}
              className="mt-0.5 p-0.5 text-slate-400 hover:text-white rounded hover:bg-white/[0.06]"
              title={legendCollapsed ? 'Mostrar leyenda de capas' : 'Plegar leyenda'}
            >
              {legendCollapsed ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>

        <div
          ref={mainContainerRef}
          className={`w-full h-full ${drawMode !== 'crosshair' ? 'cursor-crosshair' : ''}`}
        />
      </div>

      {/* Dealer Hedge Flow Subpanel (modelo) + Cone Footer */}
      <div
        className={
          mainChartOnly
            ? 'hidden'
            : 'border-t border-white/[0.08] bg-[#0B0E11] flex flex-col shrink-0'
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1 bg-[#12161E]/70 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSubPanelMobileOpen((v) => !v)}
              className="lg:hidden text-slate-400 hover:text-white"
              aria-label="Desplegar Dealer Hedge Flow"
            >
              {subPanelMobileOpen ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5" />
              )}
            </button>
            <span className="text-[11px] font-medium text-slate-300">
              Dealer Hedge Flow (modelo)
            </span>
            <span
              className={`text-[11px] font-mono-tabular ${
                latestHedgeUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {latestHedgeUsd >= 0 ? '+' : '-'}
              {formatUsdCompact(latestHedgeUsd)}
            </span>
            <div className="relative">
              <button
                type="button"
                onClick={() => setHedgeTooltipOpen((v) => !v)}
                onMouseEnter={() => setHedgeTooltipOpen(true)}
                onMouseLeave={() => setHedgeTooltipOpen(false)}
                className="text-slate-400 hover:text-slate-200 p-0.5"
                aria-label="Información del modelo Dealer Hedge Flow"
              >
                <Info className="w-3 h-3" />
              </button>
              {hedgeTooltipOpen && (
                <div className="absolute left-0 bottom-6 w-72 p-2.5 bg-[#161D2B] border border-white/[0.12] rounded-md shadow-xl text-[11px] text-slate-300 z-30 leading-relaxed">
                  Calcula H = −Γ_net · ΔS usando el OI actual de la cadena para toda la serie
                  visible, porque OKX no entrega histórico gratuito de OI. Es un modelo teórico, no
                  una señal.
                </div>
              )}
            </div>
          </div>

          <div className="text-[11px] font-mono-tabular flex flex-wrap items-center gap-2">
            <span className={isDampen ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
              {isDampen ? 'Dealers dampen moves' : 'Dealers chase'}
            </span>
            <span className="text-slate-300">
              −1 %: {onePctImpact.down1PctUsd >= 0 ? 'compra' : 'vende'} ≈{' '}
              {formatUsdCompact(onePctImpact.down1PctUsd)}
            </span>
            <span className="text-slate-300">
              +1 %: {onePctImpact.up1PctUsd >= 0 ? 'compra' : 'vende'} ≈{' '}
              {formatUsdCompact(onePctImpact.up1PctUsd)}
            </span>
            <span className="text-slate-500">(modelo)</span>
          </div>
        </div>

        <div
          className={`${
            subPanelMobileOpen ? 'h-28 sm:h-32' : 'h-0 overflow-hidden'
          } lg:h-32 w-full relative`}
        >
          <div ref={subContainerRef} className="w-full h-full" />
        </div>

        {/* Fixed Cone Caption Footer */}
        <div className="px-3 py-1 bg-[#12161E] border-t border-white/[0.06] text-[11px] text-slate-400 flex flex-wrap items-center justify-between gap-2">
          <span>
            {selectedExpiry
              ? `Rango esperado hasta ${selectedExpiry} (modelo). Sombreado: rango con skew de opciones. Línea: max pain.`
              : 'Rango esperado hasta vencimiento (modelo). Sombreado: rango que descuentan las opciones. Línea: max pain.'}
          </span>
          {coneProjection && (
            <span className="font-mono-tabular text-slate-300">
              IV ↑{(coneProjection.upsideIV * 100).toFixed(1)}% / ↓
              {(coneProjection.downsideIV * 100).toFixed(1)}% · Max Pain: $
              {coneProjection.maxPain.toLocaleString('en-US')} (modelo)
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
