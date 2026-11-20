export type SymbolAsset = 'BTC' | 'ETH';

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1H' | '4H' | 'D';

export type OptionsProviderName = 'okx' | 'deribit';

export type Candle = {
  t: number; // Unix timestamp in milliseconds
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

export type OptionRow = {
  instId: string;
  expiry: string; // YYYY-MM-DD (UTC)
  expTs: number; // Expiration timestamp in ms
  strike: number;
  type: 'C' | 'P';
  oi: number; // Open interest in contracts
  iv: number; // Mark implied volatility (decimal, e.g. 0.48 = 48%)
  delta: number; // Black-Scholes delta (dimensionless)
  gamma: number; // Black-Scholes gamma (1 / $)
  mult: number; // Underlying units per contract (e.g. 0.01 BTC on OKX, 1 on Deribit)
};

export type StrikeRow = {
  strike: number;
  gex: number; // USD exposure per 1% move
  dex: number; // USD delta exposure
  oi: number; // Total OI in underlying coin units
  callOi: number;
  putOi: number;
  callGex: number;
  putGex: number;
  callDex: number;
  putDex: number;
};

export type Levels = {
  flip: number | null;
  maxPain: number;
  callWall: number;
  putWall: number;
  netGex: number;
  netGamma: number;
};

export type MacroEvent = {
  id: string;
  date: string; // YYYY-MM-DD
  timeUtc: string; // HH:mm
  name: string;
  ts: number; // ms UTC
};

export type HorizontalLevel = {
  id: string;
  price: number;
  label?: string;
  source: 'prev_high' | 'prev_low' | 'user';
};

export type LayerVisibility = {
  emaClouds: boolean;
  ema9: boolean;
  ema21: boolean;
  vwap: boolean;
  volume: boolean;
  levels: boolean;
  optionLevels: boolean;
  liquidityLevels: boolean;
  cone: boolean;
  events: boolean;
};

export type CandleTheme = 'photo' | 'classic';

export type OrderbookWall = {
  price: number;
  sizeCoins: number;
  notionalUsd: number;
  distancePct: number;
  side: 'bid' | 'ask';
};

export type OrderbookDepthData = {
  bestBid: number;
  bestAsk: number;
  spreadPct: number;
  bidTotalUsd: number;
  askTotalUsd: number;
  imbalancePct: number;
  walls: OrderbookWall[];
  ts: number;
};

export type LiquidityLevelType =
  | 'ASK_WALL'
  | 'BID_WALL'
  | 'BSL'
  | 'SSL'
  | 'POC'
  | 'PDH'
  | 'PDL'
  | 'CALL_WALL'
  | 'PUT_WALL'
  | 'GEX_FLIP';

export type LiquidityLevel = {
  id: string;
  price: number;
  type: LiquidityLevelType;
  side: 'above' | 'below';
  strength: number; // 1..100
  label: string;
  detail: string;
  notionalUsd?: number;
};

export type LiquidityAnalysis = {
  levels: LiquidityLevel[];
  nearestAskWall: OrderbookWall | null;
  nearestBidWall: OrderbookWall | null;
  strongestAskWall: OrderbookWall | null;
  strongestBidWall: OrderbookWall | null;
  nearestBSL: LiquidityLevel | null;
  nearestSSL: LiquidityLevel | null;
  pocPrice: number | null;
  bidTotalUsd: number;
  askTotalUsd: number;
  imbalancePct: number;
};

export type TradeOptionIdea = {
  id: string;
  title: string;
  category: 'Tendencia & Flujo' | 'Barrido de Liquidez' | 'Atracción Gamma / Rango';
  direction: 'LONG' | 'SHORT';
  confidenceScore: number; // 0..100
  entry: number;
  quantity: number;
  notionalUsd: number;
  riskUsd: number;
  takeProfit1: number;
  takeProfit2: number;
  stopLoss: number;
  rr1: number;
  rr2: number;
  tp1ProbPct: number | null;
  tp2ProbPct: number | null;
  tp1Reason: string;
  tp2Reason: string;
  slReason: string;
  summary: string;
  confluences: string[];
};

export type OptionTradeRow = {
  id: string;
  ts: number;
  instId: string;
  expiry: string;
  strike: number;
  type: 'C' | 'P';
  side: 'buy' | 'sell';
  sizeCoins: number;
  iv: number;
  premiumUsd: number;
};

export type TickerSnapshot = {
  instId: string;
  idxPx: number;
  high24h: number;
  low24h: number;
  open24h: number;
  sodUtc0: number;
  ts: number;
};

export type StrategyTemplate =
  | 'ema_cross'
  | 'momentum'
  | 'rsi_reversion'
  | 'bollinger_breakout'
  | 'ema_cloud';

export type BacktestParams = {
  template: StrategyTemplate;
  instId: string; // e.g. BTC-USDT-SWAP, ETH-USDT-SWAP
  timeframe: Timeframe;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  initialCapital: number;
  positionSizePct: number; // 1..100
  commissionPct: number; // per side, e.g. 0.05
  slippagePct: number; // e.g. 0.02
  stopPct: number | null; // optional % stop loss
  targetR: number | null; // optional R multiple take profit
  // Template-specific params
  emaFast: number;
  emaSlow: number;
  momentumBars: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiExit: number;
  rsiShortSymmetric: boolean;
  bbPeriod: number;
  bbStdDev: number;
};

export type BacktestOrder = {
  id: number;
  ts: number;
  side: 'BUY' | 'SELL';
  action: 'ENTRY_LONG' | 'EXIT_LONG' | 'ENTRY_SHORT' | 'EXIT_SHORT';
  price: number;
  qty: number;
  notional: number;
  fee: number;
  reason: string;
};

export type BacktestTrade = {
  id: number;
  direction: 'LONG' | 'SHORT';
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnlUsd: number;
  pnlPct: number;
  feesUsd: number;
  durationBars: number;
  durationHours: number;
  exitReason: string;
};

export type EquityPoint = {
  t: number;
  equity: number;
  benchmark: number;
  drawdownPct: number;
};

export type BacktestMetrics = {
  totalReturnPct: number;
  benchmarkReturnPct: number;
  winDaysPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  avgDrawdownPct: number;
  avgDrawdownDays: number;
  beta: number;
  alphaPct: number; // annualized alpha in %
  tradeCount: number;
  winRatePct: number;
  profitFactor: number;
  expectancyUsd: number;
  expectancyPct: number;
  finalEquity: number;
};

export type BacktestOutput = {
  equityCurve: EquityPoint[];
  orders: BacktestOrder[];
  trades: BacktestTrade[];
  totalMetrics: BacktestMetrics;
  inSampleMetrics: BacktestMetrics; // 70% ajuste
  outOfSampleMetrics: BacktestMetrics; // 30% validación
  splitTimestamp: number;
  candleCount: number;
};

export type SavedBacktestRun = {
  id: string;
  createdAt: number;
  params: BacktestParams;
  totalMetrics: BacktestMetrics;
  inSampleMetrics: BacktestMetrics;
  outOfSampleMetrics: BacktestMetrics;
};
