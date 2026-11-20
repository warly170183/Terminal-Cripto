import type {
  AutoscaleInfo,
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
import { calculateTouchProbability, getStrikeIV, type ConeProjection } from '../../calc/cone';
import type { OptionRow, StrikeRow } from '../../types/market';

type ScreenConePoint = {
  x: number;
  yU95: number;
  yL95: number;
  yU80: number;
  yL80: number;
  yU50: number;
  yL50: number;
};

type StrikePill = {
  strike: number;
  y: number;
  probPct: number;
  aboveSpot: boolean;
};

type HeatmapTick = {
  strike: number;
  y: number;
  gex: number;
  norm: number;
};

function formatPriceShort(p: number): string {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return p.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function formatExpiryShort(isoDate: string): string {
  const dt = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return isoDate;
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

class ExpectedRangeConeRenderer implements IPrimitivePaneRenderer {
  private pts: ScreenConePoint[];
  private yMaxPain: number;
  private ySpot: number;
  private cone: ConeProjection;
  private strikePills: StrikePill[];
  private heatmapTicks: HeatmapTick[];

  constructor(
    pts: ScreenConePoint[],
    yMaxPain: number,
    ySpot: number,
    cone: ConeProjection,
    strikePills: StrikePill[],
    heatmapTicks: HeatmapTick[]
  ) {
    this.pts = pts;
    this.yMaxPain = yMaxPain;
    this.ySpot = ySpot;
    this.cone = cone;
    this.strikePills = strikePills;
    this.heatmapTicks = heatmapTicks;
  }

  draw(target: CanvasRenderingTarget2D) {
    if (this.pts.length < 2) return;

    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();

      const startX = this.pts[0].x;
      const endX = this.pts[this.pts.length - 1].x;
      const panelLeft = startX;
      const panelRight = mediaSize.width;

      // 1. Subtle slate-dark backdrop panel starting right at the end of the last candle
      const bgGrad = ctx.createLinearGradient(panelLeft, 0, panelRight, 0);
      bgGrad.addColorStop(0, 'rgba(17, 23, 34, 0.60)');
      bgGrad.addColorStop(1, 'rgba(13, 18, 28, 0.85)');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(panelLeft, 0, Math.max(0, panelRight - panelLeft), mediaSize.height);

      // Vertical hairline divider at the apex (end of last candle)
      ctx.beginPath();
      ctx.moveTo(panelLeft, 0);
      ctx.lineTo(panelLeft, mediaSize.height);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 2. White/silver translucent probability cone bands (95%, 80%, 50%) opening from apex
      const drawWhiteBand = (
        getU: (p: ScreenConePoint) => number,
        getL: (p: ScreenConePoint) => number,
        fillApex: string,
        fillRight: string,
        strokeColor: string,
        lineWidth: number
      ) => {
        ctx.beginPath();
        ctx.moveTo(this.pts[0].x, this.ySpot);
        for (let i = 1; i < this.pts.length; i++) {
          ctx.lineTo(this.pts[i].x, getU(this.pts[i]));
        }
        for (let i = this.pts.length - 1; i >= 1; i--) {
          ctx.lineTo(this.pts[i].x, getL(this.pts[i]));
        }
        ctx.lineTo(this.pts[0].x, this.ySpot);
        ctx.closePath();

        const fanGrad = ctx.createLinearGradient(startX, 0, endX, 0);
        fanGrad.addColorStop(0, fillApex);
        fanGrad.addColorStop(1, fillRight);
        ctx.fillStyle = fanGrad;
        ctx.fill();

        // Dotted white boundary arcs
        ctx.beginPath();
        ctx.setLineDash([2, 3]);
        ctx.moveTo(this.pts[0].x, this.ySpot);
        for (let i = 1; i < this.pts.length; i++) {
          ctx.lineTo(this.pts[i].x, getU(this.pts[i]));
        }
        ctx.moveTo(this.pts[0].x, this.ySpot);
        for (let i = 1; i < this.pts.length; i++) {
          ctx.lineTo(this.pts[i].x, getL(this.pts[i]));
        }
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
        ctx.setLineDash([]);
      };

      // 95% outer white veil
      drawWhiteBand(
        (p) => p.yU95,
        (p) => p.yL95,
        'rgba(255, 255, 255, 0.05)',
        'rgba(255, 255, 255, 0.11)',
        'rgba(255, 255, 255, 0.30)',
        1
      );
      // 80% middle white veil
      drawWhiteBand(
        (p) => p.yU80,
        (p) => p.yL80,
        'rgba(255, 255, 255, 0.08)',
        'rgba(255, 255, 255, 0.17)',
        'rgba(255, 255, 255, 0.44)',
        1
      );
      // 50% core white cone
      drawWhiteBand(
        (p) => p.yU50,
        (p) => p.yL50,
        'rgba(255, 255, 255, 0.12)',
        'rgba(255, 255, 255, 0.24)',
        'rgba(255, 255, 255, 0.62)',
        1.2
      );

      // 2b. Probability percentage labels inside EACH cone layer (50%, 80%, 95%)
      const drawLayerBadge = (x: number, y: number, text: string, accentAlpha: number) => {
        if (y < 14 || y > mediaSize.height - 16) return;
        ctx.save();
        ctx.font = '600 9.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(text).width + 10;
        const h = 15;
        ctx.fillStyle = `rgba(9, 13, 20, ${accentAlpha})`;
        ctx.beginPath();
        ctx.roundRect(x - w / 2, y - h / 2, w, h, 3);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
        ctx.lineWidth = 0.8;
        ctx.stroke();
        ctx.fillStyle = '#F8FAFC';
        ctx.fillText(text, x, y + 0.5);
        ctx.restore();
      };

      const coneSpanX = endX - startX;
      const wideEnough = coneSpanX >= 175;
      const pU50 = Math.round(this.cone.endpoints.touchProbUpper50 * 100);
      const pL50 = Math.round(this.cone.endpoints.touchProbLower50 * 100);
      const pU80 = Math.round(this.cone.endpoints.touchProbUpper80 * 100);
      const pL80 = Math.round(this.cone.endpoints.touchProbLower80 * 100);
      const pU95 = Math.round(this.cone.endpoints.touchProbUpper95 * 100);
      const pL95 = Math.round(this.cone.endpoints.touchProbLower95 * 100);

      const pt50 = this.pts[Math.max(1, Math.floor(this.pts.length * 0.36))];
      const pt80 = this.pts[Math.max(1, Math.floor(this.pts.length * 0.56))];
      const pt95 = this.pts[Math.max(1, Math.floor(this.pts.length * 0.72))];

      if (pt50) {
        const upThickness = this.ySpot - pt50.yU50;
        const dnThickness = pt50.yL50 - this.ySpot;
        if (upThickness >= 13) {
          drawLayerBadge(
            pt50.x,
            (pt50.yU50 + this.ySpot) * 0.5,
            wideEnough ? `50% · ↑${pU50}%` : '50%',
            0.78
          );
        }
        if (dnThickness >= 13) {
          drawLayerBadge(
            pt50.x,
            (this.ySpot + pt50.yL50) * 0.5,
            wideEnough ? `50% · ↓${pL50}%` : '50%',
            0.78
          );
        }
      }

      if (pt80) {
        const up80Band = pt80.yU50 - pt80.yU80;
        const dn80Band = pt80.yL80 - pt80.yL50;
        if (up80Band >= 13) {
          drawLayerBadge(
            pt80.x,
            (pt80.yU80 + pt80.yU50) * 0.5,
            wideEnough ? `80% · ↑${pU80}%` : '80%',
            0.72
          );
        }
        if (dn80Band >= 13) {
          drawLayerBadge(
            pt80.x,
            (pt80.yL50 + pt80.yL80) * 0.5,
            wideEnough ? `80% · ↓${pL80}%` : '80%',
            0.72
          );
        }
      }

      if (pt95) {
        const up95Band = pt95.yU80 - pt95.yU95;
        const dn95Band = pt95.yL95 - pt95.yL80;
        if (up95Band >= 13) {
          drawLayerBadge(
            pt95.x,
            (pt95.yU95 + pt95.yU80) * 0.5,
            wideEnough ? `95% · ↑${pU95}%` : '95%',
            0.66
          );
        }
        if (dn95Band >= 13) {
          drawLayerBadge(
            pt95.x,
            (pt95.yL80 + pt95.yL95) * 0.5,
            wideEnough ? `95% · ↓${pL95}%` : '95%',
            0.66
          );
        }
      }

      // Hollow white diamond markers along outer cone bounds
      const diamondIndices = [
        Math.floor(this.pts.length * 0.28),
        Math.floor(this.pts.length * 0.56),
        Math.floor(this.pts.length * 0.84),
      ];
      for (const idx of diamondIndices) {
        const pt = this.pts[idx];
        if (!pt) continue;
        for (const dy of [pt.yU95, pt.yL95]) {
          if (dy < 16 || dy > mediaSize.height - 20) continue;
          ctx.save();
          ctx.translate(pt.x, dy);
          ctx.rotate(Math.PI / 4);
          ctx.fillStyle = '#0B0E11';
          ctx.fillRect(-2.5, -2.5, 5, 5);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
          ctx.lineWidth = 1;
          ctx.strokeRect(-2.5, -2.5, 5, 5);
          ctx.restore();
        }
      }

      // 3. Bright glowing white Max Pain pull trajectory curve from exact last candle close
      const midX = startX + (endX - startX) * 0.52;
      const deltaY = this.yMaxPain - this.ySpot;
      const archOffset = Math.abs(deltaY) < 12 ? -18 : -Math.sign(deltaY) * 14;
      const ctrlY = (this.ySpot + this.yMaxPain) * 0.5 + archOffset;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(startX, this.ySpot);
      ctx.quadraticCurveTo(midX, ctrlY, endX, this.yMaxPain);
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2.2;
      ctx.shadowColor = 'rgba(255, 255, 255, 0.85)';
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.restore();

      // Glowing white origin & destination nodes
      ctx.beginPath();
      ctx.arc(startX, this.ySpot, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(endX, this.yMaxPain, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();

      // Max Pain inline label
      ctx.font = '600 10px "JetBrains Mono", monospace';
      ctx.textBaseline = 'middle';
      const mpText = `${formatExpiryShort(this.cone.expiry)} · $${formatPriceShort(this.cone.maxPain)}`;
      const mpW = ctx.measureText(mpText).width;
      const mpX = Math.max(startX + 8, Math.min(endX - mpW - 10, mediaSize.width - mpW - 42));
      const mpY = Math.max(14, Math.min(mediaSize.height - 20, this.yMaxPain - 13));
      ctx.fillStyle = 'rgba(11, 14, 17, 0.88)';
      ctx.fillRect(mpX - 4, mpY - 7, mpW + 8, 14);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(mpText, mpX, mpY);

      // High end / Low end labels
      const endPt = this.pts[this.pts.length - 1];
      ctx.font = '500 10px "JetBrains Mono", monospace';
      if (endPt.yU95 > 16 && endPt.yU95 < mediaSize.height - 30) {
        ctx.fillStyle = '#E2E8F0';
        ctx.fillText(
          `High end ${formatPriceShort(this.cone.endpoints.upper95)}`,
          Math.max(startX + 8, endX - 120),
          endPt.yU95 - 10
        );
      }
      if (endPt.yL95 > 20 && endPt.yL95 < mediaSize.height - 16) {
        ctx.fillStyle = '#E2E8F0';
        ctx.fillText(
          `Low end ${formatPriceShort(this.cone.endpoints.lower95)}`,
          Math.max(startX + 8, endX - 120),
          endPt.yL95 + 11
        );
      }

      // 4. Right-edge Strike Probability Pills (▲ Strike · XX% / ▼ Strike · XX%)
      ctx.font = '600 10px "JetBrains Mono", monospace';
      const rightEdgeX = panelRight - 20;
      let lastPillY = -Infinity;

      for (const sp of this.strikePills) {
        if (sp.y < 18 || sp.y > mediaSize.height - 26) continue;
        if (sp.y - lastPillY < 22) continue;
        lastPillY = sp.y;

        const arrow = sp.aboveSpot ? '▲' : '▼';
        const label = `${arrow} ${formatPriceShort(sp.strike)} · ${sp.probPct}%`;
        const w = ctx.measureText(label).width + 12;
        const h = 17;
        const bx = Math.max(startX + 6, rightEdgeX - w - 8);
        const by = sp.y - h / 2;

        ctx.fillStyle = 'rgba(10, 14, 21, 0.92)';
        ctx.beginPath();
        ctx.roundRect(bx, by, w, h, 3);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#F8FAFC';
        ctx.fillText(label, bx + 6, sp.y + 0.5);
      }

      // 5. Thin vertical GEX intensity bar next to the Y-axis
      const barW = 7;
      const barX = mediaSize.width - barW - 2;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(barX, 0, barW, mediaSize.height);

      for (const ht of this.heatmapTicks) {
        if (ht.y < 2 || ht.y > mediaSize.height - 2) continue;
        const alpha = 0.25 + Math.abs(ht.norm) * 0.75;
        ctx.fillStyle =
          ht.gex >= 0
            ? `rgba(16, 185, 129, ${alpha.toFixed(2)})`
            : `rgba(59, 130, 246, ${alpha.toFixed(2)})`;
        ctx.fillRect(barX, ht.y - 4, barW, 8);
      }

      ctx.restore();
    });
  }
}

class ExpectedRangeConePaneView implements IPrimitivePaneView {
  private source: ExpectedRangeConePrimitive;

  constructor(source: ExpectedRangeConePrimitive) {
    this.source = source;
  }

  zOrder(): PrimitivePaneViewZOrder {
    return 'top';
  }

  renderer(): IPrimitivePaneRenderer | null {
    return this.source.buildRenderer();
  }
}

export class ExpectedRangeConePrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private cone: ConeProjection | null = null;
  private strikes: StrikeRow[] = [];
  private expiryOptions: OptionRow[] = [];
  private lastBarIndex = 0;
  private lastBarTime: UTCTimestamp | null = null;
  private visible = true;
  private paneView: ExpectedRangeConePaneView;
  private requestUpdate?: () => void;

  constructor() {
    this.paneView = new ExpectedRangeConePaneView(this);
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

  setData(
    cone: ConeProjection | null,
    strikes: StrikeRow[],
    expiryOptions: OptionRow[],
    lastBarIndex: number,
    lastBarTime: UTCTimestamp | null,
    visible: boolean
  ) {
    this.cone = cone;
    this.strikes = strikes;
    this.expiryOptions = expiryOptions;
    this.lastBarIndex = lastBarIndex;
    this.lastBarTime = lastBarTime;
    this.visible = visible;
    this.requestUpdate?.();
  }

  autoscaleInfo(_start: Logical, end: Logical): AutoscaleInfo | null {
    if (!this.visible || !this.cone || end < this.lastBarIndex - 2) {
      return null;
    }
    const { upper95, lower95, upper50, lower50 } = this.cone.endpoints;
    if (upper95 / this.cone.spot > 1.45 || lower95 / this.cone.spot < 0.55) {
      return {
        priceRange: {
          minValue: Math.min(lower50, this.cone.maxPain),
          maxValue: Math.max(upper50, this.cone.maxPain),
        },
      };
    }
    return {
      priceRange: {
        minValue: Math.min(lower95, this.cone.maxPain),
        maxValue: Math.max(upper95, this.cone.maxPain),
      },
    };
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.visible && this.cone ? [this.paneView] : [];
  }

  buildRenderer(): IPrimitivePaneRenderer | null {
    if (!this.visible || !this.cone || !this.chart || !this.series || this.lastBarIndex < 1) {
      return null;
    }

    const timeScale = this.chart.timeScale();
    const chartWidth = timeScale.width();

    // Anchor cone apex right at the final candle of the chart
    let startX =
      this.lastBarTime !== null ? timeScale.timeToCoordinate(this.lastBarTime) : null;
    if (startX === null) {
      startX = timeScale.logicalToCoordinate(this.lastBarIndex as Logical);
    }
    if (startX === null || chartWidth <= 0) {
      return null;
    }

    // Offset slightly right of last candle wick (+5px) so apex starts cleanly right after the candle
    const apexX = startX + 5;
    const coneEndX = Math.max(apexX + 40, chartWidth - 16);
    if (apexX >= chartWidth - 24) {
      return null;
    }

    const pts: ScreenConePoint[] = [];
    for (const p of this.cone.points) {
      const x = apexX + p.stepFraction * (coneEndX - apexX);
      const yU95 = this.series.priceToCoordinate(p.upper95);
      const yL95 = this.series.priceToCoordinate(p.lower95);
      const yU80 = this.series.priceToCoordinate(p.upper80);
      const yL80 = this.series.priceToCoordinate(p.lower80);
      const yU50 = this.series.priceToCoordinate(p.upper50);
      const yL50 = this.series.priceToCoordinate(p.lower50);

      if (
        yU95 === null ||
        yL95 === null ||
        yU80 === null ||
        yL80 === null ||
        yU50 === null ||
        yL50 === null
      ) {
        continue;
      }

      pts.push({ x, yU95, yL95, yU80, yL80, yU50, yL50 });
    }

    const yMaxPain = this.series.priceToCoordinate(this.cone.maxPain);
    const ySpot = this.series.priceToCoordinate(this.cone.spot);

    if (pts.length < 2 || yMaxPain === null || ySpot === null) {
      return null;
    }

    const yearsToExp = Math.max(
      1e-5,
      (this.cone.expTs - Date.now()) / (365 * 24 * 60 * 60 * 1000)
    );
    const strikePills: StrikePill[] = [];
    const maxAbsGex = Math.max(1, ...this.strikes.map((s) => Math.abs(s.gex)));
    const heatmapTicks: HeatmapTick[] = [];

    const sortedDesc = [...this.strikes].sort((a, b) => b.strike - a.strike);
    for (const s of sortedDesc) {
      const y = this.series.priceToCoordinate(s.strike);
      if (y === null) continue;

      if (s.oi > 0 || Math.abs(s.gex) > 0) {
        heatmapTicks.push({
          strike: s.strike,
          y,
          gex: s.gex,
          norm: Math.max(-1, Math.min(1, s.gex / maxAbsGex)),
        });
      }

      if (
        s.strike >= this.cone.endpoints.lower95 * 0.96 &&
        s.strike <= this.cone.endpoints.upper95 * 1.04 &&
        s.oi > 0
      ) {
        const strikeIv =
          this.expiryOptions.length > 0
            ? getStrikeIV(this.expiryOptions, this.cone.spot, this.cone.expiry, s.strike)
            : this.cone.atmIV;
        const prob = calculateTouchProbability(
          this.cone.spot,
          s.strike,
          strikeIv,
          yearsToExp
        );
        strikePills.push({
          strike: s.strike,
          y,
          probPct: Math.round(prob * 100),
          aboveSpot: s.strike >= this.cone.spot,
        });
      }
    }

    return new ExpectedRangeConeRenderer(
      pts,
      yMaxPain,
      ySpot,
      this.cone,
      strikePills,
      heatmapTicks
    );
  }
}
