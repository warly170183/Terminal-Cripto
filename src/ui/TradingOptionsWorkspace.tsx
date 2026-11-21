import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart2,
  CheckCircle2,
  Compass,
  ExternalLink,
  Layers,
  Newspaper,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Target,
  TrendingUp,
  Waves,
  XCircle,
} from 'lucide-react';
import { calculateExpectedRangeCone, getAtTheMoneyIV } from '../calc/cone';
import { analyzeMarketLiquidity } from '../calc/liquidity';
import {
  calculateRolling30dVolMacroCorrelation,
  correlateNewsWithPriceAction,
  type CorrelationWindowDays,
} from '../calc/newsSentiment';
import { aggregateStrikes, calculateLevels } from '../calc/options';
import { evaluateScoringSystem } from '../calc/scoringEngine';
import {
  calculateFibonacciLevels,
  calculateVolumeDeltaSeries,
  calculateVolumeProfileBuckets,
  computeTechnicalSnapshot,
  detectConfluenceZones,
  detectFairValueGaps,
  detectOscillatorDivergences,
  detectSupportResistanceZones,
  evaluateMultiTimeframeMatrix,
} from '../calc/technicalAnalysis';
import { generateTradingOptions } from '../calc/tradeSetups';
import { createTrackedSignalFromIdea } from '../calc/signalEffectiveness';
import {
  fetchBtcEthDailyCandles,
  fetchDailySentimentHistory,
  type DailySentimentPoint,
} from '../data/newsClient';
import { fetchScoringDataset } from '../data/okxScoringClient';
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
import type { Candle, LiquidityLevelType, SymbolAsset, Timeframe } from '../types/market';
import type { MultiTfScoringDataset } from '../types/scoring';
import { VolatilitySmileChart } from './components/VolatilitySmileChart';

const QUICK_TFS: { value: Timeframe; label: string }[] = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1H', label: '1h' },
  { value: '4H', label: '4h' },
  { value: 'D', label: '1d' },
];

const CORR_WINDOWS: CorrelationWindowDays[] = [7, 14, 30];
const TECH_PREFS_KEY = 'wterm_tech_prefs_v1';

type RightOptionsSidebarTab = 'liquidity' | 'confluence' | 'flow_macro';

function loadSavedCorrWindow(): CorrelationWindowDays {
  try {
    const raw = localStorage.getItem(TECH_PREFS_KEY);
    if (!raw) return 30;
    const parsed = JSON.parse(raw) as { corrWindowDays?: number };
    if (parsed.corrWindowDays === 7 || parsed.corrWindowDays === 14 || parsed.corrWindowDays === 30) {
      return parsed.corrWindowDays;
    }
    return 30;
  } catch {
    return 30;
  }
}

function persistCorrWindow(w: CorrelationWindowDays) {
  try {
    const raw = localStorage.getItem(TECH_PREFS_KEY);
    const prev = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    localStorage.setItem(TECH_PREFS_KEY, JSON.stringify({ ...prev, corrWindowDays: w }));
  } catch {
    // ignore storage errors
  }
}

function formatPrice(val: number, asset: SymbolAsset): string {
  return `$${val.toLocaleString('en-US', {
    minimumFractionDigits: asset === 'BTC' ? 1 : 2,
    maximumFractionDigits: asset === 'BTC' ? 1 : 2,
  })}`;
}

function formatCompactUsd(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1_000_000) return `$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(abs / 1_000).toFixed(1)}K`;
  return `$${abs.toFixed(0)}`;
}

function levelBadgeStyle(type: LiquidityLevelType): string {
  switch (type) {
    case 'ASK_WALL':
    case 'BSL':
    case 'PDH':
      return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    case 'BID_WALL':
    case 'SSL':
    case 'PDL':
      return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    case 'CALL_WALL':
    case 'PUT_WALL':
    case 'GEX_FLIP':
      return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    default:
      return 'bg-sky-500/15 text-sky-300 border-sky-500/30';
  }
}

export function TradingOptionsWorkspace() {
  const {
    asset,
    setAsset,
    timeframe,
    setTimeframe,
    setActiveTab,
    candles,
    ticker,
    options,
    orderbook,
    selectedExpiry,
    prevDayHigh,
    prevDayLow,
    events,
    newsItems,
    newsCandles1h,
    scoringConfig,
    setScoringConfig,
    trackedSignals,
    recordTrackedSignals,
    reevaluateTrackedSignals,
  } = useTerminalStore();

  const lastRecordedSigRef = useRef<string>('');
  const lastReevalKeyRef = useRef<string>('');
  const trackedLiveCount = useMemo(
    () => trackedSignals.filter((s) => s.origin === 'live').length,
    [trackedSignals]
  );

  const [onlyOperable, setOnlyOperable] = useState(false);
  const [onlyTechAligned, setOnlyTechAligned] = useState(false);
  const [rightSidebarTab, setRightSidebarTab] = useState<RightOptionsSidebarTab>('liquidity');
  const [corrWindowDays, setCorrWindowDays] = useState<CorrelationWindowDays>(() =>
    loadSavedCorrWindow()
  );

  const handleCorrWindowChange = (w: CorrelationWindowDays) => {
    setCorrWindowDays(w);
    persistCorrWindow(w);
  };

  // Multi-TF & real-time technical + sentiment datasets (same engines as Análisis Técnico)
  const techMarketMode: TechnicalMarketMode =
    scoringConfig.mode === 'perpetual' ? 'perp' : 'spot';

  const [scoringDataset, setScoringDataset] = useState<MultiTfScoringDataset | null>(null);
  const [scoringLoading, setScoringLoading] = useState(false);
  const [techCandles, setTechCandles] = useState<Candle[]>([]);
  const [mtfCandles, setMtfCandles] = useState<
    Partial<Record<'15m' | '1H' | '4H' | 'D', Candle[]>>
  >({});
  const [takerTape, setTakerTape] = useState<TakerTapeSummary | null>(null);
  const [depthSnap, setDepthSnap] = useState<OrderbookCurveSnapshot | null>(null);
  const [perpTelemetry, setPerpTelemetry] = useState<PerpDerivativesTelemetry | null>(null);
  const [btcDaily, setBtcDaily] = useState<Candle[]>([]);
  const [ethDaily, setEthDaily] = useState<Candle[]>([]);
  const [dailySentiment, setDailySentiment] = useState<DailySentimentPoint[]>([]);

  const loadScoring = useCallback(
    async (signal?: AbortSignal) => {
      setScoringLoading(true);
      try {
        const ds = await fetchScoringDataset(asset, scoringConfig.mode, signal);
        setScoringDataset(ds);
      } catch {
        // Non-fatal: scenarios still render with base market metrics
      } finally {
        setScoringLoading(false);
      }
    },
    [asset, scoringConfig.mode]
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void loadScoring(ctrl.signal);
    const id = setInterval(() => {
      void loadScoring();
    }, 45_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [loadScoring]);

  // Load real technical market candles, MTF candles, OKX Taker flow, book curve & Perp OI/Funding
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    async function loadTechnicalContext() {
      const [cRes, mtfRes, tapeRes, depthRes, perpRes] = await Promise.allSettled([
        fetchTechnicalMarketCandles(asset, timeframe, techMarketMode, 250, undefined, ctrl.signal),
        fetchMultiTimeframeCandles(asset, techMarketMode, ctrl.signal),
        fetchLiveTakerTrades(asset, techMarketMode, ctrl.signal),
        fetchOrderbookDepthCurve(asset, techMarketMode, ctrl.signal),
        techMarketMode === 'perp'
          ? fetchPerpDerivativesTelemetry(asset, timeframe, ctrl.signal)
          : Promise.resolve(null),
      ]);
      if (cancelled) return;

      if (cRes.status === 'fulfilled' && cRes.value.length > 0) setTechCandles(cRes.value);
      if (mtfRes.status === 'fulfilled') setMtfCandles(mtfRes.value);
      if (tapeRes.status === 'fulfilled' && tapeRes.value) setTakerTape(tapeRes.value);
      if (depthRes.status === 'fulfilled' && depthRes.value) setDepthSnap(depthRes.value);
      if (perpRes.status === 'fulfilled') setPerpTelemetry(perpRes.value);
    }

    void loadTechnicalContext();
    const id = setInterval(() => {
      void loadTechnicalContext();
    }, 25_000);

    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, [asset, timeframe, techMarketMode]);

  // Load daily BTC/ETH & 100d FNG series for Rolling Macro/News vs Volatility Correlation
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    async function loadMacroDaily() {
      try {
        const [dailyRes, fngRes] = await Promise.all([
          fetchBtcEthDailyCandles(110, ctrl.signal),
          fetchDailySentimentHistory(ctrl.signal),
        ]);
        if (cancelled) return;
        setBtcDaily(dailyRes.btcDaily);
        setEthDaily(dailyRes.ethDaily);
        setDailySentiment(fngRes);
      } catch {
        // non-fatal
      }
    }

    void loadMacroDaily();
    const id = setInterval(() => {
      void loadMacroDaily();
    }, 300_000);

    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, []);

  const activeCandles = techCandles.length >= 20 ? techCandles : candles;
  const activeBook = depthSnap?.orderbookDepth ?? orderbook;
  const spot =
    ticker?.idxPx ?? activeCandles[activeCandles.length - 1]?.c ?? candles[candles.length - 1]?.c ?? 0;

  const allStrikesAsc = useMemo(() => aggregateStrikes(options, spot, 'ALL'), [options, spot]);
  const optionsLevels = useMemo(
    () => calculateLevels(allStrikesAsc, options, spot),
    [allStrikesAsc, options, spot]
  );

  const expiryOptions = useMemo(() => {
    if (!selectedExpiry) return [];
    return options.filter((o) => o.expiry === selectedExpiry);
  }, [options, selectedExpiry]);

  const cone = useMemo(() => {
    if (!selectedExpiry || expiryOptions.length === 0 || spot <= 0) return null;
    const expTs = expiryOptions[0].expTs;
    const now = Date.now();
    if (expTs <= now) return null;
    const expStrikes = aggregateStrikes(expiryOptions, spot, 'ALL');
    const expLevels = calculateLevels(expStrikes, expiryOptions, spot);
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
  }, [expiryOptions, selectedExpiry, spot]);

  const liquidity = useMemo(
    () =>
      analyzeMarketLiquidity(
        activeCandles,
        spot,
        optionsLevels,
        activeBook,
        prevDayHigh,
        prevDayLow
      ),
    [activeCandles, spot, optionsLevels, activeBook, prevDayHigh, prevDayLow]
  );

  // Real Technical Analysis computations matching TechnicalAnalysisWorkspace
  const volumeProfile = useMemo(
    () => calculateVolumeProfileBuckets(activeCandles.slice(-200), 36),
    [activeCandles]
  );
  const srZones = useMemo(
    () => detectSupportResistanceZones(activeCandles, spot),
    [activeCandles, spot]
  );
  const fvgs = useMemo(() => detectFairValueGaps(activeCandles, spot, 6), [activeCandles, spot]);
  const fibAnalysis = useMemo(
    () =>
      calculateFibonacciLevels(activeCandles, 120, 'auto', spot, {
        anchorMode: 'pivots',
      }),
    [activeCandles, spot]
  );
  const deltaSeries = useMemo(
    () => calculateVolumeDeltaSeries(activeCandles),
    [activeCandles]
  );
  const techSnapshot = useMemo(
    () =>
      computeTechnicalSnapshot(
        activeCandles,
        volumeProfile?.poc ?? liquidity.pocPrice,
        liquidity.imbalancePct
      ),
    [activeCandles, volumeProfile?.poc, liquidity.pocPrice, liquidity.imbalancePct]
  );
  const divergences = useMemo(
    () =>
      detectOscillatorDivergences(
        activeCandles,
        techSnapshot.rsi14,
        techSnapshot.macd.hist,
        deltaSeries
      ),
    [activeCandles, techSnapshot.rsi14, techSnapshot.macd.hist, deltaSeries]
  );
  const mtfMatrix = useMemo(() => evaluateMultiTimeframeMatrix(mtfCandles), [mtfCandles]);
  const confluences = useMemo(
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

  // Real News Sentiment + Rolling Correlation Window (7D / 14D / 30D)
  const newsCorrelation = useMemo(
    () => correlateNewsWithPriceAction(newsItems, newsCandles1h, events),
    [newsItems, newsCandles1h, events]
  );

  const rollingMacroCorr = useMemo(
    () =>
      calculateRolling30dVolMacroCorrelation({
        btcDaily,
        ethDaily,
        headlines: newsItems,
        macroEvents: events,
        dailySentiment,
        windowDays: corrWindowDays,
      }),
    [btcDaily, ethDaily, newsItems, events, dailySentiment, corrWindowDays]
  );

  const macroRegime = useMemo(() => {
    const rollingR = asset === 'ETH' ? rollingMacroCorr.latestREth : rollingMacroCorr.latestRBtc;
    const volPct = asset === 'ETH' ? rollingMacroCorr.avgEthVol30d : rollingMacroCorr.avgBtcVol30d;
    return {
      sentimentLabel: newsCorrelation.aggregateLabel,
      sentimentScore: newsCorrelation.aggregateScore,
      rollingR,
      windowDays: corrWindowDays,
      volPct,
    };
  }, [asset, newsCorrelation, rollingMacroCorr, corrWindowDays]);

  const scoringResult = useMemo(() => {
    if (!scoringDataset) return null;
    return evaluateScoringSystem(scoringDataset, {
      ...scoringConfig,
      upcomingEvents: events,
    });
  }, [scoringDataset, scoringConfig, events]);

  const allTradeIdeas = useMemo(
    () =>
      generateTradingOptions({
        asset,
        timeframe,
        candles: activeCandles,
        spot,
        optionsLevels,
        cone,
        liquidity,
        capitalUsd: scoringConfig.capitalUsd,
        riskPct: scoringConfig.riskPct,
        scoring: scoringResult,
        spreadPct: activeBook?.spreadPct ?? 0.02,
        feePctPerSide: scoringConfig.feePctPerSide,
        slippagePctPerSide: scoringConfig.slippagePctPerSide,
        volumeProfile,
        fibAnalysis,
        fvgs,
        confluences,
        divergences,
        techSnapshot,
        mtfMatrix,
        takerTape,
        macroRegime,
      }),
    [
      asset,
      timeframe,
      activeCandles,
      spot,
      optionsLevels,
      cone,
      liquidity,
      scoringConfig.capitalUsd,
      scoringConfig.riskPct,
      scoringConfig.feePctPerSide,
      scoringConfig.slippagePctPerSide,
      scoringResult,
      activeBook?.spreadPct,
      volumeProfile,
      fibAnalysis,
      fvgs,
      confluences,
      divergences,
      techSnapshot,
      mtfMatrix,
      takerTape,
      macroRegime,
    ]
  );

  // Automatically log newly generated trading option signals and re-grade existing ones as new candles arrive
  useEffect(() => {
    if (allTradeIdeas.length === 0 || activeCandles.length < 20 || spot <= 0) return;
    const latestCandle = activeCandles[activeCandles.length - 1];
    if (!latestCandle) return;

    const sigKey = `${asset}|${timeframe}|${scoringConfig.mode}|${latestCandle.t}|${allTradeIdeas
      .map((i) => `${i.id}:${i.scoring ? i.scoring.v11Score.toFixed(1) : i.confidenceScore}`)
      .join(',')}`;

    if (lastRecordedSigRef.current !== sigKey) {
      lastRecordedSigRef.current = sigKey;
      const incoming = allTradeIdeas.map((idea) =>
        createTrackedSignalFromIdea(idea, {
          asset,
          timeframe,
          marketMode: scoringConfig.mode,
          candleOpenTs: latestCandle.t,
          spotAtSignal: spot,
          origin: 'live',
        })
      );
      recordTrackedSignals(incoming);
    }

    const reevalKey = `${asset}|${timeframe}|${scoringConfig.mode}|${activeCandles.length}|${latestCandle.t}|${latestCandle.h}|${latestCandle.l}|${latestCandle.c}`;
    if (lastReevalKeyRef.current !== reevalKey) {
      lastReevalKeyRef.current = reevalKey;
      reevaluateTrackedSignals(asset, timeframe, scoringConfig.mode, activeCandles);
    }
  }, [
    allTradeIdeas,
    activeCandles,
    spot,
    asset,
    timeframe,
    scoringConfig.mode,
    recordTrackedSignals,
    reevaluateTrackedSignals,
  ]);

  const operableIdeas = useMemo(
    () => allTradeIdeas.filter((i) => i.scoring?.operable),
    [allTradeIdeas]
  );

  const displayedIdeas = useMemo(() => {
    let list = onlyOperable ? operableIdeas : allTradeIdeas;
    if (onlyTechAligned) {
      list = list.filter((i) => (i.technicalAlignment?.scoreDelta ?? 0) >= 2);
    }
    return list;
  }, [onlyOperable, onlyTechAligned, operableIdeas, allTradeIdeas]);

  const bestCandidate = operableIdeas[0] ?? null;
  const topScoredIdea = allTradeIdeas[0] ?? null;

  const totalBookUsd = liquidity.bidTotalUsd + liquidity.askTotalUsd;
  const bidSharePct = totalBookUsd > 0 ? (liquidity.bidTotalUsd / totalBookUsd) * 100 : 50;

  return (
    <div className="flex-1 overflow-y-auto bg-[#0B0E14] text-slate-200">
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-5">
        {/* Top Context + Risk Sizing + Scoring Profile Bar */}
        <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono-tabular text-sky-400">
              <Target className="w-4 h-4" />
              <span>
                OPCIONES DE TRADING · EVALUADOR v1.1 + ANÁLISIS TÉCNICO + CONFLUENCIAS + CORR. MACRO
              </span>
            </div>
            <h1 className="text-lg font-semibold text-white">
              Escenarios evaluados para {asset}-USD ({timeframe} ·{' '}
              {techMarketMode === 'perp' ? 'SWAP Perp' : 'Spot'})
            </h1>
            <p className="text-xs text-slate-400 max-w-2xl">
              Integra el Sistema de Puntuación v1.1 con los niveles de Análisis Técnico (VPVR,
              Golden Pocket Fib, FVG, clústeres, matriz MTF, cinta Taker) y la correlación
              sentimiento-volatilidad ({corrWindowDays}D).
            </p>
          </div>

          {/* Interactive Asset, Timeframe, Mode & Risk Controls */}
          <div className="flex flex-wrap items-end gap-3 text-xs">
            <div>
              <span className="block text-[10px] text-slate-400 mb-1">Activo</span>
              <div className="flex items-center bg-[#0B0E11] p-0.5 rounded border border-white/[0.08]">
                {(['BTC', 'ETH'] as SymbolAsset[]).map((sym) => (
                  <button
                    key={sym}
                    type="button"
                    onClick={() => setAsset(sym)}
                    className={`px-2.5 py-1 font-semibold rounded transition-colors ${
                      asset === sym ? 'bg-[#3B82F6] text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {sym}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="block text-[10px] text-slate-400 mb-1">Temporalidad</span>
              <div className="flex items-center bg-[#0B0E11] p-0.5 rounded border border-white/[0.08]">
                {QUICK_TFS.map((tf) => (
                  <button
                    key={tf.value}
                    type="button"
                    onClick={() => setTimeframe(tf.value)}
                    className={`px-2 py-1 font-mono-tabular font-semibold rounded transition-colors ${
                      timeframe === tf.value
                        ? 'bg-[#263144] text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="block text-[10px] text-slate-400 mb-1">Perfil v1.1 / Mercado</span>
              <div className="flex items-center bg-[#0B0E11] p-0.5 rounded border border-white/[0.08]">
                <button
                  type="button"
                  onClick={() => setScoringConfig({ mode: 'perpetual' })}
                  className={`px-2 py-1 rounded transition-colors ${
                    scoringConfig.mode === 'perpetual'
                      ? 'bg-[#263144] text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Perp
                </button>
                <button
                  type="button"
                  onClick={() => setScoringConfig({ mode: 'spot' })}
                  className={`px-2 py-1 rounded transition-colors ${
                    scoringConfig.mode === 'spot'
                      ? 'bg-[#263144] text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Spot
                </button>
              </div>
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 mb-1">Capital ($)</label>
              <input
                type="number"
                min={100}
                step={500}
                value={scoringConfig.capitalUsd}
                onChange={(e) =>
                  setScoringConfig({
                    capitalUsd: Math.max(100, Number(e.target.value) || 100),
                  })
                }
                className="w-24 bg-[#0B0E11] border border-white/[0.1] rounded px-2 py-1 font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
              />
            </div>

            <div>
              <label className="block text-[10px] text-slate-400 mb-1">Riesgo / Op (%)</label>
              <input
                type="number"
                min={0.05}
                max={10}
                step={0.05}
                value={scoringConfig.riskPct}
                onChange={(e) =>
                  setScoringConfig({
                    riskPct: Math.min(10, Math.max(0.05, Number(e.target.value) || 0.25)),
                  })
                }
                className="w-20 bg-[#0B0E11] border border-white/[0.1] rounded px-2 py-1 font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
              />
            </div>
          </div>
        </section>

        {/* Integrated v1.1 Opening Decision Evaluator Banner */}
        <section
          className={`bg-[#12161E] border rounded-lg p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${
            bestCandidate
              ? 'border-emerald-500/40'
              : scoringResult
              ? 'border-amber-500/35'
              : 'border-white/[0.08]'
          }`}
        >
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {bestCandidate ? (
                <span className="flex items-center gap-1.5 font-semibold text-emerald-300">
                  <ShieldCheck className="w-4 h-4" />
                  <span>
                    Decisión Sistema v1.1: HABILITADA para abrir {bestCandidate.direction} ·{' '}
                    {bestCandidate.title}
                  </span>
                </span>
              ) : scoringResult ? (
                <span className="flex items-center gap-1.5 font-semibold text-amber-300">
                  <AlertTriangle className="w-4 h-4" />
                  <span>
                    Decisión Sistema v1.1: NO abrir todavía — ninguna opción supera todos los cortes
                  </span>
                </span>
              ) : (
                <span className="text-slate-300 font-medium">
                  Calculando evaluación multi-temporal Sistema de Puntuación v1.1...
                </span>
              )}
            </div>

            {scoringResult && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-mono-tabular text-slate-300">
                <span>
                  LONG:{' '}
                  <strong
                    className={
                      scoringResult.longEval.score >= 80 ? 'text-emerald-300' : 'text-slate-200'
                    }
                  >
                    {scoringResult.longEval.score.toFixed(1)}/100
                  </strong>{' '}
                  ({scoringResult.longEval.band})
                </span>
                <span aria-hidden="true" className="text-slate-600">
                  ·
                </span>
                <span>
                  SHORT:{' '}
                  <strong
                    className={
                      scoringResult.shortEval.score >= 80 ? 'text-rose-300' : 'text-slate-200'
                    }
                  >
                    {scoringResult.shortEval.score.toFixed(1)}/100
                  </strong>{' '}
                  ({scoringResult.shortEval.band})
                </span>
                <span aria-hidden="true" className="text-slate-600">
                  ·
                </span>
                <span>
                  Cobertura:{' '}
                  <strong
                    className={
                      scoringResult.longEval.coveragePct >= 90
                        ? 'text-emerald-300'
                        : 'text-rose-300'
                    }
                  >
                    {scoringResult.longEval.coveragePct.toFixed(1)}%
                  </strong>
                </span>
                {!bestCandidate &&
                  topScoredIdea?.scoring &&
                  topScoredIdea.scoring.blockReasons.length > 0 && (
                    <>
                      <span aria-hidden="true" className="text-slate-600">
                        ·
                      </span>
                      <span className="text-amber-300 font-sans">
                        Motivo principal: {topScoredIdea.scoring.blockReasons[0]}
                      </span>
                    </>
                  )}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0 text-xs">
            <button
              type="button"
              onClick={() => setOnlyOperable((v) => !v)}
              className={`px-2.5 py-1.5 rounded border transition-colors whitespace-nowrap ${
                onlyOperable
                  ? 'bg-[#3B82F6] border-[#3B82F6] text-white'
                  : 'bg-[#0B0E11] border-white/[0.08] text-slate-300 hover:text-white'
              }`}
            >
              {onlyOperable
                ? `Solo habilitadas (${operableIdeas.length})`
                : `Todas v1.1 (${allTradeIdeas.length})`}
            </button>
            <button
              type="button"
              onClick={() => setOnlyTechAligned((v) => !v)}
              className={`px-2.5 py-1.5 rounded border transition-colors whitespace-nowrap ${
                onlyTechAligned
                  ? 'bg-sky-500/20 border-sky-500/50 text-sky-200'
                  : 'bg-[#0B0E11] border-white/[0.08] text-slate-300 hover:text-white'
              }`}
              title="Filtrar opciones con confluencia técnica positiva (MTF, Fib, FVG, VPVR o Taker)"
            >
              Alineadas Técnico
            </button>
            <button
              type="button"
              onClick={() => void loadScoring()}
              disabled={scoringLoading}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[#0B0E11] hover:bg-[#19202D] border border-white/[0.08] text-slate-300 whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${scoringLoading ? 'animate-spin' : ''}`} />
              <span>Recalcular v1.1</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('technical')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[#0B0E11] hover:bg-[#19202D] border border-white/[0.08] text-sky-300 whitespace-nowrap"
            >
              <BarChart2 className="w-3.5 h-3.5" />
              <span>Análisis Técnico</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('scoring')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[#0B0E11] hover:bg-[#19202D] border border-white/[0.08] text-slate-300 hover:text-white whitespace-nowrap"
            >
              <span>Matriz v1.1</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('effectiveness')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/35 text-emerald-300 whitespace-nowrap font-mono-tabular"
              title="Ver seguimiento de señales vs desarrollo posterior del gráfico e índice 0–100%"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Efectividad ({trackedLiveCount})</span>
            </button>
          </div>
        </section>

        {/* Live Technical Analysis + Macro/Sentiment Telemetry Strip (4 balanced cards) */}
        <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          {/* 1. Multi-Timeframe Matrix + Technical Bias */}
          <div className="bg-[#12161E] border border-white/[0.08] rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1.5 font-semibold text-white">
                <Activity className="w-3.5 h-3.5 text-sky-400" />
                <span>Sesgo Técnico &amp; MTF</span>
              </span>
              <span
                className={`font-mono-tabular font-semibold ${
                  techSnapshot.overallBias === 'Alcista'
                    ? 'text-emerald-300'
                    : techSnapshot.overallBias === 'Bajista'
                    ? 'text-rose-300'
                    : 'text-amber-300'
                }`}
              >
                {techSnapshot.overallBias} ({techSnapshot.bullishSignalsCount}↑/
                {techSnapshot.bearishSignalsCount}↓)
              </span>
            </div>
            <div className="grid grid-cols-4 gap-1.5 text-[10.5px] font-mono-tabular">
              {mtfMatrix.length > 0 ? (
                mtfMatrix.map((row) => (
                  <div
                    key={row.tf}
                    className={`rounded border px-1.5 py-1 text-center ${
                      row.overall === 'Alcista'
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : row.overall === 'Bajista'
                        ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
                        : 'border-white/[0.08] bg-[#0B0E11] text-slate-400'
                    }`}
                  >
                    <div className="font-bold">{row.label}</div>
                    <div className="text-[9.5px] truncate">{row.overall}</div>
                  </div>
                ))
              ) : (
                <div className="col-span-4 text-[11px] text-slate-500 py-1">
                  Cargando matriz 15m/1h/4h/1d...
                </div>
              )}
            </div>
            <div className="flex items-center justify-between text-[10.5px] text-slate-400 font-mono-tabular">
              <span>
                {techSnapshot.isSqueeze ? (
                  <strong className="text-amber-300">SQUEEZE BB ACTIVO</strong>
                ) : (
                  `Divergencias: ${divergences.length}`
                )}
              </span>
              <span>
                RSI {techSnapshot.rsi14[techSnapshot.rsi14.length - 1]?.toFixed(1) ?? '—'}
              </span>
            </div>
          </div>

          {/* 2. VPVR + Fibonacci Golden Pocket + FVG */}
          <div className="bg-[#12161E] border border-white/[0.08] rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1.5 font-semibold text-white">
                <Compass className="w-3.5 h-3.5 text-amber-400" />
                <span>VPVR · Fib · FVG</span>
              </span>
              <span className="font-mono-tabular text-sky-300">
                {confluences.length} clúster(es)
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 text-[10.5px] font-mono-tabular">
              <div className="bg-[#0B0E11] border border-white/[0.06] rounded px-2 py-1">
                <span className="block text-[9.5px] text-slate-500">POC</span>
                <span className="text-amber-300 font-semibold">
                  {volumeProfile ? formatPrice(volumeProfile.poc, asset) : '—'}
                </span>
              </div>
              <div className="bg-[#0B0E11] border border-white/[0.06] rounded px-2 py-1">
                <span className="block text-[9.5px] text-slate-500">VAH</span>
                <span className="text-slate-200">
                  {volumeProfile ? formatPrice(volumeProfile.vah, asset) : '—'}
                </span>
              </div>
              <div className="bg-[#0B0E11] border border-white/[0.06] rounded px-2 py-1">
                <span className="block text-[9.5px] text-slate-500">VAL</span>
                <span className="text-slate-200">
                  {volumeProfile ? formatPrice(volumeProfile.val, asset) : '—'}
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between text-[10.5px] text-slate-400 font-mono-tabular">
              <span className="truncate">
                GP Fib:{' '}
                {fibAnalysis
                  ? `${formatPrice(fibAnalysis.goldenPocketLow, asset)}–${formatPrice(
                      fibAnalysis.goldenPocketHigh,
                      asset
                    )}`
                  : '—'}
              </span>
              <span className="shrink-0 ml-2">FVG: {fvgs.length}</span>
            </div>
          </div>

          {/* 3. OKX Live Taker Tape & Perp Derivatives */}
          <div className="bg-[#12161E] border border-white/[0.08] rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1.5 font-semibold text-white">
                <Waves className="w-3.5 h-3.5 text-emerald-400" />
                <span>Cinta Taker &amp; Flujo OKX</span>
              </span>
              {takerTape ? (
                <span
                  className={`font-mono-tabular font-semibold ${
                    takerTape.netDeltaUsd >= 0 ? 'text-emerald-300' : 'text-rose-300'
                  }`}
                >
                  {takerTape.netDeltaUsd >= 0 ? '+' : '-'}
                  {formatCompactUsd(takerTape.netDeltaUsd)}
                </span>
              ) : (
                <span className="text-slate-500">—</span>
              )}
            </div>
            <div className="space-y-1">
              <div className="h-2 w-full rounded bg-slate-800 overflow-hidden flex">
                <div
                  style={{ width: `${takerTape?.buyRatioPct ?? 50}%` }}
                  className="h-full bg-emerald-500/80"
                />
                <div
                  style={{ width: `${100 - (takerTape?.buyRatioPct ?? 50)}%` }}
                  className="h-full bg-rose-500/80"
                />
              </div>
              <div className="flex items-center justify-between text-[10.5px] font-mono-tabular text-slate-400">
                <span>Compras {(takerTape?.buyRatioPct ?? 50).toFixed(0)}%</span>
                <span>Ventas {(100 - (takerTape?.buyRatioPct ?? 50)).toFixed(0)}%</span>
              </div>
            </div>
            <div className="flex items-center justify-between text-[10.5px] font-mono-tabular">
              <span
                className={
                  takerTape?.absorption.detected ? 'text-amber-300 font-semibold' : 'text-slate-400'
                }
              >
                {takerTape?.absorption.detected
                  ? `Absorción ${takerTape.absorption.side}`
                  : 'Sin absorción anómala'}
              </span>
              {perpTelemetry && perpTelemetry.fundingRatePct !== null && (
                <span className="text-slate-400">
                  FR {perpTelemetry.fundingRatePct >= 0 ? '+' : ''}
                  {perpTelemetry.fundingRatePct.toFixed(4)}%
                </span>
              )}
            </div>
          </div>

          {/* 4. News Sentiment + Rolling Correlation Window (7D / 14D / 30D) */}
          <div className="bg-[#12161E] border border-white/[0.08] rounded-lg p-3 space-y-2">
            <div className="flex items-center justify-between text-[11px] gap-2">
              <span className="flex items-center gap-1.5 font-semibold text-white">
                <Newspaper className="w-3.5 h-3.5 text-violet-400" />
                <span>Macro &amp; Corr. ({corrWindowDays}D)</span>
              </span>
              <div
                className="flex items-center bg-[#0B0E11] p-0.5 rounded border border-white/[0.08]"
                role="group"
                aria-label="Ventana correlación en Opciones"
              >
                {CORR_WINDOWS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => handleCorrWindowChange(w)}
                    className={`px-1.5 py-0.5 rounded text-[9.5px] font-mono-tabular transition-colors ${
                      corrWindowDays === w
                        ? 'bg-[#1F2937] text-white font-semibold'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {w}D
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px] font-mono-tabular">
              <span className="text-slate-400">
                Noticias:{' '}
                <strong
                  className={
                    newsCorrelation.aggregateLabel === 'Alcista'
                      ? 'text-emerald-300'
                      : newsCorrelation.aggregateLabel === 'Bajista'
                      ? 'text-rose-300'
                      : 'text-slate-200'
                  }
                >
                  {newsCorrelation.aggregateLabel} ({newsCorrelation.aggregateScore >= 0 ? '+' : ''}
                  {newsCorrelation.aggregateScore})
                </strong>
              </span>
              <span className="text-slate-400">
                Acierto:{' '}
                <strong className="text-white">
                  {newsCorrelation.directionalHitRatePct !== null
                    ? `${newsCorrelation.directionalHitRatePct.toFixed(0)}%`
                    : '—'}
                </strong>
              </span>
            </div>

            <div className="flex items-center justify-between text-[10.5px] font-mono-tabular text-slate-400">
              <span>
                r BTC:{' '}
                <strong className="text-amber-300">
                  {rollingMacroCorr.latestRBtc !== null
                    ? `${rollingMacroCorr.latestRBtc >= 0 ? '+' : ''}${rollingMacroCorr.latestRBtc.toFixed(2)}`
                    : '—'}
                </strong>{' '}
                · ETH:{' '}
                <strong className="text-sky-300">
                  {rollingMacroCorr.latestREth !== null
                    ? `${rollingMacroCorr.latestREth >= 0 ? '+' : ''}${rollingMacroCorr.latestREth.toFixed(2)}`
                    : '—'}
                </strong>
              </span>
              <span className="truncate ml-2">
                Vol {macroRegime.volPct !== null ? `${macroRegime.volPct.toFixed(2)}%` : '—'}
              </span>
            </div>
          </div>
        </section>

        {/* Implied Volatility Smile by Strike aligned with Support / Resistance levels */}
        <VolatilitySmileChart
          asset={asset}
          spot={spot}
          srZones={srZones}
          optionsLevels={optionsLevels}
          pocPrice={volumeProfile?.poc ?? liquidity.pocPrice}
        />

        {/* Main Grid: Trade Options (Left/Center) + Tabbed Market Intelligence (Right) */}
        <div className="grid grid-cols-1 xl:grid-cols-[1.45fr_1fr] gap-5 items-start">
          {/* Trade Setup Cards */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                <span>
                  Opciones ordenadas por evaluación v1.1 + Análisis Técnico ({displayedIdeas.length})
                </span>
              </h2>
              <span className="text-xs font-mono-tabular text-slate-400">
                Spot actual:{' '}
                <strong className="text-white">{spot > 0 ? formatPrice(spot, asset) : '—'}</strong>
              </span>
            </div>

            {displayedIdeas.length === 0 ? (
              <div className="bg-[#12161E] border border-white/[0.08] rounded-lg p-8 text-center text-xs text-slate-400 space-y-2">
                <div>
                  {onlyOperable || onlyTechAligned
                    ? 'Ninguna opción coincide con los filtros activos (v1.1 / alineación técnica).'
                    : 'Cargando velas y profundidad de liquidez de OKX para generar los escenarios...'}
                </div>
                {(onlyOperable || onlyTechAligned) && allTradeIdeas.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setOnlyOperable(false);
                      setOnlyTechAligned(false);
                    }}
                    className="px-3 py-1.5 rounded bg-[#1F2937] text-white hover:bg-[#2B374A] transition-colors"
                  >
                    Restablecer filtros y ver todas ({allTradeIdeas.length})
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {displayedIdeas.map((idea, index) => {
                  const isLong = idea.direction === 'LONG';
                  const tp1Pct = Math.abs(((idea.takeProfit1 - idea.entry) / idea.entry) * 100);
                  const tp2Pct = Math.abs(((idea.takeProfit2 - idea.entry) / idea.entry) * 100);
                  const slPct = Math.abs(((idea.stopLoss - idea.entry) / idea.entry) * 100);
                  const sc = idea.scoring;
                  const ta = idea.technicalAlignment;

                  const verdictColors =
                    sc?.verdict === 'CANDIDATA'
                      ? 'text-emerald-300 border-emerald-500/40'
                      : sc?.verdict === 'BLOQUEADA'
                      ? 'text-rose-300 border-rose-500/35'
                      : sc?.verdict === 'ESPERAR'
                      ? 'text-amber-300 border-amber-500/35'
                      : 'text-slate-400 border-white/[0.08]';

                  return (
                    <article
                      key={idea.id}
                      className={`bg-[#12161E] border rounded-lg overflow-hidden ${
                        sc?.operable
                          ? 'border-emerald-500/45'
                          : index === 0 && sc
                          ? 'border-white/[0.16]'
                          : 'border-white/[0.08]'
                      }`}
                    >
                      {/* Card Header */}
                      <div className="px-4 py-3 border-b border-white/[0.06] bg-[#111621] flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold font-mono-tabular ${
                              isLong
                                ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                                : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                            }`}
                          >
                            {isLong ? (
                              <ArrowUpRight className="w-3.5 h-3.5" />
                            ) : (
                              <ArrowDownRight className="w-3.5 h-3.5" />
                            )}
                            {idea.direction}
                          </span>
                          <div>
                            <div className="text-sm font-semibold text-white">{idea.title}</div>
                            <div className="text-[11px] text-slate-400 flex flex-wrap items-center gap-1.5">
                              <span>{idea.category}</span>
                              {sc && <span>· {sc.band}</span>}
                              {ta?.confluenceEntryTag && (
                                <span className="text-sky-300">
                                  · Entrada en {ta.confluenceEntryTag}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 text-xs font-mono-tabular">
                          {ta && ta.mtfTotal > 0 && (
                            <span
                              className={`px-2 py-0.5 rounded border bg-[#0B0E11] ${
                                ta.scoreDelta > 0
                                  ? 'border-sky-500/35 text-sky-300'
                                  : ta.scoreDelta < 0
                                  ? 'border-amber-500/35 text-amber-300'
                                  : 'border-white/[0.08] text-slate-300'
                              }`}
                              title="Alineación con la matriz multi-temporal y confluencias de Análisis Técnico"
                            >
                              MTF {ta.mtfAlignedCount}/{ta.mtfTotal} · ΔTéc{' '}
                              {ta.scoreDelta >= 0 ? '+' : ''}
                              {ta.scoreDelta}
                            </span>
                          )}
                          {sc ? (
                            <>
                              <span
                                className={`px-2 py-0.5 rounded border bg-[#0B0E11] font-semibold ${verdictColors}`}
                              >
                                {sc.verdict === 'CANDIDATA' ? 'ABRIR · CANDIDATA' : sc.verdict}
                              </span>
                              <span className="px-2 py-0.5 rounded bg-[#0B0E11] border border-white/[0.1] text-white font-bold">
                                {sc.v11Score.toFixed(1)}/100
                              </span>
                            </>
                          ) : (
                            <span className="px-2 py-0.5 rounded bg-[#0B0E11] border border-white/[0.1] text-sky-300 font-semibold">
                              Base {idea.confidenceScore}/100
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="p-4 space-y-3.5">
                        <p className="text-xs text-slate-300 leading-relaxed">{idea.summary}</p>

                        {/* 5 Core Fields: Entrada, Cantidad, TP1, TP2, Stoploss */}
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 font-mono-tabular">
                          <div className="bg-[#0B0E11] border border-white/[0.08] rounded-md p-2.5">
                            <div className="text-[10px] text-slate-400 uppercase">Entrada</div>
                            <div className="text-sm font-bold text-white mt-0.5">
                              {formatPrice(idea.entry, asset)}
                            </div>
                            <div className="text-[10px] text-slate-500 mt-0.5 font-sans truncate">
                              {ta?.confluenceEntryTag ?? 'Zona límite / pull'}
                            </div>
                          </div>

                          <div className="bg-[#0B0E11] border border-white/[0.08] rounded-md p-2.5">
                            <div className="text-[10px] text-slate-400 uppercase">Cantidad</div>
                            <div className="text-sm font-bold text-sky-300 mt-0.5">
                              {idea.quantity.toFixed(asset === 'BTC' ? 4 : 3)} {asset}
                            </div>
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              ≈ {formatCompactUsd(idea.notionalUsd)} nocional
                            </div>
                          </div>

                          <div className="bg-[#0B0E11] border border-emerald-500/25 rounded-md p-2.5">
                            <div className="flex items-center justify-between text-[10px] text-emerald-400 uppercase">
                              <span>Take Profit 1</span>
                              <span>
                                {sc ? `Neto ${sc.netRR.toFixed(1)}R` : `${idea.rr1.toFixed(1)}R`}
                              </span>
                            </div>
                            <div className="text-sm font-bold text-emerald-300 mt-0.5">
                              {formatPrice(idea.takeProfit1, asset)}
                            </div>
                            <div
                              className="text-[10px] text-slate-400 mt-0.5 truncate"
                              title={idea.tp1Reason}
                            >
                              +{tp1Pct.toFixed(2)}%
                              {idea.tp1ProbPct !== null ? ` · Cono ${idea.tp1ProbPct}%` : ''}
                            </div>
                          </div>

                          <div className="bg-[#0B0E11] border border-emerald-500/35 rounded-md p-2.5">
                            <div className="flex items-center justify-between text-[10px] text-emerald-400 uppercase">
                              <span>Take Profit 2</span>
                              <span>{idea.rr2.toFixed(1)}R</span>
                            </div>
                            <div className="text-sm font-bold text-emerald-300 mt-0.5">
                              {formatPrice(idea.takeProfit2, asset)}
                            </div>
                            <div
                              className="text-[10px] text-slate-400 mt-0.5 truncate"
                              title={idea.tp2Reason}
                            >
                              +{tp2Pct.toFixed(2)}%
                              {idea.tp2ProbPct !== null ? ` · Cono ${idea.tp2ProbPct}%` : ''}
                            </div>
                          </div>

                          <div className="col-span-2 sm:col-span-1 bg-[#0B0E11] border border-rose-500/30 rounded-md p-2.5">
                            <div className="flex items-center justify-between text-[10px] text-rose-400 uppercase">
                              <span>Stoploss</span>
                              <span>-${idea.riskUsd.toFixed(0)}</span>
                            </div>
                            <div className="text-sm font-bold text-rose-300 mt-0.5">
                              {formatPrice(idea.stopLoss, asset)}
                            </div>
                            <div
                              className="text-[10px] text-slate-400 mt-0.5 truncate"
                              title={idea.slReason}
                            >
                              −{slPct.toFixed(2)}% · {idea.slReason}
                            </div>
                          </div>
                        </div>

                        {/* New Technical Analysis & Macro Correlation Validation Block */}
                        {ta &&
                          (ta.alignedFactors.length > 0 ||
                            ta.conflictingFactors.length > 0 ||
                            ta.macroSensitivityNote) && (
                            <div className="bg-[#0B0E11] border border-sky-500/20 rounded-md p-3 space-y-1.5 text-[11px]">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-semibold text-sky-300">
                                  Validación Análisis Técnico &amp; Sensibilidad Macro ({corrWindowDays}D)
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setActiveTab('technical')}
                                  className="text-[10.5px] text-sky-400 hover:text-sky-200 underline-offset-2 hover:underline"
                                >
                                  Inspeccionar niveles en Análisis Técnico
                                </button>
                              </div>

                              {ta.alignedFactors.length > 0 && (
                                <div className="text-emerald-300">
                                  <strong className="font-medium">A favor:</strong>{' '}
                                  {ta.alignedFactors.join(' · ')}
                                </div>
                              )}

                              {ta.conflictingFactors.length > 0 && (
                                <div className="text-amber-300">
                                  <strong className="font-medium">Alertas / fricción:</strong>{' '}
                                  {ta.conflictingFactors.join(' · ')}
                                </div>
                              )}

                              {ta.macroSensitivityNote && (
                                <div className="text-slate-400">{ta.macroSensitivityNote}</div>
                              )}
                            </div>
                          )}

                        {/* Sistema de Puntuación v1.1 Gates Checklist */}
                        {sc && (
                          <div className="bg-[#0B0E11] border border-white/[0.07] rounded-md p-3 space-y-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                              <span className="font-semibold text-slate-200">
                                Filtros de apertura (Sistema de Puntuación v1.1)
                              </span>
                              <span className="font-mono-tabular text-slate-400">
                                Coste/Riesgo bruto: {sc.costToRiskPct.toFixed(1)}% · Condiciones ≥75:{' '}
                                {sc.fulfilledConditions.length}
                              </span>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-6 gap-1.5 text-[11px] font-mono-tabular">
                              {sc.gates.map((g) => (
                                <div
                                  key={g.id}
                                  className={`flex items-center justify-between px-2 py-1 rounded border ${
                                    g.passed
                                      ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300'
                                      : 'border-rose-500/25 bg-rose-500/5 text-rose-300'
                                  }`}
                                >
                                  <span className="flex items-center gap-1 truncate">
                                    {g.passed ? (
                                      <CheckCircle2 className="w-3 h-3 shrink-0" />
                                    ) : (
                                      <XCircle className="w-3 h-3 shrink-0" />
                                    )}
                                    <span>{g.label}</span>
                                  </span>
                                  <span className="font-semibold ml-1">{g.valueText}</span>
                                </div>
                              ))}
                            </div>

                            {sc.blockReasons.length > 0 && (
                              <div className="text-[11px] text-amber-300">
                                <strong className="font-semibold">
                                  Motivos para esperar / bloqueo:
                                </strong>{' '}
                                {sc.blockReasons.join(' · ')}
                              </div>
                            )}

                            {sc.fulfilledConditions.length > 0 && (
                              <div className="text-[11px] text-slate-400">
                                <strong className="text-emerald-300 font-medium">
                                  Condiciones v1.1 cumplidas:
                                </strong>{' '}
                                {sc.fulfilledConditions.join(' · ')}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Targets Justification + Confluences */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-slate-400 pt-1">
                          <div>
                            <span className="text-emerald-400 font-medium">TP1:</span>{' '}
                            {idea.tp1Reason}
                          </div>
                          <div>
                            <span className="text-emerald-400 font-medium">TP2:</span>{' '}
                            {idea.tp2Reason}
                          </div>
                        </div>

                        <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1.5 border-t border-white/[0.06] text-[11px] text-slate-300 font-mono-tabular">
                          {idea.confluences.map((c, idx) => (
                            <span key={c}>
                              {idx > 0 && (
                                <span aria-hidden="true" className="text-slate-600 mr-3">
                                  ·
                                </span>
                              )}
                              {c}
                            </span>
                          ))}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {/* Right Column: Tabbed Market Liquidity + Technical Confluences + Taker Flow & Macro */}
          <aside className="bg-[#12161E] border border-white/[0.08] rounded-lg overflow-hidden">
            <div className="px-4 pt-3 pb-0 border-b border-white/[0.08] bg-[#111621] space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Layers className="w-4 h-4 text-sky-400" />
                    <span>Contexto Estructural y Flujo</span>
                  </h2>
                  <p className="text-[11px] text-slate-400">
                    Libro OKX, clústeres VPVR/Fib/FVG, cinta Taker y correlación macro
                  </p>
                </div>
                <Activity className="w-4 h-4 text-slate-500" />
              </div>

              <div className="grid grid-cols-3 gap-1 text-xs">
                {(
                  [
                    { id: 'liquidity', label: 'Liquidez' },
                    { id: 'confluence', label: `Confluencias (${confluences.length})` },
                    { id: 'flow_macro', label: 'Flujo & Macro' },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setRightSidebarTab(t.id)}
                    className={`py-2 px-2 text-center font-medium border-b-2 transition-colors ${
                      rightSidebarTab === t.id
                        ? 'border-sky-400 text-white'
                        : 'border-transparent text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-4 space-y-4">
              {rightSidebarTab === 'liquidity' && (
                <>
                  {/* Orderbook Imbalance Bar */}
                  <div className="bg-[#0B0E11] border border-white/[0.08] rounded-md p-3 space-y-2">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-400">
                        Desequilibrio libro OKX (top 400 niveles)
                      </span>
                      <span
                        className={`font-mono-tabular font-semibold ${
                          liquidity.imbalancePct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {liquidity.imbalancePct >= 0 ? '+' : ''}
                        {liquidity.imbalancePct.toFixed(1)}%
                      </span>
                    </div>
                    <div className="h-2.5 w-full rounded overflow-hidden flex bg-slate-800">
                      <div
                        style={{ width: `${bidSharePct}%` }}
                        className="h-full bg-emerald-500/80 transition-all"
                      />
                      <div
                        style={{ width: `${100 - bidSharePct}%` }}
                        className="h-full bg-rose-500/80 transition-all"
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10.5px] font-mono-tabular text-slate-400">
                      <span>Bids: {formatCompactUsd(liquidity.bidTotalUsd)}</span>
                      <span>Asks: {formatCompactUsd(liquidity.askTotalUsd)}</span>
                    </div>
                  </div>

                  {/* Key Liquidity Anchors Summary */}
                  <div className="grid grid-cols-2 gap-2 text-[11px] font-mono-tabular">
                    <div className="bg-[#0B0E11] border border-white/[0.08] rounded p-2">
                      <div className="text-[10px] text-slate-500">Muro Ask más fuerte</div>
                      <div className="text-rose-300 font-semibold">
                        {liquidity.strongestAskWall
                          ? `${formatPrice(liquidity.strongestAskWall.price, asset)} (${formatCompactUsd(
                              liquidity.strongestAskWall.notionalUsd
                            )})`
                          : '—'}
                      </div>
                    </div>
                    <div className="bg-[#0B0E11] border border-white/[0.08] rounded p-2">
                      <div className="text-[10px] text-slate-500">Muro Bid más fuerte</div>
                      <div className="text-emerald-300 font-semibold">
                        {liquidity.strongestBidWall
                          ? `${formatPrice(liquidity.strongestBidWall.price, asset)} (${formatCompactUsd(
                              liquidity.strongestBidWall.notionalUsd
                            )})`
                          : '—'}
                      </div>
                    </div>
                    <div className="bg-[#0B0E11] border border-white/[0.08] rounded p-2">
                      <div className="text-[10px] text-slate-500">Pool BSL superior</div>
                      <div className="text-rose-300 font-semibold">
                        {liquidity.nearestBSL ? formatPrice(liquidity.nearestBSL.price, asset) : '—'}
                      </div>
                    </div>
                    <div className="bg-[#0B0E11] border border-white/[0.08] rounded p-2">
                      <div className="text-[10px] text-slate-500">Pool SSL inferior</div>
                      <div className="text-emerald-300 font-semibold">
                        {liquidity.nearestSSL ? formatPrice(liquidity.nearestSSL.price, asset) : '—'}
                      </div>
                    </div>
                  </div>

                  {/* Sorted Ladder of Market Liquidity Levels */}
                  <div className="border border-white/[0.08] rounded-md bg-[#0B0E11] divide-y divide-white/[0.05] max-h-[410px] overflow-y-auto">
                    {liquidity.levels.length === 0 ? (
                      <div className="p-4 text-center text-xs text-slate-500">
                        Esperando datos de liquidez...
                      </div>
                    ) : (
                      liquidity.levels.map((lvl) => {
                        const distPct = spot > 0 ? ((lvl.price - spot) / spot) * 100 : 0;
                        return (
                          <div key={lvl.id} className="px-3 py-2 text-xs space-y-1 hover:bg-white/[0.03]">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span
                                  className={`px-1.5 py-0.5 rounded border text-[9.5px] font-mono-tabular font-semibold shrink-0 ${levelBadgeStyle(
                                    lvl.type
                                  )}`}
                                >
                                  {lvl.type.replace('_', ' ')}
                                </span>
                                <span className="text-slate-200 font-medium truncate">{lvl.label}</span>
                              </div>
                              <div className="flex items-center gap-2 font-mono-tabular shrink-0">
                                <span
                                  className={`text-[10.5px] ${
                                    distPct >= 0 ? 'text-rose-400' : 'text-emerald-400'
                                  }`}
                                >
                                  {distPct >= 0 ? '+' : ''}
                                  {distPct.toFixed(2)}%
                                </span>
                                <span className="text-white font-semibold">
                                  {formatPrice(lvl.price, asset)}
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center justify-between gap-2 text-[10.5px] text-slate-400">
                              <span className="truncate">{lvl.detail}</span>
                              <div className="w-16 h-1.5 bg-slate-800 rounded overflow-hidden shrink-0">
                                <div
                                  style={{ width: `${lvl.strength}%` }}
                                  className={`h-full ${
                                    lvl.side === 'above' ? 'bg-rose-500/80' : 'bg-emerald-500/80'
                                  }`}
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              )}

              {rightSidebarTab === 'confluence' && (
                <div className="space-y-4">
                  {/* Confluence Clusters */}
                  <div className="space-y-2">
                    <div className="text-[11px] font-semibold text-white">
                      Clústeres Multi-Factor (±0.30%)
                    </div>
                    {confluences.length === 0 ? (
                      <div className="bg-[#0B0E11] border border-white/[0.08] rounded p-3 text-xs text-slate-500">
                        Sin clústeres de 2+ factores cercanos al precio actual.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {confluences.map((cl) => (
                          <div
                            key={cl.id}
                            className="bg-[#0B0E11] border border-white/[0.08] rounded p-2.5 text-xs space-y-1"
                          >
                            <div className="flex items-center justify-between font-mono-tabular">
                              <span className="text-white font-semibold">
                                {formatPrice(cl.avgPrice, asset)}
                              </span>
                              <span
                                className={
                                  cl.kind === 'resistencia'
                                    ? 'text-rose-300'
                                    : cl.kind === 'soporte'
                                    ? 'text-emerald-300'
                                    : 'text-amber-300'
                                }
                              >
                                {cl.factorCount} factores · {cl.distancePct >= 0 ? '+' : ''}
                                {cl.distancePct.toFixed(2)}%
                              </span>
                            </div>
                            <div className="text-[10.5px] text-slate-400">
                              {cl.factors.join(' + ')}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Active Unmitigated FVGs */}
                  <div className="space-y-2">
                    <div className="text-[11px] font-semibold text-white">
                      Fair Value Gaps (FVG sin mitigar)
                    </div>
                    {fvgs.length === 0 ? (
                      <div className="bg-[#0B0E11] border border-white/[0.08] rounded p-3 text-xs text-slate-500">
                        Sin desequilibrios FVG activos sin mitigar.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {fvgs.slice(0, 4).map((g) => (
                          <div
                            key={g.id}
                            className="bg-[#0B0E11] border border-white/[0.08] rounded px-2.5 py-2 flex items-center justify-between text-[11px] font-mono-tabular"
                          >
                            <span
                              className={
                                g.direction === 'bullish' ? 'text-emerald-300' : 'text-rose-300'
                              }
                            >
                              {g.direction === 'bullish' ? 'FVG Alcista' : 'FVG Bajista'}
                            </span>
                            <span className="text-slate-200">
                              {formatPrice(g.bottom, asset)} – {formatPrice(g.top, asset)}
                            </span>
                            <span className="text-slate-400">
                              {g.distancePct >= 0 ? '+' : ''}
                              {g.distancePct.toFixed(2)}%
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Divergences */}
                  <div className="space-y-2">
                    <div className="text-[11px] font-semibold text-white">
                      Divergencias RSI / MACD / CVD
                    </div>
                    {divergences.length === 0 ? (
                      <div className="bg-[#0B0E11] border border-white/[0.08] rounded p-3 text-xs text-slate-500">
                        Sin divergencias activas confirmadas en pivotes recientes.
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {divergences.slice(0, 4).map((d) => (
                          <div
                            key={d.id}
                            className="bg-[#0B0E11] border border-white/[0.08] rounded p-2 text-[11px] space-y-0.5"
                          >
                            <div className="flex items-center justify-between font-mono-tabular">
                              <span
                                className={
                                  d.kind.startsWith('bullish')
                                    ? 'text-emerald-300 font-semibold'
                                    : 'text-rose-300 font-semibold'
                                }
                              >
                                {d.label}
                              </span>
                              <span className="text-slate-300">{formatPrice(d.price, asset)}</span>
                            </div>
                            <div className="text-slate-400 text-[10.5px]">{d.summary}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {rightSidebarTab === 'flow_macro' && (
                <div className="space-y-4">
                  {/* Taker Flow Breakdown */}
                  <div className="bg-[#0B0E11] border border-white/[0.08] rounded-md p-3 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-white">
                        Flujo Taker en vivo ({techMarketMode === 'perp' ? 'SWAP' : 'Spot'})
                      </span>
                      {takerTape && (
                        <span className="font-mono-tabular text-slate-400">
                          Δ {(takerTape.priceChangePct >= 0 ? '+' : '') + takerTape.priceChangePct.toFixed(2)}%
                        </span>
                      )}
                    </div>
                    {takerTape ? (
                      <>
                        <div className="grid grid-cols-2 gap-2 font-mono-tabular text-[11px]">
                          <div className="bg-[#12161E] rounded p-2">
                            <div className="text-[10px] text-slate-400">Volumen Comprador</div>
                            <div className="text-emerald-300 font-semibold">
                              {formatCompactUsd(takerTape.buyUsd)} ({takerTape.buyRatioPct.toFixed(0)}%)
                            </div>
                          </div>
                          <div className="bg-[#12161E] rounded p-2">
                            <div className="text-[10px] text-slate-400">Volumen Vendedor</div>
                            <div className="text-rose-300 font-semibold">
                              {formatCompactUsd(takerTape.sellUsd)} (
                              {(100 - takerTape.buyRatioPct).toFixed(0)}%)
                            </div>
                          </div>
                        </div>
                        <div
                          className={`text-[11px] ${
                            takerTape.absorption.detected ? 'text-amber-300' : 'text-slate-400'
                          }`}
                        >
                          {takerTape.absorption.summary}
                        </div>
                      </>
                    ) : (
                      <div className="text-slate-500">Cargando cinta Taker OKX...</div>
                    )}
                  </div>

                  {/* News Sentiment & Rolling Macro Correlation Details */}
                  <div className="bg-[#0B0E11] border border-white/[0.08] rounded-md p-3 space-y-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-white">
                        Correlación Macro/Noticias vs Volatilidad ({corrWindowDays}D)
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-300">
                      {rollingMacroCorr.regimeLabel}
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {newsCorrelation.regimeSummary}
                    </div>
                    <div className="grid grid-cols-2 gap-2 font-mono-tabular text-[11px] pt-1">
                      <div className="bg-[#12161E] rounded p-2">
                        <span className="block text-[10px] text-slate-400">
                          Pearson r BTC ({corrWindowDays}D)
                        </span>
                        <span className="text-amber-300 font-semibold">
                          {rollingMacroCorr.latestRBtc !== null
                            ? `${rollingMacroCorr.latestRBtc >= 0 ? '+' : ''}${rollingMacroCorr.latestRBtc.toFixed(2)}`
                            : '—'}
                        </span>
                      </div>
                      <div className="bg-[#12161E] rounded p-2">
                        <span className="block text-[10px] text-slate-400">
                          Pearson r ETH ({corrWindowDays}D)
                        </span>
                        <span className="text-sky-300 font-semibold">
                          {rollingMacroCorr.latestREth !== null
                            ? `${rollingMacroCorr.latestREth >= 0 ? '+' : ''}${rollingMacroCorr.latestREth.toFixed(2)}`
                            : '—'}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab('technical')}
                      className="w-full py-1.5 rounded bg-[#1F2937] hover:bg-[#2B374A] text-white text-xs font-medium transition-colors"
                    >
                      Ver curva histórica {corrWindowDays}D en Análisis Técnico
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-start gap-2 text-[11px] text-slate-500 pt-1">
                <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
                <span>
                  Los escenarios no ejecutan órdenes reales y deben validarse con tu propia gestión
                  del riesgo.
                </span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
