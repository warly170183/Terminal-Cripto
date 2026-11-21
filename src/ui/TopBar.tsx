import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronDown, Layers, Newspaper, WifiOff } from 'lucide-react';
import { correlateNewsWithPriceAction } from '../calc/newsSentiment';
import { getAvailableExpiries } from '../calc/options';
import { useTerminalStore } from '../store/terminalStore';
import type { LayerVisibility, SymbolAsset, Timeframe } from '../types/market';

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '30m', '1H', '4H', 'D'];

const LAYER_LABELS: { key: keyof LayerVisibility; label: string }[] = [
  { key: 'emaClouds', label: 'Nubes EMA (9/21, 21/50)' },
  { key: 'ema9', label: 'EMA 9' },
  { key: 'ema21', label: 'EMA 21' },
  { key: 'vwap', label: 'VWAP (00:00 UTC)' },
  { key: 'volume', label: 'Volumen' },
  { key: 'levels', label: 'Niveles horizontales' },
  { key: 'optionLevels', label: 'Muros opciones (modelo)' },
  { key: 'liquidityLevels', label: 'Liquidez del mercado (OKX/BSL/SSL)' },
  { key: 'cone', label: 'Cono de rango (modelo)' },
  { key: 'events', label: 'Marcadores de evento' },
];

function formatCountdown(targetMs: number, nowMs: number): string {
  const diff = Math.max(0, targetMs - nowMs);
  const totalMinutes = Math.floor(diff / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function TopBar() {
  const {
    activeTab,
    setActiveTab,
    asset,
    setAsset,
    timeframe,
    setTimeframe,
    ticker,
    candles,
    streamStatus,
    layers,
    toggleLayer,
    candleTheme,
    setCandleTheme,
    options,
    selectedExpiry,
    setSelectedExpiry,
    providerName,
    setProviderName,
    events,
    setEventsModalOpen,
    newsItems,
    newsCandles1h,
  } = useTerminalStore();

  const [layersMenuOpen, setLayersMenuOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    function handleOutsideClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setLayersMenuOpen(false);
      }
    }
    if (layersMenuOpen) {
      document.addEventListener('mousedown', handleOutsideClick);
      return () => document.removeEventListener('mousedown', handleOutsideClick);
    }
  }, [layersMenuOpen]);

  const expiries = useMemo(() => getAvailableExpiries(options, nowMs), [options, nowMs]);

  useEffect(() => {
    if (expiries.length > 0 && (!selectedExpiry || !expiries.some((e) => e.expiry === selectedExpiry))) {
      // Default to ~14-30d expiry if available, else nearest valid expiry
      const preferred =
        expiries.find((e) => e.daysToExpiry >= 7 && e.daysToExpiry <= 35) ?? expiries[0];
      setSelectedExpiry(preferred.expiry);
    }
  }, [expiries, selectedExpiry, setSelectedExpiry]);

  const livePrice = ticker?.idxPx ?? candles[candles.length - 1]?.c ?? 0;
  const open24h = ticker?.open24h ?? 0;
  const pct24h = open24h > 0 && livePrice > 0 ? ((livePrice - open24h) / open24h) * 100 : null;

  const nextEvent = useMemo(() => {
    return events.find((e) => e.ts > nowMs) ?? null;
  }, [events, nowMs]);

  const newsBadgeSummary = useMemo(() => {
    if (newsItems.length === 0) return null;
    const c1h = newsCandles1h.length >= 24 ? newsCandles1h : candles;
    return correlateNewsWithPriceAction(newsItems.slice(0, 40), c1h, events, nowMs);
  }, [newsItems, newsCandles1h, candles, events, nowMs]);

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 px-3 sm:px-4 py-2 bg-[#111621] border-b border-white/[0.08] shrink-0">
      {/* Left Zone: Mode Switch + Symbol + Live Price + Timeframes */}
      <div className="flex items-center gap-3 sm:gap-4 flex-wrap">
        <div className="flex items-center bg-[#0B0E14] p-0.5 rounded-md border border-white/[0.08] overflow-x-auto max-w-full">
          <button
            type="button"
            onClick={() => setActiveTab('chart')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'chart'
                ? 'bg-[#1F2937] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Gráfico
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('main_chart')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'main_chart'
                ? 'bg-[#1F2937] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Gráfico Principal
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('technical')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'technical'
                ? 'bg-[#1F2937] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Análisis Técnico
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('trading_options')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'trading_options'
                ? 'bg-[#1F2937] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Opciones de Trading
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('effectiveness')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'effectiveness'
                ? 'bg-[#1F2937] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Evaluación de efectividad
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('scoring')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'scoring'
                ? 'bg-[#1F2937] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Sistema de Puntuación
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('backtest')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'backtest'
                ? 'bg-[#1F2937] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Backtest
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('architecture')}
            className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
              activeTab === 'architecture'
                ? 'bg-[#1F2937] text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Arquitectura
          </button>
        </div>

        {(activeTab === 'chart' || activeTab === 'main_chart') && (
          <>
            <div className="flex items-center bg-[#0B0E14] p-0.5 rounded-md border border-white/[0.08]">
              {(['BTC', 'ETH'] as SymbolAsset[]).map((sym) => (
                <button
                  key={sym}
                  type="button"
                  onClick={() => setAsset(sym)}
                  className={`px-2.5 py-1 text-xs font-semibold rounded transition-colors whitespace-nowrap shrink-0 ${
                    asset === sym
                      ? 'bg-[#3B82F6] text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {sym}
                </button>
              ))}
            </div>

            <div className="flex items-baseline gap-2">
              <span className="text-sm sm:text-base font-semibold font-mono-tabular text-white whitespace-nowrap">
                {livePrice > 0
                  ? `$${livePrice.toLocaleString('en-US', {
                      minimumFractionDigits: asset === 'BTC' ? 1 : 2,
                      maximumFractionDigits: asset === 'BTC' ? 1 : 2,
                    })}`
                  : '—'}
              </span>
              {pct24h !== null && (
                <span
                  className={`text-xs font-mono-tabular whitespace-nowrap ${
                    pct24h >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {pct24h >= 0 ? '+' : ''}
                  {pct24h.toFixed(2)}%
                </span>
              )}
            </div>

            <div className="h-4 w-px bg-white/[0.08] hidden sm:block" />

            <div className="flex items-center gap-0.5 overflow-x-auto">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => setTimeframe(tf)}
                  className={`px-2 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    timeframe === tf
                      ? 'bg-[#1F2937] text-white border border-white/[0.12]'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.04]'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Right Zone: Layers Menu + Expiry + Provider + Macro Countdown + Stream Status */}
      <div className="flex items-center gap-2.5 sm:gap-3 flex-wrap">
        {(activeTab === 'chart' || activeTab === 'main_chart') && (
          <>
            {/* Layers & indicators dropdown */}
            <div className="relative" ref={menuRef}>
              <button
                type="button"
                onClick={() => setLayersMenuOpen((v) => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-[#0B0E14] hover:bg-[#161D2B] border border-white/[0.08] rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <Layers className="w-3.5 h-3.5 text-slate-400" />
                <span>Layers &amp; indicators</span>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              </button>

              {layersMenuOpen && (
                <div className="absolute right-0 mt-1.5 w-60 bg-[#111621] border border-white/[0.12] rounded-lg shadow-xl z-50 py-1.5">
                  <div className="px-3 py-1.5 text-[11px] font-medium text-slate-400 border-b border-white/[0.06]">
                    Capas del gráfico
                  </div>
                  {LAYER_LABELS.map((item) => (
                    <label
                      key={item.key}
                      className="flex items-center justify-between px-3 py-1.5 text-xs text-slate-200 hover:bg-white/[0.04] cursor-pointer"
                    >
                      <span>{item.label}</span>
                      <input
                        type="checkbox"
                        checked={layers[item.key]}
                        onChange={() => toggleLayer(item.key)}
                        className="accent-[#3B82F6] w-3.5 h-3.5 rounded"
                      />
                    </label>
                  ))}
                  <div className="mt-1 pt-1.5 px-3 border-t border-white/[0.06] flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-400">Velas</span>
                    <div className="flex items-center gap-1 bg-[#0B0E11] p-0.5 rounded border border-white/[0.08]">
                      <button
                        type="button"
                        onClick={() => setCandleTheme('photo')}
                        className={`px-2 py-0.5 text-[11px] rounded ${
                          candleTheme === 'photo'
                            ? 'bg-[#1F2937] text-white'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Verde/Azul
                      </button>
                      <button
                        type="button"
                        onClick={() => setCandleTheme('classic')}
                        className={`px-2 py-0.5 text-[11px] rounded ${
                          candleTheme === 'classic'
                            ? 'bg-[#1F2937] text-white'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        Verde/Rojo
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Cone expiry selector */}
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="expiry-select"
                className="text-[11px] text-slate-400 hidden xl:inline whitespace-nowrap"
              >
                Vencimiento (cono)
              </label>
              <select
                id="expiry-select"
                value={selectedExpiry}
                onChange={(e) => setSelectedExpiry(e.target.value)}
                disabled={expiries.length === 0}
                className="bg-[#0B0E14] border border-white/[0.08] text-xs font-mono-tabular text-slate-200 rounded-md px-2 py-1.5 focus:outline-none focus:border-[#3B82F6]"
              >
                {expiries.length === 0 ? (
                  <option value="">Cargando venc...</option>
                ) : (
                  expiries.map((exp) => (
                    <option key={exp.expiry} value={exp.expiry}>
                      {exp.expiry} ({Math.round(exp.daysToExpiry)}d)
                    </option>
                  ))
                )}
              </select>
            </div>

            {/* OptionsProvider switcher */}
            <div className="flex items-center bg-[#0B0E14] p-0.5 rounded-md border border-white/[0.08]">
              <button
                type="button"
                onClick={() => setProviderName('okx')}
                title="Opciones desde OKX"
                className={`px-2 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  providerName === 'okx'
                    ? 'bg-[#1F2937] text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                OKX Opt
              </button>
              <button
                type="button"
                onClick={() => setProviderName('deribit')}
                title="Opciones desde Deribit"
                className={`px-2 py-1 text-[11px] font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  providerName === 'deribit'
                    ? 'bg-[#1F2937] text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Deribit Opt
              </button>
            </div>
          </>
        )}

        {/* News Sentiment quick pill alongside macro events */}
        {newsBadgeSummary && (
          <button
            type="button"
            onClick={() => setEventsModalOpen(true)}
            className="flex items-center gap-1.5 text-xs text-slate-300 hover:text-white border-l border-white/[0.08] pl-3 whitespace-nowrap"
            title={`Sentimiento noticias (${newsBadgeSummary.aggregateLabel} ${newsBadgeSummary.aggregateScore >= 0 ? '+' : ''}${newsBadgeSummary.aggregateScore}) · Abrir Centro Macro y Noticias`}
          >
            <Newspaper className="w-3.5 h-3.5 text-sky-400 shrink-0" />
            <span className="text-slate-400 hidden xl:inline">Noticias:</span>
            <span
              className={`font-mono-tabular font-semibold ${
                newsBadgeSummary.aggregateLabel === 'Alcista'
                  ? 'text-emerald-300'
                  : newsBadgeSummary.aggregateLabel === 'Bajista'
                  ? 'text-rose-300'
                  : 'text-amber-300'
              }`}
            >
              {newsBadgeSummary.aggregateLabel} ({newsBadgeSummary.aggregateScore >= 0 ? '+' : ''}
              {newsBadgeSummary.aggregateScore})
            </span>
            {newsBadgeSummary.pearson4h !== null && (
              <span className="text-[11px] font-mono-tabular text-slate-400 hidden 2xl:inline">
                r={newsBadgeSummary.pearson4h.toFixed(2)}
              </span>
            )}
          </button>
        )}

        {/* Macro events countdown (clickable to edit events; hidden text if no upcoming events) */}
        {nextEvent ? (
          <button
            type="button"
            onClick={() => setEventsModalOpen(true)}
            className="flex items-center gap-1.5 text-xs text-slate-300 hover:text-white border-l border-white/[0.08] pl-3 whitespace-nowrap"
            title={`${nextEvent.name} · ${nextEvent.date} ${nextEvent.timeUtc} UTC (clic para editar)`}
          >
            <Calendar className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            <span className="text-amber-400 font-medium">Next event</span>
            <span aria-hidden="true" className="text-slate-500">
              ·
            </span>
            <span className="text-slate-200">{nextEvent.name}</span>
            <span aria-hidden="true" className="text-slate-500">
              ·
            </span>
            <span className="font-mono-tabular text-slate-400">
              {formatCountdown(nextEvent.ts, nowMs)}
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setEventsModalOpen(true)}
            className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 border-l border-white/[0.08] pl-3 whitespace-nowrap"
            title="Configurar calendario de eventos macro"
          >
            <Calendar className="w-3.5 h-3.5" />
            <span>Eventos</span>
          </button>
        )}

        {/* Real WebSocket connection state */}
        {(activeTab === 'chart' || activeTab === 'main_chart') && streamStatus === 'disconnected' && (
          <div className="flex items-center gap-1.5 text-xs text-rose-400 font-medium whitespace-nowrap">
            <WifiOff className="w-3.5 h-3.5" />
            <span>Sin datos en vivo</span>
          </div>
        )}
      </div>
    </header>
  );
}
