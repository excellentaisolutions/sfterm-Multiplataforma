import { generateManifest } from "material-icon-theme";

// El manifest mapea nombres/extensiones -> nombre de icono. Los SVG viven en
// /material-icons/ (copiados desde node_modules por `npm run icons`).
const manifest = generateManifest();

const iconUrl = (name: string) => `/material-icons/${name}.svg`;

export function iconForFile(fileName: string): string {
  const lower = fileName.toLowerCase();
  const byName = (manifest.fileNames as Record<string, string> | undefined)?.[
    lower
  ];
  if (byName) return iconUrl(byName);
  const parts = lower.split(".");
  // extension compuesta mas larga primero: "test.tsx" antes que "tsx"
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join(".");
    const hit = (
      manifest.fileExtensions as Record<string, string> | undefined
    )?.[ext];
    if (hit) return iconUrl(hit);
  }
  return iconUrl((manifest.file as string) ?? "file");
}

export function iconForFolder(folderName: string, open: boolean): string {
  const map = (
    open ? manifest.folderNamesExpanded : manifest.folderNames
  ) as Record<string, string> | undefined;
  const hit = map?.[folderName.toLowerCase()];
  if (hit) return iconUrl(hit);
  const fallback = open
    ? ((manifest.folderExpanded as string) ?? "folder-open")
    : ((manifest.folder as string) ?? "folder");
  return iconUrl(fallback);
}
