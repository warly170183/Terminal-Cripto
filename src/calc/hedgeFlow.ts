import type { Candle, OptionRow } from '../types/market';
import { bsDeltaGamma } from './blackScholes';

export type HedgeFlowPoint = {
  t: number;
  flowCoins: number;
  flowUsd: number;
};

export type OnePercentImpact = {
  regime: 'dampen' | 'chase';
  down1PctUsd: number; // signed: + = dealers buy, - = dealers sell
  up1PctUsd: number; // signed: + = dealers buy, - = dealers sell
};

/**
 * Computes per-candle dealer delta-hedging flow:
 *   H_t = - Gamma_net * (S_t - S_{t-1})
 * Uses current netGamma across the whole visible series (no historical OI available).
 * Positive H_t => dealers buy (green bar), Negative H_t => dealers sell (red bar).
 */
export function calculateHedgeFlowSeries(candles: Candle[], netGamma: number): HedgeFlowPoint[] {
  if (candles.length === 0) return [];
  const result: HedgeFlowPoint[] = [];

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      result.push({ t: candles[i].t, flowCoins: 0, flowUsd: 0 });
      continue;
    }
    const dS = candles[i].c - candles[i - 1].c;
    const flowCoins = -netGamma * dS;
    const flowUsd = flowCoins * candles[i].c;
    result.push({
      t: candles[i].t,
      flowCoins,
      flowUsd,
    });
  }

  return result;
}

/**
 * Evaluates net gamma at S * 0.99 and S * 1.01 across the active options chain
 * and computes the USD hedge flow for a -1% and +1% spot move.
 */
export function calculateOnePercentMoveImpact(
  options: OptionRow[],
  spot: number,
  netGex: number,
  nowMs = Date.now()
): OnePercentImpact {
  const regime: 'dampen' | 'chase' = netGex >= 0 ? 'dampen' : 'chase';
  if (spot <= 0 || options.length === 0) {
    return { regime, down1PctUsd: 0, up1PctUsd: 0 };
  }

  const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
  const sDown = spot * 0.99;
  const sUp = spot * 1.01;
  const dSDown = sDown - spot; // -0.01 * spot
  const dSUp = sUp - spot; // +0.01 * spot

  let gammaNetDown = 0;
  let gammaNetUp = 0;

  for (const opt of options) {
    if (opt.oi <= 0) continue;
    const T = Math.max(1e-5, (opt.expTs - nowMs) / MS_PER_YEAR);
    const iv = opt.iv > 0 ? opt.iv : 0.5;
    const coinOi = opt.oi * opt.mult;
    const sign = opt.type === 'C' ? 1 : -1;

    const gDown = bsDeltaGamma(sDown, opt.strike, T, iv, opt.type).gamma;
    const gUp = bsDeltaGamma(sUp, opt.strike, T, iv, opt.type).gamma;

    gammaNetDown += sign * gDown * coinOi;
    gammaNetUp += sign * gUp * coinOi;
  }

  const down1PctCoins = -gammaNetDown * dSDown;
  const up1PctCoins = -gammaNetUp * dSUp;

  return {
    regime,
    down1PctUsd: down1PctCoins * sDown,
    up1PctUsd: up1PctCoins * sUp,
  };
}
