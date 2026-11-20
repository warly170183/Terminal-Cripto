import { useState } from 'react';
import { Download, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { clearLocalEvents, fetchMacroEvents, saveLocalEvents } from '../data/eventsClient';
import { useTerminalStore } from '../store/terminalStore';
import type { MacroEvent } from '../types/market';

export function EventsModal() {
  const { events, setEvents, eventsModalOpen, setEventsModalOpen } = useTerminalStore();

  const [name, setName] = useState('');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [timeUtc, setTimeUtc] = useState('13:30');
  const [formError, setFormError] = useState<string | null>(null);

  if (!eventsModalOpen) return null;

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('Introduce el nombre del evento (p. ej. FOMC, CPI).');
      return;
    }
    const ts = Date.parse(`${date}T${timeUtc}:00Z`);
    if (!Number.isFinite(ts)) {
      setFormError('Fecha u hora UTC inválida.');
      return;
    }
    setFormError(null);
    const nextEvt: MacroEvent = {
      id: `evt-${Date.now()}`,
      date,
      timeUtc,
      name: trimmed,
      ts,
    };
    const next = [...events, nextEvt].sort((a, b) => a.ts - b.ts);
    setEvents(next);
    saveLocalEvents(next);
    setName('');
  };

  const handleDelete = (id: string) => {
    const next = events.filter((e) => e.id !== id);
    setEvents(next);
    saveLocalEvents(next);
  };

  const handleResetDefault = async () => {
    clearLocalEvents();
    const loaded = await fetchMacroEvents();
    setEvents(loaded);
  };

  const handleDownloadJson = () => {
    const payload = events.map(({ id, date: d, timeUtc: t, name: n }) => ({
      id,
      date: d,
      timeUtc: t,
      name: n,
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'events.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg bg-[#12161E] border border-white/[0.12] rounded-lg shadow-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08]">
          <div>
            <h2 className="text-sm font-semibold text-white">Calendario de eventos macro (UTC)</h2>
            <p className="text-[11px] text-slate-400">
              Se guarda en el navegador y se muestra como chapas sobre el volumen.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEventsModalOpen(false)}
            className="text-slate-400 hover:text-white p-1 rounded"
            aria-label="Cerrar gestor de eventos"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleAdd} className="p-4 border-b border-white/[0.08] space-y-2.5">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_130px_90px] gap-2 text-xs">
            <input
              type="text"
              placeholder="Nombre (ej. CPI, FOMC, Fed Chair)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-[#0B0E11] border border-white/[0.1] rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-[#3B82F6]"
            />
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="bg-[#0B0E11] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
            />
            <input
              type="time"
              value={timeUtc}
              onChange={(e) => setTimeUtc(e.target.value)}
              className="bg-[#0B0E11] border border-white/[0.1] rounded px-2 py-1.5 text-slate-200 font-mono-tabular"
            />
          </div>
          {formError && <p className="text-[11px] text-rose-400">{formError}</p>}
          <div className="flex items-center justify-between gap-2">
            <button
              type="submit"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-[#3B82F6] hover:bg-blue-500 text-xs font-medium text-white"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Añadir evento</span>
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleResetDefault()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-[#0B0E11] border border-white/[0.1] hover:bg-white/[0.05] text-[11px] text-slate-300"
              >
                <RotateCcw className="w-3 h-3" />
                <span>Restaurar JSON</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadJson}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-[#0B0E11] border border-white/[0.1] hover:bg-white/[0.05] text-[11px] text-slate-300"
              >
                <Download className="w-3 h-3" />
                <span>Descargar events.json</span>
              </button>
            </div>
          </div>
        </form>

        <div className="flex-1 overflow-y-auto divide-y divide-white/[0.05]">
          {events.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">
              Sin eventos configurados. La barra superior permanece oculta.
            </div>
          ) : (
            events.map((ev) => (
              <div
                key={ev.id}
                className="flex items-center justify-between px-4 py-2 text-xs hover:bg-white/[0.03]"
              >
                <div className="flex items-center gap-3">
                  <span className="px-2 py-0.5 rounded bg-[#CA8A04] text-[#090D14] font-bold text-[10px]">
                    {ev.name}
                  </span>
                  <span className="font-mono-tabular text-slate-300">
                    {ev.date} · {ev.timeUtc} UTC
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(ev.id)}
                  className="text-slate-400 hover:text-rose-400 p-1"
                  title="Eliminar evento"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
