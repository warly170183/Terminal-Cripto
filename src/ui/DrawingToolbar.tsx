import {
  ArrowUpRight,
  Crosshair,
  Eye,
  EyeOff,
  MapPin,
  Minus,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';

export function DrawingToolbar() {
  const {
    drawMode,
    setDrawMode,
    layers,
    toggleLayer,
    userLevels,
    userTrendLines,
    userMarkers,
    clearAllUserDrawings,
  } = useTerminalStore();

  const totalDrawings = userLevels.length + userTrendLines.length + userMarkers.length;

  return (
    <aside
      aria-label="Herramientas de dibujo"
      className="flex lg:flex-col items-center gap-1.5 p-1.5 bg-[#111621] border-b lg:border-b-0 lg:border-r border-white/[0.08] shrink-0"
    >
      <button
        type="button"
        onClick={() => setDrawMode('crosshair')}
        title="Cursor / Seleccionar marca o línea"
        className={`p-2 rounded-md transition-colors ${
          drawMode === 'crosshair'
            ? 'bg-[#3B82F6] text-white'
            : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]'
        }`}
      >
        <Crosshair className="w-4 h-4" />
      </button>

      <button
        type="button"
        onClick={() => setDrawMode(drawMode === 'horizontal' ? 'crosshair' : 'horizontal')}
        title="Nivel horizontal (1 clic en el gráfico)"
        className={`p-2 rounded-md transition-colors ${
          drawMode === 'horizontal'
            ? 'bg-amber-500 text-slate-950'
            : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]'
        }`}
      >
        <Minus className="w-4 h-4" />
      </button>

      <button
        type="button"
        onClick={() => setDrawMode(drawMode === 'trendline' ? 'crosshair' : 'trendline')}
        title="Línea de tendencia (2 clics: inicio y fin)"
        className={`p-2 rounded-md transition-colors ${
          drawMode === 'trendline'
            ? 'bg-sky-400 text-slate-950'
            : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]'
        }`}
      >
        <TrendingUp className="w-4 h-4" />
      </button>

      <button
        type="button"
        onClick={() => setDrawMode(drawMode === 'ray' ? 'crosshair' : 'ray')}
        title="Rayo de proyección hacia el Cono (2 clics)"
        className={`p-2 rounded-md transition-colors ${
          drawMode === 'ray'
            ? 'bg-violet-400 text-slate-950'
            : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]'
        }`}
      >
        <ArrowUpRight className="w-4 h-4" />
      </button>

      <button
        type="button"
        onClick={() => setDrawMode(drawMode === 'marker' ? 'crosshair' : 'marker')}
        title="Marca de seguimiento de Cono (1 clic sobre velas o cono)"
        className={`p-2 rounded-md transition-colors ${
          drawMode === 'marker'
            ? 'bg-emerald-400 text-slate-950'
            : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]'
        }`}
      >
        <MapPin className="w-4 h-4" />
      </button>

      <div className="w-px h-5 lg:w-5 lg:h-px bg-white/[0.08] mx-1 lg:my-1" />

      <button
        type="button"
        onClick={() => toggleLayer('levels')}
        title={
          layers.levels
            ? 'Ocultar niveles, líneas y marcas'
            : 'Mostrar niveles, líneas y marcas'
        }
        className={`p-2 rounded-md transition-colors ${
          layers.levels
            ? 'text-amber-400 hover:bg-white/[0.05]'
            : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.05]'
        }`}
      >
        {layers.levels ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
      </button>

      {totalDrawings > 0 && (
        <button
          type="button"
          onClick={clearAllUserDrawings}
          title={`Eliminar todos los dibujos (${totalDrawings})`}
          className="relative p-2 rounded-md text-slate-400 hover:text-rose-400 hover:bg-white/[0.05] transition-colors"
        >
          <Trash2 className="w-4 h-4" />
          <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-rose-500/90 text-[9px] font-mono-tabular font-bold text-white flex items-center justify-center leading-none">
            {totalDrawings}
          </span>
        </button>
      )}
    </aside>
  );
}
