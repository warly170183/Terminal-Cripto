import { useEffect, useRef } from 'react';
import { getPreviousDayHighLow } from './calc/indicators';
import { fetchMacroEvents } from './data/eventsClient';
import {
  OkxLiveStream,
  fetchIndexCandles,
  fetchIndexTicker,
  fetchOrderbookWalls,
  fetchPrevDayCandles,
} from './data/okxMarketClient';
import { createOptionsProvider } from './data/optionsProvider';
import { useTerminalStore } from './store/terminalStore';
import { ArchitectureWorkspace } from './ui/ArchitectureWorkspace';
import { BacktestWorkspace } from './ui/BacktestWorkspace';
import { ChartWorkspace } from './ui/ChartWorkspace';
import { DrawingToolbar } from './ui/DrawingToolbar';
import { EventsModal } from './ui/EventsModal';
import { RightOptionsPanel } from './ui/RightOptionsPanel';
import { ScoringWorkspace } from './ui/ScoringWorkspace';
import { TechnicalAnalysisWorkspace } from './ui/TechnicalAnalysisWorkspace';
import { TopBar } from './ui/TopBar';
import { TradingOptionsWorkspace } from './ui/TradingOptionsWorkspace';

export default function App() {
  const {
    activeTab,
    asset,
    timeframe,
    providerName,
    setCandles,
    setCandlesLoading,
    upsertCandle,
    updateSpotVolume,
    setPrevDayHighLow,
    setTicker,
    setStreamStatus,
    setCandlesError,
    setOptionsData,
    setOptionTrades,
    setOrderbook,
    setOptionsLoading,
    setOptionsError,
    setEvents,
  } = useTerminalStore();

  const streamRef = useRef<OkxLiveStream | null>(null);
  const latestSpotRef = useRef<number>(0);

  // 1. Load local events.json once on startup
  useEffect(() => {
    void fetchMacroEvents().then(setEvents);
  }, [setEvents]);

  // 2. Load initial candles + prev day H/L + ticker + start WebSocket stream when asset or timeframe changes
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    async function loadInitialMarketData() {
      setCandlesError(null);
      setCandlesLoading(true);
      try {
        const [candles, dailyCandles, tickerSnap] = await Promise.all([
          fetchIndexCandles(asset, timeframe, 300, undefined, ctrl.signal),
          fetchPrevDayCandles(asset, ctrl.signal),
          fetchIndexTicker(asset, ctrl.signal),
        ]);
        if (cancelled) return;

        setCandles(candles, `${asset}|${timeframe}`);
        const { prevHigh, prevLow } = getPreviousDayHighLow(dailyCandles);
        setPrevDayHighLow(prevHigh, prevLow);

        if (tickerSnap) {
          latestSpotRef.current = tickerSnap.idxPx;
          setTicker(tickerSnap);
        } else if (candles.length > 0) {
          latestSpotRef.current = candles[candles.length - 1].c;
        }
      } catch (err) {
        if (!cancelled && (err as Error).name !== 'AbortError') {
          setCandlesError(
            err instanceof Error ? err.message : 'Error conectando con OKX REST API'
          );
        }
      } finally {
        if (!cancelled) {
          setCandlesLoading(false);
        }
      }
    }

    void loadInitialMarketData();

    if (streamRef.current) {
      streamRef.current.stop();
    }
    const stream = new OkxLiveStream(asset, timeframe, {
      onTicker: (t) => {
        latestSpotRef.current = t.idxPx;
        setTicker(t);
      },
      onIndexCandle: (c) => {
        latestSpotRef.current = c.c;
        upsertCandle(c);
      },
      onSpotVolume: (ts, vol) => updateSpotVolume(ts, vol),
      onStatusChange: (st) => setStreamStatus(st),
    });
    stream.start();
    streamRef.current = stream;

    return () => {
      cancelled = true;
      ctrl.abort();
      stream.stop();
      streamRef.current = null;
    };
  }, [
    asset,
    timeframe,
    setCandles,
    setCandlesLoading,
    setPrevDayHighLow,
    setTicker,
    upsertCandle,
    updateSpotVolume,
    setStreamStatus,
    setCandlesError,
  ]);

  // 3. Poll OptionsProvider every 30s (REST) keeping last valid chain on transient error
  useEffect(() => {
    let cancelled = false;
    const provider = createOptionsProvider(providerName);

    async function refreshOptions() {
      setOptionsLoading(true);
      try {
        const [chainRes, tradesRes] = await Promise.allSettled([
          provider.fetchChain(asset, latestSpotRef.current),
          provider.fetchRecentTrades(asset),
        ]);
        if (cancelled) return;

        if (chainRes.status === 'fulfilled') {
          setOptionsData(chainRes.value, Date.now());
        } else {
          const reason = chainRes.reason;
          setOptionsError(
            reason instanceof Error ? reason.message : `Error al consultar ${providerName.toUpperCase()}`
          );
        }

        if (tradesRes.status === 'fulfilled') {
          setOptionTrades(tradesRes.value);
        }
      } finally {
        if (!cancelled) {
          setOptionsLoading(false);
        }
      }
    }

    void refreshOptions();
    const intervalId = setInterval(() => {
      void refreshOptions();
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [asset, providerName, setOptionsData, setOptionTrades, setOptionsLoading, setOptionsError]);

  // 4. Poll OKX Orderbook Depth (Liquidity Walls) every 15s
  useEffect(() => {
    let cancelled = false;
    const ctrl = new AbortController();

    async function refreshBook() {
      try {
        const book = await fetchOrderbookWalls(asset, ctrl.signal);
        if (!cancelled && book) {
          setOrderbook(book);
        }
      } catch {
        // ignore transient orderbook errors
      }
    }

    void refreshBook();
    const intervalId = setInterval(() => {
      void refreshBook();
    }, 15_000);

    return () => {
      cancelled = true;
      ctrl.abort();
      clearInterval(intervalId);
    };
  }, [asset, setOrderbook]);

  return (
    <div className="min-h-screen lg:h-screen w-full flex flex-col bg-[#0B0E14] text-[#E5E7EB] lg:overflow-hidden">
      <TopBar />

      {activeTab === 'chart' || activeTab === 'main_chart' ? (
        <main className="flex flex-col lg:flex-row flex-1 min-h-0">
          {activeTab === 'chart' && <DrawingToolbar />}
          <ChartWorkspace mainChartOnly={activeTab === 'main_chart'} />
          {activeTab === 'chart' && <RightOptionsPanel />}
        </main>
      ) : activeTab === 'technical' ? (
        <main className="flex flex-col flex-1 min-h-0">
          <TechnicalAnalysisWorkspace />
        </main>
      ) : activeTab === 'trading_options' ? (
        <main className="flex flex-col flex-1 min-h-0">
          <TradingOptionsWorkspace />
        </main>
      ) : activeTab === 'scoring' ? (
        <main className="flex flex-col flex-1 min-h-0">
          <ScoringWorkspace />
        </main>
      ) : activeTab === 'backtest' ? (
        <main className="flex flex-col flex-1 min-h-0">
          <BacktestWorkspace />
        </main>
      ) : (
        <main className="flex flex-col flex-1 min-h-0">
          <ArchitectureWorkspace />
        </main>
      )}

      <EventsModal />
    </div>
  );
}
