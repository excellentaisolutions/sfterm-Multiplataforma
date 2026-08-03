export interface Binding {
  action: string;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  code: string;
  /** caracter crudo del combo ("=", "-", "a"): fallback por e.key para layouts
   *  no-US, donde la tecla FISICA (e.code) vive en otro lugar (latam: "+" es
   *  BracketRight, "-" es Slash). */
  keyChar: string;
}

export type ShortcutPlatform = "macos" | "windows";

export interface KeyEventLike {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function isPrimaryEvent(e: KeyEventLike, platform: ShortcutPlatform): boolean {
  return platform === "windows"
    ? e.ctrlKey && !e.metaKey
    : e.metaKey && !e.ctrlKey;
}

/** "cmd+alt+j" -> KeyboardEvent.code (KeyJ). Usamos e.code porque en macOS
 *  alt+letra produce caracteres especiales en e.key. */
function codeFor(key: string): string {
  const k = key.toLowerCase();
  if (/^[a-z]$/.test(k)) return `Key${k.toUpperCase()}`;
  if (/^[0-9]$/.test(k)) return `Digit${k}`;
  const special: Record<string, string> = {
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    ",": "Comma",
    ".": "Period",
    "/": "Slash",
    ";": "Semicolon",
    "'": "Quote",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    "`": "Backquote",
    "-": "Minus",
    "=": "Equal",
    plus: "Equal", // "+" literal: token nombrado ("+" es el separador de combos)
    enter: "Enter",
    escape: "Escape",
    space: "Space",
    tab: "Tab",
    backspace: "Backspace",
  };
  return special[k] ?? k;
}

export function compileBindings(
  keys: Record<string, string>,
  platform: ShortcutPlatform = "macos",
): Binding[] {
  const out: Binding[] = [];
  for (const [action, combo] of Object.entries(keys ?? {})) {
    if (typeof combo !== "string" || !combo.trim()) continue;
    const parts = combo.toLowerCase().split("+").map((p) => p.trim());
    const key = parts[parts.length - 1];
    const primary = parts.includes("primary");
    out.push({
      action,
      meta: parts.includes("cmd") || parts.includes("meta") || (primary && platform === "macos"),
      alt: parts.includes("alt") || parts.includes("opt") || parts.includes("option"),
      shift: parts.includes("shift"),
      ctrl:
        parts.includes("ctrl") ||
        parts.includes("control") ||
        (primary && platform === "windows"),
      code: codeFor(key),
      keyChar: key === "plus" ? "+" : key,
    });
  }
  return out;
}

export function matchBinding(
  e: KeyEventLike,
  bindings: Binding[],
): string | null {
  for (const b of bindings) {
    if (
      e.metaKey === b.meta &&
      e.altKey === b.alt &&
      e.shiftKey === b.shift &&
      e.ctrlKey === b.ctrl &&
      // fisica US (e.code) O caracter producido (e.key): asi "cmd+-" tambien
      // matchea en latam, donde el guion vive en la tecla fisica Slash
      (e.code === b.code || e.key.toLowerCase() === b.keyChar)
    ) {
      return b.action;
    }
  }
  return null;
}
