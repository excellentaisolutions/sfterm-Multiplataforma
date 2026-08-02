import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import * as ipc from "./ipc";
import { OwnTermView } from "./ownterm";
import { scanCandidates, resolveToken, onOpenResolved, type ResolvedToken } from "./links";
import { parseDroppedPaths, type AppConfig, type Rect, type Theme } from "./types";
import { useStore } from "./store";
import { leafOfTerm } from "./tiling";
import { quoteShellPaths } from "./shell-command";

const QUIET_MS = 8000;

/** Una terminal viva. kind decide quien DIBUJA:
 *  - "xterm": xterm.js (parsea y pinta en el webview)
 *  - "own":   motor propio (parsea Rust, pinta OwnTermView en canvas)
 *  El engine de Rust parsea SIEMPRE (semantica/bloques/gate), en ambos modos. */
export interface TermEntry {
  id: number;
  kind: "xterm" | "own";
  term: Terminal | null;
  own: OwnTermView | null;
  fit: FitAddon | null;
  search: SearchAddon | null;
  div: HTMLDivElement;
  lastData: number;
  visible: boolean;
  cols: number;
  rows: number;
}

type KeyInterceptor = (e: KeyboardEvent) => boolean; // true = xterm lo procesa

function xtermTheme(t: Theme) {
  const a = t.ansi ?? [];
  return {
    background: t.bg_panel,
    foreground: t.fg,
    cursor: t.cursor,
    cursorAccent: t.bg_panel,
    selectionBackground: t.selection,
    black: a[0], red: a[1], green: a[2], yellow: a[3],
    blue: a[4], magenta: a[5], cyan: a[6], white: a[7],
    brightBlack: a[8], brightRed: a[9], brightGreen: a[10], brightYellow: a[11],
    brightBlue: a[12], brightMagenta: a[13], brightCyan: a[14], brightWhite: a[15],
  };
}

// LINKS VIVOS (F2): regex + verificacion viven en links.ts (compartidos con
// el motor propio). La vieja PATH_RE solo-absolutas murio con ellos.

class TerminalManager {
  private entries = new Map<number, TermEntry>();
  private pool: HTMLDivElement | null = null;
  private interceptor: KeyInterceptor | null = null;
  webglOk: boolean | null = null;

  setKeyInterceptor(fn: KeyInterceptor) {
    this.interceptor = fn;
  }

  private ensurePool(): HTMLDivElement {
    if (!this.pool) {
      const el = document.createElement("div");
      el.id = "term-pool";
      document.body.appendChild(el);
      this.pool = el;
    }
    return this.pool;
  }

  /** Pool APARTE para la terminal del drawer (⌘J): mismo patron pero z-85,
   *  SOBRE el chat (z-80). La terminal del drawer NACE aqui y nunca se
   *  reparenta (cero riesgo de perder canvas/estado). */
  private drawerPool: HTMLDivElement | null = null;
  private ensureDrawerPool(): HTMLDivElement {
    if (!this.drawerPool) {
      const el = document.createElement("div");
      el.id = "term-pool-drawer";
      document.body.appendChild(el);
      this.drawerPool = el;
    }
    return this.drawerPool;
  }

  create(cfg: AppConfig, theme: Theme, layer: "main" | "drawer" = "main"): Omit<TermEntry, "id"> {
    const div = document.createElement("div");
    div.className = "term-slot";
    div.style.padding = `${cfg.appearance.terminal_padding ?? 10}px`;
    (layer === "drawer" ? this.ensureDrawerPool() : this.ensurePool()).appendChild(div);

    const renderer = (cfg.appearance as { renderer?: string }).renderer ?? "dom";
    const base = {
      lastData: Date.now(),
      visible: false,
      cols: 80,
      rows: 24,
      div,
    };

    // ---- motor propio: la vista canvas (el engine de Rust ya parsea) ----
    if (renderer === "own") {
      // el padding lo maneja el canvas (margin), no el div
      div.style.padding = "0";
      const own = new OwnTermView(cfg, theme, div);
      return { ...base, kind: "own", term: null, own, fit: null, search: null };
    }

    // ---- xterm.js (dom | webgl) ----
    const term = new Terminal({
      allowProposedApi: true,
      scrollback: cfg.general?.scrollback ?? 8000,
      fontFamily: `"${cfg.appearance.terminal_font}", Menlo, monospace`,
      fontSize: cfg.appearance.terminal_font_size,
      theme: xtermTheme(theme),
      cursorBlink: true,
      macOptionIsMeta: false,
      // TUIs (claude) capturan el mouse: option+drag fuerza seleccion nativa
      macOptionClickForcesSelection: true,
      minimumContrastRatio: 1,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    try {
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = "11";
    } catch { /* opcional */ }
    term.loadAddon(
      new WebLinksAddon((_e, uri) => {
        void ipc.openUrl(uri);
      }),
    );
    term.open(div);

    // WebGL esta ROTO en WKWebView de macOS 26.5 (xterm.js #5816); opt-in.
    if (renderer === "webgl" && this.webglOk !== false) {
      try {
        const gl = new WebglAddon();
        gl.onContextLoss(() => {
          try { gl.dispose(); } catch { /* ya muerto */ }
        });
        term.loadAddon(gl);
        this.webglOk = true;
      } catch {
        this.webglOk = false;
      }
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      if (this.interceptor) return this.interceptor(e);
      return true;
    });

    return { ...base, kind: "xterm", term, own: null, fit, search };
  }

  register(id: number, e: Omit<TermEntry, "id">) {
    const entry: TermEntry = { ...e, id };
    this.entries.set(id, entry);

    if (entry.kind === "own") {
      entry.own!.attach(id);
    } else {
      const term = entry.term!;
      // re-attach con el id ya conocido: shift+enter = salto de linea via ESC+CR
      // (la convencion que Claude Code instala con /terminal-setup en VSCode/iTerm)
      term.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown") return true;
        if (ev.ctrlKey && !ev.altKey && !ev.metaKey && (ev.key === "Pause" || ev.key === "Cancel")) {
          ev.preventDefault();
          void ipc.ptyInterrupt(id, true);
          return false;
        }
        // SALTO DE LINEA: ⇧⏎ y ⌥⏎ (paridad con ownterm.ts, 22 jul 2026) →
        // ESC+CR, la convencion meta+enter que los TUIs leen como nueva linea
        if (ev.key === "Enter" && (ev.shiftKey || ev.altKey) && !ev.metaKey && !ev.ctrlKey) {
          ev.preventDefault();
          void ipc.ptyWrite(id, "\x1b\r");
          return false;
        }
        // ATAJOS FRONTIER (paridad con ownterm.ts, 21 jul 2026): bytes
        // verificados contra el TUI de claude 2.1.216 — ^U borra linea,
        // ^_ deshace (^Z SUSPENDE: jamas mandarlo), ^V pega imagen.
        if (ev.metaKey && !ev.ctrlKey && !ev.altKey) {
          if (ev.key === "Backspace") {
            ev.preventDefault();
            void ipc.ptyWrite(id, "\x15");
            return false;
          }
          if (ev.key.toLowerCase() === "z" && !ev.shiftKey) {
            ev.preventDefault();
            void ipc.ptyWrite(id, "\x1f");
            return false;
          }
          // ⌘V NO se intercepta (22 jul 2026): leer el portapapeles a mano es
          // lectura PROGRAMATICA y WebKit la tapa con su boton "Paste" (dos
          // pasos para uno). Se deja pasar: el TEXTO lo pega xterm solo
          // (bracketed incluido) y el listener de abajo cubre la IMAGEN.
        }
        if (ev.ctrlKey && ev.altKey && ev.key === "Backspace") {
          ev.preventDefault();
          void ipc.ptyWrite(id, "\x05\x15");
          return false;
        }
        if (this.interceptor) return this.interceptor(ev);
        return true;
      });

      // IMAGEN pegada (paridad con ownterm): xterm solo entiende texto, asi
      // que el evento nativo cubre el resto. Con texto NO se hace nada (sin
      // preventDefault) y xterm lo pega el solo; sin texto es un screenshot y
      // se manda ^V para que el TUI de claude lo adjunte. Cero lectura
      // programatica del portapapeles = cero boton "Paste" de WebKit.
      entry.div.addEventListener("paste", (ev) => {
        const dt = (ev as ClipboardEvent).clipboardData;
        if (dt?.getData("text/plain")) return;
        ev.preventDefault();
        void ipc.ptyWrite(id, "\x16");
      });

      term.onData((d) => {
        void ipc.ptyWrite(id, d);
      });
      term.onBell(() => {
        const st = useStore.getState();
        if (st.focused !== id) st.setAttention(id, "bell");
      });
      // titulo OSC 0/2: Claude Code emite aqui su RESUMEN de la conversacion.
      // (El engine tambien lo emite via engine://evt; doble set inofensivo.)
      term.onTitleChange((t) => {
        const st = useStore.getState();
        const p = st.panels[id];
        if (p && t.trim() && t !== p.title) {
          st.set({ panels: { ...st.panels, [id]: { ...p, title: t } } });
        }
      });
      term.onResize(({ cols, rows }) => {
        entry.cols = cols;
        entry.rows = rows;
        void ipc.ptyResize(id, cols, rows);
      });
      // LINKS VIVOS: candidatos por regex (relativos incluidos), VERDAD por
      // Rust contra el cwd vivo del panel — solo lo que existe se subraya.
      // El provider de xterm es async a proposito: cb puede llegar despues.
      term.registerLinkProvider({
        provideLinks: (y, cb) => {
          const line = term.buffer.active.getLine(y - 1);
          if (!line) return cb(undefined);
          const text = line.translateToString(false);
          const cands = scanCandidates(text);
          if (!cands.length) return cb(undefined);
          const cwd = useStore.getState().panels[id]?.cwd || "";
          void Promise.all(
            cands.map(async (c) => ({ c, r: await resolveToken(c.token, cwd) })),
          ).then((rs) => {
            const links = rs
              .filter((x): x is { c: (typeof rs)[number]["c"]; r: ResolvedToken } => !!x.r)
              .map(({ c, r }) => ({
                range: {
                  start: { x: c.start + 1, y },
                  end: { x: c.start + c.token.length, y },
                },
                text: c.token,
                activate: () => onOpenResolved?.(r),
              }));
            cb(links.length ? (links as never) : undefined);
          });
        },
      });
    }

    // Drop de paths desde el arbol (ambos modos) — uno o varios (multi-seleccion)
    entry.div.addEventListener("dragover", (ev) => ev.preventDefault());
    entry.div.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const paths = parseDroppedPaths(ev.dataTransfer?.getData("text/plain") ?? "");
      if (paths.length) {
        void ipc.ptyWrite(id, `${quoteShellPaths(paths)} `);
        this.focus(id);
      }
    });
  }

  feed(e: Omit<TermEntry, "id"> | TermEntry, data: Uint8Array) {
    // en modo "own" los bytes crudos NO se pintan aqui (el engine manda
    // frames); solo alimentan lastData/atencion/kickoff.
    if (e.kind === "xterm") e.term!.write(data);
    const now = Date.now();
    if ("id" in e) {
      const st = useStore.getState();
      const isFocusedVisible = st.focused === e.id && e.visible;
      if (!isFocusedVisible && now - e.lastData > QUIET_MS) {
        st.setAttention(e.id, "output");
      }
    }
    e.lastData = now;
  }

  place(id: number, rect: Rect) {
    const e = this.entries.get(id);
    if (!e) return;
    e.visible = true;
    Object.assign(e.div.style, {
      display: "block",
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.w}px`,
      height: `${rect.h}px`,
    });
    requestAnimationFrame(() => {
      try {
        if (e.kind === "own") e.own!.fit();
        else e.fit!.fit();
      } catch { /* div 0x0 transitorio */ }
    });
  }

  hide(id: number) {
    const e = this.entries.get(id);
    if (!e) return;
    e.visible = false;
    e.div.style.display = "none";
  }

  focus(id: number) {
    const e = this.entries.get(id);
    if (!e) return;
    const st = useStore.getState();
    // con el chat (home) abierto NO se roba el foco DOM: se enfocaria un
    // xterm invisible debajo del overlay y el teclado se iria a una terminal
    // que no se ve. EXCEPCION: la terminal del drawer (⌘J) SI se ve sobre el
    // chat (pool z-85) — esa siempre puede tomar el teclado.
    const isDrawer = st.ui.drawer && id === st.drawerTermId;
    if (!st.ui.chat || isDrawer) {
      if (e.kind === "own") e.own!.focus();
      else e.term!.focus();
    }
    const leaf = leafOfTerm(st.root, id);
    st.set({ focused: id, focusedLeaf: leaf?.id ?? st.focusedLeaf });
    st.setAttention(id, null);
  }

  blurAll() {
    for (const e of this.entries.values()) {
      if (e.kind === "own") e.own!.blur();
      else e.term!.blur();
    }
  }

  /** pega texto (bracketed paste si el programa lo pidio) */
  paste(id: number, text: string) {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.kind === "own") e.own!.paste(text);
    else e.term!.paste(text);
  }

  selectAll(id: number) {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.kind === "own") e.own!.selectAll();
    else e.term!.selectAll();
  }

  /** ultimas n lineas CON contenido (para el gate). El modo own lee del
   *  engine (fuente de verdad); xterm lee su buffer local. */
  async readTail(id: number, n: number): Promise<string> {
    const e = this.entries.get(id);
    if (!e) return "";
    if (e.kind === "own") {
      return ipc.engineText(id, n).catch(() => "");
    }
    const buf = e.term!.buffer.active;
    const all: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      all.push(buf.getLine(y)?.translateToString(false).trimEnd() ?? "");
    }
    const text = all.join("\n").replace(/\s+$/, "");
    return text.split("\n").slice(-n).join("\n");
  }

  find(id: number, q: string, dir: "next" | "prev") {
    const e = this.entries.get(id);
    if (!e || !q) return;
    if (e.kind === "own") {
      void e.own!.find(q, dir);
      return;
    }
    if (dir === "next") e.search!.findNext(q, { incremental: false });
    else e.search!.findPrevious(q);
  }

  clearFind(id: number) {
    const e = this.entries.get(id);
    if (!e) return;
    if (e.kind === "own") {
      e.own!.clearFind();
      return;
    }
    try { e.search?.clearDecorations(); } catch { /* opcional */ }
  }

  applyAppearance(cfg: AppConfig, theme: Theme) {
    for (const e of this.entries.values()) {
      if (e.kind === "own") {
        e.own!.applyAppearance(cfg, theme);
        continue;
      }
      const term = e.term!;
      term.options.fontFamily = `"${cfg.appearance.terminal_font}", Menlo, monospace`;
      term.options.fontSize = cfg.appearance.terminal_font_size;
      term.options.theme = xtermTheme(theme);
      e.div.style.padding = `${cfg.appearance.terminal_padding ?? 10}px`;
      if (e.visible) {
        requestAnimationFrame(() => {
          try { e.fit!.fit(); } catch { /* transitorio */ }
        });
      }
    }
  }

  dispose(id: number) {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    if (e.kind === "own") {
      e.own!.dispose();
    } else {
      try { e.term!.dispose(); } catch { /* ya muerto */ }
    }
    e.div.remove();
  }

  get(id: number) {
    return this.entries.get(id);
  }
}

export const manager = new TerminalManager();
