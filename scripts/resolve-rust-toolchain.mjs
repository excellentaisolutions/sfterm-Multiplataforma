import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const requiredRustVersion = "1.97.0";

function rustupExecutable() {
  return process.platform === "win32" ? "rustup.exe" : "rustup";
}

function runRustup(args) {
  return spawnSync(rustupExecutable(), args, {
    encoding: "utf8",
    windowsHide: true,
  });
}

export function findCompatibleRustToolchain() {
  if (process.env.RUSTUP_TOOLCHAIN) {
    const selected = runRustup([
      "run",
      process.env.RUSTUP_TOOLCHAIN,
      "rustc",
      "--version",
    ]);
    if (selected.status === 0 && selected.stdout.includes(`rustc ${requiredRustVersion} `)) {
      return process.env.RUSTUP_TOOLCHAIN;
    }
  }

  const installed = runRustup(["toolchain", "list"]);
  if (installed.error || installed.status !== 0) return null;

  const toolchains = installed.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+\([^)]*\)\s*$/, "").trim())
    .filter(Boolean);

  for (const toolchain of toolchains) {
    const rustc = runRustup(["run", toolchain, "rustc", "--version"]);
    if (
      !rustc.error &&
      rustc.status === 0 &&
      rustc.stdout.includes(`rustc ${requiredRustVersion} `)
    ) {
      return toolchain;
    }
  }

  return null;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invokedPath) {
  const toolchain = findCompatibleRustToolchain();
  if (toolchain) {
    process.stdout.write(`${toolchain}\n`);
  } else {
    process.exitCode = 1;
  }
}
