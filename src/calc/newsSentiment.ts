import type { Candle, MacroEvent } from '../types/market';

export type RawNewsHeadline = {
  id: string;
  title: string;
  summary: string;
  link: string;
  source: string;
  sourceId: string;
  category: 'crypto' | 'macro';
  pubTs: number;
  pubIso: string;
};

export type NewsTopic = 'BTC' | 'ETH' | 'MACRO' | 'ETF' | 'REG';
export type SentimentLabel = 'Alcista' | 'Bajista' | 'Neutral';
export type PriceAlignmentStatus = 'Confirmado' | 'Divergente' | 'Neutro' | 'Pendiente';

export type EnrichedNewsHeadline = RawNewsHeadline & {
  sentimentScore: number; // -100 .. +100
  sentimentLabel: SentimentLabel;
  matchedTerms: string[];
  topics: NewsTopic[];
  priceAtPub: number | null;
  ret1hPct: number | null;
  ret4hPct: number | null;
  retLatestPct: number | null;
  alignment: PriceAlignmentStatus;
  nearMacroEvent: string | null;
};

export type SentimentTimelinePoint = {
  t: number;
  close: number;
  hourlyRetPct: number;
  sentimentAvg: number | null;
  headlineCount: number;
  topTitle: string | null;
};

export type NewsCorrelationSummary = {
  headlines: EnrichedNewsHeadline[];
  aggregateScore: number; // -100 .. +100 time-decayed
  aggregateLabel: SentimentLabel;
  bullishCount: number;
  bearishCount: number;
  neutralCount: number;
  pearson1h: number | null;
  pearson4h: number | null;
  directionalHitRatePct: number | null;
  evaluatedCount: number;
  avgBullishMovePct: number | null;
  avgBearishMovePct: number | null;
  timeline: SentimentTimelinePoint[];
  regimeSummary: string;
};

const BULLISH_WEIGHTS: Record<string, number> = {
  'rate cut': 28,
  'rate cuts': 28,
  dovish: 24,
  'etf inflow': 28,
  'etf inflows': 28,
  inflows: 20,
  inflow: 18,
  approval: 24,
  approved: 24,
  rally: 22,
  rallies: 22,
  surge: 24,
  surges: 24,
  surged: 24,
  soar: 24,
  soars: 24,
  breakout: 22,
  'all-time high': 28,
  ath: 22,
  accumulate: 18,
  accumulation: 20,
  adoption: 18,
  institutional: 14,
  treasury: 14,
  stimulus: 22,
  liquidity: 14,
  bullish: 26,
  rebound: 18,
  rebounds: 18,
  recovery: 18,
  recovers: 18,
  upgrade: 16,
  partnership: 15,
  gains: 16,
  gain: 14,
  climbs: 18,
  jump: 18,
  jumps: 18,
  record: 14,
  expansion: 16,
  easing: 20,
  disinflation: 22,
  cooling: 18,
  buy: 12,
  buying: 15,
  support: 10,
  resilient: 14,
  optimism: 16,
};

const BEARISH_WEIGHTS: Record<string, number> = {
  'rate hike': -28,
  'rate hikes': -28,
  hawkish: -24,
  'etf outflow': -28,
  'etf outflows': -28,
  outflows: -22,
  outflow: -20,
  crash: -28,
  crashes: -28,
  plunge: -26,
  plunges: -26,
  plunged: -26,
  tumble: -24,
  tumbles: -24,
  slump: -22,
  slumps: -22,
  'sell-off': -24,
  selloff: -24,
  liquidation: -22,
  liquidations: -24,
  liquidated: -22,
  hack: -30,
  hacked: -30,
  exploit: -28,
  exploited: -28,
  breach: -24,
  bankruptcy: -30,
  insolvent: -28,
  lawsuit: -22,
  sued: -22,
  crackdown: -24,
  ban: -24,
  banned: -24,
  tariff: -18,
  tariffs: -18,
  recession: -24,
  inflation: -12,
  'hotter cpi': -24,
  bearish: -26,
  drop: -18,
  drops: -18,
  dropped: -18,
  fall: -16,
  falls: -16,
  fell: -16,
  decline: -16,
  declines: -16,
  fear: -18,
  panic: -24,
  warning: -16,
  risk: -10,
  pressure: -14,
  weakness: -18,
  delay: -16,
  delayed: -16,
  rejected: -24,
  rejection: -22,
  fraud: -26,
  default: -26,
  tightening: -22,
};

const NEGATIONS = new Set([
  'not',
  'no',
  'never',
  'without',
  'avoids',
  'avoid',
  'fails',
  'unlikely',
  'despite',
  'less',
  'halts',
]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectTopics(textLower: string, category: 'crypto' | 'macro'): NewsTopic[] {
  const topics = new Set<NewsTopic>();
  if (/\b(bitcoin|btc|satoshi|halving|miner|miners)\b/.test(textLower)) topics.add('BTC');
  if (/\b(ethereum|eth|ether|vitalik|l2|rollup|staking)\b/.test(textLower)) topics.add('ETH');
  if (
    category === 'macro' ||
    /\b(fed|fomc|powell|cpi|pce|inflation|treasury|yield|rates|gdp|jobs|payroll|tariff|macro|central bank|ecb|boj)\b/.test(
      textLower
    )
  ) {
    topics.add('MACRO');
  }
  if (/\b(etf|blackrock|fidelity|grayscale|spot etf|inflow|outflow)\b/.test(textLower)) {
    topics.add('ETF');
  }
  if (/\b(sec|cftc|regulation|regulator|congress|senate|lawsuit|mica|eu|court)\b/.test(textLower)) {
    topics.add('REG');
  }
  if (topics.size === 0) topics.add(category === 'macro' ? 'MACRO' : 'BTC');
  return Array.from(topics);
}

export function scoreHeadlineSentiment(
  title: string,
  summary = '',
  category: 'crypto' | 'macro' = 'crypto'
): {
  score: number;
  label: SentimentLabel;
  matchedTerms: string[];
  topics: NewsTopic[];
} {
  const titleLower = title.toLowerCase();
  const sumLower = summary.toLowerCase();
  const combined = `${titleLower} ${sumLower}`;

  let rawScore = 0;
  const matched = new Set<string>();

  const applyDict = (dict: Record<string, number>, text: string, weightMult: number) => {
    const tokens = text.split(/[^a-z0-9-]+/).filter(Boolean);
    for (const [phrase, pts] of Object.entries(dict)) {
      const re = new RegExp(`\\b${escapeRegex(phrase)}\\b`, 'i');
      const m = re.exec(text);
      if (!m) continue;

      // Check 2 words preceding match for negation
      const prefixWords = text
        .slice(0, m.index)
        .split(/[^a-z0-9-]+/)
        .filter(Boolean)
        .slice(-2);
      const negated = prefixWords.some((w) => NEGATIONS.has(w)) || (tokens.length === 0 && false);
      const contribution = pts * weightMult * (negated ? -0.65 : 1);
      rawScore += contribution;
      matched.add(negated ? `no-${phrase}` : phrase);
    }
  };

  applyDict(BULLISH_WEIGHTS, titleLower, 1.45);
  applyDict(BEARISH_WEIGHTS, titleLower, 1.45);
  applyDict(BULLISH_WEIGHTS, sumLower, 0.75);
  applyDict(BEARISH_WEIGHTS, sumLower, 0.75);

  const clamped = Math.round(Math.max(-100, Math.min(100, rawScore)));
  const label: SentimentLabel =
    clamped >= 14 ? 'Alcista' : clamped <= -14 ? 'Bajista' : 'Neutral';

  return {
    score: clamped,
    label,
    matchedTerms: Array.from(matched).slice(0, 6),
    topics: detectTopics(combined, category),
  };
}

export function computePearsonCorrelation(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 4) return null;

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  if (!Number.isFinite(den) || den <= 1e-12) return null;
  return Math.max(-1, Math.min(1, num / den));
}

function findCandleIndexAtOrBefore(candles: Candle[], ts: number): number {
  if (candles.length === 0) return -1;
  if (ts < candles[0].t) return -1;
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t <= ts) lo = mid + 1;
    else hi = mid - 1;
  }
  return hi;
}

export function correlateNewsWithPriceAction(
  rawItems: RawNewsHeadline[],
  candles1h: Candle[],
  macroEvents: MacroEvent[],
  nowMs = Date.now()
): NewsCorrelationSummary {
  const sortedCandles = [...candles1h].sort((a, b) => a.t - b.t);
  const latestCandle = sortedCandles[sortedCandles.length - 1] ?? null;
  const latestClose = latestCandle?.c ?? null;

  const pearson1hXs: number[] = [];
  const pearson1hYs: number[] = [];
  const pearson4hXs: number[] = [];
  const pearson4hYs: number[] = [];

  let directionalEvalCount = 0;
  let directionalHitCount = 0;
  const bullish4hMoves: number[] = [];
  const bearish4hMoves: number[] = [];

  const enriched: EnrichedNewsHeadline[] = rawItems.map((item) => {
    const sent = scoreHeadlineSentiment(item.title, item.summary, item.category);

    // Nearest macro event within ±24h
    let nearMacroEvent: string | null = null;
    let bestMacroDiff = Infinity;
    for (const ev of macroEvents) {
      const diff = Math.abs(ev.ts - item.pubTs);
      if (diff <= 24 * 3600_000 && diff < bestMacroDiff) {
        bestMacroDiff = diff;
        nearMacroEvent = ev.name;
      }
    }

    const baseIdx = findCandleIndexAtOrBefore(sortedCandles, item.pubTs);
    let priceAtPub: number | null = null;
    let ret1hPct: number | null = null;
    let ret4hPct: number | null = null;
    let retLatestPct: number | null = null;

    if (baseIdx >= 0 && sortedCandles[baseIdx].c > 0) {
      priceAtPub = sortedCandles[baseIdx].c;

      const idx1h = baseIdx + 1;
      if (idx1h < sortedCandles.length) {
        ret1hPct = ((sortedCandles[idx1h].c - priceAtPub) / priceAtPub) * 100;
        pearson1hXs.push(sent.score);
        pearson1hYs.push(ret1hPct);
      }

      const idx4h = Math.min(sortedCandles.length - 1, baseIdx + 4);
      if (idx4h > baseIdx) {
        ret4hPct = ((sortedCandles[idx4h].c - priceAtPub) / priceAtPub) * 100;
        if (baseIdx + 4 < sortedCandles.length) {
          pearson4hXs.push(sent.score);
          pearson4hYs.push(ret4hPct);
        }
      }

      if (latestClose !== null && priceAtPub > 0) {
        retLatestPct = ((latestClose - priceAtPub) / priceAtPub) * 100;
      }
    }

    const evalMove = ret4hPct ?? ret1hPct ?? retLatestPct;
    let alignment: PriceAlignmentStatus = 'Neutro';
    if (nowMs - item.pubTs < 45 * 60_000 && evalMove === null) {
      alignment = 'Pendiente';
    } else if (sent.label !== 'Neutral' && evalMove !== null) {
      directionalEvalCount += 1;
      const moveMatch =
        (sent.label === 'Alcista' && evalMove >= 0.1) ||
        (sent.label === 'Bajista' && evalMove <= -0.1);
      const moveOpposite =
        (sent.label === 'Alcista' && evalMove <= -0.1) ||
        (sent.label === 'Bajista' && evalMove >= 0.1);
      if (moveMatch) {
        alignment = 'Confirmado';
        directionalHitCount += 1;
      } else if (moveOpposite) {
        alignment = 'Divergente';
      } else {
        alignment = 'Neutro';
      }

      if (sent.label === 'Alcista') bullish4hMoves.push(evalMove);
      if (sent.label === 'Bajista') bearish4hMoves.push(evalMove);
    }

    return {
      ...item,
      sentimentScore: sent.score,
      sentimentLabel: sent.label,
      matchedTerms: sent.matchedTerms,
      topics: sent.topics,
      priceAtPub,
      ret1hPct,
      ret4hPct,
      retLatestPct,
      alignment,
      nearMacroEvent,
    };
  });

  // Aggregate time-decayed sentiment (half-life ~ 18h)
  let weightedSum = 0;
  let weightTotal = 0;
  let bullishCount = 0;
  let bearishCount = 0;
  let neutralCount = 0;

  for (const h of enriched) {
    if (h.sentimentLabel === 'Alcista') bullishCount++;
    else if (h.sentimentLabel === 'Bajista') bearishCount++;
    else neutralCount++;

    const ageHours = Math.max(0, (nowMs - h.pubTs) / 3600_000);
    if (ageHours <= 72) {
      const w = Math.exp(-ageHours / 24);
      weightedSum += h.sentimentScore * w;
      weightTotal += w;
    }
  }

  const aggregateScore = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 0;
  const aggregateLabel: SentimentLabel =
    aggregateScore >= 12 ? 'Alcista' : aggregateScore <= -12 ? 'Bajista' : 'Neutral';

  const pearson1h = computePearsonCorrelation(pearson1hXs, pearson1hYs);
  const pearson4h = computePearsonCorrelation(pearson4hXs, pearson4hYs);
  const directionalHitRatePct =
    directionalEvalCount > 0 ? (directionalHitCount / directionalEvalCount) * 100 : null;

  const avgBullishMovePct =
    bullish4hMoves.length > 0
      ? bullish4hMoves.reduce((s, v) => s + v, 0) / bullish4hMoves.length
      : null;
  const avgBearishMovePct =
    bearish4hMoves.length > 0
      ? bearish4hMoves.reduce((s, v) => s + v, 0) / bearish4hMoves.length
      : null;

  // Build 72h hourly timeline pairing 1H candles with headlines published in that hour
  const hourBuckets = new Map<number, EnrichedNewsHeadline[]>();
  for (const h of enriched) {
    const hourTs = Math.floor(h.pubTs / 3600_000) * 3600_000;
    const arr = hourBuckets.get(hourTs);
    if (arr) arr.push(h);
    else hourBuckets.set(hourTs, [h]);
  }

  const recentCandles = sortedCandles.slice(-72);
  const timeline: SentimentTimelinePoint[] = recentCandles.map((c, idx) => {
    const prevClose = idx > 0 ? recentCandles[idx - 1].c : c.o;
    const hourlyRetPct = prevClose > 0 ? ((c.c - prevClose) / prevClose) * 100 : 0;
    const hourTs = Math.floor(c.t / 3600_000) * 3600_000;
    const items = hourBuckets.get(hourTs) ?? [];
    const sentimentAvg =
      items.length > 0
        ? items.reduce((s, x) => s + x.sentimentScore, 0) / items.length
        : null;
    const topItem =
      items.length > 0
        ? items.reduce((best, x) =>
            Math.abs(x.sentimentScore) > Math.abs(best.sentimentScore) ? x : best
          )
        : null;

    return {
      t: c.t,
      close: c.c,
      hourlyRetPct,
      sentimentAvg,
      headlineCount: items.length,
      topTitle: topItem ? topItem.title : null,
    };
  });

  let regimeSummary = 'Muestra insuficiente para medir correlación estadística.';
  const activeR = pearson4h ?? pearson1h;
  if (activeR !== null) {
    if (activeR >= 0.3) {
      regimeSummary = `Correlación positiva (${activeR.toFixed(2)}): el precio está reaccionando a favor del tono de los titulares.`;
    } else if (activeR <= -0.3) {
      regimeSummary = `Correlación inversa (${activeR.toFixed(2)}): el mercado está desvaneciendo noticias ("buy the rumor / sell the news").`;
    } else {
      regimeSummary = `Correlación débil (${activeR.toFixed(2)}): el precio se mueve más por flujos técnicos/derivados que por titulares.`;
    }
  }

  return {
    headlines: enriched,
    aggregateScore,
    aggregateLabel,
    bullishCount,
    bearishCount,
    neutralCount,
    pearson1h,
    pearson4h,
    directionalHitRatePct,
    evaluatedCount: directionalEvalCount,
    avgBullishMovePct,
    avgBearishMovePct,
    timeline,
    regimeSummary,
  };
}

export type Rolling30dCorrelationPoint = {
  dateKey: string;
  ts: number;
  rBtc: number | null;
  rEth: number | null;
  intensity: number; // 0..100 composite macro/news sentiment intensity
  btcVolPct: number | null;
  ethVolPct: number | null;
  macroEventsOnDay: string[];
  newsCountOnDay: number;
};

export type CorrelationWindowDays = 7 | 14 | 30;

export type Rolling30dCorrelationSummary = {
  windowDays: number;
  series: Rolling30dCorrelationPoint[];
  latestRBtc: number | null;
  latestREth: number | null;
  delta7dRBtc: number | null;
  delta7dREth: number | null;
  avgBtcVol30d: number | null;
  avgEthVol30d: number | null;
  latestIntensity: number;
  regimeLabel: string;
};

function toUtcDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function dailyCandleVolatilityPct(c: Candle): number {
  if (c.o <= 0 || c.c <= 0) return 0;
  const rangePct = ((c.h - c.l) / c.o) * 100;
  const absBodyPct = (Math.abs(c.c - c.o) / c.o) * 100;
  return Math.max(rangePct, absBodyPct);
}

/**
 * Computes a rolling 30-day Pearson correlation coefficient between daily
 * macro-event + news-sentiment intensity (0..100) and BTC / ETH realized daily volatility (%).
 */
export function calculateRolling30dVolMacroCorrelation(params: {
  btcDaily: Candle[];
  ethDaily: Candle[];
  headlines: RawNewsHeadline[];
  macroEvents: MacroEvent[];
  dailySentiment: { ts: number; value: number }[];
  windowDays?: number;
}): Rolling30dCorrelationSummary {
  const { btcDaily, ethDaily, headlines, macroEvents, dailySentiment, windowDays = 30 } = params;

  const btcSorted = [...btcDaily].sort((a, b) => a.t - b.t);
  const ethMap = new Map<string, Candle>();
  for (const c of ethDaily) {
    ethMap.set(toUtcDateKey(c.t), c);
  }

  // Group daily FNG sentiment values by UTC date
  const fngMap = new Map<string, number>();
  for (const pt of [...dailySentiment].sort((a, b) => a.ts - b.ts)) {
    fngMap.set(toUtcDateKey(pt.ts), pt.value);
  }

  // Group macro events by UTC date (and track +/- 1 day proximity)
  const eventExactMap = new Map<string, string[]>();
  const eventProximitySet = new Set<string>();
  for (const ev of macroEvents) {
    const dk = ev.date || toUtcDateKey(ev.ts);
    const arr = eventExactMap.get(dk) ?? [];
    arr.push(ev.name);
    eventExactMap.set(dk, arr);

    const prevKey = toUtcDateKey(ev.ts - 24 * 3600_000);
    const nextKey = toUtcDateKey(ev.ts + 24 * 3600_000);
    eventProximitySet.add(prevKey);
    eventProximitySet.add(nextKey);
  }

  // Group news headlines by UTC date
  const newsByDay = new Map<string, { absScores: number[]; macroCount: number }>();
  for (const h of headlines) {
    const dk = toUtcDateKey(h.pubTs);
    const s = scoreHeadlineSentiment(h.title, h.summary, h.category);
    const entry = newsByDay.get(dk) ?? { absScores: [], macroCount: 0 };
    entry.absScores.push(Math.abs(s.score));
    if (h.category === 'macro' || s.topics.includes('MACRO')) {
      entry.macroCount += 1;
    }
    newsByDay.set(dk, entry);
  }

  // Build aligned daily rows
  type DailyObs = {
    dateKey: string;
    ts: number;
    intensity: number;
    btcVolPct: number | null;
    ethVolPct: number | null;
    macroEventsOnDay: string[];
    newsCountOnDay: number;
  };

  const dailyObs: DailyObs[] = [];
  let prevFng: number | null = null;

  for (const btcC of btcSorted) {
    const dk = toUtcDateKey(btcC.t);
    const ethC = ethMap.get(dk);

    const btcVolPct = dailyCandleVolatilityPct(btcC);
    const ethVolPct = ethC ? dailyCandleVolatilityPct(ethC) : null;

    // 1. Sentiment extremity & day-over-day shift from 100d FNG series
    const fngVal: number | null = fngMap.get(dk) ?? prevFng;
    let fngComponent = 0;
    if (fngVal !== null) {
      const extremity = Math.abs(fngVal - 50) * 0.9; // 0..45
      const shift = prevFng !== null ? Math.abs(fngVal - prevFng) * 2.2 : 0;
      fngComponent = Math.min(55, extremity + shift);
      prevFng = fngVal;
    }

    // 2. Macro calendar impulse (exact day + proximity window)
    const exactEvs = eventExactMap.get(dk) ?? [];
    const macroImpulse =
      exactEvs.length > 0 ? Math.min(35, 22 + (exactEvs.length - 1) * 10) : eventProximitySet.has(dk) ? 10 : 0;

    // 3. News sentiment intensity & Fed macro press releases on day
    const dayNews = newsByDay.get(dk);
    let newsImpulse = 0;
    if (dayNews && dayNews.absScores.length > 0) {
      const avgAbs =
        dayNews.absScores.reduce((s, v) => s + v, 0) / dayNews.absScores.length;
      const macroBoost = Math.min(18, dayNews.macroCount * 8);
      newsImpulse = Math.min(35, avgAbs * 0.45 + macroBoost);
    }

    const intensity = Math.round(Math.min(100, fngComponent + macroImpulse + newsImpulse));

    dailyObs.push({
      dateKey: dk,
      ts: btcC.t,
      intensity,
      btcVolPct,
      ethVolPct,
      macroEventsOnDay: exactEvs,
      newsCountOnDay: dayNews?.absScores.length ?? 0,
    });
  }

  // Compute rolling Pearson r for each day i >= windowDays - 1
  const minPairs = Math.max(4, Math.min(12, Math.ceil(windowDays * 0.6)));
  const series: Rolling30dCorrelationPoint[] = [];
  for (let i = windowDays - 1; i < dailyObs.length; i++) {
    const slice = dailyObs.slice(i - windowDays + 1, i + 1);
    const btcPairs = slice.filter((d) => d.btcVolPct !== null);
    const ethPairs = slice.filter((d) => d.ethVolPct !== null);

    const rBtc =
      btcPairs.length >= minPairs
        ? computePearsonCorrelation(
            btcPairs.map((d) => d.intensity),
            btcPairs.map((d) => d.btcVolPct as number)
          )
        : null;

    const rEth =
      ethPairs.length >= minPairs
        ? computePearsonCorrelation(
            ethPairs.map((d) => d.intensity),
            ethPairs.map((d) => d.ethVolPct as number)
          )
        : null;

    const cur = dailyObs[i];
    series.push({
      dateKey: cur.dateKey,
      ts: cur.ts,
      rBtc,
      rEth,
      intensity: cur.intensity,
      btcVolPct: cur.btcVolPct,
      ethVolPct: cur.ethVolPct,
      macroEventsOnDay: cur.macroEventsOnDay,
      newsCountOnDay: cur.newsCountOnDay,
    });
  }

  const latest = series[series.length - 1] ?? null;
  const prev7d = series.length >= 8 ? series[series.length - 8] : null;

  const latestRBtc = latest?.rBtc ?? null;
  const latestREth = latest?.rEth ?? null;
  const delta7dRBtc =
    latestRBtc !== null && prev7d?.rBtc !== null && prev7d?.rBtc !== undefined
      ? latestRBtc - prev7d.rBtc
      : null;
  const delta7dREth =
    latestREth !== null && prev7d?.rEth !== null && prev7d?.rEth !== undefined
      ? latestREth - prev7d.rEth
      : null;

  const last30Obs = dailyObs.slice(-windowDays);
  const btcVols = last30Obs.map((d) => d.btcVolPct).filter((v): v is number => v !== null);
  const ethVols = last30Obs.map((d) => d.ethVolPct).filter((v): v is number => v !== null);

  const avgBtcVol30d =
    btcVols.length > 0 ? btcVols.reduce((s, v) => s + v, 0) / btcVols.length : null;
  const avgEthVol30d =
    ethVols.length > 0 ? ethVols.reduce((s, v) => s + v, 0) / ethVols.length : null;

  const primaryR = latestRBtc ?? latestREth;
  let regimeLabel = 'Muestra insuficiente';
  if (primaryR !== null) {
    if (primaryR >= 0.35) {
      regimeLabel = 'Acoplamiento Fuerte (+) · Macro/Noticias disparan volatilidad';
    } else if (primaryR >= 0.12) {
      regimeLabel = 'Acoplamiento Moderado (+)';
    } else if (primaryR <= -0.25) {
      regimeLabel = 'Correlación Inversa (-) · Compresión pese a titulares';
    } else {
      regimeLabel = 'Desacople / Régimen Técnico · Volatilidad independiente de noticias';
    }
  }

  return {
    windowDays,
    series,
    latestRBtc,
    latestREth,
    delta7dRBtc,
    delta7dREth,
    avgBtcVol30d,
    avgEthVol30d,
    latestIntensity: latest?.intensity ?? 0,
    regimeLabel,
  };
}
