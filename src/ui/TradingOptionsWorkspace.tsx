import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CheckCircle2,
  ExternalLink,
  Layers,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Target,
  TrendingUp,
  XCircle,
} from 'lucide-react';
import { calculateExpectedRangeCone, getAtTheMoneyIV } from '../calc/cone';
import { analyzeMarketLiquidity } from '../calc/liquidity';
import { aggregateStrikes, calculateLevels } from '../calc/options';
import { evaluateScoringSystem } from '../calc/scoringEngine';
import { generateTradingOptions } from '../calc/tradeSetups';
import { fetchScoringDataset } from '../data/okxScoringClient';
import { useTerminalStore } from '../store/terminalStore';
import type { LiquidityLevelType, SymbolAsset, Timeframe } from '../types/market';
import type { MultiTfScoringDataset } from '../types/scoring';

const QUICK_TFS: { value: Timeframe; label: string }[] = [
  { value: '1m', label: '1m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '1H', label: '1h' },
  { value: '4H', label: '4h' },
  { value: 'D', label: '1d' },
];

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
    scoringConfig,
    setScoringConfig,
  } = useTerminalStore();

  const [onlyOperable, setOnlyOperable] = useState(false);

  const [scoringDataset, setScoringDataset] = useState<MultiTfScoringDataset | null>(null);
  const [scoringLoading, setScoringLoading] = useState(false);

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

  const spot = ticker?.idxPx ?? candles[candles.length - 1]?.c ?? 0;

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
      analyzeMarketLiquidity(candles, spot, optionsLevels, orderbook, prevDayHigh, prevDayLow),
    [candles, spot, optionsLevels, orderbook, prevDayHigh, prevDayLow]
  );

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
        candles,
        spot,
        optionsLevels,
        cone,
        liquidity,
        capitalUsd: scoringConfig.capitalUsd,
        riskPct: scoringConfig.riskPct,
        scoring: scoringResult,
        spreadPct: orderbook?.spreadPct ?? 0.02,
        feePctPerSide: scoringConfig.feePctPerSide,
        slippagePctPerSide: scoringConfig.slippagePctPerSide,
      }),
    [
      asset,
      timeframe,
      candles,
      spot,
      optionsLevels,
      cone,
      liquidity,
      scoringConfig.capitalUsd,
      scoringConfig.riskPct,
      scoringConfig.feePctPerSide,
      scoringConfig.slippagePctPerSide,
      scoringResult,
      orderbook?.spreadPct,
    ]
  );

  const operableIdeas = useMemo(
    () => allTradeIdeas.filter((i) => i.scoring?.operable),
    [allTradeIdeas]
  );

  const displayedIdeas = useMemo(
    () => (onlyOperable ? operableIdeas : allTradeIdeas),
    [onlyOperable, operableIdeas, allTradeIdeas]
  );

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
              <span>OPCIONES DE TRADING · EVALUADOR v1.1 + LIQUIDEZ + GEX + CONO IV</span>
            </div>
            <h1 className="text-lg font-semibold text-white">
              Escenarios evaluados para {asset}-USD ({timeframe})
            </h1>
            <p className="text-xs text-slate-400 max-w-2xl">
              Cada escenario se filtra y ordena en vivo mediante el Sistema de Puntuación v1.1
              (4h/1h/15m, OI, funding 90d, costes lineales y liquidez OKX). Uso estrictamente
              analítico.
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
              <span className="block text-[10px] text-slate-400 mb-1">Perfil v1.1</span>
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
                {!bestCandidate && topScoredIdea?.scoring && topScoredIdea.scoring.blockReasons.length > 0 && (
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
                : `Mostrar todas (${allTradeIdeas.length})`}
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
              onClick={() => setActiveTab('scoring')}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[#0B0E11] hover:bg-[#19202D] border border-white/[0.08] text-sky-300 whitespace-nowrap"
            >
              <span>Ver matriz completa</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </button>
          </div>
        </section>

        {/* Main Grid: Trade Options (Left/Center) + Market Liquidity Analysis (Right) */}
        <div className="grid grid-cols-1 xl:grid-cols-[1.45fr_1fr] gap-5 items-start">
          {/* Trade Setup Cards */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                <span>
                  Opciones ordenadas por evaluación v1.1 ({displayedIdeas.length})
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
                  {onlyOperable
                    ? 'Ninguna opción cumple simultáneamente todos los requisitos del Sistema de Puntuación v1.1 en este cierre.'
                    : 'Cargando velas y profundidad de liquidez de OKX para generar los escenarios...'}
                </div>
                {onlyOperable && allTradeIdeas.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setOnlyOperable(false)}
                    className="px-3 py-1.5 rounded bg-[#1F2937] text-white hover:bg-[#2B374A] transition-colors"
                  >
                    Ver todas las opciones y sus bloqueos ({allTradeIdeas.length})
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
                            <div className="text-[11px] text-slate-400">
                              {idea.category}
                              {sc ? ` · ${sc.band}` : ''}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 text-xs font-mono-tabular">
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
                            <div className="text-[10px] text-slate-500 mt-0.5 font-sans">
                              Zona límite / pull
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
                                <strong className="font-semibold">Motivos para esperar / bloqueo:</strong>{' '}
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

          {/* Right Column: Market Liquidity Levels Map */}
          <aside className="bg-[#12161E] border border-white/[0.08] rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.08] bg-[#111621] flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                  <Layers className="w-4 h-4 text-sky-400" />
                  <span>Niveles de liquidez del mercado</span>
                </h2>
                <p className="text-[11px] text-slate-400">
                  Libro OKX en vivo + pools BSL/SSL + POC + muros de opciones
                </p>
              </div>
              <Activity className="w-4 h-4 text-slate-500" />
            </div>

            <div className="p-4 space-y-4">
              {/* Orderbook Imbalance Bar */}
              <div className="bg-[#0B0E11] border border-white/[0.08] rounded-md p-3 space-y-2">
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-slate-400">Desequilibrio libro OKX (top 400 niveles)</span>
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
              <div className="border border-white/[0.08] rounded-md bg-[#0B0E11] divide-y divide-white/[0.05] max-h-[430px] overflow-y-auto">
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
