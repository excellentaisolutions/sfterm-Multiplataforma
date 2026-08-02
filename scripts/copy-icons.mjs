import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(scriptsDir);
const sourceDir = join(rootDir, "node_modules", "material-icon-theme", "icons");
const targetDir = join(rootDir, "public", "material-icons");

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });

const entries = await readdir(sourceDir, { withFileTypes: true });
const icons = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".svg"));

if (icons.length === 0) {
  throw new Error(`No se encontraron iconos SVG en ${sourceDir}`);
}

await Promise.all(
  icons.map((entry) => copyFile(join(sourceDir, entry.name), join(targetDir, entry.name))),
);

console.log(`Copiados ${icons.length} iconos a ${targetDir}`);
