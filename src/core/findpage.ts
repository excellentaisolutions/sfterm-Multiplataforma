/** BUSCAR EN LA PAGINA (⌘F del navegador, 29 jul 2026).
 *
 *  Implementado con la CSS Custom Highlight API (WebKit moderno): los matches
 *  se pintan via CSS.highlights SIN tocar el DOM de la pagina — cero riesgo
 *  de romper apps React (un <mark> inyectado des-sincroniza el virtual DOM).
 *  El estado vive en window.__sfFind dentro de la pagina; desde afuera solo
 *  viajan EXPRESIONES via browser_eval (mismo canal pull de siempre).
 */
import * as ipc from "./ipc";

/** Estilo de los highlights (se inyecta una sola vez por documento). */
const STYLE_JS = `(() => {
  if (document.getElementById("__sffind_css")) return;
  const st = document.createElement("style");
  st.id = "__sffind_css";
  st.textContent = "::highlight(sffind){background:#8a6d1a;color:#fff} ::highlight(sffind-cur){background:#ffd60a;color:#000}";
  document.documentElement.appendChild(st);
})()`;

/** Busca `q` (case-insensitive) y resalta todo; devuelve {count, index}. */
function searchJs(q: string): string {
  const esc = JSON.stringify(q.toLowerCase());
  return `(() => {
  ${STYLE_JS};
  if (!("highlights" in CSS)) return { count: -1, index: -1 };
  const q = ${esc};
  const ranges = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode()) && ranges.length < 500) {
    const text = node.textContent.toLowerCase();
    let i = 0;
    while ((i = text.indexOf(q, i)) !== -1 && ranges.length < 500) {
      const r = new Range();
      r.setStart(node, i);
      r.setEnd(node, i + q.length);
      ranges.push(r);
      i += q.length;
    }
  }
  window.__sfFind = { ranges, cur: 0 };
  CSS.highlights.set("sffind", new Highlight(...ranges));
  if (ranges.length) {
    CSS.highlights.set("sffind-cur", new Highlight(ranges[0]));
    (ranges[0].startContainer.parentElement || document.body).scrollIntoView({ block: "center" });
  } else {
    CSS.highlights.delete("sffind-cur");
  }
  return { count: ranges.length, index: ranges.length ? 1 : 0 };
})()`;
}

/** Avanza al siguiente/anterior match; devuelve {count, index} (1-based). */
function stepJs(dir: 1 | -1): string {
  return `(() => {
  const F = window.__sfFind;
  if (!F || !F.ranges.length) return { count: 0, index: 0 };
  F.cur = (F.cur + ${dir} + F.ranges.length) % F.ranges.length;
  const r = F.ranges[F.cur];
  CSS.highlights.set("sffind-cur", new Highlight(r));
  (r.startContainer.parentElement || document.body).scrollIntoView({ block: "center" });
  return { count: F.ranges.length, index: F.cur + 1 };
})()`;
}

const CLEAR_JS = `(() => {
  CSS.highlights.delete("sffind");
  CSS.highlights.delete("sffind-cur");
  delete window.__sfFind;
  return true;
})()`;

async function run(id: number, js: string): Promise<{ count: number; index: number }> {
  const raw = await ipc.browserEval(id, js);
  try {
    const v = JSON.parse(raw) as { count?: number; index?: number };
    return { count: v.count ?? 0, index: v.index ?? 0 };
  } catch {
    return { count: 0, index: 0 };
  }
}

export const search = (id: number, q: string) => run(id, searchJs(q));
export const next = (id: number) => run(id, stepJs(1));
export const prev = (id: number) => run(id, stepJs(-1));
export const clear = (id: number) => ipc.browserEval(id, CLEAR_JS).catch(() => {});
