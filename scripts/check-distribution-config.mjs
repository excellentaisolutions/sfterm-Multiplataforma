import assert from "node:assert/strict";
import fs from "node:fs";

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const base = json("src-tauri/tauri.conf.json");
const windows = json("src-tauri/tauri.windows.conf.json");
const cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");

assert.equal(base.bundle.active, true);
assert.deepEqual(windows.bundle.targets, ["nsis", "msi"]);
assert.equal(windows.bundle.windows.nsis.installMode, "currentUser");
assert.equal(windows.bundle.windows.webviewInstallMode.type, "embedBootstrapper");
assert.match(cargo, /^tauri-plugin-updater\s*=\s*"2\./m);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
assert.match(workflow, /WINDOWS_CERTIFICATE/);
assert.match(workflow, /updaterJsonPreferNsis:\s*true/);
assert.match(workflow, /releaseDraft:\s*true/);

console.log("distribution config: NSIS per-user + MSI + signed updater release gate OK");
