import { useCallback, useEffect, useRef, useState } from "react";

/** Ancho de un panel lateral, persistente (localStorage) y con clamp.
 *  El layout NO se toca: solo cambia el width; los vecinos flexean y el
 *  ResizeObserver del tiling re-acomoda terminales sin re-montarlas.
 *
 *  UN ancho por PANEL, no por superficie (18 jul, pedido de Daniel): el rail
 *  de conversaciones y el arbol comparten LLAVE entre el chat y el taller
 *  (`sfterm-w-rail` / `sfterm-w-tree`), y todos los hooks con la misma llave
 *  se mueven JUNTOS en vivo (store del modulo + localStorage). Cambiar de
 *  vista jamas cambia un ancho. */
export interface PaneWidth {
  w: number;
  set: (px: number) => void;
  reset: () => void;
}

type Entry = { w: number; subs: Set<(w: number) => void> };
const store = new Map<string, Entry>();

function entryFor(
  key: string,
  def: number,
  min: number,
  max: number,
  legacy?: string[],
): Entry {
  let e = store.get(key);
  if (!e) {
    let v = Number(localStorage.getItem(key));
    if (!Number.isFinite(v) || v < min || v > max) {
      // migracion: hereda el ancho que ya tenias en las llaves viejas
      // (pre-unificacion: sfterm-w-chatside / sfterm-w-chattree / sfterm-w-side)
      for (const k of legacy ?? []) {
        const lv = Number(localStorage.getItem(k));
        if (Number.isFinite(lv) && lv >= min && lv <= max) {
          v = lv;
          break;
        }
      }
    }
    e = {
      w: Number.isFinite(v) && v >= min && v <= max ? v : def,
      subs: new Set(),
    };
    store.set(key, e);
  }
  return e;
}

export function usePaneWidth(
  key: string,
  def: number,
  min: number,
  max: number,
  legacy?: string[],
): PaneWidth {
  const [w, setW] = useState<number>(() => entryFor(key, def, min, max, legacy).w);
  useEffect(() => {
    const e = entryFor(key, def, min, max);
    e.subs.add(setW);
    setW(e.w); // por si otro hook lo movio entre el init y el mount
    return () => {
      e.subs.delete(setW);
    };
    // def/min/max son literales estables en los call sites; legacy solo
    // importa en la PRIMERA hidratacion del store
  }, [key, def, min, max]);
  const set = useCallback(
    (px: number) => {
      const clamped = Math.min(max, Math.max(min, Math.round(px)));
      const e = entryFor(key, def, min, max);
      e.w = clamped;
      for (const fn of e.subs) fn(clamped);
      try {
        localStorage.setItem(key, String(clamped));
      } catch { /* private mode */ }
    },
    [key, def, min, max],
  );
  const reset = useCallback(() => set(def), [set, def]);
  return { w, set, reset };
}

/** Sash vertical estilo VSCode: hit-area de 6px MONTADA sobre el borde
 *  (margins negativos), highlight con delay al hover, accent mientras
 *  arrastras (pointer capture), doble click = restaurar el default. */
export default function PaneResizer(props: {
  pane: PaneWidth;
  /** 1 = el panel vive a la IZQUIERDA del sash (arrastrar → agranda);
   *  -1 = el panel vive a la DERECHA. */
  dir: 1 | -1;
}) {
  const { pane, dir } = props;
  const [active, setActive] = useState(false);
  const drag = useRef<{ x: number; w: number } | null>(null);

  const end = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch { /* capture ya liberada */ }
    setActive(false);
    document.body.classList.remove("resizing-x");
  };

  return (
    <div
      className={`pane-resizer${active ? " active" : ""}`}
      title="Arrastra para redimensionar · doble click restaura"
      onDoubleClick={pane.reset}
      onPointerDown={(e) => {
        e.preventDefault();
        drag.current = { x: e.clientX, w: pane.w };
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setActive(true);
        document.body.classList.add("resizing-x");
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        pane.set(drag.current.w + dir * (e.clientX - drag.current.x));
      }}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}
