import { describe, expect, it } from 'vitest';
import type { Candle, MacroEvent } from '../../types/market';
import {
  calculateRolling30dVolMacroCorrelation,
  computePearsonCorrelation,
  correlateNewsWithPriceAction,
  scoreHeadlineSentiment,
  type RawNewsHeadline,
} from '../newsSentiment';

function makeHourlyCandles(closes: number[], startTs: number): Candle[] {
  return closes.map((c, idx) => ({
    t: startTs + idx * 3600_000,
    o: idx > 0 ? closes[idx - 1] : c,
    h: c * 1.004,
    l: c * 0.996,
    c,
    v: 100,
  }));
}

describe('News Sentiment & Price Correlation Engine', () => {
  it('scores bullish and bearish headlines accurately and respects negations', () => {
    const bull = scoreHeadlineSentiment(
      'Bitcoin surges to breakout as spot ETF inflows accelerate',
      'Institutional accumulation drives market rally',
      'crypto'
    );
    expect(bull.label).toBe('Alcista');
    expect(bull.score).toBeGreaterThan(30);
    expect(bull.topics).toContain('BTC');
    expect(bull.topics).toContain('ETF');

    const bear = scoreHeadlineSentiment(
      'Crypto market plunges amid hawkish Fed rate hike fear and ETF outflows',
      'Major exchange liquidation pressure',
      'macro'
    );
    expect(bear.label).toBe('Bajista');
    expect(bear.score).toBeLessThan(-30);
    expect(bear.topics).toContain('MACRO');

    const negated = scoreHeadlineSentiment(
      'Bitcoin not rally and fails surge expectations',
      '',
      'crypto'
    );
    expect(negated.score).toBeLessThan(0);
  });

  it('computes Pearson correlation and directional hit rate against 1H price action', () => {
    const startTs = Date.UTC(2026, 10, 20, 0, 0, 0);
    // Hours 0..3: flat; Hours 4..8: rally (+5%); Hours 9..14: drop (-5%); Hours 15..20: rally (+4%)
    const closes = [
      90000, 90050, 90000, 90000, // 0..3
      91000, 92200, 93400, 94500, 94600, // 4..8 (+5%)
      93500, 92000, 90800, 89900, 89800, // 9..13 (-5%)
      90400, 91600, 92800, 93600, 93900, // 14..18 (+4.5%)
    ];
    const candles = makeHourlyCandles(closes, startTs);

    const items: RawNewsHeadline[] = [
      {
        id: 'n1',
        title: 'Bitcoin breakout rally on strong institutional ETF inflows',
        summary: '',
        link: 'https://example.com/1',
        source: 'CoinDesk',
        sourceId: 'coindesk',
        category: 'crypto',
        pubTs: startTs + 3 * 3600_000 + 15 * 60_000,
        pubIso: new Date(startTs + 3 * 3600_000).toISOString(),
      },
      {
        id: 'n2',
        title: 'Hawkish Fed warning triggers Bitcoin crash and ETF outflows',
        summary: '',
        link: 'https://example.com/2',
        source: 'Federal Reserve',
        sourceId: 'fed',
        category: 'macro',
        pubTs: startTs + 8 * 3600_000 + 10 * 60_000,
        pubIso: new Date(startTs + 8 * 3600_000).toISOString(),
      },
      {
        id: 'n3',
        title: 'Ethereum and Bitcoin rebound cleanly after cooling inflation approval',
        summary: '',
        link: 'https://example.com/3',
        source: 'Blockworks',
        sourceId: 'blockworks',
        category: 'crypto',
        pubTs: startTs + 13 * 3600_000 + 10 * 60_000,
        pubIso: new Date(startTs + 13 * 3600_000).toISOString(),
      },
      {
        id: 'n4',
        title: 'Major exploit and SEC lawsuit spark crypto sell-off panic',
        summary: '',
        link: 'https://example.com/4',
        source: 'Decrypt',
        sourceId: 'decrypt',
        category: 'crypto',
        pubTs: startTs + 9 * 3600_000 + 20 * 60_000,
        pubIso: new Date(startTs + 9 * 3600_000).toISOString(),
      },
    ];

    const events: MacroEvent[] = [
      { id: 'ev1', date: '2026-11-20', timeUtc: '08:00', name: 'CPI', ts: startTs + 8 * 3600_000 },
    ];

    const res = correlateNewsWithPriceAction(items, candles, events, startTs + 18 * 3600_000);
    expect(res.headlines).toHaveLength(4);
    expect(res.pearson4h).not.toBeNull();
    expect(res.pearson4h!).toBeGreaterThan(0.75);
    expect(res.directionalHitRatePct).toBe(100);
    expect(res.avgBullishMovePct!).toBeGreaterThan(0);
    expect(res.avgBearishMovePct!).toBeLessThan(0);
    expect(res.headlines[1].nearMacroEvent).toBe('CPI');
  });

  it('returns null Pearson correlation when fewer than 4 samples exist', () => {
    expect(computePearsonCorrelation([1, 2, 3], [1, 2, 3])).toBeNull();
  });

  it('computes rolling 30-day Pearson correlation between macro/sentiment intensity and BTC/ETH volatility', () => {
    const baseDayTs = Date.UTC(2026, 9, 1, 0, 0, 0);
    const totalDays = 46;
    const btcDaily: Candle[] = [];
    const ethDaily: Candle[] = [];
    const dailySentiment: { ts: number; value: number }[] = [];
    const macroEvents: MacroEvent[] = [];
    const headlines: RawNewsHeadline[] = [];

    for (let i = 0; i < totalDays; i++) {
      const ts = baseDayTs + i * 86_400_000;
      const dateStr = new Date(ts).toISOString().slice(0, 10);
      const isShock = i % 6 === 0;
      const btcMove = isShock ? 0.065 : 0.011;
      const ethMove = isShock ? 0.085 : 0.014;

      btcDaily.push({
        t: ts,
        o: 90000,
        h: 90000 * (1 + btcMove),
        l: 90000 * (1 - btcMove * 0.2),
        c: 90000 * (1 + btcMove * 0.5),
        v: 1000,
      });
      ethDaily.push({
        t: ts,
        o: 3000,
        h: 3000 * (1 + ethMove),
        l: 3000 * (1 - ethMove * 0.2),
        c: 3000 * (1 + ethMove * 0.5),
        v: 2000,
      });

      dailySentiment.push({
        ts,
        value: isShock ? 18 : 52,
      });

      if (isShock) {
        macroEvents.push({
          id: `m-${i}`,
          date: dateStr,
          timeUtc: '13:30',
          name: 'FOMC / CPI',
          ts: ts + 13 * 3600_000,
        });
        headlines.push({
          id: `h-${i}`,
          title: 'Fed hawkish inflation warning sparks crypto crash panic',
          summary: '',
          link: `https://example.com/${i}`,
          source: 'Federal Reserve',
          sourceId: 'fed',
          category: 'macro',
          pubTs: ts + 14 * 3600_000,
          pubIso: new Date(ts + 14 * 3600_000).toISOString(),
        });
      }
    }

    const summary = calculateRolling30dVolMacroCorrelation({
      btcDaily,
      ethDaily,
      headlines,
      macroEvents,
      dailySentiment,
      windowDays: 30,
    });

    expect(summary.series).toHaveLength(totalDays - 29);
    expect(summary.windowDays).toBe(30);
    expect(summary.latestRBtc).not.toBeNull();
    expect(summary.latestREth).not.toBeNull();
    expect(summary.latestRBtc!).toBeGreaterThan(0.5);
    expect(summary.latestREth!).toBeGreaterThan(0.5);
    expect(summary.latestRBtc!).toBeLessThanOrEqual(1);
    expect(summary.avgBtcVol30d).toBeGreaterThan(0);
    expect(summary.avgEthVol30d).toBeGreaterThan(0);
    expect(summary.series.some((p) => p.macroEventsOnDay.length > 0)).toBe(true);

    const summary14 = calculateRolling30dVolMacroCorrelation({
      btcDaily,
      ethDaily,
      headlines,
      macroEvents,
      dailySentiment,
      windowDays: 14,
    });
    expect(summary14.windowDays).toBe(14);
    expect(summary14.series).toHaveLength(totalDays - 13);
    expect(summary14.latestRBtc).not.toBeNull();
    expect(summary14.latestRBtc!).toBeGreaterThan(0.5);

    const summary7 = calculateRolling30dVolMacroCorrelation({
      btcDaily,
      ethDaily,
      headlines,
      macroEvents,
      dailySentiment,
      windowDays: 7,
    });
    expect(summary7.windowDays).toBe(7);
    expect(summary7.series).toHaveLength(totalDays - 6);
    expect(summary7.latestRBtc).not.toBeNull();
    expect(summary7.latestREth).not.toBeNull();
    expect(summary7.latestRBtc!).toBeGreaterThan(0.4);
  });
});
