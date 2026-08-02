import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const sourceRoot = path.resolve("src-tauri", "src");
const adapterFiles = new Set([
  "browser.rs",
  "browser_delegate.rs",
  "debug_harness.rs",
  "pty.rs",
  "voice.rs",
]);
const nativeMarkers = [
  "use objc2",
  "objc2_",
  "font_kit::",
  "std::os::unix",
  "std::os::windows",
  "UnixListener",
  "UnixStream",
  "CreateNamedPipeW",
  "explorer.exe",
  "powershell.exe",
  '"/bin/zsh"',
  "reg.exe",
];

async function rustFiles(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await rustFiles(absolute)));
    else if (entry.isFile() && entry.name.endsWith(".rs")) result.push(absolute);
  }
  return result;
}

function isAdapter(relative) {
  const normalized = relative.split(path.sep).join("/");
  return (
    normalized.startsWith("platform/") ||
    normalized.startsWith("ptyd/") ||
    adapterFiles.has(normalized)
  );
}

const violations = [];
for (const file of await rustFiles(sourceRoot)) {
  const relative = path.relative(sourceRoot, file);
  if (isAdapter(relative)) continue;
  const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
  lines.forEach((line, index) => {
    const code = line.trimStart();
    if (code.startsWith("//")) return;
    for (const marker of nativeMarkers) {
      if (code.includes(marker)) {
        violations.push(`${relative}:${index + 1}: ${marker}`);
      }
    }
  });
}

if (violations.length > 0) {
  console.error("Dependencias nativas encontradas fuera de adaptadores de plataforma:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Fronteras de plataforma Rust verificadas.");
}
