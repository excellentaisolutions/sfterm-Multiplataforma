import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);
const testsDir = join(rootDir, "tests");

const entries = await readdir(testsDir, { withFileTypes: true });
const tests = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
  .map((entry) => join(testsDir, entry.name))
  .sort();

if (tests.length === 0) {
  console.error(`Error: no se encontraron archivos *.test.ts en ${testsDir}`);
  process.exit(1);
}

console.log(`Ejecutando ${tests.length} archivos de test...`);
const result = spawnSync(process.execPath, ["--test", ...tests], {
  cwd: rootDir,
  stdio: "inherit",
  shell: false,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
