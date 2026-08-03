import assert from "node:assert/strict";
import fs from "node:fs";

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const base = json("src-tauri/tauri.conf.json");
const windows = json("src-tauri/tauri.windows.conf.json");
const cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
const unsignedWorkflow = fs.readFileSync(".github/workflows/package-windows-unsigned.yml", "utf8");

assert.equal(base.bundle.active, true);
assert.deepEqual(windows.bundle.targets, ["nsis", "msi"]);
assert.equal(windows.bundle.windows.nsis.installMode, "currentUser");
assert.equal(windows.bundle.windows.nsis.installerHooks, "windows/nsis-hooks.nsh");
assert.equal(windows.bundle.windows.webviewInstallMode.type, "embedBootstrapper");
assert.match(cargo, /^tauri-plugin-updater\s*=\s*"2\./m);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
assert.match(workflow, /WINDOWS_CERTIFICATE/);
assert.match(workflow, /updaterJsonPreferNsis:\s*true/);
assert.match(workflow, /releaseDraft:\s*true/);
assert.match(unsignedWorkflow, /workflow_dispatch:/);
assert.match(unsignedWorkflow, /push:\s*\n\s*paths:/);
assert.match(unsignedWorkflow, /contents:\s*read/);
assert.match(unsignedWorkflow, /test:installer-lifecycle:windows/);
assert.match(unsignedWorkflow, /UNSIGNED TEST ARTIFACTS - DO NOT DISTRIBUTE/);
assert.doesNotMatch(unsignedWorkflow, /contents:\s*write/);
assert.doesNotMatch(unsignedWorkflow, /gh release|tauri-apps\/tauri-action/);
const nsisHooks = fs.readFileSync("src-tauri/windows/nsis-hooks.nsh", "utf8");
assert.match(nsisHooks, /\$DeleteAppDataCheckboxState\s*=\s*1/);
assert.match(nsisHooks, /\$UpdateMode\s*<>\s*1/);
assert.match(nsisHooks, /\$APPDATA\\SFTerm/);
assert.match(nsisHooks, /\$LOCALAPPDATA\\SFTerm/);
const validationWorkflow = fs.readFileSync(".github/workflows/validate.yml", "utf8");
assert.match(validationWorkflow, /npm audit --omit=dev --audit-level=high/);
assert.match(validationWorkflow, /rustsec\/audit-check@v2\.0\.0/);

console.log("distribution config: unsigned CI isolated from signed production release OK");
