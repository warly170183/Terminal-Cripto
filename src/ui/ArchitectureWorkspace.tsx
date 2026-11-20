import { useMemo, useState } from 'react';
import {
  Activity,
  Cpu,
  Database,
  GitBranch,
  Layers,
  Network,
  Server,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';

type FlowPreset = 'all' | 'price' | 'options' | 'backtest';
type ArchNodeId =
  | 'external_ws'
  | 'external_rest'
  | 'express_proxy'
  | 'zustand_store'
  | 'calc_indicators'
  | 'calc_options'
  | 'worker_backtest'
  | 'canvas_chart'
  | 'panel_options'
  | 'view_backtest';

interface ArchNodeMeta {
  id: ArchNodeId;
  title: string;
  subtitle: string;
  layer: 'Fuentes' | 'Proxy Backend' | 'Estado & Motores' | 'Interfaz & Canvas';
  flows: FlowPreset[];
  files: string[];
  frequency: string;
  summary: string;
  details: string[];
  formula?: string;
}

const ARCH_NODES: ArchNodeMeta[] = [
  {
    id: 'external_ws',
    title: 'OKX WebSockets',
    subtitle: 'wss://ws.okx.com/ws/v5',
    layer: 'Fuentes',
    flows: ['all', 'price'],
    files: ['src/data/okxMarketClient.ts'],
    frequency: 'Tiempo real (push ms)',
    summary:
      'Mantiene dos canales persistentes con reconexión exponencial automática: "public" para index-tickers y "business" para velas de índice y volumen spot.',
    details: [
      'index-tickers actualiza el precio spot en vivo y recalcula el cierre de la vela activa.',
      'index-candle{tf} sincroniza OHLC sin volumen nativo.',
      'candle{tf} de BTC-USDT / ETH-USDT aporta el volumen real alineado por timestamp.',
    ],
  },
  {
    id: 'external_rest',
    title: 'OKX & Deribit REST + JSON',
    subtitle: 'Velas, Opciones, Trades, Macro',
    layer: 'Fuentes',
    flows: ['all', 'price', 'options', 'backtest'],
    files: ['src/data/optionsProvider.ts', 'src/data/eventsClient.ts'],
    frequency: 'Inicial + cada 30s',
    summary:
      'Provee el histórico paginado de velas (incluyendo scroll infinito hacia el pasado), la cadena completa de opciones, el flujo de trades recientes y el calendario macro.',
    details: [
      'OKX opt-summary usa instFamily=BTC-USD para evitar contratos duplicados _UM.',
      'Deribit aporta alternativa de mayor liquidez si OKX tiene menos de 12 strikes activos.',
      'events.json se fusiona con eventos personalizados guardados en localStorage.',
    ],
  },
  {
    id: 'express_proxy',
    title: 'Servidor Proxy Express',
    subtitle: 'server.ts · Puerto 3000',
    layer: 'Proxy Backend',
    flows: ['all', 'price', 'options', 'backtest'],
    files: ['server.ts'],
    frequency: 'Bajo demanda HTTP',
    summary:
      'Actúa como puente transparente en /api/okx/* y /api/deribit/* para evitar bloqueos CORS desde el navegador y servir Vite en desarrollo o dist/ en producción.',
    details: [
      'Valida cabeceras y reenvía query strings exactas sin almacenar claves privadas.',
      'Expone /api/health para verificación de disponibilidad.',
      'Mantiene los timeouts controlados para que errores transitorios no rompan el último estado válido.',
    ],
  },
  {
    id: 'zustand_store',
    title: 'Store Central Zustand',
    subtitle: 'Estado único reactivo',
    layer: 'Estado & Motores',
    flows: ['all', 'price', 'options'],
    files: ['src/store/terminalStore.ts'],
    frequency: 'Reactivo (in-memory + localStorage)',
    summary:
      'Coordina activo (BTC/ETH), temporalidad, velas ordenadas, cadena de opciones, trades recientes, capas visibles y niveles dibujados por el usuario.',
    details: [
      'prependCandles() fusiona y deduplica velas históricas al hacer scroll a la izquierda.',
      'Persiste capas, tema de velas, proveedor, temporalidad y niveles horizontales por activo.',
      'Conserva la última cadena de opciones válida si ocurre un fallo temporal de red.',
    ],
  },
  {
    id: 'calc_indicators',
    title: 'Motor de Indicadores',
    subtitle: 'EMAs, Nubes & VWAP UTC',
    layer: 'Estado & Motores',
    flows: ['all', 'price'],
    files: ['src/calc/indicators.ts'],
    frequency: 'Por actualización de vela',
    summary:
      'Calcula medias exponenciales (EMA 9, 21, 50), bandas de nubes y el VWAP acumulado con reinicio automático diario a las 00:00 UTC.',
    details: [
      'Las nubes 9/21 y 21/50 cambian de verde a rojo según el cruce de tendencia.',
      'El VWAP pondera precio típico (H+L+C)/3 por volumen dentro de cada sesión UTC.',
      'Calcula máximo y mínimo del día UTC anterior desde velas diarias.',
    ],
    formula: 'VWAP_t = Σ(TP_i · V_i) / Σ(V_i)  desde 00:00 UTC',
  },
  {
    id: 'calc_options',
    title: 'Motor Cuantitativo Opciones',
    subtitle: 'GEX, Skew Cone & Hedge Flow',
    layer: 'Estado & Motores',
    flows: ['all', 'options'],
    files: ['src/calc/options.ts', 'src/calc/cone.ts', 'src/calc/hedgeFlow.ts'],
    frequency: 'Cada 30s + tick spot',
    summary:
      'Agrega exposición gamma/delta por strike, interpola el skew de volatilidad implícita para el cono blanco de rango y estima el flujo de cobertura teórico de dealers.',
    details: [
      'Usa gammaBS/deltaBS estándar (1/$) con multiplicador real (0.01 BTC en OKX, 1 en Deribit) y fallback Black-Scholes.',
      'Localiza GEX Flip por interpolación lineal acumulada, Call Wall, Put Wall y Max Pain.',
      'getStrikeIV() interpola la sonrisa de volatilidad para probabilidades de toque asimétricas.',
    ],
    formula: 'GEX_K = (Γ_c·OI_c − Γ_p·OI_p) · mult · S² · 0.01',
  },
  {
    id: 'worker_backtest',
    title: 'Motor Backtest (Web Worker)',
    subtitle: 'Causal t+1 & Matriz 5×5',
    layer: 'Estado & Motores',
    flows: ['all', 'backtest'],
    files: ['src/calc/backtest.ts', 'src/calc/backtest.worker.ts'],
    frequency: 'Hilo secundario aislado',
    summary:
      'Ejecuta simulaciones históricas de 5 plantillas de estrategia sin bloquear la interfaz, evaluando señales al cierre de t y ejecutando en apertura de t+1.',
    details: [
      'Incluye comisiones por lado, deslizamiento, Stop % y Objetivo R.',
      'Divide automáticamente la muestra en 70% Ajuste y 30% Validación fuera de muestra.',
      'Modo "sweep" calcula 25 combinaciones en paralelo para la matriz de sensibilidad 5×5.',
    ],
    formula: 'Señal(cierre t) → Orden(apertura t+1 · (1 ± slippage))',
  },
  {
    id: 'canvas_chart',
    title: 'ChartWorkspace + Primitives',
    subtitle: 'Lightweight Charts v5 Canvas',
    layer: 'Interfaz & Canvas',
    flows: ['all', 'price', 'options'],
    files: [
      'src/ui/ChartWorkspace.tsx',
      'src/ui/primitives/EmaCloudPrimitive.ts',
      'src/ui/primitives/ExpectedRangeConePrimitive.ts',
      'src/ui/primitives/MacroEventsPrimitive.ts',
    ],
    frequency: '60 FPS Canvas',
    summary:
      'Renderiza velas, nubes EMA, muros GEX/CW/PW, eventos macro, niveles editables y el cono blanco proyectado desde la última vela mediante ISeriesPrimitive.',
    details: [
      'Subgráfico inferior sincronizado de Dealer Hedge Flow (modelo) H_t = −Γ_net · ΔS.',
      'Detecta desplazamiento al borde izquierdo para disparar carga infinita de histórico.',
      'Dibuja probabilidades de toque por strike y curva de atracción hacia Max Pain.',
    ],
  },
  {
    id: 'panel_options',
    title: 'RightOptionsPanel',
    subtitle: 'GEX / MultiMap / Live / Levels',
    layer: 'Interfaz & Canvas',
    flows: ['all', 'options'],
    files: ['src/ui/RightOptionsPanel.tsx'],
    frequency: 'Reactivo cada 30s',
    summary:
      'Escalera interactiva alrededor del spot con modos OI, GEX, DEX y MultiMap (corto plazo vs resto de vencimientos), estructura temporal IV y flujo de trades.',
    details: [
      'Destaca con estrella el strike de mayor exposición y marca el nivel FLIP.',
      'Pestaña Live traza curva SVG de Term Structure IV ATM (%) y últimos cruces de opciones.',
      'Advierte explícitamente el supuesto teórico de dealers cortos en cripto.',
    ],
  },
  {
    id: 'view_backtest',
    title: 'BacktestWorkspace',
    subtitle: 'Equidad, Velas, CSV & Heatmap',
    layer: 'Interfaz & Canvas',
    flows: ['all', 'backtest'],
    files: ['src/ui/BacktestWorkspace.tsx'],
    frequency: 'Bajo demanda + auto-ajuste',
    summary:
      'Interfaz completa de auditoría cuantitativa con curva de capital vs benchmark, gráfico de velas con marcadores de entrada/salida, exportación CSV e historial local.',
    details: [
      'Alerta automática si la muestra tiene menos de 30 operaciones.',
      'Exporta Orders y Trades completos en UTC a formato CSV.',
      'Guarda hasta 10 ejecuciones comparables en localStorage.',
    ],
  },
];

type NodeCoords = { x: number; y: number; w: number; h: number };

const NODE_LAYOUT: Record<ArchNodeId, NodeCoords> = {
  external_ws: { x: 24, y: 42, w: 185, h: 66 },
  external_rest: { x: 24, y: 146, w: 185, h: 72 },
  express_proxy: { x: 255, y: 146, w: 175, h: 72 },
  zustand_store: { x: 478, y: 42, w: 190, h: 66 },
  calc_indicators: { x: 478, y: 132, w: 190, h: 64 },
  calc_options: { x: 478, y: 218, w: 190, h: 66 },
  worker_backtest: { x: 478, y: 306, w: 190, h: 64 },
  canvas_chart: { x: 716, y: 42, w: 200, h: 86 },
  panel_options: { x: 716, y: 162, w: 200, h: 86 },
  view_backtest: { x: 716, y: 284, w: 200, h: 86 },
};

const EDGES: { from: ArchNodeId; to: ArchNodeId; flows: FlowPreset[] }[] = [
  { from: 'external_ws', to: 'zustand_store', flows: ['all', 'price'] },
  { from: 'external_rest', to: 'express_proxy', flows: ['all', 'price', 'options', 'backtest'] },
  { from: 'express_proxy', to: 'zustand_store', flows: ['all', 'price', 'options'] },
  { from: 'express_proxy', to: 'worker_backtest', flows: ['all', 'backtest'] },
  { from: 'zustand_store', to: 'calc_indicators', flows: ['all', 'price'] },
  { from: 'zustand_store', to: 'calc_options', flows: ['all', 'options'] },
  { from: 'zustand_store', to: 'canvas_chart', flows: ['all', 'price'] },
  { from: 'calc_indicators', to: 'canvas_chart', flows: ['all', 'price'] },
  { from: 'calc_options', to: 'canvas_chart', flows: ['all', 'options'] },
  { from: 'calc_options', to: 'panel_options', flows: ['all', 'options'] },
  { from: 'worker_backtest', to: 'view_backtest', flows: ['all', 'backtest'] },
];

type SimulatorTab = 'gex' | 'cone' | 'backtest';

export function ArchitectureWorkspace() {
  const { candles, options, optionTrades, asset, providerName, streamStatus } = useTerminalStore();

  const [flowFilter, setFlowFilter] = useState<FlowPreset>('all');
  const [selectedNodeId, setSelectedNodeId] = useState<ArchNodeId>('calc_options');
  const [simTab, setSimTab] = useState<SimulatorTab>('gex');

  // Simulator 1: GEX & Dealer Flow
  const [simSpot, setSimSpot] = useState(92000);
  const [simSkew, setSimSkew] = useState(15); // % put-heavy vs call-heavy

  // Simulator 2: Skew Cone
  const [coneDte, setConeDte] = useState(14);
  const [coneAtmIv, setConeAtmIv] = useState(52);
  const [coneSkew, setConeSkew] = useState(8);

  const selectedNode = useMemo(
    () => ARCH_NODES.find((n) => n.id === selectedNodeId) ?? ARCH_NODES[0],
    [selectedNodeId]
  );

  // Compute interactive GEX simulator bars
  const gexSimData = useMemo(() => {
    const strikes = [84000, 86000, 88000, 90000, 92000, 94000, 96000, 98000, 100000];
    const putFactor = 1 + simSkew / 100;
    const callFactor = Math.max(0.4, 1 - simSkew / 200);
    const bars = strikes.map((k) => {
      const dist = (k - 92000) / 4000;
      const callGex = Math.exp(-Math.pow(dist - 0.9, 2)) * 95 * callFactor;
      const putGex = -Math.exp(-Math.pow(dist + 0.9, 2)) * 90 * putFactor;
      const net = callGex + putGex;
      return { strike: k, net };
    });

    // Cumulative flip estimate
    let cum = 0;
    let flip = 92000;
    for (let i = 0; i < bars.length; i++) {
      const prev = cum;
      cum += bars[i].net;
      if (i > 0 && ((prev < 0 && cum >= 0) || (prev > 0 && cum <= 0))) {
        const ratio = Math.abs(prev) / (Math.abs(prev) + Math.abs(cum));
        flip = bars[i - 1].strike + ratio * (bars[i].strike - bars[i - 1].strike);
        break;
      }
    }

    const netTotal = bars.reduce((acc, b) => acc + b.net * Math.exp(-Math.abs(b.strike - simSpot) / 14000), 0);
    const regimeDampen = simSpot >= flip;
    const impact1Pct = (netTotal * 0.45).toFixed(1);
    const callWall = bars.reduce((best, b) => (b.net > best.net ? b : best), bars[0]).strike;
    const putWall = bars.reduce((best, b) => (b.net < best.net ? b : best), bars[0]).strike;

    return { bars, flip, regimeDampen, impact1Pct, callWall, putWall };
  }, [simSpot, simSkew]);

  // Compute interactive Cone simulator paths
  const coneSimData = useMemo(() => {
    const steps = 16;
    const tYears = coneDte / 365;
    const ivBase = coneAtmIv / 100;
    const ivUp = Math.max(0.15, ivBase - coneSkew / 200);
    const ivDown = Math.max(0.15, ivBase + coneSkew / 100);
    const spot0 = 92000;
    const maxPainTarget = 94500;

    const points = Array.from({ length: steps + 1 }, (_, i) => {
      const f = i / steps;
      const sqrtT = Math.sqrt(tYears * f);
      const sd95Up = spot0 * Math.exp(ivUp * sqrtT * 1.96);
      const sd80Up = spot0 * Math.exp(ivUp * sqrtT * 1.28);
      const sd50Up = spot0 * Math.exp(ivUp * sqrtT * 0.674);
      const sd50Down = spot0 * Math.exp(-ivDown * sqrtT * 0.674);
      const sd80Down = spot0 * Math.exp(-ivDown * sqrtT * 1.28);
      const sd95Down = spot0 * Math.exp(-ivDown * sqrtT * 1.96);
      const pull = spot0 + (maxPainTarget - spot0) * Math.sin(f * Math.PI * 0.5);
      return { f, sd95Up, sd80Up, sd50Up, sd50Down, sd80Down, sd95Down, pull };
    });

    return {
      points,
      ivUpPct: (ivUp * 100).toFixed(1),
      ivDownPct: (ivDown * 100).toFixed(1),
      final95Up: points[steps].sd95Up,
      final95Down: points[steps].sd95Down,
    };
  }, [coneDte, coneAtmIv, coneSkew]);

  return (
    <div className="flex-1 overflow-y-auto bg-[#0B0E14] text-slate-200">
      <div className="max-w-7xl mx-auto p-4 sm:p-6 space-y-6">
        {/* Header + Real Runtime Context */}
        <section className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1.5 max-w-3xl">
            <div className="flex items-center gap-2 text-xs font-mono-tabular text-sky-400">
              <Network className="w-4 h-4" />
              <span>ARQUITECTURA DEL SISTEMA · PIPELINE EN VIVO</span>
            </div>
            <h1 className="text-lg sm:text-xl font-semibold text-white">
              Cómo funciona Terminal Cripto · Opciones
            </h1>
            <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
              La aplicación combina streaming WebSocket de precios, un proxy Express sin CORS, cálculo
              cuantitativo de opciones en el cliente, renderizado Canvas a 60 FPS y un simulador de
              backtesting causal aislado en un Web Worker. Explora cada nodo del diagrama o manipula
              los simuladores matemáticos interactivos de abajo.
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-2 gap-2 shrink-0 font-mono-tabular text-xs">
            <div className="bg-[#0B0E11] border border-white/[0.08] rounded px-3 py-2">
              <div className="text-[10px] text-slate-500">VELAS ({asset})</div>
              <div className="text-white font-semibold">{candles.length.toLocaleString('en-US')}</div>
            </div>
            <div className="bg-[#0B0E11] border border-white/[0.08] rounded px-3 py-2">
              <div className="text-[10px] text-slate-500">CONTRATOS ({providerName.toUpperCase()})</div>
              <div className="text-sky-300 font-semibold">{options.length.toLocaleString('en-US')}</div>
            </div>
            <div className="bg-[#0B0E11] border border-white/[0.08] rounded px-3 py-2">
              <div className="text-[10px] text-slate-500">TRADES OPCIONES</div>
              <div className="text-emerald-400 font-semibold">{optionTrades.length}</div>
            </div>
            <div className="bg-[#0B0E11] border border-white/[0.08] rounded px-3 py-2">
              <div className="text-[10px] text-slate-500">STREAM OKX WS</div>
              <div
                className={`font-semibold ${
                  streamStatus === 'connected' ? 'text-emerald-400' : 'text-amber-400'
                }`}
              >
                {streamStatus === 'connected' ? 'Conectado' : streamStatus}
              </div>
            </div>
          </div>
        </section>

        {/* Interactive System Flow Graph + Inspector */}
        <section className="bg-[#12161E] border border-white/[0.08] rounded-lg overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-white/[0.08] bg-[#111621]">
            <div>
              <h2 className="text-sm font-semibold text-white">
                1. Mapa interactivo de flujo de datos
              </h2>
              <p className="text-xs text-slate-400">
                Filtra un subsistema o haz clic en cualquier módulo para inspeccionar su función y fórmulas.
              </p>
            </div>

            <div className="flex items-center gap-1 bg-[#0B0E11] p-0.5 rounded-md border border-white/[0.08] overflow-x-auto">
              {(
                [
                  { id: 'all', label: 'Sistema completo' },
                  { id: 'price', label: 'Precio y Velas WS' },
                  { id: 'options', label: 'Opciones, GEX y Cono' },
                  { id: 'backtest', label: 'Backtest Worker' },
                ] as { id: FlowPreset; label: string }[]
              ).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFlowFilter(f.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                    flowFilter === f.id
                      ? 'bg-[#263144] text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px]">
            {/* Interactive SVG Architecture Canvas */}
            <div className="p-3 sm:p-4 bg-[#0B0E11] overflow-x-auto">
              <svg viewBox="0 0 940 395" className="w-full min-w-[740px] h-auto select-none">
                <defs>
                  <marker
                    id="arrowActive"
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L7,3 L0,6 Z" fill="#38BDF8" />
                  </marker>
                  <marker
                    id="arrowDim"
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L7,3 L0,6 Z" fill="#334155" />
                  </marker>
                </defs>

                {/* Layer column titles */}
                {[
                  { x: 116, label: '1. FUENTES EXTERNAS' },
                  { x: 342, label: '2. PROXY EXPRESS' },
                  { x: 573, label: '3. STORE Y CÁLCULO' },
                  { x: 816, label: '4. CANVAS Y PANELES' },
                ].map((col) => (
                  <text
                    key={col.label}
                    x={col.x}
                    y={20}
                    textAnchor="middle"
                    fill="#64748B"
                    fontSize="10"
                    fontWeight="600"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {col.label}
                  </text>
                ))}

                {/* Directed Bezier Edges */}
                {EDGES.map((edge) => {
                  const a = NODE_LAYOUT[edge.from];
                  const b = NODE_LAYOUT[edge.to];
                  const active = edge.flows.includes(flowFilter);
                  const touchesSelected =
                    edge.from === selectedNodeId || edge.to === selectedNodeId;
                  const x1 = a.x + a.w;
                  const y1 = a.y + a.h / 2;
                  const x2 = b.x - 4;
                  const y2 = b.y + b.h / 2;
                  const cx = (x1 + x2) / 2;
                  const d = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;

                  return (
                    <path
                      key={`${edge.from}-${edge.to}`}
                      d={d}
                      fill="none"
                      stroke={touchesSelected ? '#FACC15' : active ? '#38BDF8' : '#1E293B'}
                      strokeWidth={touchesSelected ? 2.2 : active ? 1.6 : 1}
                      strokeDasharray={active && !touchesSelected ? '4 3' : undefined}
                      opacity={active || touchesSelected ? 0.9 : 0.35}
                      markerEnd={active ? 'url(#arrowActive)' : 'url(#arrowDim)'}
                    />
                  );
                })}

                {/* Interactive Node Rects */}
                {ARCH_NODES.map((node) => {
                  const box = NODE_LAYOUT[node.id];
                  const isSelected = node.id === selectedNodeId;
                  const isInFlow = node.flows.includes(flowFilter);
                  const stroke = isSelected
                    ? '#FACC15'
                    : isInFlow
                    ? 'rgba(56, 189, 248, 0.45)'
                    : 'rgba(255, 255, 255, 0.08)';

                  return (
                    <g
                      key={node.id}
                      onClick={() => setSelectedNodeId(node.id)}
                      className="cursor-pointer"
                      opacity={isInFlow || isSelected ? 1 : 0.38}
                    >
                      <rect
                        x={box.x}
                        y={box.y}
                        width={box.w}
                        height={box.h}
                        rx={8}
                        fill={isSelected ? '#192231' : '#12161E'}
                        stroke={stroke}
                        strokeWidth={isSelected ? 2 : 1.2}
                      />
                      <text
                        x={box.x + 12}
                        y={box.y + 24}
                        fill="#F8FAFC"
                        fontSize="11.5"
                        fontWeight="600"
                        fontFamily="Plus Jakarta Sans, sans-serif"
                      >
                        {node.title}
                      </text>
                      <text
                        x={box.x + 12}
                        y={box.y + 42}
                        fill="#94A3B8"
                        fontSize="9.5"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {node.subtitle}
                      </text>
                      {box.h >= 70 && (
                        <text
                          x={box.x + 12}
                          y={box.y + 57}
                          fill="#38BDF8"
                          fontSize="8.5"
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {node.frequency}
                        </text>
                      )}
                    </g>
                  );
                })}
              </svg>
            </div>

            {/* Selected Node Technical Inspector */}
            <aside className="p-4 border-t xl:border-t-0 xl:border-l border-white/[0.08] bg-[#12161E] flex flex-col justify-between gap-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-mono-tabular uppercase tracking-wider text-amber-400">
                    {selectedNode.layer}
                  </span>
                  <span className="text-[10px] font-mono-tabular text-sky-300">
                    {selectedNode.frequency}
                  </span>
                </div>

                <div>
                  <h3 className="text-base font-semibold text-white">{selectedNode.title}</h3>
                  <p className="text-xs text-slate-300 leading-relaxed mt-1">
                    {selectedNode.summary}
                  </p>
                </div>

                {selectedNode.formula && (
                  <div className="bg-[#0B0E11] border border-sky-500/25 rounded px-3 py-2 font-mono-tabular text-[11px] text-sky-300">
                    {selectedNode.formula}
                  </div>
                )}

                <ul className="space-y-1.5 text-xs text-slate-400">
                  {selectedNode.details.map((d) => (
                    <li key={d} className="flex items-start gap-2">
                      <span className="text-emerald-400 mt-0.5">•</span>
                      <span>{d}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="pt-3 border-t border-white/[0.06] space-y-1">
                <div className="text-[10px] font-mono-tabular text-slate-500 uppercase">
                  Módulos implicados
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {selectedNode.files.map((file) => (
                    <code
                      key={file}
                      className="text-[10.5px] font-mono-tabular px-2 py-0.5 rounded bg-[#0B0E11] border border-white/[0.08] text-slate-300"
                    >
                      {file}
                    </code>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        </section>

        {/* Interactive Math & Logic Visualizers */}
        <section className="bg-[#12161E] border border-white/[0.08] rounded-lg overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-white/[0.08] bg-[#111621]">
            <div>
              <h2 className="text-sm font-semibold text-white">
                2. Laboratorio interactivo de los motores de cálculo
              </h2>
              <p className="text-xs text-slate-400">
                Mueve los controles para ver cómo cambian en tiempo real la exposición gamma, el cono
                de volatilidad y la ejecución causal.
              </p>
            </div>

            <div className="flex items-center gap-1 bg-[#0B0E11] p-0.5 rounded-md border border-white/[0.08]">
              {(
                [
                  { id: 'gex', label: 'GEX & Hedge Flow' },
                  { id: 'cone', label: 'Cono con Skew' },
                  { id: 'backtest', label: 'Causalidad t+1' },
                ] as { id: SimulatorTab; label: string }[]
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSimTab(tab.id)}
                  className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                    simTab === tab.id
                      ? 'bg-[#3B82F6] text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {simTab === 'gex' && (
            <div className="p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-[1.25fr_1fr] gap-5 items-center">
              <div className="bg-[#0B0E11] border border-white/[0.08] rounded-lg p-3">
                <svg viewBox="0 0 540 230" className="w-full h-auto">
                  {/* Zero baseline */}
                  <line x1="36" y1="115" x2="520" y2="115" stroke="#334155" strokeWidth="1" />
                  <text x="10" y="34" fill="#10B981" fontSize="9" fontFamily="JetBrains Mono">
                    +GEX
                  </text>
                  <text x="10" y="205" fill="#F43F5E" fontSize="9" fontFamily="JetBrains Mono">
                    −GEX
                  </text>

                  {/* Bars */}
                  {gexSimData.bars.map((b, idx) => {
                    const x = 48 + idx * 52;
                    const barW = 34;
                    const maxH = 88;
                    const h = Math.min(maxH, (Math.abs(b.net) / 110) * maxH);
                    const y = b.net >= 0 ? 115 - h : 115;
                    const fill =
                      b.strike === gexSimData.callWall
                        ? '#10B981'
                        : b.strike === gexSimData.putWall
                        ? '#F43F5E'
                        : b.net >= 0
                        ? '#2D5A4C'
                        : '#3D5B82';

                    return (
                      <g key={b.strike}>
                        <rect x={x} y={y} width={barW} height={h} rx="2" fill={fill} />
                        <text
                          x={x + barW / 2}
                          y={222}
                          textAnchor="middle"
                          fill="#94A3B8"
                          fontSize="9"
                          fontFamily="JetBrains Mono"
                        >
                          {b.strike / 1000}k
                        </text>
                      </g>
                    );
                  })}

                  {/* Flip dashed vertical marker */}
                  {(() => {
                    const flipX = 48 + ((gexSimData.flip - 84000) / 16000) * (8 * 52) + 17;
                    const spotX = 48 + ((simSpot - 84000) / 16000) * (8 * 52) + 17;
                    return (
                      <>
                        <line
                          x1={flipX}
                          y1={18}
                          x2={flipX}
                          y2={205}
                          stroke="#FACC15"
                          strokeWidth="1.5"
                          strokeDasharray="4 3"
                        />
                        <text
                          x={flipX}
                          y={13}
                          textAnchor="middle"
                          fill="#FACC15"
                          fontSize="9.5"
                          fontWeight="700"
                          fontFamily="JetBrains Mono"
                        >
                          FLIP ${(gexSimData.flip / 1000).toFixed(1)}k
                        </text>

                        <line
                          x1={spotX}
                          y1={24}
                          x2={spotX}
                          y2={205}
                          stroke="#FFFFFF"
                          strokeWidth="2"
                        />
                        <circle cx={spotX} cy={115} r="4.5" fill="#FFFFFF" />
                        <text
                          x={spotX}
                          y={202}
                          textAnchor="middle"
                          fill="#FFFFFF"
                          fontSize="9.5"
                          fontWeight="700"
                          fontFamily="JetBrains Mono"
                        >
                          SPOT {(simSpot / 1000).toFixed(1)}k
                        </text>
                      </>
                    );
                  })()}
                </svg>
              </div>

              <div className="space-y-4">
                <div className="space-y-3 bg-[#0B0E11] border border-white/[0.08] rounded-lg p-3.5 text-xs">
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-slate-400">Precio Spot Simulado</span>
                      <span className="font-mono-tabular text-white font-semibold">
                        ${simSpot.toLocaleString('en-US')}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={85000}
                      max={99000}
                      step={500}
                      value={simSpot}
                      onChange={(e) => setSimSpot(Number(e.target.value))}
                      className="w-full accent-[#3B82F6]"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-slate-400">Sesgo Put / Call OI</span>
                      <span className="font-mono-tabular text-sky-300 font-semibold">
                        {simSkew >= 0 ? `+${simSkew}% Puts` : `${simSkew}% Calls`}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={-40}
                      max={50}
                      step={5}
                      value={simSkew}
                      onChange={(e) => setSimSkew(Number(e.target.value))}
                      className="w-full accent-[#3B82F6]"
                    />
                  </div>
                </div>

                <div
                  className={`border rounded-lg p-3.5 text-xs space-y-1.5 ${
                    gexSimData.regimeDampen
                      ? 'bg-emerald-500/10 border-emerald-500/25'
                      : 'bg-rose-500/10 border-rose-500/25'
                  }`}
                >
                  <div
                    className={`font-semibold ${
                      gexSimData.regimeDampen ? 'text-emerald-300' : 'text-rose-300'
                    }`}
                  >
                    {gexSimData.regimeDampen
                      ? 'Régimen: Dealers dampen moves (Gamma Positiva)'
                      : 'Régimen: Dealers chase (Gamma Negativa)'}
                  </div>
                  <p className="text-slate-300 leading-relaxed">
                    {gexSimData.regimeDampen
                      ? 'Por encima del GEX Flip, los creadores de mercado cubren vendiendo en subidas y comprando en caídas, actuando como amortiguador hacia el Call Wall.'
                      : 'Por debajo del GEX Flip, la cobertura delta obliga a vender en caídas y comprar en rebotes, amplificando la volatilidad realizada.'}
                  </p>
                  <div className="pt-1 font-mono-tabular text-[11px] text-slate-200 flex flex-wrap gap-x-4 gap-y-1">
                    <span>CW: ${(gexSimData.callWall / 1000).toFixed(0)}k</span>
                    <span>PW: ${(gexSimData.putWall / 1000).toFixed(0)}k</span>
                    <span>Flujo ±1%: ~${gexSimData.impact1Pct}M (modelo)</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {simTab === 'cone' && (
            <div className="p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-[1.25fr_1fr] gap-5 items-center">
              <div className="bg-[#0B0E11] border border-white/[0.08] rounded-lg p-3">
                <svg viewBox="0 0 540 230" className="w-full h-auto">
                  {(() => {
                    const minP = 68000;
                    const maxP = 120000;
                    const toX = (f: number) => 95 + f * 415;
                    const toY = (p: number) =>
                      20 + (1 - (Math.min(maxP, Math.max(minP, p)) - minP) / (maxP - minP)) * 185;

                    const poly = (topKey: 'sd95Up' | 'sd80Up' | 'sd50Up', botKey: 'sd95Down' | 'sd80Down' | 'sd50Down') => {
                      const topPts = coneSimData.points.map((pt) => `${toX(pt.f)},${toY(pt[topKey])}`);
                      const botPts = [...coneSimData.points]
                        .reverse()
                        .map((pt) => `${toX(pt.f)},${toY(pt[botKey])}`);
                      return [...topPts, ...botPts].join(' ');
                    };

                    const pullPath = coneSimData.points
                      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${toX(pt.f)} ${toY(pt.pull)}`)
                      .join(' ');

                    return (
                      <>
                        {/* Historical mini candles stub on left */}
                        {[
                          { x: 24, o: 93800, c: 92900 },
                          { x: 42, o: 92900, c: 93300 },
                          { x: 60, o: 93300, c: 91700 },
                          { x: 78, o: 91700, c: 92000 },
                        ].map((bar) => {
                          const top = toY(Math.max(bar.o, bar.c));
                          const bot = toY(Math.min(bar.o, bar.c));
                          return (
                            <rect
                              key={bar.x}
                              x={bar.x}
                              y={top}
                              width="10"
                              height={Math.max(4, bot - top)}
                              fill={bar.c >= bar.o ? '#00E676' : '#38BDF8'}
                            />
                          );
                        })}

                        {/* 95%, 80%, 50% White Cone Bands */}
                        <polygon points={poly('sd95Up', 'sd95Down')} fill="rgba(255,255,255,0.09)" stroke="rgba(255,255,255,0.22)" strokeDasharray="3 3" />
                        <polygon points={poly('sd80Up', 'sd80Down')} fill="rgba(255,255,255,0.14)" />
                        <polygon points={poly('sd50Up', 'sd50Down')} fill="rgba(255,255,255,0.22)" />

                        {/* Max Pain Pull Curve */}
                        <path d={pullPath} fill="none" stroke="#FFFFFF" strokeWidth="2" />

                        <circle cx={toX(0)} cy={toY(92000)} r="4" fill="#FFFFFF" />
                        <text x={toX(1) - 6} y={toY(coneSimData.final95Up) - 6} textAnchor="end" fill="#E2E8F0" fontSize="9.5" fontFamily="JetBrains Mono">
                          95% Sup: ${Math.round(coneSimData.final95Up).toLocaleString('en-US')}
                        </text>
                        <text x={toX(1) - 6} y={toY(coneSimData.final95Down) + 12} textAnchor="end" fill="#E2E8F0" fontSize="9.5" fontFamily="JetBrains Mono">
                          95% Inf: ${Math.round(coneSimData.final95Down).toLocaleString('en-US')}
                        </text>
                        <text x={toX(1) - 6} y={toY(94500) - 7} textAnchor="end" fill="#FACC15" fontSize="9.5" fontFamily="JetBrains Mono">
                          Max Pain pull: $94,500
                        </text>
                      </>
                    );
                  })()}
                </svg>
              </div>

              <div className="space-y-4">
                <div className="space-y-3 bg-[#0B0E11] border border-white/[0.08] rounded-lg p-3.5 text-xs">
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-slate-400">Días al vencimiento (DTE)</span>
                      <span className="font-mono-tabular text-white font-semibold">{coneDte}d</span>
                    </div>
                    <input
                      type="range"
                      min={2}
                      max={45}
                      step={1}
                      value={coneDte}
                      onChange={(e) => setConeDte(Number(e.target.value))}
                      className="w-full accent-[#3B82F6]"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-slate-400">IV ATM (%)</span>
                      <span className="font-mono-tabular text-sky-300 font-semibold">{coneAtmIv}%</span>
                    </div>
                    <input
                      type="range"
                      min={25}
                      max={100}
                      step={1}
                      value={coneAtmIv}
                      onChange={(e) => setConeAtmIv(Number(e.target.value))}
                      className="w-full accent-[#3B82F6]"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between mb-1">
                      <span className="text-slate-400">Skew de volatilidad (Put − Call)</span>
                      <span className="font-mono-tabular text-amber-300 font-semibold">+{coneSkew}%</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={25}
                      step={1}
                      value={coneSkew}
                      onChange={(e) => setConeSkew(Number(e.target.value))}
                      className="w-full accent-[#3B82F6]"
                    />
                  </div>
                </div>

                <div className="bg-[#0B0E11] border border-white/[0.08] rounded-lg p-3.5 text-xs space-y-2">
                  <div className="font-semibold text-white">Bandas asimétricas con Skew</div>
                  <p className="text-slate-400 leading-relaxed">
                    El cono arranca exactamente en la última vela y usa <code className="text-sky-300">getStrikeIV()</code>{' '}
                    para interpolar la volatilidad real de puts OTM (<strong className="text-white">{coneSimData.ivDownPct}%</strong>)
                    frente a calls OTM (<strong className="text-white">{coneSimData.ivUpPct}%</strong>).
                  </p>
                  <div className="font-mono-tabular text-[11px] text-sky-300">
                    P(toque K) ≈ 2 · (1 − Φ(|ln(K/S)| / (σ(K)·√T)))
                  </div>
                </div>
              </div>
            </div>
          )}

          {simTab === 'backtest' && (
            <div className="p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-2 gap-5 items-center">
              <div className="bg-[#0B0E11] border border-white/[0.08] rounded-lg p-3">
                <svg viewBox="0 0 520 210" className="w-full h-auto">
                  {/* Timeline bars t-1, t, t+1 */}
                  <line x1="30" y1="150" x2="490" y2="150" stroke="#334155" strokeWidth="1" />

                  {/* Bar t-1 */}
                  <rect x="65" y="88" width="24" height="36" fill="#38BDF8" rx="2" />
                  <text x="77" y="168" textAnchor="middle" fill="#64748B" fontSize="10" fontFamily="JetBrains Mono">
                    t − 1
                  </text>

                  {/* Bar t: Signal evaluation at close */}
                  <rect x="190" y="64" width="24" height="58" fill="#00E676" rx="2" />
                  <circle cx="202" cy="64" r="5" fill="#FACC15" />
                  <text x="202" y="42" textAnchor="middle" fill="#FACC15" fontSize="10" fontWeight="700">
                    1. Señal al cierre t
                  </text>
                  <text x="202" y="168" textAnchor="middle" fill="#E2E8F0" fontSize="10" fontFamily="JetBrains Mono">
                    t (cierre)
                  </text>

                  {/* Causal arrow t -> t+1 */}
                  <path
                    d="M 218 64 C 265 40, 290 40, 326 68"
                    fill="none"
                    stroke="#38BDF8"
                    strokeWidth="2"
                    strokeDasharray="4 2"
                  />

                  {/* Bar t+1: Execution at open */}
                  <rect x="330" y="54" width="24" height="48" fill="#00E676" rx="2" />
                  <circle cx="342" cy="102" r="5" fill="#38BDF8" />
                  <text x="342" y="34" textAnchor="middle" fill="#38BDF8" fontSize="10" fontWeight="700">
                    2. Ejecución apertura t+1
                  </text>
                  <text x="342" y="122" textAnchor="middle" fill="#94A3B8" fontSize="9" fontFamily="JetBrains Mono">
                    + comisión + slippage
                  </text>
                  <text x="342" y="168" textAnchor="middle" fill="#E2E8F0" fontSize="10" fontFamily="JetBrains Mono">
                    t + 1 (open)
                  </text>

                  {/* 70% / 30% Split bar */}
                  <rect x="40" y="182" width="308" height="14" fill="#1D4ED8" rx="2" />
                  <rect x="350" y="182" width="130" height="14" fill="#059669" rx="2" />
                  <text x="194" y="192.5" textAnchor="middle" fill="#FFFFFF" fontSize="9" fontWeight="600">
                    70% Ajuste (In-Sample)
                  </text>
                  <text x="415" y="192.5" textAnchor="middle" fill="#FFFFFF" fontSize="9" fontWeight="600">
                    30% Validación
                  </text>
                </svg>
              </div>

              <div className="space-y-3 text-xs">
                <div className="bg-[#0B0E11] border border-white/[0.08] rounded-lg p-3.5 space-y-2">
                  <div className="font-semibold text-white">Protección anti-autoengaño</div>
                  <ul className="space-y-1.5 text-slate-300">
                    <li>
                      <strong className="text-amber-300">Cero sesgo futuro:</strong> los indicadores se
                      calculan solo hasta la barra <code className="font-mono-tabular">t</code> y la orden
                      se ejecuta en <code className="font-mono-tabular">open[t+1]</code>.
                    </li>
                    <li>
                      <strong className="text-sky-300">Costes realistas:</strong> cada operación descuenta
                      comisión por lado y deslizamiento direccional, además de evaluar stops/objetivos intrabar.
                    </li>
                    <li>
                      <strong className="text-emerald-300">Validación fuera de muestra:</strong> la matriz
                      5×5 en <em>Sensibilidad</em> compara simultáneamente el tramo 70% frente al 30%.
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Key Technical Design Choices */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-white">
              <Server className="w-4 h-4 text-sky-400" />
              <span>Por qué Express Proxy + WebSockets</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Los endpoints REST de OKX y Deribit bloquean peticiones CORS directas desde navegadores.
              <code className="text-slate-300"> server.ts</code> enruta <code className="text-slate-300">/api/*</code>{' '}
              sin almacenar secretos mientras los WebSockets se conectan directo para mínima latencia.
            </p>
          </div>

          <div className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-white">
              <Layers className="w-4 h-4 text-emerald-400" />
              <span>Por qué ISeriesPrimitive en Canvas</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              Dibujar las nubes EMA, el cono blanco con sus probabilidades de toque y las chapas de
              eventos directamente sobre el Canvas de Lightweight Charts garantiza alineación exacta al
              pixel durante zoom y scroll infinito sin desincronización de capas SVG.
            </p>
          </div>

          <div className="bg-[#12161E] border border-white/[0.08] rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-white">
              <Cpu className="w-4 h-4 text-amber-400" />
              <span>Por qué gammaBS y Web Worker</span>
            </div>
            <p className="text-xs text-slate-400 leading-relaxed">
              En OKX el campo <code className="text-slate-300">gamma</code> viene en escala inversa;
              usamos <code className="text-slate-300">gammaBS</code> y <code className="text-slate-300">deltaBS</code>{' '}
              con respaldo analítico Black-Scholes. Y el barrido 5×5 de 25 backtests corre en Web Worker
              para no congelar la UI.
            </p>
          </div>
        </section>

        {/* Unused icons guard / clean footer summary */}
        <footer className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500 border-t border-white/[0.06] pt-3">
          <span className="inline-flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5" />
            <span>Datos de mercado reales (OKX &amp; Deribit) · Sin datos simulados</span>
          </span>
          <span className="inline-flex items-center gap-3">
            <span className="inline-flex items-center gap-1">
              <Activity className="w-3.5 h-3.5" />
              <span>Cálculo cuantitativo local</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <GitBranch className="w-3.5 h-3.5" />
              <span>Causalidad estricta t → t+1</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>Canvas 60 FPS</span>
            </span>
            <span className="inline-flex items-center gap-1">
              <ShieldAlert className="w-3.5 h-3.5" />
              <span>Uso analítico (sin ejecución de órdenes)</span>
            </span>
          </span>
        </footer>
      </div>
    </div>
  );
}
