import type { BacktestParams, Candle } from '../types/market';
import { runBacktest, runSensitivitySweep } from './backtest';

type WorkerRequest =
  | { kind?: 'run'; candles: Candle[]; params: BacktestParams }
  | { kind: 'sweep'; candles: Candle[]; params: BacktestParams };

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { candles, params } = event.data;
  if (event.data.kind === 'sweep') {
    const grid = runSensitivitySweep(candles, params);
    self.postMessage({ kind: 'sweep', grid });
    return;
  }
  const result = runBacktest(candles, params);
  self.postMessage({ kind: 'run', result });
};
