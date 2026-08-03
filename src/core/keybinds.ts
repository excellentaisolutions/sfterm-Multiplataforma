import type { KeyEventLike, ShortcutPlatform } from "./keys.ts";

/** Fuente unica de los atajos remapeables: censo de acciones + su default.
 *  Los defaults son copia de src-tauri/src/config.rs -> DEFAULT_CONFIG [keys]
 *  (si cambian alla, actualizar aqui a mano; no hay forma de leer Rust desde
 *  el bundler). Consumido por ShortcutsPanel (solo lectura) y por la pestaña
 *  "Atajos" de Settings (edicion) — asi ambas vistas nunca se desincronizan. */

export interface KeybindAction {
  action: string;
  label: string;
  /** combo por defecto, formato de config.toml [keys] */
  def: string;
}

export interface KeybindGroup {
  title: string;
  items: KeybindAction[];
}

export const KEYBIND_GROUPS: KeybindGroup[] = [
  {
    title: "Conversación de la terminal",
    items: [
      { action: "taller", label: "LECTOR: la conversación de la terminal enfocada con cara de chat (abre/cierra; Esc vuelve)", def: "ctrl+tab" },
      { action: "chat", label: "Lector de la terminal enfocada", def: "primary+l" },
    ],
  },
  {
    title: "Moverse",
    items: [
      { action: "next_terminal", label: "Siguiente TERMINAL, en el orden del rail", def: "alt+tab" },
      { action: "next_tab", label: "Siguiente PESTAÑA del campo enfocado (con una sola pestaña la tecla se la queda el agente)", def: "shift+tab" },
    ],
  },
  {
    title: "Terminales",
    items: [
      { action: "new_chat", label: "Terminal nueva en el tiling", def: "primary+n" },
      { action: "new_terminal", label: "Terminal rápida (panel inferior)", def: "primary+j" },
      { action: "new_conversation", label: "Terminal nueva CON el agente (config agent_command)", def: "primary+alt+j" },
      { action: "close_panel", label: "Quitar la pestaña de la vista — la conversación sigue viva en el rail (matarla = ✕ del rail) · cerrar el lector", def: "primary+w" },
    ],
  },
  {
    title: "Buscar y abrir",
    items: [
      { action: "file_finder", label: "Abrir archivo por nombre", def: "primary+p" },
      { action: "search_project", label: "Buscar por contenido en el proyecto", def: "primary+shift+f" },
      { action: "search", label: "Buscar dentro de la terminal", def: "primary+alt+f" },
      { action: "palette", label: "Paleta de comandos", def: "primary+k" },
    ],
  },
  {
    title: "Vistas",
    items: [
      { action: "toggle_tree", label: "Árbol de archivos", def: "primary+b" },
      { action: "toggle_rail", label: "Rail de conversaciones", def: "primary+alt+b" },
      { action: "toggle_markdown", label: "Visor: markdown ⇄ código", def: "primary+shift+m" },
      { action: "toggle_theme", label: "Cambiar paleta: papel ⇄ arbrain", def: "primary+shift+t" },
      { action: "expand_leaf", label: "Expandir el campo enfocado a TODA la pantalla (y volver)", def: "primary+shift+e" },
      { action: "zoom_in", label: "Zoom + (la página si el navegador está enfocado; si no, la app)", def: "primary+=" },
      { action: "zoom_out", label: "Zoom − (la página si el navegador está enfocado; si no, la app)", def: "primary+-" },
      { action: "zoom_reset", label: "Zoom 100% (navegador: vuelve al ajuste automático)", def: "primary+0" },
    ],
  },
  {
    title: "Taller pro",
    items: [
      { action: "composer", label: "Composer: texto real hacia la terminal enfocada", def: "primary+i" },
      { action: "focus_left", label: "Foco al panel izquierdo", def: "primary+alt+arrowleft" },
      { action: "focus_right", label: "Foco al panel derecho", def: "primary+alt+arrowright" },
      { action: "focus_up", label: "Foco al panel de arriba", def: "primary+alt+arrowup" },
      { action: "focus_down", label: "Foco al panel de abajo", def: "primary+alt+arrowdown" },
      { action: "dock_panel", label: "Encajonar el panel: fuera de vista pero VIVO", def: "primary+d" },
      { action: "restore_last", label: "Restaurar el último encajonado", def: "primary+shift+d" },
      { action: "select_all", label: "Seleccionar todo el buffer", def: "primary+a" },
    ],
  },
  {
    title: "App",
    items: [
      { action: "settings", label: "Configuración", def: "primary+," },
      { action: "shortcuts", label: "Este panel", def: "primary+alt+s" },
      { action: "reload_app", label: "Recargar la app (relanza con el build nuevo)", def: "primary+r" },
    ],
  },
];

/** action -> label, derivado de KEYBIND_GROUPS (para mensajes de colision). */
export const ACTION_LABEL: Record<string, string> = Object.fromEntries(
  KEYBIND_GROUPS.flatMap((g) => g.items).map((i) => [i.action, i.label]),
);

const DEFAULT_COMBO: Record<string, string> = Object.fromEntries(
  KEYBIND_GROUPS.flatMap((group) => group.items).map((item) => [item.action, item.def]),
);

export function actionCombo(
  action: string,
  keys: Record<string, string> | undefined,
  platform: ShortcutPlatform,
): string {
  return formatCombo(keys?.[action] ?? DEFAULT_COMBO[action] ?? "", platform);
}

/** Traduce prosa auxiliar legado con glifos macOS. Los paneles de atajos usan
 * combos estructurados; esto cubre tooltips breves sin duplicar componentes. */
export function nativeShortcutText(text: string, platform?: ShortcutPlatform): string {
  const windows = platform
    ? platform === "windows"
    : typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  if (!windows) return text;
  return text
    .replaceAll("⌘⌥", "Ctrl+Alt+")
    .replaceAll("⌘⇧", "Ctrl+Shift+")
    .replaceAll("⌘+", "Ctrl+")
    .replaceAll("⌘", "Ctrl+")
    .replaceAll("⌥", "Alt+")
    .replaceAll("⇧", "Shift+");
}

/** Gestos fijos: completan el mapa visual pero no viven en [keys] — no son remapeables. */
export function fixedGestures(platform: ShortcutPlatform): [string, string][] {
  return [
    ["Esc", "Escalonado: drawer → lector → taller"],
    [platform === "windows" ? "Enter · Shift+Enter" : "⏎ · ⇧⏎", "Enviar · salto de línea (lector y composer)"],
    [formatCombo("primary+plus", platform) + "/−/0", "Zoom en cualquier layout de teclado"],
  ];
}

/** Combos que rompen la TUI de claude en el taller si se asignan (ctrl+letra
 *  clasico de terminal, o teclas de navegacion SIN modificador). Es un aviso,
 *  no un bloqueo — Daniel puede igual guardarlos si sabe lo que hace. */
const SOFT_BLOCKLIST = [
  "ctrl+c", "ctrl+d", "ctrl+r", "ctrl+l", "ctrl+z",
  "tab", "escape", "enter", "arrowleft", "arrowright", "arrowup", "arrowdown",
];

const MAC_SYM: Record<string, string> = {
  primary: "⌘", cmd: "⌘", meta: "⌘", alt: "⌥", opt: "⌥", option: "⌥", shift: "⇧", ctrl: "⌃", control: "⌃",
  arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓",
  tab: "⇥", escape: "⎋", enter: "⏎", space: "␣", backspace: "⌫",
};

const WINDOWS_NAME: Record<string, string> = {
  primary: "Ctrl", cmd: "Win", meta: "Win", alt: "Alt", opt: "Alt", option: "Alt", shift: "Shift", ctrl: "Ctrl", control: "Ctrl",
  arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓",
  tab: "Tab", escape: "Esc", enter: "Enter", space: "Space", backspace: "Backspace",
};

/** Combo crudo ("cmd+alt+j") -> presentacion mac ("⌘⌥J"). Vacio = desasignado. */
export function formatCombo(combo: string, platform: ShortcutPlatform = "macos"): string {
  if (!combo || !combo.trim()) return "sin asignar";
  const names = platform === "windows" ? WINDOWS_NAME : MAC_SYM;
  const parts = combo
    .split("+")
    .map((p) => (p === "plus" ? "+" : names[p] ?? (p.length === 1 ? p.toUpperCase() : p)));
  return parts.join(platform === "windows" ? "+" : "");
}

/** Firma canonica de un combo para comparar duplicados sin importar orden de
 *  modificadores o alias (meta==cmd, opt==alt, control==ctrl). */
export function normalizeCombo(combo: string, platform: ShortcutPlatform = "macos"): string {
  const parts = combo.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "";
  const raw = parts[parts.length - 1];
  const key = raw === "plus" ? "+" : raw;
  const has = (names: string[]) => names.some((n) => parts.includes(n));
  const primary = parts.includes("primary");
  const bits = [
    has(["cmd", "meta"]) || (primary && platform === "macos") ? "1" : "0",
    has(["ctrl", "control"]) || (primary && platform === "windows") ? "1" : "0",
    has(["alt", "opt", "option"]) ? "1" : "0",
    has(["shift"]) ? "1" : "0",
  ].join("");
  return `${bits}:${key}`;
}

export function isSoftBlocked(combo: string, platform: ShortcutPlatform = "macos"): boolean {
  if (!combo.trim() || combo.toLowerCase().split("+").includes("primary")) return false;
  const blocked = new Set(SOFT_BLOCKLIST.map((item) => normalizeCombo(item, platform)));
  return blocked.has(normalizeCombo(combo, platform));
}

/** teclas con nombre propio: e.code coincide 1:1 con el nombre en ingles, asi
 *  que no hace falta un mapa aparte por e.key (evita gotchas de layout). */
const NAMED_CODES: Record<string, string> = {
  Tab: "tab", Enter: "enter", Escape: "escape", Space: "space", Backspace: "backspace",
  ArrowLeft: "arrowleft", ArrowRight: "arrowright", ArrowUp: "arrowup", ArrowDown: "arrowdown",
};

const MODIFIER_KEYS = new Set(["Meta", "Control", "Alt", "Shift"]);

/** Traduce un keydown de captura a un combo guardable ("cmd+alt+j"), o null
 *  si el evento no alcanza para formar uno (solo modificador, o tecla no
 *  soportada). Reglas (gotcha layout LATAM, ver teammate brief):
 *   - letras/digitos: token via e.code (fisico), respeta shift normal
 *   - teclas nombradas (tab/enter/escape/space/backspace/flechas): idem
 *   - simbolos/puntuacion (e.key de 1 caracter no alfanumerico): token = e.key
 *     TAL CUAL, y el shift se DESCARTA del combo — en latam "/" es fisicamente
 *     shift+7, guardar ese shift contaminaria el combo con el layout del usuario */
export function captureCombo(
  e: KeyEventLike,
  platform: ShortcutPlatform = "macos",
): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;

  const mods: string[] = [];
  if (e.metaKey) mods.push(platform === "macos" ? "primary" : "meta");
  if (e.ctrlKey) mods.push(platform === "windows" ? "primary" : "ctrl");
  if (e.altKey) mods.push("alt");

  let token: string | null = null;
  let includeShift = true;

  if (/^Key[A-Z]$/.test(e.code)) {
    token = e.code.slice(3).toLowerCase();
  } else if (/^Digit[0-9]$/.test(e.code)) {
    token = e.code.slice(5);
  } else if (NAMED_CODES[e.code]) {
    token = NAMED_CODES[e.code];
  } else if (e.key.length === 1 && !/^[a-zA-Z0-9]$/.test(e.key)) {
    // "+" LITERAL rompe el formato (es el separador): token nombrado
    token = e.key === "+" ? "plus" : e.key;
    includeShift = false;
  }

  if (!token) return null;
  if (includeShift && e.shiftKey) mods.push("shift");
  return [...mods, token].join("+");
}

// ── modo captura global: mientras el panel de Atajos espera un combo, el
//    keymap de App NO debe despachar (⌘W cerraria un panel a media captura;
//    stopPropagation no alcanza: listeners del MISMO target corren todos).
//    Flag de modulo compartido — verificacion adversarial 20 jul.
let capturing = false;
export function setCapturingKeys(v: boolean) { capturing = v; }
export function isCapturingKeys(): boolean { return capturing; }
