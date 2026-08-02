/** EL CICLADO — moverse con el teclado por las dos listas que Daniel ve:
 *  las PESTAÑAS del campo enfocado (⇧Tab) y las TERMINALES del rail (⌥Tab).
 *
 *  Todo aqui es PURO y testeable: la parte con efectos (activar el tab,
 *  traer la terminal a la vista) vive en actions.ts. La razon de que exista
 *  el modulo es una sola:
 *
 *  ⚠️ EL ORDEN DEL CICLADO TIENE QUE SER EL ORDEN QUE SE VE. `sortByRail`
 *  vivia dentro de Rail.tsx; si el teclado se hubiera hecho su propia copia,
 *  arrastrar una fila del rail habria cambiado lo que ves pero no por donde
 *  te mueves. Por eso el Rail IMPORTA de aqui en vez de tener lo suyo: una
 *  sola funcion, imposible que driftee.
 */
/** Lo UNICO que el ciclado necesita saber de una terminal. Generico
 *  estructural a proposito: asi este modulo no arrastra el grafo de tipos de
 *  la app y se puede probar solo — el runner de tests compila con node16,
 *  donde importar "./types" exigiria extension .js. `PanelMeta` encaja sin
 *  que ninguno de los dos lados tenga que declararlo. */
export interface Cyclable {
  id: number;
}

/** Siguiente indice de una lista circular, o null si no hay a donde ir.
 *  `null` con menos de 2 elementos NO es un detalle: es lo que deja pasar
 *  ⇧Tab al PTY cuando el campo tiene una sola pestaña (⇧Tab es del TUI de
 *  claude — ahi cicla los modos de permiso). Ver App.tsx::willConsume. */
export function stepIndex(len: number, cur: number, dir: 1 | -1): number | null {
  if (len < 2) return null;
  const base = cur >= 0 && cur < len ? cur : 0;
  return (base + dir + len) % len;
}

/** Orden del rail: las filas que Daniel movio a mano mandan, y las que no
 *  estan en `order` caen al final por id (una terminal nueva nace abajo).
 *  `order` es una PISTA, no la fuente de existencia: ids muertos ahi dentro
 *  son inofensivos porque se pinta `panels`, no la lista. */
export function sortByRail<T extends Cyclable>(list: T[], order: number[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...list].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra != null && rb != null) return ra - rb;
    if (ra != null) return -1; // los ordenados a mano mandan
    if (rb != null) return 1;
    return a.id - b.id;
  });
}

/** Las terminales ciclables, en el orden del rail. Las del drawer (⌘J) NO
 *  entran: no viven en el rail, asi que ⌥Tab no puede saltar a algo que
 *  Daniel no ve en la lista. */
export function cyclableTerms<T extends Cyclable>(
  panels: Record<number, T>,
  drawerTerms: number[],
  railOrder: number[],
): T[] {
  const drawer = new Set(drawerTerms);
  return sortByRail(
    Object.values(panels).filter((p) => !drawer.has(p.id)),
    railOrder,
  );
}

/** La terminal a la que salta ⌥Tab, o null si no hay a donde.
 *
 *  Si la enfocada no esta en la lista (foco en un archivo, en el drawer, o
 *  ninguna terminal enfocada) el salto NO se cancela: aterriza en la primera
 *  con dir=1 y en la ultima con dir=-1. Cancelarlo dejaria ⌥Tab muerto
 *  justo cuando Daniel esta mirando un diff y quiere volver a una terminal. */
export function nextTermId(
  ordered: Cyclable[],
  focused: number | null,
  dir: 1 | -1,
): number | null {
  if (!ordered.length) return null;
  const i = focused == null ? -1 : ordered.findIndex((p) => p.id === focused);
  if (i < 0) return (dir === 1 ? ordered[0] : ordered[ordered.length - 1]).id;
  const next = stepIndex(ordered.length, i, dir);
  return next == null ? null : ordered[next].id;
}

/** Un tab, visto por el ciclado: solo importa si es un navegador y de quien. */
export interface TabLike {
  kind: string;
  owner?: number;
}

/** Los indices de las pestañas VISIBLES de un campo.
 *
 *  ⚠️ No es `tabs` entero: los navegadores de OTRAS conversaciones siguen vivos
 *  en el arbol pero no se pintan (el slot muestra uno a la vez, el de quien
 *  tiene el foco). Ciclar sobre la lista cruda pararia en pestañas invisibles
 *  — pulsaciones que no hacen nada — y, peor, con UNA pestaña real mas un
 *  navegador ajeno, ⇧Tab se creeria con 2 y se tragaria la tecla que le toca
 *  al TUI de claude. */
export function visibleTabs(tabs: TabLike[], focused: number | null): number[] {
  const out: number[] = [];
  tabs.forEach((t, i) => {
    if (t.kind === "browser" && t.owner !== undefined && t.owner !== focused) return;
    out.push(i);
  });
  return out;
}
