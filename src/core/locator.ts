/** LOCALIZAR Y ACCIONAR (29 jul 2026) — el nucleo que hace que un clic del
 *  agente no falle en silencio.
 *
 *  El problema que resuelve: `querySelector(...).click()` "funciona" contra una
 *  pagina quieta y miente contra una viva. Le da clic a un boton que todavia no
 *  aparece, a uno que esta animandose, a uno deshabilitado, o a uno tapado por
 *  el banner de cookies — y devuelve `clicked: true` en los cuatro casos. El
 *  agente cree que actuo y nadie se entera hasta que el daño esta hecho.
 *
 *  La respuesta (semantica robada a Playwright, implementacion nuestra): antes
 *  de tocar nada se exige que el elemento este
 *    1. PRESENTE      · existe en el DOM
 *    2. VISIBLE       · tiene caja y no esta apagado por CSS
 *    3. HABILITADO    · ni disabled ni aria-disabled
 *    4. QUIETO        · su caja es la MISMA que en la medicion anterior
 *    5. ALCANZABLE    · quien recibe el clic en su centro es el, no otro
 *  y si algo falla, se REINTENTA hasta el techo y se reporta POR QUE ("tapado
 *  por <div.cookie-banner>"), no un "no encontrado" que no ayuda a nadie.
 *
 *  ⚠️ La espera vive en TypeScript, no en la pagina: `evaluateJavaScript`
 *  devuelve valores, no promesas, asi que un `await` dentro del snippet se
 *  serializaria como `{}`. Cada sondeo es una expresion SINCRONA; la
 *  estabilidad se mide comparando contra `window.__sfAct`, que guarda la caja
 *  del sondeo anterior.
 */
import * as ipc from "./ipc";

/** Como se pide un elemento. Todos opcionales; se combinan (role+name). */
export interface Target {
  selector?: string;
  text?: string;
  /** rol de accesibilidad: button · link · textbox · checkbox · radio · tab ·
   *  heading · combobox · option · img */
  role?: string;
  /** nombre accesible (aria-label, texto, value, placeholder, alt, title) */
  name?: string;
  placeholder?: string;
  /** texto del <label> asociado a un campo */
  label?: string;
}

export interface Actionable {
  ok: boolean;
  reason?: string;
  tag?: string;
  text?: string;
}

export { RESOLVER_JS } from "./locator-js";
import { RESOLVER_JS } from "./locator-js";

/** Espera a que el target sea accionable y ejecuta `accion` (fuente JS que
 *  recibe `el`). Reintenta cada 120ms hasta `timeout`; al agotarse devuelve el
 *  ULTIMO motivo real, nunca un generico. */
export async function actuar(
  id: number,
  target: Target,
  accionJs: string,
  timeout = 6000,
): Promise<Actionable & Record<string, unknown>> {
  const q = JSON.stringify(target);
  const t0 = Date.now();
  let ultimo: Actionable = { ok: false, reason: "sin intentos" };
  // tres vueltas minimo: hacen falta dos comparaciones seguidas para afirmar
  // que algo esta quieto (la primera medicion no tiene con que compararse).
  // Cuesta ~250ms en el caso feliz y compra que "quieto" signifique quieto.
  while (Date.now() - t0 < timeout) {
    const raw = await ipc.browserEval(
      id,
      `(() => { ${RESOLVER_JS}
        const q = ${q};
        const v = __sfActionable(q);
        if (!v.ok) return v;
        const el = __sfFind(q);
        ${accionJs}
        return v;
      })()`,
    );
    if (raw.startsWith("JSERROR:")) throw new Error(raw);
    try {
      ultimo = JSON.parse(raw) as Actionable;
    } catch {
      ultimo = { ok: false, reason: `respuesta ilegible: ${raw.slice(0, 80)}` };
    }
    if (ultimo.ok) return { ...ultimo, ms: Date.now() - t0 };
    // 60ms: el caso feliz (elemento quieto y visible) paga ~120ms por las dos
    // comparaciones. Con 120ms pagaba el doble y CADA clic se sentia lento —
    // una garantia que cuesta medio segundo por accion no vale su precio.
    await new Promise((r) => setTimeout(r, 60));
  }
  return { ...ultimo, ms: Date.now() - t0, timeout: true };
}

/** Solo mira si es accionable (sin tocar). Base de browser_wait. */
export const chequear = (id: number, target: Target, timeout = 6000) =>
  actuar(id, target, "", timeout);
