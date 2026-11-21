import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookmarkPlus,
  CheckCircle2,
  Clock,
  Download,
  History,
  MinusCircle,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import {
  evaluateHistoricalAudit,
  evaluateScoringSystem,
  sliceDatasetAsOf,
} from '../calc/scoringEngine';
import {
  autoGradeJournalEntry,
  computeCalibrationDashboard,
  resolveChosenDirection,
  resolveChosenScore,
  resolveIsControlGroup,
} from '../calc/scoringJournal';
import { fetchScoringDataset } from '../data/okxScoringClient';
import { useTerminalStore } from '../store/terminalStore';
import type { SymbolAsset } from '../types/market';
import type {
  DirectionEvaluation,
  DirectionParamResult,
  HistoricalAuditSummary,
  JournalExitReason,
  MultiTfScoringDataset,
  ScoringConfig,
  ScoringFamilyId,
  ScoringJournalEntry,
  VpLevelLock,
} from '../types/scoring';
import { ScoringAuditChart } from './components/ScoringAuditChart';

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
    localStorage.setItem(JOURNAL_STORAGE_KEY, JSON.stringify(entries.slice(0, 200)));
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

function formatCompactUsd(val: number): string {
  const abs = Math.abs(val);
  if (abs >= 1_000_000_000) return `$${(val / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(val / 1_000).toFixed(1)}K`;
  return `$${val.toFixed(0)}`;
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

      {/* Classification + Coverage + Caducidad metadata line */}
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
        {ev.triggerFreshness.remainingValidBars !== null && (
          <>
            <span aria-hidden="true" className="text-slate-600">
              ·
            </span>
            <span className="text-sky-300">
              D1 vigente: {ev.triggerFreshness.remainingValidBars}/4 velas (16v máx)
            </span>
          </>
        )}
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
          <div>
            <span className="text-[10px] text-slate-400 block">Margen requerido</span>
            <span className="text-slate-200">${ev.plan.requiredMarginUsd.toFixed(0)}</span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 block">Liq. estimada</span>
            <span className="text-slate-300">
              {ev.plan.estimatedLiqPrice !== null
                ? formatPrice(ev.plan.estimatedLiqPrice, asset)
                : 'Spot (N/A)'}
            </span>
          </div>
          <div>
            <span className="text-[10px] text-slate-400 block">Funding 4h est.</span>
            <span className="text-slate-300">{ev.plan.effectiveFundingCostPct.toFixed(4)}%</span>
          </div>
        </div>
      ) : (
        <div className="text-xs text-slate-400 bg-[#0B0E14] border border-white/[0.06] rounded p-3">
          Plan de ejecución no disponible por falta de velas válidas.
        </div>
      )}

      {/* Gap-to-80 Analyzer */}
      <div className="bg-[#0B0E14] border border-white/[0.06] rounded px-3 py-2 space-y-1.5">
        <div className="text-[11px] font-medium text-slate-200">{ev.gapTo80.summaryText}</div>
        {ev.gapTo80.topImprovements.length > 0 && ev.score < 80 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono-tabular text-slate-400">
            {ev.gapTo80.topImprovements.map((g) => (
              <span key={g.id}>
                {g.id} ({g.currentPts}→100):{' '}
                <strong className="text-sky-300">+{g.gainTo100.toFixed(1)} pts</strong>
              </span>
            ))}
          </div>
        )}
      </div>

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
  const { asset, setAsset, events, scoringConfig, setScoringConfig } = useTerminalStore();

  const [dataset, setDataset] = useState<MultiTfScoringDataset | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<MatrixFilter>('all');
  const [journal, setJournal] = useState<ScoringJournalEntry[]>(() => loadJournal());

  // Historical Replay / Fase 1 & 2 Audit state
  const [replayAsOfTs, setReplayAsOfTs] = useState<number | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [showChart, setShowChart] = useState(true);

  // Manual trade-close editor state inside Journal
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editReason, setEditReason] = useState<JournalExitReason>('TP1');
  const [editResultR, setEditResultR] = useState<string>('2.0');
  const [editMaeR, setEditMaeR] = useState<string>('0.4');
  const [editMfeR, setEditMfeR] = useState<string>('2.3');

  const loadData = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const ds = await fetchScoringDataset(asset, scoringConfig.mode, signal);
        setDataset(ds);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError(err instanceof Error ? err.message : 'Error al descargar datos OKX para v1.1');
        }
      } finally {
        setLoading(false);
      }
    },
    [asset, scoringConfig.mode]
  );

  useEffect(() => {
    setReplayAsOfTs(null);
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

  const activeDataset = useMemo(() => {
    if (!dataset) return null;
    if (replayAsOfTs === null) return dataset;
    return sliceDatasetAsOf(dataset, replayAsOfTs);
  }, [dataset, replayAsOfTs]);

  const config: ScoringConfig = useMemo(
    () => ({
      ...scoringConfig,
      upcomingEvents: events,
      isReplay: replayAsOfTs !== null,
    }),
    [scoringConfig, events, replayAsOfTs]
  );

  const result = useMemo(() => {
    if (!activeDataset) return null;
    return evaluateScoringSystem(activeDataset, config);
  }, [activeDataset, config]);

  // Replay options: last 32 closed 1H bar closes
  const replayTimestamps = useMemo(() => {
    if (!dataset || dataset.candles1h.length < 220) return [];
    const BAR_1H = 3_600_000;
    return dataset.candles1h
      .slice(-33, -1)
      .reverse()
      .map((c) => c.t + BAR_1H);
  }, [dataset]);

  const historicalAudit: HistoricalAuditSummary | null = useMemo(() => {
    if (!auditOpen || !dataset) return null;
    return evaluateHistoricalAudit(dataset, config, 20);
  }, [auditOpen, dataset, config]);

  const calibration = useMemo(() => computeCalibrationDashboard(journal), [journal]);

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
    const isControl = domEval.verdict !== 'CANDIDATA';
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
      directionTaken: domEval.direction,
      chosenScore: Number(domEval.score.toFixed(2)),
      isControlGroup: isControl,
      status: 'ABIERTA',
      riskBudgetUsd: Number(
        (scoringConfig.capitalUsd * (scoringConfig.riskPct / 100)).toFixed(2)
      ),
    };
    const next = [entry, ...journal].slice(0, 200);
    setJournal(next);
    saveJournal(next);
  };

  const handleAutoGradeOpen = () => {
    if (!dataset || dataset.candles15m.length === 0) return;
    const updated = journal.map((entry) => {
      if (entry.asset !== dataset.asset || entry.status === 'CERRADA') return entry;
      const graded = autoGradeJournalEntry(
        entry,
        dataset.candles15m,
        scoringConfig.feePctPerSide,
        scoringConfig.slippagePctPerSide,
        scoringConfig.expectedFundingCostPct
      );
      return graded ?? entry;
    });
    setJournal(updated);
    saveJournal(updated);
  };

  const startManualClose = (entry: ScoringJournalEntry) => {
    setEditingEntryId(entry.id);
    setEditReason(entry.exitReason ?? 'TP1');
    setEditResultR(
      typeof entry.resultR === 'number'
        ? String(entry.resultR)
        : entry.netRR
        ? String(entry.netRR)
        : '2.0'
    );
    setEditMaeR(typeof entry.maeR === 'number' ? String(entry.maeR) : '0.4');
    setEditMfeR(typeof entry.mfeR === 'number' ? String(entry.mfeR) : '2.2');
  };

  const saveManualClose = (id: string) => {
    const rVal = Number(editResultR);
    const maeVal = Number(editMaeR);
    const mfeVal = Number(editMfeR);
    if (!Number.isFinite(rVal)) return;

    const updated = journal.map((entry) => {
      if (entry.id !== id) return entry;
      const riskBudget = entry.riskBudgetUsd ?? scoringConfig.capitalUsd * (scoringConfig.riskPct / 100);
      return {
        ...entry,
        directionTaken: resolveChosenDirection(entry),
        chosenScore: resolveChosenScore(entry),
        isControlGroup: resolveIsControlGroup(entry),
        status: 'CERRADA' as const,
        exitReason: editReason,
        closedAt: Date.now(),
        resultR: Number(rVal.toFixed(2)),
        pnlUsd: Number((rVal * riskBudget).toFixed(2)),
        maeR: Number.isFinite(maeVal) ? Number(maeVal.toFixed(2)) : entry.maeR,
        mfeR: Number.isFinite(mfeVal) ? Number(mfeVal.toFixed(2)) : entry.mfeR,
      };
    });
    setJournal(updated);
    saveJournal(updated);
    setEditingEntryId(null);
  };

  const handleDeleteEntry = (id: string) => {
    const next = journal.filter((j) => j.id !== id);
    setJournal(next);
    saveJournal(next);
  };

  const handleExportCsv = () => {
    if (journal.length === 0) return;
    const header =
      'FechaUTC,Activo,Modo,Spot,Direccion,NotaElegida,Grupo,LONG,SHORT,VeredictoLONG,VeredictoSHORT,CoberturaPct,RRNeto,Entrada,Stop,Objetivo,Estado,MotivoSalida,ResultadoR,PnLUsd,MAE_R,MFE_R,Bloqueos';
    const rows = journal.map((j) =>
      [
        new Date(j.ts).toISOString(),
        j.asset,
        j.mode,
        j.spot,
        resolveChosenDirection(j),
        resolveChosenScore(j),
        resolveIsControlGroup(j) ? 'Control' : 'v1.1',
        j.longScore,
        j.shortScore,
        j.longVerdict,
        j.shortVerdict,
        j.coveragePct,
        j.netRR ?? '',
        j.entry ?? '',
        j.stopLoss ?? '',
        j.takeProfit ?? '',
        j.status ?? 'ABIERTA',
        j.exitReason ?? '',
        j.resultR ?? '',
        j.pnlUsd ?? '',
        j.maeR ?? '',
        j.mfeR ?? '',
        `"${j.blockSummary}"`,
      ].join(',')
    );
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `registro_calibracion_v1_1_${asset}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const liveFundingEst4hPct =
    dataset?.fundingCurrent8h != null
      ? (Math.abs(dataset.fundingCurrent8h) * 100 * 0.5).toFixed(4)
      : null;

  return (
    <div className="flex-1 overflow-y-auto bg-[#0B0E14] text-slate-200">
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-5">
        {/* 1. Header & Unified Persisted Simulation Controls */}
        <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <span className="text-sky-400 font-medium">Sistema de Puntuación</span>
                <span aria-hidden="true">·</span>
                <span>Especificación v1.1 (4h / 1h / 15m)</span>
                <span aria-hidden="true">·</span>
                <span>
                  {scoringConfig.mode === 'spot'
                    ? 'Velas y libro Spot OKX reales'
                    : 'Velas y libro Perpetuo OKX reales'}
                </span>
              </div>
              <h1 className="text-lg font-semibold text-white">
                Evaluación independiente LONG y SHORT sobre 100 puntos
              </h1>
              <p className="text-xs text-slate-400 max-w-3xl">
                Configuración sincronizada con Opciones de Trading y guardada localmente. Corte
                operable: nota ≥ 80, diferencia ≥ 15 pts, A1 ≥ 75, D1 ≥ 75, RR neto ≥ 2 y cobertura ≥
                90%.
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
                onClick={() => setAuditOpen((v) => !v)}
                disabled={!dataset}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border rounded-md transition-colors whitespace-nowrap ${
                  auditOpen
                    ? 'bg-sky-500/20 border-sky-500/40 text-sky-200'
                    : 'bg-[#0B0E14] hover:bg-[#19202D] border-white/[0.08] text-slate-200'
                }`}
              >
                <History className="w-3.5 h-3.5" />
                <span>{auditOpen ? 'Ocultar auditoría 20v' : 'Auditoría 20 velas'}</span>
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

          {/* Primary Parameter Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 pt-3 border-t border-white/[0.06] text-xs items-end">
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
                  onClick={() => setScoringConfig({ mode: 'perpetual' })}
                  className={`flex-1 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap ${
                    scoringConfig.mode === 'perpetual'
                      ? 'bg-[#1F2937] text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Perp (100)
                </button>
                <button
                  type="button"
                  onClick={() => setScoringConfig({ mode: 'spot' })}
                  className={`flex-1 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap ${
                    scoringConfig.mode === 'spot'
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
                value={scoringConfig.capitalUsd}
                onChange={(e) =>
                  setScoringConfig({
                    capitalUsd: Math.max(100, Number(e.target.value) || 10000),
                  })
                }
                className="w-full bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-1 text-xs font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
              />
            </label>

            <label className="block">
              <span className="block text-[10px] text-slate-400 mb-1">Riesgo / Op (%)</span>
              <input
                type="number"
                min={0.05}
                max={5}
                step={0.05}
                value={scoringConfig.riskPct}
                onChange={(e) =>
                  setScoringConfig({
                    riskPct: Math.min(5, Math.max(0.05, Number(e.target.value) || 0.25)),
                  })
                }
                className="w-full bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-1 text-xs font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
              />
            </label>

            <label className="block">
              <span className="block text-[10px] text-slate-400 mb-1">Apalanc. máx (x)</span>
              <input
                type="number"
                min={1}
                max={50}
                step={1}
                disabled={scoringConfig.mode === 'spot'}
                value={scoringConfig.leverage}
                onChange={(e) =>
                  setScoringConfig({
                    leverage: Math.min(50, Math.max(1, Number(e.target.value) || 5)),
                  })
                }
                className="w-full bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-1 text-xs font-mono-tabular text-white disabled:opacity-40 focus:outline-none focus:border-[#3B82F6]"
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
                  value={scoringConfig.feePctPerSide}
                  onChange={(e) =>
                    setScoringConfig({
                      feePctPerSide: Math.max(0, Number(e.target.value) || 0),
                    })
                  }
                  title="Comisión por lado (%)"
                  className="w-1/2 bg-[#0B0E14] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
                />
                <input
                  type="number"
                  min={0}
                  max={0.5}
                  step={0.01}
                  value={scoringConfig.slippagePctPerSide}
                  onChange={(e) =>
                    setScoringConfig({
                      slippagePctPerSide: Math.max(0, Number(e.target.value) || 0),
                    })
                  }
                  title="Deslizamiento por lado (%)"
                  className="w-1/2 bg-[#0B0E14] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
                />
              </div>
            </label>

            <div className="block">
              <div className="flex items-center justify-between text-[10px] text-slate-400 mb-1">
                <span>Funding 4h (%)</span>
                <button
                  type="button"
                  onClick={() =>
                    setScoringConfig({ autoFundingFromLive: !scoringConfig.autoFundingFromLive })
                  }
                  className="text-sky-400 hover:text-sky-300 font-medium"
                >
                  {scoringConfig.autoFundingFromLive ? 'Auto' : 'Manual'}
                </button>
              </div>
              <input
                type="number"
                min={0}
                max={1}
                step={0.005}
                disabled={scoringConfig.mode === 'spot' || scoringConfig.autoFundingFromLive}
                value={
                  scoringConfig.autoFundingFromLive && liveFundingEst4hPct !== null
                    ? Number(liveFundingEst4hPct)
                    : scoringConfig.expectedFundingCostPct
                }
                onChange={(e) =>
                  setScoringConfig({
                    expectedFundingCostPct: Math.max(0, Number(e.target.value) || 0),
                  })
                }
                className="w-full bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-1 text-xs font-mono-tabular text-white disabled:opacity-50 focus:outline-none focus:border-[#3B82F6]"
              />
            </div>

            <label className="block">
              <span className="block text-[10px] text-slate-400 mb-1">Anclaje C3 (VP 7d)</span>
              <select
                value={scoringConfig.vpLevelLock}
                onChange={(e) =>
                  setScoringConfig({ vpLevelLock: e.target.value as VpLevelLock })
                }
                className="w-full bg-[#0B0E14] border border-white/[0.08] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-[#3B82F6]"
              >
                <option value="auto">Auto (más cercano)</option>
                <option value="POC">Fijar POC 7d</option>
                <option value="VAH">Fijar VAH 7d</option>
                <option value="VAL">Fijar VAL 7d</option>
              </select>
            </label>
          </div>

          {/* Secondary Strip: C2 Anchor Lock, Replay Time-Travel, Macro Guard & Portfolio Stops */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 pt-2 border-t border-white/[0.06] text-xs items-center">
            <label className="block">
              <span className="block text-[10px] text-slate-400 mb-1">
                Anclaje C2 (VWAP pivote 1h)
              </span>
              <select
                value={scoringConfig.avwapAnchorLockTs ?? ''}
                onChange={(e) =>
                  setScoringConfig({
                    avwapAnchorLockTs: e.target.value ? Number(e.target.value) : null,
                  })
                }
                className="w-full bg-[#0B0E14] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
              >
                <option value="">Auto (último pivote 1h)</option>
                {(result?.pivots1h ?? []).map((p) => (
                  <option key={`${p.ts}-${p.type}`} value={p.ts}>
                    {p.type} ${p.price.toFixed(1)} ({formatUtcShort(p.ts)})
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-[10px] text-slate-400 mb-1">
                Modo Temporal (Replay causal)
              </span>
              <select
                value={replayAsOfTs ?? ''}
                onChange={(e) =>
                  setReplayAsOfTs(e.target.value ? Number(e.target.value) : null)
                }
                className="w-full bg-[#0B0E14] border border-white/[0.08] rounded px-2 py-1 text-xs font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
              >
                <option value="">En vivo (última vela cerrada)</option>
                {replayTimestamps.map((ts) => (
                  <option key={ts} value={ts}>
                    Cierre {formatUtcShort(ts)}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-[10px] text-slate-400 mb-1">
                Bloqueo evento macro (h)
              </span>
              <input
                type="number"
                min={0}
                max={24}
                step={0.5}
                value={scoringConfig.macroEventWindowHours}
                onChange={(e) =>
                  setScoringConfig({
                    macroEventWindowHours: Math.max(0, Number(e.target.value) || 0),
                  })
                }
                className="w-full bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-1 text-xs font-mono-tabular text-white focus:outline-none focus:border-[#3B82F6]"
              />
            </label>

            <label className="flex items-center gap-2 bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-1.5 cursor-pointer select-none mt-3 lg:mt-0">
              <input
                type="checkbox"
                checked={scoringConfig.dailyLossReached}
                onChange={(e) => setScoringConfig({ dailyLossReached: e.target.checked })}
                className="accent-rose-500 w-3.5 h-3.5"
              />
              <span className="text-[11px] text-slate-300 truncate">Límite diario 1%</span>
            </label>

            <label className="flex items-center gap-2 bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={scoringConfig.correlatedRiskExceeded}
                onChange={(e) => setScoringConfig({ correlatedRiskExceeded: e.target.checked })}
                className="accent-rose-500 w-3.5 h-3.5"
              />
              <span className="text-[11px] text-slate-300 truncate">Riesgo BTC+ETH</span>
            </label>
          </div>
        </section>

        {replayAsOfTs !== null && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-2.5 text-xs text-amber-200 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 shrink-0" />
              <span>
                Modo Replay Causal activo en <strong>{formatUtcShort(replayAsOfTs)}</strong> —
                evaluando únicamente velas cerradas disponibles en ese instante (sin sesgo futuro).
              </span>
            </div>
            <button
              type="button"
              onClick={() => setReplayAsOfTs(null)}
              className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-white whitespace-nowrap"
            >
              Volver a En vivo
            </button>
          </div>
        )}

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

        {loading && !result && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="h-72 bg-[#12161E] border border-white/[0.08] rounded-lg animate-pulse" />
            <div className="h-72 bg-[#12161E] border border-white/[0.08] rounded-lg animate-pulse" />
          </div>
        )}

        {/* Historical Audit Drawer (Fase 1 & 2) */}
        {auditOpen && historicalAudit && (
          <section className="bg-[#12161E] border border-sky-500/30 rounded-lg p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-white">
                  Auditoría histórica causal (últimos {historicalAudit.evaluatedBars} cortes 1h ·
                  horizonte 16×15m = 4h)
                </h2>
                <p className="text-xs text-slate-400">
                  Simula paso a paso sin datos futuros cómo habría puntuado el sistema y cuál fue el
                  desenlace en las siguientes 16 velas de 15m.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-xs font-mono-tabular">
                <span>
                  Candidatas:{' '}
                  <strong className="text-emerald-300">{historicalAudit.candidataCount}</strong>
                </span>
                <span>
                  Acierto Candidatas:{' '}
                  <strong className="text-white">
                    {historicalAudit.candidataWinRatePct.toFixed(0)}%
                  </strong>
                </span>
                <span>
                  Expectativa v1.1:{' '}
                  <strong
                    className={
                      historicalAudit.candidataExpectancyR >= 0
                        ? 'text-emerald-300'
                        : 'text-rose-300'
                    }
                  >
                    {historicalAudit.candidataExpectancyR >= 0 ? '+' : ''}
                    {historicalAudit.candidataExpectancyR.toFixed(2)} R
                  </strong>
                </span>
                <span>
                  Expectativa Control:{' '}
                  <strong className="text-slate-300">
                    {historicalAudit.controlExpectancyR >= 0 ? '+' : ''}
                    {historicalAudit.controlExpectancyR.toFixed(2)} R
                  </strong>
                </span>
              </div>
            </div>

            <div className="overflow-x-auto max-h-64 overflow-y-auto">
              <table className="w-full text-left border-collapse text-xs font-mono-tabular">
                <thead className="sticky top-0 bg-[#0B0E14]">
                  <tr className="border-b border-white/[0.08] text-[11px] text-slate-400">
                    <th className="py-2 px-2">Corte UTC</th>
                    <th className="py-2 px-2 text-right">Spot</th>
                    <th className="py-2 px-2">Dom.</th>
                    <th className="py-2 px-2 text-right">Nota</th>
                    <th className="py-2 px-2 text-right">RR Neto</th>
                    <th className="py-2 px-2">Veredicto</th>
                    <th className="py-2 px-2">Salida 16v</th>
                    <th className="py-2 px-2 text-right">R Neto</th>
                    <th className="py-2 px-2 text-right">MAE / MFE</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.06]">
                  {historicalAudit.rows.map((r) => (
                    <tr
                      key={r.ts}
                      onClick={() => setReplayAsOfTs(r.ts)}
                      className="hover:bg-white/[0.03] cursor-pointer"
                      title="Clic para abrir este instante exacto en Modo Replay"
                    >
                      <td className="py-1.5 px-2 text-slate-400">{formatUtcShort(r.ts)}</td>
                      <td className="py-1.5 px-2 text-right text-slate-200">
                        {formatPrice(r.spot, asset)}
                      </td>
                      <td
                        className={`py-1.5 px-2 font-semibold ${
                          r.dominant === 'LONG' ? 'text-emerald-300' : 'text-rose-300'
                        }`}
                      >
                        {r.dominant}
                      </td>
                      <td className="py-1.5 px-2 text-right text-white">{r.score.toFixed(1)}</td>
                      <td className="py-1.5 px-2 text-right text-slate-300">
                        {r.netRR !== null ? `${r.netRR.toFixed(2)}R` : '—'}
                      </td>
                      <td
                        className={`py-1.5 px-2 ${
                          r.operable
                            ? 'text-emerald-300 font-semibold'
                            : r.verdict === 'BLOQUEADA'
                            ? 'text-rose-300'
                            : 'text-amber-300'
                        }`}
                      >
                        {r.verdict}
                      </td>
                      <td className="py-1.5 px-2 text-slate-300">{r.forwardOutcome}</td>
                      <td
                        className={`py-1.5 px-2 text-right font-semibold ${
                          (r.forwardR ?? 0) > 0
                            ? 'text-emerald-300'
                            : (r.forwardR ?? 0) < 0
                            ? 'text-rose-300'
                            : 'text-slate-300'
                        }`}
                      >
                        {r.forwardR !== null
                          ? `${r.forwardR >= 0 ? '+' : ''}${r.forwardR.toFixed(2)}R`
                          : '—'}
                      </td>
                      <td className="py-1.5 px-2 text-right text-slate-400">
                        {r.maeR !== null && r.mfeR !== null
                          ? `${r.maeR.toFixed(2)} / ${r.mfeR.toFixed(2)}`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {result && activeDataset && (
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
                      {result.activeVpSelection.usedLabel}: $
                      {result.activeVpSelection.levelPrice?.toFixed(0)} (VA $
                      {result.volumeProfile7d.val.toFixed(0)}–$
                      {result.volumeProfile7d.vah.toFixed(0)})
                    </span>
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[11px]">
                <span>4h: {formatUtcShort(result.lastClosed4hTs)}</span>
                <span aria-hidden="true">·</span>
                <span>1h: {formatUtcShort(result.lastClosed1hTs)}</span>
                <span aria-hidden="true">·</span>
                <span>15m: {formatUtcShort(result.lastClosed15mTs)}</span>
                <button
                  type="button"
                  onClick={() => setShowChart((v) => !v)}
                  className="text-sky-400 hover:text-sky-300 font-sans font-medium"
                >
                  {showChart ? 'Ocultar gráfico' : 'Mostrar gráfico'}
                </button>
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

            {/* 2b. Multi-Timeframe Visual Audit Chart */}
            {showChart && (
              <ScoringAuditChart
                dataset={activeDataset}
                result={result}
                avwapAnchorLockTs={scoringConfig.avwapAnchorLockTs}
              />
            )}

            {/* 2c. Auxiliary Market Context (§12 · 0 points) */}
            <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <h2 className="text-sm font-semibold text-white">
                  Contexto auxiliar de mercado (§12 · 0 pts, no altera la puntuación)
                </h2>
                <span className="text-[11px] text-slate-400">
                  Señales informativas fuera de los 100 puntos obligatorios
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs font-mono-tabular">
                <div className="bg-[#0B0E14] border border-white/[0.06] rounded p-2.5">
                  <span className="text-[10px] text-slate-400 block font-sans">
                    Bollinger 1h (20,2)
                  </span>
                  <span className="text-white font-semibold">{result.auxiliary.bbStateLabel}</span>
                  <span className="block text-[10px] text-slate-400 mt-0.5">
                    {result.auxiliary.bbBandwidthPct !== null
                      ? `Ancho ${result.auxiliary.bbBandwidthPct.toFixed(2)}% (P${result.auxiliary.bbSqueezePercentile?.toFixed(0)})`
                      : 'N/D'}
                  </span>
                </div>

                <div className="bg-[#0B0E14] border border-white/[0.06] rounded p-2.5">
                  <span className="text-[10px] text-slate-400 block font-sans">
                    Divergencia RSI 1h
                  </span>
                  <span
                    className={`font-semibold ${
                      result.auxiliary.rsiDivergence === 'Alcista'
                        ? 'text-emerald-300'
                        : result.auxiliary.rsiDivergence === 'Bajista'
                        ? 'text-rose-300'
                        : 'text-slate-200'
                    }`}
                  >
                    {result.auxiliary.rsiDivergence}
                  </span>
                  <span className="block text-[10px] text-slate-400 mt-0.5">
                    Sobre últimos pivotes 2v
                  </span>
                </div>

                <div className="bg-[#0B0E14] border border-white/[0.06] rounded p-2.5">
                  <span className="text-[10px] text-slate-400 block font-sans">
                    Muro Bid OKX cercano
                  </span>
                  <span className="text-emerald-300 font-semibold">
                    {result.auxiliary.nearestBidWall
                      ? formatPrice(result.auxiliary.nearestBidWall.price, result.asset)
                      : 'N/D'}
                  </span>
                  <span className="block text-[10px] text-slate-400 mt-0.5">
                    {result.auxiliary.nearestBidWall
                      ? formatCompactUsd(result.auxiliary.nearestBidWall.notionalUsd)
                      : 'Sin libro'}
                  </span>
                </div>

                <div className="bg-[#0B0E14] border border-white/[0.06] rounded p-2.5">
                  <span className="text-[10px] text-slate-400 block font-sans">
                    Muro Ask OKX cercano
                  </span>
                  <span className="text-rose-300 font-semibold">
                    {result.auxiliary.nearestAskWall
                      ? formatPrice(result.auxiliary.nearestAskWall.price, result.asset)
                      : 'N/D'}
                  </span>
                  <span className="block text-[10px] text-slate-400 mt-0.5">
                    {result.auxiliary.bookImbalancePct !== null
                      ? `Imbalance ${result.auxiliary.bookImbalancePct >= 0 ? '+' : ''}${result.auxiliary.bookImbalancePct.toFixed(1)}%`
                      : 'Sin libro'}
                  </span>
                </div>

                <div className="bg-[#0B0E14] border border-white/[0.06] rounded p-2.5">
                  <span className="text-[10px] text-slate-400 block font-sans">
                    OI SWAP en vivo
                  </span>
                  <span className="text-white font-semibold">
                    {result.auxiliary.swapLiveOiCcy !== null
                      ? `${result.auxiliary.swapLiveOiCcy.toLocaleString('en-US', {
                          maximumFractionDigits: 0,
                        })} ${result.asset}`
                      : result.mode === 'spot'
                      ? 'N/A (Spot)'
                      : 'N/D'}
                  </span>
                  <span className="block text-[10px] text-slate-400 mt-0.5">
                    {result.auxiliary.swapLiveOiUsd
                      ? formatCompactUsd(result.auxiliary.swapLiveOiUsd)
                      : 'Contrato perpetuo'}
                  </span>
                </div>

                <div className="bg-[#0B0E14] border border-white/[0.06] rounded p-2.5">
                  <span className="text-[10px] text-slate-400 block font-sans">
                    Próximo evento macro
                  </span>
                  <span className="text-white font-semibold truncate block">
                    {result.auxiliary.nextMacroEvent
                      ? result.auxiliary.nextMacroEvent.name
                      : 'Sin eventos cargados'}
                  </span>
                  <span className="block text-[10px] text-slate-400 mt-0.5">
                    {result.auxiliary.nextMacroEvent
                      ? `En ${Math.max(0, result.auxiliary.nextMacroEvent.hoursAway).toFixed(1)}h (${result.auxiliary.nextMacroEvent.impact})`
                      : `Ventana ≤ ${scoringConfig.macroEventWindowHours}h`}
                  </span>
                </div>
              </div>
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
                            <span>
                              LONG ({fam.longPassedCount}/{fam.totalApplicableCount})
                            </span>
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
                            <span>
                              SHORT ({fam.shortPassedCount}/{fam.totalApplicableCount})
                            </span>
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

            {/* 5. Demo Calibration Dashboard & Evaluation Journal (§13 & §14) */}
            <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-semibold text-white">
                    Protocolo Demo y Calibración (§13 y §14 · v1.1)
                  </h2>
                  <p className="text-xs text-slate-400">
                    Separa operaciones filtradas v1.1 frente a grupo de control, evalúa salidas a 16
                    velas de 15m (4h) y calibra rendimiento por bandas ({journal.length} registros).
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleAutoGradeOpen}
                    disabled={!dataset || calibration.openCount === 0}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-[#0B0E14] hover:bg-[#19202D] disabled:opacity-40 border border-white/[0.08] rounded text-sky-300 whitespace-nowrap"
                  >
                    <Clock className="w-3.5 h-3.5" />
                    <span>Auto-evaluar abiertas (16v)</span>
                  </button>
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

              {/* §14 Metrics Comparison: Sistema v1.1 vs Grupo de Control + Bandas */}
              {calibration.closedCount > 0 && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  {/* Filtered vs Control Summary */}
                  <div className="bg-[#0B0E14] border border-white/[0.06] rounded p-3 space-y-2">
                    <div className="text-xs font-semibold text-white">
                      Métricas v1.1 vs Grupo de Control (operaciones cerradas)
                    </div>
                    <table className="w-full text-left border-collapse text-xs font-mono-tabular">
                      <thead>
                        <tr className="border-b border-white/[0.06] text-[11px] text-slate-400">
                          <th className="py-1.5">Grupo</th>
                          <th className="py-1.5 text-right">Ops</th>
                          <th className="py-1.5 text-right">Acierto</th>
                          <th className="py-1.5 text-right">Exp. R</th>
                          <th className="py-1.5 text-right">PF</th>
                          <th className="py-1.5 text-right">DD máx</th>
                          <th className="py-1.5 text-right">Coste R</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.06]">
                        {[calibration.filteredStats, calibration.controlStats].map((gs) => (
                          <tr key={gs.label}>
                            <td className="py-1.5 font-sans text-slate-200">{gs.label}</td>
                            <td className="py-1.5 text-right text-slate-300">{gs.closedTrades}</td>
                            <td className="py-1.5 text-right text-slate-200">
                              {gs.closedTrades > 0 ? `${gs.winRatePct.toFixed(0)}%` : '—'}
                            </td>
                            <td
                              className={`py-1.5 text-right font-semibold ${
                                gs.expectancyR >= 0 ? 'text-emerald-300' : 'text-rose-300'
                              }`}
                            >
                              {gs.closedTrades > 0
                                ? `${gs.expectancyR >= 0 ? '+' : ''}${gs.expectancyR.toFixed(2)}R`
                                : '—'}
                            </td>
                            <td className="py-1.5 text-right text-slate-200">
                              {gs.profitFactor === null
                                ? '—'
                                : gs.profitFactor === Infinity
                                ? '∞'
                                : gs.profitFactor.toFixed(2)}
                            </td>
                            <td className="py-1.5 text-right text-rose-300">
                              {gs.closedTrades > 0 ? `-${gs.maxDrawdownR.toFixed(2)}R` : '—'}
                            </td>
                            <td className="py-1.5 text-right text-slate-400">
                              {gs.closedTrades > 0 ? `${gs.avgCostsR.toFixed(2)}R` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Calibration by Score Bands */}
                  <div className="bg-[#0B0E14] border border-white/[0.06] rounded p-3 space-y-2">
                    <div className="text-xs font-semibold text-white">
                      Calibración por bandas de puntuación (§14)
                    </div>
                    <table className="w-full text-left border-collapse text-xs font-mono-tabular">
                      <thead>
                        <tr className="border-b border-white/[0.06] text-[11px] text-slate-400">
                          <th className="py-1.5">Banda</th>
                          <th className="py-1.5 text-right">Ops</th>
                          <th className="py-1.5 text-right">Acierto</th>
                          <th className="py-1.5 text-right">Expectativa R</th>
                          <th className="py-1.5 text-right">MAE medio</th>
                          <th className="py-1.5 text-right">MFE medio</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/[0.06]">
                        {calibration.bandStats.map((bs) => (
                          <tr key={bs.bandLabel}>
                            <td className="py-1.5 text-white">{bs.bandLabel}</td>
                            <td className="py-1.5 text-right text-slate-300">{bs.closedTrades}</td>
                            <td className="py-1.5 text-right text-slate-200">
                              {bs.closedTrades > 0 ? `${bs.winRatePct.toFixed(0)}%` : '—'}
                            </td>
                            <td
                              className={`py-1.5 text-right font-semibold ${
                                bs.expectancyR >= 0 ? 'text-emerald-300' : 'text-rose-300'
                              }`}
                            >
                              {bs.closedTrades > 0
                                ? `${bs.expectancyR >= 0 ? '+' : ''}${bs.expectancyR.toFixed(2)}R`
                                : '—'}
                            </td>
                            <td className="py-1.5 text-right text-rose-300">
                              {bs.closedTrades > 0 ? `${bs.avgMaeR.toFixed(2)}R` : '—'}
                            </td>
                            <td className="py-1.5 text-right text-emerald-300">
                              {bs.closedTrades > 0 ? `${bs.avgMfeR.toFixed(2)}R` : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {journal.length === 0 ? (
                <div className="text-xs text-slate-400 bg-[#0B0E14] border border-white/[0.06] rounded p-3">
                  Aún no hay evaluaciones registradas. Pulsa «Registrar evaluación» arriba para
                  guardar la instantánea actual y evaluar su resultado tras hasta 16 velas de 15m.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-xs font-mono-tabular">
                    <thead>
                      <tr className="border-b border-white/[0.08] text-[11px] text-slate-400">
                        <th className="py-2 px-2">Fecha UTC</th>
                        <th className="py-2 px-2">Activo</th>
                        <th className="py-2 px-2">Dir · Grupo</th>
                        <th className="py-2 px-2 text-right">Nota</th>
                        <th className="py-2 px-2 text-right">RR Neto</th>
                        <th className="py-2 px-2">Estado / Salida</th>
                        <th className="py-2 px-2 text-right">Resultado R</th>
                        <th className="py-2 px-2 text-right">MAE / MFE</th>
                        <th className="py-2 px-2 text-right">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                      {journal.slice(0, 20).map((j) => {
                        const dir = resolveChosenDirection(j);
                        const chosenScore = resolveChosenScore(j);
                        const isCtrl = resolveIsControlGroup(j);
                        const isEditing = editingEntryId === j.id;

                        return (
                          <tr key={j.id} className="hover:bg-white/[0.02]">
                            <td className="py-2 px-2 text-slate-400">
                              {new Date(j.ts).toISOString().slice(5, 16).replace('T', ' ')}
                            </td>
                            <td className="py-2 px-2 text-white">
                              {j.asset} ({j.mode === 'perpetual' ? 'Perp' : 'Spot'})
                            </td>
                            <td className="py-2 px-2 font-sans">
                              <span
                                className={
                                  dir === 'LONG'
                                    ? 'text-emerald-300 font-semibold'
                                    : 'text-rose-300 font-semibold'
                                }
                              >
                                {dir}
                              </span>{' '}
                              <span className="text-slate-400">
                                · {isCtrl ? 'Control' : 'v1.1'}
                              </span>
                            </td>
                            <td className="py-2 px-2 text-right text-white font-semibold">
                              {chosenScore.toFixed(1)}
                            </td>
                            <td className="py-2 px-2 text-right text-slate-200">
                              {j.netRR !== null ? `${j.netRR.toFixed(2)} R` : '—'}
                            </td>
                            <td className="py-2 px-2 text-slate-300 font-sans">
                              {isEditing ? (
                                <select
                                  value={editReason}
                                  onChange={(e) =>
                                    setEditReason(e.target.value as JournalExitReason)
                                  }
                                  className="bg-[#0B0E14] border border-white/[0.15] rounded px-1.5 py-0.5 text-xs text-white"
                                >
                                  <option value="TP1">TP1</option>
                                  <option value="STOP">STOP</option>
                                  <option value="TEMPORAL_16V">Temporal 16v</option>
                                  <option value="MANUAL">Manual</option>
                                </select>
                              ) : j.status === 'CERRADA' ? (
                                <span>Cerrada · {j.exitReason ?? 'MANUAL'}</span>
                              ) : (
                                <span className="text-amber-300">Abierta ({j.blockSummary})</span>
                              )}
                            </td>
                            <td className="py-2 px-2 text-right">
                              {isEditing ? (
                                <input
                                  type="number"
                                  step="0.1"
                                  value={editResultR}
                                  onChange={(e) => setEditResultR(e.target.value)}
                                  className="w-16 bg-[#0B0E14] border border-white/[0.15] rounded px-1.5 py-0.5 text-xs text-right text-white"
                                />
                              ) : typeof j.resultR === 'number' ? (
                                <span
                                  className={`font-semibold ${
                                    j.resultR >= 0 ? 'text-emerald-300' : 'text-rose-300'
                                  }`}
                                >
                                  {j.resultR >= 0 ? '+' : ''}
                                  {j.resultR.toFixed(2)} R
                                </span>
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="py-2 px-2 text-right text-slate-400">
                              {isEditing ? (
                                <div className="flex items-center justify-end gap-1">
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={editMaeR}
                                    onChange={(e) => setEditMaeR(e.target.value)}
                                    title="MAE en R"
                                    className="w-12 bg-[#0B0E14] border border-white/[0.15] rounded px-1 py-0.5 text-xs text-right text-white"
                                  />
                                  <input
                                    type="number"
                                    step="0.1"
                                    value={editMfeR}
                                    onChange={(e) => setEditMfeR(e.target.value)}
                                    title="MFE en R"
                                    className="w-12 bg-[#0B0E14] border border-white/[0.15] rounded px-1 py-0.5 text-xs text-right text-white"
                                  />
                                </div>
                              ) : typeof j.maeR === 'number' && typeof j.mfeR === 'number' ? (
                                `${j.maeR.toFixed(2)} / ${j.mfeR.toFixed(2)}`
                              ) : (
                                '—'
                              )}
                            </td>
                            <td className="py-2 px-2 text-right font-sans">
                              {isEditing ? (
                                <div className="flex items-center justify-end gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => saveManualClose(j.id)}
                                    className="px-2 py-0.5 bg-emerald-500/20 text-emerald-300 rounded text-[11px] hover:bg-emerald-500/30"
                                  >
                                    Guardar
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setEditingEntryId(null)}
                                    className="px-2 py-0.5 bg-white/[0.06] text-slate-300 rounded text-[11px]"
                                  >
                                    Cancelar
                                  </button>
                                </div>
                              ) : (
                                <div className="flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={() => startManualClose(j)}
                                    className="text-sky-400 hover:text-sky-300 text-[11px]"
                                  >
                                    {j.status === 'CERRADA' ? 'Editar' : 'Cerrar'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteEntry(j.id)}
                                    className="text-slate-500 hover:text-rose-400 text-[11px]"
                                    aria-label="Eliminar registro"
                                  >
                                    ×
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
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
