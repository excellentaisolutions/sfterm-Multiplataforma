/** LA FUENTE JS que se inyecta en la pagina: resolver de elementos + los cinco
 *  chequeos de accionabilidad. Vive SOLA y sin imports a proposito, para que se
 *  pueda parsear en un test (`new Function`) sin arrastrar las APIs de Tauri.
 *  El por que de cada chequeo esta en locator.ts, que es quien la usa. */

/** El resolver + los cinco chequeos, como fuente JS lista para inyectar.
 *  Se comparte entre click, type, upload y wait: una sola definicion de "que
 *  es un elemento accionable" para toda la app. */
export const RESOLVER_JS = `
const __sfRoles = {
  button: "button,[role=button],input[type=button],input[type=submit],input[type=reset],summary",
  link: "a[href],[role=link]",
  textbox: "input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]),textarea,[role=textbox],[contenteditable=true]",
  file: "input[type=file]",
  checkbox: "input[type=checkbox],[role=checkbox]",
  radio: "input[type=radio],[role=radio]",
  tab: "[role=tab]",
  heading: "h1,h2,h3,h4,h5,h6,[role=heading]",
  combobox: "select,[role=combobox]",
  option: "option,[role=option]",
  img: "img,[role=img]",
};
const __sfName = (e) => {
  const aria = e.getAttribute && e.getAttribute("aria-label");
  if (aria) return aria.trim();
  const by = e.getAttribute && e.getAttribute("aria-labelledby");
  if (by) {
    const t = by.split(/\\s+/).map((id) => (document.getElementById(id) || {}).innerText || "").join(" ").trim();
    if (t) return t;
  }
  return ((e.innerText || e.value || e.placeholder || e.alt || e.title || "") + "").trim();
};
const __sfVisible = (e) => {
  const r = e.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const cs = getComputedStyle(e);
  return cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity !== 0;
};
/** El elemento que pide el target. Prefiere: selector > rol+nombre >
 *  placeholder > label > texto. En texto y nombre, exacto antes que contiene,
 *  y entre varios candidatos gana el MAS PEQUEÑO (el boton, no el <div> que lo
 *  envuelve — un contenedor "contiene" el texto igual que su hijo). */
const __sfFind = (q) => {
  const chico = (a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return ra.width * ra.height <= rb.width * rb.height ? a : b;
  };
  const pick = (cands, needle, fn) => {
    if (!needle) return null;
    const n = needle.toLowerCase();
    const vis = cands.filter(__sfVisible);
    const pool = vis.length ? vis : cands;
    const exact = pool.filter((e) => fn(e).toLowerCase() === n);
    if (exact.length) return exact.reduce(chico);
    const part = pool.filter((e) => fn(e).toLowerCase().includes(n));
    return part.length ? part.reduce(chico) : null;
  };
  if (q.selector) {
    const el = document.querySelector(q.selector);
    if (el) return el;
  }
  if (q.role) {
    const cands = [...document.querySelectorAll(__sfRoles[q.role] || "[role=" + q.role + "]")];
    if (!q.name) return cands.filter(__sfVisible)[0] || cands[0] || null;
    const hit = pick(cands, q.name, __sfName);
    if (hit) return hit;
  }
  if (q.placeholder) {
    const hit = pick([...document.querySelectorAll("input,textarea")], q.placeholder, (e) => e.placeholder || "");
    if (hit) return hit;
  }
  if (q.label) {
    const n = q.label.toLowerCase();
    for (const l of document.querySelectorAll("label")) {
      if (!(l.innerText || "").toLowerCase().includes(n)) continue;
      const f = l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector("input,textarea,select");
      if (f) return f;
    }
  }
  if (q.text) {
    const cands = [...document.querySelectorAll(
      "a,button,[role=button],[role=link],[role=tab],input[type=submit],input[type=button],[onclick],summary,label"
    )];
    const hit = pick(cands, q.text, __sfName);
    if (hit) return hit;
    // ultimo recurso: CUALQUIER elemento con ese texto (el mas chico)
    const todos = [...document.querySelectorAll("body *")].filter(
      (e) => !e.children.length || (e.innerText || "").length < 200
    );
    return pick(todos, q.text, (e) => (e.innerText || "").trim());
  }
  return null;
};
/** Los cinco chequeos. Devuelve {ok} o {ok:false, reason} con el POR QUE. */
const __sfActionable = (q) => {
  const el = __sfFind(q);
  if (!el) { window.__sfAct = null; return { ok: false, reason: "no existe en la pagina" }; }
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const info = { tag: el.tagName.toLowerCase(), text: __sfName(el).slice(0, 80) };
  if (!__sfVisible(el)) { window.__sfAct = null; return { ok: false, reason: "existe pero esta invisible", ...info }; }
  if (el.disabled || el.getAttribute("aria-disabled") === "true")
    { window.__sfAct = null; return { ok: false, reason: "esta deshabilitado", ...info }; }
  // QUIETO = la misma caja DOS sondeos seguidos, no uno. Con uno solo, una
  // animacion con pausa en los extremos (ease-in-out) cuela el elemento justo
  // en el instante en que su velocidad es cero.
  //
  // ⚠️ ES BEST-EFFORT, NO GARANTIA, y conviene saberlo: si la ventana esta
  // TAPADA, macOS ralentiza las animaciones de la pagina, asi que dos sondeos
  // seguidos pueden ver la misma caja de algo que sigue moviendose (medido en
  // E2E el 29 jul). No es grave porque nuestro clic se despacha AL ELEMENTO,
  // no a una coordenada: un blanco en movimiento no se falla. Esta prueba
  // existe para no accionar una UI a media transicion, no para no errar el
  // tiro. El chequeo que SI es duro es el de alcanzable (hit test).
  const caja = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(",");
  const prev = window.__sfAct;
  const veces = prev && prev.caja === caja ? prev.veces + 1 : 0;
  window.__sfAct = { caja, veces };
  if (veces < 2) return { ok: false, reason: "se esta moviendo", ...info };
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const arriba = document.elementFromPoint(cx, cy);
  if (!arriba) return { ok: false, reason: "esta fuera de la ventana", ...info };
  if (arriba !== el && !el.contains(arriba) && !arriba.contains(el)) {
    const q2 = arriba.tagName.toLowerCase() + (arriba.className && typeof arriba.className === "string"
      ? "." + arriba.className.split(/\\s+/)[0] : "");
    return { ok: false, reason: "esta tapado por <" + q2 + ">", ...info };
  }
  return { ok: true, ...info };
};`;
