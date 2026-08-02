import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCompatibleRustToolchain } from "./resolve-rust-toolchain.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const targetDir = path.join(projectRoot, "src-tauri", "target");
const compatibleToolchain = findCompatibleRustToolchain();
const [tool, ...toolArgs] = process.argv.slice(2);

function windowsMsvcEnvironment() {
  if (process.platform !== "win32") return {};
  if (spawnSync("where.exe", ["link.exe"], { stdio: "ignore" }).status === 0) {
    return {};
  }

  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  if (!existsSync(vswhere)) return {};
  const discovery = spawnSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const installation = discovery.stdout?.trim();
  if (discovery.status !== 0 || !installation) return {};

  const buildDir = path.join(installation, "VC", "Auxiliary", "Build");
  for (const script of ["vcvarsx86_amd64.bat", "vcvars64.bat"]) {
    const vcvars = path.join(buildDir, script);
    if (!existsSync(vcvars)) continue;
    const initialized = spawnSync(
      "cmd.exe",
      ["/d", "/c", `call "${vcvars}" >nul && where link.exe >nul && set`],
      { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true },
    );
    if (initialized.status !== 0) continue;
    return Object.fromEntries(
      initialized.stdout
        .split(/\r?\n/)
        .map((line) => {
          const separator = line.indexOf("=");
          return separator > 0
            ? [line.slice(0, separator), line.slice(separator + 1)]
            : null;
        })
        .filter(Boolean),
    );
  }
  return {};
}

if (tool !== "cargo" && tool !== "tauri") {
  console.error(
    "Usage: node scripts/run-with-project-target.mjs <cargo|tauri> [...args]",
  );
  process.exit(2);
}

let command;
let args = toolArgs;
const windowsBuildEnv = windowsMsvcEnvironment();

if (process.env.SFTERM_DEBUG_MSVC === "1" && process.platform === "win32") {
  console.error(
    `MSVC linker: ${windowsBuildEnv.Path ?? windowsBuildEnv.PATH ?? "not initialized"}`,
  );
}

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
    ...windowsBuildEnv,
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
