import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  CheckCircle2,
  Clock,
  ExternalLink,
  History,
  RefreshCw,
  ShieldCheck,
  Target,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  auditHistoricalSignalsFromCandles,
  computeEffectivenessSummary,
  DEFAULT_SIGNAL_HORIZON_BARS,
  evaluateSignalAgainstCandles,
  mergeSignalsIntoHistory,
  type EffectivenessBreakdownItem,
  type SignalEffectivenessStatus,
  type TrackedOptionSignal,
} from '../calc/signalEffectiveness';
import { calculateLevels, aggregateStrikes } from '../calc/options';
import { fetchTechnicalMarketCandles, type TechnicalMarketMode } from '../data/okxTechnicalClient';
import { useTerminalStore } from '../store/terminalStore';
import type { Candle, SymbolAsset, Timeframe } from '../types/market';
import { SignalStrategyStackedDashboard } from './components/SignalStrategyStackedDashboard';

type OriginFilter = 'all' | 'live' | 'audit';
type AssetFilter = 'all' | SymbolAsset;
type StatusFilter = 'all' | 'evaluated' | 'fulfilled' | 'stop' | 'open';
type BreakdownTab = 'category' | 'tech' | 'verdict' | 'direction_asset';

const HORIZON_OPTIONS = [12, 24, 48] as const;

function formatPrice(val: number | null, asset: SymbolAsset): string {
  if (val === null || !Number.isFinite(val)) return '—';
  return `$${val.toLocaleString('en-US', {
    minimumFractionDigits: asset === 'BTC' ? 1 : 2,
    maximumFractionDigits: asset === 'BTC' ? 1 : 2,
  })}`;
}

function formatUtcCompact(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toISOString().slice(5, 16).replace('T', ' ');
}

function statusMeta(status: SignalEffectivenessStatus): {
  label: string;
  textClass: string;
} {
  switch (status) {
    case 'CUMPLIDA_TP2':
      return { label: 'TP2 Cumplida', textClass: 'text-emerald-300' };
    case 'CUMPLIDA_TP1':
      return { label: 'TP1 Cumplida', textClass: 'text-emerald-400' };
    case 'FALLIDA_STOP':
      return { label: 'Stop Loss', textClass: 'text-rose-400' };
    case 'ACTIVA':
      return { label: 'En curso', textClass: 'text-sky-300' };
    case 'PENDIENTE':
      return { label: 'Pendiente entrada', textClass: 'text-amber-300' };
    case 'EXPIRADA':
      return { label: 'Expirada', textClass: 'text-slate-400' };
  }
}

function indexColorClass(pct: number | null): string {
  if (pct === null) return 'text-slate-300';
  if (pct >= 68) return 'text-emerald-300';
  if (pct >= 45) return 'text-amber-300';
  return 'text-rose-300';
}

function barFillClass(pct: number | null): string {
  if (pct === null) return 'bg-slate-600';
  if (pct >= 68) return 'bg-emerald-500';
  if (pct >= 45) return 'bg-amber-500';
  return 'bg-rose-500';
}

function SignalTrailChart({ signal }: { signal: TrackedOptionSignal }) {
  const bars = signal.trailBars;
  const w = 640;
  const h = 210;
  const padL = 12;
  const padR = 76;
  const padT = 16;
  const padB = 26;

  const refPrices = [signal.entry, signal.stopLoss, signal.takeProfit1, signal.takeProfit2];
  for (const b of bars) {
    refPrices.push(b.h, b.l);
  }
  const minP = Math.min(...refPrices);
  const maxP = Math.max(...refPrices);
  const span = Math.max(signal.entry * 0.002, maxP - minP);
  const lo = minP - span * 0.08;
  const hi = maxP + span * 0.08;

  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const toY = (p: number) => padT + ((hi - p) / Math.max(1e-9, hi - lo)) * plotH;

  const levels = [
    { label: 'TP2', price: signal.takeProfit2, stroke: '#10b981', text: '#6ee7b7' },
    { label: 'TP1', price: signal.takeProfit1, stroke: '#34d399', text: '#a7f3d0' },
    { label: 'ENT', price: signal.entry, stroke: '#38bdf8', text: '#7dd3fc' },
    { label: 'SL', price: signal.stopLoss, stroke: '#f43f5e', text: '#fda4af' },
  ];

  const count = Math.max(1, bars.length);
  const stepX = count > 1 ? plotW / (count - 1) : plotW * 0.5;
  const candleW = Math.max(4, Math.min(14, (plotW / Math.max(6, count)) * 0.55));

  return (
    <div className="bg-[#0B0E11] border border-white/[0.08] rounded-lg p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2 text-[11px]">
        <span className="font-medium text-slate-200">
          Desarrollo posterior real OKX ({bars.length} velas {signal.timeframe} posteriores a{' '}
          <span className="font-mono-tabular text-slate-300">
            {formatUtcCompact(signal.candleOpenTs)} UTC
          </span>
          )
        </span>
        <span className="font-mono-tabular text-slate-400">
          Spot señal: {formatPrice(signal.spotAtSignal, signal.asset)} · MFE{' '}
          <span className="text-emerald-300">+{signal.maxFavorablePct.toFixed(2)}%</span> · MAE{' '}
          <span className="text-rose-300">-{signal.maxAdversePct.toFixed(2)}%</span>
        </span>
      </div>

      {bars.length === 0 ? (
        <div className="h-[140px] flex items-center justify-center text-xs text-slate-500">
          Esperando el cierre de las siguientes velas reales en OKX ({signal.asset} {signal.timeframe}).
        </div>
      ) : (
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto overflow-visible select-none">
          {/* Reference Target / Stop Horizontal Lines */}
          {levels.map((lv) => {
            const y = toY(lv.price);
            return (
              <g key={lv.label}>
                <line
                  x1={padL}
                  y1={y}
                  x2={w - padR}
                  y2={y}
                  stroke={lv.stroke}
                  strokeWidth={1}
                  strokeDasharray={lv.label === 'ENT' ? '2 2' : '4 3'}
                  opacity={0.75}
                />
                <text
                  x={w - padR + 6}
                  y={y + 3.5}
                  fill={lv.text}
                  fontSize="9.5"
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                >
                  {lv.label} {formatPrice(lv.price, signal.asset)}
                </text>
              </g>
            );
          })}

          {/* Candlesticks for Subsequent Bars */}
          {bars.map((b, idx) => {
            const x = count === 1 ? padL + plotW * 0.25 : padL + idx * stepX;
            const yH = toY(b.h);
            const yL = toY(b.l);
            const yO = toY(b.o);
            const yC = toY(b.c);
            const bull = b.c >= b.o;
            const color = bull ? '#10b981' : '#f43f5e';
            const topBody = Math.min(yO, yC);
            const bodyH = Math.max(1.5, Math.abs(yC - yO));

            return (
              <g key={b.t}>
                <line x1={x} y1={yH} x2={x} y2={yL} stroke={color} strokeWidth={1.2} />
                <rect
                  x={x - candleW * 0.5}
                  y={topBody}
                  width={candleW}
                  height={bodyH}
                  fill={color}
                  rx={1}
                  opacity={0.9}
                />
              </g>
            );
          })}

          {/* X Axis labels */}
          <text
            x={padL}
            y={h - 6}
            fill="#64748b"
            fontSize="9.5"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          >
            +1v ({formatUtcCompact(bars[0].t)})
          </text>
          {bars.length > 1 && (
            <text
              x={w - padR}
              y={h - 6}
              textAnchor="end"
              fill="#64748b"
              fontSize="9.5"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              +{bars.length}v ({formatUtcCompact(bars[bars.length - 1].t)})
            </text>
          )}
        </svg>
      )}
    </div>
  );
}

function EffectivenessEvolutionChart({
  timeline,
}: {
  timeline: ReturnType<typeof computeEffectivenessSummary>['timeline'];
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (timeline.length === 0) {
    return (
      <div className="h-[220px] flex items-center justify-center text-xs text-slate-500 text-center px-4">
        Se necesitan señales evaluadas (con entrada ejecutada y desarrollo posterior en el gráfico)
        para trazar la evolución del Índice de Efectividad (0–100%).
      </div>
    );
  }

  const w = 620;
  const h = 220;
  const padL = 38;
  const padR = 16;
  const padT = 18;
  const padB = 26;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const toX = (idx: number) =>
    timeline.length === 1 ? padL + plotW * 0.5 : padL + (idx / (timeline.length - 1)) * plotW;
  const toY = (pct: number) => padT + ((100 - Math.max(0, Math.min(100, pct))) / 100) * plotH;

  const indexPath = timeline
    .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(pt.cumulativeIndexPct).toFixed(1)}`)
    .join(' ');

  const hitRatePath = timeline
    .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toY(pt.cumulativeTpHitRatePct).toFixed(1)}`)
    .join(' ');

  const areaPath =
    timeline.length > 1
      ? `${indexPath} L ${toX(timeline.length - 1).toFixed(1)} ${toY(0).toFixed(1)} L ${toX(0).toFixed(1)} ${toY(0).toFixed(1)} Z`
      : '';

  const activePt = hoverIdx !== null && timeline[hoverIdx] ? timeline[hoverIdx] : timeline[timeline.length - 1];

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono-tabular">
        <div className="flex items-center gap-3 text-slate-400">
          <span className="flex items-center gap-1.5 text-sky-300">
            <span className="w-3 h-0.5 bg-sky-400 inline-block" />
            Índice Acumulado (%)
          </span>
          <span className="flex items-center gap-1.5 text-emerald-300">
            <span className="w-3 h-0.5 bg-emerald-400 inline-block border-b border-dashed" />
            Tasa TP1/TP2 (%)
          </span>
        </div>
        <div className="text-slate-300 truncate max-w-full">
          #{activePt.seq} · {activePt.asset} {activePt.timeframe} {activePt.direction} ·{' '}
          <strong className="text-white">{activePt.cumulativeIndexPct.toFixed(1)}%</strong>
        </div>
      </div>

      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto overflow-visible select-none">
        <defs>
          <linearGradient id="effIndexGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {[0, 25, 50, 75, 100].map((lvl) => {
          const y = toY(lvl);
          return (
            <g key={lvl}>
              <line
                x1={padL}
                y1={y}
                x2={w - padR}
                y2={y}
                stroke={lvl === 50 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)'}
                strokeDasharray={lvl === 50 ? '4 4' : undefined}
              />
              <text
                x={padL - 6}
                y={y + 3}
                textAnchor="end"
                fill="#64748b"
                fontSize="9.5"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {lvl}%
              </text>
            </g>
          );
        })}

        {areaPath && <path d={areaPath} fill="url(#effIndexGrad)" />}
        {timeline.length > 1 && (
          <>
            <path
              d={hitRatePath}
              fill="none"
              stroke="#10b981"
              strokeWidth={1.6}
              strokeDasharray="4 3"
              opacity={0.8}
            />
            <path d={indexPath} fill="none" stroke="#38bdf8" strokeWidth={2.2} />
          </>
        )}

        {timeline.map((pt, idx) => {
          const x = toX(idx);
          const y = toY(pt.cumulativeIndexPct);
          const dotColor =
            pt.signalPoints >= 85
              ? '#10b981'
              : pt.signalPoints === 0
              ? '#f43f5e'
              : '#f59e0b';
          const isHover = hoverIdx === idx;
          return (
            <g
              key={pt.seq}
              onMouseEnter={() => setHoverIdx(idx)}
              onMouseLeave={() => setHoverIdx(null)}
              className="cursor-pointer"
            >
              <circle cx={x} cy={y} r={isHover ? 5 : 3} fill={dotColor} stroke="#0B0E14" strokeWidth={1} />
              <rect x={x - 6} y={padT} width={12} height={plotH} fill="transparent" />
            </g>
          );
        })}

        <text
          x={padL}
          y={h - 6}
          fill="#64748b"
          fontSize="9.5"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        >
          Señal #1 ({formatUtcCompact(timeline[0].ts)})
        </text>
        {timeline.length > 1 && (
          <text
            x={w - padR}
            y={h - 6}
            textAnchor="end"
            fill="#64748b"
            fontSize="9.5"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          >
            Señal #{timeline.length} ({formatUtcCompact(timeline[timeline.length - 1].ts)})
          </text>
        )}
      </svg>
    </div>
  );
}

function BreakdownTable({ rows }: { rows: EffectivenessBreakdownItem[] }) {
  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-slate-500">
        Sin datos suficientes en este desglose todavía.
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {rows.map((row) => (
        <div
          key={row.key}
          className="bg-[#0B0E11] border border-white/[0.06] rounded-md p-2.5 space-y-1.5"
        >
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium text-slate-200 truncate">{row.label}</span>
            <div className="flex items-center gap-3 font-mono-tabular shrink-0">
              <span className="text-[11px] text-slate-400">
                {row.fulfilledCount}/{row.evaluatedCount} TP
              </span>
              <span className={`font-semibold ${indexColorClass(row.indexPct)}`}>
                {row.indexPct !== null ? `${row.indexPct.toFixed(1)}%` : '—'}
              </span>
            </div>
          </div>

          <div className="h-1.5 w-full rounded bg-slate-800 overflow-hidden">
            <div
              className={`h-full transition-all ${barFillClass(row.indexPct)}`}
              style={{ width: `${Math.max(0, Math.min(100, row.indexPct ?? 0))}%` }}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] font-mono-tabular text-slate-400">
            <span>
              TP2 {row.tp2Count} · TP1 {row.tp1Count} · SL {row.stopCount}
              {row.activeCount > 0 ? ` · En curso ${row.activeCount}` : ''}
              {row.pendingCount > 0 ? ` · Pend. ${row.pendingCount}` : ''}
            </span>
            <span>
              Hit {row.tpHitRatePct !== null ? `${row.tpHitRatePct.toFixed(0)}%` : '—'} · R medio{' '}
              <strong
                className={
                  row.avgR !== null && row.avgR > 0
                    ? 'text-emerald-300'
                    : row.avgR !== null && row.avgR < 0
                    ? 'text-rose-300'
                    : 'text-slate-300'
                }
              >
                {row.avgR !== null ? `${row.avgR >= 0 ? '+' : ''}${row.avgR.toFixed(2)}R` : '—'}
              </strong>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function EffectivenessWorkspace() {
  const {
    asset,
    timeframe,
    candles,
    options,
    ticker,
    scoringConfig,
    setActiveTab,
    trackedSignals,
    recordTrackedSignals,
    replaceTrackedSignals,
    clearTrackedSignals,
  } = useTerminalStore();

  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [breakdownTab, setBreakdownTab] = useState<BreakdownTab>('category');
  const [horizonBars, setHorizonBars] = useState<number>(DEFAULT_SIGNAL_HORIZON_BARS);
  const [selectedSignalId, setSelectedSignalId] = useState<string | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const marketMode: TechnicalMarketMode = scoringConfig.mode === 'perpetual' ? 'perp' : 'spot';

  // Re-evaluate all persisted signals against real OKX candles for each unique (asset, timeframe, marketMode)
  const reevaluateAllWithOkx = useCallback(
    async (targetHorizon = horizonBars, silent = false) => {
      const currentSignals = useTerminalStore.getState().trackedSignals;
      if (currentSignals.length === 0) return;

      setSyncing(true);
      if (!silent) setFeedbackMsg(null);

      try {
        const pairKeys = new Map<
          string,
          { asset: SymbolAsset; timeframe: Timeframe; mode: 'perpetual' | 'spot' }
        >();
        for (const sig of currentSignals) {
          const key = `${sig.asset}|${sig.timeframe}|${sig.marketMode}`;
          if (!pairKeys.has(key)) {
            pairKeys.set(key, {
              asset: sig.asset,
              timeframe: sig.timeframe,
              mode: sig.marketMode,
            });
          }
        }

        const candlesByPair = new Map<string, Candle[]>();
        const entries = Array.from(pairKeys.entries());
        const results = await Promise.allSettled(
          entries.map(([, p]) =>
            fetchTechnicalMarketCandles(
              p.asset,
              p.timeframe,
              p.mode === 'perpetual' ? 'perp' : 'spot',
              300
            )
          )
        );

        entries.forEach(([key], idx) => {
          const r = results[idx];
          if (r.status === 'fulfilled' && r.value.length > 0) {
            candlesByPair.set(key, r.value);
          }
        });

        const now = Date.now();
        const updated = currentSignals.map((sig) => {
          const key = `${sig.asset}|${sig.timeframe}|${sig.marketMode}`;
          const c = candlesByPair.get(key);
          if (!c || c.length === 0) return sig;
          return evaluateSignalAgainstCandles(sig, c, targetHorizon, now);
        });

        replaceTrackedSignals(updated);
        if (!silent) {
          setFeedbackMsg(
            `Reevaluadas ${updated.length} señales contra velas reales de OKX (${entries.length} serie${entries.length === 1 ? '' : 's'}).`
          );
        }
      } catch (err) {
        if (!silent) {
          setFeedbackMsg(
            err instanceof Error ? err.message : 'Error consultando velas OKX para reevaluar.'
          );
        }
      } finally {
        setSyncing(false);
      }
    },
    [horizonBars, replaceTrackedSignals]
  );

  // Sync automatically on initial mount if signals exist
  useEffect(() => {
    if (trackedSignals.length > 0) {
      void reevaluateAllWithOkx(horizonBars, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-evaluate immediately when user switches evaluation horizon
  const handleHorizonChange = (nextH: number) => {
    setHorizonBars(nextH);
    if (trackedSignals.length > 0) {
      void reevaluateAllWithOkx(nextH, false);
    }
  };

  // Run walk-forward real historical candle audit on current asset & timeframe
  const handleRunOkxAudit = async () => {
    setAuditing(true);
    setFeedbackMsg(null);
    try {
      const okxCandles = await fetchTechnicalMarketCandles(asset, timeframe, marketMode, 300);
      if (okxCandles.length < 90) {
        setFeedbackMsg('No hay suficientes velas históricas en OKX para auditar este marco temporal.');
        return;
      }

      const spotRef = ticker?.idxPx ?? candles[candles.length - 1]?.c ?? okxCandles[okxCandles.length - 1].c;
      const strikes = aggregateStrikes(options, spotRef, 'ALL');
      const optLvls = calculateLevels(strikes, options, spotRef);

      const audited = auditHistoricalSignalsFromCandles({
        asset,
        timeframe,
        marketMode: scoringConfig.mode,
        candles: okxCandles,
        horizonBars,
        stepBars: 8,
        capitalUsd: scoringConfig.capitalUsd,
        riskPct: scoringConfig.riskPct,
        optionsLevels: optLvls,
      });

      if (audited.length === 0) {
        setFeedbackMsg('No se generaron señales en la ventana histórica auditada.');
        return;
      }

      const merged = mergeSignalsIntoHistory(useTerminalStore.getState().trackedSignals, audited);
      replaceTrackedSignals(merged);
      setFeedbackMsg(
        `Auditoría walk-forward completada: +${audited.length} señales históricas reales (${asset} ${timeframe}) evaluadas vela a vela.`
      );
    } catch (err) {
      setFeedbackMsg(
        err instanceof Error ? err.message : 'Error ejecutando auditoría histórica en OKX.'
      );
    } finally {
      setAuditing(false);
    }
  };

  const filteredSignals = useMemo(() => {
    return trackedSignals.filter((s) => {
      if (originFilter !== 'all' && s.origin !== originFilter) return false;
      if (assetFilter !== 'all' && s.asset !== assetFilter) return false;
      if (statusFilter === 'evaluated' && s.effectivenessPoints === null) return false;
      if (
        statusFilter === 'fulfilled' &&
        s.status !== 'CUMPLIDA_TP1' &&
        s.status !== 'CUMPLIDA_TP2'
      ) {
        return false;
      }
      if (statusFilter === 'stop' && s.status !== 'FALLIDA_STOP') return false;
      if (statusFilter === 'open' && s.status !== 'ACTIVA' && s.status !== 'PENDIENTE') {
        return false;
      }
      return true;
    });
  }, [trackedSignals, originFilter, assetFilter, statusFilter]);

  const summary = useMemo(() => computeEffectivenessSummary(filteredSignals), [filteredSignals]);

  const selectedSignal = useMemo(() => {
    if (selectedSignalId) {
      return filteredSignals.find((s) => s.id === selectedSignalId) ?? null;
    }
    return filteredSignals.find((s) => s.trailBars.length > 0) ?? filteredSignals[0] ?? null;
  }, [filteredSignals, selectedSignalId]);

  const activeBreakdownRows = useMemo(() => {
    switch (breakdownTab) {
      case 'category':
        return summary.byCategory;
      case 'tech':
        return summary.byTechAlignment;
      case 'verdict':
        return summary.byVerdict;
      case 'direction_asset':
        return [...summary.byDirection, ...summary.byAsset];
    }
  }, [breakdownTab, summary]);

  const liveCount = useMemo(
    () => trackedSignals.filter((s) => s.origin === 'live').length,
    [trackedSignals]
  );
  const auditCount = useMemo(
    () => trackedSignals.filter((s) => s.origin === 'audit').length,
    [trackedSignals]
  );

  // Unused import guard cleanup helper (recordTrackedSignals is available if needed)
  void recordTrackedSignals;

  return (
    <div className="flex-1 overflow-y-auto bg-[#0B0E14] text-slate-200">
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-5">
        {/* Top Context & Controls Header */}
        <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs font-mono-tabular text-emerald-400">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>EVALUACIÓN DE EFECTIVIDAD · SEGUIMIENTO REAL vs VELAS OKX</span>
            </div>
            <h1 className="text-lg font-semibold text-white">
              Índice de Efectividad de Señales ({summary.effectivenessIndexPct !== null ? `${summary.effectivenessIndexPct.toFixed(1)}%` : 'Sin evaluar'})
            </h1>
            <p className="text-xs text-slate-400 max-w-2xl">
              Recopila automáticamente las señales generadas en{' '}
              <button
                type="button"
                onClick={() => setActiveTab('trading_options')}
                className="text-sky-300 hover:underline font-medium"
              >
                Opciones de Trading
              </button>{' '}
              ({liveCount} en vivo · {auditCount} en auditoría) y las contrasta vela a vela contra el
              desarrollo posterior real en OKX para validar si las señales técnicas se cumplen.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => void reevaluateAllWithOkx(horizonBars, false)}
              disabled={syncing || trackedSignals.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#0B0E11] hover:bg-[#19202D] disabled:opacity-45 border border-white/[0.1] text-slate-200 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              <span>Reevaluar OKX</span>
            </button>

            <button
              type="button"
              onClick={() => void handleRunOkxAudit()}
              disabled={auditing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#3B82F6] hover:bg-blue-500 disabled:opacity-50 text-white font-medium whitespace-nowrap shrink-0"
              title={`Ejecuta auditoría walk-forward sobre las últimas velas reales de ${asset} (${timeframe})`}
            >
              <History className={`w-3.5 h-3.5 ${auditing ? 'animate-spin' : ''}`} />
              <span>
                {auditing ? 'Auditando OKX...' : `Auditar histórico ${asset} ${timeframe}`}
              </span>
            </button>

            {trackedSignals.length > 0 && !confirmClear && (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[#0B0E11] hover:bg-rose-500/15 border border-white/[0.08] hover:border-rose-500/35 text-slate-400 hover:text-rose-300 whitespace-nowrap shrink-0"
                title="Limpiar historial de señales registradas"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Limpiar</span>
              </button>
            )}

            {confirmClear && (
              <div className="flex items-center gap-1.5 bg-[#0B0E11] border border-rose-500/40 rounded px-2 py-1">
                <span className="text-[11px] text-rose-300">¿Confirmar?</span>
                <button
                  type="button"
                  onClick={() => {
                    clearTrackedSignals(originFilter === 'all' ? undefined : originFilter);
                    setConfirmClear(false);
                    setFeedbackMsg('Registro limpiado.');
                  }}
                  className="px-2 py-0.5 rounded bg-rose-600 text-white text-[11px] font-medium"
                >
                  Sí
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[11px]"
                >
                  No
                </button>
              </div>
            )}
          </div>
        </section>

        {feedbackMsg && (
          <div className="bg-[#12161E] border border-sky-500/30 rounded-lg px-3.5 py-2 text-xs text-sky-200 flex items-center justify-between gap-2">
            <span>{feedbackMsg}</span>
            <button
              type="button"
              onClick={() => setFeedbackMsg(null)}
              className="text-slate-400 hover:text-white text-[11px]"
            >
              Cerrar
            </button>
          </div>
        )}

        {/* Filter & Horizon Control Bar */}
        <section className="bg-[#12161E] border border-white/[0.08] rounded-lg px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            {/* Origin Filter */}
            <div className="flex items-center bg-[#0B0E11] p-0.5 rounded border border-white/[0.08]">
              {(
                [
                  { id: 'all', label: `Todas (${trackedSignals.length})` },
                  { id: 'live', label: `En Vivo (${liveCount})` },
                  { id: 'audit', label: `Auditoría OKX (${auditCount})` },
                ] as { id: OriginFilter; label: string }[]
              ).map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setOriginFilter(o.id)}
                  className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap ${
                    originFilter === o.id
                      ? 'bg-[#1F2937] text-white font-medium'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>

            {/* Asset Filter */}
            <div className="flex items-center bg-[#0B0E11] p-0.5 rounded border border-white/[0.08]">
              {(['all', 'BTC', 'ETH'] as AssetFilter[]).map((sym) => (
                <button
                  key={sym}
                  type="button"
                  onClick={() => setAssetFilter(sym)}
                  className={`px-2 py-1 rounded transition-colors whitespace-nowrap ${
                    assetFilter === sym
                      ? 'bg-[#1F2937] text-white font-medium'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {sym === 'all' ? 'BTC+ETH' : sym}
                </button>
              ))}
            </div>

            {/* Status Filter */}
            <div className="flex items-center bg-[#0B0E11] p-0.5 rounded border border-white/[0.08]">
              {(
                [
                  { id: 'all', label: 'Todos estados' },
                  { id: 'evaluated', label: 'Evaluadas' },
                  { id: 'fulfilled', label: 'Cumplidas' },
                  { id: 'stop', label: 'Stop' },
                  { id: 'open', label: 'En curso' },
                ] as { id: StatusFilter; label: string }[]
              ).map((st) => (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => setStatusFilter(st.id)}
                  className={`px-2 py-1 rounded transition-colors whitespace-nowrap ${
                    statusFilter === st.id
                      ? 'bg-[#1F2937] text-white font-medium'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {st.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400 whitespace-nowrap">Horizonte evaluación:</span>
            <div className="flex items-center bg-[#0B0E11] p-0.5 rounded border border-white/[0.08] font-mono-tabular">
              {HORIZON_OPTIONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => handleHorizonChange(h)}
                  className={`px-2 py-1 rounded transition-colors whitespace-nowrap ${
                    horizonBars === h
                      ? 'bg-[#263144] text-white font-semibold'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {h}v
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Empty State */}
        {trackedSignals.length === 0 ? (
          <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-8 text-center space-y-4">
            <div className="w-10 h-10 rounded-lg bg-[#0B0E11] border border-white/[0.08] mx-auto flex items-center justify-center text-sky-400">
              <Target className="w-5 h-5" />
            </div>
            <div className="space-y-1 max-w-lg mx-auto">
              <h2 className="text-sm font-semibold text-white">
                Todavía no hay señales de Opciones de Trading registradas
              </h2>
              <p className="text-xs text-slate-400 leading-relaxed">
                Cada vez que se generen escenarios en Opciones de Trading se guardarán aquí para
                seguir vela a vela si alcanzan TP1, TP2 o Stop Loss. También puedes lanzar ahora una
                auditoría walk-forward sobre las últimas velas reales de OKX para obtener el índice
                inicial al instante.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => void handleRunOkxAudit()}
                disabled={auditing}
                className="flex items-center gap-1.5 px-4 py-2 rounded bg-[#3B82F6] hover:bg-blue-500 text-white text-xs font-medium whitespace-nowrap"
              >
                <History className={`w-3.5 h-3.5 ${auditing ? 'animate-spin' : ''}`} />
                <span>Auditar histórico real OKX ({asset} {timeframe})</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('trading_options')}
                className="flex items-center gap-1.5 px-4 py-2 rounded bg-[#0B0E11] hover:bg-[#19202D] border border-white/[0.1] text-slate-200 text-xs whitespace-nowrap"
              >
                <span>Ir a Opciones de Trading</span>
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
          </section>
        ) : (
          <>
            {/* Hero Effectiveness Index (0–100%) + Companion KPI Grid */}
            <section className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] gap-4">
              {/* Main 100% Index Card */}
              <div className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-slate-400">
                      Índice de Efectividad Global (Base 100%)
                    </div>
                    <div className="flex items-baseline gap-2.5 mt-1 font-mono-tabular">
                      <span
                        className={`text-3xl sm:text-4xl font-bold ${indexColorClass(
                          summary.effectivenessIndexPct
                        )}`}
                      >
                        {summary.effectivenessIndexPct !== null
                          ? `${summary.effectivenessIndexPct.toFixed(1)}%`
                          : '—'}
                      </span>
                      <span className="text-sm text-slate-400">/ 100%</span>
                      {summary.evaluatedCount > 0 && (
                        <span className="text-xs text-slate-400">
                          · {summary.evaluatedCount} señales evaluadas
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="text-right font-mono-tabular text-xs space-y-0.5">
                    <div className="text-slate-400">
                      Tasa acierto TP1/TP2:{' '}
                      <strong className="text-white">
                        {summary.tpHitRatePct !== null
                          ? `${summary.tpHitRatePct.toFixed(1)}%`
                          : '—'}
                      </strong>
                    </div>
                    <div className="text-slate-400">
                      Tasa llenado entrada:{' '}
                      <strong className="text-slate-200">
                        {summary.fillRatePct !== null ? `${summary.fillRatePct.toFixed(1)}%` : '—'}
                      </strong>
                    </div>
                  </div>
                </div>

                {/* 0% - 100% Bar Gauge */}
                <div className="space-y-1.5">
                  <div className="h-2.5 w-full rounded bg-[#0B0E11] border border-white/[0.06] overflow-hidden">
                    <div
                      className={`h-full transition-all ${barFillClass(summary.effectivenessIndexPct)}`}
                      style={{
                        width: `${Math.max(
                          0,
                          Math.min(100, summary.effectivenessIndexPct ?? 0)
                        )}%`,
                      }}
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] font-mono-tabular text-slate-500">
                    <span>
                      Ponderación: TP2 = 100% · TP1 = 85% · Expirada favorable = 45–60% · Stop = 0%
                    </span>
                    <span>
                      TP2 {summary.tp2Count} · TP1 {summary.tp1Count} · SL {summary.stopCount} · En
                      curso {summary.activeCount} · Pend. {summary.pendingCount}
                    </span>
                  </div>
                </div>
              </div>

              {/* Companion Metrics Strip */}
              <div className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-3 font-mono-tabular">
                <div className="bg-[#0B0E11] border border-white/[0.06] rounded p-2.5">
                  <span className="block text-[10px] text-slate-400 font-sans">Cumplidas (TP1+TP2)</span>
                  <span className="text-lg font-semibold text-emerald-300">
                    {summary.fulfilledCount}
                    <span className="text-xs text-slate-500">/{summary.evaluatedCount}</span>
                  </span>
                </div>
                <div className="bg-[#0B0E11] border border-white/[0.06] rounded p-2.5">
                  <span className="block text-[10px] text-slate-400 font-sans">Expectativa Media (R)</span>
                  <span
                    className={`text-lg font-semibold ${
                      summary.avgRealizedR !== null && summary.avgRealizedR > 0
                        ? 'text-emerald-300'
                        : summary.avgRealizedR !== null && summary.avgRealizedR < 0
                        ? 'text-rose-300'
                        : 'text-slate-200'
                    }`}
                  >
                    {summary.avgRealizedR !== null
                      ? `${summary.avgRealizedR >= 0 ? '+' : ''}${summary.avgRealizedR.toFixed(2)}R`
                      : '—'}
                  </span>
                </div>
                <div className="bg-[#0B0E11] border border-white/[0.06] rounded p-2.5">
                  <span className="block text-[10px] text-slate-400 font-sans">MFE Medio Favorable</span>
                  <span className="text-lg font-semibold text-emerald-300">
                    {summary.avgMfePct !== null ? `+${summary.avgMfePct.toFixed(2)}%` : '—'}
                  </span>
                </div>
                <div className="bg-[#0B0E11] border border-white/[0.06] rounded p-2.5">
                  <span className="block text-[10px] text-slate-400 font-sans">MAE Medio Adverso</span>
                  <span className="text-lg font-semibold text-rose-300">
                    {summary.avgMaePct !== null ? `-${summary.avgMaePct.toFixed(2)}%` : '—'}
                  </span>
                </div>
              </div>
            </section>

            {/* Stacked Bar Dashboard with Recharts by Signal Strategy Type & Technical Driver */}
            <SignalStrategyStackedDashboard
              bySignalType={summary.bySignalType}
              byTechnicalDriver={summary.byTechnicalDriver}
            />

            {/* Analytics Row: Cumulative Effectiveness Index Chart + Technical Breakdown */}
            <section className="grid grid-cols-1 xl:grid-cols-[1.35fr_1fr] gap-4 items-start">
              <div className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <BarChart3 className="w-4 h-4 text-sky-400" />
                    <span>Evolución Acumulada del Índice de Efectividad (0%–100%)</span>
                  </h2>
                  <span className="text-[11px] font-mono-tabular text-slate-400">
                    {summary.timeline.length} señales cerradas/evaluadas
                  </span>
                </div>
                <EffectivenessEvolutionChart timeline={summary.timeline} />
              </div>

              <div className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <Activity className="w-4 h-4 text-emerald-400" />
                    <span>Desglose por Análisis Técnico y Setup</span>
                  </h2>

                  <div className="flex items-center bg-[#0B0E11] p-0.5 rounded border border-white/[0.08] text-[10.5px]">
                    {(
                      [
                        { id: 'category', label: 'Setups' },
                        { id: 'tech', label: 'Alineación Téc.' },
                        { id: 'verdict', label: 'v1.1' },
                        { id: 'direction_asset', label: 'Dir/Activo' },
                      ] as { id: BreakdownTab; label: string }[]
                    ).map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setBreakdownTab(t.id)}
                        className={`px-2 py-0.5 rounded transition-colors whitespace-nowrap ${
                          breakdownTab === t.id
                            ? 'bg-[#1F2937] text-white font-medium'
                            : 'text-slate-400 hover:text-white'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                <BreakdownTable rows={activeBreakdownRows} />
              </div>
            </section>

            {/* Selected Signal Subsequent Price Action Chart Inspector */}
            {selectedSignal && (
              <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={`font-mono-tabular font-bold ${
                        selectedSignal.direction === 'LONG' ? 'text-emerald-300' : 'text-rose-300'
                      }`}
                    >
                      {selectedSignal.direction}
                    </span>
                    <span className="font-semibold text-white">{selectedSignal.title}</span>
                    <span className="text-slate-400">
                      · {selectedSignal.asset} {selectedSignal.timeframe} ·{' '}
                      {selectedSignal.origin === 'live' ? 'En Vivo' : 'Auditoría OKX'}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 text-xs font-mono-tabular">
                    <span className={statusMeta(selectedSignal.status).textClass}>
                      {statusMeta(selectedSignal.status).label}
                    </span>
                    {selectedSignal.effectivenessPoints !== null && (
                      <span className="text-white font-semibold">
                        Índice señal: {selectedSignal.effectivenessPoints}%
                      </span>
                    )}
                  </div>
                </div>

                <SignalTrailChart signal={selectedSignal} />

                {(selectedSignal.alignedFactors.length > 0 ||
                  selectedSignal.conflictingFactors.length > 0) && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 text-[11px]">
                    <div className="bg-[#0B0E11] border border-white/[0.06] rounded p-2.5 space-y-1">
                      <div className="text-emerald-300 font-medium">
                        Factores Técnicos Alineados ({selectedSignal.alignedFactors.length})
                      </div>
                      {selectedSignal.alignedFactors.length === 0 ? (
                        <div className="text-slate-500">Sin factores técnicos de respaldo extra.</div>
                      ) : (
                        <ul className="text-slate-300 space-y-0.5">
                          {selectedSignal.alignedFactors.map((f, idx) => (
                            <li key={idx}>· {f}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="bg-[#0B0E11] border border-white/[0.06] rounded p-2.5 space-y-1">
                      <div className="text-amber-300 font-medium">
                        Riesgos / Fricciones Detectadas ({selectedSignal.conflictingFactors.length})
                      </div>
                      {selectedSignal.conflictingFactors.length === 0 ? (
                        <div className="text-slate-500">Sin fricciones técnicas relevantes.</div>
                      ) : (
                        <ul className="text-slate-300 space-y-0.5">
                          {selectedSignal.conflictingFactors.map((f, idx) => (
                            <li key={idx}>· {f}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* Signals Effectiveness Audit Table */}
            <section className="bg-[#12161E] border border-white/[0.08] rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-xs font-semibold text-white">
                  Registro Detallado de Señales vs Gráfico Posterior ({filteredSignals.length})
                </h2>
                <span className="text-[11px] text-slate-400">
                  Haz clic en cualquier fila para inspeccionar el desarrollo vela a vela en el gráfico superior
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-white/[0.08] bg-[#0F131C] text-[10.5px] uppercase tracking-wider text-slate-400">
                      <th className="px-3 py-2.5 font-medium">Fecha UTC</th>
                      <th className="px-3 py-2.5 font-medium">Activo / Origen</th>
                      <th className="px-3 py-2.5 font-medium">Señal &amp; Categoría</th>
                      <th className="px-3 py-2.5 font-medium">Dir.</th>
                      <th className="px-3 py-2.5 font-medium text-right">Entrada</th>
                      <th className="px-3 py-2.5 font-medium text-right">TP1 / TP2</th>
                      <th className="px-3 py-2.5 font-medium text-right">Stop Loss</th>
                      <th className="px-3 py-2.5 font-medium text-right">Velas · MFE/MAE</th>
                      <th className="px-3 py-2.5 font-medium">Estado</th>
                      <th className="px-3 py-2.5 font-medium text-right">Efectividad</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05]">
                    {filteredSignals.slice(0, 120).map((sig) => {
                      const sm = statusMeta(sig.status);
                      const isSelected = selectedSignal?.id === sig.id;
                      return (
                        <tr
                          key={sig.id}
                          onClick={() => setSelectedSignalId(sig.id)}
                          className={`cursor-pointer transition-colors ${
                            isSelected ? 'bg-sky-500/10' : 'hover:bg-white/[0.03]'
                          }`}
                        >
                          <td className="px-3 py-2.5 font-mono-tabular text-[11px] text-slate-400 whitespace-nowrap">
                            {formatUtcCompact(sig.candleOpenTs)}
                          </td>
                          <td className="px-3 py-2.5 font-mono-tabular whitespace-nowrap">
                            <span className="font-semibold text-white">{sig.asset}</span>
                            <span className="text-slate-400">
                              {' '}
                              · {sig.timeframe} · {sig.origin === 'live' ? 'Vivo' : 'Audit'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 max-w-[260px]">
                            <div className="font-medium text-slate-100 truncate">{sig.title}</div>
                            <div className="text-[10.5px] text-slate-400 font-mono-tabular truncate">
                              {sig.category} · ΔTéc {sig.scoreDelta >= 0 ? '+' : ''}
                              {sig.scoreDelta}
                              {sig.v11Score !== null ? ` · v1.1 ${sig.v11Score.toFixed(0)}` : ''}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 font-mono-tabular whitespace-nowrap">
                            <span
                              className={`inline-flex items-center gap-0.5 font-semibold ${
                                sig.direction === 'LONG' ? 'text-emerald-300' : 'text-rose-300'
                              }`}
                            >
                              {sig.direction === 'LONG' ? (
                                <ArrowUpRight className="w-3.5 h-3.5" />
                              ) : (
                                <ArrowDownRight className="w-3.5 h-3.5" />
                              )}
                              {sig.direction}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 font-mono-tabular text-right whitespace-nowrap text-slate-200">
                            {formatPrice(sig.entry, sig.asset)}
                            <span className="block text-[10px] text-slate-500">
                              {sig.entryFilled ? 'Ejecutada' : 'Sin llenar'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 font-mono-tabular text-right whitespace-nowrap text-emerald-300">
                            {formatPrice(sig.takeProfit1, sig.asset)}
                            <span className="block text-[10px] text-emerald-400/75">
                              {formatPrice(sig.takeProfit2, sig.asset)}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 font-mono-tabular text-right whitespace-nowrap text-rose-300">
                            {formatPrice(sig.stopLoss, sig.asset)}
                          </td>
                          <td className="px-3 py-2.5 font-mono-tabular text-right whitespace-nowrap text-[11px]">
                            <span className="text-slate-300">
                              {sig.barsObserved}/{sig.horizonBars}v
                            </span>
                            <span className="block text-[10px]">
                              <span className="text-emerald-300">+{sig.maxFavorablePct.toFixed(1)}%</span>
                              <span className="text-slate-500"> / </span>
                              <span className="text-rose-300">-{sig.maxAdversePct.toFixed(1)}%</span>
                            </span>
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap">
                            <span className={`inline-flex items-center gap-1 font-medium ${sm.textClass}`}>
                              {sig.status === 'CUMPLIDA_TP2' || sig.status === 'CUMPLIDA_TP1' ? (
                                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                              ) : sig.status === 'FALLIDA_STOP' ? (
                                <XCircle className="w-3.5 h-3.5 shrink-0" />
                              ) : (
                                <Clock className="w-3.5 h-3.5 shrink-0" />
                              )}
                              <span>{sm.label}</span>
                            </span>
                          </td>
                          <td className="px-3 py-2.5 font-mono-tabular text-right whitespace-nowrap font-semibold">
                            {sig.effectivenessPoints !== null ? (
                              <span className={indexColorClass(sig.effectivenessPoints)}>
                                {sig.effectivenessPoints}%
                                {sig.realizedR !== null && (
                                  <span className="block text-[10px] text-slate-400 font-normal">
                                    {sig.realizedR >= 0 ? '+' : ''}
                                    {sig.realizedR.toFixed(2)}R
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className="text-slate-500">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
