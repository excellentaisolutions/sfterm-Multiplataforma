import fs from "node:fs";
import path from "node:path";

const base = JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json", "utf8"));
const parts = String(base.version).split(".").map(Number);
if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
  throw new Error(`Version base no SemVer: ${base.version}`);
}
parts[2] += 1;

const output = path.resolve("src-tauri", "target", "installer-upgrade-test.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ version: parts.join(".") }, null, 2)}\n`, "utf8");
console.log(`${path.relative(process.cwd(), output)} -> ${parts.join(".")}`);
