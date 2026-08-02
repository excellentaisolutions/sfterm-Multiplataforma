/** Tests de la PROPIEDAD del navegador (src/core/tiling.ts).
 *
 *  Cimiento del navegador por conversacion: cada WKWebView pertenece a la
 *  terminal que lo abrio. La propiedad vive en el TAB, no en un mapa aparte,
 *  para que no haya dos verdades que sincronizar.
 *
 *  Corre con `node --test tests/` (sin dependencias: Node 22 strippea TS solo).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserIdOf,
  leafOfBrowser,
  makeLeaf,
  splitLeaf,
  type TabItem,
} from "../src/core/tiling.ts";

const term = (id: number): TabItem => ({ kind: "term", id });
const browser = (id: number, owner?: number): TabItem =>
  owner === undefined ? { kind: "browser", id } : { kind: "browser", id, owner };

test("browserIdOf encuentra el navegador de SU conversacion", () => {
  const leaf = makeLeaf([term(1), browser(10, 1), browser(11, 2)]);
  assert.equal(browserIdOf(leaf, 1), 10);
  assert.equal(browserIdOf(leaf, 2), 11);
});

test("una conversacion sin navegador devuelve null, no el de otra", () => {
  const leaf = makeLeaf([browser(10, 1)]);
  assert.equal(browserIdOf(leaf, 99), null, "jamas prestar el navegador ajeno");
});

/** ⚠️ El caso que evita un navegador HUERFANO. Un webview abierto antes de que
 *  existiera la propiedad no tiene dueño; si las funciones nuevas lo ignoraran,
 *  seguiria pintado en pantalla pero ninguna accion podria alcanzarlo. */
test("un navegador sin dueño (v1) sigue siendo reclamable por quien pregunte", () => {
  const leaf = makeLeaf([browser(10)]);
  const hit = leafOfBrowser(leaf, 7);
  assert.notEqual(hit, null, "el compartido de v1 no puede quedar inalcanzable");
  assert.equal(hit!.index, 0);
});

test("leafOfBrowser sin dueño busca cualquiera (comportamiento v1 intacto)", () => {
  const leaf = makeLeaf([term(1), browser(10, 3)]);
  const hit = leafOfBrowser(leaf);
  assert.equal(hit?.index, 1);
});

test("no confunde el navegador de otra conversacion con el propio", () => {
  const leaf = makeLeaf([browser(10, 1)]);
  // pregunta la 2: el de la 1 tiene dueño y NO es suyo
  assert.equal(browserIdOf(leaf, 2), null);
});

test("la propiedad sobrevive a un split (viaja en el tab, no en un mapa)", () => {
  const base = makeLeaf([term(1)]);
  const { root } = splitLeaf(base, base.id, "right", browser(10, 1));
  assert.equal(browserIdOf(root, 1), 10, "el dueño viaja con el tab");
});

test("con varias pestañas gana la ACTIVA, no la primera", () => {
  // dos navegadores de la misma conversacion; el activo es el segundo
  const leaf = makeLeaf([browser(10, 1), browser(11, 1)], 1);
  assert.equal(
    browserIdOf(leaf, 1),
    11,
    "operar la pestaña de atras seria actuar a ciegas mientras la pantalla muestra otra",
  );
  // si la activa no es de esa conversacion, cae en la primera suya
  const mixto = makeLeaf([browser(10, 1), browser(11, 2)], 1);
  assert.equal(browserIdOf(mixto, 1), 10);
});
