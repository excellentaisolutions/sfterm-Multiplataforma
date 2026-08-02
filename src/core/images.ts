/** IMAGENES DEL LECTOR (26 jul 2026): el visor y la cache.
 *
 *  Dos piezas chicas que no merecen archivo propio cada una:
 *
 *  1. LIGHTBOX — el visor. Vive como controlador de modulo (no en el store de
 *     zustand) porque lo abre un thumbnail enterrado dentro de un mensaje y no
 *     tiene sentido pasarle callbacks por seis niveles de props. Esc y click
 *     fuera cierran: pedido explicito de Daniel ("poder cerrar las imagenes").
 *
 *  2. CACHE de las imagenes que viven DENTRO del transcript. readTail stripea
 *     los blobs base64 en el shell, asi que pintarlas exige pedirlas de vuelta
 *     una por una (ipc.transcriptImage). Sin cache, el poll de 1.5s del lector
 *     las volveria a pedir cada vez que re-renderiza: una imagen de 4MB, cada
 *     segundo y medio, por cada imagen visible.
 */
import * as ipc from "./ipc";

/* ── 1. el visor ──────────────────────────────────────────────────────────── */

export interface LightboxShot {
  src: string;
  alt?: string;
  /** ruta real en disco, si la hay: habilita "revelar en Finder" */
  path?: string;
}

let shot: LightboxShot | null = null;
const subs = new Set<() => void>();

export const lightbox = {
  open(s: LightboxShot) {
    shot = s;
    subs.forEach((f) => f());
  },
  close() {
    if (!shot) return;
    shot = null;
    subs.forEach((f) => f());
  },
  get: () => shot,
  subscribe(cb: () => void) {
    subs.add(cb);
    return () => subs.delete(cb);
  },
};

/* ── 2. la cache ──────────────────────────────────────────────────────────── */

/** Tope de imagenes en memoria. Un screenshot pesa hasta 4MB en base64 y el
 *  data URI vive en el heap del webview: sin tope, scrollear una sesion vieja
 *  llena de capturas se come cientos de MB. FIFO simple — la ventana visible
 *  del lector nunca tiene tantas. */
const MAX_CACHED = 24;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

const keyOf = (path: string, uuid: string, index: number) => `${path}#${uuid}:${index}`;

/** Data URI de una imagen del transcript. Cachea por (archivo, mensaje, indice)
 *  y coalesce las peticiones en vuelo (el poll puede disparar dos renders antes
 *  de que la primera vuelva). */
export function transcriptImage(path: string, uuid: string, index: number): Promise<string> {
  const key = keyOf(path, uuid, index);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const flying = inflight.get(key);
  if (flying) return flying;
  const p = ipc
    .transcriptImage(path, uuid, index)
    .then((uri) => {
      cache.set(key, uri);
      if (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return uri;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Lo ya cacheado, sin pedir nada (para pintar en el primer frame). */
export const cachedImage = (path: string, uuid: string, index: number) =>
  cache.get(keyOf(path, uuid, index));

/* ── 3. imagenes del DISCO (adjuntos) ─────────────────────────────────────── */

/** Data URI de una imagen que vive en disco (un adjunto del composer).
 *  Misma cache y mismo coalescing que las del transcript: el thumbnail y el
 *  visor ampliado piden la MISMA ruta, y sin esto se leeria el archivo dos
 *  veces por cada imagen que Daniel abre. */
export function localImage(path: string): Promise<string> {
  const key = `file:${path}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  const flying = inflight.get(key);
  if (flying) return flying;
  const p = ipc
    .localImage(path)
    .then((uri) => {
      cache.set(key, uri);
      if (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return uri;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const cachedLocalImage = (path: string) => cache.get(`file:${path}`);
