// Modelo de tiling v2: arbol de splits con pestañas por campo (leaf).
// TODO es puro e inmutable: cada op devuelve un arbol nuevo. Los xterm viven
// fuera (term-pool); este modelo solo decide DONDE se pinta cada cosa.

import type { Rect } from "./types";

export type TabItem =
  | { kind: "term"; id: number }
  | {
      kind: "file";
      path: string;
      mode: "auto" | "diff";
      /** tab PREVIEW (itálica, estilo VSCode): una apertura ligera (clic del
       *  arbol) que se REEMPLAZA sola en vez de acumularse. Maximo uno por
       *  leaf. Ausente/false = permanente. */
      preview?: boolean;
      /** toggle render<->fuente de un archivo markdown, a nivel de TAB (no
       *  local al componente: se pierde al cambiar de pestaña si no vive aqui). */
      raw?: boolean;
    }
  /** NAVEGADOR DEL AGENTE (F1): un WKWebView nativo (browser.rs) que vive
   *  como panel del tiling. `id` es el id del webview en Rust. NO se
   *  serializa en la sesion (el webview muere con la app, mismo criterio que
   *  el revival de conversaciones: mejor ninguna imitacion). */
  | {
      kind: "browser";
      id: number;
      /** DUEÑO: la terminal (conversacion) de la que es este navegador.
       *
       *  La propiedad vive en el TAB y no en un mapa aparte del store a
       *  proposito: asi no hay dos verdades que sincronizar: cerrar el tab ya
       *  se lleva la relacion, y ningun mapa puede quedar apuntando a un
       *  navegador muerto.
       *
       *  ⚠️ OPCIONAL a proposito. Ausente = el navegador COMPARTIDO de v1
       *  (el que resolvia "el primero del arbol"). Sin esa puerta, cualquier
       *  navegador ya abierto quedaria sin dueño y las funciones nuevas lo
       *  ignorarian: se veria en pantalla pero seria inalcanzable. */
      owner?: number;
    };

export interface LeafNode {
  kind: "leaf";
  id: string;
  tabs: TabItem[];
  active: number;
}

export interface SplitNode {
  kind: "split";
  id: string;
  dir: "row" | "col"; // row = hijos lado a lado; col = apilados
  children: TilingNode[];
  sizes: number[]; // fracciones que suman 1
}

export type TilingNode = LeafNode | SplitNode;

export type Side = "left" | "right" | "top" | "bottom";

let counter = 0;
export function nextNodeId(): string {
  return `n${++counter}`;
}

export function makeLeaf(tabs: TabItem[], active = 0): LeafNode {
  return { kind: "leaf", id: nextNodeId(), tabs, active };
}

export function sameTab(a: TabItem, b: TabItem): boolean {
  if (a.kind === "term" && b.kind === "term") return a.id === b.id;
  if (a.kind === "file" && b.kind === "file") return a.path === b.path;
  if (a.kind === "browser" && b.kind === "browser") return a.id === b.id;
  return false;
}

// ---------- lectura ----------

export function walkLeaves(root: TilingNode | null, cb: (l: LeafNode) => void) {
  if (!root) return;
  if (root.kind === "leaf") return cb(root);
  root.children.forEach((c) => walkLeaves(c, cb));
}

export function leaves(root: TilingNode | null): LeafNode[] {
  const out: LeafNode[] = [];
  walkLeaves(root, (l) => out.push(l));
  return out;
}

export function findLeaf(root: TilingNode | null, leafId: string): LeafNode | null {
  let hit: LeafNode | null = null;
  walkLeaves(root, (l) => {
    if (l.id === leafId) hit = l;
  });
  return hit;
}

/** Leaf que contiene una terminal. */
export function leafOfTerm(root: TilingNode | null, ptyId: number): LeafNode | null {
  let hit: LeafNode | null = null;
  walkLeaves(root, (l) => {
    if (l.tabs.some((t) => t.kind === "term" && t.id === ptyId)) hit = l;
  });
  return hit;
}

/** Leaf que contiene un archivo abierto. */
export function leafOfFile(root: TilingNode | null, path: string): LeafNode | null {
  let hit: LeafNode | null = null;
  walkLeaves(root, (l) => {
    if (l.tabs.some((t) => t.kind === "file" && t.path === path)) hit = l;
  });
  return hit;
}

/** Leaf que contiene el navegador DE UNA conversacion.
 *
 *  `owner` undefined = "cualquiera, el primero que aparezca" (el comportamiento
 *  v1, que siguen usando los caminos que aun no saben de quien preguntan).
 *  Con `owner` puesto busca EXACTAMENTE el de esa terminal, y un navegador sin
 *  dueño (heredado de v1) tambien califica: es el unico que puede reclamar. */
export function leafOfBrowser(
  root: TilingNode | null,
  owner?: number,
): { leaf: LeafNode; index: number } | null {
  let hit: { leaf: LeafNode; index: number } | null = null;
  walkLeaves(root, (l) => {
    const i = l.tabs.findIndex(
      (t) => t.kind === "browser" && (owner === undefined || t.owner === owner || t.owner === undefined),
    );
    if (i >= 0 && !hit) hit = { leaf: l, index: i };
  });
  return hit;
}

/** El leaf donde vive el SLOT del navegador, sea de quien sea. Con el modelo
 *  "sigue al foco" el campo NO desaparece cuando la conversacion enfocada no
 *  tiene navegador: si se cerrara, tu layout colapsaria y volveria a abrirse
 *  en cada ⌥Tab, que es peor que el problema que vino a resolver. */
export function leafOfAnyBrowser(root: TilingNode | null): { leaf: LeafNode; index: number } | null {
  return leafOfBrowser(root, undefined);
}

/** El webview de una conversacion, o null si esa conversacion no abrio ninguno. */
/** El navegador de esa conversacion. Con VARIAS pestañas (29 jul) gana la
 *  ACTIVA: es la que Daniel esta viendo, y un agente que actuara sobre una
 *  pestaña de atras estaria operando a ciegas mientras la pantalla muestra
 *  otra cosa — la misma clase de fallo que "prestar el navegador ajeno". */
export function browserIdOf(root: TilingNode | null, owner: number): number | null {
  let activo: number | null = null;
  let primero: number | null = null;
  walkLeaves(root, (l) => {
    l.tabs.forEach((t, i) => {
      if (t.kind !== "browser" || t.owner !== owner) return;
      if (primero == null) primero = t.id;
      if (activo == null && i === l.active) activo = t.id;
    });
  });
  return activo ?? primero;
}

/** Ids de todos los navegadores vivos en el arbol. */
export function browserIds(root: TilingNode | null): number[] {
  const out: number[] = [];
  walkLeaves(root, (l) => {
    l.tabs.forEach((t) => {
      if (t.kind === "browser") out.push(t.id);
    });
  });
  return out;
}

export function termIds(root: TilingNode | null): number[] {
  const out: number[] = [];
  walkLeaves(root, (l) => {
    l.tabs.forEach((t) => {
      if (t.kind === "term") out.push(t.id);
    });
  });
  return out;
}

export function activeTab(leaf: LeafNode): TabItem | null {
  return leaf.tabs[leaf.active] ?? null;
}

// ---------- geometria ----------

export interface LeafRect {
  leafId: string;
  rect: Rect;
}

/** Rects en pixeles por leaf. gap entre campos. */
const NADA_OCULTO: ReadonlySet<string> = new Set();

/** El CAMPO DEL NAVEGADOR: un leaf que solo contiene navegadores.
 *
 *  ⚠️ Existe porque un navegador JAMAS debe compartir campo con una terminal
 *  (29 jul 2026, bug reportado por Daniel: al abrir el navegador se colaba
 *  como pestaña junto a su terminal, y clickear esa conversacion en el rail
 *  la "movia a la derecha" — dos conversaciones revueltas en un panel). El
 *  navegador es un ALA, no una pestaña del taller. */
export function leafSoloBrowsers(root: TilingNode | null): LeafNode | null {
  if (!root) return null;
  for (const leaf of leaves(root)) {
    if (leaf.tabs.length && leaf.tabs.every((t) => t.kind === "browser")) return leaf;
  }
  return null;
}

/** El id del CAMPO donde vive este navegador (para expandirlo). */
export function leafOfBrowserId(root: TilingNode | null, browserId: number): string | null {
  if (!root) return null;
  for (const leaf of leaves(root)) {
    if (leaf.tabs.some((t) => t.kind === "browser" && t.id === browserId)) return leaf.id;
  }
  return null;
}

/** Las conversaciones que tienen navegador propio. El rail lo usa para
 *  marcarlas: como el ala solo se ve dentro de SU conversacion, sin esta
 *  señal los navegadores de las demas serian invisibles. */
export function ownersConBrowser(root: TilingNode | null): ReadonlySet<number> {
  const out = new Set<number>();
  if (!root) return out;
  for (const leaf of leaves(root)) {
    for (const t of leaf.tabs) {
      if (t.kind === "browser" && t.owner !== undefined) out.add(t.owner);
    }
  }
  return out;
}

/** Los campos que NO se pintan en esta conversacion: aquellos donde TODO lo
 *  que hay son navegadores de OTRA. Regla de UX (29 jul 2026, pedido de
 *  Daniel): el navegador es un ala de SU conversacion — donde no lo abriste,
 *  no existe; ni panel, ni tarjeta vacia, ni hueco. La terminal se queda con
 *  la pantalla entera. */
export function leavesOcultas(
  root: TilingNode | null,
  conversacion: number | null,
  /** SOLO (⌘⇧E): el unico campo que se pinta; todo lo demas se pliega. Es
   *  expandir sin mover el arbol — el mismo mecanismo que el ala plegada, al
   *  reves. Volver es exacto porque nada se movio. */
  solo?: string | null,
): ReadonlySet<string> {
  if (!root) return NADA_OCULTO;
  const out = new Set<string>();
  for (const leaf of leaves(root)) {
    if (!leaf.tabs.length) continue;
    if (solo) {
      if (leaf.id !== solo) out.add(leaf.id);
      continue;
    }
    const todoAjeno = leaf.tabs.every(
      (t) => t.kind === "browser" && t.owner !== undefined && t.owner !== conversacion,
    );
    if (todoAjeno) out.add(leaf.id);
  }
  return out.size ? out : NADA_OCULTO;
}

/** ¿este nodo tiene algo que mostrar AHORA? Un split cuyos hijos estan todos
 *  ocultos tambien lo esta. Base del COLAPSO DE RENDER (29 jul 2026): el
 *  navegador de otra conversacion sigue VIVO en el arbol pero no ocupa un
 *  pixel — asi volver a su conversacion lo restaura al instante, sin recargar
 *  la pagina y sin que el layout brinque. */
function tieneAlgoQueMostrar(node: TilingNode, hidden: ReadonlySet<string>): boolean {
  if (node.kind === "leaf") return !hidden.has(node.id);
  return node.children.some((c) => tieneAlgoQueMostrar(c, hidden));
}

export function layoutRects(
  root: TilingNode | null,
  rect: Rect,
  gap: number,
  hidden: ReadonlySet<string> = NADA_OCULTO,
): LeafRect[] {
  if (!root) return [];
  if (root.kind === "leaf") return hidden.has(root.id) ? [] : [{ leafId: root.id, rect }];

  // solo los hijos con algo que mostrar reparten el espacio; si queda UNO, se
  // queda con TODO (el campo del vecino oculto no deja hueco ni divisor)
  const vivos = root.children.filter((c) => tieneAlgoQueMostrar(c, hidden));
  if (vivos.length === 0) return [];
  if (vivos.length === 1) return layoutRects(vivos[0], rect, gap, hidden);

  const fracs = vivos.map(
    (c) => root.sizes[root.children.indexOf(c)] ?? 1 / root.children.length,
  );
  const suma = fracs.reduce((a, b) => a + b, 0) || 1;
  const out: LeafRect[] = [];
  const total = root.dir === "row" ? rect.w : rect.h;
  const avail = total - gap * (vivos.length - 1);
  let cursor = root.dir === "row" ? rect.x : rect.y;
  vivos.forEach((child, i) => {
    const span = Math.round(avail * (fracs[i] / suma));
    const r: Rect =
      root.dir === "row"
        ? { x: cursor, y: rect.y, w: span, h: rect.h }
        : { x: rect.x, y: cursor, w: rect.w, h: span };
    out.push(...layoutRects(child, r, gap, hidden));
    cursor += span + gap;
  });
  return out;
}

export interface DividerRect {
  splitId: string;
  index: number; // divide children[index] y children[index+1]
  dir: "row" | "col";
  rect: Rect;
  span: number; // px disponibles del split (para convertir delta px -> fraccion)
}

/** Rects de los divisores arrastrables entre hijos de cada split. */
export function dividerRects(
  root: TilingNode | null,
  rect: Rect,
  gap: number,
  hidden: ReadonlySet<string> = NADA_OCULTO,
): DividerRect[] {
  if (!root || root.kind === "leaf") return [];
  const vivos = root.children.filter((c) => tieneAlgoQueMostrar(c, hidden));
  if (vivos.length === 0) return [];
  if (vivos.length === 1) return dividerRects(vivos[0], rect, gap, hidden);

  const idx = vivos.map((c) => root.children.indexOf(c));
  const fracs = idx.map((i) => root.sizes[i] ?? 1 / root.children.length);
  const suma = fracs.reduce((a, b) => a + b, 0) || 1;
  const out: DividerRect[] = [];
  const total = root.dir === "row" ? rect.w : rect.h;
  const avail = total - gap * (vivos.length - 1);
  let cursor = root.dir === "row" ? rect.x : rect.y;
  vivos.forEach((child, i) => {
    const span = Math.round(avail * (fracs[i] / suma));
    const r: Rect =
      root.dir === "row"
        ? { x: cursor, y: rect.y, w: span, h: rect.h }
        : { x: rect.x, y: cursor, w: rect.w, h: span };
    out.push(...dividerRects(child, r, gap, hidden));
    cursor += span;
    if (i < vivos.length - 1) {
      // solo hay manija si los DOS lados de esa costura estan a la vista: no
      // se arrastra contra algo que no se ve (con un oculto en medio, ese
      // divisor simplemente no existe)
      if (idx[i + 1] === idx[i] + 1) {
        out.push({
          splitId: root.id,
          index: idx[i],
          dir: root.dir,
          span: avail,
          rect:
            root.dir === "row"
              ? { x: cursor, y: rect.y, w: gap, h: rect.h }
              : { x: rect.x, y: cursor, w: rect.w, h: gap },
        });
      }
      cursor += gap;
    }
  });
  return out;
}

// ---------- mutaciones (inmutables) ----------

function mapNode(
  node: TilingNode,
  fn: (n: TilingNode) => TilingNode | null,
): TilingNode | null {
  const self = fn(node);
  if (self === null) return null;
  if (self.kind === "leaf") return self;
  const children: TilingNode[] = [];
  const sizes: number[] = [];
  self.children.forEach((c, i) => {
    const mapped = mapNode(c, fn);
    if (mapped) {
      children.push(mapped);
      sizes.push(self.sizes[i] ?? 1 / self.children.length);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]; // hoist: split de 1 = el hijo
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  return { ...self, children, sizes: sizes.map((s) => s / sum) };
}

function normalize(root: TilingNode | null): TilingNode | null {
  if (!root) return null;
  return mapNode(root, (n) => {
    if (n.kind === "leaf") return n.tabs.length === 0 ? null : n;
    // aplanar splits anidados con la misma direccion
    const children: TilingNode[] = [];
    const sizes: number[] = [];
    n.children.forEach((c, i) => {
      const frac = n.sizes[i] ?? 1 / n.children.length;
      if (c.kind === "split" && c.dir === n.dir) {
        c.children.forEach((gc, j) => {
          children.push(gc);
          sizes.push(frac * (c.sizes[j] ?? 1 / c.children.length));
        });
      } else {
        children.push(c);
        sizes.push(frac);
      }
    });
    return { ...n, children, sizes };
  });
}

/** Inserta un tab en un leaf (al final o en index) y lo activa. */
export function insertTab(
  root: TilingNode | null,
  leafId: string,
  tab: TabItem,
  index?: number,
): TilingNode | null {
  if (!root) return makeLeaf([tab]);
  return normalize(
    mapNode(root, (n) => {
      if (n.kind !== "leaf" || n.id !== leafId) return n;
      const tabs = [...n.tabs];
      const i = index === undefined ? tabs.length : Math.max(0, Math.min(index, tabs.length));
      tabs.splice(i, 0, tab);
      return { ...n, tabs, active: i };
    }),
  );
}

/** Quita el primer tab que cumpla pred. Leafs vacios colapsan. */
export function removeTab(
  root: TilingNode | null,
  pred: (t: TabItem, leaf: LeafNode) => boolean,
): TilingNode | null {
  if (!root) return null;
  let removed = false;
  return normalize(
    mapNode(root, (n) => {
      if (n.kind !== "leaf" || removed) return n;
      const i = n.tabs.findIndex((t) => pred(t, n));
      if (i < 0) return n;
      removed = true;
      const tabs = n.tabs.filter((_, j) => j !== i);
      const active = Math.max(0, Math.min(n.active > i ? n.active - 1 : n.active, tabs.length - 1));
      return { ...n, tabs, active };
    }),
  );
}

/** Activa el tab `index` de un leaf. */
export function mapActivate(
  root: TilingNode | null,
  leafId: string,
  index: number,
): TilingNode | null {
  if (!root) return null;
  return mapNode(root, (n) =>
    n.kind === "leaf" && n.id === leafId && index >= 0 && index < n.tabs.length
      ? { ...n, active: index }
      : n,
  );
}

/** Reemplaza el tab `index` de un leaf por otro (swap de conversacion). */
export function mapReplaceTab(
  root: TilingNode | null,
  leafId: string,
  index: number,
  tab: TabItem,
): TilingNode | null {
  if (!root) return null;
  return mapNode(root, (n) => {
    if (n.kind !== "leaf" || n.id !== leafId || !n.tabs[index]) return n;
    const tabs = [...n.tabs];
    tabs[index] = tab;
    return { ...n, tabs, active: index };
  });
}

/** Divide un leaf: el nuevo tab queda en un leaf nuevo del lado `side`.
 *  Si el split padre ya va en esa direccion, inserta hermano (tiling real). */
export function splitLeaf(
  root: TilingNode | null,
  targetLeafId: string,
  side: Side,
  tab: TabItem,
): { root: TilingNode | null; newLeafId: string } {
  const dir: "row" | "col" = side === "left" || side === "right" ? "row" : "col";
  const before = side === "left" || side === "top";
  const newLeaf = makeLeaf([tab]);
  if (!root) return { root: newLeaf, newLeafId: newLeaf.id };

  const wrap = (n: TilingNode): SplitNode => ({
    kind: "split",
    id: nextNodeId(),
    dir,
    children: before ? [newLeaf, n] : [n, newLeaf],
    sizes: [0.5, 0.5],
  });

  let done = false; // mapNode recorre split y luego hijos: sin flag, doble insert
  const result = mapNode(root, (n) => {
    if (done) return n;
    if (n.kind === "split") {
      // ¿el target es hijo directo y la direccion coincide? -> hermano
      const idx = n.children.findIndex(
        (c) => c.kind === "leaf" && c.id === targetLeafId,
      );
      if (idx >= 0 && n.dir === dir) {
        done = true;
        const children = [...n.children];
        const sizes = [...n.sizes];
        const half = (sizes[idx] ?? 1 / children.length) / 2;
        sizes[idx] = half;
        children.splice(before ? idx : idx + 1, 0, newLeaf);
        sizes.splice(before ? idx : idx + 1, 0, half);
        return { ...n, children, sizes };
      }
      return n;
    }
    if (n.id === targetLeafId) {
      done = true;
      return wrap(n);
    }
    return n;
  });
  return { root: normalize(result), newLeafId: newLeaf.id };
}

/** Mueve un tab de un leaf a otro (append o index). No-op si mismo leaf y sin index. */
export function moveTab(
  root: TilingNode | null,
  fromLeafId: string,
  tabIndex: number,
  toLeafId: string,
  toIndex?: number,
): TilingNode | null {
  const from = findLeaf(root, fromLeafId);
  const tab = from?.tabs[tabIndex];
  if (!root || !from || !tab) return root;
  if (fromLeafId === toLeafId && toIndex === undefined) return root;
  if (fromLeafId === toLeafId) {
    // reorden dentro del mismo leaf
    return mapNode(root, (n) => {
      if (n.kind !== "leaf" || n.id !== fromLeafId) return n;
      const tabs = [...n.tabs];
      tabs.splice(tabIndex, 1);
      const i = Math.max(0, Math.min(toIndex! > tabIndex ? toIndex! - 1 : toIndex!, tabs.length));
      tabs.splice(i, 0, tab);
      return { ...n, tabs, active: i };
    });
  }
  let out = removeTab(root, (t, l) => l.id === fromLeafId && sameTab(t, tab));
  out = insertTab(out, toLeafId, tab, toIndex);
  return out;
}

/** Mueve un tab hacia un split de otro leaf. */
export function moveTabToSide(
  root: TilingNode | null,
  fromLeafId: string,
  tabIndex: number,
  targetLeafId: string,
  side: Side,
): { root: TilingNode | null; newLeafId: string | null } {
  const from = findLeaf(root, fromLeafId);
  const tab = from?.tabs[tabIndex];
  if (!root || !from || !tab) return { root, newLeafId: null };
  if (fromLeafId === targetLeafId && from.tabs.length === 1) {
    return { root, newLeafId: null }; // separar lo unico que hay de si mismo = no-op
  }
  const removed = removeTab(root, (t, l) => l.id === fromLeafId && sameTab(t, tab));
  // si el target colapso al remover (era el mismo leaf que quedo vacio), cae al root
  const target = findLeaf(removed, targetLeafId);
  if (!target) {
    if (!removed) return { root: makeLeaf([tab]), newLeafId: null };
    const anyLeaf = leaves(removed)[0];
    const r = splitLeaf(removed, anyLeaf.id, side, tab);
    return { root: r.root, newLeafId: r.newLeafId };
  }
  const r = splitLeaf(removed, targetLeafId, side, tab);
  return { root: r.root, newLeafId: r.newLeafId };
}

/** Ajusta el tamaño entre dos hijos de un split (drag del divider). */
export function resizeSplit(
  root: TilingNode | null,
  splitId: string,
  index: number,
  delta: number, // fraccion +/- que gana children[index]
): TilingNode | null {
  if (!root) return null;
  const MIN = 0.12;
  return mapNode(root, (n) => {
    if (n.kind !== "split" || n.id !== splitId) return n;
    const sizes = [...n.sizes];
    const a = sizes[index] ?? 1 / n.children.length;
    const b = sizes[index + 1] ?? 1 / n.children.length;
    const d = Math.max(-(a - MIN), Math.min(delta, b - MIN));
    sizes[index] = a + d;
    sizes[index + 1] = b - d;
    return { ...n, sizes };
  });
}

// ---------- serializacion (sesion) ----------

export type SerializedTab =
  /** `termId` = la terminal en el daemon sfterm-ptyd. Si al abrir sigue VIVA
   *  ahi, el boot la RE-ADOPTA (mismo proceso, pantalla intacta) — esto NO es
   *  el revival por --resume que murio el 21 jul (esa era una IMITACION: un
   *  proceso nuevo leyendo la sesion vieja; tombstone en CLAUDE.md, codigo en
   *  11e03de..cca3f6f). Con el daemon el proceso ES el mismo, que es justo lo
   *  que Daniel pidio el 27 jul: "conservar las conversaciones en cada
   *  rebuild". Sin daemon (o terminal muerta) cae al spawn fresco por cwd. */
  | { kind: "term"; cwd: string; termId?: number }
  | { kind: "file"; path: string; mode: "auto" | "diff"; preview?: boolean; raw?: boolean };

export interface SerializedLeaf {
  kind: "leaf";
  tabs: SerializedTab[];
  active: number;
}
export interface SerializedSplit {
  kind: "split";
  dir: "row" | "col";
  sizes: number[];
  children: SerializedNode[];
}
export type SerializedNode = SerializedLeaf | SerializedSplit;

export function serializeTree(
  root: TilingNode | null,
  cwdOf: (ptyId: number) => string,
): SerializedNode | null {
  if (!root) return null;
  if (root.kind === "leaf") {
    // el navegador NO viaja a la sesion (el webview nativo muere con la app);
    // se filtra ANTES de mapear para que `active` apunte a lo que sobrevive
    const alive = root.tabs.filter(
      (t): t is Exclude<TabItem, { kind: "browser" }> => t.kind !== "browser",
    );
    if (alive.length === 0) return null;
    const activeTab = root.tabs[root.active];
    const activeIdx =
      activeTab && activeTab.kind !== "browser"
        ? alive.indexOf(activeTab as Exclude<TabItem, { kind: "browser" }>)
        : 0;
    return {
      kind: "leaf",
      tabs: alive.map((t) =>
        t.kind === "file"
          ? {
              kind: "file" as const,
              path: t.path,
              mode: t.mode,
              preview: t.preview,
              raw: t.raw,
            }
          : { kind: "term" as const, cwd: cwdOf(t.id), termId: t.id },
      ),
      active: Math.max(0, activeIdx),
    };
  }
  const children = root.children
    .map((c) => serializeTree(c, cwdOf))
    .filter((c): c is SerializedNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return { kind: "split", dir: root.dir, sizes: root.sizes, children };
}

export function buildPresetTree(leafCount: number): TilingNode | null {
  if (leafCount <= 0) return null;
  const mk = () => makeLeaf([]);
  if (leafCount === 1) return mk();
  const row = (k: number): SplitNode => ({
    kind: "split",
    id: nextNodeId(),
    dir: "row",
    children: Array.from({ length: k }, mk),
    sizes: Array.from({ length: k }, () => 1 / k),
  });
  if (leafCount <= 3) return row(leafCount);
  const top = Math.ceil(leafCount / 2);
  const bottom = leafCount - top;
  return {
    kind: "split",
    id: nextNodeId(),
    dir: "col",
    children: [row(top), row(bottom)],
    sizes: [0.5, 0.5],
  };
}
