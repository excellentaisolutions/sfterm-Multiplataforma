/** Tests del LOCALIZADOR (src/core/locator.ts).
 *
 *  El resolver y los cinco chequeos viven como FUENTE JS en un string, porque
 *  se inyectan en la pagina. Eso los vuelve invisibles para el compilador: un
 *  parentesis de mas no lo caza `tsc`, lo caza el agente en produccion a mitad
 *  de una tarea. Estos tests son el sustituto del compilador para esa zona:
 *  parsean la fuente de verdad y verifican que el contrato este completo.
 *
 *  Lo que NO se prueba aqui: el comportamiento contra una pagina viva (tapado,
 *  en movimiento, deshabilitado). Eso exige un DOM real y se valida E2E contra
 *  la pagina hostil del sandbox — un DOM de mentiras probaria un DOM de
 *  mentiras.
 *
 *  Corre con `node --test tests/` (Node 22 strippea TS solo).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RESOLVER_JS } from "../src/core/locator-js.ts";

test("la fuente JS inyectada PARSEA (el compilador no mira dentro de un string)", () => {
  assert.doesNotThrow(
    () => new Function(`${RESOLVER_JS} return typeof __sfActionable;`),
    "un error de sintaxis aqui explota en la pagina, no en el build",
  );
  const tipo = new Function(`${RESOLVER_JS} return typeof __sfActionable;`)();
  assert.equal(tipo, "function");
});

test("expone las tres piezas del contrato: buscar, nombrar y accionar", () => {
  const tipos = new Function(
    `${RESOLVER_JS} return [typeof __sfFind, typeof __sfName, typeof __sfActionable, typeof __sfVisible];`,
  )();
  assert.deepEqual(tipos, ["function", "function", "function", "function"]);
});

test("los cinco motivos de fallo estan redactados en la fuente", () => {
  // si alguien borra un chequeo, el agente vuelve a fallar en silencio: esa
  // regresion no la caza ningun tipo, solo esto
  for (const motivo of [
    "no existe en la pagina",
    "existe pero esta invisible",
    "esta deshabilitado",
    "se esta moviendo",
    "esta tapado por",
  ]) {
    assert.ok(RESOLVER_JS.includes(motivo), `falta el motivo: ${motivo}`);
  }
});

test("conoce los roles que un agente usa de verdad", () => {
  const roles = new Function(`${RESOLVER_JS} return Object.keys(__sfRoles);`)();
  for (const r of ["button", "link", "textbox", "file", "checkbox", "combobox"]) {
    assert.ok(roles.includes(r), `falta el rol ${r}`);
  }
});

test("el nombre accesible sale de aria-label antes que del texto", () => {
  // el orden importa: un boton que es un emoji 🚀 solo se puede nombrar por su
  // aria-label, y si el texto ganara, ese boton seria inalcanzable
  const i = RESOLVER_JS.indexOf("aria-label");
  const j = RESOLVER_JS.indexOf("e.innerText || e.value");
  assert.ok(i > 0 && j > i, "aria-label debe evaluarse primero");
});
