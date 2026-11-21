import { create } from 'zustand';
import type {
  Candle,
  CandleTheme,
  ChartAnchorPoint,
  ChartDrawMode,
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
  UserChartMarker,
  UserTrendLine,
} from '../types/market';
import type { PersistedScoringConfig } from '../types/scoring';
import type { RawNewsHeadline } from '../calc/newsSentiment';
import type { StreamConnectionStatus } from '../data/okxMarketClient';
import {
  evaluateSignalAgainstCandles,
  mergeSignalsIntoHistory,
  type TrackedOptionSignal,
} from '../calc/signalEffectiveness';

const STORAGE_KEYS = {
  layers: 'wterm_layers_v1',
  timeframe: 'wterm_timeframe_v1',
  asset: 'wterm_asset_v1',
  userLevelsPrefix: 'wterm_levels_v1_',
  userTrendLinesPrefix: 'wterm_trendlines_v1_',
  userMarkersPrefix: 'wterm_markers_v1_',
  provider: 'wterm_provider_v1',
  candleTheme: 'wterm_candletheme_v1',
  scoringConfig: 'wterm_scoring_config_v1',
  trackedSignals: 'wterm_tracked_signals_v1',
};

const DEFAULT_SCORING_CONFIG: PersistedScoringConfig = {
  mode: 'perpetual',
  capitalUsd: 10000,
  riskPct: 0.25,
  feePctPerSide: 0.05,
  slippagePctPerSide: 0.02,
  expectedFundingCostPct: 0.01,
  autoFundingFromLive: true,
  leverage: 5,
  dailyLossReached: false,
  correlatedRiskExceeded: false,
  vpLevelLock: 'auto',
  avwapAnchorLockTs: null,
  macroEventWindowHours: 2,
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
  | 'effectiveness'
  | 'scoring'
  | 'backtest'
  | 'architecture';
export type RightPanelTab = 'Levels' | 'Live' | 'GEX' | 'Macro';
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

  drawMode: ChartDrawMode;
  userLevels: HorizontalLevel[];
  selectedLevelId: string | null;
  userTrendLines: UserTrendLine[];
  userMarkers: UserChartMarker[];
  selectedTrendLineId: string | null;
  selectedMarkerId: string | null;

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

  newsItems: RawNewsHeadline[];
  newsSources: string[];
  newsCandles1h: Candle[];
  newsUpdatedAt: number | null;
  newsLoading: boolean;
  newsError: string | null;

  scoringConfig: PersistedScoringConfig;
  setScoringConfig: (patch: Partial<PersistedScoringConfig>) => void;

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

  setDrawMode: (mode: ChartDrawMode) => void;
  addUserLevel: (price: number) => void;
  updateUserLevelLabel: (id: string, label: string) => void;
  removeUserLevel: (id: string) => void;
  clearUserLevels: () => void;
  setSelectedLevelId: (id: string | null) => void;

  addUserTrendLine: (
    kind: 'segment' | 'ray',
    p1: ChartAnchorPoint,
    p2: ChartAnchorPoint,
    color?: string,
    label?: string
  ) => void;
  updateUserTrendLine: (id: string, patch: Partial<Pick<UserTrendLine, 'label' | 'color'>>) => void;
  removeUserTrendLine: (id: string) => void;
  setSelectedTrendLineId: (id: string | null) => void;

  addUserMarker: (point: ChartAnchorPoint, label?: string, color?: string) => void;
  updateUserMarker: (
    id: string,
    patch: Partial<Pick<UserChartMarker, 'label' | 'color' | 'status'>>
  ) => void;
  removeUserMarker: (id: string) => void;
  setSelectedMarkerId: (id: string | null) => void;

  clearAllUserDrawings: () => void;

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

  setNewsFeed: (items: RawNewsHeadline[], sources: string[], updatedAt: number) => void;
  setNewsCandles1h: (candles: Candle[]) => void;
  setNewsLoading: (loading: boolean) => void;
  setNewsError: (err: string | null) => void;

  trackedSignals: TrackedOptionSignal[];
  recordTrackedSignals: (incoming: TrackedOptionSignal[]) => void;
  reevaluateTrackedSignals: (
    asset: SymbolAsset,
    timeframe: Timeframe,
    marketMode: 'perpetual' | 'spot',
    candles: Candle[],
    horizonBars?: number
  ) => void;
  replaceTrackedSignals: (signals: TrackedOptionSignal[]) => void;
  clearTrackedSignals: (origin?: 'live' | 'audit') => void;
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
  userTrendLines: loadJson<UserTrendLine[]>(STORAGE_KEYS.userTrendLinesPrefix + initialAsset, []),
  userMarkers: loadJson<UserChartMarker[]>(STORAGE_KEYS.userMarkersPrefix + initialAsset, []),
  selectedTrendLineId: null,
  selectedMarkerId: null,

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

  newsItems: [],
  newsSources: [],
  newsCandles1h: [],
  newsUpdatedAt: null,
  newsLoading: false,
  newsError: null,

  scoringConfig: {
    ...DEFAULT_SCORING_CONFIG,
    ...loadJson<Partial<PersistedScoringConfig>>(STORAGE_KEYS.scoringConfig, {}),
  },
  trackedSignals: loadJson<TrackedOptionSignal[]>(STORAGE_KEYS.trackedSignals, []),
  setScoringConfig: (patch) =>
    set((state) => {
      const next = { ...state.scoringConfig, ...patch };
      saveJson(STORAGE_KEYS.scoringConfig, next);
      return { scoringConfig: next };
    }),

  setActiveTab: (activeTab) => set({ activeTab }),
  setAsset: (asset) => {
    saveJson(STORAGE_KEYS.asset, asset);
    const loadedLevels = loadJson<HorizontalLevel[]>(STORAGE_KEYS.userLevelsPrefix + asset, []);
    const loadedTrendLines = loadJson<UserTrendLine[]>(
      STORAGE_KEYS.userTrendLinesPrefix + asset,
      []
    );
    const loadedMarkers = loadJson<UserChartMarker[]>(STORAGE_KEYS.userMarkersPrefix + asset, []);
    set((state) => {
      const nextScoring = { ...state.scoringConfig, avwapAnchorLockTs: null };
      saveJson(STORAGE_KEYS.scoringConfig, nextScoring);
      return {
        asset,
        userLevels: loadedLevels,
        userTrendLines: loadedTrendLines,
        userMarkers: loadedMarkers,
        selectedLevelId: null,
        selectedTrendLineId: null,
        selectedMarkerId: null,
        options: [],
        optionTrades: [],
        orderbook: null,
        selectedExpiry: '',
        ticker: null,
        scoringConfig: nextScoring,
      };
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
    set({
      userLevels: next,
      selectedLevelId: newLevel.id,
      selectedTrendLineId: null,
      selectedMarkerId: null,
      drawMode: 'crosshair',
    });
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
  setSelectedLevelId: (selectedLevelId) =>
    set({ selectedLevelId, selectedTrendLineId: null, selectedMarkerId: null }),

  addUserTrendLine: (kind, p1, p2, color = '#38BDF8', label) => {
    const { asset, userTrendLines } = get();
    const nextLine: UserTrendLine = {
      id: `tl-${Date.now()}-${Math.round(p1.price)}`,
      kind,
      p1,
      p2,
      color,
      label,
      createdAt: Date.now(),
    };
    const next = [...userTrendLines, nextLine];
    saveJson(STORAGE_KEYS.userTrendLinesPrefix + asset, next);
    set({
      userTrendLines: next,
      selectedTrendLineId: nextLine.id,
      selectedLevelId: null,
      selectedMarkerId: null,
      drawMode: 'crosshair',
    });
  },
  updateUserTrendLine: (id, patch) => {
    const { asset, userTrendLines } = get();
    const next = userTrendLines.map((tl) => (tl.id === id ? { ...tl, ...patch } : tl));
    saveJson(STORAGE_KEYS.userTrendLinesPrefix + asset, next);
    set({ userTrendLines: next });
  },
  removeUserTrendLine: (id) => {
    const { asset, userTrendLines, selectedTrendLineId } = get();
    const next = userTrendLines.filter((tl) => tl.id !== id);
    saveJson(STORAGE_KEYS.userTrendLinesPrefix + asset, next);
    set({
      userTrendLines: next,
      selectedTrendLineId: selectedTrendLineId === id ? null : selectedTrendLineId,
    });
  },
  setSelectedTrendLineId: (selectedTrendLineId) =>
    set({ selectedTrendLineId, selectedLevelId: null, selectedMarkerId: null }),

  addUserMarker: (point, label = 'Seg. Cono', color = '#FACC15') => {
    const { asset, userMarkers } = get();
    const nextMarker: UserChartMarker = {
      id: `mk-${Date.now()}-${Math.round(point.price)}`,
      timeSec: point.timeSec,
      price: point.price,
      label,
      color,
      status: 'pendiente',
      createdAt: Date.now(),
    };
    const next = [...userMarkers, nextMarker];
    saveJson(STORAGE_KEYS.userMarkersPrefix + asset, next);
    set({
      userMarkers: next,
      selectedMarkerId: nextMarker.id,
      selectedLevelId: null,
      selectedTrendLineId: null,
      drawMode: 'crosshair',
    });
  },
  updateUserMarker: (id, patch) => {
    const { asset, userMarkers } = get();
    const next = userMarkers.map((mk) => (mk.id === id ? { ...mk, ...patch } : mk));
    saveJson(STORAGE_KEYS.userMarkersPrefix + asset, next);
    set({ userMarkers: next });
  },
  removeUserMarker: (id) => {
    const { asset, userMarkers, selectedMarkerId } = get();
    const next = userMarkers.filter((mk) => mk.id !== id);
    saveJson(STORAGE_KEYS.userMarkersPrefix + asset, next);
    set({
      userMarkers: next,
      selectedMarkerId: selectedMarkerId === id ? null : selectedMarkerId,
    });
  },
  setSelectedMarkerId: (selectedMarkerId) =>
    set({ selectedMarkerId, selectedLevelId: null, selectedTrendLineId: null }),

  clearAllUserDrawings: () => {
    const { asset } = get();
    saveJson(STORAGE_KEYS.userLevelsPrefix + asset, []);
    saveJson(STORAGE_KEYS.userTrendLinesPrefix + asset, []);
    saveJson(STORAGE_KEYS.userMarkersPrefix + asset, []);
    set({
      userLevels: [],
      userTrendLines: [],
      userMarkers: [],
      selectedLevelId: null,
      selectedTrendLineId: null,
      selectedMarkerId: null,
    });
  },

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

  setNewsFeed: (newsItems, newsSources, newsUpdatedAt) =>
    set({ newsItems, newsSources, newsUpdatedAt, newsError: null }),
  setNewsCandles1h: (newsCandles1h) => set({ newsCandles1h }),
  setNewsLoading: (newsLoading) => set({ newsLoading }),
  setNewsError: (newsError) => set({ newsError }),

  recordTrackedSignals: (incoming) =>
    set((state) => {
      if (incoming.length === 0) return state;
      const next = mergeSignalsIntoHistory(state.trackedSignals, incoming);
      saveJson(STORAGE_KEYS.trackedSignals, next);
      return { trackedSignals: next };
    }),
  reevaluateTrackedSignals: (asset, timeframe, marketMode, candles, horizonBars) =>
    set((state) => {
      if (candles.length === 0 || state.trackedSignals.length === 0) return state;
      let changed = false;
      const next = state.trackedSignals.map((sig) => {
        if (
          sig.asset === asset &&
          sig.timeframe === timeframe &&
          sig.marketMode === marketMode
        ) {
          changed = true;
          return evaluateSignalAgainstCandles(sig, candles, horizonBars);
        }
        return sig;
      });
      if (!changed) return state;
      saveJson(STORAGE_KEYS.trackedSignals, next);
      return { trackedSignals: next };
    }),
  replaceTrackedSignals: (signals) => {
    saveJson(STORAGE_KEYS.trackedSignals, signals);
    set({ trackedSignals: signals });
  },
  clearTrackedSignals: (origin) =>
    set((state) => {
      const next = origin
        ? state.trackedSignals.filter((s) => s.origin !== origin)
        : [];
      saveJson(STORAGE_KEYS.trackedSignals, next);
      return { trackedSignals: next };
    }),
}));
