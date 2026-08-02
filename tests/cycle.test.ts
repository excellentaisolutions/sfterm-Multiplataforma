/** Tests del CICLADO (src/core/cycle.ts) — ⇧Tab entre pestañas, ⌥Tab entre
 *  terminales. Todo lo de aqui es puro; lo que toca la app (activar el tab,
 *  traer la terminal) vive en actions.ts y no se prueba aqui.
 *
 *  Corre con `node --test tests/` (sin dependencias: Node 22 strippea TS solo).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cyclableTerms, nextTermId, sortByRail, stepIndex, visibleTabs } from "../src/core/cycle.ts";

const panel = (id: number) => ({ id });
const panels = (...ids: number[]) =>
  Object.fromEntries(ids.map((id) => [id, panel(id)]));

// ── stepIndex: el corazon del ciclado ────────────────────────────────────────

test("stepIndex avanza y da la vuelta en los dos sentidos", () => {
  assert.equal(stepIndex(3, 0, 1), 1);
  assert.equal(stepIndex(3, 2, 1), 0, "del ultimo vuelve al primero");
  assert.equal(stepIndex(3, 0, -1), 2, "del primero salta al ultimo");
});

/** ⚠️ EL TEST QUE PROTEGE A CLAUDE. Con menos de 2 elementos NO hay ciclado, y
 *  ese null es lo que hace que ⇧Tab llegue al PTY en vez de morir en la app:
 *  en el TUI de claude esa tecla cicla los modos de permiso. Si esto empezara
 *  a devolver 0, la tecla se la quedaria SFTerm para no hacer nada. */
test("stepIndex devuelve null con 0 o 1 elemento (⇧Tab se le deja al agente)", () => {
  assert.equal(stepIndex(0, 0, 1), null);
  assert.equal(stepIndex(1, 0, 1), null);
  assert.equal(stepIndex(1, 0, -1), null);
});

test("stepIndex tolera un indice activo fuera de rango sin romperse", () => {
  assert.equal(stepIndex(3, 99, 1), 1, "arranca desde 0 y avanza");
  assert.equal(stepIndex(3, -1, 1), 1);
});

// ── orden del rail: lo que se cicla es lo que se ve ──────────────────────────

test("sortByRail respeta el orden manual y manda lo demas al final por id", () => {
  const out = sortByRail([panel(5), panel(2), panel(9)], [9, 5]);
  assert.deepEqual(out.map((p) => p.id), [9, 5, 2]);
});

test("sortByRail ignora ids muertos del orden sin perder filas", () => {
  const out = sortByRail([panel(1), panel(2)], [77, 2, 88]);
  assert.deepEqual(out.map((p) => p.id), [2, 1], "el 2 viene ordenado a mano; el 1 cae al final");
});

test("las terminales del drawer no entran al ciclado", () => {
  const out = cyclableTerms(panels(1, 2, 3), [2], []);
  assert.deepEqual(out.map((p) => p.id), [1, 3], "⌥Tab no salta a algo fuera del rail");
});

// ── nextTermId ───────────────────────────────────────────────────────────────

test("nextTermId cicla en el orden del rail, no por id", () => {
  const ord = cyclableTerms(panels(1, 2, 3), [], [3, 1, 2]);
  assert.equal(nextTermId(ord, 3, 1), 1);
  assert.equal(nextTermId(ord, 2, 1), 3, "da la vuelta al principio del rail");
  assert.equal(nextTermId(ord, 3, -1), 2);
});

/** Con el foco en un ARCHIVO (o en el drawer) no hay terminal enfocada. Saltar
 *  igual es lo correcto: es justo cuando Daniel esta mirando un diff y quiere
 *  volver a una terminal. Cancelar dejaria ⌥Tab muerto en ese momento. */
test("sin terminal enfocada aterriza en un extremo segun el sentido", () => {
  const ord = cyclableTerms(panels(4, 7), [], [7, 4]);
  assert.equal(nextTermId(ord, null, 1), 7, "hacia adelante: la primera del rail");
  assert.equal(nextTermId(ord, null, -1), 4, "hacia atras: la ultima");
  assert.equal(nextTermId(ord, 999, 1), 7, "una enfocada que no esta en la lista es lo mismo");
});

test("una sola terminal no cicla, y ninguna tampoco", () => {
  assert.equal(nextTermId(cyclableTerms(panels(1), [], []), 1, 1), null);
  assert.equal(nextTermId([], null, 1), null);
});

// ── visibleTabs: lo que ⇧Tab puede recorrer ─────────────────────────────────

const tab = (kind: string, owner?: number) => (owner === undefined ? { kind } : { kind, owner });

test("los navegadores de otras conversaciones no se recorren", () => {
  const tabs = [tab("term"), tab("browser", 1), tab("browser", 2)];
  assert.deepEqual(visibleTabs(tabs, 1), [0, 1], "solo el propio");
  assert.deepEqual(visibleTabs(tabs, 2), [0, 2]);
});

/** ⚠️ EL CASO QUE PROTEGE A CLAUDE. Una terminal + el navegador de OTRO = una
 *  sola pestaña visible ⇒ stepIndex devuelve null ⇒ ⇧Tab llega al PTY. Si aqui
 *  se contaran las dos, la app se tragaria la tecla que cicla los modos de
 *  permiso y no haria nada visible a cambio. */
test("una pestaña real + un navegador ajeno NO habilitan ⇧Tab", () => {
  const vis = visibleTabs([tab("term"), tab("browser", 99)], 1);
  assert.deepEqual(vis, [0]);
  assert.equal(stepIndex(vis.length, 0, 1), null, "⇧Tab se le deja al agente");
});

test("un navegador sin dueño (v1) se recorre siempre", () => {
  assert.deepEqual(visibleTabs([tab("term"), tab("browser")], 7), [0, 1]);
});
