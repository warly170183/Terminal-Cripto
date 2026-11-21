import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Award, Layers, TrendingUp } from 'lucide-react';
import type { EffectivenessBreakdownItem } from '../../calc/signalEffectiveness';

type DisplayUnitMode = 'pct' | 'count';

interface TooltipPayloadItem {
  payload?: EffectivenessBreakdownItem;
}

function StackedChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
}) {
  if (!active || !payload || payload.length === 0 || !payload[0]?.payload) {
    return null;
  }
  const row = payload[0].payload;

  return (
    <div className="bg-[#0B0E14] border border-white/[0.14] rounded-md px-3 py-2.5 shadow-xl text-[11px] font-mono-tabular min-w-[230px] space-y-1.5">
      <div className="font-sans font-semibold text-white text-xs border-b border-white/[0.08] pb-1">
        {row.label}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        <span className="text-slate-400">Índice Efectividad:</span>
        <span className="text-right font-semibold text-sky-300">
          {row.indexPct !== null ? `${row.indexPct.toFixed(1)}%` : '—'}
        </span>
        <span className="text-slate-400">Acierto TP1/TP2:</span>
        <span className="text-right font-semibold text-emerald-300">
          {row.tpHitRatePct !== null ? `${row.tpHitRatePct.toFixed(1)}%` : '—'} ({row.fulfilledCount}/
          {row.evaluatedCount})
        </span>
        <span className="text-slate-400">Expectativa R:</span>
        <span
          className={`text-right font-semibold ${
            row.avgR !== null && row.avgR > 0
              ? 'text-emerald-300'
              : row.avgR !== null && row.avgR < 0
              ? 'text-rose-300'
              : 'text-slate-300'
          }`}
        >
          {row.avgR !== null ? `${row.avgR >= 0 ? '+' : ''}${row.avgR.toFixed(2)}R` : '—'}
        </span>
      </div>

      <div className="border-t border-white/[0.08] pt-1 space-y-0.5 text-[10.5px]">
        <div className="flex justify-between text-emerald-400">
          <span>TP2 Cumplida (100%)</span>
          <span>
            {row.tp2Pct.toFixed(1)}% · {row.tp2Count}
          </span>
        </div>
        <div className="flex justify-between text-teal-300">
          <span>TP1 Cumplida (85%)</span>
          <span>
            {row.tp1Pct.toFixed(1)}% · {row.tp1Count}
          </span>
        </div>
        <div className="flex justify-between text-amber-300">
          <span>Expirada Favorable</span>
          <span>
            {row.expiredFavPct.toFixed(1)}% · {row.expiredFavCount}
          </span>
        </div>
        <div className="flex justify-between text-orange-300">
          <span>Expirada Desfavorable</span>
          <span>
            {row.expiredUnfavPct.toFixed(1)}% · {row.expiredUnfavCount}
          </span>
        </div>
        <div className="flex justify-between text-rose-400">
          <span>Stop Loss (Fallida)</span>
          <span>
            {row.stopPct.toFixed(1)}% · {row.stopCount}
          </span>
        </div>
      </div>
    </div>
  );
}

function StackedStrategyBarChart({
  title,
  subtitle,
  data,
  unitMode,
  emptyText,
}: {
  title: string;
  subtitle: string;
  data: EffectivenessBreakdownItem[];
  unitMode: DisplayUnitMode;
  emptyText: string;
}) {
  const evaluatedRows = useMemo(
    () =>
      data
        .filter((d) => d.evaluatedCount > 0)
        .slice()
        .sort((a, b) => (b.tpHitRatePct ?? 0) - (a.tpHitRatePct ?? 0) || b.evaluatedCount - a.evaluatedCount),
    [data]
  );

  const chartHeight = Math.max(230, evaluatedRows.length * 42 + 62);
  const isPct = unitMode === 'pct';

  return (
    <div className="bg-[#0B0E11] border border-white/[0.08] rounded-lg p-3.5 space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-white">{title}</h3>
          <p className="text-[11px] text-slate-400">{subtitle}</p>
        </div>
        <span className="text-[10.5px] font-mono-tabular text-slate-400">
          {evaluatedRows.length} categoría{evaluatedRows.length === 1 ? '' : 's'} evaluadas
        </span>
      </div>

      {evaluatedRows.length === 0 ? (
        <div className="h-[220px] flex items-center justify-center text-xs text-slate-500 text-center px-4">
          {emptyText}
        </div>
      ) : (
        <div style={{ width: '100%', height: chartHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={evaluatedRows}
              layout="vertical"
              margin={{ top: 8, right: 18, left: 6, bottom: 4 }}
              barSize={18}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
              <XAxis
                type="number"
                domain={isPct ? [0, 100] : [0, 'auto']}
                tickFormatter={(v: number) => (isPct ? `${v}%` : `${v}`)}
                tick={{ fill: '#94a3b8', fontSize: 10 }}
                axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
                tickLine={false}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={175}
                tick={{ fill: '#e2e8f0', fontSize: 10.5 }}
                axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
                tickLine={false}
              />
              {isPct && (
                <ReferenceLine
                  x={50}
                  stroke="rgba(255,255,255,0.22)"
                  strokeDasharray="4 4"
                />
              )}
              <Tooltip
                content={<StackedChartTooltip />}
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
              />
              <Legend
                wrapperStyle={{ fontSize: '10.5px', paddingTop: '6px' }}
                iconType="square"
                iconSize={8}
              />
              <Bar
                dataKey={isPct ? 'tp2Pct' : 'tp2Count'}
                name="TP2 (100%)"
                stackId="outcome"
                fill="#10b981"
                radius={[0, 0, 0, 0]}
              />
              <Bar
                dataKey={isPct ? 'tp1Pct' : 'tp1Count'}
                name="TP1 (85%)"
                stackId="outcome"
                fill="#2dd4bf"
              />
              <Bar
                dataKey={isPct ? 'expiredFavPct' : 'expiredFavCount'}
                name="Exp. Fav."
                stackId="outcome"
                fill="#f59e0b"
              />
              <Bar
                dataKey={isPct ? 'expiredUnfavPct' : 'expiredUnfavCount'}
                name="Exp. Desfav."
                stackId="outcome"
                fill="#fb923c"
              />
              <Bar
                dataKey={isPct ? 'stopPct' : 'stopCount'}
                name="Stop Loss"
                stackId="outcome"
                fill="#f43f5e"
                radius={[0, 3, 3, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export function SignalStrategyStackedDashboard({
  bySignalType,
  byTechnicalDriver,
}: {
  bySignalType: EffectivenessBreakdownItem[];
  byTechnicalDriver: EffectivenessBreakdownItem[];
}) {
  const [unitMode, setUnitMode] = useState<DisplayUnitMode>('pct');

  const evaluatedStrategies = useMemo(
    () => bySignalType.filter((s) => s.evaluatedCount > 0),
    [bySignalType]
  );

  const bestByHitRate = useMemo(() => {
    if (evaluatedStrategies.length === 0) return null;
    return [...evaluatedStrategies].sort(
      (a, b) => (b.tpHitRatePct ?? -1) - (a.tpHitRatePct ?? -1) || b.evaluatedCount - a.evaluatedCount
    )[0];
  }, [evaluatedStrategies]);

  const bestByIndex = useMemo(() => {
    if (evaluatedStrategies.length === 0) return null;
    return [...evaluatedStrategies].sort(
      (a, b) => (b.indexPct ?? -1) - (a.indexPct ?? -1) || b.evaluatedCount - a.evaluatedCount
    )[0];
  }, [evaluatedStrategies]);

  const bestDriver = useMemo(() => {
    const ev = byTechnicalDriver.filter((d) => d.evaluatedCount > 0);
    if (ev.length === 0) return null;
    return [...ev].sort(
      (a, b) => (b.tpHitRatePct ?? -1) - (a.tpHitRatePct ?? -1) || b.evaluatedCount - a.evaluatedCount
    )[0];
  }, [byTechnicalDriver]);

  return (
    <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-white">
            <Layers className="w-4 h-4 text-sky-400 shrink-0" />
            <span>Dashboard de Tasa de Acierto por Tipo de Señal (Barras Apiladas)</span>
          </div>
          <p className="text-[11px] text-slate-400">
            Compara proporcionalmente qué estrategias y confirmaciones técnicas alcanzan TP1/TP2 frente
            a expiraciones y Stop Loss.
          </p>
        </div>

        <div className="flex items-center bg-[#0B0E11] p-0.5 rounded border border-white/[0.08] text-[11px]">
          <button
            type="button"
            onClick={() => setUnitMode('pct')}
            className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap ${
              unitMode === 'pct' ? 'bg-[#1F2937] text-white font-medium' : 'text-slate-400 hover:text-white'
            }`}
          >
            Proporción 0–100%
          </button>
          <button
            type="button"
            onClick={() => setUnitMode('count')}
            className={`px-2.5 py-1 rounded transition-colors whitespace-nowrap ${
              unitMode === 'count' ? 'bg-[#1F2937] text-white font-medium' : 'text-slate-400 hover:text-white'
            }`}
          >
            Conteo (# señales)
          </button>
        </div>
      </div>

      {/* Top Performing Strategy Callouts */}
      {evaluatedStrategies.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="bg-[#0B0E11] border border-white/[0.06] rounded-md px-3 py-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="block text-[10px] uppercase tracking-wider text-slate-400">
                Mayor Tasa Acierto (TP1+TP2)
              </span>
              <span className="font-medium text-white truncate block">
                {bestByHitRate?.label ?? '—'}
              </span>
            </div>
            <span className="font-mono-tabular font-bold text-emerald-300 shrink-0 flex items-center gap-1">
              <Award className="w-3.5 h-3.5" />
              {bestByHitRate?.tpHitRatePct !== null && bestByHitRate?.tpHitRatePct !== undefined
                ? `${bestByHitRate.tpHitRatePct.toFixed(1)}%`
                : '—'}
            </span>
          </div>

          <div className="bg-[#0B0E11] border border-white/[0.06] rounded-md px-3 py-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="block text-[10px] uppercase tracking-wider text-slate-400">
                Mayor Índice Ponderado
              </span>
              <span className="font-medium text-white truncate block">
                {bestByIndex?.label ?? '—'}
              </span>
            </div>
            <span className="font-mono-tabular font-bold text-sky-300 shrink-0 flex items-center gap-1">
              <TrendingUp className="w-3.5 h-3.5" />
              {bestByIndex?.indexPct !== null && bestByIndex?.indexPct !== undefined
                ? `${bestByIndex.indexPct.toFixed(1)}%`
                : '—'}
            </span>
          </div>

          <div className="bg-[#0B0E11] border border-white/[0.06] rounded-md px-3 py-2 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="block text-[10px] uppercase tracking-wider text-slate-400">
                Disparador Técnico Más Efectivo
              </span>
              <span className="font-medium text-white truncate block">
                {bestDriver?.label ?? '—'}
              </span>
            </div>
            <span className="font-mono-tabular font-bold text-teal-300 shrink-0">
              {bestDriver?.tpHitRatePct !== null && bestDriver?.tpHitRatePct !== undefined
                ? `${bestDriver.tpHitRatePct.toFixed(1)}% (${bestDriver.fulfilledCount}/${bestDriver.evaluatedCount})`
                : '—'}
            </span>
          </div>
        </div>
      )}

      {/* Dual Stacked Recharts Bar Charts */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <StackedStrategyBarChart
          title="Por Tipo de Señal / Estrategia"
          subtitle="Rebote en soporte SSL, ruptura alcista, fuerza de vendedor, rechazo BSL y confluencia"
          data={bySignalType}
          unitMode={unitMode}
          emptyText="Aún no hay señales evaluadas para comparar por tipo de estrategia."
        />
        <StackedStrategyBarChart
          title="Por Factor / Disparador Técnico"
          subtitle="Efectividad según el soporte técnico presente (Fib, FVG, VPVR, MTF, Taker, Clúster)"
          data={byTechnicalDriver}
          unitMode={unitMode}
          emptyText="Aún no hay señales evaluadas con factores técnicos registrados."
        />
      </div>
    </section>
  );
}
