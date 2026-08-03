import fs from "node:fs";
import path from "node:path";

const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const cargoLock = fs.readFileSync("src-tauri/Cargo.lock", "utf8");

const components = new Map();
const add = (component) => components.set(component.purl, component);

for (const [location, pkg] of Object.entries(lock.packages ?? {})) {
  if (!location || !pkg.version) continue;
  const name = pkg.name ?? location.slice(location.lastIndexOf("node_modules/") + 13);
  const purl = `pkg:npm/${encodeURIComponent(name)}@${pkg.version}`;
  const component = { type: "library", name, version: pkg.version, purl };
  if (pkg.integrity?.startsWith("sha512-")) {
    component.hashes = [{ alg: "SHA-512", content: Buffer.from(pkg.integrity.slice(7), "base64").toString("hex") }];
  }
  add(component);
}

for (const block of cargoLock.split(/^\[\[package\]\]\s*$/m).slice(1)) {
  const field = (name) => block.match(new RegExp(`^${name} = "([^"]+)"$`, "m"))?.[1];
  const name = field("name");
  const version = field("version");
  if (!name || !version || name === "app") continue;
  const purl = `pkg:cargo/${encodeURIComponent(name)}@${version}`;
  const component = { type: "library", name, version, purl };
  const checksum = field("checksum");
  if (checksum) component.hashes = [{ alg: "SHA-256", content: checksum }];
  add(component);
}

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: {
    component: {
      type: "application",
      name: baseName(lock.name ?? "sfterm"),
      version: lock.version ?? "0.0.0",
      purl: `pkg:npm/${baseName(lock.name ?? "sfterm")}@${lock.version ?? "0.0.0"}`,
    },
  },
  components: [...components.values()].sort((a, b) => a.purl.localeCompare(b.purl)),
};

function baseName(value) {
  return String(value).trim().toLowerCase();
}

const output = path.resolve("artifacts", "sfterm.cdx.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(bom, null, 2)}\n`, "utf8");
console.log(`${path.relative(process.cwd(), output)} (${bom.components.length} components)`);
