import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';
import type { VolumeProfileData } from '../../calc/technicalAnalysis';

type ScreenBucket = {
  yTop: number;
  yBot: number;
  buyFrac: number;
  widthFrac: number;
  isPoc: boolean;
  inValueArea: boolean;
};

class VolumeProfileRenderer implements IPrimitivePaneRenderer {
  private buckets: ScreenBucket[];
  private yPoc: number | null;
  private yVah: number | null;
  private yVal: number | null;

  constructor(
    buckets: ScreenBucket[],
    yPoc: number | null,
    yVah: number | null,
    yVal: number | null
  ) {
    this.buckets = buckets;
    this.yPoc = yPoc;
    this.yVah = yVah;
    this.yVal = yVal;
  }

  draw(target: CanvasRenderingTarget2D) {
    if (this.buckets.length === 0) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();

      const maxBarWidth = Math.min(180, Math.max(70, mediaSize.width * 0.2));
      const rightEdge = mediaSize.width - 2;

      // Subtle shaded Value Area (VAL..VAH) band on the profile edge
      if (this.yVah !== null && this.yVal !== null) {
        const vaTop = Math.min(this.yVah, this.yVal);
        const vaHeight = Math.abs(this.yVal - this.yVah);
        ctx.fillStyle = 'rgba(56, 189, 248, 0.04)';
        ctx.fillRect(rightEdge - maxBarWidth, vaTop, maxBarWidth, vaHeight);
      }

      for (const b of this.buckets) {
        const y0 = Math.min(b.yTop, b.yBot);
        const h = Math.max(2, Math.abs(b.yBot - b.yTop) - 1);
        const totalW = Math.max(2, b.widthFrac * maxBarWidth);
        const buyW = totalW * b.buyFrac;
        const sellW = totalW - buyW;
        const xStart = rightEdge - totalW;

        const alpha = b.isPoc ? 0.55 : b.inValueArea ? 0.34 : 0.16;

        if (sellW > 0.5) {
          ctx.fillStyle = `rgba(244, 63, 94, ${alpha})`;
          ctx.fillRect(xStart, y0, sellW, h);
        }
        if (buyW > 0.5) {
          ctx.fillStyle = `rgba(16, 185, 129, ${alpha})`;
          ctx.fillRect(xStart + sellW, y0, buyW, h);
        }

        if (b.isPoc) {
          ctx.strokeStyle = 'rgba(250, 204, 21, 0.85)';
          ctx.lineWidth = 1;
          ctx.strokeRect(xStart, y0, totalW, h);
        }
      }

      if (this.yPoc !== null) {
        ctx.beginPath();
        ctx.setLineDash([4, 3]);
        ctx.moveTo(0, this.yPoc);
        ctx.lineTo(rightEdge, this.yPoc);
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.72)';
        ctx.lineWidth = 1.25;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.restore();
    });
  }
}

class VolumeProfilePaneView implements IPrimitivePaneView {
  private primitive: VolumeProfilePrimitive;

  constructor(primitive: VolumeProfilePrimitive) {
    this.primitive = primitive;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return 'bottom';
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this.primitive.buildRenderer();
  }
}

export class VolumeProfilePrimitive implements ISeriesPrimitive<Time> {
  private series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private paneView: VolumeProfilePaneView;
  private profile: VolumeProfileData | null = null;
  private visible = true;

  constructor() {
    this.paneView = new VolumeProfilePaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>) {
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.series = null;
    this.requestUpdate = null;
  }

  updateAllViews() {
    // Recomputed lazily on renderer()
  }

  paneViews() {
    return [this.paneView];
  }

  setData(profile: VolumeProfileData | null, visible: boolean) {
    this.profile = profile;
    this.visible = visible;
    this.requestUpdate?.();
  }

  buildRenderer(): IPrimitivePaneRenderer | null {
    if (!this.visible || !this.series || !this.profile || this.profile.maxBucketVol <= 0) {
      return null;
    }

    const screenBuckets: ScreenBucket[] = [];
    const { buckets, maxBucketVol, poc, vah, val } = this.profile;

    for (const b of buckets) {
      const yTop = this.series.priceToCoordinate(b.priceHigh);
      const yBot = this.series.priceToCoordinate(b.priceLow);
      if (yTop === null || yBot === null) continue;

      const total = b.totalVol > 0 ? b.totalVol : 1;
      screenBuckets.push({
        yTop,
        yBot,
        buyFrac: Math.min(1, Math.max(0, b.buyVol / total)),
        widthFrac: Math.min(1, b.totalVol / maxBucketVol),
        isPoc: poc >= b.priceLow && poc <= b.priceHigh,
        inValueArea: b.mid >= val && b.mid <= vah,
      });
    }

    const yPoc = this.series.priceToCoordinate(poc);
    const yVah = this.series.priceToCoordinate(vah);
    const yVal = this.series.priceToCoordinate(val);

    return new VolumeProfileRenderer(screenBuckets, yPoc, yVah, yVal);
  }
}
