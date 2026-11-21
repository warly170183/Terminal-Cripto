import { useMemo, useState } from 'react';
import { ExternalLink, Newspaper, RefreshCw, TrendingDown, TrendingUp } from 'lucide-react';
import {
  correlateNewsWithPriceAction,
  type EnrichedNewsHeadline,
  type NewsTopic,
  type SentimentLabel,
} from '../../calc/newsSentiment';
import { fetchNewsFeed } from '../../data/newsClient';
import { useTerminalStore } from '../../store/terminalStore';
import type { MacroEvent } from '../../types/market';

function formatRelativeAge(ts: number, nowMs: number): string {
  const diffMin = Math.max(0, Math.round((nowMs - ts) / 60_000));
  if (diffMin < 60) return `hace ${diffMin}m`;
  const hrs = Math.floor(diffMin / 60);
  if (hrs < 24) return `hace ${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `hace ${days}d`;
}

function formatPct(val: number | null): string {
  if (val === null || !Number.isFinite(val)) return '—';
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`;
}

function SentimentPriceCorrelationChart({
  timeline,
  macroEvents,
  asset,
  compact = false,
}: {
  timeline: ReturnType<typeof correlateNewsWithPriceAction>['timeline'];
  macroEvents: MacroEvent[];
  asset: string;
  compact?: boolean;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (timeline.length < 4) {
    return (
      <div className="h-28 flex items-center justify-center text-[11px] text-slate-500 bg-[#0B0E14] rounded border border-white/[0.06]">
        Esperando velas 1H y titulares para trazar correlación...
      </div>
    );
  }

  const W = compact ? 330 : 620;
  const H = compact ? 118 : 156;
  const padX = 10;
  const padTop = 16;
  const padBot = 20;
  const innerW = W - padX * 2;
  const innerH = H - padTop - padBot;

  const minPrice = Math.min(...timeline.map((p) => p.close));
  const maxPrice = Math.max(...timeline.map((p) => p.close));
  const pSpan = Math.max(1e-6, maxPrice - minPrice);

  const toX = (idx: number) =>
    timeline.length === 1 ? W / 2 : padX + (idx / (timeline.length - 1)) * innerW;
  const toPriceY = (p: number) =>
    padTop + (1 - (p - minPrice) / pSpan) * (innerH * 0.72);

  const pricePath = timeline
    .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${toX(i).toFixed(1)} ${toPriceY(pt.close).toFixed(1)}`)
    .join(' ');

  const sentBaseY = padTop + innerH * 0.86;
  const maxBarH = innerH * 0.24;

  const tStart = timeline[0].t;
  const tEnd = timeline[timeline.length - 1].t;
  const tSpan = Math.max(1, tEnd - tStart);
  const macroInWindow = macroEvents.filter((e) => e.ts >= tStart && e.ts <= tEnd);

  const hovered = hoverIdx !== null ? timeline[hoverIdx] : null;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] font-mono-tabular text-slate-400">
        <span>
          Precio {asset} (1H) vs Sentimiento horario
        </span>
        {hovered ? (
          <span className="text-slate-200 truncate max-w-[68%]">
            ${hovered.close.toLocaleString('en-US', { maximumFractionDigits: 1 })} (
            {formatPct(hovered.hourlyRetPct)})
            {hovered.sentimentAvg !== null
              ? ` · Sent: ${hovered.sentimentAvg >= 0 ? '+' : ''}${hovered.sentimentAvg.toFixed(0)} (${hovered.headlineCount})`
              : ''}
          </span>
        ) : (
          <span>Barras: tono titulares · Línea: {asset}</span>
        )}
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        onMouseLeave={() => setHoverIdx(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const relX = ((e.clientX - rect.left) / rect.width) * W;
          const frac = Math.min(1, Math.max(0, (relX - padX) / innerW));
          const idx = Math.round(frac * (timeline.length - 1));
          setHoverIdx(idx);
        }}
        className={`w-full ${compact ? 'h-28' : 'h-36'} bg-[#0B0E14] rounded border border-white/[0.06] cursor-crosshair select-none`}
      >
        {/* Sentiment zero baseline */}
        <line
          x1={padX}
          y1={sentBaseY}
          x2={W - padX}
          y2={sentBaseY}
          stroke="rgba(255,255,255,0.12)"
          strokeDasharray="2 3"
        />

        {/* Macro events vertical markers inside 72h window */}
        {macroInWindow.map((ev) => {
          const x = padX + ((ev.ts - tStart) / tSpan) * innerW;
          return (
            <g key={ev.id}>
              <line
                x1={x}
                y1={padTop - 4}
                x2={x}
                y2={H - padBot}
                stroke="rgba(250, 204, 21, 0.5)"
                strokeDasharray="3 2"
              />
              <text
                x={Math.min(W - 36, Math.max(12, x))}
                y={10}
                textAnchor="middle"
                fill="#FACC15"
                fontSize="8.5"
                fontFamily="JetBrains Mono, monospace"
              >
                {ev.name}
              </text>
            </g>
          );
        })}

        {/* Hourly headline sentiment bars */}
        {timeline.map((pt, i) => {
          if (pt.sentimentAvg === null) return null;
          const x = toX(i);
          const norm = Math.min(1, Math.abs(pt.sentimentAvg) / 65);
          const barH = Math.max(3, norm * maxBarH);
          const isPos = pt.sentimentAvg >= 0;
          return (
            <rect
              key={pt.t}
              x={x - 2}
              y={isPos ? sentBaseY - barH : sentBaseY}
              width={4}
              height={barH}
              rx={1}
              fill={isPos ? 'rgba(16, 185, 129, 0.78)' : 'rgba(244, 63, 94, 0.78)'}
            />
          );
        })}

        {/* Price curve */}
        <path d={pricePath} fill="none" stroke="#38BDF8" strokeWidth="1.6" />

        {hoverIdx !== null && (
          <line
            x1={toX(hoverIdx)}
            y1={padTop}
            x2={toX(hoverIdx)}
            y2={H - padBot}
            stroke="rgba(226, 232, 240, 0.4)"
            strokeDasharray="2 2"
          />
        )}

        <text
          x={padX}
          y={H - 5}
          fill="#64748B"
          fontSize="8.5"
          fontFamily="JetBrains Mono, monospace"
        >
          -72h
        </text>
        <text
          x={W - padX}
          y={H - 5}
          textAnchor="end"
          fill="#64748B"
          fontSize="8.5"
          fontFamily="JetBrains Mono, monospace"
        >
          Ahora
        </text>
      </svg>
    </div>
  );
}

export function NewsSentimentPanel({
  compact = false,
  onOpenFullCenter,
}: {
  compact?: boolean;
  onOpenFullCenter?: () => void;
}) {
  const {
    asset,
    candles,
    newsItems,
    newsSources,
    newsCandles1h,
    newsUpdatedAt,
    newsLoading,
    newsError,
    events,
    setNewsFeed,
    setNewsLoading,
    setNewsError,
  } = useTerminalStore();

  const [topicFilter, setTopicFilter] = useState<'ALL' | NewsTopic>('ALL');
  const [sentimentFilter, setSentimentFilter] = useState<'ALL' | SentimentLabel>('ALL');

  const baseCandles = newsCandles1h.length >= 24 ? newsCandles1h : candles;

  const analysis = useMemo(
    () => correlateNewsWithPriceAction(newsItems, baseCandles, events),
    [newsItems, baseCandles, events]
  );

  const filteredHeadlines = useMemo(() => {
    return analysis.headlines.filter((h) => {
      if (topicFilter !== 'ALL' && !h.topics.includes(topicFilter)) return false;
      if (sentimentFilter !== 'ALL' && h.sentimentLabel !== sentimentFilter) return false;
      return true;
    });
  }, [analysis.headlines, topicFilter, sentimentFilter]);

  const handleManualRefresh = async () => {
    if (newsLoading) return;
    setNewsLoading(true);
    try {
      const data = await fetchNewsFeed(true);
      setNewsFeed(data.items, data.sources, data.updatedAt);
    } catch (err) {
      setNewsError(err instanceof Error ? err.message : 'Error actualizando noticias');
    } finally {
      setNewsLoading(false);
    }
  };

  const nowMs = Date.now();
  const displayList = compact ? filteredHeadlines.slice(0, 8) : filteredHeadlines.slice(0, 40);

  return (
    <div className="flex flex-col min-h-0 space-y-3">
      {/* Header & Refresh */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Newspaper className="w-4 h-4 text-sky-400 shrink-0" />
          <div>
            <h3 className="text-xs font-semibold text-white">
              Sentimiento de Noticias &amp; Correlación ({asset})
            </h3>
            {!compact && (
              <p className="text-[11px] text-slate-400">
                Fuentes en vivo:{' '}
                {newsSources.length > 0 ? newsSources.join(', ') : 'Conectando RSS...'}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {newsUpdatedAt && (
            <span className="text-[10px] font-mono-tabular text-slate-500">
              {new Date(newsUpdatedAt).toISOString().slice(11, 16)} UTC
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleManualRefresh()}
            disabled={newsLoading}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#0B0E14] border border-white/[0.1] hover:bg-white/[0.05] text-[11px] text-slate-300 disabled:opacity-50"
            title="Actualizar noticias ahora"
          >
            <RefreshCw className={`w-3 h-3 ${newsLoading ? 'animate-spin text-sky-400' : ''}`} />
            {!compact && <span>Actualizar</span>}
          </button>
        </div>
      </div>

      {newsError && (
        <div className="px-2.5 py-1.5 rounded bg-rose-500/10 border border-rose-500/25 text-[11px] text-rose-300">
          {newsError}
        </div>
      )}

      {/* Quantitative Sentiment + Price Correlation KPIs */}
      <div className={`grid ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-4'} gap-2`}>
        <div className="bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-2">
          <div className="text-[10px] text-slate-400">Sentimiento Neto (72h)</div>
          <div className="flex items-baseline justify-between mt-0.5 font-mono-tabular">
            <span
              className={`text-sm font-bold ${
                analysis.aggregateLabel === 'Alcista'
                  ? 'text-emerald-300'
                  : analysis.aggregateLabel === 'Bajista'
                  ? 'text-rose-300'
                  : 'text-amber-300'
              }`}
            >
              {analysis.aggregateScore >= 0 ? '+' : ''}
              {analysis.aggregateScore}
            </span>
            <span className="text-[10px] text-slate-400">
              {analysis.bullishCount}↑ · {analysis.bearishCount}↓
            </span>
          </div>
        </div>

        <div className="bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-2">
          <div className="text-[10px] text-slate-400">Correlación Pearson (4h)</div>
          <div className="flex items-baseline justify-between mt-0.5 font-mono-tabular">
            <span
              className={`text-sm font-bold ${
                analysis.pearson4h === null
                  ? 'text-slate-400'
                  : analysis.pearson4h >= 0.25
                  ? 'text-emerald-300'
                  : analysis.pearson4h <= -0.25
                  ? 'text-rose-300'
                  : 'text-slate-200'
              }`}
            >
              {analysis.pearson4h !== null ? analysis.pearson4h.toFixed(2) : '—'}
            </span>
            <span className="text-[10px] text-slate-400">
              1h: {analysis.pearson1h !== null ? analysis.pearson1h.toFixed(2) : '—'}
            </span>
          </div>
        </div>

        <div className="bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-2">
          <div className="text-[10px] text-slate-400">Alineación con Precio</div>
          <div className="flex items-baseline justify-between mt-0.5 font-mono-tabular">
            <span className="text-sm font-bold text-sky-300">
              {analysis.directionalHitRatePct !== null
                ? `${analysis.directionalHitRatePct.toFixed(0)}%`
                : '—'}
            </span>
            <span className="text-[10px] text-slate-400">n={analysis.evaluatedCount}</span>
          </div>
        </div>

        <div className="bg-[#0B0E14] border border-white/[0.08] rounded px-2.5 py-2">
          <div className="text-[10px] text-slate-400">Reacción Media (4h)</div>
          <div className="flex items-center justify-between mt-0.5 text-[11px] font-mono-tabular">
            <span className="text-emerald-300">{formatPct(analysis.avgBullishMovePct)}</span>
            <span className="text-rose-300">{formatPct(analysis.avgBearishMovePct)}</span>
          </div>
        </div>
      </div>

      {/* Regime interpretation */}
      <div className="px-2.5 py-1.5 rounded bg-[#0B0E14]/80 border border-white/[0.06] text-[11px] text-slate-300">
        {analysis.regimeSummary}
      </div>

      {/* Price Action vs Sentiment & Macro Events Chart */}
      <SentimentPriceCorrelationChart
        timeline={analysis.timeline}
        macroEvents={events}
        asset={asset}
        compact={compact}
      />

      {/* Topic & Sentiment Filters */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div className="flex flex-wrap items-center gap-1 bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]">
          {(['ALL', 'BTC', 'ETH', 'MACRO', 'ETF', 'REG'] as const).map((tp) => (
            <button
              key={tp}
              type="button"
              onClick={() => setTopicFilter(tp)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                topicFilter === tp
                  ? 'bg-[#1F2937] text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {tp === 'ALL' ? 'Todos' : tp}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1 bg-[#0B0E14] p-0.5 rounded border border-white/[0.08]">
          {(['ALL', 'Alcista', 'Bajista', 'Neutral'] as const).map((sf) => (
            <button
              key={sf}
              type="button"
              onClick={() => setSentimentFilter(sf)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                sentimentFilter === sf
                  ? 'bg-[#1F2937] text-white'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {sf === 'ALL' ? 'Todo tono' : sf}
            </button>
          ))}
        </div>
      </div>

      {/* Headline Cards with Post-News Price Action */}
      <div className={`${compact ? 'space-y-2' : 'flex-1 overflow-y-auto pr-1 space-y-2 max-h-[380px]'}`}>
        {displayList.length === 0 ? (
          <div className="p-4 text-center text-xs text-slate-500 bg-[#0B0E14] rounded border border-white/[0.06]">
            {newsLoading ? 'Descargando titulares en vivo...' : 'Sin titulares que coincidan con el filtro.'}
          </div>
        ) : (
          displayList.map((item: EnrichedNewsHeadline) => (
            <div
              key={item.id}
              className="bg-[#0B0E14] border border-white/[0.07] hover:border-white/[0.14] rounded p-2.5 space-y-1.5 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <a
                  href={item.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-medium text-slate-100 hover:text-sky-300 leading-snug inline-flex items-start gap-1"
                >
                  <span>{item.title}</span>
                  <ExternalLink className="w-3 h-3 shrink-0 mt-0.5 text-slate-500" />
                </a>
                <span
                  className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-mono-tabular font-semibold ${
                    item.sentimentLabel === 'Alcista'
                      ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                      : item.sentimentLabel === 'Bajista'
                      ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                      : 'bg-slate-700/30 text-slate-300 border border-white/[0.08]'
                  }`}
                >
                  {item.sentimentLabel} ({item.sentimentScore >= 0 ? '+' : ''}
                  {item.sentimentScore})
                </span>
              </div>

              {!compact && item.summary && (
                <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                  {item.summary}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 text-[10.5px] font-mono-tabular text-slate-400 pt-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-sans font-medium text-slate-300">{item.source}</span>
                  <span>·</span>
                  <span>{formatRelativeAge(item.pubTs, nowMs)}</span>
                  {item.topics.slice(0, 2).map((tp) => (
                    <span
                      key={tp}
                      className="px-1 py-0 rounded bg-white/[0.05] text-slate-300 text-[9.5px]"
                    >
                      {tp}
                    </span>
                  ))}
                  {item.nearMacroEvent && (
                    <span className="px-1.5 py-0 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 text-[9.5px]">
                      Cerca: {item.nearMacroEvent}
                    </span>
                  )}
                </div>

                {/* Price Reaction Metrics */}
                <div className="flex items-center gap-2">
                  <span>
                    1h:{' '}
                    <strong
                      className={
                        item.ret1hPct === null
                          ? 'text-slate-500'
                          : item.ret1hPct >= 0
                          ? 'text-emerald-300'
                          : 'text-rose-300'
                      }
                    >
                      {formatPct(item.ret1hPct)}
                    </strong>
                  </span>
                  <span>
                    4h:{' '}
                    <strong
                      className={
                        item.ret4hPct === null
                          ? 'text-slate-500'
                          : item.ret4hPct >= 0
                          ? 'text-emerald-300'
                          : 'text-rose-300'
                      }
                    >
                      {formatPct(item.ret4hPct)}
                    </strong>
                  </span>
                  <span
                    className={`inline-flex items-center gap-0.5 font-sans font-semibold ${
                      item.alignment === 'Confirmado'
                        ? 'text-emerald-300'
                        : item.alignment === 'Divergente'
                        ? 'text-amber-300'
                        : 'text-slate-500'
                    }`}
                  >
                    {item.alignment === 'Confirmado' && <TrendingUp className="w-3 h-3" />}
                    {item.alignment === 'Divergente' && <TrendingDown className="w-3 h-3" />}
                    {item.alignment}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {compact && onOpenFullCenter && (
        <button
          type="button"
          onClick={onOpenFullCenter}
          className="w-full py-1.5 rounded bg-[#0B0E14] border border-sky-500/35 text-xs font-medium text-sky-300 hover:bg-sky-500/10 transition-colors"
        >
          Abrir Centro Macro &amp; Correlación Completo
        </button>
      )}
    </div>
  );
}
