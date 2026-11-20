import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
  UTCTimestamp,
} from 'lightweight-charts';
import type { CanvasRenderingTarget2D } from 'fancy-canvas';

export type ChartEventBadge = {
  id: string;
  time: UTCTimestamp;
  name: string;
};

class MacroEventsRenderer implements IPrimitivePaneRenderer {
  private items: { x: number; name: string }[];

  constructor(items: { x: number; name: string }[]) {
    this.items = items;
  }

  draw(target: CanvasRenderingTarget2D) {
    if (this.items.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = '700 10px "Plus Jakarta Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const chipY = mediaSize.height - 30;

      for (const item of this.items) {
        if (item.x < 10 || item.x > mediaSize.width - 10) continue;

        ctx.beginPath();
        ctx.moveTo(item.x, mediaSize.height - 56);
        ctx.lineTo(item.x, mediaSize.height);
        ctx.strokeStyle = 'rgba(234, 179, 8, 0.40)';
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 2]);
        ctx.stroke();
        ctx.setLineDash([]);

        const textW = ctx.measureText(item.name).width;
        const boxW = textW + 10;
        const boxH = 16;
        const rx = item.x - boxW / 2;
        const ry = chipY - boxH / 2;

        ctx.fillStyle = '#CA8A04';
        ctx.beginPath();
        ctx.roundRect(rx, ry, boxW, boxH, 3);
        ctx.fill();

        ctx.strokeStyle = '#FACC15';
        ctx.lineWidth = 0.85;
        ctx.stroke();

        ctx.fillStyle = '#090D14';
        ctx.fillText(item.name, item.x, chipY + 0.5);
      }

      ctx.restore();
    });
  }
}

class MacroEventsPaneView implements IPrimitivePaneView {
  private source: MacroEventsPrimitive;

  constructor(source: MacroEventsPrimitive) {
    this.source = source;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this.source.buildRenderer();
  }
}

export class MacroEventsPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private badges: ChartEventBadge[] = [];
  private visible = true;
  private paneView: MacroEventsPaneView;
  private requestUpdate?: () => void;

  constructor() {
    this.paneView = new MacroEventsPaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart;
    this.requestUpdate = param.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.requestUpdate = undefined;
  }

  setData(badges: ChartEventBadge[], visible: boolean) {
    this.badges = badges;
    this.visible = visible;
    this.requestUpdate?.();
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.visible && this.badges.length > 0 ? [this.paneView] : [];
  }

  buildRenderer(): IPrimitivePaneRenderer | null {
    if (!this.visible || !this.chart || this.badges.length === 0) {
      return null;
    }
    const timeScale = this.chart.timeScale();
    const items: { x: number; name: string }[] = [];
    for (const b of this.badges) {
      const x = timeScale.timeToCoordinate(b.time);
      if (x !== null) {
        items.push({ x, name: b.name });
      }
    }
    if (items.length === 0) return null;
    return new MacroEventsRenderer(items);
  }
}
