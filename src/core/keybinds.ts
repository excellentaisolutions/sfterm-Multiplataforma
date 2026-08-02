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
      { action: "chat", label: "Mismo gesto que ⌃Tab (lector de la terminal enfocada)", def: "cmd+l" },
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
      { action: "new_chat", label: "Terminal nueva en el tiling", def: "cmd+n" },
      { action: "new_terminal", label: "Terminal rápida (panel inferior)", def: "cmd+j" },
      { action: "new_conversation", label: "Terminal nueva CON el agente (config agent_command)", def: "cmd+alt+j" },
      { action: "close_panel", label: "Quitar la pestaña de la vista — la conversación sigue viva en el rail (matarla = ✕ del rail) · cerrar el lector", def: "cmd+w" },
    ],
  },
  {
    title: "Buscar y abrir",
    items: [
      { action: "file_finder", label: "Abrir archivo por nombre", def: "cmd+p" },
      { action: "search_project", label: "Buscar por contenido en el proyecto", def: "cmd+shift+f" },
      { action: "search", label: "Buscar dentro de la terminal", def: "cmd+alt+f" },
      { action: "palette", label: "Paleta de comandos", def: "cmd+k" },
    ],
  },
  {
    title: "Vistas",
    items: [
      { action: "toggle_tree", label: "Árbol de archivos", def: "cmd+b" },
      { action: "toggle_rail", label: "Rail de conversaciones", def: "cmd+alt+b" },
      { action: "toggle_markdown", label: "Visor: markdown ⇄ código", def: "cmd+shift+m" },
      { action: "toggle_theme", label: "Cambiar paleta: papel ⇄ arbrain", def: "cmd+shift+t" },
      { action: "expand_leaf", label: "Expandir el campo enfocado a TODA la pantalla (y volver)", def: "cmd+shift+e" },
      { action: "zoom_in", label: "Zoom + (la página si el navegador está enfocado; si no, la app)", def: "cmd+=" },
      { action: "zoom_out", label: "Zoom − (la página si el navegador está enfocado; si no, la app)", def: "cmd+-" },
      { action: "zoom_reset", label: "Zoom 100% (navegador: vuelve al ajuste automático)", def: "cmd+0" },
    ],
  },
  {
    title: "Taller pro",
    items: [
      { action: "composer", label: "Composer: texto real hacia la terminal enfocada", def: "cmd+i" },
      { action: "focus_left", label: "Foco al panel izquierdo", def: "cmd+alt+arrowleft" },
      { action: "focus_right", label: "Foco al panel derecho", def: "cmd+alt+arrowright" },
      { action: "focus_up", label: "Foco al panel de arriba", def: "cmd+alt+arrowup" },
      { action: "focus_down", label: "Foco al panel de abajo", def: "cmd+alt+arrowdown" },
      { action: "dock_panel", label: "Encajonar el panel: fuera de vista pero VIVO (mismo destino que ⌘W)", def: "cmd+d" },
      { action: "restore_last", label: "Restaurar el último encajonado", def: "cmd+shift+d" },
      { action: "select_all", label: "Seleccionar todo el buffer", def: "cmd+a" },
    ],
  },
  {
    title: "App",
    items: [
      { action: "settings", label: "Configuración", def: "cmd+," },
      { action: "shortcuts", label: "Este panel", def: "cmd+alt+s" },
      { action: "reload_app", label: "Recargar la app (relanza con el build nuevo)", def: "cmd+r" },
    ],
  },
];

/** action -> label, derivado de KEYBIND_GROUPS (para mensajes de colision). */
export const ACTION_LABEL: Record<string, string> = Object.fromEntries(
  KEYBIND_GROUPS.flatMap((g) => g.items).map((i) => [i.action, i.label]),
);

/** Gestos fijos: completan el mapa visual pero no viven en [keys] — no son remapeables. */
export const FIXED_GESTURES: [string, string][] = [
  ["Esc", "Escalonado: drawer → lector → taller"],
  ["⏎ · ⇧⏎", "Enviar · salto de línea (lector y composer)"],
  ["⌘ +/−/0", "Zoom en cualquier layout de teclado"],
];

/** Combos que rompen la TUI de claude en el taller si se asignan (ctrl+letra
 *  clasico de terminal, o teclas de navegacion SIN modificador). Es un aviso,
 *  no un bloqueo — Daniel puede igual guardarlos si sabe lo que hace. */
const SOFT_BLOCKLIST = [
  "ctrl+c", "ctrl+d", "ctrl+r", "ctrl+l", "ctrl+z",
  "tab", "escape", "enter", "arrowleft", "arrowright", "arrowup", "arrowdown",
];

const SYM: Record<string, string> = {
  cmd: "⌘", meta: "⌘", alt: "⌥", opt: "⌥", option: "⌥", shift: "⇧", ctrl: "⌃",
  arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓",
  tab: "⇥", escape: "⎋", enter: "⏎", space: "␣", backspace: "⌫",
};

/** Combo crudo ("cmd+alt+j") -> presentacion mac ("⌘⌥J"). Vacio = desasignado. */
export function formatCombo(combo: string): string {
  if (!combo || !combo.trim()) return "sin asignar";
  return combo
    .split("+")
    .map((p) => (p === "plus" ? "+" : SYM[p] ?? (p.length === 1 ? p.toUpperCase() : p)))
    .join("");
}

/** Firma canonica de un combo para comparar duplicados sin importar orden de
 *  modificadores o alias (meta==cmd, opt==alt, control==ctrl). */
export function normalizeCombo(combo: string): string {
  const parts = combo.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return "";
  const raw = parts[parts.length - 1];
  const key = raw === "plus" ? "+" : raw;
  const has = (names: string[]) => names.some((n) => parts.includes(n));
  const bits = [
    has(["cmd", "meta"]) ? "1" : "0",
    has(["ctrl", "control"]) ? "1" : "0",
    has(["alt", "opt", "option"]) ? "1" : "0",
    has(["shift"]) ? "1" : "0",
  ].join("");
  return `${bits}:${key}`;
}

const SOFT_BLOCKLIST_NORM = new Set(SOFT_BLOCKLIST.map(normalizeCombo));

export function isSoftBlocked(combo: string): boolean {
  return combo.trim() ? SOFT_BLOCKLIST_NORM.has(normalizeCombo(combo)) : false;
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
export function captureCombo(e: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;

  const mods: string[] = [];
  if (e.metaKey) mods.push("cmd");
  if (e.ctrlKey) mods.push("ctrl");
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
