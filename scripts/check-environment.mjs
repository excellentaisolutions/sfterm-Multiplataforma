import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  findCompatibleRustToolchain,
  requiredRustVersion,
} from "./resolve-rust-toolchain.mjs";

const jsonOutput = process.argv.includes("--json");
const checks = [];

function run(command, args = []) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function add(name, ok, detail, remedy, required = true) {
  checks.push({ name, ok, detail, remedy, required });
}

function versionTuple(value) {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(actual, expected) {
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] > expected[index]) return true;
    if (actual[index] < expected[index]) return false;
  }
  return true;
}

const nodeVersion = versionTuple(process.versions.node);
add(
  "Node.js",
  Boolean(nodeVersion && nodeVersion[0] === 24 && atLeast(nodeVersion, [24, 15, 0])),
  `v${process.versions.node}`,
  "Instala Node.js 24 LTS (>=24.15.0 <25) y abre una terminal nueva.",
);

const rustToolchain = findCompatibleRustToolchain();
const rustup = process.platform === "win32" ? "rustup.exe" : "rustup";
const cargo = rustToolchain
  ? run(rustup, ["run", rustToolchain, "cargo", "--version"])
  : { ok: false, output: "toolchain compatible no encontrado" };
add(
  "Cargo",
  cargo.ok,
  cargo.output || "no encontrado",
  "Instala rustup; rust-toolchain.toml instalará el toolchain fijado.",
);

const rustc = rustToolchain
  ? run(rustup, ["run", rustToolchain, "rustc", "-vV"])
  : { ok: false, output: "toolchain compatible no encontrado" };
const expectedRust = `release: ${requiredRustVersion}`;
const hostLine = rustc.output
  .split(/\r?\n/)
  .find((line) => line.startsWith("host:"));
const rustHostOk =
  process.platform !== "win32" || Boolean(hostLine?.endsWith("-pc-windows-msvc"));
add(
  "Rust",
  rustc.ok && rustc.output.includes(expectedRust) && rustHostOk,
  rustc.ok
    ? `${rustToolchain}; ${rustc.output.split(/\r?\n/)[0]}; ${hostLine ?? "host desconocido"}`
    : "no encontrado",
  "Ejecuta rustup toolchain install 1.97.0 --profile minimal --component rustfmt --component clippy y usa un host MSVC en Windows.",
);

const git = run(process.platform === "win32" ? "git.exe" : "git", ["--version"]);
add(
  "Git",
  git.ok,
  git.output || "no encontrado",
  "Instala Git si necesitas clonar, actualizar o contribuir al repositorio.",
  false,
);

if (process.platform === "win32") {
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = path.join(
    programFilesX86,
    "Microsoft Visual Studio",
    "Installer",
    "vswhere.exe",
  );
  const visualStudio = existsSync(vswhere)
    ? run(vswhere, [
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-property",
        "installationPath",
      ])
    : { ok: false, output: "" };
  add(
    "MSVC Build Tools",
    visualStudio.ok && visualStudio.output.length > 0,
    visualStudio.output || "workload C++ no encontrado",
    "Instala Visual Studio Build Tools con Desktop development with C++ usando .vsconfig.",
  );

  const sdkInclude = path.join(programFilesX86, "Windows Kits", "10", "Include");
  const sdkVersions = existsSync(sdkInclude)
    ? readdirSync(sdkInclude, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^10\.0\./.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    : [];
  add(
    "Windows SDK",
    sdkVersions.length > 0,
    sdkVersions.at(-1) ?? "no encontrado",
    "Añade un Windows 10/11 SDK desde Visual Studio Installer.",
  );

  const webViewKeys = [
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    "HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  ];
  const webView = webViewKeys
    .map((key) => run("reg.exe", ["query", key, "/v", "pv"]))
    .find((result) => result.ok);
  const webViewVersion = webView?.output.match(/pv\s+REG_SZ\s+([^\s]+)/i)?.[1];
  add(
    "WebView2 Evergreen",
    Boolean(webViewVersion),
    webViewVersion ?? "no encontrado",
    "Instala Microsoft Edge WebView2 Evergreen Runtime.",
  );
} else if (process.platform === "darwin") {
  const xcode = run("xcode-select", ["-p"]);
  add(
    "Xcode Command Line Tools",
    xcode.ok,
    xcode.output || "no encontrado",
    "Ejecuta xcode-select --install.",
  );
}

const failed = checks.filter((check) => check.required && !check.ok);

if (jsonOutput) {
  process.stdout.write(
    `${JSON.stringify({ ok: failed.length === 0, platform: process.platform, checks }, null, 2)}\n`,
  );
} else {
  console.log(`Entorno WinTerm (${process.platform}/${process.arch})`);
  for (const check of checks) {
    const state = check.ok ? "OK" : check.required ? "ERROR" : "AVISO";
    console.log(`[${state}] ${check.name}: ${check.detail}`);
    if (!check.ok) console.log(`        ${check.remedy}`);
  }
  console.log(
    failed.length === 0
      ? "\nEntorno de desarrollo preparado."
      : `\nFaltan ${failed.length} requisito(s) obligatorio(s).`,
  );
}

process.exitCode = failed.length === 0 ? 0 : 1;
