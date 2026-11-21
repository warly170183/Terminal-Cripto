import { useMemo, useState } from 'react';
import { Layers, Loader2, TrendingUp } from 'lucide-react';
import { calculateVolatilitySmile, getAvailableExpiries } from '../../calc/options';
import type { SupportResistanceZone } from '../../calc/technicalAnalysis';
import { useTerminalStore } from '../../store/terminalStore';
import type { Levels, SymbolAsset } from '../../types/market';

type VolatilitySmileChartProps = {
  asset: SymbolAsset;
  spot: number;
  srZones: SupportResistanceZone[];
  optionsLevels: Levels;
  pocPrice: number | null;
};

type SmileRangeMode = 20 | 35 | null;

function formatStrike(val: number, asset: SymbolAsset): string {
  return `$${val.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: asset === 'BTC' ? 0 : 1,
  })}`;
}

export function VolatilitySmileChart({
  asset,
  spot,
  srZones,
  optionsLevels,
  pocPrice,
}: VolatilitySmileChartProps) {
  const { options, optionsLoading, providerName, selectedExpiry, setSelectedExpiry } =
    useTerminalStore();

  const [rangePct, setRangePct] = useState<SmileRangeMode>(35);
  const [showCallPut, setShowCallPut] = useState(true);
  const [showSrLevels, setShowSrLevels] = useState(true);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const expiries = useMemo(() => getAvailableExpiries(options), [options]);

  const smile = useMemo(
    () =>
      calculateVolatilitySmile({
        options,
        spot,
        expiry: selectedExpiry,
        srZones,
        optionsLevels,
        pocPrice,
        rangePct,
      }),
    [options, spot, selectedExpiry, srZones, optionsLevels, pocPrice, rangePct]
  );

  const pts = smile.points;
  const activeExpiry = smile.expiry || selectedExpiry;

  const nearestSupport = useMemo(
    () => smile.levelAlignments.find((l) => l.kind === 'support') ?? null,
    [smile.levelAlignments]
  );
  const nearestResistance = useMemo(
    () => smile.levelAlignments.find((l) => l.kind === 'resistance') ?? null,
    [smile.levelAlignments]
  );

  // SVG Coordinate Geometry
  const W = 980;
  const H = 248;
  const padL = 46;
  const padR = 22;
  const padTop = 26;
  const padBot = 30;
  const innerW = W - padL - padR;
  const innerH = H - padTop - padBot;

  const minStrike = useMemo(() => {
    if (pts.length === 0) return spot * 0.8;
    const minPt = pts[0].strike;
    // Slightly include spot if close
    return Math.min(minPt, spot > 0 ? spot * 0.99 : minPt);
  }, [pts, spot]);

  const maxStrike = useMemo(() => {
    if (pts.length === 0) return spot * 1.2;
    const maxPt = pts[pts.length - 1].strike;
    return Math.max(maxPt, spot > 0 ? spot * 1.01 : maxPt);
  }, [pts, spot]);

  const { minIv, maxIv } = useMemo(() => {
    if (pts.length === 0) return { minIv: 30, maxIv: 80 };
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      if (p.smileIvPct < lo) lo = p.smileIvPct;
      if (p.smileIvPct > hi) hi = p.smileIvPct;
      if (showCallPut) {
        if (p.callIvPct !== null) {
          lo = Math.min(lo, p.callIvPct);
          hi = Math.max(hi, p.callIvPct);
        }
        if (p.putIvPct !== null) {
          lo = Math.min(lo, p.putIvPct);
          hi = Math.max(hi, p.putIvPct);
        }
      }
    }
    const span = Math.max(6, hi - lo);
    return {
      minIv: Math.max(0, lo - span * 0.16),
      maxIv: hi + span * 0.18,
    };
  }, [pts, showCallPut]);

  const strikeSpan = Math.max(1, maxStrike - minStrike);
  const ivSpan = Math.max(1, maxIv - minIv);

  const toX = (strike: number) => padL + ((strike - minStrike) / strikeSpan) * innerW;
  const toY = (ivPct: number) => padTop + (1 - (ivPct - minIv) / ivSpan) * innerH;

  const smilePath = useMemo(() => {
    if (pts.length === 0) return '';
    return pts
      .map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${toX(p.strike).toFixed(1)} ${toY(p.smileIvPct).toFixed(1)}`)
      .join(' ');
  }, [pts, minStrike, strikeSpan, minIv, ivSpan]);

  const callPath = useMemo(() => {
    if (!showCallPut || pts.length === 0) return '';
    let d = '';
    let started = false;
    for (const p of pts) {
      if (p.callIvPct === null) {
        started = false;
        continue;
      }
      d += `${started ? 'L' : 'M'} ${toX(p.strike).toFixed(1)} ${toY(p.callIvPct).toFixed(1)} `;
      started = true;
    }
    return d.trim();
  }, [pts, showCallPut, minStrike, strikeSpan, minIv, ivSpan]);

  const putPath = useMemo(() => {
    if (!showCallPut || pts.length === 0) return '';
    let d = '';
    let started = false;
    for (const p of pts) {
      if (p.putIvPct === null) {
        started = false;
        continue;
      }
      d += `${started ? 'L' : 'M'} ${toX(p.strike).toFixed(1)} ${toY(p.putIvPct).toFixed(1)} `;
      started = true;
    }
    return d.trim();
  }, [pts, showCallPut, minStrike, strikeSpan, minIv, ivSpan]);

  const hovered = hoverIdx !== null && pts[hoverIdx] ? pts[hoverIdx] : null;

  // Visible S/R + Options Walls markers inside strike X-domain
  const visibleMarkers = useMemo(() => {
    if (!showSrLevels) return [];
    return smile.levelAlignments.filter(
      (lvl) => lvl.price >= minStrike && lvl.price <= maxStrike
    );
  }, [showSrLevels, smile.levelAlignments, minStrike, maxStrike]);

  // 4 horizontal IV grid lines
  const ivGridTicks = useMemo(() => {
    const steps = 4;
    return Array.from({ length: steps + 1 }, (_, i) => minIv + (ivSpan * i) / steps);
  }, [minIv, ivSpan]);

  // X-axis strike ticks (max ~7 cleanly spaced)
  const strikeTicks = useMemo(() => {
    if (pts.length === 0) return [];
    const step = Math.max(1, Math.ceil(pts.length / 7));
    const out: number[] = [];
    for (let i = 0; i < pts.length; i += step) {
      out.push(pts[i].strike);
    }
    const lastStrike = pts[pts.length - 1].strike;
    if (out[out.length - 1] !== lastStrike) out.push(lastStrike);
    return out;
  }, [pts]);

  return (
    <section className="bg-[#12161E] border border-white/[0.08] rounded-lg overflow-hidden">
      {/* Header Controls */}
      <div className="px-4 py-3 border-b border-white/[0.06] bg-[#111621] flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <TrendingUp className="w-4 h-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-white">
              Volatilidad Implícita por Strike (Volatility Smile)
            </h2>
            <span className="px-1.5 py-0.5 rounded bg-[#0B0E11] border border-white/[0.08] text-[10px] font-mono-tabular text-sky-300 uppercase">
              {providerName}
            </span>
            {optionsLoading && (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Actualizando cadena</span>
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-400">
            Curva OTM de volatilidad implícita del proveedor alineada verticalmente con niveles
            técnicos de Soporte / Resistencia y muros Put / Call.
          </p>
        </div>

        {/* Expiry, Range & Overlay Toggles */}
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <label className="flex items-center gap-1.5 text-slate-400">
            <span>Vencimiento:</span>
            <select
              value={activeExpiry}
              onChange={(e) => {
                setSelectedExpiry(e.target.value);
                setHoverIdx(null);
              }}
              className="bg-[#0B0E11] border border-white/[0.1] rounded px-2 py-1 text-[11px] font-mono-tabular text-white focus:outline-none focus:border-sky-500"
            >
              {expiries.length === 0 ? (
                <option value="">Sin vencimientos</option>
              ) : (
                expiries.map((exp) => (
                  <option key={exp.expiry} value={exp.expiry}>
                    {exp.expiry} ({exp.daysToExpiry < 1 ? '<1d' : `${exp.daysToExpiry.toFixed(0)}d`})
                  </option>
                ))
              )}
            </select>
          </label>

          <div
            className="flex items-center bg-[#0B0E11] p-0.5 rounded border border-white/[0.08] font-mono-tabular"
            role="group"
            aria-label="Rango strikes alrededor de Spot"
          >
            {(
              [
                { val: 20, label: '±20%' },
                { val: 35, label: '±35%' },
                { val: null, label: 'Todo' },
              ] as const
            ).map((opt) => (
              <button
                key={String(opt.val)}
                type="button"
                onClick={() => {
                  setRangePct(opt.val);
                  setHoverIdx(null);
                }}
                className={`px-2 py-0.5 rounded text-[10px] transition-colors ${
                  rangePct === opt.val
                    ? 'bg-[#1F2937] text-white font-semibold'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowCallPut((v) => !v)}
            className={`px-2 py-1 rounded border text-[10.5px] transition-colors ${
              showCallPut
                ? 'bg-[#1F2937] border-sky-500/45 text-white'
                : 'bg-[#0B0E11] border-white/[0.08] text-slate-400 hover:text-slate-200'
            }`}
          >
            Calls / Puts
          </button>

          <button
            type="button"
            onClick={() => setShowSrLevels((v) => !v)}
            className={`flex items-center gap-1 px-2 py-1 rounded border text-[10.5px] transition-colors ${
              showSrLevels
                ? 'bg-[#1F2937] border-emerald-500/45 text-white'
                : 'bg-[#0B0E11] border-white/[0.08] text-slate-400 hover:text-slate-200'
            }`}
          >
            <Layers className="w-3 h-3" />
            <span>S/R &amp; Muros</span>
          </button>
        </div>
      </div>

      {/* Telemetry & S/R Alignment Summary Strip */}
      <div className="px-4 py-2 bg-[#0E131C] border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-3 text-[11px] font-mono-tabular">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            IV ATM:{' '}
            <strong className="text-white">
              {smile.atmIvPct !== null ? `${smile.atmIvPct.toFixed(1)}%` : '—'}
            </strong>
          </span>

          <span>
            Skew (±10%):{' '}
            <strong
              className={
                smile.skew10Pct === null
                  ? 'text-slate-400'
                  : smile.skew10Pct > 2
                  ? 'text-rose-300'
                  : smile.skew10Pct < -2
                  ? 'text-emerald-300'
                  : 'text-slate-200'
              }
            >
              {smile.skew10Pct !== null
                ? `${smile.skew10Pct >= 0 ? '+' : ''}${smile.skew10Pct.toFixed(1)}% (${
                    smile.skew10Pct > 2
                      ? 'Put Skew'
                      : smile.skew10Pct < -2
                      ? 'Call Skew'
                      : 'Simétrico'
                  })`
                : '—'}
            </strong>
          </span>

          <span>
            Curvatura:{' '}
            <strong className="text-sky-300">
              {smile.wingCurvaturePct !== null
                ? `${smile.wingCurvaturePct >= 0 ? '+' : ''}${smile.wingCurvaturePct.toFixed(1)}%`
                : '—'}
            </strong>
          </span>

          {smile.minIvStrike !== null && smile.minIvPct !== null && (
            <span className="text-slate-400">
              Valle IV: <strong className="text-slate-200">{formatStrike(smile.minIvStrike, asset)}</strong> (
              {smile.minIvPct.toFixed(1)}%)
            </span>
          )}
        </div>

        {/* S1 / R1 IV alignment badges */}
        <div className="flex flex-wrap items-center gap-3 text-[10.5px]">
          {nearestSupport && (
            <span className="text-emerald-300">
              Soporte {formatStrike(nearestSupport.price, asset)} → IV{' '}
              <strong>
                {nearestSupport.ivAtLevelPct !== null
                  ? `${nearestSupport.ivAtLevelPct.toFixed(1)}%`
                  : '—'}
              </strong>
            </span>
          )}
          {nearestResistance && (
            <span className="text-rose-300">
              Resistencia {formatStrike(nearestResistance.price, asset)} → IV{' '}
              <strong>
                {nearestResistance.ivAtLevelPct !== null
                  ? `${nearestResistance.ivAtLevelPct.toFixed(1)}%`
                  : '—'}
              </strong>
            </span>
          )}
        </div>
      </div>

      {/* Interactive SVG Volatility Smile Canvas */}
      <div className="relative px-3 py-2.5 bg-[#0B0E14]">
        {hovered && (
          <div className="pointer-events-none absolute top-3 left-14 z-10 bg-[#0E131C]/95 border border-white/[0.14] rounded px-2.5 py-1 text-[10.5px] font-mono-tabular text-slate-200 flex flex-wrap items-center gap-3">
            <span className="text-white font-bold">
              Strike {formatStrike(hovered.strike, asset)} (
              {hovered.moneynessPct >= 0 ? '+' : ''}
              {hovered.moneynessPct.toFixed(1)}%)
            </span>
            <span className="text-sky-300 font-semibold">
              Smile {hovered.smileIvPct.toFixed(1)}%
            </span>
            {hovered.callIvPct !== null && (
              <span className="text-emerald-300">Call {hovered.callIvPct.toFixed(1)}%</span>
            )}
            {hovered.putIvPct !== null && (
              <span className="text-rose-300">Put {hovered.putIvPct.toFixed(1)}%</span>
            )}
            <span className="text-slate-400">
              OI: C {hovered.callOi.toFixed(0)} · P {hovered.putOi.toFixed(0)}
            </span>
          </div>
        )}

        {pts.length < 3 ? (
          <div className="h-[220px] flex items-center justify-center text-xs text-slate-500">
            {optionsLoading
              ? `Cargando cadena de opciones de ${providerName.toUpperCase()} para construir el Volatility Smile...`
              : 'Datos insuficientes en la cadena de opciones para graficar la sonrisa de volatilidad.'}
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="w-full h-[230px] cursor-crosshair select-none"
            onMouseLeave={() => setHoverIdx(null)}
            onMouseMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const relX = ((e.clientX - rect.left) / rect.width) * W;
              const targetStrike =
                minStrike + Math.min(1, Math.max(0, (relX - padL) / innerW)) * strikeSpan;
              let bestIdx = 0;
              let bestDist = Infinity;
              pts.forEach((p, idx) => {
                const d = Math.abs(p.strike - targetStrike);
                if (d < bestDist) {
                  bestDist = d;
                  bestIdx = idx;
                }
              });
              setHoverIdx(bestIdx);
            }}
          >
            {/* Horizontal IV % grid */}
            {ivGridTicks.map((tick) => {
              const y = toY(tick);
              return (
                <g key={tick.toFixed(2)}>
                  <line
                    x1={padL}
                    y1={y}
                    x2={W - padR}
                    y2={y}
                    stroke="rgba(255,255,255,0.06)"
                  />
                  <text
                    x={padL - 6}
                    y={y + 3}
                    textAnchor="end"
                    fill="#64748B"
                    fontSize="10"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {tick.toFixed(0)}%
                  </text>
                </g>
              );
            })}

            {/* Support / Resistance / Wall vertical alignment lines */}
            {(() => {
              const sorted = [...visibleMarkers].sort((a, b) => a.price - b.price);
              let lastLabelX = -Infinity;
              let staggerRow = 0;
              return sorted.map((lvl) => {
                const x = toX(lvl.price);
                if (x - lastLabelX < 68) {
                  staggerRow = (staggerRow + 1) % 2;
                } else {
                  staggerRow = 0;
                }
                lastLabelX = x;
                const labelY = staggerRow === 0 ? padTop - 8 : padTop + 10;

                const isSup = lvl.kind === 'support' || lvl.kind === 'put_wall';
                const isPoc = lvl.kind === 'poc';
                const stroke = isPoc
                  ? 'rgba(250, 204, 21, 0.55)'
                  : isSup
                  ? 'rgba(16, 185, 129, 0.52)'
                  : 'rgba(244, 63, 94, 0.52)';
                const textColor = isPoc ? '#FACC15' : isSup ? '#34D399' : '#FB7185';
                const shortTag =
                  lvl.kind === 'support' || lvl.kind === 'resistance'
                    ? lvl.label.split(' ')[0]
                    : lvl.label;
                const markerY = lvl.ivAtLevelPct !== null ? toY(lvl.ivAtLevelPct) : null;

                return (
                  <g key={lvl.id}>
                    <line
                      x1={x}
                      y1={padTop}
                      x2={x}
                      y2={padTop + innerH}
                      stroke={stroke}
                      strokeDasharray="3 3"
                      strokeWidth="1.2"
                    />
                    <text
                      x={x}
                      y={labelY}
                      textAnchor="middle"
                      fill={textColor}
                      fontSize="9.5"
                      fontWeight="600"
                      fontFamily="JetBrains Mono, monospace"
                    >
                      {shortTag}
                      {lvl.ivAtLevelPct !== null ? ` (${lvl.ivAtLevelPct.toFixed(0)}%)` : ''}
                    </text>
                    {markerY !== null && (
                      <circle
                        cx={x}
                        cy={markerY}
                        r={3.5}
                        fill={textColor}
                        stroke="#0B0E14"
                        strokeWidth="1.2"
                      />
                    )}
                  </g>
                );
              });
            })()}

            {/* Spot Price Reference Line */}
            {spot >= minStrike && spot <= maxStrike && (
              <g>
                <line
                  x1={toX(spot)}
                  y1={padTop}
                  x2={toX(spot)}
                  y2={padTop + innerH}
                  stroke="rgba(226, 232, 240, 0.5)"
                  strokeWidth="1.3"
                />
                <text
                  x={toX(spot)}
                  y={padTop + innerH - 6}
                  textAnchor="middle"
                  fill="#E2E8F0"
                  fontSize="9.5"
                  fontWeight="600"
                  fontFamily="JetBrains Mono, monospace"
                >
                  SPOT {formatStrike(spot, asset)}
                </text>
              </g>
            )}

            {/* Dashed Call IV & Put IV overlay curves */}
            {callPath && (
              <path
                d={callPath}
                fill="none"
                stroke="rgba(52, 211, 153, 0.65)"
                strokeWidth="1.4"
                strokeDasharray="4 3"
              />
            )}
            {putPath && (
              <path
                d={putPath}
                fill="none"
                stroke="rgba(251, 113, 133, 0.65)"
                strokeWidth="1.4"
                strokeDasharray="4 3"
              />
            )}

            {/* Primary OTM Composite Volatility Smile Curve */}
            {smilePath && (
              <path
                d={smilePath}
                fill="none"
                stroke="#38BDF8"
                strokeWidth="2.4"
                strokeLinejoin="round"
              />
            )}

            {/* Strike points */}
            {pts.map((p, idx) => (
              <circle
                key={p.strike}
                cx={toX(p.strike)}
                cy={toY(p.smileIvPct)}
                r={hoverIdx === idx ? 4.8 : 2.2}
                fill={hoverIdx === idx ? '#FFFFFF' : '#38BDF8'}
                stroke={hoverIdx === idx ? '#38BDF8' : 'none'}
                strokeWidth={hoverIdx === idx ? 2 : 0}
              />
            ))}

            {/* Hover Crosshair */}
            {hovered && (
              <line
                x1={toX(hovered.strike)}
                y1={padTop}
                x2={toX(hovered.strike)}
                y2={padTop + innerH}
                stroke="rgba(226, 232, 240, 0.35)"
                strokeDasharray="2 2"
              />
            )}

            {/* X-axis Strike ticks */}
            {strikeTicks.map((k) => (
              <text
                key={k}
                x={toX(k)}
                y={H - 8}
                textAnchor="middle"
                fill="#64748B"
                fontSize="10"
                fontFamily="JetBrains Mono, monospace"
              >
                {formatStrike(k, asset)}
              </text>
            ))}
          </svg>
        )}

        {/* Compact Legend */}
        <div className="mt-1.5 px-2 flex flex-wrap items-center justify-between gap-2 text-[10.5px] text-slate-400">
          <div className="flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3.5 h-0.5 bg-sky-400 inline-block" />
              <span>Smile OTM (Puts &lt; Spot / Calls &gt; Spot)</span>
            </span>
            {showCallPut && (
              <>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3.5 h-0.5 border-t border-dashed border-emerald-400 inline-block" />
                  <span>Call IV</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-3.5 h-0.5 border-t border-dashed border-rose-400 inline-block" />
                  <span>Put IV</span>
                </span>
              </>
            )}
            {showSrLevels && (
              <>
                <span className="inline-flex items-center gap-1.5 text-emerald-300">
                  <span>│ Soportes / Put Wall</span>
                </span>
                <span className="inline-flex items-center gap-1.5 text-rose-300">
                  <span>│ Resistencias / Call Wall</span>
                </span>
                <span className="inline-flex items-center gap-1.5 text-amber-300">
                  <span>│ POC VPVR</span>
                </span>
              </>
            )}
          </div>
          <span className="font-mono-tabular text-slate-500">
            {pts.length} strikes activos · {activeExpiry || '—'}
          </span>
        </div>
      </div>
    </section>
  );
}
