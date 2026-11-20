import { create } from 'zustand';
import type {
  Candle,
  CandleTheme,
  HorizontalLevel,
  LayerVisibility,
  MacroEvent,
  OptionRow,
  OptionTradeRow,
  OptionsProviderName,
  OrderbookDepthData,
  SymbolAsset,
  TickerSnapshot,
  Timeframe,
} from '../types/market';
import type { StreamConnectionStatus } from '../data/okxMarketClient';

const STORAGE_KEYS = {
  layers: 'wterm_layers_v1',
  timeframe: 'wterm_timeframe_v1',
  asset: 'wterm_asset_v1',
  userLevelsPrefix: 'wterm_levels_v1_',
  provider: 'wterm_provider_v1',
  candleTheme: 'wterm_candletheme_v1',
};

const DEFAULT_LAYERS: LayerVisibility = {
  emaClouds: true,
  ema9: true,
  ema21: true,
  vwap: true,
  volume: true,
  levels: true,
  optionLevels: true,
  liquidityLevels: true,
  cone: true,
  events: true,
};

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson<T>(key: string, value: T) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // ignore quota errors
  }
}

export type ActiveWorkspaceTab =
  | 'chart'
  | 'main_chart'
  | 'technical'
  | 'trading_options'
  | 'scoring'
  | 'backtest'
  | 'architecture';
export type RightPanelTab = 'Levels' | 'Live' | 'GEX';
export type GexLadderMode = 'GEX' | 'DEX' | 'OI' | 'MultiMap';

interface TerminalState {
  activeTab: ActiveWorkspaceTab;
  asset: SymbolAsset;
  timeframe: Timeframe;
  candles: Candle[];
  candlesLoading: boolean;
  candlesDatasetKey: string;
  prevDayHigh: number | null;
  prevDayLow: number | null;
  ticker: TickerSnapshot | null;
  streamStatus: StreamConnectionStatus;
  candlesError: string | null;

  layers: LayerVisibility;
  legendCollapsed: boolean;
  candleTheme: CandleTheme;

  drawMode: 'crosshair' | 'horizontal';
  userLevels: HorizontalLevel[];
  selectedLevelId: string | null;

  providerName: OptionsProviderName;
  options: OptionRow[];
  optionTrades: OptionTradeRow[];
  orderbook: OrderbookDepthData | null;
  optionsLoading: boolean;
  optionsError: string | null;
  optionsUpdatedAt: number | null;
  selectedExpiry: string;
  rightTab: RightPanelTab;
  ladderMode: GexLadderMode;

  events: MacroEvent[];
  eventsModalOpen: boolean;

  setActiveTab: (tab: ActiveWorkspaceTab) => void;
  setAsset: (asset: SymbolAsset) => void;
  setTimeframe: (tf: Timeframe) => void;
  setCandles: (candles: Candle[], datasetKey?: string) => void;
  setCandlesLoading: (loading: boolean) => void;
  prependCandles: (older: Candle[]) => void;
  upsertCandle: (candle: Omit<Candle, 'v'>) => void;
  updateSpotVolume: (ts: number, vol: number) => void;
  setPrevDayHighLow: (high: number | null, low: number | null) => void;
  setTicker: (ticker: TickerSnapshot) => void;
  setStreamStatus: (status: StreamConnectionStatus) => void;
  setCandlesError: (err: string | null) => void;

  toggleLayer: (key: keyof LayerVisibility) => void;
  setLegendCollapsed: (collapsed: boolean) => void;
  setCandleTheme: (theme: CandleTheme) => void;

  setDrawMode: (mode: 'crosshair' | 'horizontal') => void;
  addUserLevel: (price: number) => void;
  updateUserLevelLabel: (id: string, label: string) => void;
  removeUserLevel: (id: string) => void;
  clearUserLevels: () => void;
  setSelectedLevelId: (id: string | null) => void;

  setProviderName: (name: OptionsProviderName) => void;
  setOptionsData: (options: OptionRow[], updatedAt: number) => void;
  setOptionTrades: (trades: OptionTradeRow[]) => void;
  setOrderbook: (orderbook: OrderbookDepthData | null) => void;
  setOptionsLoading: (loading: boolean) => void;
  setOptionsError: (err: string | null) => void;
  setSelectedExpiry: (expiry: string) => void;
  setRightTab: (tab: RightPanelTab) => void;
  setLadderMode: (mode: GexLadderMode) => void;

  setEvents: (events: MacroEvent[]) => void;
  setEventsModalOpen: (open: boolean) => void;
}

const initialAsset = loadJson<SymbolAsset>(STORAGE_KEYS.asset, 'BTC');

export const useTerminalStore = create<TerminalState>((set, get) => ({
  activeTab: 'chart',
  asset: initialAsset,
  timeframe: loadJson<Timeframe>(STORAGE_KEYS.timeframe, '15m'),
  candles: [],
  candlesLoading: false,
  candlesDatasetKey: '',
  prevDayHigh: null,
  prevDayLow: null,
  ticker: null,
  streamStatus: 'connecting',
  candlesError: null,

  layers: { ...DEFAULT_LAYERS, ...loadJson<Partial<LayerVisibility>>(STORAGE_KEYS.layers, {}) },
  legendCollapsed: false,
  candleTheme: loadJson<CandleTheme>(STORAGE_KEYS.candleTheme, 'photo'),

  drawMode: 'crosshair',
  userLevels: loadJson<HorizontalLevel[]>(STORAGE_KEYS.userLevelsPrefix + initialAsset, []),
  selectedLevelId: null,

  providerName: loadJson<OptionsProviderName>(STORAGE_KEYS.provider, 'okx'),
  options: [],
  optionTrades: [],
  orderbook: null,
  optionsLoading: false,
  optionsError: null,
  optionsUpdatedAt: null,
  selectedExpiry: '',
  rightTab: 'GEX',
  ladderMode: 'GEX',

  events: [],
  eventsModalOpen: false,

  setActiveTab: (activeTab) => set({ activeTab }),
  setAsset: (asset) => {
    saveJson(STORAGE_KEYS.asset, asset);
    const loadedLevels = loadJson<HorizontalLevel[]>(STORAGE_KEYS.userLevelsPrefix + asset, []);
    set({
      asset,
      userLevels: loadedLevels,
      selectedLevelId: null,
      options: [],
      optionTrades: [],
      orderbook: null,
      selectedExpiry: '',
      ticker: null,
    });
  },
  setTimeframe: (timeframe) => {
    saveJson(STORAGE_KEYS.timeframe, timeframe);
    set({ timeframe });
  },
  setCandles: (candles, datasetKey) =>
    set((state) => ({
      candles,
      candlesDatasetKey: datasetKey ?? `${state.asset}|${state.timeframe}`,
    })),
  setCandlesLoading: (candlesLoading) => set({ candlesLoading }),
  prependCandles: (older) =>
    set((state) => {
      if (older.length === 0) return state;
      const map = new Map<number, Candle>();
      for (const c of older) map.set(c.t, c);
      for (const c of state.candles) map.set(c.t, c);
      const merged = Array.from(map.values()).sort((a, b) => a.t - b.t);
      return { candles: merged };
    }),
  upsertCandle: (incoming) =>
    set((state) => {
      if (state.candles.length === 0) return state;
      const last = state.candles[state.candles.length - 1];
      if (incoming.t === last.t) {
        const updated = state.candles.slice();
        updated[updated.length - 1] = { ...incoming, v: last.v };
        return { candles: updated };
      }
      if (incoming.t > last.t) {
        const updated = [...state.candles, { ...incoming, v: 0 }];
        if (updated.length > 2000) updated.shift();
        return { candles: updated };
      }
      return state;
    }),
  updateSpotVolume: (ts, vol) =>
    set((state) => {
      if (state.candles.length === 0) return state;
      const idx = state.candles.findIndex((c) => c.t === ts);
      if (idx === -1) return state;
      const updated = state.candles.slice();
      updated[idx] = { ...updated[idx], v: vol };
      return { candles: updated };
    }),
  setPrevDayHighLow: (prevDayHigh, prevDayLow) => set({ prevDayHigh, prevDayLow }),
  setTicker: (ticker) =>
    set((state) => {
      if (state.candles.length === 0) return { ticker };
      const last = state.candles[state.candles.length - 1];
      const updated = state.candles.slice();
      updated[updated.length - 1] = {
        ...last,
        c: ticker.idxPx,
        h: Math.max(last.h, ticker.idxPx),
        l: Math.min(last.l, ticker.idxPx),
      };
      return { ticker, candles: updated };
    }),
  setStreamStatus: (streamStatus) => set({ streamStatus }),
  setCandlesError: (candlesError) => set({ candlesError }),

  toggleLayer: (key) => {
    const next = { ...get().layers, [key]: !get().layers[key] };
    saveJson(STORAGE_KEYS.layers, next);
    set({ layers: next });
  },
  setLegendCollapsed: (legendCollapsed) => set({ legendCollapsed }),
  setCandleTheme: (candleTheme) => {
    saveJson(STORAGE_KEYS.candleTheme, candleTheme);
    set({ candleTheme });
  },

  setDrawMode: (drawMode) => set({ drawMode }),
  addUserLevel: (price) => {
    const { asset, userLevels } = get();
    const newLevel: HorizontalLevel = {
      id: `lvl-${Date.now()}-${Math.round(price)}`,
      price,
      source: 'user',
    };
    const next = [...userLevels, newLevel];
    saveJson(STORAGE_KEYS.userLevelsPrefix + asset, next);
    set({ userLevels: next, selectedLevelId: newLevel.id, drawMode: 'crosshair' });
  },
  updateUserLevelLabel: (id, label) => {
    const { asset, userLevels } = get();
    const next = userLevels.map((l) => (l.id === id ? { ...l, label } : l));
    saveJson(STORAGE_KEYS.userLevelsPrefix + asset, next);
    set({ userLevels: next });
  },
  removeUserLevel: (id) => {
    const { asset, userLevels, selectedLevelId } = get();
    const next = userLevels.filter((l) => l.id !== id);
    saveJson(STORAGE_KEYS.userLevelsPrefix + asset, next);
    set({
      userLevels: next,
      selectedLevelId: selectedLevelId === id ? null : selectedLevelId,
    });
  },
  clearUserLevels: () => {
    const { asset } = get();
    saveJson(STORAGE_KEYS.userLevelsPrefix + asset, []);
    set({ userLevels: [], selectedLevelId: null });
  },
  setSelectedLevelId: (selectedLevelId) => set({ selectedLevelId }),

  setProviderName: (providerName) => {
    saveJson(STORAGE_KEYS.provider, providerName);
    set({ providerName, options: [], optionTrades: [], selectedExpiry: '' });
  },
  setOptionsData: (options, optionsUpdatedAt) => set({ options, optionsUpdatedAt, optionsError: null }),
  setOptionTrades: (optionTrades) => set({ optionTrades }),
  setOrderbook: (orderbook) => set({ orderbook }),
  setOptionsLoading: (optionsLoading) => set({ optionsLoading }),
  setOptionsError: (optionsError) => set({ optionsError }),
  setSelectedExpiry: (selectedExpiry) => set({ selectedExpiry }),
  setRightTab: (rightTab) => set({ rightTab }),
  setLadderMode: (ladderMode) => set({ ladderMode }),

  setEvents: (events) => set({ events }),
  setEventsModalOpen: (eventsModalOpen) => set({ eventsModalOpen }),
}));
