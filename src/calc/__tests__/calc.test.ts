import { describe, expect, it } from 'vitest';
import { runBacktest } from '../backtest';
import { bsDeltaGamma } from '../blackScholes';
import { calculateExpectedRangeCone, calculateTouchProbability } from '../cone';
import { calculateHedgeFlowSeries, calculateOnePercentMoveImpact } from '../hedgeFlow';
import { calculateEMA, calculateVWAP } from '../indicators';
import { aggregateStrikes, calculateLevels } from '../options';
import type { BacktestParams, Candle, OptionRow } from '../../types/market';

describe('Options GEX, Flip & Max Pain calculations', () => {
  it('computes exact GEX per strike matching manual calculation for 3 strikes', () => {
    const spot = 60000;
    const mult = 0.01;
    // Strike 58000: Put heavy (negative GEX)
    // Strike 60000: Balanced (slightly positive)
    // Strike 62000: Call heavy (positive GEX)
    const options: OptionRow[] = [
      {
        instId: 'BTC-USD-261127-58000-P',
        expiry: '2026-11-27',
        expTs: 1800000000000,
        strike: 58000,
        type: 'P',
        oi: 1000,
        iv: 0.5,
        delta: -0.25,
        gamma: 0.00004,
        mult,
      },
      {
        instId: 'BTC-USD-261127-60000-C',
        expiry: '2026-11-27',
        expTs: 1800000000000,
        strike: 60000,
        type: 'C',
        oi: 500,
        iv: 0.5,
        delta: 0.5,
        gamma: 0.00006,
        mult,
      },
      {
        instId: 'BTC-USD-261127-60000-P',
        expiry: '2026-11-27',
        expTs: 1800000000000,
        strike: 60000,
        type: 'P',
        oi: 300,
        iv: 0.5,
        delta: -0.5,
        gamma: 0.00006,
        mult,
      },
      {
        instId: 'BTC-USD-261127-62000-C',
        expiry: '2026-11-27',
        expTs: 1800000000000,
        strike: 62000,
        type: 'C',
        oi: 1200,
        iv: 0.5,
        delta: 0.28,
        gamma: 0.000045,
        mult,
      },
    ];

    const strikes = aggregateStrikes(options, spot, 'ALL');
    expect(strikes).toHaveLength(3);

    // Manual GEX_58000 = -0.00004 * 1000 * 0.01 * 60000^2 * 0.01 = -14400
    expect(strikes[0].gex).toBeCloseTo(-14400, 4);
    // Manual GEX_60000 = (0.00006 * 500 - 0.00006 * 300) * 0.01 * 60000^2 * 0.01 = 4320
    expect(strikes[1].gex).toBeCloseTo(4320, 4);
    // Manual GEX_62000 = 0.000045 * 1200 * 0.01 * 60000^2 * 0.01 = 19440
    expect(strikes[2].gex).toBeCloseTo(19440, 4);

    // Cumulative GEX:
    // K=58000: -14400
    // K=60000: -14400 + 4320 = -10080
    // K=62000: -10080 + 19440 = +9360 -> crosses 0 between 60000 and 62000!
    const levels = calculateLevels(strikes, options, spot);
    expect(levels.flip).not.toBeNull();
    expect(levels.flip!).toBeGreaterThan(60000);
    expect(levels.flip!).toBeLessThan(62000);
    const expectedFlip = 60000 + (10080 / (10080 + 9360)) * 2000;
    expect(levels.flip!).toBeCloseTo(expectedFlip, 4);

    // Max Pain manual payout check:
    // At K=58000: Put(58k)=0, Call(60k)=0, Put(60k)=300*0.01*2000=6000, Call(62k)=0 => 6000
    // At K=60000: Put(58k)=0, Call(60k)=0, Put(60k)=0, Call(62k)=0 => 0 (minimum!)
    // At K=62000: Call(60k)=500*0.01*2000=10000 => 10000
    expect(levels.maxPain).toBe(60000);
    expect(levels.callWall).toBe(62000);
    expect(levels.putWall).toBe(58000);
  });
});

describe('Indicators & Cone calculations', () => {
  it('resets VWAP daily at 00:00 UTC', () => {
    const day1 = Date.UTC(2026, 10, 18, 23, 45, 0);
    const day2 = Date.UTC(2026, 10, 19, 0, 0, 0);
    const candles: Candle[] = [
      { t: day1, o: 100, h: 100, l: 100, c: 100, v: 10 },
      { t: day2, o: 200, h: 200, l: 200, c: 200, v: 5 },
    ];
    const vwap = calculateVWAP(candles);
    expect(vwap[0]).toBeCloseTo(100, 6);
    expect(vwap[1]).toBeCloseTo(200, 6);
  });

  it('computes EMA correctly', () => {
    const ema = calculateEMA([10, 12, 14, 16, 18], 3);
    expect(ema[0]).toBeNull();
    expect(ema[1]).toBeNull();
    expect(ema[2]).toBeCloseTo(12, 6); // SMA(10,12,14) = 12
    // k = 2/(3+1) = 0.5 => 16*0.5 + 12*0.5 = 14
    expect(ema[3]).toBeCloseTo(14, 6);
    expect(ema[4]).toBeCloseTo(16, 6);
  });

  it('computes expected range cone and reflection touch probability', () => {
    const now = Date.UTC(2026, 10, 19, 0, 0, 0);
    const exp = now + 30 * 24 * 60 * 60 * 1000;
    const cone = calculateExpectedRangeCone(60000, 0.5, now, exp, '2026-12-19', 60000, 10);
    expect(cone.endpoints.upper95).toBeGreaterThan(cone.endpoints.upper80);
    expect(cone.endpoints.upper80).toBeGreaterThan(cone.endpoints.upper50);
    expect(cone.endpoints.lower50).toBeGreaterThan(cone.endpoints.lower80);
    expect(cone.endpoints.lower80).toBeGreaterThan(cone.endpoints.lower95);

    const pAtSpot = calculateTouchProbability(60000, 60000, 0.5, 30 / 365);
    expect(pAtSpot).toBeCloseTo(1, 6);
    const pFar = calculateTouchProbability(60000, 90000, 0.5, 30 / 365);
    expect(pFar).toBeLessThan(0.1);
  });
});

describe('Dealer Hedge Flow & Black-Scholes', () => {
  it('computes hedge flow with opposite sign to price change when netGamma > 0', () => {
    const candles: Candle[] = [
      { t: 1000, o: 60000, h: 60000, l: 60000, c: 60000, v: 1 },
      { t: 2000, o: 60000, h: 60600, l: 60000, c: 60600, v: 1 },
    ];
    const flow = calculateHedgeFlowSeries(candles, 0.5);
    expect(flow[1].flowCoins).toBeCloseTo(-300, 6);
    expect(flow[1].flowUsd).toBeCloseTo(-300 * 60600, 2);

    const bs = bsDeltaGamma(60000, 60000, 30 / 365, 0.5, 'C');
    expect(bs.delta).toBeGreaterThan(0.5);
    expect(bs.gamma).toBeGreaterThan(0);

    const impact = calculateOnePercentMoveImpact(
      [
        {
          instId: 'BTC-USD-261219-60000-C',
          expiry: '2026-12-19',
          expTs: Date.now() + 30 * 86400_000,
          strike: 60000,
          type: 'C',
          oi: 1000,
          iv: 0.5,
          delta: bs.delta,
          gamma: bs.gamma,
          mult: 0.01,
        },
      ],
      60000,
      100000
    );
    expect(impact.regime).toBe('dampen');
    expect(impact.down1PctUsd).toBeGreaterThan(0); // dealers buy on -1% drop
    expect(impact.up1PctUsd).toBeLessThan(0); // dealers sell on +1% rally
  });
});

describe('Backtesting engine (causal t+1 execution, fees & 3 manual trades)', () => {
  it('executes signals at t+1 open without look-ahead bias and reduces profit when commission increases', () => {
    // 15 candles designed to produce clear Momentum (N=2) entry & exit signals
    const baseTs = Date.UTC(2026, 10, 1, 0, 0, 0);
    const closes = [100, 100, 100, 105, 110, 115, 112, 108, 105, 110, 120, 125, 120, 110, 110];
    const candles: Candle[] = closes.map((c, idx) => ({
      t: baseTs + idx * 3600_000,
      o: idx === 0 ? c : closes[idx - 1],
      h: Math.max(c, idx === 0 ? c : closes[idx - 1]) + 1,
      l: Math.min(c, idx === 0 ? c : closes[idx - 1]) - 1,
      c,
      v: 10,
    }));

    const baseParams: BacktestParams = {
      template: 'momentum',
      instId: 'BTC-USDT-SWAP',
      timeframe: '1H',
      startDate: '2026-11-01',
      endDate: '2026-11-02',
      initialCapital: 10000,
      positionSizePct: 100,
      commissionPct: 0.1,
      slippagePct: 0,
      stopPct: null,
      targetR: null,
      emaFast: 9,
      emaSlow: 21,
      momentumBars: 2,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiExit: 50,
      rsiShortSymmetric: false,
      bbPeriod: 20,
      bbStdDev: 2,
    };

    const resLowFee = runBacktest(candles, baseParams);
    const resHighFee = runBacktest(candles, { ...baseParams, commissionPct: 1.0 });

    // Bar 3 close=105 > bar 1 close=100 => signal at bar 3 close -> enters at bar 4 OPEN (= 105)!
    expect(resLowFee.orders.length).toBeGreaterThanOrEqual(2);
    expect(resLowFee.orders[0].ts).toBe(candles[4].t);
    expect(resLowFee.orders[0].price).toBeCloseTo(candles[4].o, 6);

    // Increasing commission strictly reduces final equity by fee drag
    expect(resHighFee.totalMetrics.finalEquity).toBeLessThan(resLowFee.totalMetrics.finalEquity);
  });
});

describe('Skew-aware Cone, Term Structure & Sensitivity Sweep', () => {
  it('interpolates volatility skew across strikes and produces asymmetric cone bands', async () => {
    const { getStrikeIV } = await import('../cone');
    const { calculateTermStructure } = await import('../options');
    const now = Date.UTC(2026, 10, 19, 0, 0, 0);
    const exp1 = now + 10 * 86400_000;
    const exp2 = now + 30 * 86400_000;
    const d1 = new Date(exp1).toISOString().slice(0, 10);
    const d2 = new Date(exp2).toISOString().slice(0, 10);

    const opts: OptionRow[] = [
      { instId: 'P50', expiry: d1, expTs: exp1, strike: 50000, type: 'P', oi: 100, iv: 0.8, delta: -0.2, gamma: 0.00001, mult: 0.01 },
      { instId: 'P60', expiry: d1, expTs: exp1, strike: 60000, type: 'P', oi: 100, iv: 0.5, delta: -0.5, gamma: 0.00002, mult: 0.01 },
      { instId: 'C70', expiry: d1, expTs: exp1, strike: 70000, type: 'C', oi: 100, iv: 0.4, delta: 0.2, gamma: 0.00001, mult: 0.01 },
      { instId: 'C60_2', expiry: d2, expTs: exp2, strike: 60000, type: 'C', oi: 100, iv: 0.45, delta: 0.5, gamma: 0.00001, mult: 0.01 },
    ];

    expect(getStrikeIV(opts, 60000, d1, 55000)).toBeCloseTo(0.65, 4);
    expect(getStrikeIV(opts, 60000, d1, 65000)).toBeCloseTo(0.45, 4);

    const cone = calculateExpectedRangeCone(60000, 0.5, now, exp1, d1, 60000, 10, opts);
    expect(cone.downsideIV).toBeGreaterThan(cone.upsideIV);
    expect(60000 - cone.endpoints.lower95).toBeGreaterThan(cone.endpoints.upper95 - 60000);

    const ts = calculateTermStructure(opts, 60000, now);
    expect(ts).toHaveLength(2);
    expect(ts[0].atmIvPct).toBeCloseTo(50, 4);
    expect(ts[1].atmIvPct).toBeCloseTo(45, 4);
  });

  it('produces a 5x5 sensitivity sweep matrix with in-sample and out-of-sample metrics', async () => {
    const { runSensitivitySweep } = await import('../backtest');
    const baseTs = Date.UTC(2026, 10, 1, 0, 0, 0);
    const candles: Candle[] = Array.from({ length: 80 }, (_, idx) => {
      const c = 60000 + Math.sin(idx / 5) * 1500 + idx * 15;
      return { t: baseTs + idx * 3600_000, o: c - 20, h: c + 50, l: c - 50, c, v: 10 };
    });
    const params: BacktestParams = {
      template: 'ema_cross',
      instId: 'BTC-USDT-SWAP',
      timeframe: '1H',
      startDate: '2026-11-01',
      endDate: '2026-11-05',
      initialCapital: 10000,
      positionSizePct: 100,
      commissionPct: 0.05,
      slippagePct: 0.02,
      stopPct: null,
      targetR: null,
      emaFast: 9,
      emaSlow: 21,
      momentumBars: 10,
      rsiPeriod: 14,
      rsiOversold: 30,
      rsiExit: 50,
      rsiShortSymmetric: false,
      bbPeriod: 20,
      bbStdDev: 2,
    };
    const grid = runSensitivitySweep(candles, params);
    expect(grid.cells).toHaveLength(5);
    expect(grid.cells[0]).toHaveLength(5);
  });
});

describe('Market Liquidity Levels & Trading Options Generator', () => {
  it('analyzes orderbook/swing liquidity and builds valid LONG/SHORT setups with exact risk sizing', async () => {
    const { analyzeMarketLiquidity } = await import('../liquidity');
    const { generateTradingOptions } = await import('../tradeSetups');

    const baseTs = Date.UTC(2026, 10, 1, 0, 0, 0);
    // Construct 40 candles with clear swing highs (~63000) and swing lows (~59000)
    const candles: Candle[] = Array.from({ length: 40 }, (_, i) => {
      const wave = Math.sin(i / 3) * 1400;
      const c = 61000 + wave + i * 20;
      return { t: baseTs + i * 3600_000, o: c - 40, h: c + 250, l: c - 250, c, v: 120 + i * 2 };
    });
    const spot = candles[candles.length - 1].c;

    const liq = analyzeMarketLiquidity(
      candles,
      spot,
      { flip: 61000, maxPain: 62500, callWall: 64000, putWall: 59000, netGex: 150000, netGamma: 0.4 },
      {
        bestBid: spot - 1,
        bestAsk: spot + 1,
        spreadPct: 0.003,
        bidTotalUsd: 4_500_000,
        askTotalUsd: 3_100_000,
        imbalancePct: 18.4,
        ts: Date.now(),
        walls: [
          { price: spot + 1200, sizeCoins: 42, notionalUsd: 2_600_000, distancePct: 1.9, side: 'ask' },
          { price: spot - 1100, sizeCoins: 55, notionalUsd: 3_300_000, distancePct: -1.8, side: 'bid' },
        ],
      },
      63500,
      59200
    );

    expect(liq.strongestAskWall?.price).toBeCloseTo(spot + 1200, 1);
    expect(liq.strongestBidWall?.price).toBeCloseTo(spot - 1100, 1);
    expect(liq.pocPrice).not.toBeNull();

    const ideas = generateTradingOptions({
      asset: 'BTC',
      timeframe: '1H',
      candles,
      spot,
      optionsLevels: { flip: 61000, maxPain: 62500, callWall: 64000, putWall: 59000, netGex: 150000, netGamma: 0.4 },
      cone: null,
      liquidity: liq,
      capitalUsd: 20000,
      riskPct: 1.5, // $300 risk
    });

    expect(ideas).toHaveLength(3);
    for (const idea of ideas) {
      expect(idea.riskUsd).toBeCloseTo(300, 1);
      expect(idea.quantity).toBeGreaterThan(0);
      if (idea.direction === 'LONG') {
        expect(idea.stopLoss).toBeLessThan(idea.entry);
        expect(idea.takeProfit1).toBeGreaterThan(idea.entry);
        expect(idea.takeProfit2).toBeGreaterThan(idea.takeProfit1);
      } else {
        expect(idea.stopLoss).toBeGreaterThan(idea.entry);
        expect(idea.takeProfit1).toBeLessThan(idea.entry);
        expect(idea.takeProfit2).toBeLessThan(idea.takeProfit1);
      }
    }
  });
});
