import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { calculateEMA } from '../../calc/indicators';
import { calculateAnchoredVWAP, findConfirmedTwoBarPivots } from '../../calc/scoringEngine';
import type { MultiTfScoringDataset, ScoringResult } from '../../types/scoring';

type AuditTf = '15m' | '1h' | '4h';

export function ScoringAuditChart({
  dataset,
  result,
  avwapAnchorLockTs,
}: {
  dataset: MultiTfScoringDataset;
  result: ScoringResult;
  avwapAnchorLockTs: number | null;
}) {
  const [tf, setTf] = useState<AuditTf>('15m');
  const [planDir, setPlanDir] = useState<'LONG' | 'SHORT'>(() =>
    result.shortEval.score > result.longEval.score ? 'SHORT' : 'LONG'
  );

  // Keep planDir aligned when dominant shifts noticeably on asset switch
  useEffect(() => {
    setPlanDir(result.shortEval.score > result.longEval.score ? 'SHORT' : 'LONG');
  }, [result.asset, result.shortEval.score, result.longEval.score]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const ema20Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema200Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const avwapRef = useRef<ISeriesApi<'Line'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const activeCandles = useMemo(() => {
    if (tf === '4h') return dataset.candles4h.slice(-140);
    if (tf === '1h') return dataset.candles1h.slice(-220);
    return dataset.candles15m.slice(-140);
  }, [dataset.candles4h, dataset.candles1h, dataset.candles15m, tf]);

  // Mount chart once
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 310,
      layout: {
        background: { type: ColorType.Solid, color: '#0B0E14' },
        textColor: '#94A3B8',
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.08)',
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10B981',
      downColor: '#EF4444',
      borderUpColor: '#10B981',
      borderDownColor: '#EF4444',
      wickUpColor: '#10B981',
      wickDownColor: '#EF4444',
    });

    const markersPlugin = createSeriesMarkers(candleSeries, []);

    const ema20 = chart.addSeries(LineSeries, {
      color: '#38BDF8',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const ema50 = chart.addSeries(LineSeries, {
      color: '#F59E0B',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const ema200 = chart.addSeries(LineSeries, {
      color: '#EC4899',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const avwap = chart.addSeries(LineSeries, {
      color: '#A78BFA',
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    markersRef.current = markersPlugin;
    ema20Ref.current = ema20;
    ema50Ref.current = ema50;
    ema200Ref.current = ema200;
    avwapRef.current = avwap;

    const ro = new ResizeObserver(() => {
      if (!el) return;
      chart.applyOptions({ width: el.clientWidth, height: 310 });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      priceLinesRef.current = [];
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      markersRef.current = null;
    };
  }, []);

  // Push series data, pivot markers, and structural/execution price lines
  useEffect(() => {
    const cs = candleSeriesRef.current;
    const mk = markersRef.current;
    const e20s = ema20Ref.current;
    const e50s = ema50Ref.current;
    const e200s = ema200Ref.current;
    const avs = avwapRef.current;
    const chart = chartRef.current;
    if (!cs || !mk || !e20s || !e50s || !e200s || !avs || !chart) return;

    // Clear previous price lines
    for (const pl of priceLinesRef.current) {
      try {
        cs.removePriceLine(pl);
      } catch {
        // ignore removed lines
      }
    }
    priceLinesRef.current = [];

    if (activeCandles.length === 0) {
      cs.setData([]);
      mk.setMarkers([]);
      e20s.setData([]);
      e50s.setData([]);
      e200s.setData([]);
      avs.setData([]);
      return;
    }

    cs.setData(
      activeCandles.map((c) => ({
        time: Math.floor(c.t / 1000) as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      }))
    );

    // 2-bar confirmed pivots used by A1/A2/D1
    const pivots = findConfirmedTwoBarPivots(activeCandles);
    const pivotMarkers: SeriesMarker<Time>[] = pivots.slice(-14).map((p) => ({
      time: Math.floor(p.ts / 1000) as UTCTimestamp,
      position: p.type === 'H' ? 'aboveBar' : 'belowBar',
      color: p.type === 'H' ? '#F87171' : '#34D399',
      shape: p.type === 'H' ? 'arrowDown' : 'arrowUp',
      text: p.type,
    }));
    mk.setMarkers(pivotMarkers);

    // 1H Indicators & Anchored VWAP (computed over full 1H history for accurate EMA200)
    if (tf === '1h') {
      const full1h = dataset.candles1h;
      const minTs = activeCandles[0].t;
      const closes = full1h.map((c) => c.c);
      const ema20Vals = calculateEMA(closes, 20);
      const ema50Vals = calculateEMA(closes, 50);
      const ema200Vals = calculateEMA(closes, 200);

      e20s.setData(
        full1h
          .map((c, idx) =>
            c.t >= minTs && ema20Vals[idx] !== null
              ? { time: Math.floor(c.t / 1000) as UTCTimestamp, value: ema20Vals[idx]! }
              : null
          )
          .filter((d): d is { time: UTCTimestamp; value: number } => d !== null)
      );
      e50s.setData(
        full1h
          .map((c, idx) =>
            c.t >= minTs && ema50Vals[idx] !== null
              ? { time: Math.floor(c.t / 1000) as UTCTimestamp, value: ema50Vals[idx]! }
              : null
          )
          .filter((d): d is { time: UTCTimestamp; value: number } => d !== null)
      );
      e200s.setData(
        full1h
          .map((c, idx) =>
            c.t >= minTs && ema200Vals[idx] !== null
              ? { time: Math.floor(c.t / 1000) as UTCTimestamp, value: ema200Vals[idx]! }
              : null
          )
          .filter((d): d is { time: UTCTimestamp; value: number } => d !== null)
      );

      const fullPivots1h = findConfirmedTwoBarPivots(full1h);
      const locked =
        avwapAnchorLockTs != null
          ? fullPivots1h.find((p) => p.ts === avwapAnchorLockTs) ?? null
          : null;
      const anchor = locked ?? fullPivots1h[fullPivots1h.length - 1] ?? null;
      if (anchor) {
        const avSeries = calculateAnchoredVWAP(full1h, anchor.index);
        avs.setData(
          full1h
            .map((c, idx) =>
              idx >= anchor.index && c.t >= minTs && avSeries[idx] > 0
                ? { time: Math.floor(c.t / 1000) as UTCTimestamp, value: avSeries[idx] }
                : null
            )
            .filter((d): d is { time: UTCTimestamp; value: number } => d !== null)
        );
      } else {
        avs.setData([]);
      }
    } else {
      e20s.setData([]);
      e50s.setData([]);
      e200s.setData([]);
      avs.setData([]);
    }

    // Price lines: Volume Profile 7D on 1h/4h, and D1 + Execution Plan on 15m
    const added: IPriceLine[] = [];
    if (result.volumeProfile7d && (tf === '1h' || tf === '4h')) {
      added.push(
        cs.createPriceLine({
          price: result.volumeProfile7d.poc,
          color: '#A78BFA',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: 'POC 7d',
        }),
        cs.createPriceLine({
          price: result.volumeProfile7d.vah,
          color: '#64748B',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'VAH 7d',
        }),
        cs.createPriceLine({
          price: result.volumeProfile7d.val,
          color: '#64748B',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: 'VAL 7d',
        })
      );
    }

    const activePlan = planDir === 'LONG' ? result.longEval.plan : result.shortEval.plan;
    if (activePlan && tf === '15m') {
      added.push(
        cs.createPriceLine({
          price: activePlan.validationLevel,
          color: '#38BDF8',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `D1 Val (${planDir})`,
        }),
        cs.createPriceLine({
          price: activePlan.entry,
          color: '#E2E8F0',
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'Entrada',
        }),
        cs.createPriceLine({
          price: activePlan.stopLoss,
          color: '#F43F5E',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'Stop estructural',
        }),
        cs.createPriceLine({
          price: activePlan.takeProfit,
          color: '#10B981',
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: 'TP1',
        })
      );
    }

    priceLinesRef.current = added;
    chart.timeScale().fitContent();
  }, [activeCandles, avwapAnchorLockTs, dataset.candles1h, planDir, result.longEval.plan, result.shortEval.plan, result.volumeProfile7d, tf]);

  return (
    <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-white">
            Auditoría visual multi-timeframe ({result.instId})
          </h2>
          <p className="text-xs text-slate-400">
            Pivotes confirmados de 2 velas (A1/A2), medias 1h, VWAP anclado (C2), perfil 7d (C3) y
            plan D1 en 15m.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Timeframe switcher */}
          <div className="flex items-center gap-1 bg-[#0B0E14] p-0.5 rounded border border-white/[0.08] text-xs">
            {(
              [
                { id: '15m', label: '15m · D1 y Plan' },
                { id: '1h', label: '1h · EMAs, VWAP y VP7d' },
                { id: '4h', label: '4h · Estructura A1' },
              ] as { id: AuditTf; label: string }[]
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setTf(opt.id)}
                className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors whitespace-nowrap ${
                  tf === opt.id ? 'bg-[#1F2937] text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Direction overlay toggle for 15m */}
          {tf === '15m' && (
            <div className="flex items-center gap-1 bg-[#0B0E14] p-0.5 rounded border border-white/[0.08] text-xs">
              {(['LONG', 'SHORT'] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setPlanDir(d)}
                  className={`px-2.5 py-1 rounded text-[11px] font-semibold transition-colors whitespace-nowrap ${
                    planDir === d
                      ? d === 'LONG'
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'bg-rose-500/20 text-rose-300'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Plan {d}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Legend line (clean inline typography, zero pills) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400 font-mono-tabular">
        <span>Pivotes 2v: H (rojo) / L (verde)</span>
        {tf === '1h' && (
          <>
            <span className="text-sky-400">EMA 20</span>
            <span className="text-amber-400">EMA 50</span>
            <span className="text-pink-400">EMA 200</span>
            <span className="text-violet-400">VWAP Anclado (C2)</span>
            <span>POC / VAH / VAL 7d</span>
          </>
        )}
        {tf === '15m' && (
          <>
            <span className="text-sky-400">Validación D1</span>
            <span className="text-slate-200">Entrada</span>
            <span className="text-rose-400">Stop</span>
            <span className="text-emerald-400">TP1</span>
          </>
        )}
      </div>

      <div
        ref={containerRef}
        className="w-full h-[310px] rounded border border-white/[0.06] overflow-hidden bg-[#0B0E14]"
      />
    </section>
  );
}
