import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../src/core/actions.ts", import.meta.url), "utf8");
const bootStart = source.indexOf("export async function boot()");
const bootEnd = source.indexOf("/** Migra sesiones", bootStart);
const bootSource = source.slice(bootStart, bootEnd);

test("el boot nunca aplica presets ni inyecta comandos o kickoffs", () => {
  assert.ok(bootStart >= 0 && bootEnd > bootStart, "se localiza la funcion boot");
  assert.doesNotMatch(bootSource, /applyPreset|maybeDailyKickoff|agent_command|command\s*:/);
  assert.match(bootSource, /spawnPanel\(\{ cwd: st\(\)\.treeRoot, target: \{ at: "auto" \} \}\)/);
  assert.match(bootSource, /adoptable\.size > 0 && cfg\.general\.restore_session/);
});
