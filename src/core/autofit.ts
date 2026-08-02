/** AJUSTE AL PANEL (29 jul 2026) — que la pagina QUEPA en el ala, no que se corte.
 *
 *  EL SINTOMA: skool.com en un ala de 496px se ve partido por la mitad; media
 *  columna de miembros y la tarjeta de la derecha quedan fuera de la caja.
 *
 *  EL DIAGNOSTICO (medido, no supuesto): NO es que el webview ignore su ancho.
 *  Lo reporta bien — `innerWidth` 496 — y el sitio si lo lee. Es que con UA de
 *  Safari de ESCRITORIO (la que usamos a proposito, para que los logins de
 *  Google no nos bloqueen) el sitio sirve su layout de escritorio, que tiene un
 *  ancho minimo duro de ~636px, y su meta viewport trae `user-scalable=no,
 *  maximum-scale=1`: le PROHIBE al motor encoger para acomodar. Resultado:
 *  140px de contenido fuera de la caja, recortados sin aviso.
 *
 *  EL ARREGLO: hacer desde afuera el shrink-to-fit que ese meta prohibe.
 *  `setMagnification` de WKWebView SI reflowea el layout, no es solo escala
 *  visual — medido en el caso Skool: a 0.78 el `innerWidth` pasa de 496 a 635
 *  y el desborde queda en CERO. Asi que basta con calcular el factor exacto.
 *
 *  LA MECANICA. De una pagina nos interesa UN numero: `needW`, el ancho minimo
 *  en px CSS que necesita para no desbordarse. Se mide UNA vez por carga, con
 *  el zoom en 1 (a otro zoom la medicion vendria contaminada). Despues, para
 *  cualquier ancho de panel:
 *
 *      f = clamp(panel / needW, MIN, 1)
 *
 *  y como el layout en px CSS es `panel / magnification`, el ancho real del
 *  panel se recupera en cualquier momento con `innerWidth * magnification`,
 *  sin tener que resetear el zoom y provocar un parpadeo en cada ajuste.
 *
 *  DOS LIMITES A PROPOSITO:
 *  - Techo 1.0: solo ENCOGE. Una pagina que ya cabe jamas se agranda sola.
 *  - Piso MIN: antes que volver ilegible un sitio de ancho absurdo (un dump de
 *    logs, una tabla de 3000px), se prefiere dejarle scroll horizontal.
 *
 *  Y UNA REGLA DE CORTESIA: si Daniel o un agente fijan el zoom a mano, el
 *  ajuste automatico SE CALLA para ese navegador. Volver a 1.0 (⌘0, o
 *  `browser_zoom {factor:1}`) lo reactiva. Nada pelea contra quien esta
 *  mirando la pantalla.
 */
import * as ipc from "./ipc";

/** Por debajo de esto el texto deja de leerse: mejor scroll que ilegible. */
const MIN = 0.5;
/** Holgura: un desborde de pocos px no vale un re-zoom (bordes, scrollbars). */
const TOL = 6;

type Estado = {
  /** magnification vigente que nosotros aplicamos */
  mag: number;
  /** ancho minimo de la pagina en px CSS (medido a zoom 1); 0 = sin medir */
  needW: number;
  /** el zoom lo fijo un humano/agente: no tocarlo */
  manual: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

const estados = new Map<number, Estado>();

function edo(id: number): Estado {
  let e = estados.get(id);
  if (!e) {
    e = { mag: 1, needW: 0, manual: false, timer: null };
    estados.set(id, e);
  }
  return e;
}

/** Expresion SINCRONA (browser_eval no espera promesas): ancho del viewport y
 *  ancho real del contenido. `body.scrollWidth` entra al max porque hay
 *  layouts donde el desborde lo produce el body y no el documento. */
const MEDIDA = `JSON.stringify({i:window.innerWidth,s:Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0)})`;

async function medir(id: number): Promise<{ i: number; s: number } | null> {
  try {
    const raw = await ipc.browserEval(id, MEDIDA);
    const v = JSON.parse(typeof raw === "string" ? raw : String(raw));
    if (typeof v?.i !== "number" || typeof v?.s !== "number") return null;
    if (v.i <= 0 || v.s <= 0) return null; // panel plegado u oculto: no medir
    return v;
  } catch {
    return null; // webview cerrado, pagina sin JS, navegacion en curso
  }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Aplica el factor que hace caber la pagina. `remedir` fuerza recalcular
 *  `needW` (se usa al terminar una carga: la pagina es otra). */
async function ajustar(id: number, remedir: boolean) {
  const e = edo(id);
  if (e.manual) return;

  if (remedir) {
    // el ancho minimo se mide con el zoom limpio, si no viene contaminado
    if (e.mag !== 1) {
      try {
        await ipc.browserZoom(id, 1);
      } catch {
        return;
      }
      e.mag = 1;
    }
    const m = await medir(id);
    if (!m) return;
    e.needW = m.s;
  }

  const m = await medir(id);
  if (!m) return;
  // panel real en px CSS (invariante al zoom que nosotros mismos pusimos)
  const panel = m.i * e.mag;
  // sin medida previa util, el contenido de ahora es la mejor referencia
  const need = e.needW > 0 ? e.needW : m.s;
  if (need <= panel + TOL && e.mag >= 1) return; // ya cabe y ya esta en 100%

  const f = Math.round(clamp(panel / need, MIN, 1) * 100) / 100;
  if (Math.abs(f - e.mag) < 0.02) return; // diferencia invisible: no parpadear
  try {
    await ipc.browserZoom(id, f);
    e.mag = f;
  } catch {
    /* webview cerrado a media operacion */
  }
}

/** Pide un ajuste (con debounce, porque los resize llegan en rafaga).
 *  `remedir: true` = la pagina cambio (carga nueva / cambio de ruta). */
export function schedule(id: number, opts?: { remedir?: boolean; delay?: number }) {
  const e = edo(id);
  if (e.manual) return;
  if (e.timer) clearTimeout(e.timer);
  e.timer = setTimeout(() => {
    e.timer = null;
    void ajustar(id, opts?.remedir ?? false);
  }, opts?.delay ?? 180);
}

/** Termino de cargar una pagina: medir de cero y, por si es una SPA que pinta
 *  tarde, revisar otra vez un momento despues. */
export function onLoad(id: number) {
  schedule(id, { remedir: true, delay: 220 });
  const e = edo(id);
  setTimeout(() => {
    if (!e.manual) void ajustar(id, true);
  }, 1400);
}

/** Paso de zoom manual (⌘+/− — venga del hook de la pagina o del atajo de la
 *  app): parte del factor VIGENTE (si el ajuste habia encogido a 0.78, ⌘+ da
 *  0.88, como Safari), fija modo manual y aplica. ⌘0 devuelve al automatico. */
export function step(id: number, delta: number): number {
  const e = edo(id);
  if (e.timer) {
    clearTimeout(e.timer);
    e.timer = null;
  }
  e.manual = true;
  e.mag = Math.round(clamp(e.mag + delta, 0.4, 3) * 100) / 100;
  void ipc.browserZoom(id, e.mag);
  return e.mag;
}

/** El zoom lo fijo alguien a mano. 1.0 significa "vuelve a automatico". */
export function manual(id: number, factor: number) {
  const e = edo(id);
  if (Math.abs(factor - 1) < 0.001) {
    e.manual = false;
    e.mag = 1;
    schedule(id, { remedir: true, delay: 120 });
  } else {
    e.manual = true;
    e.mag = factor;
  }
}

/** "Quiero verla al 100% aunque no quepa": congela en 1.0 (con scroll
 *  horizontal, como estaba antes). ⌘0 la devuelve al ajuste automatico. */
export function pin100(id: number) {
  const e = edo(id);
  if (e.timer) clearTimeout(e.timer);
  e.timer = null;
  e.manual = true;
  e.mag = 1;
  void ipc.browserZoom(id, 1);
}

/** % vigente para pintarlo en el chrome (null = nada que enseñar). */
export function factor(id: number): number | null {
  const e = estados.get(id);
  if (!e || e.manual) return null;
  return e.mag < 0.995 ? e.mag : null;
}

export function forget(id: number) {
  const e = estados.get(id);
  if (e?.timer) clearTimeout(e.timer);
  estados.delete(id);
}
