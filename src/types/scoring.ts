import type { Candle, MacroEvent, OrderbookDepthData, SymbolAsset } from './market';

export type ScoringMode = 'perpetual' | 'spot';

export type VpLevelLock = 'auto' | 'POC' | 'VAH' | 'VAL';

export type ScoringParameterId =
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A4'
  | 'B1'
  | 'B2'
  | 'B3'
  | 'B4'
  | 'C1'
  | 'C2'
  | 'C3'
  | 'D1'
  | 'D2'
  | 'D3'
  | 'E1'
  | 'E2'
  | 'F1'
  | 'F2'
  | 'F3';

export type ScoringFamilyId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export type ParameterPoints = 0 | 25 | 50 | 75 | 100;

export type ScoreBandLabel =
  | 'INCOMPLETO'
  | 'Descartar'
  | 'Vigilancia'
  | 'Esperar mejor confirmación'
  | 'Candidata'
  | 'Candidata con alta confluencia';

export type DirectionVerdict = 'CANDIDATA' | 'ESPERAR' | 'BLOQUEADA' | 'DESCARTADA';

export type BlockingSeverity = 'BLOQUEAR' | 'ESPERAR';

export type BlockedCondition = {
  code: string;
  label: string;
  detail: string;
  severity: BlockingSeverity;
};

export type DirectionParamResult = {
  points: ParameterPoints | null; // null => N/D (missing data) or N/A (not applicable)
  applicable: boolean;
  missing: boolean;
  weightedPoints: number;
  maxWeight: number;
  passed: boolean; // points !== null && points >= 75
  reason: string;
};

export type ParameterScoreRow = {
  id: ScoringParameterId;
  family: ScoringFamilyId;
  name: string;
  timeframeLabel: string;
  maxWeight: number;
  observedSummary: string;
  long: DirectionParamResult;
  short: DirectionParamResult;
};

export type FamilySummary = {
  id: ScoringFamilyId;
  name: string;
  maxWeight: number;
  applicableWeight: number;
  longPoints: number;
  shortPoints: number;
  longPassedCount: number;
  shortPassedCount: number;
  totalApplicableCount: number;
};

export type TradeExecutionPlan = {
  direction: 'LONG' | 'SHORT';
  entry: number;
  stopLoss: number;
  takeProfit: number;
  validationLevel: number;
  invalidationMarginAtr: number;
  quantity: number;
  notionalUsd: number;
  requiredMarginUsd: number;
  estimatedLiqPrice: number | null;
  effectiveFundingCostPct: number;
  grossRiskUsd: number;
  grossRewardUsd: number;
  stopCostUsd: number;
  targetCostUsd: number;
  netRiskUsd: number;
  netRewardUsd: number;
  netRR: number;
  costToRiskPct: number;
  spreadPct: number;
  depthAtEntryUsd: number;
};

export type GapImprovementItem = {
  id: ScoringParameterId;
  name: string;
  currentPts: number;
  targetPts: 75 | 100;
  gainTo75: number;
  gainTo100: number;
};

export type GapTo80Summary = {
  pointsNeeded: number;
  topImprovements: GapImprovementItem[];
  gateBlockers: string[];
  summaryText: string;
};

export type TriggerFreshnessInfo = {
  barsSinceBreakout: number | null;
  remainingValidBars: number | null;
  timeStopBars: number;
  expired: boolean;
};

export type DirectionEvaluation = {
  direction: 'LONG' | 'SHORT';
  score: number; // Exact unrounded 0..100
  band: ScoreBandLabel;
  verdict: DirectionVerdict;
  operable: boolean;
  coveragePct: number;
  applicableWeight: number;
  availableWeight: number;
  rawWeightedSum: number;
  diffVsOpposite: number;
  passedCount: number;
  partialCount: number;
  failedCount: number;
  missingCount: number;
  plan: TradeExecutionPlan | null;
  blocks: BlockedCondition[];
  gapTo80: GapTo80Summary;
  triggerFreshness: TriggerFreshnessInfo;
};

export type VolumeProfile7D = {
  poc: number;
  vah: number;
  val: number;
  daysIncluded: number;
  totalVolume: number;
};

export type FundingStats90D = {
  currentRate8h: number;
  percentile: number; // 0..100
  sampleCount: number;
  minRate8h: number;
  maxRate8h: number;
};

export type OpenInterestWindow = {
  latestOiBase: number;
  prev4hOiBase: number;
  changePct4h: number;
  latestOiUsd: number;
  ts: number;
};

export type PivotAnchorOption = {
  ts: number;
  price: number;
  type: 'H' | 'L';
};

export type AuxiliaryMarketContext = {
  bbBandwidthPct: number | null;
  bbSqueezePercentile: number | null;
  bbStateLabel: string;
  rsiDivergence: 'Alcista' | 'Bajista' | 'Ninguna';
  nearestBidWall: { price: number; notionalUsd: number } | null;
  nearestAskWall: { price: number; notionalUsd: number } | null;
  bookImbalancePct: number | null;
  nextMacroEvent: { name: string; hoursAway: number; impact: string } | null;
  swapLiveOiCcy: number | null;
  swapLiveOiUsd: number | null;
};

export type ScoringConfig = {
  mode: ScoringMode;
  capitalUsd: number;
  riskPct: number;
  feePctPerSide: number;
  slippagePctPerSide: number;
  expectedFundingCostPct: number;
  autoFundingFromLive?: boolean;
  leverage?: number;
  dailyLossReached: boolean;
  correlatedRiskExceeded: boolean;
  vpLevelLock?: VpLevelLock;
  avwapAnchorLockTs?: number | null;
  macroEventWindowHours?: number;
  upcomingEvents?: MacroEvent[];
  isReplay?: boolean;
};

export type PersistedScoringConfig = {
  mode: ScoringMode;
  capitalUsd: number;
  riskPct: number;
  feePctPerSide: number;
  slippagePctPerSide: number;
  expectedFundingCostPct: number;
  autoFundingFromLive: boolean;
  leverage: number;
  dailyLossReached: boolean;
  correlatedRiskExceeded: boolean;
  vpLevelLock: VpLevelLock;
  avwapAnchorLockTs: number | null;
  macroEventWindowHours: number;
};

export type MultiTfScoringDataset = {
  asset: SymbolAsset;
  instId: string;
  candles4h: Candle[];
  candles1h: Candle[];
  candles15m: Candle[];
  btcCandles4h: Candle[];
  orderbook: OrderbookDepthData | null;
  oiSeries1h: { ts: number; oiUsd: number }[];
  swapLiveOi?: { oiCcy: number; oiUsd: number; ts: number } | null;
  fundingCurrent8h: number | null;
  fundingHistory8h: number[];
  fetchedAt: number;
};

export type ScoringResult = {
  version: 'v1.1';
  asset: SymbolAsset;
  instId: string;
  mode: ScoringMode;
  evaluatedAt: number;
  isReplay: boolean;
  lastClosed4hTs: number | null;
  lastClosed1hTs: number | null;
  lastClosed15mTs: number | null;
  spot: number;
  btcContextLabel: string;
  ethRelPerf4hPct: number | null;
  volumeProfile7d: VolumeProfile7D | null;
  fundingStats90d: FundingStats90D | null;
  oiWindow: OpenInterestWindow | null;
  regimeLabel: string;
  pivots1h: PivotAnchorOption[];
  activeAvwapAnchor: PivotAnchorOption | null;
  activeVpSelection: {
    lock: VpLevelLock;
    usedLabel: string;
    levelPrice: number | null;
  };
  auxiliary: AuxiliaryMarketContext;
  parameters: ParameterScoreRow[];
  families: FamilySummary[];
  longEval: DirectionEvaluation;
  shortEval: DirectionEvaluation;
  dominantDirection: 'LONG' | 'SHORT' | 'NEUTRAL';
  excludedNotes: string[];
};

export type JournalEntryStatus = 'ABIERTA' | 'CERRADA' | 'OBSERVACION';
export type JournalExitReason = 'TP1' | 'STOP' | 'TEMPORAL_16V' | 'MANUAL';

export type ScoringJournalEntry = {
  id: string;
  ts: number;
  asset: SymbolAsset;
  mode: ScoringMode;
  spot: number;
  longScore: number;
  shortScore: number;
  longVerdict: DirectionVerdict;
  shortVerdict: DirectionVerdict;
  dominant: 'LONG' | 'SHORT' | 'NEUTRAL';
  coveragePct: number;
  netRR: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  blockSummary: string;
  directionTaken?: 'LONG' | 'SHORT';
  chosenScore?: number;
  isControlGroup?: boolean;
  status?: JournalEntryStatus;
  exitReason?: JournalExitReason;
  exitPrice?: number | null;
  closedAt?: number | null;
  resultR?: number | null;
  pnlUsd?: number | null;
  costsInR?: number | null;
  maeR?: number | null;
  mfeR?: number | null;
  riskBudgetUsd?: number | null;
  notes?: string;
};

export type CalibrationBandStats = {
  bandLabel: '[70, 80)' | '[80, 90)' | '[90, 100]' | '< 70';
  closedTrades: number;
  winRatePct: number;
  expectancyR: number;
  avgMaeR: number;
  avgMfeR: number;
};

export type CalibrationGroupStats = {
  label: string;
  closedTrades: number;
  wins: number;
  winRatePct: number;
  expectancyR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  avgCostsR: number;
  totalPnlUsd: number;
  totalR: number;
};

export type CalibrationDashboardStats = {
  totalEntries: number;
  openCount: number;
  closedCount: number;
  filteredStats: CalibrationGroupStats;
  controlStats: CalibrationGroupStats;
  bandStats: CalibrationBandStats[];
};

export type HistoricalAuditRow = {
  ts: number;
  spot: number;
  dominant: 'LONG' | 'SHORT';
  score: number;
  oppScore: number;
  verdict: DirectionVerdict;
  operable: boolean;
  netRR: number | null;
  forwardOutcome: 'TP1' | 'STOP' | 'TEMPORAL_16V' | 'PENDIENTE';
  forwardR: number | null;
  maeR: number | null;
  mfeR: number | null;
};

export type HistoricalAuditSummary = {
  rows: HistoricalAuditRow[];
  evaluatedBars: number;
  candidataCount: number;
  candidataWinRatePct: number;
  candidataExpectancyR: number;
  controlExpectancyR: number;
};
