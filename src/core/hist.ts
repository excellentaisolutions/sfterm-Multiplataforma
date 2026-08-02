/** La vitrina de historial: CARGA (via providers) + FIJADAS (localStorage).
 *  La logica pura (agrupar/filtrar/etiquetas de dia) vive en histgroup.ts —
 *  cero imports, testeada en tests/hist.test.ts. Aqui solo lo que toca IO. */
import { providers } from "./providers";
import type { ConvCard } from "./histgroup";

export type { ConvCard, HistSection, GroupedHistory, HistPrefs } from "./histgroup";
export {
  groupHistory,
  dayLabel,
  matches,
  projectsOf,
  projectOf,
  DEFAULT_PREFS,
} from "./histgroup";
import { DEFAULT_PREFS, type HistPrefs } from "./histgroup";

// ---------- carga (cache 30s, compartida por rail y gate) ----------

let cache: { at: number; cards: ConvCard[] } | null = null;

export async function loadHistory(force = false): Promise<ConvCard[]> {
  if (!force && cache && Date.now() - cache.at < 30_000) return cache.cards;
  const all = (await Promise.all(providers.map((p) => p.list()))).flat();
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  cache = { at: Date.now(), cards: all };
  return all;
}

export function invalidateHistory() {
  cache = null;
}

// ---------- fijadas (localStorage: preferencia de maquina, no config) ----------

const PIN_KEY = "sfterm-conv-pinned";
const PREFS_KEY = "sfterm-hist-prefs";
const COLLAPSED_KEY = "sfterm-hist-collapsed";

// ---------- preferencias del popover (agrupar/ordenar/proyecto) ----------

export function histPrefs(): HistPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const p = raw ? (JSON.parse(raw) as Partial<HistPrefs>) : {};
    return {
      groupBy: p.groupBy === "project" || p.groupBy === "none" ? p.groupBy : "date",
      sortBy: p.sortBy === "title" ? "title" : "recency",
      project: typeof p.project === "string" && p.project ? p.project : null,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveHistPrefs(p: HistPrefs): HistPrefs {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* sin storage las prefs viven lo que la pagina */
  }
  return p;
}

// ---------- secciones colapsadas (toggle por header, estilo Claude Desktop) ----------

export function collapsedLabels(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function toggleCollapsed(label: string): Set<string> {
  const cur = collapsedLabels();
  if (cur.has(label)) cur.delete(label);
  else cur.add(label);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...cur]));
  } catch {
    /* idem */
  }
  return cur;
}

export function pinnedSids(): Set<string> {
  try {
    const raw = localStorage.getItem(PIN_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function togglePin(sid: string): Set<string> {
  const cur = pinnedSids();
  if (cur.has(sid)) cur.delete(sid);
  else cur.add(sid);
  try {
    localStorage.setItem(PIN_KEY, JSON.stringify([...cur]));
  } catch {
    /* sin storage no hay fijadas, pero la lista sigue */
  }
  return cur;
}
