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

export type VolatilitySmilePoint = {
  strike: number;
  moneynessPct: number;
  smileIvPct: number;
  callIvPct: number | null;
  putIvPct: number | null;
  callOi: number;
  putOi: number;
};

export type SmileLevelAlignment = {
  id: string;
  price: number;
  kind: 'support' | 'resistance' | 'put_wall' | 'call_wall' | 'poc';
  label: string;
  ivAtLevelPct: number | null;
  distancePct: number;
  touches?: number;
};

export type VolatilitySmileData = {
  expiry: string;
  daysToExpiry: number | null;
  spot: number;
  points: VolatilitySmilePoint[];
  atmIvPct: number | null;
  skew10Pct: number | null;
  wingCurvaturePct: number | null;
  minIvStrike: number | null;
  minIvPct: number | null;
  levelAlignments: SmileLevelAlignment[];
};

function interpolateSmileIvPct(points: VolatilitySmilePoint[], targetPrice: number): number | null {
  if (points.length === 0 || targetPrice <= 0) return null;
  if (targetPrice <= points[0].strike) return points[0].smileIvPct;
  const last = points[points.length - 1];
  if (targetPrice >= last.strike) return last.smileIvPct;

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    if (targetPrice <= curr.strike) {
      const span = curr.strike - prev.strike;
      const t = span > 0 ? (targetPrice - prev.strike) / span : 0;
      return prev.smileIvPct + t * (curr.smileIvPct - prev.smileIvPct);
    }
  }
  return last.smileIvPct;
}

/**
 * Builds the Implied Volatility Smile curve by Strike for a given expiry (or nearest active expiry)
 * and aligns technical Support/Resistance zones & option walls onto the curve.
 */
export function calculateVolatilitySmile(params: {
  options: OptionRow[];
  spot: number;
  expiry: string;
  srZones?: { id: string; price: number; kind: 'support' | 'resistance'; touches: number }[];
  optionsLevels?: Levels | null;
  pocPrice?: number | null;
  rangePct?: number | null; // e.g., 20 or 35 (%) around spot; null for full chain
  nowMs?: number;
}): VolatilitySmileData {
  const {
    options,
    spot,
    expiry,
    srZones = [],
    optionsLevels = null,
    pocPrice = null,
    rangePct = 35,
    nowMs = Date.now(),
  } = params;

  const expiries = getAvailableExpiries(options, nowMs);
  const resolvedExpiry =
    expiry && expiry !== 'ALL' && options.some((o) => o.expiry === expiry && o.iv > 0 && o.iv < 5)
      ? expiry
      : expiries[0]?.expiry ?? '';

  const expMeta = expiries.find((e) => e.expiry === resolvedExpiry) ?? null;

  if (!resolvedExpiry || spot <= 0) {
    return {
      expiry: resolvedExpiry,
      daysToExpiry: expMeta?.daysToExpiry ?? null,
      spot,
      points: [],
      atmIvPct: null,
      skew10Pct: null,
      wingCurvaturePct: null,
      minIvStrike: null,
      minIvPct: null,
      levelAlignments: [],
    };
  }

  const rows = options.filter(
    (o) =>
      o.expiry === resolvedExpiry &&
      Number.isFinite(o.strike) &&
      o.strike > 0 &&
      Number.isFinite(o.iv) &&
      o.iv > 0.005 &&
      o.iv < 5
  );

  const byStrike = new Map<
    number,
    { callIvs: number[]; putIvs: number[]; callOi: number; putOi: number }
  >();

  for (const r of rows) {
    let bucket = byStrike.get(r.strike);
    if (!bucket) {
      bucket = { callIvs: [], putIvs: [], callOi: 0, putOi: 0 };
      byStrike.set(r.strike, bucket);
    }
    const coinOi = Math.max(0, r.oi * r.mult);
    if (r.type === 'C') {
      bucket.callIvs.push(r.iv * 100);
      bucket.callOi += coinOi;
    } else {
      bucket.putIvs.push(r.iv * 100);
      bucket.putOi += coinOi;
    }
  }

  const allPoints: VolatilitySmilePoint[] = Array.from(byStrike.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([strike, b]) => {
      const callIvPct =
        b.callIvs.length > 0 ? b.callIvs.reduce((s, v) => s + v, 0) / b.callIvs.length : null;
      const putIvPct =
        b.putIvs.length > 0 ? b.putIvs.reduce((s, v) => s + v, 0) / b.putIvs.length : null;

      let smileIvPct: number;
      if (strike < spot * 0.995) {
        smileIvPct = putIvPct ?? callIvPct ?? 0;
      } else if (strike > spot * 1.005) {
        smileIvPct = callIvPct ?? putIvPct ?? 0;
      } else if (callIvPct !== null && putIvPct !== null) {
        smileIvPct = (callIvPct + putIvPct) * 0.5;
      } else {
        smileIvPct = callIvPct ?? putIvPct ?? 0;
      }

      return {
        strike,
        moneynessPct: ((strike - spot) / spot) * 100,
        smileIvPct,
        callIvPct,
        putIvPct,
        callOi: b.callOi,
        putOi: b.putOi,
      };
    })
    .filter((p) => p.smileIvPct > 0);

  const visiblePoints =
    rangePct !== null && rangePct > 0
      ? allPoints.filter((p) => Math.abs(p.moneynessPct) <= rangePct)
      : allPoints;

  const points = visiblePoints.length >= 4 ? visiblePoints : allPoints;

  const atmIvPct = interpolateSmileIvPct(allPoints, spot);
  const putWing = interpolateSmileIvPct(allPoints, spot * 0.9);
  const callWing = interpolateSmileIvPct(allPoints, spot * 1.1);
  const skew10Pct = putWing !== null && callWing !== null ? putWing - callWing : null;
  const wingCurvaturePct =
    putWing !== null && callWing !== null && atmIvPct !== null
      ? (putWing + callWing) * 0.5 - atmIvPct
      : null;

  let minIvStrike: number | null = null;
  let minIvPct: number | null = null;
  for (const pt of points) {
    if (minIvPct === null || pt.smileIvPct < minIvPct) {
      minIvPct = pt.smileIvPct;
      minIvStrike = pt.strike;
    }
  }

  // Align technical Support / Resistance zones + Key option walls + POC onto strike domain
  const levelAlignments: SmileLevelAlignment[] = [];
  let supIdx = 0;
  let resIdx = 0;
  const sortedSr = [...srZones].sort((a, b) => Math.abs(a.price - spot) - Math.abs(b.price - spot));
  for (const z of sortedSr) {
    if (z.kind === 'support') {
      supIdx++;
      levelAlignments.push({
        id: z.id,
        price: z.price,
        kind: 'support',
        label: `S${supIdx} Soporte`,
        ivAtLevelPct: interpolateSmileIvPct(allPoints, z.price),
        distancePct: ((z.price - spot) / spot) * 100,
        touches: z.touches,
      });
    } else {
      resIdx++;
      levelAlignments.push({
        id: z.id,
        price: z.price,
        kind: 'resistance',
        label: `R${resIdx} Resistencia`,
        ivAtLevelPct: interpolateSmileIvPct(allPoints, z.price),
        distancePct: ((z.price - spot) / spot) * 100,
        touches: z.touches,
      });
    }
  }

  if (optionsLevels) {
    if (optionsLevels.putWall > 0) {
      levelAlignments.push({
        id: 'put-wall-align',
        price: optionsLevels.putWall,
        kind: 'put_wall',
        label: 'Put Wall',
        ivAtLevelPct: interpolateSmileIvPct(allPoints, optionsLevels.putWall),
        distancePct: ((optionsLevels.putWall - spot) / spot) * 100,
      });
    }
    if (optionsLevels.callWall > 0) {
      levelAlignments.push({
        id: 'call-wall-align',
        price: optionsLevels.callWall,
        kind: 'call_wall',
        label: 'Call Wall',
        ivAtLevelPct: interpolateSmileIvPct(allPoints, optionsLevels.callWall),
        distancePct: ((optionsLevels.callWall - spot) / spot) * 100,
      });
    }
  }

  if (pocPrice && pocPrice > 0) {
    levelAlignments.push({
      id: 'poc-align',
      price: pocPrice,
      kind: 'poc',
      label: 'POC VPVR',
      ivAtLevelPct: interpolateSmileIvPct(allPoints, pocPrice),
      distancePct: ((pocPrice - spot) / spot) * 100,
    });
  }

  return {
    expiry: resolvedExpiry,
    daysToExpiry: expMeta?.daysToExpiry ?? null,
    spot,
    points,
    atmIvPct,
    skew10Pct,
    wingCurvaturePct,
    minIvStrike,
    minIvPct,
    levelAlignments,
  };
}
