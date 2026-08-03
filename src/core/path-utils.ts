export function isAbsolutePath(value: string): boolean {
  const path = value.trim();
  return (
    path.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("//")
  );
}

export function pathBasename(value: string): string {
  const path = value.replace(/[\\/]+$/, "");
  if (!path) return value.startsWith("/") ? "/" : "";
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return path.slice(index + 1) || path;
}

export function pathDirname(value: string): string {
  const path = value.replace(/[\\/]+$/, "");
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index < 0) return "";
  if (index === 0) return path[0];
  if (index === 2 && /^[a-zA-Z]:/.test(path)) return path.slice(0, 3);
  return path.slice(0, index);
}

/** La vista Archivos sigue la carpeta de la terminal enfocada. Si no hay una
 * terminal activa (por ejemplo, al enfocar un visor), conserva la raiz del
 * proyecto como fallback estable. */
export function currentExplorerRoot(projectRoot: string, focusedCwd?: string | null): string {
  return focusedCwd?.trim() ? focusedCwd : projectRoot;
}

/** Ruta relativa con separadores Git (`/`), o el valor intacto si queda fuera. */
export function pathRelative(root: string, value: string): string {
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const path = value.replace(/\\/g, "/").replace(/\/+$/, "");
  const windowsPath = /^[a-zA-Z]:\//.test(base) || base.startsWith("//");
  const comparableBase = windowsPath ? base.toLowerCase() : base;
  const comparablePath = windowsPath ? path.toLowerCase() : path;
  if (comparablePath === comparableBase) return "";
  if (comparablePath.startsWith(`${comparableBase}/`)) return path.slice(base.length + 1);
  return value;
}

/** Paths absolutos escritos por el árbol, uno por línea. Rechaza texto normal. */
export function parseDroppedPaths(raw: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const path = line.trim();
    if (!isAbsolutePath(path) || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

export function fileManagerLabel(): "Explorer" | "Finder" {
  if (typeof navigator === "undefined") return "Finder";
  const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /windows|win32|win64/i.test(platform) ? "Explorer" : "Finder";
}
