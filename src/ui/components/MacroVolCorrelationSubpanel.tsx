import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import {
  calculateRolling30dVolMacroCorrelation,
  type CorrelationWindowDays,
} from '../../calc/newsSentiment';
import {
  fetchBtcEthDailyCandles,
  fetchDailySentimentHistory,
  type DailySentimentPoint,
} from '../../data/newsClient';
import { useTerminalStore } from '../../store/terminalStore';
import type { Candle } from '../../types/market';

const WINDOW_OPTIONS: { value: CorrelationWindowDays; label: string; horizon: string }[] = [
  { value: 7, label: '7D', horizon: 'Corto plazo' },
  { value: 14, label: '14D', horizon: 'Intermedio' },
  { value: 30, label: '30D', horizon: 'Medio plazo' },
];

type MacroVolCorrelationSubpanelProps = {
  windowDays?: CorrelationWindowDays;
  onChangeWindowDays?: (w: CorrelationWindowDays) => void;
};

function formatCorr(val: number | null): string {
  if (val === null || !Number.isFinite(val)) return '—';
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}`;
}

export function MacroVolCorrelationSubpanel({
  windowDays: controlledWindowDays,
  onChangeWindowDays,
}: MacroVolCorrelationSubpanelProps = {}) {
  const { newsItems, events } = useTerminalStore();

  const [internalWindowDays, setInternalWindowDays] = useState<CorrelationWindowDays>(30);
  const windowDays = controlledWindowDays ?? internalWindowDays;
  const setWindowDays = (next: CorrelationWindowDays) => {
    if (onChangeWindowDays) onChangeWindowDays(next);
    else setInternalWindowDays(next);
  };

  const [btcDaily, setBtcDaily] = useState<Candle[]>([]);
  const [ethDaily, setEthDaily] = useState<Candle[]>([]);
  const [dailySentiment, setDailySentiment] = useState<DailySentimentPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [showBtc, setShowBtc] = useState(true);
  const [showEth, setShowEth] = useState(true);
  const [showIntensityBars, setShowIntensityBars] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    async function load() {
      setLoading(true);
      try {
        const [candlesRes, fngRes] = await Promise.all([
          fetchBtcEthDailyCandles(110, ctrl.signal),
          fetchDailySentimentHistory(ctrl.signal),
        ]);
        if (cancelled) return;
        setBtcDaily(candlesRes.btcDaily);
        setEthDaily(candlesRes.ethDaily);
        setDailySentiment(fngRes);
      } catch {
        // ignore transient network errors
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    const id = setInterval(() => {
      void load();
    }, 300_000);

    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(id);
    };
  }, []);

  const summary = useMemo(
    () =>
      calculateRolling30dVolMacroCorrelation({
        btcDaily,
        ethDaily,
        headlines: newsItems,
        macroEvents: events,
        dailySentiment,
        windowDays,
      }),
    [btcDaily, ethDaily, newsItems, events, dailySentiment, windowDays]
  );

  // Reference 7D vs 30D BTC correlation comparison to highlight short- vs medium-term sensitivity shift
  const shortVsMediumSummary = useMemo(() => {
    const r7 =
      windowDays === 7
        ? summary.latestRBtc
        : calculateRolling30dVolMacroCorrelation({
            btcDaily,
            ethDaily,
            headlines: newsItems,
            macroEvents: events,
            dailySentiment,
            windowDays: 7,
          }).latestRBtc;
    const r30 =
      windowDays === 30
        ? summary.latestRBtc
        : calculateRolling30dVolMacroCorrelation({
            btcDaily,
            ethDaily,
            headlines: newsItems,
            macroEvents: events,
            dailySentiment,
            windowDays: 30,
          }).latestRBtc;
    return { r7, r30 };
  }, [btcDaily, ethDaily, newsItems, events, dailySentiment, windowDays, summary.latestRBtc]);

  const series = summary.series;
  const hovered = hoverIdx !== null && series[hoverIdx] ? series[hoverIdx] : null;

  const chartHeight = expanded ? 185 : 108;
  const W = 900;
  const H = expanded ? 185 : 114;
  const padL = 34;
  const padR = 14;
  const padTop = 14;
  const padBot = 18;
  const innerW = W - padL - padR;
  const innerH = H - padTop - padBot;

  const toX = (idx: number) =>
    series.length <= 1 ? padL + innerW / 2 : padL + (idx / (series.length - 1)) * innerW;
  const toY = (r: number) => {
    const clamped = Math.max(-1, Math.min(1, r));
    return padTop + ((1 - clamped) / 2) * innerH;
  };

  const buildPath = (getter: (pt: (typeof series)[number]) => number | null) => {
    let d = '';
    let started = false;
    series.forEach((pt, idx) => {
      const val = getter(pt);
      if (val === null) {
        started = false;
        return;
      }
      d += `${started ? 'L' : 'M'} ${toX(idx).toFixed(1)} ${toY(val).toFixed(1)} `;
      started = true;
    });
    return d.trim();
  };

  const btcPath = showBtc ? buildPath((p) => p.rBtc) : '';
  const ethPath = showEth ? buildPath((p) => p.rEth) : '';

  const yZero = toY(0);
  const yPlus30 = toY(0.3);
  const yMinus30 = toY(-0.3);

  return (
    <div className="border-t border-white/[0.08] bg-[#0B0E14] flex flex-col shrink-0">
      {/* Header Telemetry & Controls */}
      <div className="px-3 py-1.5 bg-[#0E131C] border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="font-semibold text-white">
            Correlación Móvil {windowDays}D · Macro/Sentimiento vs Volatilidad
          </span>
          <div
            className="flex items-center bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]"
            role="group"
            aria-label="Ventana deslizante de correlación"
          >
            {WINDOW_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  setWindowDays(opt.value);
                  setHoverIdx(null);
                }}
                title={`Ventana deslizante de ${opt.value} días (${opt.horizon})`}
                className={`px-1.5 py-0.5 rounded text-[10px] font-mono-tabular font-medium transition-colors ${
                  windowDays === opt.value
                    ? 'bg-[#1F2937] text-white'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {loading && series.length === 0 && (
            <span className="inline-flex items-center gap-1 text-sky-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              <span>Calculando {windowDays}d</span>
            </span>
          )}
          <span className="hidden xl:inline text-[10.5px] text-slate-400">
            {summary.regimeLabel}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 font-mono-tabular">
          <span>
            r BTC ({windowDays}d):{' '}
            <strong
              className={
                summary.latestRBtc === null
                  ? 'text-slate-400'
                  : summary.latestRBtc >= 0.2
                  ? 'text-amber-300'
                  : summary.latestRBtc <= -0.2
                  ? 'text-rose-300'
                  : 'text-slate-200'
              }
            >
              {formatCorr(summary.latestRBtc)}
            </strong>
            {summary.delta7dRBtc !== null && (
              <span className="text-[10px] text-slate-500 ml-1">
                (Δ7d {summary.delta7dRBtc >= 0 ? '+' : ''}
                {summary.delta7dRBtc.toFixed(2)})
              </span>
            )}
          </span>

          <span>
            r ETH:{' '}
            <strong
              className={
                summary.latestREth === null
                  ? 'text-slate-400'
                  : summary.latestREth >= 0.2
                  ? 'text-sky-300'
                  : summary.latestREth <= -0.2
                  ? 'text-rose-300'
                  : 'text-slate-200'
              }
            >
              {formatCorr(summary.latestREth)}
            </strong>
          </span>

          {shortVsMediumSummary.r7 !== null && shortVsMediumSummary.r30 !== null && (
            <span
              className="hidden 2xl:inline text-[10px] text-slate-400 border-l border-white/[0.08] pl-2.5"
              title="Comparativa de sensibilidad BTC a corto plazo (7D) frente a medio plazo (30D)"
            >
              Corto 7D <strong className="text-slate-200">{formatCorr(shortVsMediumSummary.r7)}</strong> vs
              Medio 30D <strong className="text-slate-200">{formatCorr(shortVsMediumSummary.r30)}</strong>
            </span>
          )}

          <span className="text-slate-400 hidden sm:inline">
            Vol {windowDays}d: BTC{' '}
            {summary.avgBtcVol30d !== null ? `${summary.avgBtcVol30d.toFixed(2)}%` : '—'} · ETH{' '}
            {summary.avgEthVol30d !== null ? `${summary.avgEthVol30d.toFixed(2)}%` : '—'}
          </span>

          <div className="flex items-center gap-1 font-sans">
            <button
              type="button"
              onClick={() => setShowBtc((v) => !v)}
              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                showBtc
                  ? 'bg-amber-500/15 border-amber-500/45 text-amber-300'
                  : 'bg-[#0B0E14] border-white/[0.08] text-slate-500'
              }`}
            >
              BTC
            </button>
            <button
              type="button"
              onClick={() => setShowEth((v) => !v)}
              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                showEth
                  ? 'bg-sky-500/15 border-sky-500/45 text-sky-300'
                  : 'bg-[#0B0E14] border-white/[0.08] text-slate-500'
              }`}
            >
              ETH
            </button>
            <button
              type="button"
              onClick={() => setShowIntensityBars((v) => !v)}
              className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors ${
                showIntensityBars
                  ? 'bg-white/[0.08] border-white/[0.2] text-slate-200'
                  : 'bg-[#0B0E14] border-white/[0.08] text-slate-500'
              }`}
            >
              Intensidad
            </button>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="p-0.5 rounded bg-[#0B0E14] border border-white/[0.08] text-slate-400 hover:text-white"
              title={expanded ? 'Contraer sub-panel' : 'Ampliar sub-panel'}
            >
              {expanded ? (
                <ChevronDown className="w-3.5 h-3.5" />
              ) : (
                <ChevronUp className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Hover inspection bar + Rolling Correlation Chart */}
      <div className="relative px-2 py-1.5">
        {hovered && (
          <div className="pointer-events-none absolute top-2 left-11 z-10 bg-[#0E131C]/95 border border-white/[0.12] rounded px-2 py-0.5 text-[10px] font-mono-tabular text-slate-200 flex flex-wrap items-center gap-2.5">
            <span className="text-white font-semibold">{hovered.dateKey}</span>
            <span className="text-amber-300">rBTC {formatCorr(hovered.rBtc)}</span>
            <span className="text-sky-300">rETH {formatCorr(hovered.rEth)}</span>
            <span className="text-slate-300">
              Vol BTC {hovered.btcVolPct !== null ? `${hovered.btcVolPct.toFixed(2)}%` : '—'} · ETH{' '}
              {hovered.ethVolPct !== null ? `${hovered.ethVolPct.toFixed(2)}%` : '—'}
            </span>
            <span className="text-violet-300">Intensidad {hovered.intensity}/100</span>
            {hovered.macroEventsOnDay.length > 0 && (
              <span className="text-amber-200">
                Macro: {hovered.macroEventsOnDay.join(', ')}
              </span>
            )}
          </div>
        )}

        {series.length < 2 ? (
          <div
            style={{ height: `${chartHeight}px` }}
            className="flex items-center justify-center text-xs text-slate-500"
          >
            {loading
              ? 'Cargando histórico diario de BTC/ETH e intensidad macro...'
              : `Datos diarios insuficientes para ventana móvil de ${windowDays} días.`}
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            style={{ height: `${chartHeight}px` }}
            onMouseLeave={() => setHoverIdx(null)}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = ((e.clientX - rect.left) / rect.width) * W;
              const frac = Math.min(1, Math.max(0, (relX - padL) / innerW));
              setHoverIdx(Math.round(frac * (series.length - 1)));
            }}
            className="w-full cursor-crosshair select-none"
          >
            {/* Positive / Negative strong coupling bands */}
            <rect
              x={padL}
              y={padTop}
              width={innerW}
              height={Math.max(0, yPlus30 - padTop)}
              fill="rgba(16, 185, 129, 0.045)"
            />
            <rect
              x={padL}
              y={yMinus30}
              width={innerW}
              height={Math.max(0, padTop + innerH - yMinus30)}
              fill="rgba(244, 63, 94, 0.045)"
            />

            {/* Grid & Correlation Reference Lines */}
            {[
              { y: toY(1), label: '+1.0', dash: false },
              { y: yPlus30, label: '+0.3', dash: true },
              { y: yZero, label: ' 0.0', dash: false },
              { y: yMinus30, label: '-0.3', dash: true },
              { y: toY(-1), label: '-1.0', dash: false },
            ].map((g) => (
              <g key={g.label}>
                <line
                  x1={padL}
                  y1={g.y}
                  x2={W - padR}
                  y2={g.y}
                  stroke={g.label === ' 0.0' ? 'rgba(148,163,184,0.38)' : 'rgba(255,255,255,0.06)'}
                  strokeDasharray={g.dash ? '3 3' : undefined}
                />
                <text
                  x={padL - 4}
                  y={g.y + 3}
                  textAnchor="end"
                  fill="#64748B"
                  fontSize="9"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {g.label}
                </text>
              </g>
            ))}

            {/* Daily Macro/News Intensity Bars (bottom normalized backdrop) */}
            {showIntensityBars &&
              series.map((pt, idx) => {
                const x = toX(idx);
                const barW = Math.max(3, (innerW / series.length) * 0.55);
                const barH = (pt.intensity / 100) * (innerH * 0.42);
                const y = padTop + innerH - barH;
                const hasMacro = pt.macroEventsOnDay.length > 0;
                return (
                  <g key={pt.dateKey}>
                    <rect
                      x={x - barW / 2}
                      y={y}
                      width={barW}
                      height={barH}
                      rx={1}
                      fill={hasMacro ? 'rgba(250, 204, 21, 0.36)' : 'rgba(148, 163, 184, 0.16)'}
                    />
                    {hasMacro && (
                      <circle cx={x} cy={padTop + 5} r={2.8} fill="#FACC15" />
                    )}
                  </g>
                );
              })}

            {/* ETH 30D Rolling Correlation Line */}
            {ethPath && (
              <path
                d={ethPath}
                fill="none"
                stroke="#38BDF8"
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
            )}

            {/* BTC 30D Rolling Correlation Line */}
            {btcPath && (
              <path
                d={btcPath}
                fill="none"
                stroke="#F59E0B"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            )}

            {/* Hover crosshair */}
            {hoverIdx !== null && series[hoverIdx] && (
              <line
                x1={toX(hoverIdx)}
                y1={padTop}
                x2={toX(hoverIdx)}
                y2={padTop + innerH}
                stroke="rgba(226, 232, 240, 0.45)"
                strokeDasharray="2 2"
              />
            )}

            {/* X-axis Start / Mid / End UTC dates */}
            {series.length >= 3 && (
              <>
                <text
                  x={padL}
                  y={H - 4}
                  fill="#64748B"
                  fontSize="9"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {series[0].dateKey.slice(5)}
                </text>
                <text
                  x={toX(Math.floor(series.length / 2))}
                  y={H - 4}
                  textAnchor="middle"
                  fill="#64748B"
                  fontSize="9"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {series[Math.floor(series.length / 2)].dateKey.slice(5)}
                </text>
                <text
                  x={W - padR}
                  y={H - 4}
                  textAnchor="end"
                  fill="#64748B"
                  fontSize="9"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {series[series.length - 1].dateKey.slice(5)}
                </text>
              </>
            )}
          </svg>
        )}
      </div>
    </div>
  );
}
