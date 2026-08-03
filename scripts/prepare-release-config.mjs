import fs from "node:fs";
import path from "node:path";

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable requerida ${name}`);
  return value;
};

const pubkey = required("SFTERM_UPDATER_PUBKEY");
const updaterOnly = process.argv.includes("--updater-only");
const certificateThumbprint = updaterOnly
  ? null
  : required("WINDOWS_CERTIFICATE_THUMBPRINT").replaceAll(" ", "").toUpperCase();
if (certificateThumbprint && !/^[A-F0-9]{40,64}$/.test(certificateThumbprint)) {
  throw new Error("WINDOWS_CERTIFICATE_THUMBPRINT no parece una huella SHA valida");
}

const endpoint = process.env.SFTERM_UPDATER_ENDPOINT?.trim()
  || "https://github.com/excellentaisolutions/sfterm-Multiplataforma/releases/latest/download/latest.json";
if (!endpoint.startsWith("https://")) throw new Error("El endpoint del updater debe usar HTTPS");

const config = {
  bundle: {
    createUpdaterArtifacts: true,
    ...(certificateThumbprint ? { windows: {
      certificateThumbprint,
      digestAlgorithm: "sha256",
      timestampUrl: "http://timestamp.digicert.com",
    } } : {}),
  },
  plugins: {
    updater: {
      pubkey,
      endpoints: [endpoint],
      windows: { installMode: "passive" },
    },
  },
};

const output = path.resolve("src-tauri", "target", "release-config.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(path.relative(process.cwd(), output));
