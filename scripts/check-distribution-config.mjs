import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const trackedFiles = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const forbiddenSigningFiles = trackedFiles.filter((file) =>
  /(?:^|\/)(?:\.sfterm-signing)(?:\/|$)|\.(?:pfx|p12|cer|key|key\.pub)$|[^/]*-password\.txt$/i.test(file));
assert.deepEqual(forbiddenSigningFiles, [], `Material de firma rastreado por Git: ${forbiddenSigningFiles.join(", ")}`);
const privateKeyMarker = ["BEGIN", "PRIVATE", "KEY"].join(" ");
const certificateMarker = ["BEGIN", "CERTIFICATE"].join(" ");
const tauriSecretMarker = ["minisign", "encrypted", "secret", "key"].join(" ");
for (const file of trackedFiles) {
  const content = fs.readFileSync(file);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  assert.doesNotMatch(text, /[A-Za-z]:\\Users\\[^\\\s"'`]+/i, `Ruta personal publicada en ${file}`);
  assert.equal(text.includes(privateKeyMarker), false, `Clave privada publicada en ${file}`);
  assert.equal(text.includes(certificateMarker), false, `Certificado publicado en ${file}`);
  assert.equal(text.toLowerCase().includes(tauriSecretMarker), false, `Clave Tauri publicada en ${file}`);
}
const base = json("src-tauri/tauri.conf.json");
const windows = json("src-tauri/tauri.windows.conf.json");
const cargo = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
const unsignedWorkflow = fs.readFileSync(".github/workflows/package-windows-unsigned.yml", "utf8");

assert.equal(base.bundle.active, true);
assert.deepEqual(base.plugins.updater, { pubkey: "", endpoints: [] });
assert.deepEqual(windows.bundle.targets, ["nsis", "msi"]);
assert.equal(windows.bundle.windows.nsis.installMode, "currentUser");
assert.equal(windows.bundle.windows.nsis.installerHooks, "windows/nsis-hooks.nsh");
assert.equal(windows.bundle.windows.webviewInstallMode.type, "embedBootstrapper");
assert.match(cargo, /^tauri-plugin-updater\s*=\s*"2\./m);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
assert.match(workflow, /WINDOWS_CERTIFICATE/);
assert.match(workflow, /certificate\.Subject -eq \$certificate\.Issuer/);
assert.match(workflow, /Cert:\\CurrentUser\\TrustedPublisher/);
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
