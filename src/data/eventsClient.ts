import type { MacroEvent } from '../types/market';

const CUSTOM_EVENTS_STORAGE_KEY = 'wterm_custom_events_v1';

type RawMacroEvent = {
  id?: string;
  date: string;
  timeUtc: string;
  name: string;
};

export function parseRawEvents(data: unknown): MacroEvent[] {
  if (!Array.isArray(data)) return [];
  const events: MacroEvent[] = [];
  for (let i = 0; i < data.length; i++) {
    const item = data[i] as RawMacroEvent;
    if (!item?.date || !item?.name) continue;
    const timeStr = item.timeUtc || '00:00';
    const ts = Date.parse(`${item.date}T${timeStr}:00Z`);
    if (!Number.isFinite(ts)) continue;
    events.push({
      id: item.id || `evt-${i}-${ts}`,
      date: item.date,
      timeUtc: timeStr,
      name: item.name,
      ts,
    });
  }
  return events.sort((a, b) => a.ts - b.ts);
}

export function saveLocalEvents(events: MacroEvent[]) {
  try {
    const raw = events.map(({ id, date, timeUtc, name }) => ({ id, date, timeUtc, name }));
    localStorage.setItem(CUSTOM_EVENTS_STORAGE_KEY, JSON.stringify(raw));
  } catch {
    // ignore storage errors
  }
}

export function clearLocalEvents() {
  try {
    localStorage.removeItem(CUSTOM_EVENTS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export async function fetchMacroEvents(): Promise<MacroEvent[]> {
  try {
    const savedRaw = localStorage.getItem(CUSTOM_EVENTS_STORAGE_KEY);
    if (savedRaw) {
      const parsedLocal = parseRawEvents(JSON.parse(savedRaw));
      if (parsedLocal.length > 0) return parsedLocal;
    }
  } catch {
    // fallback to /events.json
  }

  try {
    const res = await fetch('/events.json', { cache: 'no-store' });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    return parseRawEvents(data);
  } catch {
    return [];
  }
}
