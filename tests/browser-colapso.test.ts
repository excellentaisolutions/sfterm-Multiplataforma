/** Tests del COLAPSO DE RENDER del ala del navegador (src/core/tiling.ts).
 *
 *  Regla de UX (29 jul 2026, pedido de Daniel: "no debería verlo en principio
 *  porque debería estar solo únicamente en el espacio donde abrió el
 *  navegador"): el navegador es un ala de SU conversacion. Donde no lo
 *  abriste, no existe: ni panel, ni tarjeta vacia, ni hueco, ni divisor — la
 *  terminal se queda con la pantalla entera.
 *
 *  Lo importante es que el colapso sea de RENDER y no del arbol: el tab sigue
 *  vivo (el WKWebView no muere, la pagina no se recarga) y volver a su
 *  conversacion lo restaura con el MISMO ancho. Sin eso, cada ⌥Tab mataria y
 *  reabriria navegadores.
 *
 *  Corre con `node --test tests/` (sin dependencias: Node 22 strippea TS solo).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dividerRects,
  insertTab,
  layoutRects,
  leafSoloBrowsers,
  leavesOcultas,
  makeLeaf,
  ownersConBrowser,
  splitLeaf,
  type TabItem,
} from "../src/core/tiling.ts";

const term = (id: number): TabItem => ({ kind: "term", id });
const browser = (id: number, owner?: number): TabItem =>
  owner === undefined ? { kind: "browser", id } : { kind: "browser", id, owner };

const PANTALLA = { x: 0, y: 0, w: 1000, h: 600 };
const GAP = 8;

/** taller tipico: terminal a la izquierda, ala del navegador a la derecha.
 *  El ala es de la conversacion 1. */
function taller() {
  const izq = makeLeaf([term(1)]);
  const { root, newLeafId } = splitLeaf(izq, izq.id, "right", browser(10, 1));
  return { root: root!, izqId: izq.id, alaId: newLeafId! };
}

test("sin navegador propio: la terminal se queda con la pantalla ENTERA", () => {
  const { root, izqId } = taller();
  // conversacion 2 enfocada — el ala es de la 1
  const ocultas = leavesOcultas(root, 2);
  const rects = layoutRects(root, PANTALLA, GAP, ocultas);

  assert.equal(rects.length, 1, "solo se pinta un campo");
  assert.equal(rects[0].leafId, izqId);
  assert.deepEqual(rects[0].rect, PANTALLA, "sin hueco: ocupa todo, gap incluido");
  assert.equal(
    dividerRects(root, PANTALLA, GAP, ocultas).length,
    0,
    "tampoco queda el divisor colgando",
  );
});

test("en SU conversacion el ala se abre, y el arbol nunca cambio", () => {
  const { root, izqId, alaId } = taller();
  const rects = layoutRects(root, PANTALLA, GAP, leavesOcultas(root, 1));

  assert.equal(rects.length, 2);
  assert.deepEqual(
    rects.map((r) => r.leafId).sort(),
    [izqId, alaId].sort(),
  );
  // el ancho es el del split (mitades), no un valor inventado por el colapso
  assert.equal(rects[0].rect.w, rects[1].rect.w);
  assert.equal(
    dividerRects(root, PANTALLA, GAP, leavesOcultas(root, 1)).length,
    1,
    "con las dos a la vista SI hay manija para arrastrar",
  );
});

test("ir y volver restaura el MISMO ancho (el colapso no toca el arbol)", () => {
  const { root } = taller();
  const antes = layoutRects(root, PANTALLA, GAP, leavesOcultas(root, 1));
  // paso por una conversacion sin navegador...
  layoutRects(root, PANTALLA, GAP, leavesOcultas(root, 2));
  // ...y regreso
  const despues = layoutRects(root, PANTALLA, GAP, leavesOcultas(root, 1));

  assert.deepEqual(despues, antes, "mismo layout exacto: nada se reabrio ni brinco");
});

test("un campo con terminal Y navegador ajeno sigue visible (no se traga la terminal)", () => {
  // el navegador de otro NO puede esconder un campo donde tambien hay trabajo
  const leaf = makeLeaf([term(1), browser(10, 2)]);
  const ocultas = leavesOcultas(leaf, 1);
  assert.equal(ocultas.size, 0);
  assert.equal(layoutRects(leaf, PANTALLA, GAP, ocultas).length, 1);
});

test("el navegador SIN dueño (era v1) se ve en todas: es reclamable, no huerfano", () => {
  const { root } = taller();
  const compartido = makeLeaf([browser(99)]);
  assert.equal(leavesOcultas(compartido, 7).size, 0);
  // y el que SI tiene dueño sigue escondiendose para los demas
  assert.equal(leavesOcultas(root, 7).size, 1);
});

test("ownersConBrowser: el rail sabe que conversaciones tienen uno", () => {
  const leaf = makeLeaf([term(1), browser(10, 1), browser(11, 3), browser(12)]);
  const owners = ownersConBrowser(leaf);
  assert.ok(owners.has(1) && owners.has(3));
  assert.equal(owners.size, 2, "el sin-dueño no cuenta para nadie");
});

// ---- EL ALA ES UN CAMPO APARTE (bug del 29 jul: "le doy clic y se pasa a la
// derecha" — el navegador se colaba como pestaña junto a la terminal) ----

test("leafSoloBrowsers ignora los campos MIXTOS: el ala nunca comparte con una terminal", () => {
  const mixto = makeLeaf([term(1), browser(10, 1)]);
  assert.equal(
    leafSoloBrowsers(mixto),
    null,
    "un campo con terminal NO es ala, aunque tenga navegadores",
  );

  const soloTerm = makeLeaf([term(1)]);
  const { root } = splitLeaf(soloTerm, soloTerm.id, "right", browser(10, 1));
  const ala = leafSoloBrowsers(root);
  assert.ok(ala, "el campo de puro navegador SI es ala");
  assert.ok(
    ala!.tabs.every((t) => t.kind === "browser"),
    "y solo tiene navegadores",
  );
});

test("el ala junta los navegadores de varias conversaciones, no las terminales", () => {
  const soloTerm = makeLeaf([term(1)]);
  const { root } = splitLeaf(soloTerm, soloTerm.id, "right", browser(10, 1));
  const ala = leafSoloBrowsers(root)!;
  // el segundo agente abre el suyo: entra al MISMO campo (no parte la pantalla)
  const root2 = insertTab(root, ala.id, browser(11, 2));
  const ala2 = leafSoloBrowsers(root2)!;
  assert.equal(ala2.tabs.length, 2);
  assert.deepEqual([...ownersConBrowser(root2)].sort(), [1, 2]);
  // y cada conversacion solo ve el suyo: para la 1, el campo NO se oculta
  assert.equal(leavesOcultas(root2, 1).size, 0);
  // para una tercera sin navegador, el ala entera se pliega
  assert.equal(leavesOcultas(root2, 3).size, 1);
});

// ---- EXPANDIR (⌘⇧E): el mismo mecanismo, al reves ----

test("expandir deja UN campo con toda la pantalla y contraer devuelve el layout EXACTO", () => {
  const { root, izqId, alaId } = taller();
  const normal = layoutRects(root, PANTALLA, GAP, leavesOcultas(root, 1));
  assert.equal(normal.length, 2);

  // expandido: solo el ala recibe pixeles, y son TODOS
  const exp = layoutRects(root, PANTALLA, GAP, leavesOcultas(root, 1, alaId));
  assert.equal(exp.length, 1);
  assert.equal(exp[0].leafId, alaId);
  assert.deepEqual(exp[0].rect, PANTALLA, "sin hueco ni gap: la pantalla entera");
  assert.equal(dividerRects(root, PANTALLA, GAP, leavesOcultas(root, 1, alaId)).length, 0);

  // y se puede expandir el OTRO campo con el mismo mecanismo
  const exp2 = layoutRects(root, PANTALLA, GAP, leavesOcultas(root, 1, izqId));
  assert.equal(exp2[0].leafId, izqId);

  // contraer = exactamente lo de antes (el arbol nunca se movio)
  assert.deepEqual(layoutRects(root, PANTALLA, GAP, leavesOcultas(root, 1)), normal);
});

test("expandir gana sobre el plegado por conversacion", () => {
  const { root, alaId } = taller();
  // conversacion 2 no es dueña del ala, pero si la expande, se ve igual
  const r = layoutRects(root, PANTALLA, GAP, leavesOcultas(root, 2, alaId));
  assert.equal(r.length, 1);
  assert.equal(r[0].leafId, alaId, "el expandido manda sobre quien es el dueño");
});
