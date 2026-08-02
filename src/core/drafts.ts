/** BORRADORES del lector (26 jul 2026) — la red de seguridad del composer.
 *
 *  El bug que mata esto: el textarea del lector es NO CONTROLADO (el texto vive
 *  solo en el nodo del DOM). Al cerrar el lector, React desmonta ese nodo en la
 *  fase de mutacion y pone la ref en null ANTES de que corra el cleanup del
 *  efecto que devolvia el borrador al TUI — el cleanup leia `inputRef.current`,
 *  encontraba null, y no devolvia nada. Un parrafo entero al vacio, sin copia
 *  en ningun lado. (Reporte de Daniel, 26 jul: "perdí mi texto para siempre".)
 *
 *  Aqui vive la copia. Dos capas, a proposito:
 *
 *    MEMORIA (por termId) — la vida de la app. Es la que cubre el caso real:
 *      escribir → cambiar de vista → volver. termId sirve de llave porque
 *      mientras la app vive, esa terminal ES esa terminal.
 *
 *    DISCO (por sessionId, en localStorage) — sobrevive a ⌘R (que en esta app
 *      RELANZA el proceso) y a cerrar la app. La llave es el sid de la sesion
 *      de claude, no el termId: al reabrir, los paneles nacen con ids NUEVOS
 *      (misma falta de identidad estable que mato el revival de sesiones), asi
 *      que un draft guardado por id se lo comeria una terminal ajena.
 *
 *  El borrador se BORRA solo cuando se entrego: o lo enviaste, o volvio al TUI
 *  de su terminal. Si el intercambio con el TUI no se pudo cerrar (el parser no
 *  entendio la pantalla), la copia se queda. Preferimos que sobre a que falte:
 *  un borrador duplicado se ve, uno perdido no se recupera.
 */

export interface Draft {
  text: string;
  /** rutas de los adjuntos pendientes (los que aun no viajaron en un mensaje) */
  attachments: string[];
}

const LS_KEY = "sfterm-drafts-v1";
const LS_MAX = 40;

/** por termId — la llave viva mientras la app corre */
const mem = new Map<number, Draft>();

export function isEmpty(d: Draft | null | undefined): boolean {
  return !d || (!d.text.trim() && !d.attachments.length);
}

function loadLs(): Record<string, Draft> {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, Draft> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const d = v as Partial<Draft>;
      if (typeof d?.text !== "string") continue;
      out[k] = {
        text: d.text,
        attachments: Array.isArray(d.attachments)
          ? d.attachments.filter((p): p is string => typeof p === "string")
          : [],
      };
    }
    return out;
  } catch {
    return {};
  }
}

let lsCache: Record<string, Draft> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function ls(): Record<string, Draft> {
  if (!lsCache) lsCache = loadLs();
  return lsCache;
}

/** Escritura diferida: el composer llama a write() en cada tecla y no vale la
 *  pena serializar en cada una. 400ms de retraso no pierde nada — la copia en
 *  MEMORIA ya esta puesta, y esta capa solo cubre el relanzamiento. */
function flushSoon() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      const all = ls();
      const keys = Object.keys(all);
      // poda: los mas viejos primero (orden de insercion de Object.keys)
      if (keys.length > LS_MAX) {
        for (const k of keys.slice(0, keys.length - LS_MAX)) delete all[k];
      }
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch {
      /* cuota llena / storage bloqueado: la copia en memoria sigue viva */
    }
  }, 400);
}

/** El borrador de una terminal. Memoria primero; si la app acaba de arrancar,
 *  el de disco de esa sesion. */
export function read(termId: number | undefined, sid?: string): Draft | null {
  if (termId != null) {
    const m = mem.get(termId);
    if (m) return m;
  }
  if (sid) {
    const d = ls()[sid];
    if (d && !isEmpty(d)) return d;
  }
  return null;
}

export function write(termId: number | undefined, sid: string | undefined, d: Draft): void {
  if (isEmpty(d)) {
    clear(termId, sid);
    return;
  }
  if (termId != null) mem.set(termId, d);
  if (sid) {
    const all = ls();
    delete all[sid]; // re-insertar al final: la poda tira los mas viejos
    all[sid] = d;
    flushSoon();
  }
}

export function clear(termId: number | undefined, sid?: string): void {
  if (termId != null) mem.delete(termId);
  if (sid && ls()[sid]) {
    delete ls()[sid];
    flushSoon();
  }
}

/** Solo para tests: vacia las dos capas. */
export function _reset(): void {
  mem.clear();
  lsCache = {};
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* sin storage */
  }
}
