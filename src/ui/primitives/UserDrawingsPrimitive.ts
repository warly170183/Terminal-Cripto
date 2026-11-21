import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import { computeRayEndpointPx, resolveLogicalFromTimeSec } from '../../calc/chartDrawings';
import type {
  ChartAnchorPoint,
  MarkerFollowStatus,
  UserChartMarker,
  UserTrendLine,
} from '../../types/market';

export type PreviewTrendLine = {
  kind: 'segment' | 'ray';
  p1: ChartAnchorPoint;
  p2: ChartAnchorPoint;
  color: string;
};

type ScreenLine = {
  id: string;
  kind: 'segment' | 'ray';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  label?: string;
  selected: boolean;
  isPreview?: boolean;
  deltaText?: string;
};

type ScreenMarker = {
  id: string;
  x: number;
  y: number;
  price: number;
  label: string;
  color: string;
  status: MarkerFollowStatus;
  selected: boolean;
};

function formatPriceTag(price: number): string {
  if (price >= 1000) return `$${price.toLocaleString('en-US', { maximumFractionDigits: 1 })}`;
  return `$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function resolveMarkerColors(status: MarkerFollowStatus, baseColor: string): {
  stroke: string;
  fill: string;
  glyph: string;
} {
  if (status === 'cumplido') {
    return { stroke: '#10B981', fill: '#10B981', glyph: '✓' };
  }
  if (status === 'invalidado') {
    return { stroke: '#F43F5E', fill: '#F43F5E', glyph: '✕' };
  }
  return { stroke: baseColor, fill: baseColor, glyph: '•' };
}

class UserDrawingsRenderer implements IPrimitivePaneRenderer {
  private lines: ScreenLine[];
  private markers: ScreenMarker[];

  constructor(lines: ScreenLine[], markers: ScreenMarker[]) {
    this.lines = lines;
    this.markers = markers;
  }

  draw(target: CanvasRenderingTarget2D) {
    if (this.lines.length === 0 && this.markers.length === 0) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();

      // 1. Render trendlines & rays (including live preview)
      for (const ln of this.lines) {
        let endX = ln.x2;
        let endY = ln.y2;

        if (ln.kind === 'ray') {
          const rayEnd = computeRayEndpointPx(
            ln.x1,
            ln.y1,
            ln.x2,
            ln.y2,
            mediaSize.width,
            mediaSize.height
          );
          if (rayEnd) {
            endX = rayEnd.x2;
            endY = rayEnd.y2;
          }
        }

        // Subtle dark halo underneath so lines stay sharp over white Prediction Cone shading
        ctx.beginPath();
        ctx.moveTo(ln.x1, ln.y1);
        ctx.lineTo(endX, endY);
        ctx.strokeStyle = 'rgba(11, 14, 17, 0.72)';
        ctx.lineWidth = ln.selected ? 5 : 4;
        ctx.setLineDash(ln.isPreview ? [6, 4] : []);
        ctx.stroke();

        // Main colored line
        ctx.beginPath();
        ctx.moveTo(ln.x1, ln.y1);
        ctx.lineTo(endX, endY);
        ctx.strokeStyle = ln.color;
        ctx.lineWidth = ln.selected ? 2.5 : 1.75;
        ctx.globalAlpha = ln.isPreview ? 0.85 : 1;
        ctx.setLineDash(ln.isPreview ? [6, 4] : []);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        // Ray directional tick at p2 to distinguish p2 anchor
        const drawAnchor = (ax: number, ay: number, radius: number) => {
          ctx.beginPath();
          ctx.arc(ax, ay, radius, 0, Math.PI * 2);
          ctx.fillStyle = '#0B0E11';
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = ln.color;
          ctx.stroke();
        };

        const anchorR = ln.selected || ln.isPreview ? 4.5 : 3;
        drawAnchor(ln.x1, ln.y1, anchorR);
        drawAnchor(ln.x2, ln.y2, anchorR);

        // Optional label or live delta badge
        const tagText = ln.deltaText || ln.label?.trim();
        if (tagText) {
          const mx = ln.isPreview ? ln.x2 + 12 : (ln.x1 + ln.x2) / 2;
          const my = ln.isPreview ? ln.y2 - 14 : (ln.y1 + ln.y2) / 2 - 12;
          ctx.font = '600 10px "JetBrains Mono", monospace';
          const tw = ctx.measureText(tagText).width;
          const bw = tw + 12;
          const bh = 18;
          const bx = Math.max(4, Math.min(mediaSize.width - bw - 4, ln.isPreview ? mx : mx - bw / 2));
          const by = Math.max(4, Math.min(mediaSize.height - bh - 4, my - bh / 2));

          ctx.fillStyle = 'rgba(13, 18, 28, 0.92)';
          ctx.beginPath();
          ctx.roundRect(bx, by, bw, bh, 4);
          ctx.fill();

          ctx.strokeStyle = ln.color;
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.fillStyle = '#F8FAFC';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(tagText, bx + 6, by + bh / 2 + 0.5);
        }
      }

      // 2. Render point markers (candles & future cone area)
      for (const mk of this.markers) {
        if (mk.x < -30 || mk.x > mediaSize.width + 30) continue;
        if (mk.y < -30 || mk.y > mediaSize.height + 30) continue;

        const palette = resolveMarkerColors(mk.status, mk.color);

        // Selection ring
        if (mk.selected) {
          ctx.beginPath();
          ctx.arc(mk.x, mk.y, 12, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([3, 2]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Crosshair ticks around marker
        ctx.beginPath();
        ctx.moveTo(mk.x - 11, mk.y);
        ctx.lineTo(mk.x - 6, mk.y);
        ctx.moveTo(mk.x + 6, mk.y);
        ctx.lineTo(mk.x + 11, mk.y);
        ctx.moveTo(mk.x, mk.y - 11);
        ctx.lineTo(mk.x, mk.y - 6);
        ctx.moveTo(mk.x, mk.y + 6);
        ctx.lineTo(mk.x, mk.y + 11);
        ctx.strokeStyle = palette.stroke;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Diamond beacon
        const r = 6;
        ctx.beginPath();
        ctx.moveTo(mk.x, mk.y - r);
        ctx.lineTo(mk.x + r, mk.y);
        ctx.lineTo(mk.x, mk.y + r);
        ctx.lineTo(mk.x - r, mk.y);
        ctx.closePath();
        ctx.fillStyle = palette.fill;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#0B0E11';
        ctx.stroke();

        // Compact callout badge beside the marker
        const labelPart = mk.label.trim() ? `${mk.label.trim()} · ` : '';
        const text = `${palette.glyph} ${labelPart}${formatPriceTag(mk.price)}`;
        ctx.font = '600 10px "JetBrains Mono", monospace';
        const tw = ctx.measureText(text).width;
        const bw = tw + 12;
        const bh = 18;

        // Place badge right of marker unless near right edge
        const placeLeft = mk.x + 12 + bw > mediaSize.width - 8;
        const bx = placeLeft ? mk.x - 10 - bw : mk.x + 10;
        const by = Math.max(4, Math.min(mediaSize.height - bh - 4, mk.y - bh / 2));

        ctx.fillStyle = 'rgba(11, 15, 23, 0.94)';
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 4);
        ctx.fill();

        ctx.strokeStyle = mk.selected ? '#FFFFFF' : palette.stroke;
        ctx.lineWidth = mk.selected ? 1.4 : 1;
        ctx.stroke();

        ctx.fillStyle = '#F8FAFC';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx + 6, by + bh / 2 + 0.5);
      }

      ctx.restore();
    });
  }
}

class UserDrawingsPaneView implements IPrimitivePaneView {
  private source: UserDrawingsPrimitive;

  constructor(source: UserDrawingsPrimitive) {
    this.source = source;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this.source.buildRenderer();
  }
}

export class UserDrawingsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private paneView: UserDrawingsPaneView;
  private requestUpdate?: () => void;

  private trendLines: UserTrendLine[] = [];
  private markers: UserChartMarker[] = [];
  private previewLine: PreviewTrendLine | null = null;
  private selectedTrendLineId: string | null = null;
  private selectedMarkerId: string | null = null;
  private barTimesSec: number[] = [];
  private stepSec = 900;
  private visible = true;

  constructor() {
    this.paneView = new UserDrawingsPaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.requestUpdate = undefined;
  }

  setData(params: {
    trendLines: UserTrendLine[];
    markers: UserChartMarker[];
    previewLine: PreviewTrendLine | null;
    selectedTrendLineId: string | null;
    selectedMarkerId: string | null;
    barTimesSec: number[];
    stepSec: number;
    visible: boolean;
  }) {
    this.trendLines = params.trendLines;
    this.markers = params.markers;
    this.previewLine = params.previewLine;
    this.selectedTrendLineId = params.selectedTrendLineId;
    this.selectedMarkerId = params.selectedMarkerId;
    this.barTimesSec = params.barTimesSec;
    this.stepSec = Math.max(60, Math.round(params.stepSec));
    this.visible = params.visible;
    this.requestUpdate?.();
  }

  pointToScreen(pt: ChartAnchorPoint): { x: number; y: number } | null {
    if (!this.chart || !this.series) return null;
    const y = this.series.priceToCoordinate(pt.price);
    if (y === null || !Number.isFinite(y)) return null;

    const timeScale = this.chart.timeScale();
    let x = timeScale.timeToCoordinate(pt.timeSec as UTCTimestamp);
    if (x === null && this.barTimesSec.length > 0) {
      const logical = resolveLogicalFromTimeSec(pt.timeSec, this.barTimesSec, this.stepSec);
      if (logical !== null) {
        x = timeScale.logicalToCoordinate(logical as Logical);
      }
    }
    if (x === null || !Number.isFinite(x)) return null;
    return { x, y };
  }

  paneViews(): readonly IPrimitivePaneView[] {
    if (!this.visible) return [];
    if (this.trendLines.length === 0 && this.markers.length === 0 && !this.previewLine) {
      return [];
    }
    return [this.paneView];
  }

  buildRenderer(): IPrimitivePaneRenderer | null {
    if (!this.visible || !this.chart || !this.series) return null;

    const screenLines: ScreenLine[] = [];
    for (const tl of this.trendLines) {
      const s1 = this.pointToScreen(tl.p1);
      const s2 = this.pointToScreen(tl.p2);
      if (!s1 || !s2) continue;
      screenLines.push({
        id: tl.id,
        kind: tl.kind,
        x1: s1.x,
        y1: s1.y,
        x2: s2.x,
        y2: s2.y,
        color: tl.color,
        label: tl.label,
        selected: tl.id === this.selectedTrendLineId,
      });
    }

    if (this.previewLine) {
      const s1 = this.pointToScreen(this.previewLine.p1);
      const s2 = this.pointToScreen(this.previewLine.p2);
      if (s1 && s2) {
        const diff = this.previewLine.p2.price - this.previewLine.p1.price;
        const pct =
          this.previewLine.p1.price > 0 ? (diff / this.previewLine.p1.price) * 100 : 0;
        const sign = diff >= 0 ? '+' : '';
        screenLines.push({
          id: 'preview',
          kind: this.previewLine.kind,
          x1: s1.x,
          y1: s1.y,
          x2: s2.x,
          y2: s2.y,
          color: this.previewLine.color,
          selected: false,
          isPreview: true,
          deltaText: `${sign}${pct.toFixed(2)}% (${sign}$${Math.round(diff).toLocaleString('en-US')})`,
        });
      }
    }

    const screenMarkers: ScreenMarker[] = [];
    for (const mk of this.markers) {
      const pt = this.pointToScreen({ timeSec: mk.timeSec, price: mk.price });
      if (!pt) continue;
      screenMarkers.push({
        id: mk.id,
        x: pt.x,
        y: pt.y,
        price: mk.price,
        label: mk.label,
        color: mk.color,
        status: mk.status,
        selected: mk.id === this.selectedMarkerId,
      });
    }

    if (screenLines.length === 0 && screenMarkers.length === 0) return null;
    return new UserDrawingsRenderer(screenLines, screenMarkers);
  }
}
