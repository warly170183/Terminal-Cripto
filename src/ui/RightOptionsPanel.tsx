import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, Star, Trash2 } from 'lucide-react';
import { getAtTheMoneyIV } from '../calc/cone';
import { analyzeMarketLiquidity } from '../calc/liquidity';
import {
  aggregateStrikes,
  calculateLevels,
  calculateTermStructure,
  getAvailableExpiries,
} from '../calc/options';
import { useTerminalStore } from '../store/terminalStore';
import type { GexLadderMode, RightPanelTab } from '../store/terminalStore';

function formatCompactUsd(val: number): string {
  const abs = Math.abs(val);
  const sign = val < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function formatPrice(val: number | null, asset: 'BTC' | 'ETH'): string {
  if (val === null || !Number.isFinite(val)) return '—';
  return `$${val.toLocaleString('en-US', {
    maximumFractionDigits: asset === 'BTC' ? 0 : 1,
  })}`;
}

export function RightOptionsPanel() {
  const {
    asset,
    candles,
    ticker,
    options,
    optionTrades,
    orderbook,
    optionsLoading,
    optionsError,
    optionsUpdatedAt,
    selectedExpiry,
    providerName,
    setProviderName,
    rightTab,
    setRightTab,
    ladderMode,
    setLadderMode,
    prevDayHigh,
    prevDayLow,
    userLevels,
    selectedLevelId,
    setSelectedLevelId,
    removeUserLevel,
  } = useTerminalStore();

  const [ladderFilterAll, setLadderFilterAll] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(true);

  const spot = ticker?.idxPx ?? candles[candles.length - 1]?.c ?? 0;

  const activeOptions = useMemo(() => {
    if (ladderFilterAll || !selectedExpiry) return options;
    return options.filter((o) => o.expiry === selectedExpiry);
  }, [options, ladderFilterAll, selectedExpiry]);

  const strikesAsc = useMemo(() => {
    return aggregateStrikes(activeOptions, spot, 'ALL');
  }, [activeOptions, spot]);

  const levels = useMemo(() => {
    return calculateLevels(strikesAsc, activeOptions, spot);
  }, [strikesAsc, activeOptions, spot]);

  const visibleStrikesDesc = useMemo(() => {
    const withActivity = strikesAsc.filter((s) => s.oi > 0 || Math.abs(s.gex) > 0);
    if (withActivity.length === 0) return [];
    let closestIdx = 0;
    let minD = Infinity;
    for (let i = 0; i < withActivity.length; i++) {
      const d = Math.abs(withActivity[i].strike - spot);
      if (d < minD) {
        minD = d;
        closestIdx = i;
      }
    }
    const start = Math.max(0, closestIdx - 18);
    const end = Math.min(withActivity.length, closestIdx + 19);
    return withActivity.slice(start, end).reverse();
  }, [strikesAsc, spot]);

  const activeStrikesCount = useMemo(
    () => strikesAsc.filter((s) => s.oi > 0).length,
    [strikesAsc]
  );

  const maxExposureStrike = useMemo(() => {
    if (visibleStrikesDesc.length === 0) return null;
    return visibleStrikesDesc.reduce((best, r) => {
      const val =
        ladderMode === 'GEX' || ladderMode === 'MultiMap'
          ? Math.abs(r.gex)
          : ladderMode === 'DEX'
          ? Math.abs(r.dex)
          : r.oi;
      const bestVal =
        ladderMode === 'GEX' || ladderMode === 'MultiMap'
          ? Math.abs(best.gex)
          : ladderMode === 'DEX'
          ? Math.abs(best.dex)
          : best.oi;
      return val > bestVal ? r : best;
    }, visibleStrikesDesc[0]).strike;
  }, [visibleStrikesDesc, ladderMode]);

  const { maxAbsBar, totalAbsExposure } = useMemo(() => {
    let m = 1;
    let sum = 0;
    for (const r of visibleStrikesDesc) {
      const v =
        ladderMode === 'GEX' || ladderMode === 'MultiMap'
          ? Math.abs(r.gex)
          : ladderMode === 'DEX'
          ? Math.abs(r.dex)
          : r.oi;
      if (v > m) m = v;
      sum += v;
    }
    return { maxAbsBar: m, totalAbsExposure: sum > 0 ? sum : 1 };
  }, [visibleStrikesDesc, ladderMode]);

  // MultiMap breakdown: near-term expiry (0..next) vs structural rest-of-chain GEX
  const availableExpiries = useMemo(() => getAvailableExpiries(options), [options]);
  const nearExpiry = availableExpiries[0]?.expiry ?? '';

  const multiMapByStrike = useMemo(() => {
    const map = new Map<number, { nearGex: number; farGex: number }>();
    if (ladderMode !== 'MultiMap' || options.length === 0 || spot <= 0) {
      return { map, maxSegment: 1 };
    }
    const nearRows = nearExpiry
      ? aggregateStrikes(
          options.filter((o) => o.expiry === nearExpiry),
          spot,
          'ALL'
        )
      : [];
    const nearMap = new Map(nearRows.map((r) => [r.strike, r.gex]));

    let maxSegment = 1;
    for (const row of visibleStrikesDesc) {
      const nearGex = nearMap.get(row.strike) ?? 0;
      const farGex = row.gex - nearGex;
      map.set(row.strike, { nearGex, farGex });
      const totAbs = Math.abs(nearGex) + Math.abs(farGex);
      if (totAbs > maxSegment) maxSegment = totAbs;
    }
    return { map, maxSegment };
  }, [ladderMode, options, spot, nearExpiry, visibleStrikesDesc]);

  const closestSpotStrike = useMemo(() => {
    if (visibleStrikesDesc.length === 0 || spot <= 0) return null;
    return visibleStrikesDesc.reduce((best, r) =>
      Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best
    ).strike;
  }, [visibleStrikesDesc, spot]);

  const atmIv = useMemo(() => {
    if (!selectedExpiry || spot <= 0) return 0;
    return getAtTheMoneyIV(options, spot, selectedExpiry);
  }, [options, spot, selectedExpiry]);

  const termStructure = useMemo(
    () => calculateTermStructure(options, spot).slice(0, 8),
    [options, spot]
  );

  const totals = useMemo(() => {
    let callOi = 0;
    let putOi = 0;
    for (const s of strikesAsc) {
      callOi += s.callOi;
      putOi += s.putOi;
    }
    return {
      callOi,
      putOi,
      pcRatio: callOi > 0 ? putOi / callOi : 0,
    };
  }, [strikesAsc]);

  const regimeAboveFlip = levels.flip !== null ? spot >= levels.flip : levels.netGex >= 0;

  const liquidityAnalysis = useMemo(
    () =>
      analyzeMarketLiquidity(candles, spot, levels, orderbook, prevDayHigh, prevDayLow),
    [candles, spot, levels, orderbook, prevDayHigh, prevDayLow]
  );

  return (
    <aside className="w-full lg:w-80 xl:w-[356px] bg-[#12161E] border-t lg:border-t-0 lg:border-l border-white/[0.08] flex flex-col shrink-0 lg:h-full lg:overflow-hidden">
      {/* Mobile Accordion Header */}
      <button
        type="button"
        onClick={() => setMobileOpen((v) => !v)}
        className="flex lg:hidden items-center justify-between px-3 py-2.5 text-xs font-semibold text-slate-200 border-b border-white/[0.08]"
      >
        <span>Panel de Opciones · GEX (modelo)</span>
        {mobileOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      <div className={`${mobileOpen ? 'flex' : 'hidden'} lg:flex flex-col flex-1 min-h-0`}>
        {/* Top Tabs: Levels | Live | GEX */}
        <div className="flex items-center justify-between px-3 pt-2 pb-2 border-b border-white/[0.08]">
          <div className="flex items-center gap-1 bg-[#0B0E11] p-0.5 rounded-md border border-white/[0.08]">
            {(['Levels', 'Live', 'GEX'] as RightPanelTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setRightTab(tab)}
                className={`px-3.5 py-1 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 ${
                  rightTab === tab
                    ? 'bg-slate-200 text-slate-950'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          <span className="text-[11px] font-medium text-slate-400 whitespace-nowrap">
            {providerName.toUpperCase()} (modelo)
          </span>
        </div>

        {/* Dealer Assumption Warning */}
        <div className="px-3 py-1.5 bg-[#0B0E11]/70 border-b border-white/[0.06] text-[10.5px] leading-snug text-slate-400">
          <span className="text-amber-400 font-medium">Modelo teórico:</span> asume dealers cortos
          de calls/puts (calls +, puts −). En cripto ese supuesto es más débil.
        </div>

        {/* Low liquidity warning proposing Deribit */}
        {providerName === 'okx' && !optionsLoading && options.length > 0 && activeStrikesCount < 12 && (
          <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 flex items-center justify-between gap-2 text-[11px] text-amber-300">
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>Pocos strikes con OI en OKX ({activeStrikesCount}).</span>
            </div>
            <button
              type="button"
              onClick={() => setProviderName('deribit')}
              className="px-2 py-0.5 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 font-medium whitespace-nowrap shrink-0"
            >
              Cambiar a Deribit
            </button>
          </div>
        )}

        {optionsError && (
          <div className="px-3 py-1.5 bg-rose-500/10 border-b border-rose-500/20 text-[11px] text-rose-300">
            {optionsError} (conservando última cadena)
          </div>
        )}

        {/* TAB: GEX LADDER */}
        {rightTab === 'GEX' && (
          <div className="flex flex-col flex-1 min-h-0">
            {/* Filter bar + Regime header (matching screenshot) */}
            <div className="px-3 py-2 border-b border-white/[0.08] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-0.5 bg-[#0B0E11] p-0.5 rounded border border-white/[0.08]">
                  {(['OI', 'GEX', 'DEX', 'MultiMap'] as GexLadderMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => {
                        setLadderMode(m);
                        if (m === 'MultiMap') setLadderFilterAll(true);
                      }}
                      className={`px-2 py-0.5 text-[11px] font-semibold rounded transition-colors whitespace-nowrap ${
                        ladderMode === m
                          ? 'bg-[#263144] text-white'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => setLadderFilterAll((v) => !v)}
                  disabled={ladderMode === 'MultiMap'}
                  className="text-[11px] text-slate-300 hover:text-white disabled:opacity-50 px-2 py-0.5 rounded bg-[#0B0E11] border border-white/[0.08] whitespace-nowrap"
                >
                  {ladderMode === 'MultiMap' || ladderFilterAll
                    ? 'All expiries'
                    : selectedExpiry || 'Venc. activo'}
                </button>
              </div>

              {ladderMode === 'MultiMap' && (
                <div className="flex items-center justify-between text-[10px] text-slate-400 font-mono-tabular">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-sm bg-[#38BDF8]" />
                    Corto ({nearExpiry ? nearExpiry.slice(5) : '—'})
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-sm bg-[#6366F1]" />
                    Resto de vencimientos
                  </span>
                </div>
              )}

              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 font-mono-tabular">
                  <span className="font-semibold text-white">{asset}</span>
                  <span className="text-rose-400 font-semibold">{formatPrice(spot, asset)}</span>
                </div>
                <span
                  className={`text-[11px] font-semibold ${
                    regimeAboveFlip ? 'text-[#00E676]' : 'text-rose-400'
                  }`}
                >
                  {regimeAboveFlip ? 'Dealers dampen moves' : 'Dealers chase'}
                </span>
              </div>
            </div>

            {/* Ladder rows (matching screenshot compact horizontal steel-blue bars) */}
            <div className="flex-1 overflow-y-auto divide-y divide-white/[0.03] bg-[#0E1218]">
              {optionsLoading && options.length === 0 ? (
                <div className="p-4 space-y-2">
                  {Array.from({ length: 12 }).map((_, idx) => (
                    <div key={idx} className="h-5 bg-white/[0.04] rounded animate-pulse" />
                  ))}
                </div>
              ) : visibleStrikesDesc.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  Sin datos de strikes disponibles.
                </div>
              ) : (
                visibleStrikesDesc.map((row, idx) => {
                  const nextRow = visibleStrikesDesc[idx + 1];
                  const showFlipLineAfter =
                    levels.flip !== null &&
                    nextRow !== undefined &&
                    row.strike >= levels.flip &&
                    nextRow.strike < levels.flip;

                  const val =
                    ladderMode === 'GEX' || ladderMode === 'MultiMap'
                      ? row.gex
                      : ladderMode === 'DEX'
                      ? row.dex
                      : row.oi;
                  const pctWidth = Math.min(100, (Math.abs(val) / maxAbsBar) * 100);
                  const sharePct = Math.round((Math.abs(val) / totalAbsExposure) * 100);
                  const isSpotRow = row.strike === closestSpotStrike;
                  const isMaxExp = row.strike === maxExposureStrike;
                  const isCallWall = row.strike === levels.callWall;
                  const isPutWall = row.strike === levels.putWall;
                  const isPositive = ladderMode === 'OI' ? row.callOi >= row.putOi : val >= 0;

                  const multi = multiMapByStrike.map.get(row.strike);
                  const nearWidthPct = multi
                    ? Math.min(100, (Math.abs(multi.nearGex) / multiMapByStrike.maxSegment) * 100)
                    : 0;
                  const farWidthPct = multi
                    ? Math.min(
                        100 - nearWidthPct,
                        (Math.abs(multi.farGex) / multiMapByStrike.maxSegment) * 100
                      )
                    : 0;

                  return (
                    <div key={row.strike}>
                      <div
                        className={`relative flex items-center h-7 px-2 text-[11px] font-mono-tabular ${
                          isSpotRow
                            ? 'bg-white/[0.08] text-white'
                            : 'hover:bg-white/[0.03] text-slate-200'
                        }`}
                      >
                        {/* Far-left vertical polarity strip */}
                        <span
                          className={`w-0.5 h-5 mr-1.5 rounded-full shrink-0 ${
                            isPositive ? 'bg-emerald-500' : 'bg-rose-500'
                          }`}
                        />

                        {/* Strike + Star + Wall tag */}
                        <div className="flex items-center gap-1 w-[84px] shrink-0">
                          {isMaxExp ? (
                            <Star
                              className="w-3 h-3 text-[#FACC15] fill-[#FACC15] shrink-0"
                              aria-label="Mayor exposición"
                            />
                          ) : (
                            <span className="w-3 shrink-0" />
                          )}
                          <span
                            className={`px-1 rounded ${
                              isSpotRow ? 'border border-white/80 font-bold text-white' : ''
                            }`}
                          >
                            {row.strike.toLocaleString('en-US')}
                          </span>
                        </div>

                        {/* Share % + CW / PW tag */}
                        <div className="flex items-center gap-1 w-14 shrink-0">
                          {isCallWall && (
                            <span className="px-1 py-0 text-[9px] font-bold bg-emerald-500/20 text-emerald-300 rounded">
                              CW
                            </span>
                          )}
                          {isPutWall && (
                            <span className="px-1 py-0 text-[9px] font-bold bg-blue-500/20 text-blue-300 rounded">
                              PW
                            </span>
                          )}
                          <span
                            className={`text-[10px] ${
                              isPositive ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {val < 0 ? '-' : '+'}
                            {sharePct}%
                          </span>
                        </div>

                        {/* Right-aligned exposure bar + overlaid USD figure */}
                        <div className="relative flex-1 h-5 flex items-center justify-end overflow-hidden rounded-sm bg-[#0B0E11]/60">
                          {ladderMode === 'MultiMap' ? (
                            <div className="flex h-full justify-end w-full">
                              <div
                                style={{ width: `${farWidthPct}%` }}
                                className="h-full bg-[#6366F1]/75 transition-all duration-150"
                                title={`Resto: ${formatCompactUsd(multi?.farGex ?? 0)}`}
                              />
                              <div
                                style={{ width: `${nearWidthPct}%` }}
                                className="h-full bg-[#38BDF8]/80 transition-all duration-150"
                                title={`Corto (${nearExpiry}): ${formatCompactUsd(multi?.nearGex ?? 0)}`}
                              />
                            </div>
                          ) : (
                            <div
                              style={{ width: `${pctWidth}%` }}
                              className={`h-full transition-all duration-150 ${
                                isPositive ? 'bg-[#2D5A4C]' : 'bg-[#3D5B82]'
                              }`}
                            />
                          )}
                          <span className="absolute right-1.5 text-[11px] font-semibold text-white drop-shadow">
                            {ladderMode === 'OI'
                              ? row.oi.toLocaleString('en-US', { maximumFractionDigits: 1 })
                              : formatCompactUsd(val)}
                          </span>
                        </div>
                      </div>

                      {showFlipLineAfter && (
                        <div className="flex items-center gap-1.5 px-2 py-0.5 bg-[#FACC15]/10 text-[10px] font-mono-tabular text-[#FACC15]">
                          <span className="font-bold">FLIP</span>
                          <span className="flex-1 border-b border-dashed border-[#FACC15]/70" />
                          <span>{formatPrice(levels.flip, asset)}</span>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* TAB: LEVELS */}
        {rightTab === 'Levels' && (
          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            <div>
              <h3 className="text-xs font-semibold text-slate-300 mb-2">
                Niveles de opciones (modelo)
              </h3>
              <div className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-md bg-[#0B0E11]/60">
                {[
                  {
                    label: 'GEX Flip (modelo)',
                    val: formatPrice(levels.flip, asset),
                    cls: 'text-[#FACC15]',
                  },
                  {
                    label: 'Max Pain (modelo)',
                    val: formatPrice(levels.maxPain, asset),
                    cls: 'text-white',
                  },
                  {
                    label: 'Call Wall (modelo)',
                    val: formatPrice(levels.callWall, asset),
                    cls: 'text-[#00E676]',
                  },
                  {
                    label: 'Put Wall (modelo)',
                    val: formatPrice(levels.putWall, asset),
                    cls: 'text-rose-400',
                  },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between px-3 py-2 text-xs">
                    <span className="text-slate-400">{item.label}</span>
                    <span className={`font-mono-tabular font-medium ${item.cls}`}>{item.val}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-300 mb-2">
                Liquidez del mercado (OKX / Pools)
              </h3>
              <div className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-md bg-[#0B0E11]/60">
                {[
                  {
                    label: 'Muro Ask más fuerte',
                    val: liquidityAnalysis.strongestAskWall
                      ? `${formatPrice(liquidityAnalysis.strongestAskWall.price, asset)} (${formatCompactUsd(
                          liquidityAnalysis.strongestAskWall.notionalUsd
                        )})`
                      : '—',
                    cls: 'text-rose-400',
                  },
                  {
                    label: 'Muro Bid más fuerte',
                    val: liquidityAnalysis.strongestBidWall
                      ? `${formatPrice(liquidityAnalysis.strongestBidWall.price, asset)} (${formatCompactUsd(
                          liquidityAnalysis.strongestBidWall.notionalUsd
                        )})`
                      : '—',
                    cls: 'text-emerald-400',
                  },
                  {
                    label: 'Pool BSL (Máximos)',
                    val: formatPrice(liquidityAnalysis.nearestBSL?.price ?? null, asset),
                    cls: 'text-amber-300',
                  },
                  {
                    label: 'Pool SSL (Mínimos)',
                    val: formatPrice(liquidityAnalysis.nearestSSL?.price ?? null, asset),
                    cls: 'text-teal-300',
                  },
                  {
                    label: 'POC Volumen',
                    val: formatPrice(liquidityAnalysis.pocPrice, asset),
                    cls: 'text-sky-300',
                  },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between px-3 py-2 text-xs">
                    <span className="text-slate-400">{item.label}</span>
                    <span className={`font-mono-tabular font-medium ${item.cls}`}>{item.val}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-300 mb-2">Niveles diarios (UTC)</h3>
              <div className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-md bg-[#0B0E11]/60">
                <div className="flex items-center justify-between px-3 py-2 text-xs">
                  <span className="text-slate-400">Máximo día anterior</span>
                  <span className="font-mono-tabular text-slate-200">
                    {formatPrice(prevDayHigh, asset)}
                  </span>
                </div>
                <div className="flex items-center justify-between px-3 py-2 text-xs">
                  <span className="text-slate-400">Mínimo día anterior</span>
                  <span className="font-mono-tabular text-slate-200">
                    {formatPrice(prevDayLow, asset)}
                  </span>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-300 mb-2">
                Niveles dibujados ({userLevels.length})
              </h3>
              {userLevels.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Usa el botón de línea horizontal a la izquierda y haz clic en el gráfico para marcar
                  un nivel.
                </p>
              ) : (
                <div className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-md bg-[#0B0E11]/60">
                  {userLevels.map((lvl) => (
                    <div
                      key={lvl.id}
                      onClick={() => setSelectedLevelId(lvl.id)}
                      className={`flex items-center justify-between px-3 py-2 text-xs cursor-pointer ${
                        selectedLevelId === lvl.id ? 'bg-amber-500/15' : 'hover:bg-white/[0.03]'
                      }`}
                    >
                      <span className="font-mono-tabular text-[#FACC15]">
                        {formatPrice(lvl.price, asset)}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeUserLevel(lvl.id);
                        }}
                        className="text-slate-400 hover:text-rose-400 p-1"
                        title="Eliminar nivel"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB: LIVE */}
        {rightTab === 'Live' && (
          <div className="flex-1 overflow-y-auto p-3 space-y-4">
            <div>
              <h3 className="text-xs font-semibold text-slate-300 mb-2">Índice {asset}-USD (OKX)</h3>
              <div className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-md bg-[#0B0E11]/60">
                {[
                  { label: 'Precio índice', val: formatPrice(spot, asset) },
                  { label: 'Máximo 24h', val: formatPrice(ticker?.high24h ?? null, asset) },
                  { label: 'Mínimo 24h', val: formatPrice(ticker?.low24h ?? null, asset) },
                  { label: 'Apertura 00:00 UTC', val: formatPrice(ticker?.sodUtc0 ?? null, asset) },
                ].map((r) => (
                  <div key={r.label} className="flex items-center justify-between px-3 py-2 text-xs">
                    <span className="text-slate-400">{r.label}</span>
                    <span className="font-mono-tabular text-slate-200">{r.val}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <h3 className="text-xs font-semibold text-slate-300 mb-2">
                Resumen opciones (modelo)
              </h3>
              <div className="divide-y divide-white/[0.06] border border-white/[0.08] rounded-md bg-[#0B0E11]/60">
                {[
                  {
                    label: 'GEX Neto (modelo)',
                    val: formatCompactUsd(levels.netGex),
                    cls: levels.netGex >= 0 ? 'text-[#00E676]' : 'text-rose-400',
                  },
                  {
                    label: `Gamma Neta (${asset}/$)`,
                    val: levels.netGamma.toFixed(4),
                    cls: 'text-slate-200',
                  },
                  {
                    label: `IV ATM (${selectedExpiry || '—'})`,
                    val: atmIv > 0 ? `${(atmIv * 100).toFixed(1)}%` : '—',
                    cls: 'text-sky-300',
                  },
                  {
                    label: `Call OI (${asset})`,
                    val: totals.callOi.toLocaleString('en-US', { maximumFractionDigits: 1 }),
                    cls: 'text-[#00E676]',
                  },
                  {
                    label: `Put OI (${asset})`,
                    val: totals.putOi.toLocaleString('en-US', { maximumFractionDigits: 1 }),
                    cls: 'text-rose-400',
                  },
                  {
                    label: 'Ratio Put/Call OI',
                    val: totals.pcRatio.toFixed(2),
                    cls: 'text-slate-200',
                  },
                ].map((r) => (
                  <div key={r.label} className="flex items-center justify-between px-3 py-2 text-xs">
                    <span className="text-slate-400">{r.label}</span>
                    <span className={`font-mono-tabular ${r.cls}`}>{r.val}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* IV Term Structure */}
            <div>
              <h3 className="text-xs font-semibold text-slate-300 mb-2">
                Estructura temporal IV ATM (%)
              </h3>
              <div className="border border-white/[0.08] rounded-md bg-[#0B0E11]/60 p-2.5">
                {termStructure.length < 2 ? (
                  <p className="text-[11px] text-slate-500 py-3 text-center">
                    Esperando múltiples vencimientos para trazar la curva IV.
                  </p>
                ) : (
                  <TermStructureChart points={termStructure} />
                )}
              </div>
            </div>

            {/* Recent Option Trades Flow */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-semibold text-slate-300">
                  Flujo reciente de opciones ({providerName.toUpperCase()})
                </h3>
                <span className="text-[10px] font-mono-tabular text-slate-500">
                  {optionTrades.length} ops
                </span>
              </div>
              <div className="border border-white/[0.08] rounded-md bg-[#0B0E11]/60 overflow-hidden">
                {optionTrades.length === 0 ? (
                  <p className="text-[11px] text-slate-500 p-3 text-center">
                    Sin operaciones recientes disponibles.
                  </p>
                ) : (
                  <div className="max-h-60 overflow-y-auto divide-y divide-white/[0.04]">
                    {optionTrades.slice(0, 18).map((tr) => (
                      <div
                        key={tr.id}
                        className="flex items-center justify-between px-2.5 py-1.5 text-[11px] font-mono-tabular hover:bg-white/[0.03]"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            className={`px-1 rounded text-[10px] font-bold ${
                              tr.type === 'C'
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : 'bg-rose-500/20 text-rose-300'
                            }`}
                          >
                            {tr.type}
                          </span>
                          <span className="text-slate-200 font-medium">
                            {tr.strike > 0 ? tr.strike.toLocaleString('en-US') : tr.instId}
                          </span>
                          <span className="text-slate-500 text-[10px]">{tr.expiry.slice(5)}</span>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <span
                            className={tr.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}
                          >
                            {tr.side === 'buy' ? 'B' : 'S'} {tr.sizeCoins.toFixed(2)}
                          </span>
                          <span className="text-sky-300 w-10 text-right">
                            {tr.iv > 0 ? `${(tr.iv * 100).toFixed(0)}%` : '—'}
                          </span>
                          <span className="text-slate-300 w-14 text-right">
                            {formatCompactUsd(tr.premiumUsd)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="text-[11px] text-slate-500">
              Última sincronización de opciones:{' '}
              <span className="font-mono-tabular text-slate-400">
                {optionsUpdatedAt
                  ? new Date(optionsUpdatedAt).toISOString().slice(11, 19) + ' UTC'
                  : 'Pendiente'}
              </span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function TermStructureChart({
  points,
}: {
  points: { expiry: string; daysToExpiry: number; atmIvPct: number }[];
}) {
  const w = 290;
  const h = 92;
  const padX = 16;
  const padTop = 14;
  const padBottom = 22;
  const minIv = Math.min(...points.map((p) => p.atmIvPct));
  const maxIv = Math.max(...points.map((p) => p.atmIvPct));
  const ivSpan = Math.max(1, maxIv - minIv);

  const coords = points.map((p, idx) => {
    const x =
      points.length === 1
        ? w / 2
        : padX + (idx / (points.length - 1)) * (w - padX * 2);
    const y =
      padTop + (1 - (p.atmIvPct - minIv) / ivSpan) * (h - padTop - padBottom);
    return { ...p, x, y };
  });

  const polyline = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-24 overflow-visible">
      <polyline
        fill="none"
        stroke="#38BDF8"
        strokeWidth="1.75"
        points={polyline}
      />
      {coords.map((c, idx) => {
        const showLabel = idx === 0 || idx === coords.length - 1 || idx % 2 === 0;
        return (
          <g key={c.expiry}>
            <circle cx={c.x} cy={c.y} r="3" fill="#0B0E11" stroke="#38BDF8" strokeWidth="1.5" />
            {showLabel && (
              <>
                <text
                  x={c.x}
                  y={c.y - 6}
                  textAnchor="middle"
                  fill="#E2E8F0"
                  fontSize="9"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {c.atmIvPct.toFixed(1)}%
                </text>
                <text
                  x={c.x}
                  y={h - 4}
                  textAnchor="middle"
                  fill="#64748B"
                  fontSize="8.5"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {c.expiry.slice(5)}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}
