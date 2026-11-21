import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type {
  ConfluenceZone,
  FairValueGap,
  FibonacciAnalysis,
} from '../../calc/technicalAnalysis';

export type TechnicalSessionSpan = {
  startTs: number;
  endTs: number;
  session: 'ASIA' | 'LON' | 'NY';
};

export type RulerOverlayState = {
  a: { ts: number; price: number };
  b: { ts: number; price: number };
  atr14: number | null;
  barsBetween: number;
};

export type RrPlannerOverlay = {
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  anchorTs: number;
};

export type TechnicalZonesOverlayInput = {
  showFibGolden: boolean;
  fib: FibonacciAnalysis | null;
  showFvg: boolean;
  fvgs: FairValueGap[];
  showConfluence: boolean;
  confluences: ConfluenceZone[];
  showSessions: boolean;
  sessions: TechnicalSessionSpan[];
  ruler: RulerOverlayState | null;
  rrPlanner: RrPlannerOverlay | null;
};

class TechnicalZonesRenderer implements IPrimitivePaneRenderer {
  private input: TechnicalZonesOverlayInput;
  private chart: IChartApi;
  private series: ISeriesApi<SeriesType>;

  constructor(
    input: TechnicalZonesOverlayInput,
    chart: IChartApi,
    series: ISeriesApi<SeriesType>
  ) {
    this.input = input;
    this.chart = chart;
    this.series = series;
  }

  draw(target: CanvasRenderingTarget2D) {
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      const tsScale = this.chart.timeScale();

      // 1. Trading Sessions vertical tint bands (Asia / London / NY)
      if (this.input.showSessions && this.input.sessions.length > 0) {
        ctx.font = '600 9px "JetBrains Mono", monospace';
        for (const s of this.input.sessions) {
          const x1 = tsScale.timeToCoordinate(Math.floor(s.startTs / 1000) as UTCTimestamp);
          const x2 = tsScale.timeToCoordinate(Math.floor(s.endTs / 1000) as UTCTimestamp);
          if (x1 === null && x2 === null) continue;
          const left = x1 ?? 0;
          const right = x2 ?? mediaSize.width;
          const w = Math.max(2, right - left);

          const fill =
            s.session === 'ASIA'
              ? 'rgba(148, 163, 184, 0.03)'
              : s.session === 'LON'
              ? 'rgba(56, 189, 248, 0.045)'
              : 'rgba(245, 158, 11, 0.045)';
          const textCol =
            s.session === 'ASIA'
              ? 'rgba(148, 163, 184, 0.5)'
              : s.session === 'LON'
              ? 'rgba(56, 189, 248, 0.65)'
              : 'rgba(251, 191, 36, 0.65)';

          ctx.fillStyle = fill;
          ctx.fillRect(left, 0, w, mediaSize.height);
          if (w > 22) {
            ctx.fillStyle = textCol;
            ctx.fillText(s.session, left + 4, 14);
          }
        }
      }

      // 2. Fair Value Gaps (FVG) unmitigated boxes
      if (this.input.showFvg && this.input.fvgs.length > 0) {
        ctx.font = '600 9px "JetBrains Mono", monospace';
        for (const fvg of this.input.fvgs) {
          const xStart = tsScale.timeToCoordinate(Math.floor(fvg.createdTs / 1000) as UTCTimestamp);
          const yTop = this.series.priceToCoordinate(fvg.top);
          const yBot = this.series.priceToCoordinate(fvg.bottom);
          if (yTop === null || yBot === null) continue;
          const left = xStart !== null ? Math.max(0, xStart) : 0;
          const width = Math.max(24, mediaSize.width - left);
          const topPx = Math.min(yTop, yBot);
          const heightPx = Math.max(3, Math.abs(yBot - yTop));

          const isBull = fvg.direction === 'bullish';
          ctx.fillStyle = isBull ? 'rgba(16, 185, 129, 0.11)' : 'rgba(244, 63, 94, 0.11)';
          ctx.strokeStyle = isBull ? 'rgba(16, 185, 129, 0.42)' : 'rgba(244, 63, 94, 0.42)';
          ctx.lineWidth = 1;
          ctx.fillRect(left, topPx, width, heightPx);
          ctx.strokeRect(left, topPx, width, heightPx);

          if (heightPx >= 11) {
            ctx.fillStyle = isBull ? 'rgba(110, 231, 183, 0.85)' : 'rgba(253, 164, 175, 0.85)';
            ctx.fillText(isBull ? 'FVG+' : 'FVG-', left + 4, topPx + 9);
          }
        }
      }

      // 3. Confluence Zones highlighted bands
      if (this.input.showConfluence && this.input.confluences.length > 0) {
        ctx.font = '600 9px "JetBrains Mono", monospace';
        for (const z of this.input.confluences) {
          const bandPad = z.avgPrice * 0.0014;
          const yHigh = this.series.priceToCoordinate(Math.max(z.highPrice, z.avgPrice + bandPad));
          const yLow = this.series.priceToCoordinate(Math.min(z.lowPrice, z.avgPrice - bandPad));
          if (yHigh === null || yLow === null) continue;
          const topPx = Math.min(yHigh, yLow);
          const hPx = Math.max(5, Math.abs(yLow - yHigh));

          ctx.fillStyle =
            z.kind === 'soporte'
              ? 'rgba(16, 185, 129, 0.09)'
              : z.kind === 'resistencia'
              ? 'rgba(244, 63, 94, 0.09)'
              : 'rgba(56, 189, 248, 0.09)';
          ctx.fillRect(0, topPx, mediaSize.width, hPx);

          ctx.strokeStyle =
            z.kind === 'soporte'
              ? 'rgba(16, 185, 129, 0.45)'
              : z.kind === 'resistencia'
              ? 'rgba(244, 63, 94, 0.45)'
              : 'rgba(56, 189, 248, 0.45)';
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          const yMid = (topPx + topPx + hPx) / 2;
          ctx.beginPath();
          ctx.moveTo(0, yMid);
          ctx.lineTo(mediaSize.width, yMid);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = '#E2E8F0';
          ctx.fillText(`Confluencia ×${z.factorCount}`, 8, topPx - 2 > 10 ? topPx - 2 : topPx + 10);
        }
      }

      // 4. Fibonacci Golden Pocket (0.618 - 0.65) Shaded Band + Bounded Anchor Diagonal
      if (this.input.showFibGolden && this.input.fib) {
        const fib = this.input.fib;
        const y618 = this.series.priceToCoordinate(fib.goldenPocketHigh);
        const y65 = this.series.priceToCoordinate(fib.goldenPocketLow);
        const startTs = Math.min(fib.swingHighTs, fib.swingLowTs);
        const xOrigin = tsScale.timeToCoordinate(Math.floor(startTs / 1000) as UTCTimestamp);
        const left = xOrigin !== null ? Math.max(0, xOrigin) : 0;

        if (y618 !== null && y65 !== null) {
          const gpTop = Math.min(y618, y65);
          const gpH = Math.max(4, Math.abs(y65 - y618));
          ctx.fillStyle = 'rgba(250, 204, 21, 0.12)';
          ctx.fillRect(left, gpTop, mediaSize.width - left, gpH);
          ctx.font = '600 9px "JetBrains Mono", monospace';
          ctx.fillStyle = 'rgba(253, 224, 71, 0.85)';
          ctx.fillText('Golden Pocket 61.8-65%', left + 6, gpTop + Math.min(11, gpH));
        }

        const xHigh = tsScale.timeToCoordinate(Math.floor(fib.swingHighTs / 1000) as UTCTimestamp);
        const xLow = tsScale.timeToCoordinate(Math.floor(fib.swingLowTs / 1000) as UTCTimestamp);
        const yHigh = this.series.priceToCoordinate(fib.swingHigh);
        const yLow = this.series.priceToCoordinate(fib.swingLow);
        if (xHigh !== null && xLow !== null && yHigh !== null && yLow !== null) {
          ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
          ctx.lineWidth = 1.25;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(xLow, yLow);
          ctx.lineTo(xHigh, yHigh);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // 5. Risk / Reward Simulator Box
      if (this.input.rrPlanner) {
        const rr = this.input.rrPlanner;
        const yEntry = this.series.priceToCoordinate(rr.entry);
        const ySl = this.series.priceToCoordinate(rr.stopLoss);
        const yTp1 = this.series.priceToCoordinate(rr.tp1);
        const yTp2 = this.series.priceToCoordinate(rr.tp2);
        const xAnchor = tsScale.timeToCoordinate(Math.floor(rr.anchorTs / 1000) as UTCTimestamp);
        const boxLeft = xAnchor !== null ? Math.max(40, Math.min(mediaSize.width - 140, xAnchor)) : mediaSize.width * 0.65;
        const boxW = Math.min(180, Math.max(90, mediaSize.width - boxLeft - 6));

        if (yEntry !== null && ySl !== null && yTp2 !== null) {
          // Risk box (Entry -> SL)
          const rTop = Math.min(yEntry, ySl);
          const rH = Math.max(2, Math.abs(ySl - yEntry));
          ctx.fillStyle = 'rgba(244, 63, 94, 0.16)';
          ctx.fillRect(boxLeft, rTop, boxW, rH);

          // Reward box (Entry -> TP2)
          const wTop = Math.min(yEntry, yTp2);
          const wH = Math.max(2, Math.abs(yTp2 - yEntry));
          ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
          ctx.fillRect(boxLeft, wTop, boxW, wH);

          if (yTp1 !== null) {
            ctx.strokeStyle = 'rgba(52, 211, 153, 0.7)';
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(boxLeft, yTp1);
            ctx.lineTo(boxLeft + boxW, yTp1);
            ctx.stroke();
            ctx.setLineDash([]);
          }

          const risk = Math.abs(rr.entry - rr.stopLoss);
          const reward = Math.abs(rr.tp2 - rr.entry);
          const ratio = risk > 0 ? reward / risk : 0;

          ctx.font = '600 10px "JetBrains Mono", monospace';
          ctx.fillStyle = '#34D399';
          ctx.fillText(
            `${rr.direction} R:R ${ratio.toFixed(2)}x`,
            boxLeft + 6,
            yTp2 + (rr.direction === 'LONG' ? 12 : -5)
          );
        }
      }

      // 6. Active Ruler Measurement
      if (this.input.ruler) {
        const { a, b, atr14, barsBetween } = this.input.ruler;
        const x1 = tsScale.timeToCoordinate(Math.floor(a.ts / 1000) as UTCTimestamp);
        const y1 = this.series.priceToCoordinate(a.price);
        const x2 = tsScale.timeToCoordinate(Math.floor(b.ts / 1000) as UTCTimestamp);
        const y2 = this.series.priceToCoordinate(b.price);

        if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
          const diff = b.price - a.price;
          const pct = a.price > 0 ? (diff / a.price) * 100 : 0;
          const isUp = diff >= 0;
          const stroke = isUp ? '#34D399' : '#FB7185';

          ctx.fillStyle = isUp ? 'rgba(16, 185, 129, 0.08)' : 'rgba(244, 63, 94, 0.08)';
          ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));

          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.setLineDash([]);

          for (const [px, py] of [
            [x1, y1],
            [x2, y2],
          ]) {
            ctx.beginPath();
            ctx.arc(px, py, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = stroke;
            ctx.fill();
          }

          const atrText = atr14 && atr14 > 0 ? ` · ${(Math.abs(diff) / atr14).toFixed(2)}×ATR` : '';
          const label = `${diff >= 0 ? '+' : ''}${diff.toFixed(1)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)${atrText} · ${barsBetween}v`;
          ctx.font = '600 10px "JetBrains Mono", monospace';
          const tw = ctx.measureText(label).width + 12;
          const bx = Math.min(mediaSize.width - tw - 6, Math.max(6, (x1 + x2) / 2 - tw / 2));
          const by = Math.max(18, Math.min(mediaSize.height - 24, (y1 + y2) / 2 - 10));

          ctx.fillStyle = 'rgba(11, 14, 20, 0.92)';
          ctx.fillRect(bx, by, tw, 18);
          ctx.strokeStyle = stroke;
          ctx.lineWidth = 1;
          ctx.strokeRect(bx, by, tw, 18);
          ctx.fillStyle = '#F8FAFC';
          ctx.fillText(label, bx + 6, by + 12);
        }
      }

      ctx.restore();
    });
  }
}

class TechnicalZonesPaneView implements IPrimitivePaneView {
  private primitive: TechnicalZonesPrimitive;

  constructor(primitive: TechnicalZonesPrimitive) {
    this.primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom';
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this.primitive.buildRenderer();
  }
}

export class TechnicalZonesPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private paneView: TechnicalZonesPaneView;
  private input: TechnicalZonesOverlayInput = {
    showFibGolden: false,
    fib: null,
    showFvg: false,
    fvgs: [],
    showConfluence: false,
    confluences: [],
    showSessions: false,
    sessions: [],
    ruler: null,
    rrPlanner: null,
  };

  constructor() {
    this.paneView = new TechnicalZonesPaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  updateAllViews() {
    // Recomputed lazily in renderer
  }

  paneViews() {
    return [this.paneView];
  }

  setData(input: TechnicalZonesOverlayInput) {
    this.input = input;
    this.requestUpdate?.();
  }

  buildRenderer(): IPrimitivePaneRenderer | null {
    if (!this.chart || !this.series) return null;
    return new TechnicalZonesRenderer(this.input, this.chart, this.series);
  }
}
