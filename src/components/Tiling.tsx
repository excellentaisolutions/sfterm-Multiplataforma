import { useCallback, useEffect, useRef, useState } from "react";
import { useStore, panelTitle } from "../core/store";
import * as T from "../core/tiling";
import { manager } from "../core/term";
import * as actions from "../core/actions";
import * as ipc from "../core/ipc";
import * as autofit from "../core/autofit";
import { iconForFile } from "../core/icons";
import BrowserView from "./BrowserView";
import FileView from "./FileView";
import Logo from "./Logo";
import { parseDroppedPaths, type DragSrc, type DropHint, type DropRegion, type Rect } from "../core/types";

const TAB_H = 30;
const GAP = 8;
const EDGE = 0.28; // fraccion del leaf que cuenta como borde para drops
/** ¿Este navegador es de la conversacion enfocada? Un navegador SIN dueño es
 *  el compartido de la era v1: se sigue mostrando siempre, o quedaria pintado
 *  en el arbol pero invisible para siempre. */
function ownsBrowser(tab: { owner?: number }, focused: number | null): boolean {
  return tab.owner === undefined || tab.owner === focused;
}

/** alto del chrome del navegador (debe calzar con .browser-chrome en CSS) */
const BROWSER_CHROME_H = 34;

// ---------- iconos del cluster de acciones del visor (mismo patron que
// ConvReader.tsx: cada archivo redeclara su svgProps, sin dependencia externa) ----------

const svgProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const IconEye = () => (
  <svg width={16} height={16} {...svgProps}>
    <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const IconEyeOff = () => (
  <svg width={16} height={16} {...svgProps}>
    <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
    <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
    <path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
    <path d="m2 2 20 20" />
  </svg>
);

const IconDiff = () => (
  <svg width={16} height={16} {...svgProps}>
    <rect x="3" y="3" width="12" height="12" rx="2" />
    <rect x="9" y="9" width="12" height="12" rx="2" />
  </svg>
);

const IconReveal = () => (
  <svg width={16} height={16} {...svgProps}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);

const IconGlobe = () => (
  <svg width={16} height={16} {...svgProps} className="ficon-globe">
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
  </svg>
);

// ---------- hit testing (compartido por drags pointer y nativos) ----------

function hitTest(x: number, y: number, termDrag = false): DropHint | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const tabEl = el.closest("[data-tab-index]") as HTMLElement | null;
  const frame = el.closest("[data-leaf-id]") as HTMLElement | null;
  if (!frame) {
    return el.closest("#center") ? { leafId: null, region: "center" } : null;
  }
  const leafId = frame.dataset.leafId!;
  const r = frame.getBoundingClientRect();
  if (tabEl || y - r.top <= TAB_H) {
    return {
      leafId,
      region: "tabs",
      tabIndex: tabEl ? Number(tabEl.dataset.tabIndex) : undefined,
    };
  }
  const rx = (x - r.left) / r.width;
  const ry = (y - r.top) / r.height;
  let region: DropRegion = "center";
  // el borde mas cercano gana si estamos dentro de su franja. Para drags de
  // TERMINAL no existe "center": tab solo via header, el cuerpo siempre
  // resuelve al borde mas cercano (split).
  const d = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
  const min = Math.min(d.left, d.right, d.top, d.bottom);
  if (min < EDGE || termDrag) {
    region =
      min === d.left ? "left" : min === d.right ? "right" : min === d.top ? "top" : "bottom";
  }
  return { leafId, region };
}

/** Arranca un drag interno (tab o rail). Compartido con Rail.tsx. */
export function startPointerDrag(
  e: React.PointerEvent,
  src: DragSrc,
  onClick?: () => void,
) {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  // ¿el drag lleva una TERMINAL? (rail siempre; tab solo si el item es term)
  const s0 = useStore.getState();
  const termDrag =
    src.kind === "rail" ||
    (src.kind === "tab" &&
      T.findLeaf(s0.root, src.leafId)?.tabs[src.index]?.kind === "term");
  let started = false;
  const move = (ev: PointerEvent) => {
    if (!started && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
    if (!started) {
      started = true;
      document.body.classList.add("dragging");
      // arrastrar una pestaña PREVIEW es el gesto de "posicionarla" que la
      // promueve a permanente (pedido de Daniel: "a menos que arrastre y
      // posicione"). Se promueve al cruzar el umbral, no al soltar: si el
      // drag termina en no-op (onClick) igual quedo fijada, que es correcto
      // — ya la moviste con la mano.
      if (src.kind === "tab") {
        const t = T.findLeaf(useStore.getState().root, src.leafId)?.tabs[src.index];
        if (t?.kind === "file" && t.preview) actions.promoteFileTab(src.leafId, src.index);
      }
    }
    const hint = hitTest(ev.clientX, ev.clientY, termDrag);
    useStore.getState().set({
      dragging: { src, x: ev.clientX, y: ev.clientY },
      dropHint: hint,
    });
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.classList.remove("dragging");
    const s = useStore.getState();
    const hint = s.dropHint;
    s.set({ dragging: null, dropHint: null });
    if (started && hint) {
      actions.dropOn(src, hint.leafId, hint.region, hint.tabIndex);
    } else if (!started && onClick) {
      onClick();
    }
    void ev;
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---------- drags nativos (archivos desde el arbol) ----------

function useNativeFileDrops() {
  useEffect(() => {
    let inside = 0;
    const over = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("text/plain")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      const hint = hitTest(e.clientX, e.clientY);
      useStore.getState().set({ dropHint: hint });
    };
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("text/plain")) return;
      inside++;
      document.body.classList.add("dragging-file");
    };
    const leave = () => {
      inside = Math.max(0, inside - 1);
      if (inside === 0) {
        document.body.classList.remove("dragging-file");
        useStore.getState().set({ dropHint: null });
      }
    };
    const drop = (e: DragEvent) => {
      const paths = parseDroppedPaths(e.dataTransfer?.getData("text/plain") ?? "");
      inside = 0;
      document.body.classList.remove("dragging-file");
      const s = useStore.getState();
      const hint = s.dropHint;
      s.set({ dropHint: null });
      if (!paths.length) return;
      e.preventDefault();
      if (hint) {
        actions.dropOn({ kind: "file", path: paths[0], paths }, hint.leafId, hint.region, hint.tabIndex);
      }
    };
    const center = document.getElementById("center");
    if (!center) return;
    center.addEventListener("dragover", over);
    center.addEventListener("dragenter", enter);
    center.addEventListener("dragleave", leave);
    center.addEventListener("drop", drop);
    return () => {
      center.removeEventListener("dragover", over);
      center.removeEventListener("dragenter", enter);
      center.removeEventListener("dragleave", leave);
      center.removeEventListener("drop", drop);
    };
  }, []);
}

// ---------- componente ----------

export default function Tiling() {
  const ref = useRef<HTMLDivElement>(null);
  const root = useStore((s) => s.root);
  const treeVersion = useStore((s) => s.treeVersion);
  const panels = useStore((s) => s.panels);
  const focusedLeaf = useStore((s) => s.focusedLeaf);
  // ⚠️ el efecto de colocacion DEPENDE del foco: el slot del navegador sigue a
  // la conversacion enfocada. Sin esto, moverte a una conversacion SIN
  // navegador no re-corre el efecto y el webview de la anterior se queda
  // pintado — verias la web de otro agente creyendo que es la tuya.
  const focusedTerm = useStore((s) => s.focused);
  const soloLeaf = useStore((s) => s.soloLeaf);
  const dragging = useStore((s) => s.dragging);
  const dropHint = useStore((s) => s.dropHint);
  const railVisible = useStore((s) => s.railVisible);
  const treeVisible = useStore((s) => s.treeVisible);
  const treeRoot = useStore((s) => s.treeRoot);
  const git = useStore((s) => s.git);
  const browserMeta = useStore((s) => s.browserMeta);
  // el WKWebView del navegador es NATIVO: siempre pinta ENCIMA del DOM. Con
  // cualquier overlay abierto (paleta, lector, drawer…) o un drag en curso
  // (hints de drop) se ESCONDE — si no, taparia lo que flota. findbar y
  // composer quedan fuera a proposito: son chicos y frecuentes (⌘I con el
  // navegador a la vista no debe parpadear).
  const overlayUp = useStore(
    (s) =>
      s.ui.palette ||
      s.ui.finder ||
      s.ui.settings ||
      s.ui.shortcuts ||
      s.ui.chat ||
      s.ui.drawer ||
      s.ui.search ||
      !!s.ui.reader ||
      !!s.ui.preview,
  );
  const [box, setBox] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  // UX del navegador (modo iPhone / chrome crecido): re-posicionar al cambiar
  const browserUx = useStore((s) => s.browserUx);

  useNativeFileDrops();

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    setBox({ x: b.left, y: b.top, w: b.width, h: b.height });
  }, []);

  useEffect(() => {
    measure();
    const ro = new ResizeObserver(() => measure());
    if (ref.current) ro.observe(ref.current);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, railVisible, treeVisible]);

  const inner: Rect = { x: GAP, y: GAP, w: Math.max(0, box.w - GAP * 2), h: Math.max(0, box.h - GAP * 2) };
  // COLAPSO DE RENDER: los campos que solo tienen navegadores de OTRA
  // conversacion no reciben un pixel (siguen vivos en el arbol — volver a su
  // conversacion los restaura sin recargar). Ver tiling.leavesOcultas.
  // `solo` (expandir) gana sobre el plegado por conversacion: si un campo esta
  // expandido, es el UNICO que recibe pixeles.
  const ocultas = T.leavesOcultas(root, focusedTerm, soloLeaf);
  const rects = T.layoutRects(root, inner, GAP, ocultas);
  const dividers = T.dividerRects(root, inner, GAP, ocultas);
  // booleano estable: `dragging` muta en cada pointermove y re-dispararia el
  // placement imperativo (spam de IPC al webview nativo) en pleno drag
  const draggingOn = dragging !== null;

  // colocacion IMPERATIVA de terminales: el tab term activo de cada leaf se
  // pinta en su rect (coords viewport); todo lo demas se esconde. Los xterm
  // JAMAS se re-montan: solo se mueven sus divs.
  useEffect(() => {
    const s = useStore.getState();
    const visible = new Set<number>();
    const visibleBrowsers = new Set<number>();
    for (const { leafId, rect } of rects) {
      const leaf = T.findLeaf(s.root, leafId);
      if (!leaf) continue;
      const act = T.activeTab(leaf);
      if (act?.kind === "term") {
        visible.add(act.id);
        manager.place(act.id, {
          x: box.x + rect.x + 1,
          y: box.y + rect.y + TAB_H,
          w: rect.w - 2,
          h: rect.h - TAB_H - 1,
        });
      } else if (act?.kind === "browser" && ownsBrowser(act, s.focused)) {
        // el WKWebView nativo se posiciona igual que una terminal del pool,
        // debajo de la fila de tabs Y del chrome (url bar) del BrowserView.
        // extraH = chrome crecido (dialogo JS / find / toast de descarga);
        // mobile = viewport iPhone (~390px) centrado en el panel.
        //
        // ⚠️ SOLO se coloca el navegador de la conversacion ENFOCADA. El slot
        // sigue al foco: si el tab activo es de otra, no se pinta ningun
        // webview y el campo muestra su estado vacio. Colocar el ajeno seria
        // enseñarte lo que otro agente esta navegando creyendo que es el tuyo.
        visibleBrowsers.add(act.id);
        const ux = browserUx[act.id];
        const extra = ux?.extraH ?? 0;
        let bx = box.x + rect.x + 1;
        let bw = rect.w - 2;
        if (ux?.mobile && bw > 390) {
          bx += (bw - 390) / 2;
          bw = 390;
        }
        void ipc.browserPlace(
          act.id,
          {
            x: bx,
            y: box.y + rect.y + TAB_H + BROWSER_CHROME_H + extra,
            w: bw,
            h: rect.h - TAB_H - BROWSER_CHROME_H - extra - 1,
          },
          !overlayUp && !draggingOn,
        );
        // el ala cambio de ancho: re-encoger (o devolver a 100% si ya cabe).
        // Con debounce adentro, asi que el arrastre del divisor no lo satura.
        if (!draggingOn) autofit.schedule(act.id);
      }
    }
    for (const idStr of Object.keys(s.panels)) {
      const id = Number(idStr);
      // las terminales del drawer (⌘J) tienen su propio dueño: Tiling no las toca
      if (!visible.has(id) && !s.drawerTerms.includes(id)) manager.hide(id);
    }
    for (const id of T.browserIds(s.root)) {
      if (!visibleBrowsers.has(id)) {
        // BACKSTAGE, no apagada. A 0x0 y oculta no hay layout, y sin layout su
        // agente no puede medir ni clickear: la unica salida que le quedaba
        // era DESPLEGARLA, y eso le mueve la pantalla a Daniel. Con dos
        // agentes en paralelo era una pelea por el foco (reporte 29 jul).
        void ipc.browserPlace(id, { x: 0, y: 0, w: 0, h: 0 }, true, true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeVersion, box.x, box.y, box.w, box.h, railVisible, treeVisible, overlayUp, draggingOn, browserUx, focusedTerm, soloLeaf]);

  // ---------- dividers ----------
  const onDividerDown = (d: T.DividerRect) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const horizontal = d.dir === "row";
    const start = horizontal ? e.clientX : e.clientY;
    const total = Math.max(1, d.span); // px del split: delta px -> fraccion
    let last = start;
    const move = (ev: PointerEvent) => {
      const cur = horizontal ? ev.clientX : ev.clientY;
      const deltaFrac = (cur - last) / total;
      if (Math.abs(deltaFrac) < 0.002) return;
      last = cur;
      const s = useStore.getState();
      s.setRoot(T.resizeSplit(s.root, d.splitId, d.index, deltaFrac));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      actions.scheduleSessionSave();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // ---------- tabs + cluster de acciones del visor (una sola fila, 30px) ----------
  const renderActions = (leaf: T.LeafNode) => {
    const act = T.activeTab(leaf);
    if (!act || act.kind !== "file") return <div className="leaf-actions" />;
    const name = act.path.split("/").pop() ?? "";
    const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
    const isMd = (ext === "md" || ext === "markdown") && act.mode !== "diff";
    const relPath = act.path.startsWith(treeRoot + "/") ? act.path.slice(treeRoot.length + 1) : act.path;
    const showDiff = !!git?.files?.[relPath] || act.mode === "diff";
    return (
      <div className="leaf-actions">
        {isMd && (
          <button
            className={`leaf-action-btn ${!act.raw ? "on" : ""}`}
            title={act.raw ? "Ver renderizado (⌘⇧M)" : "Ver fuente (⌘⇧M)"}
            onClick={() => actions.setFileTabRaw(leaf.id, leaf.active, !act.raw)}
          >
            {act.raw ? <IconEyeOff /> : <IconEye />}
          </button>
        )}
        {showDiff && (
          <button
            className={`leaf-action-btn ${act.mode === "diff" ? "on" : ""}`}
            title="Ver diff"
            onClick={() =>
              actions.setFileTabMode(leaf.id, leaf.active, act.mode === "diff" ? "auto" : "diff")
            }
          >
            <IconDiff />
          </button>
        )}
        <button
          className="leaf-action-btn"
          title="Revelar en Finder"
          onClick={() => void ipc.revealInFinder(act.path)}
        >
          <IconReveal />
        </button>
      </div>
    );
  };

  const renderBar = (leaf: T.LeafNode) => (
    <div className="leaf-bar" data-leaf-id={leaf.id}>
      <div className="leaf-tabs">
        {leaf.tabs.map((tab, i) => {
          // ⚠️ Los navegadores de OTRAS conversaciones siguen VIVOS en el
          // arbol (para eso son suyos) pero no se listan: si no, la barra se
          // llenaria de pestañas identicas — una por agente — y ⇧Tab pasearia
          // por navegadores ajenos que ademas no se pintan. El slot muestra
          // uno a la vez, el de quien tiene el foco.
          if (tab.kind === "browser" && !ownsBrowser(tab, focusedTerm)) return null;
          const active = i === leaf.active;
          const preview = tab.kind === "file" && !!tab.preview;
          let label: string;
          let icon: React.ReactNode = null;
          if (tab.kind === "term") {
            const p = panels[tab.id];
            label = p ? panelTitle(p) : `terminal`;
          } else if (tab.kind === "browser") {
            const m = browserMeta[tab.id];
            const host = m?.url ? (m.url.match(/^https?:\/\/([^/]+)/)?.[1] ?? "") : "";
            label = m?.title || host || "navegador";
            icon = <IconGlobe />;
          } else {
            const name = tab.path.split("/").pop() ?? tab.path;
            label = tab.mode === "diff" ? `${name} (diff)` : name;
            icon = <img className="ficon" src={iconForFile(name)} alt="" draggable={false} />;
          }
          return (
            <div
              key={tab.kind === "term" ? `t${tab.id}` : tab.kind === "browser" ? `b${tab.id}` : `f${tab.path}`}
              className={`tab-item ${active ? "active" : ""} ${preview ? "preview" : ""}`}
              data-tab-index={i}
              title={tab.kind === "file" ? tab.path : undefined}
              onPointerDown={(e) => {
                if ((e.target as HTMLElement).closest(".tab-close")) return;
                startPointerDrag(e, { kind: "tab", leafId: leaf.id, index: i }, () =>
                  actions.activateTabAt(leaf.id, i),
                );
              }}
              onDoubleClick={() => {
                if (preview) actions.promoteFileTab(leaf.id, i);
              }}
            >
              {icon}
              <span className="tab-label">{label}</span>
              <span
                className="tab-close"
                title={
                  tab.kind === "term"
                    ? "Quitar de la vista (⌘W). La conversación sigue VIVA en el rail — para cerrarla de verdad, la ✕ del rail"
                    : tab.kind === "browser"
                      ? "Cerrar el navegador (⌘W)"
                      : "Cerrar el archivo (⌘W)"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  actions.closeTab(leaf.id, i);
                }}
              >
                ✕
              </span>
            </div>
          );
        })}
        {/* + de PESTAÑA NUEVA del navegador: a la derecha de las pestañas,
            como en cualquier navegador (pedido de Daniel 30 jul). Solo se
            pinta cuando el campo tiene navegador de esta conversacion. */}
        {leaf.tabs.some((t) => t.kind === "browser" && ownsBrowser(t, focusedTerm)) && (
          <button
            className="tab-plus"
            title="Nueva pestaña del navegador (misma conversación)"
            onClick={() => void actions.openBrowser(undefined, undefined, true)}
          >
            +
          </button>
        )}
      </div>
      {renderActions(leaf)}
    </div>
  );

  // ---------- drop hint visual ----------
  const hintStyle = (rect: Rect, hint: DropHint): React.CSSProperties => {
    const base = { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
    switch (hint.region) {
      case "left": return { ...base, width: rect.w / 2 };
      case "right": return { ...base, left: rect.x + rect.w / 2, width: rect.w / 2 };
      case "top": return { ...base, height: rect.h / 2 };
      case "bottom": return { ...base, top: rect.y + rect.h / 2, height: rect.h / 2 };
      case "tabs": return { left: rect.x, top: rect.y, width: rect.w, height: TAB_H };
      default: return base;
    }
  };

  const showDrops = dragging !== null || dropHint !== null;

  return (
    <div id="center" ref={ref}>
      {rects.map(({ leafId, rect }) => {
        const leaf = T.findLeaf(root, leafId);
        if (!leaf) return null;
        const act = T.activeTab(leaf);
        const isFocused = focusedLeaf === leafId;
        return (
          <div
            key={leafId}
            className={`leaf-frame ${isFocused ? "focused" : ""}`}
            data-leaf-id={leafId}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            onPointerDown={() => {
              if (useStore.getState().focusedLeaf !== leafId) actions.focusLeaf(leafId);
            }}
          >
            {renderBar(leaf)}
            {act?.kind === "file" && (
              <div className="leaf-content">
                <FileView path={act.path} mode={act.mode} raw={!!act.raw} />
              </div>
            )}
            {act?.kind === "browser" && ownsBrowser(act, focusedTerm) && (
              <div className="leaf-content">
                <BrowserView id={act.id} />
                {/* el WKWebView nativo pinta sobre este hueco (lo posiciona
                    el efecto imperativo de arriba, patron term-pool) */}
                <div className="browser-host" />
              </div>
            )}
            {/* NO hay estado vacio: un campo que solo tiene navegadores de
                otra conversacion ni siquiera recibe rect (leavesOcultas), asi
                que este componente jamas se monta para el. La terminal se
                queda con la pantalla entera. */}
          </div>
        );
      })}

      {dividers.map((d, i) => (
        <div
          key={`${d.splitId}-${d.index}-${i}`}
          className={`split-divider ${d.dir}`}
          style={{ left: d.rect.x, top: d.rect.y, width: d.rect.w, height: d.rect.h }}
          onPointerDown={onDividerDown(d)}
        />
      ))}

      {!root && (
        <div className="center-empty" onClick={() => void actions.newTerminal()}>
          <Logo size={64} />
          <span>⌘J · terminal &nbsp;·&nbsp; ⌘⌥J · agente</span>
        </div>
      )}

      {showDrops && dropHint && (
        <div className="drop-overlay">
          {dropHint.leafId === null ? (
            <div className="drop-region hot" style={{ left: inner.x, top: inner.y, width: inner.w, height: inner.h }} />
          ) : (
            (() => {
              const r = rects.find((x) => x.leafId === dropHint.leafId);
              return r ? <div className="drop-region hot" style={hintStyle(r.rect, dropHint)} /> : null;
            })()
          )}
        </div>
      )}
    </div>
  );
}
