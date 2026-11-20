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

export type CloudPoint = {
  time: UTCTimestamp;
  fast: number;
  slow: number;
};

class EmaCloudRenderer implements IPrimitivePaneRenderer {
  private points: { x: number; yFast: number; ySlow: number; bullish: boolean }[];
  private bullColor: string;
  private bearColor: string;
  private bullEdge: string;
  private bearEdge: string;

  constructor(
    points: { x: number; yFast: number; ySlow: number; bullish: boolean }[],
    bullColor: string,
    bearColor: string,
    bullEdge: string,
    bearEdge: string
  ) {
    this.points = points;
    this.bullColor = bullColor;
    this.bearColor = bearColor;
    this.bullEdge = bullEdge;
    this.bearEdge = bearEdge;
  }

  draw(target: CanvasRenderingTarget2D) {
    if (this.points.length < 2) return;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.save();

      let segStart = 0;
      while (segStart < this.points.length - 1) {
        const isBull = this.points[segStart].bullish;
        let segEnd = segStart + 1;
        while (segEnd < this.points.length && this.points[segEnd].bullish === isBull) {
          segEnd++;
        }

        const polyPts = this.points.slice(segStart, segEnd);
        let crossPt: { x: number; y: number } | null = null;
        if (segEnd < this.points.length) {
          const pA = this.points[segEnd - 1];
          const pB = this.points[segEnd];
          const dA = pA.ySlow - pA.yFast;
          const dB = pB.ySlow - pB.yFast;
          const denom = Math.abs(dA) + Math.abs(dB);
          const ratio = denom > 0 ? Math.abs(dA) / denom : 0.5;
          crossPt = {
            x: pA.x + ratio * (pB.x - pA.x),
            y: pA.yFast + ratio * (pB.yFast - pA.yFast),
          };
        }

        if (polyPts.length >= 1 && (polyPts.length >= 2 || crossPt !== null)) {
          // Fill ribbon
          ctx.beginPath();
          ctx.moveTo(polyPts[0].x, polyPts[0].yFast);
          for (let i = 1; i < polyPts.length; i++) {
            ctx.lineTo(polyPts[i].x, polyPts[i].yFast);
          }
          if (crossPt) {
            ctx.lineTo(crossPt.x, crossPt.y);
          }
          for (let i = polyPts.length - 1; i >= 0; i--) {
            ctx.lineTo(polyPts[i].x, polyPts[i].ySlow);
          }
          ctx.closePath();
          ctx.fillStyle = isBull ? this.bullColor : this.bearColor;
          ctx.fill();

          // Subtle edge lines along fast & slow boundaries
          ctx.beginPath();
          ctx.moveTo(polyPts[0].x, polyPts[0].yFast);
          for (let i = 1; i < polyPts.length; i++) {
            ctx.lineTo(polyPts[i].x, polyPts[i].yFast);
          }
          if (crossPt) ctx.lineTo(crossPt.x, crossPt.y);
          ctx.strokeStyle = isBull ? this.bullEdge : this.bearEdge;
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(polyPts[0].x, polyPts[0].ySlow);
          for (let i = 1; i < polyPts.length; i++) {
            ctx.lineTo(polyPts[i].x, polyPts[i].ySlow);
          }
          if (crossPt) ctx.lineTo(crossPt.x, crossPt.y);
          ctx.strokeStyle = isBull ? this.bullEdge : this.bearEdge;
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        if (segEnd < this.points.length && crossPt) {
          this.points[segEnd - 1] = {
            x: crossPt.x,
            yFast: crossPt.y,
            ySlow: crossPt.y,
            bullish: this.points[segEnd].bullish,
          };
          segStart = segEnd - 1;
        } else {
          segStart = segEnd;
        }
      }

      ctx.restore();
    });
  }
}

class EmaCloudPaneView implements IPrimitivePaneView {
  private source: EmaCloudPrimitive;

  constructor(source: EmaCloudPrimitive) {
    this.source = source;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom';
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this.source.buildRenderer();
  }
}

export class EmaCloudPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private data: CloudPoint[] = [];
  private visible = true;
  private bullColor: string;
  private bearColor: string;
  private bullEdge: string;
  private bearEdge: string;
  private paneView: EmaCloudPaneView;
  private requestUpdate?: () => void;

  constructor(
    bullColor = 'rgba(16, 185, 129, 0.36)',
    bearColor = 'rgba(220, 38, 38, 0.38)',
    bullEdge = 'rgba(16, 185, 129, 0.55)',
    bearEdge = 'rgba(220, 38, 38, 0.65)'
  ) {
    this.bullColor = bullColor;
    this.bearColor = bearColor;
    this.bullEdge = bullEdge;
    this.bearEdge = bearEdge;
    this.paneView = new EmaCloudPaneView(this);
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

  setData(data: CloudPoint[], visible: boolean) {
    this.data = data;
    this.visible = visible;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.visible ? [this.paneView] : [];
  }

  buildRenderer(): IPrimitivePaneRenderer | null {
    if (!this.visible || !this.chart || !this.series || this.data.length < 2) {
      return null;
    }

    const timeScale = this.chart.timeScale();
    const coords: { x: number; yFast: number; ySlow: number; bullish: boolean }[] = [];

    for (const pt of this.data) {
      const x = timeScale.timeToCoordinate(pt.time);
      const yFast = this.series.priceToCoordinate(pt.fast);
      const ySlow = this.series.priceToCoordinate(pt.slow);
      if (x === null || yFast === null || ySlow === null) continue;
      coords.push({
        x,
        yFast,
        ySlow,
        bullish: pt.fast >= pt.slow,
      });
    }

    if (coords.length < 2) return null;
    return new EmaCloudRenderer(coords, this.bullColor, this.bearColor, this.bullEdge, this.bearEdge);
  }
}
