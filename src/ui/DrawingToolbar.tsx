import { Crosshair, Eye, EyeOff, Minus, Trash2 } from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';

export function DrawingToolbar() {
  const { drawMode, setDrawMode, layers, toggleLayer, userLevels, clearUserLevels } =
    useTerminalStore();

  return (
    <aside
      aria-label="Herramientas de dibujo"
      className="flex lg:flex-col items-center gap-1.5 p-1.5 bg-[#111621] border-b lg:border-b-0 lg:border-r border-white/[0.08] shrink-0"
    >
      <button
        type="button"
        onClick={() => setDrawMode('crosshair')}
        title="Cursor / Cruz"
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
        title="Dibujar nivel horizontal (clic en el gráfico)"
        className={`p-2 rounded-md transition-colors ${
          drawMode === 'horizontal'
            ? 'bg-amber-500 text-slate-950'
            : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.05]'
        }`}
      >
        <Minus className="w-4 h-4" />
      </button>

      <div className="w-px h-5 lg:w-5 lg:h-px bg-white/[0.08] mx-1 lg:my-1" />

      <button
        type="button"
        onClick={() => toggleLayer('levels')}
        title={layers.levels ? 'Ocultar niveles horizontales' : 'Mostrar niveles horizontales'}
        className={`p-2 rounded-md transition-colors ${
          layers.levels
            ? 'text-amber-400 hover:bg-white/[0.05]'
            : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.05]'
        }`}
      >
        {layers.levels ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
      </button>

      {userLevels.length > 0 && (
        <button
          type="button"
          onClick={clearUserLevels}
          title="Eliminar todos los niveles dibujados"
          className="p-2 rounded-md text-slate-400 hover:text-rose-400 hover:bg-white/[0.05] transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </aside>
  );
}
