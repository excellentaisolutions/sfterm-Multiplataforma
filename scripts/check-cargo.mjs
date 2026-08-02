import { spawnSync } from "node:child_process";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCompatibleRustToolchain } from "./resolve-rust-toolchain.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const manifestPath = path.join(projectRoot, "src-tauri", "Cargo.toml");
const targetDir = path.join(projectRoot, "src-tauri", "target");
const jsonOutput = process.argv.includes("--json");
const online = process.argv.includes("--online");
const toolchain = findCompatibleRustToolchain();

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      ...extraEnv,
      CARGO_TARGET_DIR: targetDir,
      ...(toolchain ? { RUSTUP_TOOLCHAIN: toolchain } : {}),
    },
  });
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function probe(url) {
  return new Promise((resolve) => {
    const request = https.request(url, { method: "HEAD", timeout: 8_000 }, (response) => {
      response.resume();
      resolve({
        url,
        ok: Boolean(response.statusCode && response.statusCode < 400),
        status: response.statusCode ?? null,
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) =>
      resolve({ url, ok: false, status: null, error: error.message }),
    );
    request.end();
  });
}

function tail(value, lines = 5) {
  return value.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}

const endpoints = await Promise.all([
  probe("https://index.crates.io/config.json"),
  probe("https://static.crates.io/crates/git2/git2-0.21.0.crate"),
]);
const cargo = toolchain
  ? run(process.platform === "win32" ? "rustup.exe" : "rustup", [
      "run",
      toolchain,
      "cargo",
      "--version",
    ])
  : { ok: false, status: null, output: "Rust 1.97.0 compatible no encontrado" };
const offlineFetch = cargo.ok
  ? run(process.platform === "win32" ? "cargo.exe" : "cargo", [
      "fetch",
      "--manifest-path",
      manifestPath,
      "--locked",
      "--offline",
    ])
  : { ok: false, status: null, output: "Cargo no disponible" };
const onlineFetch = online && cargo.ok
  ? run(process.platform === "win32" ? "cargo.exe" : "cargo", [
      "fetch",
      "--manifest-path",
      manifestPath,
      "--locked",
    ])
  : null;

const generalNetworkOk = endpoints.every((endpoint) => endpoint.ok);
const cargoSocketBlocked = Boolean(
  onlineFetch &&
    !onlineFetch.ok &&
    generalNetworkOk &&
    /(?:10013|socket.*(?:permiso|permission)|Could not connect to server)/i.test(
      onlineFetch.output,
    ),
);
const result = {
  ok: cargo.ok && (online ? Boolean(onlineFetch?.ok) : offlineFetch.ok),
  platform: `${process.platform}/${process.arch}`,
  toolchain,
  cargo: { ...cargo, output: tail(cargo.output, 2) },
  endpoints,
  cache: {
    ok: offlineFetch.ok,
    detail: offlineFetch.ok
      ? "Cargo.lock está disponible completamente en la caché local."
      : tail(offlineFetch.output),
  },
  onlineFetch: onlineFetch
    ? { ok: onlineFetch.ok, detail: tail(onlineFetch.output) }
    : null,
  diagnosis: cargoSocketBlocked
    ? "cargo_process_socket_blocked"
    : !generalNetworkOk
      ? "crates_io_unreachable"
      : !offlineFetch.ok
        ? "cargo_cache_incomplete"
        : "ready",
};

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  console.log(`Cargo doctor (${result.platform})`);
  console.log(`${cargo.ok ? "[OK]" : "[ERROR]"} Toolchain: ${toolchain ?? "no encontrado"}`);
  for (const endpoint of endpoints) {
    console.log(
      `${endpoint.ok ? "[OK]" : "[ERROR]"} ${endpoint.url}: ${endpoint.status ?? endpoint.error}`,
    );
  }
  console.log(`${offlineFetch.ok ? "[OK]" : "[AVISO]"} Caché Cargo`);
  if (!offlineFetch.ok) console.log(tail(offlineFetch.output));
  if (onlineFetch) {
    console.log(`${onlineFetch.ok ? "[OK]" : "[ERROR]"} cargo fetch --locked`);
    if (!onlineFetch.ok) console.log(tail(onlineFetch.output));
  }
  console.log(`\nDiagnóstico: ${result.diagnosis}`);
  if (cargoSocketBlocked) {
    console.log(
      "La red general funciona, pero Windows o el entorno de ejecución impide a cargo.exe abrir sockets. Revisa reglas por aplicación del firewall, antivirus/EDR o la política del sandbox; no cambies Cargo.lock ni uses un mirror para ocultarlo.",
    );
  } else if (!generalNetworkOk) {
    console.log("Comprueba DNS, proxy, TLS y acceso HTTPS a crates.io.");
  } else if (!offlineFetch.ok && !online) {
    console.log("La caché está incompleta. Ejecuta `npm run cargo:doctor:online` para probar y descargar exactamente Cargo.lock.");
  }
}

process.exitCode = result.ok ? 0 : 1;
