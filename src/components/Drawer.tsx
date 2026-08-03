import { useEffect, useRef } from "react";
import { useStore } from "../core/store";
import { manager } from "../core/term";
import * as actions from "../core/actions";
import { nativeShortcutText } from "../core/keybinds";

/** DRAWER ⌘J — terminal rapida que sube desde abajo (estilo panel de VSCode),
 *  visible SOBRE cualquier superficie (shell z-85; sus terminales viven en el
 *  pool #term-pool-drawer z-86, encima del chat z-80).
 *
 *  MULTI-TERMINAL (17 jul): tabs en la cabecera como VSCode — `+` abre otra,
 *  click cambia, ✕ mata esa tab. Solo la ACTIVA se pinta en el host; las demas
 *  siguen vivas ocultas. Mismo patron de anclaje que Tiling: placeholder div +
 *  ResizeObserver → manager.place(id, rect). Las xterm JAMAS se re-montan. */
export default function Drawer() {
  const open = useStore((s) => s.ui.drawer);
  const terms = useStore((s) => s.drawerTerms);
  const termId = useStore((s) => s.drawerTermId);
  const panels = useStore((s) => s.panels);
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ y: number; h: number } | null>(null);
  const hRef = useRef<number>(
    Math.min(Math.max(Number(localStorage.getItem("sfterm-drawer-h")) || 300, 140), 800),
  );

  // anclar la terminal ACTIVA al placeholder; el cleanup la oculta al cambiar
  // de tab (o al cerrar el drawer), asi el switch es hide-vieja → place-nueva.
  // El FOCO se da AQUI, despues de place (el slot ya es visible): darlo en las
  // actions caia en un slot display:none y el teclado no aterrizaba.
  useEffect(() => {
    if (!open || termId == null) return;
    const el = hostRef.current;
    if (!el) return;
    const placeNow = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        manager.place(termId, { x: r.x, y: r.y, w: r.width, h: r.height });
      }
    };
    placeNow();
    manager.focus(termId);
    const ro = new ResizeObserver(placeNow);
    ro.observe(el);
    window.addEventListener("resize", placeNow);
    // ⚠️ BUG CAZADO (28 jul, reporte "no me deja bajar hasta abajo"): .drawer
    // abre con animation drawer-up (translateY 24px). El placeNow del mount
    // corre A MEDIA animacion y el rect trae la Y desplazada → la terminal
    // queda plantada hasta 24px mas abajo de su lugar final y sus ULTIMAS
    // FILAS mueren cortadas bajo el borde (el scroll SI esta en el fondo; el
    // fondo esta bajo la cortina). El ResizeObserver jamas se entera: un
    // transform no cambia el TAMAÑO. Fix: re-colocar al terminar la animacion
    // (+ un timer de respaldo por si animationend no llega — reduced motion).
    const root = el.closest(".drawer");
    const onAnimEnd = () => placeNow();
    root?.addEventListener("animationend", onAnimEnd);
    const settle = setTimeout(placeNow, 260);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", placeNow);
      root?.removeEventListener("animationend", onAnimEnd);
      clearTimeout(settle);
      manager.hide(termId);
    };
  }, [open, termId]);

  if (!open) return null;

  const tabTitle = (tid: number, i: number): string => {
    const p = panels[tid];
    const proc = p?.fgName && p.fgName !== "-zsh" ? p.fgName : "zsh";
    return terms.length > 1 ? `${proc} ${i + 1}` : proc;
  };

  return (
    <div className="drawer" style={{ height: hRef.current }}>
      <div
        className="drawer-sash"
        title="Arrastra para cambiar la altura"
        onPointerDown={(e) => {
          dragRef.current = { y: e.clientY, h: hRef.current };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          document.body.classList.add("resizing-y");
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          const h = Math.min(Math.max(d.h + (d.y - e.clientY), 140), window.innerHeight * 0.8);
          hRef.current = h;
          (e.currentTarget.parentElement as HTMLElement).style.height = `${h}px`;
        }}
        onPointerUp={(e) => {
          dragRef.current = null;
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
          document.body.classList.remove("resizing-y");
          localStorage.setItem("sfterm-drawer-h", String(Math.round(hRef.current)));
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          document.body.classList.remove("resizing-y");
        }}
      />
      <div className="drawer-head">
        <div className="drawer-tabs">
          {terms.map((tid, i) => (
            <div
              key={tid}
              className={`drawer-tab${tid === termId ? " active" : ""}`}
              onClick={() => actions.setDrawerActive(tid)}
              title={panels[tid]?.cwd || undefined}
            >
              <span className="drawer-tab-title">{tabTitle(tid, i)}</span>
              <button
                className="drawer-tab-x"
                title="Matar esta terminal"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.closePanel(tid);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button
          className="reader-btn"
          onClick={() => void actions.newDrawerTerm()}
          title="Nueva terminal en el panel"
        >
          +
        </button>
        <button
          className="reader-btn"
          onClick={() => void actions.toggleDrawer()}
          title={nativeShortcutText("Ocultar (⌘J) — las terminales siguen vivas")}
        >
          ✕
        </button>
      </div>
      <div className="drawer-host" ref={hostRef} />
    </div>
  );
}
