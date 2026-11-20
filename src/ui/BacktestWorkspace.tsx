import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LogicalRange,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { AlertTriangle, ArrowUpDown, Download, Grid3X3, History, Play, Trash2 } from 'lucide-react';
import type { SensitivityGridResult } from '../calc/backtest';
import { fetchHistoryCandlesPaginated } from '../data/okxMarketClient';
import type {
  BacktestMetrics,
  BacktestOrder,
  BacktestOutput,
  BacktestParams,
  BacktestTrade,
  Candle,
  SavedBacktestRun,
  StrategyTemplate,
  Timeframe,
} from '../types/market';

const HISTORY_STORAGE_KEY = 'wterm_backtests_v1';

const TEMPLATE_OPTIONS: { value: StrategyTemplate; label: string; desc: string }[] = [
  {
    value: 'ema_cross',
    label: 'Cruce de EMA',
    desc: 'Largo cuando EMA rápida cruza sobre lenta; sale en el cruce inverso.',
  },
  {
    value: 'momentum',
    label: 'Momentum',
    desc: 'Largo si el cambio de precio a N barras es positivo.',
  },
  {
    value: 'rsi_reversion',
    label: 'Reversión RSI',
    desc: 'Largo si RSI < umbral entrada, sale si RSI > umbral salida; corto simétrico opcional.',
  },
  {
    value: 'bollinger_breakout',
    label: 'Ruptura Bollinger',
    desc: 'Largo si el cierre supera la banda superior; sale bajo la media.',
  },
  {
    value: 'ema_cloud',
    label: 'Nube EMA',
    desc: 'Largo si el cierre está sobre la nube 9/21 y la nube es verde.',
  },
];

function getDefaultDates() {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

function loadSavedRuns(): SavedBacktestRun[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedBacktestRun[]) : [];
  } catch {
    return [];
  }
}

function saveRuns(runs: SavedBacktestRun[]) {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(runs.slice(0, 10)));
  } catch {
    // ignore
  }
}

function exportCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const csv = [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type DetailTab = 'Total' | 'Orders' | 'Trades' | 'Sensibilidad' | 'Historial';
type ChartViewMode = 'equity' | 'candles';

export function BacktestWorkspace() {
  const defaults = useMemo(() => getDefaultDates(), []);

  const [params, setParams] = useState<BacktestParams>({
    template: 'ema_cross',
    instId: 'BTC-USDT-SWAP',
    timeframe: '1H',
    startDate: defaults.startDate,
    endDate: defaults.endDate,
    initialCapital: 10000,
    positionSizePct: 100,
    commissionPct: 0.05,
    slippagePct: 0.02,
    stopPct: null,
    targetR: null,
    emaFast: 9,
    emaSlow: 21,
    momentumBars: 10,
    rsiPeriod: 14,
    rsiOversold: 30,
    rsiExit: 50,
    rsiShortSymmetric: false,
    bbPeriod: 20,
    bbStdDev: 2,
  });

  const [candles, setCandles] = useState<Candle[]>([]);
  const [loadedDatasetKey, setLoadedDatasetKey] = useState<string>('');
  const [loadingProgress, setLoadingProgress] = useState<{ pct: number; count: number } | null>(
    null
  );
  const [runningWorker, setRunningWorker] = useState(false);
  const [runningSweep, setRunningSweep] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestOutput | null>(null);
  const [sweepGrid, setSweepGrid] = useState<SensitivityGridResult | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('Total');
  const [chartViewMode, setChartViewMode] = useState<ChartViewMode>('equity');
  const [savedRuns, setSavedRuns] = useState<SavedBacktestRun[]>(() => loadSavedRuns());

  // Sort state for Orders & Trades tables
  const [orderSort, setOrderSort] = useState<{ key: keyof BacktestOrder; asc: boolean }>({
    key: 'ts',
    asc: false,
  });
  const [tradeSort, setTradeSort] = useState<{ key: keyof BacktestTrade; asc: boolean }>({
    key: 'exitTs',
    asc: false,
  });

  const eqContainerRef = useRef<HTMLDivElement>(null);
  const ddContainerRef = useRef<HTMLDivElement>(null);
  const candleContainerRef = useRef<HTMLDivElement>(null);
  const eqChartRef = useRef<IChartApi | null>(null);
  const ddChartRef = useRef<IChartApi | null>(null);
  const candleChartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const candleMarkersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const eqSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const benchSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ddSeriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pendingHistoryRunRef = useRef<{ record: boolean; params: BacktestParams } | null>(null);

  const datasetKey = `${params.instId}|${params.timeframe}|${params.startDate}|${params.endDate}`;

  // Initialize Web Worker
  useEffect(() => {
    const worker = new Worker(new URL('../calc/backtest.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (
      ev: MessageEvent<
        | { kind: 'run'; result: BacktestOutput }
        | { kind: 'sweep'; grid: SensitivityGridResult }
      >
    ) => {
      if (ev.data.kind === 'sweep') {
        setSweepGrid(ev.data.grid);
        setRunningSweep(false);
        return;
      }
      if (ev.data.kind === 'run') {
        const out = ev.data.result;
        setResult(out);
        setRunningWorker(false);

        const pending = pendingHistoryRunRef.current;
        if (pending?.record) {
          const entry: SavedBacktestRun = {
            id: `bt-${Date.now()}`,
            createdAt: Date.now(),
            params: { ...pending.params },
            totalMetrics: out.totalMetrics,
            inSampleMetrics: out.inSampleMetrics,
            outOfSampleMetrics: out.outOfSampleMetrics,
          };
          setSavedRuns((prev) => {
            const next = [entry, ...prev].slice(0, 10);
            saveRuns(next);
            return next;
          });
        }
        pendingHistoryRunRef.current = null;
      }
    };
    workerRef.current = worker;

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // Initialize Equity + Drawdown Charts
  useEffect(() => {
    const eqEl = eqContainerRef.current;
    const ddEl = ddContainerRef.current;
    if (!eqEl || !ddEl) return;

    const layout = {
      background: { type: ColorType.Solid, color: '#0B0E14' },
      textColor: '#94A3B8',
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 11,
    };

    const eqChart = createChart(eqEl, {
      layout,
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.08)' },
      timeScale: { borderColor: 'rgba(255, 255, 255, 0.08)', timeVisible: true },
      autoSize: true,
    });

    const benchSeries = eqChart.addSeries(LineSeries, {
      color: '#64748B',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      title: 'Benchmark',
    });
    const eqSeries = eqChart.addSeries(LineSeries, {
      color: '#3B82F6',
      lineWidth: 2,
      title: 'Estrategia',
    });

    const ddChart = createChart(ddEl, {
      layout,
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.08)' },
      timeScale: { borderColor: 'rgba(255, 255, 255, 0.08)', timeVisible: true },
      autoSize: true,
    });

    const ddSeries = ddChart.addSeries(AreaSeries, {
      lineColor: '#EF4444',
      topColor: 'rgba(239, 68, 68, 0.05)',
      bottomColor: 'rgba(239, 68, 68, 0.35)',
      lineWidth: 1,
      priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(1)}%` },
    });

    let syncing = false;
    const sync = (src: 'eq' | 'dd', r: LogicalRange | null) => {
      if (!r || syncing) return;
      syncing = true;
      try {
        if (src === 'eq') ddChart.timeScale().setVisibleLogicalRange(r);
        else eqChart.timeScale().setVisibleLogicalRange(r);
      } finally {
        syncing = false;
      }
    };
    eqChart.timeScale().subscribeVisibleLogicalRangeChange((r) => sync('eq', r));
    ddChart.timeScale().subscribeVisibleLogicalRangeChange((r) => sync('dd', r));

    eqChartRef.current = eqChart;
    ddChartRef.current = ddChart;
    eqSeriesRef.current = eqSeries;
    benchSeriesRef.current = benchSeries;
    ddSeriesRef.current = ddSeries;

    return () => {
      eqChart.remove();
      ddChart.remove();
    };
  }, []);

  // Initialize / update Candlestick + Trade Markers Chart when chartViewMode === 'candles'
  useEffect(() => {
    if (chartViewMode !== 'candles') return;
    const el = candleContainerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#0B0E14' },
        textColor: '#94A3B8',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.04)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.04)' },
      },
      rightPriceScale: { borderColor: 'rgba(255, 255, 255, 0.08)' },
      timeScale: { borderColor: 'rgba(255, 255, 255, 0.08)', timeVisible: true },
      autoSize: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#00E676',
      downColor: '#EF4444',
      borderUpColor: '#00E676',
      borderDownColor: '#EF4444',
      wickUpColor: '#00E676',
      wickDownColor: '#EF4444',
    });

    const markersPlugin = createSeriesMarkers(series, []);
    candleChartRef.current = chart;
    candleSeriesRef.current = series;
    candleMarkersRef.current = markersPlugin;

    return () => {
      candleMarkersRef.current = null;
      candleSeriesRef.current = null;
      candleChartRef.current = null;
      chart.remove();
    };
  }, [chartViewMode]);

  useEffect(() => {
    if (chartViewMode !== 'candles' || !candleSeriesRef.current || !candleMarkersRef.current) return;
    if (candles.length === 0) return;

    candleSeriesRef.current.setData(
      candles.map((c) => ({
        time: (c.t / 1000) as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      }))
    );

    const markers: SeriesMarker<Time>[] = [];
    if (result) {
      for (const t of result.trades) {
        markers.push({
          time: (t.entryTs / 1000) as UTCTimestamp,
          position: t.direction === 'LONG' ? 'belowBar' : 'aboveBar',
          color: t.direction === 'LONG' ? '#00E676' : '#F43F5E',
          shape: t.direction === 'LONG' ? 'arrowUp' : 'arrowDown',
          text: t.direction === 'LONG' ? 'L' : 'S',
        });
        markers.push({
          time: (t.exitTs / 1000) as UTCTimestamp,
          position: t.direction === 'LONG' ? 'aboveBar' : 'belowBar',
          color: t.pnlUsd >= 0 ? '#38BDF8' : '#F59E0B',
          shape: 'circle',
          text: `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%`,
        });
      }
      markers.sort((a, b) => Number(a.time) - Number(b.time));
    }

    candleMarkersRef.current.setMarkers(markers);
    candleChartRef.current?.timeScale().fitContent();
  }, [chartViewMode, candles, result]);

  const executeWorkerSimulation = useCallback(
    (sourceCandles: Candle[], runParams: BacktestParams, recordToHistory: boolean) => {
      const worker = workerRef.current;
      if (!worker || sourceCandles.length < 5) return;

      setRunningWorker(true);
      pendingHistoryRunRef.current = { record: recordToHistory, params: { ...runParams } };
      worker.postMessage({ kind: 'run', candles: sourceCandles, params: runParams });
    },
    []
  );

  const executeSensitivitySweep = useCallback(
    (sourceCandles: Candle[], runParams: BacktestParams) => {
      const worker = workerRef.current;
      if (!worker || sourceCandles.length < 15) return;
      setRunningSweep(true);
      worker.postMessage({ kind: 'sweep', candles: sourceCandles, params: runParams });
    },
    []
  );

  const handleRunSimulation = useCallback(
    async (recordToHistory = true) => {
      setErrorMsg(null);
      if (datasetKey === loadedDatasetKey && candles.length > 5) {
        executeWorkerSimulation(candles, params, recordToHistory);
        return;
      }

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      const startTs = Date.parse(`${params.startDate}T00:00:00Z`);
      const endTs = Date.parse(`${params.endDate}T23:59:59Z`);
      if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) {
        setErrorMsg('Rango de fechas inválido.');
        return;
      }

      try {
        setLoadingProgress({ pct: 0, count: 0 });
        const fetched = await fetchHistoryCandlesPaginated(
          params.instId,
          params.timeframe,
          startTs,
          endTs,
          (pct, count) => setLoadingProgress({ pct, count }),
          ctrl.signal
        );
        setLoadingProgress(null);

        if (fetched.length < 10) {
          setErrorMsg('Se obtuvieron muy pocas velas en ese rango de fechas.');
          return;
        }
        setCandles(fetched);
        setLoadedDatasetKey(datasetKey);
        executeWorkerSimulation(fetched, params, recordToHistory);
      } catch (err) {
        setLoadingProgress(null);
        if ((err as Error).name !== 'AbortError') {
          setErrorMsg(err instanceof Error ? err.message : 'Error descargando velas históricas.');
        }
      }
    },
    [candles, datasetKey, executeWorkerSimulation, loadedDatasetKey, params]
  );

  // Run initial simulation automatically when tab opens
  useEffect(() => {
    if (candles.length === 0 && loadingProgress === null && !result) {
      void handleRunSimulation(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto re-run worker when strategy/cost params change on already-loaded candles
  useEffect(() => {
    if (datasetKey === loadedDatasetKey && candles.length > 5) {
      setSweepGrid(null);
      const t = setTimeout(() => {
        executeWorkerSimulation(candles, params, false);
      }, 160);
      return () => clearTimeout(t);
    }
  }, [candles, datasetKey, executeWorkerSimulation, loadedDatasetKey, params]);

  // Auto-run sensitivity grid when user opens Sensibilidad tab
  useEffect(() => {
    if (detailTab === 'Sensibilidad' && candles.length >= 15 && !sweepGrid && !runningSweep) {
      executeSensitivitySweep(candles, params);
    }
  }, [detailTab, candles, params, sweepGrid, runningSweep, executeSensitivitySweep]);

  // Update charts when result changes
  useEffect(() => {
    if (!result || !eqSeriesRef.current || !benchSeriesRef.current || !ddSeriesRef.current) return;
    eqSeriesRef.current.setData(
      result.equityCurve.map((p) => ({
        time: (p.t / 1000) as UTCTimestamp,
        value: p.equity,
      }))
    );
    benchSeriesRef.current.setData(
      result.equityCurve.map((p) => ({
        time: (p.t / 1000) as UTCTimestamp,
        value: p.benchmark,
      }))
    );
    ddSeriesRef.current.setData(
      result.equityCurve.map((p) => ({
        time: (p.t / 1000) as UTCTimestamp,
        value: p.drawdownPct,
      }))
    );
    eqChartRef.current?.timeScale().fitContent();
    ddChartRef.current?.timeScale().fitContent();
  }, [result]);

  const sortedOrders = useMemo(() => {
    if (!result) return [];
    return [...result.orders].sort((a, b) => {
      const av = a[orderSort.key];
      const bv = b[orderSort.key];
      if (av < bv) return orderSort.asc ? -1 : 1;
      if (av > bv) return orderSort.asc ? 1 : -1;
      return 0;
    });
  }, [result, orderSort]);

  const sortedTrades = useMemo(() => {
    if (!result) return [];
    return [...result.trades].sort((a, b) => {
      const av = a[tradeSort.key];
      const bv = b[tradeSort.key];
      if (av < bv) return tradeSort.asc ? -1 : 1;
      if (av > bv) return tradeSort.asc ? 1 : -1;
      return 0;
    });
  }, [result, tradeSort]);

  const activeTemplateMeta = TEMPLATE_OPTIONS.find((t) => t.value === params.template)!;

  return (
    <div className="flex flex-col lg:flex-row flex-1 min-h-0 bg-[#0B0E14] overflow-y-auto lg:overflow-hidden">
      {/* Left Form */}
      <aside className="w-full lg:w-80 bg-[#111621] border-b lg:border-b-0 lg:border-r border-white/[0.08] p-3.5 space-y-3 overflow-y-auto shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white">Parámetros de estrategia</h2>
          <span className="text-[11px] text-slate-400">Sin IA · t+1</span>
        </div>

        <div className="space-y-2.5 text-xs">
          <div>
            <label className="block text-slate-400 mb-1">Plantilla</label>
            <select
              value={params.template}
              onChange={(e) =>
                setParams((p) => ({ ...p, template: e.target.value as StrategyTemplate }))
              }
              className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-[#3B82F6]"
            >
              {TEMPLATE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-slate-400 leading-snug">{activeTemplateMeta.desc}</p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-slate-400 mb-1">Par perpetuo (OKX)</label>
              <select
                value={params.instId}
                onChange={(e) => setParams((p) => ({ ...p, instId: e.target.value }))}
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
              >
                <option value="BTC-USDT-SWAP">BTC-USDT-SWAP</option>
                <option value="ETH-USDT-SWAP">ETH-USDT-SWAP</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Temporalidad</label>
              <select
                value={params.timeframe}
                onChange={(e) =>
                  setParams((p) => ({ ...p, timeframe: e.target.value as Timeframe }))
                }
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
              >
                {(['15m', '1H', '4H', 'D'] as Timeframe[]).map((tf) => (
                  <option key={tf} value={tf}>
                    {tf}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-slate-400 mb-1">Desde</label>
              <input
                type="date"
                value={params.startDate}
                onChange={(e) => setParams((p) => ({ ...p, startDate: e.target.value }))}
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Hasta</label>
              <input
                type="date"
                value={params.endDate}
                onChange={(e) => setParams((p) => ({ ...p, endDate: e.target.value }))}
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
              />
            </div>
          </div>

          {/* Template Specific Params */}
          {params.template === 'ema_cross' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-slate-400 mb-1">EMA rápida</label>
                <input
                  type="number"
                  min={2}
                  max={200}
                  value={params.emaFast}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, emaFast: Math.max(2, Number(e.target.value)) }))
                  }
                  className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">EMA lenta</label>
                <input
                  type="number"
                  min={3}
                  max={400}
                  value={params.emaSlow}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, emaSlow: Math.max(3, Number(e.target.value)) }))
                  }
                  className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
                />
              </div>
            </div>
          )}

          {params.template === 'momentum' && (
            <div>
              <label className="block text-slate-400 mb-1">Barras N</label>
              <input
                type="number"
                min={1}
                max={200}
                value={params.momentumBars}
                onChange={(e) =>
                  setParams((p) => ({ ...p, momentumBars: Math.max(1, Number(e.target.value)) }))
                }
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
              />
            </div>
          )}

          {params.template === 'rsi_reversion' && (
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-slate-400 mb-1">Periodo</label>
                  <input
                    type="number"
                    min={2}
                    max={100}
                    value={params.rsiPeriod}
                    onChange={(e) =>
                      setParams((p) => ({ ...p, rsiPeriod: Math.max(2, Number(e.target.value)) }))
                    }
                    className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Entrada &lt;</label>
                  <input
                    type="number"
                    min={5}
                    max={45}
                    value={params.rsiOversold}
                    onChange={(e) =>
                      setParams((p) => ({ ...p, rsiOversold: Number(e.target.value) }))
                    }
                    className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Salida &gt;</label>
                  <input
                    type="number"
                    min={30}
                    max={90}
                    value={params.rsiExit}
                    onChange={(e) => setParams((p) => ({ ...p, rsiExit: Number(e.target.value) }))}
                    className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={params.rsiShortSymmetric}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, rsiShortSymmetric: e.target.checked }))
                  }
                  className="accent-[#3B82F6]"
                />
                <span>Corto simétrico opcional (RSI &gt; {100 - params.rsiOversold})</span>
              </label>
            </div>
          )}

          {params.template === 'bollinger_breakout' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-slate-400 mb-1">Periodo</label>
                <input
                  type="number"
                  min={5}
                  max={200}
                  value={params.bbPeriod}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, bbPeriod: Math.max(5, Number(e.target.value)) }))
                  }
                  className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Desviaciones</label>
                <input
                  type="number"
                  step={0.1}
                  min={0.5}
                  max={5}
                  value={params.bbStdDev}
                  onChange={(e) =>
                    setParams((p) => ({ ...p, bbStdDev: Math.max(0.5, Number(e.target.value)) }))
                  }
                  className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 pt-1 border-t border-white/[0.06]">
            <div>
              <label className="block text-slate-400 mb-1">Capital ($)</label>
              <input
                type="number"
                min={100}
                step={500}
                value={params.initialCapital}
                onChange={(e) =>
                  setParams((p) => ({ ...p, initialCapital: Math.max(100, Number(e.target.value)) }))
                }
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Tamaño pos. (%)</label>
              <input
                type="number"
                min={5}
                max={100}
                value={params.positionSizePct}
                onChange={(e) =>
                  setParams((p) => ({
                    ...p,
                    positionSizePct: Math.min(100, Math.max(5, Number(e.target.value))),
                  }))
                }
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-slate-400 mb-1">Comisión/lado (%)</label>
              <input
                type="number"
                step={0.01}
                min={0}
                max={2}
                value={params.commissionPct}
                onChange={(e) =>
                  setParams((p) => ({ ...p, commissionPct: Math.max(0, Number(e.target.value)) }))
                }
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Deslizamiento (%)</label>
              <input
                type="number"
                step={0.01}
                min={0}
                max={2}
                value={params.slippagePct}
                onChange={(e) =>
                  setParams((p) => ({ ...p, slippagePct: Math.max(0, Number(e.target.value)) }))
                }
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-slate-400 mb-1">Stop % (opc.)</label>
              <input
                type="number"
                step={0.5}
                min={0}
                placeholder="Sin stop"
                value={params.stopPct ?? ''}
                onChange={(e) =>
                  setParams((p) => ({
                    ...p,
                    stopPct: e.target.value === '' ? null : Math.max(0.1, Number(e.target.value)),
                  }))
                }
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular placeholder:text-slate-600"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Objetivo R (opc.)</label>
              <input
                type="number"
                step={0.5}
                min={0}
                placeholder="Sin obj."
                value={params.targetR ?? ''}
                onChange={(e) =>
                  setParams((p) => ({
                    ...p,
                    targetR: e.target.value === '' ? null : Math.max(0.1, Number(e.target.value)),
                  }))
                }
                className="w-full bg-[#0B0E14] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular placeholder:text-slate-600"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => void handleRunSimulation(true)}
            disabled={loadingProgress !== null || runningWorker}
            className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-md bg-[#3B82F6] hover:bg-blue-500 disabled:opacity-50 text-white font-medium transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            <span>
              {loadingProgress !== null
                ? `Descargando velas (${loadingProgress.pct}%)...`
                : runningWorker
                ? 'Simulando...'
                : 'Ejecutar y guardar'}
            </span>
          </button>

          {loadingProgress !== null && (
            <div className="space-y-1">
              <div className="h-1.5 w-full bg-[#0B0E14] rounded overflow-hidden">
                <div
                  style={{ width: `${loadingProgress.pct}%` }}
                  className="h-full bg-[#3B82F6] transition-all"
                />
              </div>
              <div className="text-[11px] font-mono-tabular text-slate-400">
                {loadingProgress.count.toLocaleString('en-US')} velas descargadas desde OKX
              </div>
            </div>
          )}

          {errorMsg && <p className="text-xs text-rose-400">{errorMsg}</p>}

          <p className="text-[11px] text-slate-500 pt-1 border-t border-white/[0.06]">
            Un backtest bueno no garantiza resultados futuros. Sin apalancamiento; señales evaluadas
            al cierre de t y ejecutadas en apertura de t+1.
          </p>
        </div>
      </aside>

      {/* Right Workspace: Equity/Drawdown Charts + Metrics/Orders/Trades Tables */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Sample size warning */}
        {result && result.totalMetrics.tradeCount < 30 && (
          <div className="px-4 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2 text-xs text-amber-300 shrink-0">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>
              Muestra insuficiente ({result.totalMetrics.tradeCount} operaciones &lt; 30). Amplía el
              rango de fechas o usa una temporalidad menor para evitar sobreajuste.
            </span>
          </div>
        )}

        {/* Chart View Mode Bar + Equity/Drawdown or Candles+Markers */}
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#111621] border-b border-white/[0.08] shrink-0">
          <div className="flex items-center gap-1 bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]">
            <button
              type="button"
              onClick={() => setChartViewMode('equity')}
              className={`px-2.5 py-0.5 text-[11px] font-medium rounded transition-colors ${
                chartViewMode === 'equity'
                  ? 'bg-[#1F2937] text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Curva de Capital
            </button>
            <button
              type="button"
              onClick={() => setChartViewMode('candles')}
              className={`px-2.5 py-0.5 text-[11px] font-medium rounded transition-colors ${
                chartViewMode === 'candles'
                  ? 'bg-[#1F2937] text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Velas y Señales
            </button>
          </div>

          {result && (
            <span className="text-[11px] font-mono-tabular text-slate-400">
              {result.candleCount.toLocaleString('en-US')} velas · Corte 70/30:{' '}
              {new Date(result.splitTimestamp).toISOString().slice(0, 10)}
            </span>
          )}
        </div>

        <div className="relative h-[320px] sm:h-[360px] border-b border-white/[0.08] shrink-0">
          <div
            className={`grid grid-rows-[1fr_110px] w-full h-full ${
              chartViewMode === 'equity' ? '' : 'hidden'
            }`}
          >
            <div className="relative min-h-0">
              <div className="absolute top-2 left-3 z-10 flex items-center gap-4 text-[11px] pointer-events-none">
                <span className="text-sky-400 font-medium">Estrategia</span>
                <span className="text-slate-400">Benchmark (Comprar y mantener)</span>
              </div>
              <div ref={eqContainerRef} className="w-full h-full" />
            </div>
            <div className="relative min-h-0 border-t border-white/[0.06]">
              <div className="absolute top-1.5 left-3 z-10 text-[11px] text-rose-400 pointer-events-none">
                Drawdown (%)
              </div>
              <div ref={ddContainerRef} className="w-full h-full" />
            </div>
          </div>

          {chartViewMode === 'candles' && (
            <div className="relative w-full h-full">
              <div className="absolute top-2 left-3 z-10 flex items-center gap-3 text-[11px] pointer-events-none">
                <span className="text-emerald-400">▲ Entrada Largo</span>
                <span className="text-rose-400">▼ Entrada Corto</span>
                <span className="text-sky-300">● Salida (% PnL)</span>
              </div>
              <div ref={candleContainerRef} className="w-full h-full" />
            </div>
          )}
        </div>

        {/* Bottom Tabs */}
        <div className="flex items-center justify-between px-3 py-2 bg-[#111621] border-b border-white/[0.08] shrink-0 gap-2 overflow-x-auto">
          <div className="flex items-center gap-1 bg-[#0B0E14] p-0.5 rounded-md border border-white/[0.08]">
            {(['Total', 'Orders', 'Trades', 'Sensibilidad', 'Historial'] as DetailTab[]).map(
              (tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setDetailTab(tab)}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    detailTab === tab
                      ? 'bg-[#1F2937] text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab === 'Orders' && result
                    ? `Orders (${result.orders.length})`
                    : tab === 'Trades' && result
                    ? `Trades (${result.trades.length})`
                    : tab === 'Historial'
                    ? `Historial (${savedRuns.length}/10)`
                    : tab}
                </button>
              )
            )}
          </div>

          {result && (
            <div className="text-xs font-mono-tabular text-slate-300 hidden sm:flex items-center gap-3 shrink-0">
              <span>
                Capital final:{' '}
                <strong className="text-white">
                  $
                  {result.totalMetrics.finalEquity.toLocaleString('en-US', {
                    maximumFractionDigits: 2,
                  })}
                </strong>
              </span>
              <span
                className={
                  result.totalMetrics.totalReturnPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }
              >
                {result.totalMetrics.totalReturnPct >= 0 ? '+' : ''}
                {result.totalMetrics.totalReturnPct.toFixed(2)}%
              </span>
            </div>
          )}
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-3">
          {!result ? (
            <div className="p-8 text-center text-xs text-slate-400">
              Ejecuta una simulación para ver métricas, órdenes y operaciones.
            </div>
          ) : detailTab === 'Total' ? (
            <MetricsTable
              total={result.totalMetrics}
              inSample={result.inSampleMetrics}
              outOfSample={result.outOfSampleMetrics}
            />
          ) : detailTab === 'Orders' ? (
            <div className="space-y-2">
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() =>
                    exportCsv(
                      `orders_${params.instId}_${params.timeframe}.csv`,
                      ['Fecha UTC', 'Lado', 'Accion', 'Precio', 'Cantidad', 'Comision', 'Motivo'],
                      sortedOrders.map((o) => [
                        new Date(o.ts).toISOString(),
                        o.side,
                        o.action,
                        o.price.toFixed(2),
                        o.qty.toFixed(6),
                        o.fee.toFixed(2),
                        o.reason,
                      ])
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#0B0E14] border border-white/[0.1] hover:bg-white/[0.05] text-[11px] text-slate-300"
                >
                  <Download className="w-3 h-3" />
                  <span>Exportar CSV</span>
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/[0.08] text-slate-400">
                    {(
                      [
                        ['ts', 'Fecha UTC'],
                        ['side', 'Lado'],
                        ['action', 'Acción'],
                        ['price', 'Precio'],
                        ['qty', 'Cantidad'],
                        ['fee', 'Comisión'],
                        ['reason', 'Motivo'],
                      ] as [keyof BacktestOrder, string][]
                    ).map(([k, label]) => (
                      <th
                        key={k}
                        onClick={() =>
                          setOrderSort((s) => ({ key: k, asc: s.key === k ? !s.asc : false }))
                        }
                        className="py-2 px-2.5 font-medium cursor-pointer hover:text-white whitespace-nowrap"
                      >
                        <span className="inline-flex items-center gap-1">
                          {label}
                          <ArrowUpDown className="w-3 h-3 opacity-50" />
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04] font-mono-tabular">
                  {sortedOrders.map((o) => (
                    <tr key={o.id} className="hover:bg-white/[0.03]">
                      <td className="py-1.5 px-2.5 text-slate-300">
                        {new Date(o.ts).toISOString().slice(0, 16).replace('T', ' ')}
                      </td>
                      <td
                        className={`py-1.5 px-2.5 font-semibold ${
                          o.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {o.side}
                      </td>
                      <td className="py-1.5 px-2.5 text-slate-300">{o.action}</td>
                      <td className="py-1.5 px-2.5 text-slate-200">
                        ${o.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                      </td>
                      <td className="py-1.5 px-2.5 text-slate-300">{o.qty.toFixed(4)}</td>
                      <td className="py-1.5 px-2.5 text-slate-400">${o.fee.toFixed(2)}</td>
                      <td className="py-1.5 px-2.5 font-sans text-slate-400">{o.reason}</td>
                    </tr>
                  ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : detailTab === 'Trades' ? (
            <div className="space-y-2">
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() =>
                    exportCsv(
                      `trades_${params.instId}_${params.timeframe}.csv`,
                      [
                        'Direccion',
                        'Entrada UTC',
                        'Salida UTC',
                        'P Entrada',
                        'P Salida',
                        'PnL USD',
                        'PnL %',
                        'Duracion (h)',
                        'Motivo salida',
                      ],
                      sortedTrades.map((t) => [
                        t.direction,
                        new Date(t.entryTs).toISOString(),
                        new Date(t.exitTs).toISOString(),
                        t.entryPrice.toFixed(2),
                        t.exitPrice.toFixed(2),
                        t.pnlUsd.toFixed(2),
                        t.pnlPct.toFixed(2),
                        t.durationHours.toFixed(1),
                        t.exitReason,
                      ])
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#0B0E14] border border-white/[0.1] hover:bg-white/[0.05] text-[11px] text-slate-300"
                >
                  <Download className="w-3 h-3" />
                  <span>Exportar CSV</span>
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left border-collapse">
                <thead>
                  <tr className="border-b border-white/[0.08] text-slate-400">
                    {(
                      [
                        ['direction', 'Dir.'],
                        ['entryTs', 'Entrada UTC'],
                        ['exitTs', 'Salida UTC'],
                        ['entryPrice', 'P. Entrada'],
                        ['exitPrice', 'P. Salida'],
                        ['pnlUsd', 'PnL ($)'],
                        ['pnlPct', 'PnL (%)'],
                        ['durationHours', 'Duración'],
                        ['exitReason', 'Salida'],
                      ] as [keyof BacktestTrade, string][]
                    ).map(([k, label]) => (
                      <th
                        key={k}
                        onClick={() =>
                          setTradeSort((s) => ({ key: k, asc: s.key === k ? !s.asc : false }))
                        }
                        className="py-2 px-2.5 font-medium cursor-pointer hover:text-white whitespace-nowrap"
                      >
                        <span className="inline-flex items-center gap-1">
                          {label}
                          <ArrowUpDown className="w-3 h-3 opacity-50" />
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04] font-mono-tabular">
                  {sortedTrades.map((t) => (
                    <tr key={t.id} className="hover:bg-white/[0.03]">
                      <td
                        className={`py-1.5 px-2.5 font-semibold ${
                          t.direction === 'LONG' ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {t.direction}
                      </td>
                      <td className="py-1.5 px-2.5 text-slate-300">
                        {new Date(t.entryTs).toISOString().slice(0, 16).replace('T', ' ')}
                      </td>
                      <td className="py-1.5 px-2.5 text-slate-300">
                        {new Date(t.exitTs).toISOString().slice(0, 16).replace('T', ' ')}
                      </td>
                      <td className="py-1.5 px-2.5 text-slate-200">
                        ${t.entryPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                      </td>
                      <td className="py-1.5 px-2.5 text-slate-200">
                        ${t.exitPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                      </td>
                      <td
                        className={`py-1.5 px-2.5 font-medium ${
                          t.pnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toFixed(2)}
                      </td>
                      <td
                        className={`py-1.5 px-2.5 ${
                          t.pnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {t.pnlPct >= 0 ? '+' : ''}
                        {t.pnlPct.toFixed(2)}%
                      </td>
                      <td className="py-1.5 px-2.5 text-slate-400">
                        {t.durationHours.toFixed(1)}h
                      </td>
                      <td className="py-1.5 px-2.5 font-sans text-slate-400">{t.exitReason}</td>
                    </tr>
                  ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : detailTab === 'Sensibilidad' ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold text-white">
                    Matriz de sensibilidad (Ajuste 70% vs Validación 30%)
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Detecta sobreajuste comparando rentabilidad y Sharpe en muestra frente a fuera de muestra.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => executeSensitivitySweep(candles, params)}
                  disabled={runningSweep || candles.length < 15}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#1F2937] hover:bg-[#2B374B] disabled:opacity-50 text-xs font-medium text-white"
                >
                  <Grid3X3 className="w-3.5 h-3.5" />
                  <span>{runningSweep ? 'Calculando 25 combos...' : 'Recalcular matriz 5×5'}</span>
                </button>
              </div>

              {!sweepGrid || runningSweep ? (
                <div className="p-6 text-center text-xs text-slate-400 border border-white/[0.08] rounded bg-[#0B0E14]/60">
                  {runningSweep
                    ? 'Ejecutando 25 simulaciones en Web Worker...'
                    : 'Pulsa "Recalcular matriz 5×5" para evaluar estabilidad.'}
                </div>
              ) : (
                <div className="overflow-x-auto border border-white/[0.08] rounded bg-[#0B0E14]/60">
                  <table className="w-full text-[11px] font-mono-tabular border-collapse">
                    <thead>
                      <tr className="border-b border-white/[0.08] text-slate-400">
                        <th className="py-2 px-2.5 text-left font-sans">
                          {sweepGrid.yLabel} \ {sweepGrid.xLabel}
                        </th>
                        {sweepGrid.xValues.map((xv) => (
                          <th key={xv} className="py-2 px-2.5 text-center">
                            {xv}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.05]">
                      {sweepGrid.cells.map((row, rIdx) => (
                        <tr key={sweepGrid.yValues[rIdx]}>
                          <th className="py-2 px-2.5 text-left text-slate-300 font-medium border-r border-white/[0.06]">
                            {sweepGrid.yValues[rIdx]}
                          </th>
                          {row.map((cell) => {
                            const oosPos = cell.outOfSampleReturnPct >= 0;
                            const strongOos = cell.outOfSampleReturnPct > 2 && cell.outOfSampleSharpe > 0.8;
                            const bgCls = strongOos
                              ? 'bg-emerald-500/20 border-emerald-500/30'
                              : oosPos
                              ? 'bg-emerald-500/10 border-emerald-500/15'
                              : 'bg-rose-500/10 border-rose-500/15';
                            return (
                              <td
                                key={`${cell.xVal}-${cell.yVal}`}
                                className={`p-2 text-center border ${bgCls}`}
                              >
                                <div className="text-slate-300">
                                  Aj: {cell.inSampleReturnPct >= 0 ? '+' : ''}
                                  {cell.inSampleReturnPct.toFixed(1)}%
                                </div>
                                <div
                                  className={`font-bold ${
                                    oosPos ? 'text-emerald-300' : 'text-rose-300'
                                  }`}
                                >
                                  Val: {cell.outOfSampleReturnPct >= 0 ? '+' : ''}
                                  {cell.outOfSampleReturnPct.toFixed(1)}%
                                </div>
                                <div className="text-[10px] text-slate-400">
                                  S:{cell.outOfSampleSharpe.toFixed(2)} · {cell.tradeCount} ops
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {savedRuns.length === 0 ? (
                <p className="text-xs text-slate-400 p-4 text-center">
                  Pulsa &ldquo;Ejecutar y guardar&rdquo; para comparar hasta 10 simulaciones.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs text-left border-collapse">
                    <thead>
                      <tr className="border-b border-white/[0.08] text-slate-400">
                        <th className="py-2 px-2">Fecha</th>
                        <th className="py-2 px-2">Plantilla</th>
                        <th className="py-2 px-2">Par · TF</th>
                        <th className="py-2 px-2 text-right">Rent. Total</th>
                        <th className="py-2 px-2 text-right">Ajuste 70%</th>
                        <th className="py-2 px-2 text-right">Valid. 30%</th>
                        <th className="py-2 px-2 text-right">Sharpe</th>
                        <th className="py-2 px-2 text-right">Max DD</th>
                        <th className="py-2 px-2 text-right">Ops</th>
                        <th className="py-2 px-2 text-right">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04] font-mono-tabular">
                      {savedRuns.map((run) => (
                        <tr key={run.id} className="hover:bg-white/[0.03]">
                          <td className="py-1.5 px-2 text-slate-400">
                            {new Date(run.createdAt).toISOString().slice(5, 16).replace('T', ' ')}
                          </td>
                          <td className="py-1.5 px-2 font-sans text-slate-200">
                            {TEMPLATE_OPTIONS.find((t) => t.value === run.params.template)?.label}
                          </td>
                          <td className="py-1.5 px-2 text-slate-300">
                            {run.params.instId.replace('-USDT-SWAP', '')} · {run.params.timeframe}
                          </td>
                          <td
                            className={`py-1.5 px-2 text-right ${
                              run.totalMetrics.totalReturnPct >= 0
                                ? 'text-emerald-400'
                                : 'text-rose-400'
                            }`}
                          >
                            {run.totalMetrics.totalReturnPct.toFixed(2)}%
                          </td>
                          <td className="py-1.5 px-2 text-right text-slate-300">
                            {run.inSampleMetrics.totalReturnPct.toFixed(2)}%
                          </td>
                          <td className="py-1.5 px-2 text-right text-slate-300">
                            {run.outOfSampleMetrics.totalReturnPct.toFixed(2)}%
                          </td>
                          <td className="py-1.5 px-2 text-right text-slate-200">
                            {run.totalMetrics.sharpe.toFixed(2)}
                          </td>
                          <td className="py-1.5 px-2 text-right text-rose-400">
                            {run.totalMetrics.maxDrawdownPct.toFixed(2)}%
                          </td>
                          <td className="py-1.5 px-2 text-right text-slate-300">
                            {run.totalMetrics.tradeCount}
                          </td>
                          <td className="py-1.5 px-2 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setParams(run.params)}
                                className="text-sky-400 hover:text-sky-300 p-1"
                                title="Cargar parámetros"
                              >
                                <History className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setSavedRuns((prev) => {
                                    const next = prev.filter((x) => x.id !== run.id);
                                    saveRuns(next);
                                    return next;
                                  })
                                }
                                className="text-slate-500 hover:text-rose-400 p-1"
                                title="Eliminar"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricsTable({
  total,
  inSample,
  outOfSample,
}: {
  total: BacktestMetrics;
  inSample: BacktestMetrics;
  outOfSample: BacktestMetrics;
}) {
  const rows: {
    label: string;
    totalVal: string;
    inVal: string;
    outVal: string;
    barPct: number;
    positive: boolean;
  }[] = [
    {
      label: 'Rentabilidad total',
      totalVal: `${total.totalReturnPct >= 0 ? '+' : ''}${total.totalReturnPct.toFixed(2)}%`,
      inVal: `${inSample.totalReturnPct >= 0 ? '+' : ''}${inSample.totalReturnPct.toFixed(2)}%`,
      outVal: `${outOfSample.totalReturnPct >= 0 ? '+' : ''}${outOfSample.totalReturnPct.toFixed(2)}%`,
      barPct: Math.min(100, Math.abs(total.totalReturnPct)),
      positive: total.totalReturnPct >= 0,
    },
    {
      label: 'Benchmark (Comprar y mantener)',
      totalVal: `${total.benchmarkReturnPct >= 0 ? '+' : ''}${total.benchmarkReturnPct.toFixed(2)}%`,
      inVal: `${inSample.benchmarkReturnPct >= 0 ? '+' : ''}${inSample.benchmarkReturnPct.toFixed(2)}%`,
      outVal: `${outOfSample.benchmarkReturnPct >= 0 ? '+' : ''}${outOfSample.benchmarkReturnPct.toFixed(2)}%`,
      barPct: Math.min(100, Math.abs(total.benchmarkReturnPct)),
      positive: total.benchmarkReturnPct >= 0,
    },
    {
      label: 'Win days',
      totalVal: `${total.winDaysPct.toFixed(1)}%`,
      inVal: `${inSample.winDaysPct.toFixed(1)}%`,
      outVal: `${outOfSample.winDaysPct.toFixed(1)}%`,
      barPct: Math.min(100, total.winDaysPct),
      positive: total.winDaysPct >= 50,
    },
    {
      label: 'Sharpe (anualizado 365d)',
      totalVal: total.sharpe.toFixed(2),
      inVal: inSample.sharpe.toFixed(2),
      outVal: outOfSample.sharpe.toFixed(2),
      barPct: Math.min(100, Math.max(0, (Math.abs(total.sharpe) / 4) * 100)),
      positive: total.sharpe >= 0,
    },
    {
      label: 'Max drawdown',
      totalVal: `${total.maxDrawdownPct.toFixed(2)}%`,
      inVal: `${inSample.maxDrawdownPct.toFixed(2)}%`,
      outVal: `${outOfSample.maxDrawdownPct.toFixed(2)}%`,
      barPct: Math.min(100, Math.abs(total.maxDrawdownPct) * 2),
      positive: false,
    },
    {
      label: 'Drawdown medio',
      totalVal: `${total.avgDrawdownPct.toFixed(2)}%`,
      inVal: `${inSample.avgDrawdownPct.toFixed(2)}%`,
      outVal: `${outOfSample.avgDrawdownPct.toFixed(2)}%`,
      barPct: Math.min(100, Math.abs(total.avgDrawdownPct) * 3),
      positive: false,
    },
    {
      label: 'Días medios en drawdown',
      totalVal: `${total.avgDrawdownDays.toFixed(1)} d`,
      inVal: `${inSample.avgDrawdownDays.toFixed(1)} d`,
      outVal: `${outOfSample.avgDrawdownDays.toFixed(1)} d`,
      barPct: Math.min(100, total.avgDrawdownDays * 5),
      positive: total.avgDrawdownDays < 3,
    },
    {
      label: 'Beta vs benchmark',
      totalVal: total.beta.toFixed(2),
      inVal: inSample.beta.toFixed(2),
      outVal: outOfSample.beta.toFixed(2),
      barPct: Math.min(100, Math.abs(total.beta) * 50),
      positive: true,
    },
    {
      label: 'Alfa (anualizado)',
      totalVal: `${total.alphaPct >= 0 ? '+' : ''}${total.alphaPct.toFixed(1)}%`,
      inVal: `${inSample.alphaPct >= 0 ? '+' : ''}${inSample.alphaPct.toFixed(1)}%`,
      outVal: `${outOfSample.alphaPct >= 0 ? '+' : ''}${outOfSample.alphaPct.toFixed(1)}%`,
      barPct: Math.min(100, Math.abs(total.alphaPct)),
      positive: total.alphaPct >= 0,
    },
    {
      label: 'Nº de operaciones',
      totalVal: `${total.tradeCount}`,
      inVal: `${inSample.tradeCount}`,
      outVal: `${outOfSample.tradeCount}`,
      barPct: Math.min(100, (total.tradeCount / 60) * 100),
      positive: total.tradeCount >= 30,
    },
    {
      label: 'Win rate',
      totalVal: `${total.winRatePct.toFixed(1)}%`,
      inVal: `${inSample.winRatePct.toFixed(1)}%`,
      outVal: `${outOfSample.winRatePct.toFixed(1)}%`,
      barPct: Math.min(100, total.winRatePct),
      positive: total.winRatePct >= 50,
    },
    {
      label: 'Profit factor',
      totalVal: total.profitFactor.toFixed(2),
      inVal: inSample.profitFactor.toFixed(2),
      outVal: outOfSample.profitFactor.toFixed(2),
      barPct: Math.min(100, (total.profitFactor / 3) * 100),
      positive: total.profitFactor >= 1,
    },
    {
      label: 'Expectancy ($ / %)',
      totalVal: `$${total.expectancyUsd.toFixed(1)} (${total.expectancyPct.toFixed(2)}%)`,
      inVal: `$${inSample.expectancyUsd.toFixed(1)} (${inSample.expectancyPct.toFixed(2)}%)`,
      outVal: `$${outOfSample.expectancyUsd.toFixed(1)} (${outOfSample.expectancyPct.toFixed(2)}%)`,
      barPct: Math.min(100, Math.abs(total.expectancyPct) * 20),
      positive: total.expectancyUsd >= 0,
    },
  ];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs text-left border-collapse">
        <thead>
          <tr className="border-b border-white/[0.08] text-slate-400">
            <th className="py-2 px-2.5 font-medium">Métrica</th>
            <th className="py-2 px-2.5 font-medium w-40 hidden sm:table-cell">Progreso</th>
            <th className="py-2 px-2.5 font-medium text-right">Total</th>
            <th className="py-2 px-2.5 font-medium text-right">Ajuste (70%)</th>
            <th className="py-2 px-2.5 font-medium text-right">Validación (30%)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.04]">
          {rows.map((r) => (
            <tr key={r.label} className="hover:bg-white/[0.03]">
              <td className="py-2 px-2.5 text-slate-300">{r.label}</td>
              <td className="py-2 px-2.5 hidden sm:table-cell">
                <div className="h-2 w-full bg-[#161D2B] rounded-sm overflow-hidden">
                  <div
                    style={{ width: `${r.barPct}%` }}
                    className={`h-full ${r.positive ? 'bg-emerald-500/80' : 'bg-rose-500/80'}`}
                  />
                </div>
              </td>
              <td
                className={`py-2 px-2.5 text-right font-mono-tabular font-medium ${
                  r.positive ? 'text-slate-100' : 'text-rose-400'
                }`}
              >
                {r.totalVal}
              </td>
              <td className="py-2 px-2.5 text-right font-mono-tabular text-slate-300">{r.inVal}</td>
              <td className="py-2 px-2.5 text-right font-mono-tabular text-slate-300">
                {r.outVal}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
