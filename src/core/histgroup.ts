/** La logica PURA de la vitrina de historial: filtrar, fijar y AGRUPAR por
 *  dia. CERO imports a proposito — corre igual en la app y en `node --test`
 *  (tests/hist.test.ts). `nowMs` viaja como argumento: agrupar por fecha con
 *  un reloj implicito seria intesteable, y "Hoy"/"Ayer" son exactamente la
 *  clase de logica que se rompe en silencio. */
import { pathBasename } from "./path-utils.ts";

export interface ConvCard {
  provider: string;
  sid: string;
  /** transcript en disco (la verdad; el lector lo espeja) */
  path: string;
  /** cuenta no-default (CLAUDE_CONFIG_DIR de bro) — el resume la necesita */
  configDir: string | null;
  cwd: string;
  title: string | null;
  mtimeMs: number;
}

export interface HistSection {
  label: string;
  cards: ConvCard[];
}

export interface GroupedHistory {
  sections: HistSection[];
  /** cards que pasaron filtro (sin contar fijadas) */
  total: number;
  /** true si `limit` recorto la lista (hay "mostrar mas") */
  hasMore: boolean;
}

const MESES = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

/** Etiqueta de grupo estilo Claude Desktop: Hoy · Ayer · "28 jul" (mismo año)
 *  · "28 jul 2025" (otro año). Dias CIVILES en hora local, no ventanas de
 *  24h: una conversacion de anoche a las 23:50 es "Ayer" aunque hayan pasado
 *  veinte minutos. */
export function dayLabel(mtimeMs: number, nowMs: number): string {
  const d = new Date(mtimeMs);
  const now = new Date(nowMs);
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diasAtras = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diasAtras <= 0) return "Hoy";
  if (diasAtras === 1) return "Ayer";
  const base = `${d.getDate()} ${MESES[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** ¿La card matchea la busqueda? titulo + carpeta del proyecto, sin acentos ni
 *  mayusculas — buscar "edicion" tiene que encontrar "Edición". */
const fold = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

export function matches(card: ConvCard, query: string): boolean {
  const q = fold(query.trim());
  if (!q) return true;
  const proyecto = pathBasename(card.cwd);
  return fold(`${card.title ?? ""} ${proyecto}`).includes(q);
}

/** Preferencias de la vitrina (el popover de filtros, estilo Claude Desktop). */
export interface HistPrefs {
  groupBy: "date" | "project" | "none";
  sortBy: "recency" | "title";
  /** filtro por proyecto (basename del cwd); null = todos */
  project: string | null;
}

export const DEFAULT_PREFS: HistPrefs = {
  groupBy: "date",
  sortBy: "recency",
  project: null,
};

export function projectOf(card: ConvCard): string {
  return pathBasename(card.cwd) || "(sin proyecto)";
}

/** Los proyectos presentes en el historial, por frecuencia descendente —
 *  alimenta el filtro "Proyecto" del popover. */
export function projectsOf(cards: ConvCard[]): string[] {
  const n = new Map<string, number>();
  for (const c of cards) {
    const p = projectOf(c);
    n.set(p, (n.get(p) ?? 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

export function groupHistory(
  cards: ConvCard[],
  opts: {
    query?: string;
    pinned?: Set<string>;
    /** sids a excluir: las conversaciones VIVAS ya estan arriba en el rail —
     *  repetirlas abajo seria una lista que se contradice sola */
    exclude?: Set<string>;
    limit?: number;
    nowMs: number;
    prefs?: HistPrefs;
  },
): GroupedHistory {
  const pinned = opts.pinned ?? new Set<string>();
  const exclude = opts.exclude ?? new Set<string>();
  const query = opts.query ?? "";
  const limit = opts.limit ?? 30;
  const prefs = opts.prefs ?? DEFAULT_PREFS;

  const visibles = cards.filter(
    (c) =>
      !exclude.has(c.sid) &&
      matches(c, query) &&
      (!prefs.project || projectOf(c) === prefs.project),
  );

  const fijadas = visibles.filter((c) => pinned.has(c.sid));
  let resto = visibles.filter((c) => !pinned.has(c.sid));
  if (prefs.sortBy === "title") {
    resto = [...resto].sort((a, b) =>
      (a.title ?? "").localeCompare(b.title ?? "", "es", { sensitivity: "base" }),
    );
  }
  const shown = resto.slice(0, limit);

  const labelOf = (c: ConvCard): string =>
    prefs.groupBy === "date"
      ? dayLabel(c.mtimeMs, opts.nowMs)
      : prefs.groupBy === "project"
        ? projectOf(c)
        : "Historial";

  const sections: HistSection[] = [];
  if (fijadas.length) sections.push({ label: "Fijadas", cards: fijadas });
  // agrupado por LLAVE (Map conserva orden de insercion): con recencia los
  // grupos salen en orden de recencia; con titulo, un grupo jamas se parte en
  // dos secciones aunque sus cards no sean contiguas en el orden elegido.
  // "Fijadas" nunca colisiona (ni dayLabel ni un proyecto la producen como
  // llave de ESTA map — vive en su seccion de arriba).
  const by = new Map<string, ConvCard[]>();
  for (const c of shown) {
    const l = labelOf(c);
    by.set(l, [...(by.get(l) ?? []), c]);
  }
  for (const [label, cs] of by) sections.push({ label, cards: cs });
  return { sections, total: resto.length, hasMore: resto.length > limit };
}
