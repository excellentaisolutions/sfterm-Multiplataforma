/** ELEMENT PICKER del navegador del agente (28 jul 2026, inspirado en T3).
 *
 *  Daniel SEÑALA un elemento de la pagina y el elemento me llega como DATOS
 *  {selector, texto, href, html truncado, rect}. Dos entradas, un camino:
 *   - verbo de gate `browser_pick` (arma y espera el click)
 *   - boton ⊹ del chrome del navegador (Daniel arma; el resultado queda en el
 *     buffer y el proximo `browser_pick` lo drena al instante)
 *
 *  RESTRICCION DURA: el navegador NO tiene IPC de Tauri — la pagina jamas
 *  puede llamar a la app. Por eso el picker es inyeccion via el eval existente
 *  y el resultado se LEE por polling de `window.__sfPick` (pull, nunca push).
 *  Si la pagina navega a mitad del pick, la variable muere con ella y el poll
 *  lo reporta honesto como cancelado.
 */
import * as ipc from "./ipc";

export interface PickResult {
  cancelled?: boolean;
  reason?: string;
  selector?: string;
  tag?: string;
  text?: string;
  href?: string | null;
  html?: string;
  rect?: { x: number; y: number; w: number; h: number };
  /** "manual" = lo señalo Daniel con el boton del chrome */
  source?: string;
}

/** buffer del pick manual: browser_pick lo drena (una sola vez, fresco) */
let lastPick: { at: number; result: PickResult } | null = null;

export function stashPick(result: PickResult) {
  lastPick = { at: Date.now(), result };
}

export function takeLastPick(maxAgeMs = 120_000): PickResult | null {
  if (!lastPick || Date.now() - lastPick.at > maxAgeMs) return null;
  const r = lastPick.result;
  lastPick = null;
  return { ...r, source: "manual" };
}

async function ev(id: number, expr: string): Promise<unknown> {
  const raw = await ipc.browserEval(id, expr);
  if (raw.startsWith("JSERROR:")) throw new Error(raw);
  if (raw === "undefined") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** JS inyectado: overlay de highlight + captura del click en fase CAPTURE
 *  (la pagina no ve el click: señalar no debe disparar la accion del sitio).
 *  Todo se limpia solo al pick, al Esc o al cancel del timeout. */
const ARM_JS = `(() => {
  if (window.__sfPickCleanup) window.__sfPickCleanup();
  const ov = document.createElement("div");
  Object.assign(ov.style, {
    position: "fixed", zIndex: 2147483647, pointerEvents: "none",
    border: "2px solid #A968F7", background: "rgba(169,104,247,0.14)",
    borderRadius: "3px", left: "-9999px", top: "0", width: "0", height: "0",
  });
  document.documentElement.appendChild(ov);
  let cur = null;
  const sel = (el) => {
    const parts = [];
    let e = el;
    while (e && e.nodeType === 1 && parts.length < 5) {
      if (e.id) { parts.unshift(e.tagName.toLowerCase() + "#" + CSS.escape(e.id)); break; }
      let p = e.tagName.toLowerCase();
      const par = e.parentElement;
      if (par) {
        const same = [...par.children].filter(x => x.tagName === e.tagName);
        if (same.length > 1) p += ":nth-of-type(" + (same.indexOf(e) + 1) + ")";
      }
      const cls = [...e.classList].slice(0, 2).map(c => "." + CSS.escape(c)).join("");
      parts.unshift(p + cls);
      e = par;
    }
    return parts.join(" > ");
  };
  const onMove = (me) => {
    const el = document.elementFromPoint(me.clientX, me.clientY);
    if (!el) return;
    cur = el;
    const r = el.getBoundingClientRect();
    Object.assign(ov.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  };
  const block = (be) => { be.preventDefault(); be.stopPropagation(); };
  const finish = (res) => { cleanup(); window.__sfPick = Object.assign({ done: true }, res); };
  const onClick = (ce) => {
    block(ce);
    const el = document.elementFromPoint(ce.clientX, ce.clientY) || cur;
    if (!el) return finish({ cancelled: true, reason: "sin elemento" });
    const r = el.getBoundingClientRect();
    const a = el.closest ? el.closest("a[href]") : null;
    finish({
      selector: sel(el),
      tag: el.tagName.toLowerCase(),
      text: ((el.innerText || el.value || "") + "").trim().slice(0, 300),
      href: a ? a.href : null,
      html: (el.outerHTML || "").slice(0, 1500),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    });
  };
  const onKey = (ke) => { if (ke.key === "Escape") { block(ke); finish({ cancelled: true, reason: "esc" }); } };
  const cleanup = () => {
    removeEventListener("mousemove", onMove, true);
    removeEventListener("mousedown", block, true);
    removeEventListener("mouseup", block, true);
    removeEventListener("click", onClick, true);
    removeEventListener("keydown", onKey, true);
    ov.remove();
    delete window.__sfPickCleanup;
  };
  addEventListener("mousemove", onMove, true);
  addEventListener("mousedown", block, true);
  addEventListener("mouseup", block, true);
  addEventListener("click", onClick, true);
  addEventListener("keydown", onKey, true);
  window.__sfPickCleanup = cleanup;
  window.__sfPick = { armed: true };
  return true;
})()`;

export async function armPick(id: number): Promise<void> {
  await ev(id, ARM_JS);
}

/** Desarma el picker desde AFUERA (boton Cancelar del chrome, 30 jul): mismo
 *  camino que Esc — pollPick despierta con cancelled y el sitio no vio nada. */
export async function cancelPick(id: number): Promise<void> {
  await ev(
    id,
    `(() => { if (window.__sfPickCleanup) { window.__sfPickCleanup(); window.__sfPick = { done: true, cancelled: true, reason: "cancel" }; } return true; })()`,
  );
}

/** Espera el resultado del pick (poll 250ms). Al timeout desarma y limpia. */
export async function pollPick(id: number, timeoutMs = 45_000): Promise<PickResult> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    let cur: unknown;
    try {
      cur = await ev(id, "window.__sfPick || null");
    } catch {
      continue; // eval transitoriamente no disponible (carga): seguir
    }
    if (cur == null) {
      // la variable murio: la pagina navego (o el navegador se cerro)
      return { cancelled: true, reason: "la pagina navego durante el pick" };
    }
    const p = cur as PickResult & { done?: boolean; armed?: boolean };
    if (p.done) {
      const { done: _done, ...rest } = p;
      return rest;
    }
  }
  await ev(
    id,
    "window.__sfPickCleanup ? (window.__sfPickCleanup(), window.__sfPick = null, true) : false",
  ).catch(() => {});
  return { cancelled: true, reason: "timeout" };
}
