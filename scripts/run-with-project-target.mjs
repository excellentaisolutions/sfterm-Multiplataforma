import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCompatibleRustToolchain } from "./resolve-rust-toolchain.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const targetDir = path.join(projectRoot, "src-tauri", "target");
const compatibleToolchain = findCompatibleRustToolchain();
const [tool, ...toolArgs] = process.argv.slice(2);

if (tool !== "cargo" && tool !== "tauri") {
  console.error(
    "Usage: node scripts/run-with-project-target.mjs <cargo|tauri> [...args]",
  );
  process.exit(2);
}

let command;
let args = toolArgs;

if (tool === "cargo") {
  command = process.platform === "win32" ? "cargo.exe" : "cargo";
} else {
  command = process.execPath;
  const tauriCli = path.join(
    projectRoot,
    "node_modules",
    "@tauri-apps",
    "cli",
    "tauri.js",
  );

  if (!existsSync(tauriCli)) {
    console.error("Tauri CLI not found. Run npm ci before invoking Tauri.");
    process.exit(1);
  }

  args = [tauriCli, ...toolArgs];
}

const child = spawn(command, args, {
  cwd: projectRoot,
  env: {
    ...process.env,
    CARGO_TARGET_DIR: targetDir,
    ...(compatibleToolchain
      ? { RUSTUP_TOOLCHAIN: compatibleToolchain }
      : {}),
  },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`Unable to start ${tool}: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
