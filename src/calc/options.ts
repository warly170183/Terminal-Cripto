import type { Levels, OptionRow, StrikeRow } from '../types/market';

/**
 * Aggregates options rows into per-strike GEX, DEX, and OI metrics.
 *
 * Formulas (per specification):
 *   GEX_K = (Gamma_c * OI_c - Gamma_p * OI_p) * mult * S^2 * 0.01
 *   DEX_K = (Delta_c * OI_c + Delta_p * OI_p) * mult * S
 *   OI_K  = (OI_c + OI_p) * mult
 *
 * Returns rows sorted ascending by strike.
 */
export function aggregateStrikes(
  options: OptionRow[],
  spot: number,
  expiryFilter: string = 'ALL'
): StrikeRow[] {
  if (spot <= 0 || options.length === 0) {
    return [];
  }

  const byStrike = new Map<number, StrikeRow>();
  const spotSq01 = spot * spot * 0.01;

  for (const opt of options) {
    if (expiryFilter !== 'ALL' && opt.expiry !== expiryFilter) continue;
    if (!Number.isFinite(opt.strike) || opt.strike <= 0) continue;

    let row = byStrike.get(opt.strike);
    if (!row) {
      row = {
        strike: opt.strike,
        gex: 0,
        dex: 0,
        oi: 0,
        callOi: 0,
        putOi: 0,
        callGex: 0,
        putGex: 0,
        callDex: 0,
        putDex: 0,
      };
      byStrike.set(opt.strike, row);
    }

    const coinOi = opt.oi * opt.mult;
    if (opt.type === 'C') {
      const gexVal = opt.gamma * coinOi * spotSq01;
      const dexVal = opt.delta * coinOi * spot;
      row.callOi += coinOi;
      row.callGex += gexVal;
      row.callDex += dexVal;
      row.gex += gexVal;
      row.dex += dexVal;
      row.oi += coinOi;
    } else {
      const gexVal = -opt.gamma * coinOi * spotSq01;
      const dexVal = opt.delta * coinOi * spot;
      row.putOi += coinOi;
      row.putGex += gexVal;
      row.putDex += dexVal;
      row.gex += gexVal;
      row.dex += dexVal;
      row.oi += coinOi;
    }
  }

  return Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
}

/**
 * Calculates GEX Flip (via linear interpolation of cumulative net GEX from lowest strike upward),
 * Max Pain (strike minimizing total buyer payout), Call Wall, and Put Wall.
 */
export function calculateLevels(
  strikesAsc: StrikeRow[],
  optionsForExpiry: OptionRow[],
  spot: number
): Levels {
  if (strikesAsc.length === 0) {
    return {
      flip: null,
      maxPain: spot,
      callWall: spot,
      putWall: spot,
      netGex: 0,
      netGamma: 0,
    };
  }

  // 1. Net GEX & Net Gamma
  let netGex = 0;
  for (const s of strikesAsc) {
    netGex += s.gex;
  }
  const netGamma = spot > 0 ? netGex / (spot * spot * 0.01) : 0;

  // 2. Call Wall (highest positive GEX, fallback to highest callOi) & Put Wall (most negative GEX, fallback to highest putOi)
  let callWallRow = strikesAsc[0];
  let putWallRow = strikesAsc[0];
  let hasPositiveGex = false;
  let hasNegativeGex = false;

  for (const row of strikesAsc) {
    if (row.gex > 0) hasPositiveGex = true;
    if (row.gex < 0) hasNegativeGex = true;
  }

  if (hasPositiveGex) {
    callWallRow = strikesAsc.reduce((best, r) => (r.gex > best.gex ? r : best), strikesAsc[0]);
  } else {
    callWallRow = strikesAsc.reduce((best, r) => (r.callOi > best.callOi ? r : best), strikesAsc[0]);
  }

  if (hasNegativeGex) {
    putWallRow = strikesAsc.reduce((best, r) => (r.gex < best.gex ? r : best), strikesAsc[0]);
  } else {
    putWallRow = strikesAsc.reduce((best, r) => (r.putOi > best.putOi ? r : best), strikesAsc[0]);
  }

  // 3. Flip: scan ascending strikes, accumulate net GEX, linearly interpolate where cumulative GEX crosses 0.
  let flip: number | null = null;
  let cumPrev = 0;
  const crossings: number[] = [];

  for (let i = 0; i < strikesAsc.length; i++) {
    const cumCurr = cumPrev + strikesAsc[i].gex;
    if (i > 0) {
      const crossedUp = cumPrev < 0 && cumCurr >= 0;
      const crossedDown = cumPrev > 0 && cumCurr <= 0;
      if (crossedUp || crossedDown) {
        const denom = Math.abs(cumPrev) + Math.abs(cumCurr);
        const ratio = denom > 0 ? Math.abs(cumPrev) / denom : 0.5;
        const k0 = strikesAsc[i - 1].strike;
        const k1 = strikesAsc[i].strike;
        crossings.push(k0 + ratio * (k1 - k0));
      }
    }
    cumPrev = cumCurr;
  }

  if (crossings.length > 0) {
    // Choose the zero crossing closest to current spot price
    flip = crossings.reduce((best, c) =>
      Math.abs(c - spot) < Math.abs(best - spot) ? c : best
    );
  }

  // 4. Max Pain: argmin_K sum_i [ OI_c_i * mult_i * max(K - K_i, 0) + OI_p_i * mult_i * max(K_i - K, 0) ]
  const sourceRows = optionsForExpiry.length > 0 ? optionsForExpiry : [];
  let maxPain = strikesAsc[0].strike;
  let minPayout = Infinity;

  for (const candidate of strikesAsc) {
    const K = candidate.strike;
    let totalPayout = 0;
    if (sourceRows.length > 0) {
      for (const opt of sourceRows) {
        const coinOi = opt.oi * opt.mult;
        if (coinOi <= 0) continue;
        if (opt.type === 'C') {
          if (K > opt.strike) totalPayout += coinOi * (K - opt.strike);
        } else {
          if (opt.strike > K) totalPayout += coinOi * (opt.strike - K);
        }
      }
    } else {
      for (const s of strikesAsc) {
        if (K > s.strike) totalPayout += s.callOi * (K - s.strike);
        if (s.strike > K) totalPayout += s.putOi * (s.strike - K);
      }
    }

    if (totalPayout < minPayout) {
      minPayout = totalPayout;
      maxPain = K;
    }
  }

  return {
    flip,
    maxPain,
    callWall: callWallRow.strike,
    putWall: putWallRow.strike,
    netGex,
    netGamma,
  };
}

/**
 * Extracts unique sorted expiries from options chain.
 */
export function getAvailableExpiries(options: OptionRow[], nowMs = Date.now()): {
  expiry: string;
  expTs: number;
  daysToExpiry: number;
  activeStrikes: number;
}[] {
  const map = new Map<string, { expTs: number; strikesWithOi: Set<number> }>();
  for (const opt of options) {
    if (opt.expTs <= nowMs) continue;
    let entry = map.get(opt.expiry);
    if (!entry) {
      entry = { expTs: opt.expTs, strikesWithOi: new Set() };
      map.set(opt.expiry, entry);
    }
    if (opt.oi > 0) {
      entry.strikesWithOi.add(opt.strike);
    }
  }

  return Array.from(map.entries())
    .map(([expiry, info]) => ({
      expiry,
      expTs: info.expTs,
      daysToExpiry: Math.max(0.01, (info.expTs - nowMs) / (1000 * 60 * 60 * 24)),
      activeStrikes: info.strikesWithOi.size,
    }))
    .sort((a, b) => a.expTs - b.expTs);
}

export type TermStructurePoint = {
  expiry: string;
  daysToExpiry: number;
  atmIvPct: number;
  totalOi: number;
};

/**
 * Computes ATM implied volatility term structure across all active expiries.
 */
export function calculateTermStructure(
  options: OptionRow[],
  spot: number,
  nowMs = Date.now()
): TermStructurePoint[] {
  if (options.length === 0 || spot <= 0) return [];
  const expiries = getAvailableExpiries(options, nowMs);
  const result: TermStructurePoint[] = [];

  for (const exp of expiries) {
    const expRows = options.filter((o) => o.expiry === exp.expiry && o.iv > 0 && o.iv < 5);
    if (expRows.length === 0) continue;

    let minDist = Infinity;
    for (const o of expRows) {
      const d = Math.abs(o.strike - spot);
      if (d < minDist) minDist = d;
    }
    const atm = expRows.filter((o) => Math.abs(Math.abs(o.strike - spot) - minDist) < 1e-6);
    const atmIv = atm.reduce((a, o) => a + o.iv, 0) / atm.length;
    const totalOi = expRows.reduce((a, o) => a + o.oi * o.mult, 0);

    result.push({
      expiry: exp.expiry,
      daysToExpiry: exp.daysToExpiry,
      atmIvPct: atmIv * 100,
      totalOi,
    });
  }

  return result;
}
