/** Tests de la logica PURA de la vitrina de historial (src/core/histgroup.ts):
 *  etiquetas de dia civiles, busqueda sin acentos, fijadas, exclusion de vivas
 *  y el corte de "mostrar mas". Corre con `node --test tests/`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayLabel,
  groupHistory,
  matches,
  projectsOf,
  type ConvCard,
} from "../src/core/histgroup.ts";

const card = (over: Partial<ConvCard>): ConvCard => ({
  provider: "claude",
  sid: "sid-x",
  path: "/tmp/x.jsonl",
  configDir: null,
  cwd: "/Users/d/Developer/business-os",
  title: "Arreglar el scroll",
  model: null,
  mtimeMs: 0,
  ...over,
});

// un "ahora" fijo: mier 30 jul 2026, 12:00 hora local
const NOW = new Date(2026, 6, 30, 12, 0, 0).getTime();
const DIA = 86_400_000;

test("dayLabel: dias CIVILES, no ventanas de 24h", () => {
  assert.equal(dayLabel(NOW - 1000, NOW), "Hoy");
  // anoche 23:50 = "Ayer" aunque hayan pasado solo ~12h
  const anoche = new Date(2026, 6, 29, 23, 50).getTime();
  assert.equal(dayLabel(anoche, NOW), "Ayer");
  const lunes27 = new Date(2026, 6, 27, 9, 0).getTime();
  assert.equal(dayLabel(lunes27, NOW), "27 jul");
  // otro año lo dice explicito
  const navidad = new Date(2025, 11, 25, 10, 0).getTime();
  assert.equal(dayLabel(navidad, NOW), "25 dic 2025");
});

test("matches: sin acentos ni mayusculas, titulo y proyecto", () => {
  const c = card({ title: "Edición de vídeo", cwd: "/x/María" });
  assert.ok(matches(c, "edicion"));
  assert.ok(matches(c, "VIDEO"));
  assert.ok(matches(c, "maria"));
  assert.ok(!matches(c, "thumbnail"));
  assert.ok(matches(c, "  ")); // query vacia = todo pasa
});

test("groupHistory: fijadas primero, luego grupos por dia en orden", () => {
  const cards = [
    card({ sid: "a", mtimeMs: NOW - 1000, title: "de hoy" }),
    card({ sid: "b", mtimeMs: NOW - DIA, title: "de ayer" }),
    card({ sid: "c", mtimeMs: NOW - DIA - 3600_000, title: "tambien de ayer" }),
    card({ sid: "d", mtimeMs: NOW - 3 * DIA, title: "del lunes" }),
  ];
  const g = groupHistory(cards, { pinned: new Set(["c"]), nowMs: NOW });
  assert.deepEqual(
    g.sections.map((s) => s.label),
    ["Fijadas", "Hoy", "Ayer", "27 jul"],
  );
  assert.deepEqual(g.sections[0].cards.map((c) => c.sid), ["c"]);
  assert.deepEqual(g.sections[2].cards.map((c) => c.sid), ["b"]);
});

test("groupHistory: las vivas se excluyen (la lista no se contradice)", () => {
  const cards = [
    card({ sid: "viva", mtimeMs: NOW - 1000 }),
    card({ sid: "muerta", mtimeMs: NOW - 2000 }),
  ];
  const g = groupHistory(cards, { exclude: new Set(["viva"]), nowMs: NOW });
  assert.equal(g.total, 1);
  assert.deepEqual(g.sections[0].cards.map((c) => c.sid), ["muerta"]);
});

test("groupHistory: limit corta y hasMore lo dice; fijadas no cuentan al corte", () => {
  const cards = Array.from({ length: 40 }, (_, i) =>
    card({ sid: `s${i}`, mtimeMs: NOW - i * 60_000, title: `conv ${i}` }),
  );
  const g = groupHistory(cards, { pinned: new Set(["s39"]), limit: 10, nowMs: NOW });
  assert.equal(g.hasMore, true);
  assert.equal(g.total, 39); // 40 menos la fijada
  const shown = g.sections.filter((s) => s.label !== "Fijadas").flatMap((s) => s.cards);
  assert.equal(shown.length, 10);
  // la fijada aparece aunque este fuera del corte por recencia
  assert.deepEqual(g.sections[0].cards.map((c) => c.sid), ["s39"]);
});

test("prefs: agrupar por PROYECTO junta cards no contiguas sin partir grupos", () => {
  const cards = [
    card({ sid: "a", mtimeMs: NOW - 1000, cwd: "/x/arbrain" }),
    card({ sid: "b", mtimeMs: NOW - 2000, cwd: "/x/sfterm" }),
    card({ sid: "c", mtimeMs: NOW - 3000, cwd: "/x/arbrain" }),
  ];
  const g = groupHistory(cards, {
    nowMs: NOW,
    prefs: { groupBy: "project", sortBy: "recency", project: null },
  });
  assert.deepEqual(g.sections.map((s) => s.label), ["arbrain", "sfterm"]);
  assert.deepEqual(g.sections[0].cards.map((c) => c.sid), ["a", "c"]);
});

test("prefs: ordenar por TITULO (es, sin sensibilidad a mayusculas)", () => {
  const cards = [
    card({ sid: "a", mtimeMs: NOW - 1000, title: "zanahoria" }),
    card({ sid: "b", mtimeMs: NOW - 2000, title: "Ábaco" }),
    card({ sid: "c", mtimeMs: NOW - 3000, title: "mango" }),
  ];
  const g = groupHistory(cards, {
    nowMs: NOW,
    prefs: { groupBy: "none", sortBy: "title", project: null },
  });
  assert.deepEqual(g.sections.map((s) => s.label), ["Historial"]);
  assert.deepEqual(g.sections[0].cards.map((c) => c.sid), ["b", "c", "a"]);
});

test("prefs: filtro por proyecto deja fuera el resto (fijadas incluidas)", () => {
  const cards = [
    card({ sid: "a", mtimeMs: NOW - 1000, cwd: "/x/arbrain" }),
    card({ sid: "b", mtimeMs: NOW - 2000, cwd: "/x/sfterm" }),
  ];
  const g = groupHistory(cards, {
    nowMs: NOW,
    pinned: new Set(["b"]),
    prefs: { groupBy: "date", sortBy: "recency", project: "arbrain" },
  });
  assert.equal(g.total, 1);
  assert.deepEqual(g.sections.map((s) => s.label), ["Hoy"]);
  assert.deepEqual(g.sections[0].cards.map((c) => c.sid), ["a"]);
});

test("projectsOf: por frecuencia descendente", () => {
  const cards = [
    card({ sid: "a", cwd: "/x/arbrain" }),
    card({ sid: "b", cwd: "/x/sfterm" }),
    card({ sid: "c", cwd: "/x/arbrain" }),
  ];
  assert.deepEqual(projectsOf(cards), ["arbrain", "sfterm"]);
});

test("groupHistory: busqueda filtra dentro de los grupos", () => {
  const cards = [
    card({ sid: "a", mtimeMs: NOW - 1000, title: "thumbnails del canal" }),
    card({ sid: "b", mtimeMs: NOW - 2000, title: "otra cosa" }),
  ];
  const g = groupHistory(cards, { query: "thumb", nowMs: NOW });
  assert.equal(g.total, 1);
  assert.deepEqual(g.sections[0].cards.map((c) => c.sid), ["a"]);
});
