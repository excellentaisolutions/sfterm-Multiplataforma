/** HISTORIAL del navegador del agente (29 jul 2026). Vive en localStorage de
 *  la app (no de la pagina): lo alimenta el poll del chrome y lo leen el
 *  dropdown de la barra y el verbo browser_history del gate. Cap 200. */

const KEY = "sfterm-browser-history";

export type HistEntry = { url: string; title: string; t: number };

export function loadHist(): HistEntry[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]") as HistEntry[];
  } catch {
    return [];
  }
}

export function pushHist(url: string, title: string) {
  if (!url || url === "about:blank") return;
  const h = loadHist().filter((e) => e.url !== url);
  h.unshift({ url, title: title || url, t: Date.now() });
  localStorage.setItem(KEY, JSON.stringify(h.slice(0, 200)));
}

/** filtro fuzzy barato: substring sobre url+titulo, mas recientes primero */
export function searchHist(q: string, n = 20): HistEntry[] {
  const needle = q.trim().toLowerCase();
  const all = loadHist();
  if (!needle) return all.slice(0, n);
  return all
    .filter((e) => e.url.toLowerCase().includes(needle) || e.title.toLowerCase().includes(needle))
    .slice(0, n);
}
