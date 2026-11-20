import { bsDeltaGamma } from '../calc/blackScholes';
import type { OptionRow, OptionTradeRow, OptionsProviderName, SymbolAsset } from '../types/market';

export interface OptionsProvider {
  readonly name: OptionsProviderName;
  fetchChain(asset: SymbolAsset, spotHint: number): Promise<OptionRow[]>;
  fetchRecentTrades(asset: SymbolAsset): Promise<OptionTradeRow[]>;
}

type OkxSummaryItem = {
  instId: string;
  deltaBS?: string;
  gammaBS?: string;
  markVol?: string;
  fwdPx?: string;
};

type OkxOiItem = {
  instId: string;
  oi: string;
};

type OkxInstrumentItem = {
  instId: string;
  ctMult: string;
  ctVal: string;
  expTime: string;
  stk: string;
  optType: 'C' | 'P';
};

type OkxOptionTradeItem = {
  tradeId: string;
  instId: string;
  optType: 'C' | 'P';
  side: 'buy' | 'sell';
  sz: string;
  px: string;
  idxPx: string;
  fillVol: string;
  ts: string;
};

function parseOkxInstMeta(instId: string): { expiry: string; strike: number } {
  // e.g. BTC-USD-261120-61500-P
  const parts = instId.split('-');
  if (parts.length < 5) return { expiry: '—', strike: 0 };
  const yymmdd = parts[2];
  const strike = Number(parts[3]);
  const expiry =
    yymmdd.length === 6
      ? `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`
      : yymmdd;
  return { expiry, strike: Number.isFinite(strike) ? strike : 0 };
}

export class OkxOptionsProvider implements OptionsProvider {
  readonly name: OptionsProviderName = 'okx';

  async fetchChain(asset: SymbolAsset, spotHint: number): Promise<OptionRow[]> {
    const uly = `${asset}-USD`;
    const [sumRes, oiRes, instRes] = await Promise.all([
      fetch(`/api/okx/public/opt-summary?instFamily=${uly}`),
      fetch(`/api/okx/public/open-interest?instType=OPTION&uly=${uly}`),
      fetch(`/api/okx/public/instruments?instType=OPTION&uly=${uly}`),
    ]);

    if (!sumRes.ok || !oiRes.ok || !instRes.ok) {
      throw new Error('Error al consultar la cadena de opciones de OKX');
    }

    const [sumJson, oiJson, instJson] = await Promise.all([
      sumRes.json() as Promise<{ code: string; msg: string; data: OkxSummaryItem[] }>,
      oiRes.json() as Promise<{ code: string; msg: string; data: OkxOiItem[] }>,
      instRes.json() as Promise<{ code: string; msg: string; data: OkxInstrumentItem[] }>,
    ]);

    if (sumJson.code !== '0' || oiJson.code !== '0' || instJson.code !== '0') {
      throw new Error(sumJson.msg || oiJson.msg || instJson.msg || 'Respuesta inválida de OKX');
    }

    const summaryMap = new Map<string, OkxSummaryItem>();
    for (const item of sumJson.data) {
      summaryMap.set(item.instId, item);
    }

    const oiMap = new Map<string, number>();
    for (const item of oiJson.data) {
      oiMap.set(item.instId, Number(item.oi || 0));
    }

    const nowMs = Date.now();
    const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
    const rows: OptionRow[] = [];

    for (const inst of instJson.data) {
      const expTs = Number(inst.expTime);
      const strike = Number(inst.stk);
      const mult = Number(inst.ctVal || 1) * Number(inst.ctMult || 1);
      if (!Number.isFinite(expTs) || !Number.isFinite(strike) || expTs <= nowMs) continue;

      const summary = summaryMap.get(inst.instId);
      const oi = oiMap.get(inst.instId) ?? 0;
      const iv = summary?.markVol ? Number(summary.markVol) : 0.5;
      const spot = spotHint > 0 ? spotHint : Number(summary?.fwdPx || strike);

      let delta = summary?.deltaBS ? Number(summary.deltaBS) : NaN;
      let gamma = summary?.gammaBS ? Number(summary.gammaBS) : NaN;

      if (!Number.isFinite(delta) || !Number.isFinite(gamma) || gamma === 0) {
        const T = Math.max(1e-5, (expTs - nowMs) / MS_PER_YEAR);
        const bs = bsDeltaGamma(spot, strike, T, iv > 0 ? iv : 0.5, inst.optType);
        delta = bs.delta;
        gamma = bs.gamma;
      }

      const expiry = new Date(expTs).toISOString().slice(0, 10);
      rows.push({
        instId: inst.instId,
        expiry,
        expTs,
        strike,
        type: inst.optType,
        oi,
        iv: Number.isFinite(iv) && iv > 0 ? iv : 0.5,
        delta,
        gamma,
        mult: Number.isFinite(mult) && mult > 0 ? mult : 0.01,
      });
    }

    return rows;
  }

  async fetchRecentTrades(asset: SymbolAsset): Promise<OptionTradeRow[]> {
    const res = await fetch(`/api/okx/public/option-trades?instFamily=${asset}-USD`);
    if (!res.ok) return [];
    const json = (await res.json()) as { code: string; data?: OkxOptionTradeItem[] };
    if (json.code !== '0' || !Array.isArray(json.data)) return [];

    const mult = asset === 'BTC' ? 0.01 : 0.1;
    return json.data.slice(0, 25).map((item) => {
      const meta = parseOkxInstMeta(item.instId);
      const sizeCoins = Number(item.sz || 0) * mult;
      const px = Number(item.px || 0);
      const idxPx = Number(item.idxPx || 0);
      return {
        id: `${item.tradeId}-${item.ts}`,
        ts: Number(item.ts),
        instId: item.instId,
        expiry: meta.expiry,
        strike: meta.strike,
        type: item.optType,
        side: item.side,
        sizeCoins,
        iv: Number(item.fillVol || 0),
        premiumUsd: sizeCoins * px * idxPx,
      };
    });
  }
}

const MONTH_MAP: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

function parseDeribitInstrument(name: string): {
  expTs: number;
  expiry: string;
  strike: number;
  type: 'C' | 'P';
} | null {
  const parts = name.split('-');
  if (parts.length !== 4) return null;
  const dateToken = parts[1];
  const strike = Number(parts[2]);
  const optType = parts[3] === 'C' ? 'C' : parts[3] === 'P' ? 'P' : null;
  if (!optType || !Number.isFinite(strike)) return null;

  const match = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(dateToken);
  if (!match) return null;
  const day = Number(match[1]);
  const month = MONTH_MAP[match[2]];
  const year = 2000 + Number(match[3]);
  if (month === undefined) return null;

  const expTs = Date.UTC(year, month, day, 8, 0, 0);
  const expiry = new Date(expTs).toISOString().slice(0, 10);
  return { expTs, expiry, strike, type: optType };
}

type DeribitSummaryItem = {
  instrument_name: string;
  open_interest: number;
  mark_iv: number;
  underlying_price: number;
};

type DeribitTradeItem = {
  trade_id: string;
  timestamp: number;
  instrument_name: string;
  direction: 'buy' | 'sell';
  amount: number;
  price: number;
  index_price: number;
  iv: number;
};

export class DeribitOptionsProvider implements OptionsProvider {
  readonly name: OptionsProviderName = 'deribit';

  async fetchChain(asset: SymbolAsset, spotHint: number): Promise<OptionRow[]> {
    const res = await fetch(
      `/api/deribit/public/get_book_summary_by_currency?currency=${asset}&kind=option`
    );
    if (!res.ok) {
      throw new Error(`Deribit HTTP ${res.status}`);
    }
    const json = (await res.json()) as { result?: DeribitSummaryItem[] };
    if (!Array.isArray(json.result)) {
      throw new Error('Respuesta inválida de Deribit');
    }

    const nowMs = Date.now();
    const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;
    const rows: OptionRow[] = [];

    for (const item of json.result) {
      const parsed = parseDeribitInstrument(item.instrument_name);
      if (!parsed || parsed.expTs <= nowMs) continue;

      const iv = item.mark_iv > 0 ? item.mark_iv / 100 : 0.5;
      const spot = spotHint > 0 ? spotHint : item.underlying_price || parsed.strike;
      const T = Math.max(1e-5, (parsed.expTs - nowMs) / MS_PER_YEAR);
      const { delta, gamma } = bsDeltaGamma(spot, parsed.strike, T, iv, parsed.type);

      rows.push({
        instId: item.instrument_name,
        expiry: parsed.expiry,
        expTs: parsed.expTs,
        strike: parsed.strike,
        type: parsed.type,
        oi: item.open_interest ?? 0,
        iv,
        delta,
        gamma,
        mult: 1,
      });
    }

    return rows;
  }

  async fetchRecentTrades(asset: SymbolAsset): Promise<OptionTradeRow[]> {
    const res = await fetch(
      `/api/deribit/public/get_last_trades_by_currency?currency=${asset}&kind=option&count=25`
    );
    if (!res.ok) return [];
    const json = (await res.json()) as { result?: { trades?: DeribitTradeItem[] } };
    const trades = json.result?.trades;
    if (!Array.isArray(trades)) return [];

    return trades
      .map((t) => {
        const parsed = parseDeribitInstrument(t.instrument_name);
        if (!parsed) return null;
        return {
          id: t.trade_id,
          ts: t.timestamp,
          instId: t.instrument_name,
          expiry: parsed.expiry,
          strike: parsed.strike,
          type: parsed.type,
          side: t.direction,
          sizeCoins: t.amount,
          iv: (t.iv ?? 0) / 100,
          premiumUsd: t.amount * t.price * t.index_price,
        };
      })
      .filter((x): x is OptionTradeRow => x !== null);
  }
}

export function createOptionsProvider(name: OptionsProviderName): OptionsProvider {
  return name === 'deribit' ? new DeribitOptionsProvider() : new OkxOptionsProvider();
}
