import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookmarkPlus,
  CheckCircle2,
  Download,
  MinusCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { evaluateScoringSystem } from '../calc/scoringEngine';
import { fetchScoringDataset } from '../data/okxScoringClient';
import { useTerminalStore } from '../store/terminalStore';
import type { SymbolAsset } from '../types/market';
import type {
  DirectionEvaluation,
  DirectionParamResult,
  MultiTfScoringDataset,
  ScoringConfig,
  ScoringFamilyId,
  ScoringJournalEntry,
  ScoringMode,
} from '../types/scoring';

const JOURNAL_STORAGE_KEY = 'wterm_scoring_journal_v1';

type MatrixFilter = 'all' | 'long_passed' | 'short_passed' | 'warnings' | ScoringFamilyId;

function loadJournal(): ScoringJournalEntry[] {
  try {
    const raw = localStorage.getItem(JOURNAL_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ScoringJournalEntry[];
  } catch {
    return [];
  }
}

function saveJournal(entries: ScoringJournalEntry[]) {
  try {
    localStorage.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(entries.slice(0, 100)));
  } catch {
    // ignore storage quota errors
  }
}

function formatPrice(val: number, asset: SymbolAsset): string {
  return `$${val.toLocaleString('en-US', {
    minimumFractionDigits: asset === 'BTC' ? 1 : 2,
    maximumFractionDigits: asset === 'BTC' ? 1 : 2,
  })}`;
}

function formatUtcShort(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toISOString().slice(5, 16).replace('T', ' ') + ' UTC';
}

function verdictStyle(ev: DirectionEvaluation): {
  border: string;
  text: string;
  label: string;
} {
  if (ev.verdict === 'CANDIDATA') {
    return {
      border: 'border-emerald-500/35',
      text: 'text-emerald-300',
      label: 'CANDIDATA OPERABLE',
    };
  }
  if (ev.verdict === 'BLOQUEADA') {
    return {
      border: 'border-rose-500/35',
      text: 'text-rose-300',
      label: 'BLOQUEADA',
    };
  }
  if (ev.verdict === 'ESPERAR') {
    return {
      border: 'border-amber-500/35',
      text: 'text-amber-300',
      label: 'ESPERAR CONFIRMACIÓN',
    };
  }
  return {
    border: 'border-white/[0.08]',
    text: 'text-slate-400',
    label: 'DESCARTADA',
  };
}

function ParamCell({ res }: { res: DirectionParamResult }) {
  if (!res.applicable) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-mono-tabular text-slate-500">
          <MinusCircle className="w-3.5 h-3.5 shrink-0" />
          <span>N/A (Desactivado)</span>
        </div>
        <p className="text-[11px] text-slate-500 leading-snug">{res.reason}</p>
      </div>
    );
  }
  if (res.missing || res.points === null) {
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-xs font-mono-tabular text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>N/D · 0.00 / {res.maxWeight}</span>
        </div>
        <p className="text-[11px] text-slate-400 leading-snug">{res.reason}</p>
      </div>
    );
  }

  const isPass = res.points >= 75;
  const isMid = res.points === 50;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs font-mono-tabular">
        <span
          className={`flex items-center gap-1.5 font-semibold ${
            isPass ? 'text-emerald-300' : isMid ? 'text-amber-300' : 'text-rose-300'
          }`}
        >
          {isPass ? (
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          ) : isMid ? (
            <MinusCircle className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <XCircle className="w-3.5 h-3.5 shrink-0" />
          )}
          <span>{res.points} pts</span>
          <span className="text-[11px] font-normal text-slate-400">
            {isPass ? 'Cumple' : isMid ? 'Neutral' : 'No cumple'}
          </span>
        </span>
        <span className="text-slate-300">
          +{res.weightedPoints.toFixed(2)}/{res.maxWeight}
        </span>
      </div>
      <p className="text-[11px] text-slate-400 leading-snug">{res.reason}</p>
    </div>
  );
}

function DirectionScoreCard({
  ev,
  asset,
  isDominant,
}: {
  ev: DirectionEvaluation;
  asset: SymbolAsset;
  isDominant: boolean;
}) {
  const style = verdictStyle(ev);
  const isLong = ev.direction === 'LONG';

  return (
    <div className={`bg-[#12161E] border ${style.border} rounded-lg p-4 flex flex-col gap-3`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className={`font-semibold ${isLong ? 'text-emerald-300' : 'text-rose-300'}`}>
              Opción {ev.direction}
            </span>
            <span aria-hidden="true">·</span>
            <span>{isDominant ? 'Dirección dominante' : 'Dirección contraria'}</span>
          </div>
          <h2 className={`text-base font-semibold mt-0.5 ${style.text}`}>{style.label}</h2>
        </div>

        <div className="text-right font-mono-tabular">
          <div className="text-2xl font-bold text-white leading-none">
            {ev.score.toFixed(1)}
            <span className="text-xs font-normal text-slate-400"> / 100</span>
          </div>
          <div className="text-[11px] text-slate-400 mt-1">Exacto: {ev.score.toFixed(2)}</div>
        </div>
      </div>

      {/* Classification + Coverage metadata line (zero pills) */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-300 border-y border-white/[0.06] py-2 font-mono-tabular">
        <span>
          Banda: <strong className="text-white">{ev.band}</strong>
        </span>
        <span aria-hidden="true" className="text-slate-600">
          ·
        </span>
        <span>
          Cobertura:{' '}
          <strong className={ev.coveragePct >= 90 ? 'text-emerald-300' : 'text-rose-300'}>
            {ev.coveragePct.toFixed(1)}%
          </strong>{' '}
          ({ev.availableWeight}/{ev.applicableWeight})
        </span>
        <span aria-hidden="true" className="text-slate-600">
          ·
        </span>
        <span>
          Diferencia:{' '}
          <strong className={ev.diffVsOpposite >= 15 ? 'text-emerald-300' : 'text-slate-300'}>
            {ev.diffVsOpposite >= 0 ? '+' : ''}
            {ev.diffVsOpposite.toFixed(1)} pts
          </strong>
        </span>
      </div>

      {/* Condition Tally */}
      <div className="grid grid-cols-4 gap-2 text-center font-mono-tabular text-xs">
        <div className="bg-[#0B0E14] border border-white/[0.06] rounded py-1.5 px-2">
          <div className="text-emerald-300 font-semibold text-sm">{ev.passedCount}</div>
          <div className="text-[10px] text-slate-400">Cumplen ≥75</div>
        </div>
        <div className="bg-[#0B0E14] border border-white/[0.06] rounded py-1.5 px-2">
          <div className="text-amber-300 font-semibold text-sm">{ev.partialCount}</div>
          <div className="text-[10px] text-slate-400">Neutras 50</div>
        </div>
        <div className="bg-[#0B0E14] border border-white/[0.06] rounded py-1.5 px-2">
          <div className="text-rose-300 font-semibold text-sm">{ev.failedCount}</div>
          <div className="text-[10px] text-slate-400">Contrarias ≤25</div>
        </div>
        <div className="bg-[#0B0E14] border border-white/[0.06] rounded py-1.5 px-2">
          <div className="text-slate-300 font-semibold text-sm">{ev.missingCount}</div>
          <div className="text-[10px] text-slate-400">Ausentes N/D</div>
        </div>
      </div>

      {/* Linear Plan & Costs */}
      {ev.plan ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs font-mono-tabular bg-[#0B0E14] border border-white/[0.06] rounded p-3">
          <div>
            <span className="text-[10px] text-slate-400 block">Entrada</span>
            <span className="text-white font-semibold">{formatPrice(ev.plan.entry, asset)}</span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 block">Stop estructural</span>
            <span className="text-rose-300 font-semibold">
              {formatPrice(ev.plan.stopLoss, asset)}
            </span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 block">Objetivo 1</span>
            <span className="text-emerald-300 font-semibold">
              {formatPrice(ev.plan.takeProfit, asset)}
            </span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 block">Tamaño (q)</span>
            <span className="text-slate-200">
              {ev.plan.quantity.toFixed(asset === 'BTC' ? 4 : 3)} {asset}
            </span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 block">RR Neto (tras costes)</span>
            <span
              className={`font-semibold ${
                ev.plan.netRR >= 2 ? 'text-emerald-300' : 'text-rose-300'
              }`}
            >
              {ev.plan.netRR.toFixed(2)} R
            </span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 block">Coste / Riesgo bruto</span>
            <span
              className={ev.plan.costToRiskPct <= 20 ? 'text-slate-200' : 'text-rose-300'}
            >
              {ev.plan.costToRiskPct.toFixed(1)}%
            </span>
          </div>
        </div>
      ) : (
        <div className="text-xs text-slate-400 bg-[#0B0E14] border border-white/[0.06] rounded p-3">
          Plan de ejecución no disponible por falta de velas válidas.
        </div>
      )}

      {/* Blocks & Warnings */}
      <div className="space-y-1.5 mt-auto">
        {ev.blocks.length === 0 ? (
          <div className="flex items-center gap-2 text-xs text-emerald-300">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>Sin bloqueos ni filtros restrictivos activos (cumple corte v1.1).</span>
          </div>
        ) : (
          ev.blocks.map((b) => (
            <div
              key={b.code}
              className="flex items-start gap-2 text-xs border border-white/[0.06] bg-[#0B0E14] rounded px-2.5 py-1.5"
            >
              {b.severity === 'BLOQUEAR' ? (
                <XCircle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
              )}
              <div>
                <span
                  className={`font-semibold ${
                    b.severity === 'BLOQUEAR' ? 'text-rose-300' : 'text-amber-300'
                  }`}
                >
                  [{b.severity}] {b.label}:{' '}
                </span>
                <span className="text-slate-400">{b.detail}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function ScoringWorkspace() {
  const { asset, setAsset } = useTerminalStore();

  const [mode, setMode] = useState<ScoringMode>('perpetual');
  const [capitalUsd, setCapitalUsd] = useState(10000);
  const [riskPct, setRiskPct] = useState(0.25);
  const [feePctPerSide, setFeePctPerSide] = useState(0.05);
  const [slippagePctPerSide, setSlippagePctPerSide] = useState(0.02);
  const [dailyLossReached, setDailyLossReached] = useState(false);
  const [correlatedRiskExceeded, setCorrelatedRiskExceeded] = useState(false);

  const [dataset, setDataset] = useState<MultiTfScoringDataset | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<MatrixFilter>('all');
  const [journal, setJournal] = useState<ScoringJournalEntry[]>(() => loadJournal());

  const loadData = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const ds = await fetchScoringDataset(asset, signal);
        setDataset(ds);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : 'Error al descargar datos OKX para v1.1');
        }
      } finally {
        setLoading(false);
      }
    },
    [asset]
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void loadData(ctrl.signal);
    const id = setInterval(() => {
      void loadData();
    }, 60_000);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [loadData]);

  const config: ScoringConfig = useMemo(
    () => ({
      mode,
      capitalUsd,
      riskPct,
      feePctPerSide,
      slippagePctPerSide,
      expectedFundingCostPct: 0.01,
      dailyLossReached,
      correlatedRiskExceeded,
    }),
    [
      mode,
      capitalUsd,
      riskPct,
      feePctPerSide,
      slippagePctPerSide,
      dailyLossReached,
      correlatedRiskExceeded,
    ]
  );

  const result = useMemo(() => {
    if (!dataset) return null;
    return evaluateScoringSystem(dataset, config);
  }, [dataset, config]);

  const filteredParams = useMemo(() => {
    if (!result) return [];
    return result.parameters.filter((row) => {
      if (filter === 'all') return true;
      if (filter === 'long_passed') return row.long.passed;
      if (filter === 'short_passed') return row.short.passed;
      if (filter === 'warnings') {
        return (
          (row.long.applicable && (row.long.missing || (row.long.points ?? 0) <= 25)) ||
          (row.short.applicable && (row.short.missing || (row.short.points ?? 0) <= 25))
        );
      }
      return row.family === filter;
    });
  }, [result, filter]);

  const handleRecordEvaluation = () => {
    if (!result) return;
    const domEval =
      result.shortEval.score > result.longEval.score ? result.shortEval : result.longEval;
    const entry: ScoringJournalEntry = {
      id: `sc-${Date.now()}`,
      ts: result.evaluatedAt,
      asset: result.asset,
      mode: result.mode,
      spot: result.spot,
      longScore: Number(result.longEval.score.toFixed(2)),
      shortScore: Number(result.shortEval.score.toFixed(2)),
      longVerdict: result.longEval.verdict,
      shortVerdict: result.shortEval.verdict,
      dominant: result.dominantDirection,
      coveragePct: Number(domEval.coveragePct.toFixed(1)),
      netRR: domEval.plan ? Number(domEval.plan.netRR.toFixed(2)) : null,
      entry: domEval.plan?.entry ?? null,
      stopLoss: domEval.plan?.stopLoss ?? null,
      takeProfit: domEval.plan?.takeProfit ?? null,
      blockSummary:
        domEval.blocks.length > 0 ? domEval.blocks.map((b) => b.code).join(', ') : 'Sin bloqueos',
    };
    const next = [entry, ...journal].slice(0, 100);
    setJournal(next);
    saveJournal(next);
  };

  const handleExportCsv = () => {
    if (journal.length === 0) return;
    const header =
      'FechaUTC,Activo,Modo,Spot,LONG,SHORT,VeredictoLONG,VeredictoSHORT,CoberturaPct,RRNeto,Entrada,Stop,Objetivo,Bloqueos';
    const rows = journal.map((j) =>
      [
        new Date(j.ts).toISOString(),
        j.asset,
        j.mode,
        j.spot,
        j.longScore,
        j.shortScore,
        j.longVerdict,
        j.shortVerdict,
        j.coveragePct,
        j.netRR ?? '',
        j.entry ?? '',
        j.stopLoss ?? '',
        j.takeProfit ?? '',
        `"${j.blockSummary}"`,
      ].join(',')
    );
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `registro_puntuacion_v1_1_${asset}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-[#0B0E14] text-slate-200">
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-5">
        {/* 1. Header & Simulation Controls */}
        <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span className="text-sky-400 font-medium">Sistema de Puntuación</span>
                <span aria-hidden="true">·</span>
                <span>Especificación v1.1 (4h / 1h / 15m)</span>
                <span aria-hidden="true">·</span>
                <span>Solo velas cerradas OKX</span>
              </div>
              <h1 className="text-lg font-semibold text-white">
                Evaluación independiente LONG y SHORT sobre 100 puntos
              </h1>
              <p className="text-xs text-slate-400 max-w-3xl">
                Marca automáticamente qué condiciones se cumplen en tiempo real y expone la cobertura
                y bloqueos de riesgo. Una nota ≥ 80 requiere diferencia ≥ 15 pts, A1 ≥ 75, D1 ≥ 75,
                RR neto ≥ 2 y cobertura ≥ 90%.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => void loadData()}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0B0E14] hover:bg-[#19202D] border border-white/[0.08] rounded-md text-slate-200 transition-colors whitespace-nowrap"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
                <span>Actualizar OKX</span>
              </button>
              <button
                type="button"
                onClick={handleRecordEvaluation}
                disabled={!result}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#3B82F6] hover:bg-[#2563EB] disabled:opacity-50 rounded-md text-white transition-colors whitespace-nowrap"
              >
                <BookmarkPlus className="w-3.5 h-3.5" />
                <span>Registrar evaluación</span>
              </button>
            </div>
          </div>

          {/* Parameter Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 pt-3 border-t border-white/[0.06] text-xs items-end">
            <div>
              <span className="block text-[10px] text-slate-400 mb-1">Activo</span>
              <div className="flex bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]">
                {(['BTC', 'ETH'] as SymbolAsset[]).map((sym) => (
                  <button
                    key={sym}
                    type="button"
                    onClick={() => setAsset(sym)}
                    className={`flex-1 py-1 text-xs font-semibold rounded transition-colors ${
                      asset === sym ? 'bg-[#3B82F6] text-white' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {sym}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="block text-[10px] text-slate-400 mb-1">Producto / Perfil</span>
              <div className="flex bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]">
                <button
                  type="button"
                  onClick={() => setMode('perpetual')}
                  className={`flex-1 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap ${
                    mode === 'perpetual'
                      ? 'bg-[#1F2937] text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Perp (100)
                </button>
                <button
                  type="button"
                  onClick={() => setMode('spot')}
                  className={`flex-1 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap ${
                    mode === 'spot'
                      ? 'bg-[#1F2937] text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Spot (95)
                </button>
              </div>
            </div>

            <label className="block">
              <span className="block text-[10px] text-slate-400 mb-1">Capital (USDT)</span>
              <input
                type="number"
                min={100}
                step={500}
                value={capitalUsd}
                onChange={(e) => setCapitalUsd(Math.max(100, Number(e.target.value) || 10000))}
                className="w-full bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-1 text-xs font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
              />
            </label>

            <label className="block">
              <span className="block text-[10px] text-slate-400 mb-1">Riesgo / Op (%)</span>
              <input
                type="number"
                min={0.1}
                max={5}
                step={0.05}
                value={riskPct}
                onChange={(e) =>
                  setRiskPct(Math.min(5, Math.max(0.05, Number(e.target.value) || 0.25)))
                }
                className="w-full bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-1 text-xs font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
              />
            </label>

            <label className="block">
              <span className="block text-[10px] text-slate-400 mb-1">Comisión + Desliz. (%)</span>
              <div className="flex gap-1">
                <input
                  type="number"
                  min={0}
                  max={0.5}
                  step={0.01}
                  value={feePctPerSide}
                  onChange={(e) => setFeePctPerSide(Math.max(0, Number(e.target.value) || 0))}
                  title="Comisión por lado (%)"
                  className="w-1/2 bg-[#0B0E14] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
                />
                <input
                  type="number"
                  min={0}
                  max={0.5}
                  step={0.01}
                  value={slippagePctPerSide}
                  onChange={(e) => setSlippagePctPerSide(Math.max(0, Number(e.target.value) || 0))}
                  title="Deslizamiento por lado (%)"
                  className="w-1/2 bg-[#0B0E14] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
                />
              </div>
            </label>

            <label className="flex items-center gap-2 bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={dailyLossReached}
                onChange={(e) => setDailyLossReached(e.target.checked)}
                className="accent-rose-500 w-3.5 h-3.5"
              />
              <span className="text-[11px] text-slate-300 truncate">Límite diario 1%</span>
            </label>

            <label className="flex items-center gap-2 bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={correlatedRiskExceeded}
                onChange={(e) => setCorrelatedRiskExceeded(e.target.checked)}
                className="accent-rose-500 w-3.5 h-3.5"
              />
              <span className="text-[11px] text-slate-300 truncate">Riesgo BTC+ETH</span>
            </label>
          </div>
        </section>

        {error && (
          <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-3 text-xs text-rose-300 flex items-center justify-between gap-3">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => void loadData()}
              className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-white whitespace-nowrap"
            >
              Reintentar
            </button>
          </div>
        )}

        {/* Loading skeleton on initial fetch */}
        {loading && !result && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="h-72 bg-[#12161E] border border-white/[0.08] rounded-lg animate-pulse" />
            <div className="h-72 bg-[#12161E] border border-white/[0.08] rounded-lg animate-pulse" />
          </div>
        )}

        {result && (
          <>
            {/* Live Context Summary Line */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 px-1 font-mono-tabular">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-white font-semibold">{result.instId}</span>
                <span aria-hidden="true">·</span>
                <span>Spot cierre: {formatPrice(result.spot, result.asset)}</span>
                <span aria-hidden="true">·</span>
                <span>Régimen: {result.regimeLabel}</span>
                {result.volumeProfile7d && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      POC 7d: ${result.volumeProfile7d.poc.toFixed(0)} (VA $
                      {result.volumeProfile7d.val.toFixed(0)}–$
                      {result.volumeProfile7d.vah.toFixed(0)})
                    </span>
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span>4h: {formatUtcShort(result.lastClosed4hTs)}</span>
                <span aria-hidden="true">·</span>
                <span>1h: {formatUtcShort(result.lastClosed1hTs)}</span>
                <span aria-hidden="true">·</span>
                <span>15m: {formatUtcShort(result.lastClosed15mTs)}</span>
              </div>
            </div>

            {/* 2. Dual Verdict Cards (LONG vs SHORT) */}
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
              <DirectionScoreCard
                ev={result.longEval}
                asset={result.asset}
                isDominant={result.dominantDirection === 'LONG'}
              />
              <DirectionScoreCard
                ev={result.shortEval}
                asset={result.asset}
                isDominant={result.dominantDirection === 'SHORT'}
              />
            </section>

            {/* 3. 6-Family Weight Breakdown */}
            <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h2 className="text-sm font-semibold text-white">
                  Desglose por familia de puntuación (LONG vs SHORT)
                </h2>
                {result.excludedNotes.length > 0 && (
                  <span className="text-[11px] text-slate-400">
                    {result.excludedNotes.join(' · ')}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
                {result.families.map((fam) => {
                  const denom = Math.max(1, fam.applicableWeight);
                  const lPct = Math.min(100, (fam.longPoints / denom) * 100);
                  const sPct = Math.min(100, (fam.shortPoints / denom) * 100);

                  return (
                    <div
                      key={fam.id}
                      className="bg-[#0B0E14] border border-white/[0.06] rounded p-3 space-y-2"
                    >
                      <div className="flex items-baseline justify-between gap-1">
                        <span className="text-xs font-semibold text-white">
                          {fam.id}. {fam.name}
                        </span>
                        <span className="text-[11px] font-mono-tabular text-slate-400 shrink-0">
                          {fam.applicableWeight} pts
                        </span>
                      </div>

                      <div className="space-y-1.5 font-mono-tabular text-[11px]">
                        <div>
                          <div className="flex justify-between text-emerald-300 mb-0.5">
                            <span>LONG ({fam.longPassedCount}/{fam.totalApplicableCount})</span>
                            <span>{fam.longPoints.toFixed(1)}</span>
                          </div>
                          <div className="h-1.5 bg-white/[0.06] rounded overflow-hidden">
                            <div
                              className="h-full bg-emerald-400"
                              style={{ width: `${lPct}%` }}
                            />
                          </div>
                        </div>

                        <div>
                          <div className="flex justify-between text-rose-300 mb-0.5">
                            <span>SHORT ({fam.shortPassedCount}/{fam.totalApplicableCount})</span>
                            <span>{fam.shortPoints.toFixed(1)}</span>
                          </div>
                          <div className="h-1.5 bg-white/[0.06] rounded overflow-hidden">
                            <div
                              className="h-full bg-rose-400"
                              style={{ width: `${sPct}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* 4. Full 19-Condition Evaluation Matrix */}
            <section className="bg-[#12161E] border border-white/[0.08] rounded-lg overflow-hidden">
              <div className="p-4 border-b border-white/[0.08] flex flex-col md:flex-row md:items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-white">
                    Matriz de condiciones evaluadas ({filteredParams.length} de{' '}
                    {result.parameters.length})
                  </h2>
                  <p className="text-xs text-slate-400">
                    Cada condición ≥ 75 puntos se marca como cumplida en su dirección correspondiente.
                  </p>
                </div>

                {/* Filter bar */}
                <div className="flex flex-wrap items-center gap-1 bg-[#0B0E14] p-1 rounded border border-white/[0.08] text-xs">
                  {(
                    [
                      { id: 'all', label: 'Todas (19)' },
                      { id: 'long_passed', label: 'Cumplidas LONG' },
                      { id: 'short_passed', label: 'Cumplidas SHORT' },
                      { id: 'warnings', label: 'Contrarias / N/D' },
                      { id: 'A', label: 'A' },
                      { id: 'B', label: 'B' },
                      { id: 'C', label: 'C' },
                      { id: 'D', label: 'D' },
                      { id: 'E', label: 'E' },
                      { id: 'F', label: 'F' },
                    ] as { id: MatrixFilter; label: string }[]
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setFilter(tab.id)}
                      className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors whitespace-nowrap ${
                        filter === tab.id
                          ? 'bg-[#1F2937] text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-[#0B0E14] border-b border-white/[0.08] text-[11px] text-slate-400">
                      <th className="py-2.5 px-3 font-medium w-48">ID · Parámetro</th>
                      <th className="py-2.5 px-3 font-medium w-48">Dato observado</th>
                      <th className="py-2.5 px-3 font-medium">Evaluación LONG</th>
                      <th className="py-2.5 px-3 font-medium">Evaluación SHORT</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06] text-xs">
                    {filteredParams.map((row) => (
                      <tr key={row.id} className="hover:bg-white/[0.02] align-top">
                        <td className="py-3 px-3">
                          <div className="flex items-center gap-2 font-mono-tabular">
                            <span className="text-sky-400 font-semibold">{row.id}</span>
                            <span className="text-white font-medium">{row.name}</span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5 font-mono-tabular">
                            TF: {row.timeframeLabel} · Peso máx: {row.maxWeight}
                          </div>
                        </td>
                        <td className="py-3 px-3 font-mono-tabular text-[11px] text-slate-300">
                          {row.observedSummary}
                        </td>
                        <td className="py-3 px-3">
                          <ParamCell res={row.long} />
                        </td>
                        <td className="py-3 px-3">
                          <ParamCell res={row.short} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* 5. Demo Evaluation Journal (§14 Registro) */}
            <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-white">
                    Registro de evaluaciones (Protocolo Demo v1.1)
                  </h2>
                  <p className="text-xs text-slate-400">
                    Guarda instantáneas verificables sin sobrescribir evaluaciones previas ({journal.length}{' '}
                    registros locales).
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleExportCsv}
                    disabled={journal.length === 0}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-[#0B0E14] hover:bg-[#19202D] disabled:opacity-40 border border-white/[0.08] rounded text-slate-200 whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Exportar CSV</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setJournal([]);
                      saveJournal([]);
                    }}
                    disabled={journal.length === 0}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-[#0B0E14] hover:bg-rose-500/15 disabled:opacity-40 border border-white/[0.08] rounded text-slate-300 whitespace-nowrap"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Limpiar</span>
                  </button>
                </div>
              </div>

              {journal.length === 0 ? (
                <div className="text-xs text-slate-400 bg-[#0B0E14] border border-white/[0.06] rounded p-3">
                  Aún no hay evaluaciones registradas. Pulsa «Registrar evaluación» arriba para
                  guardar la lectura actual de LONG, SHORT, RR neto y bloqueos.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs font-mono-tabular">
                    <thead>
                      <tr className="border-b border-white/[0.08] text-[11px] text-slate-400">
                        <th className="py-2 px-2">Fecha UTC</th>
                        <th className="py-2 px-2">Activo</th>
                        <th className="py-2 px-2 text-right">Spot</th>
                        <th className="py-2 px-2 text-right">LONG</th>
                        <th className="py-2 px-2 text-right">SHORT</th>
                        <th className="py-2 px-2 text-right">Cobertura</th>
                        <th className="py-2 px-2 text-right">RR Neto</th>
                        <th className="py-2 px-2">Bloqueos / Estado</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                      {journal.slice(0, 12).map((j) => (
                        <tr key={j.id} className="hover:bg-white/[0.02]">
                          <td className="py-2 px-2 text-slate-400">
                            {new Date(j.ts).toISOString().slice(0, 16).replace('T', ' ')}
                          </td>
                          <td className="py-2 px-2 text-white">
                            {j.asset} ({j.mode === 'perpetual' ? 'Perp' : 'Spot'})
                          </td>
                          <td className="py-2 px-2 text-right text-slate-200">
                            {formatPrice(j.spot, j.asset)}
                          </td>
                          <td
                            className={`py-2 px-2 text-right font-semibold ${
                              j.longScore >= 80 ? 'text-emerald-300' : 'text-slate-200'
                            }`}
                          >
                            {j.longScore.toFixed(1)}
                          </td>
                          <td
                            className={`py-2 px-2 text-right font-semibold ${
                              j.shortScore >= 80 ? 'text-rose-300' : 'text-slate-200'
                            }`}
                          >
                            {j.shortScore.toFixed(1)}
                          </td>
                          <td className="py-2 px-2 text-right text-slate-300">
                            {j.coveragePct.toFixed(1)}%
                          </td>
                          <td className="py-2 px-2 text-right text-slate-200">
                            {j.netRR !== null ? `${j.netRR.toFixed(2)} R` : '—'}
                          </td>
                          <td className="py-2 px-2 text-slate-400 font-sans">
                            {j.blockSummary}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
