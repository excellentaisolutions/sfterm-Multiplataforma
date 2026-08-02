/** Renderer PROPIO del motor de terminal (renderer = "own" en config.toml).
 *
 *  El parsing VT vive en Rust (engine); esta vista es "tonta": recibe frames
 *  binarios (solo filas dirty) por Channel, los cachea y los pinta en un
 *  canvas 2D. El input (teclado/IME/mouse/paste) se codifica aqui a bytes VT
 *  segun los modos que reporta el frame (app cursor, bracketed, mouse SGR...).
 *
 *  Que gana sobre xterm.js: bloques comando+output dibujados como objetos
 *  (separador + badge exit/duracion + re-run ↻), scrollback fuera del webview,
 *  y un modelo consultable por agentes (gate).
 */
import * as ipc from "./ipc";
// LINKS VIVOS (F2): las regex viven en links.ts (compartidas con term.ts)
import { URL_RE, scanCandidates } from "./links";
import type { AppConfig, Theme } from "./types";

const BOLD = 1, DIM = 2, ITALIC = 4, UNDERLINE = 8, INVERSE = 16, STRIKE = 32,
  HIDDEN = 64, WIDE_CONT = 256;

// modes bitfield del frame
const M_APP_CURSOR = 1, M_BRACKETED = 2, M_MOUSE_X10 = 4, M_MOUSE_DRAG = 8,
  M_MOUSE_ANY = 16, M_MOUSE_SGR = 32, M_FOCUS = 64, M_ALT_SCROLL = 128,
  M_CURSOR_VISIBLE = 1024;

interface BlockHead {
  row: number;
  running: boolean;
  hasCmd: boolean;
  /** suficiente output para el Modo Lectura (badge ☰) */
  readable: boolean;
  exit: number | null;
  durationMs: number;
  id: number;
}

function xterm256(i: number): string {
  if (i < 232) {
    const n = i - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(n / 36)], g = steps[Math.floor((n % 36) / 6)], b = steps[n % 6];
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + (i - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

export class OwnTermView {
  id = 0;
  cols = 80;
  rows = 24;
  private div: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private input: HTMLTextAreaElement;
  private theme: Theme;
  private font = "SF Mono";
  private fontSize = 13;
  private pad = 10;
  private cellW = 8;
  private cellH = 18;
  private baseline = 13;

  // cache local del grid (lo que manda el engine)
  private chs: string[][] = [];
  private flgs: Uint16Array[] = [];
  private fgs: Uint32Array[] = [];
  private bgs: Uint32Array[] = [];

  private cursorX = -1;
  private cursorY = -1;
  private cursorShape = 0;
  private modes = 0;
  private reverseVideo = false;
  private altScreen = false;
  private scrollbackLen = 0;
  private viewportOffset = 0;
  private absBase = 0;
  private blocks: BlockHead[] = [];
  private badgeHits: {
    x: number; y: number; w: number; h: number; blockId: number;
    kind: "rerun" | "read";
  }[] = [];

  private focused = false;
  private renderQueued = false;
  private wheelAcc = 0;
  private disposed = false;
  private ro: ResizeObserver | null = null;

  // seleccion en coords absolutas (fila abs, columna)
  private sel: { aAbs: number; aCol: number; bAbs: number; bCol: number } | null = null;
  private selecting = false;
  private downAt: { x: number; y: number } | null = null;

  // busqueda (cmd+F)
  private findAbs: number | null = null;
  private findQ = "";

  constructor(cfg: AppConfig, theme: Theme, div: HTMLDivElement) {
    this.div = div;
    this.theme = theme;
    this.font = cfg.appearance.terminal_font;
    this.fontSize = cfg.appearance.terminal_font_size;
    this.pad = cfg.appearance.terminal_padding ?? 10;

    this.canvas = document.createElement("canvas");
    this.canvas.className = "ownterm-canvas";
    Object.assign(this.canvas.style, { display: "block" });
    this.ctx = this.canvas.getContext("2d")!;

    this.input = document.createElement("textarea");
    this.input.className = "ownterm-input";
    this.input.setAttribute("autocorrect", "off");
    this.input.setAttribute("autocapitalize", "off");
    this.input.spellcheck = false;
    Object.assign(this.input.style, {
      position: "absolute",
      left: "0",
      top: "0",
      width: "1px",
      height: "1px",
      opacity: "0",
      padding: "0",
      border: "none",
      resize: "none",
      zIndex: "-1",
    });

    div.style.background = theme.bg_panel;
    div.appendChild(this.canvas);
    div.appendChild(this.input);
    this.measure();
  }

  // ---------- ciclo de vida ----------

  attach(id: number) {
    this.id = id;
    this.wireInput();
    this.wireMouse();
    // el canvas sigue el tamaño real del div (place() puede correr con div 0x0;
    // splits, zoom y resize de ventana tambien reflowean por aqui)
    this.ro = new ResizeObserver(() => this.fit());
    this.ro.observe(this.div);
    void ipc.engineSubscribe(id, (buf) => this.applyFrame(buf));
  }

  dispose() {
    this.disposed = true;
    this.ro?.disconnect();
    void ipc.engineUnsubscribe(this.id).catch(() => {});
    this.canvas.remove();
    this.input.remove();
  }

  applyAppearance(cfg: AppConfig, theme: Theme) {
    this.theme = theme;
    this.font = cfg.appearance.terminal_font;
    this.fontSize = cfg.appearance.terminal_font_size;
    this.pad = cfg.appearance.terminal_padding ?? 10;
    this.div.style.background = theme.bg_panel;
    this.measure();
    this.fit();
    this.queueRender();
  }

  private measure() {
    const ctx = this.ctx;
    ctx.font = `${this.fontSize}px "${this.font}", Menlo, monospace`;
    const m = ctx.measureText("W");
    this.cellW = Math.max(4, Math.ceil(m.width));
    const asc = m.fontBoundingBoxAscent || this.fontSize * 0.8;
    const desc = m.fontBoundingBoxDescent || this.fontSize * 0.25;
    this.cellH = Math.max(8, Math.ceil((asc + desc) * 1.08));
    this.baseline = Math.ceil(asc + (this.cellH - asc - desc) / 2);
  }

  /** recalcula cols/rows segun el tamaño del div y avisa al PTY/engine */
  fit() {
    const w = this.div.clientWidth - this.pad * 2;
    const h = this.div.clientHeight - this.pad * 2;
    if (w <= 0 || h <= 0) return;
    const cols = Math.max(2, Math.floor(w / this.cellW));
    const rows = Math.max(1, Math.floor(h / this.cellH));
    const dpr = window.devicePixelRatio || 1;
    const cssW = cols * this.cellW;
    const cssH = rows * this.cellH;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.style.marginLeft = `${this.pad}px`;
    this.canvas.style.marginTop = `${this.pad}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols;
      this.rows = rows;
      this.allocRows();
      void ipc.ptyResize(this.id, cols, rows);
    }
    this.queueRender();
  }

  private allocRows() {
    this.chs = Array.from({ length: this.rows }, () => Array(this.cols).fill(" "));
    this.flgs = Array.from({ length: this.rows }, () => new Uint16Array(this.cols));
    this.fgs = Array.from({ length: this.rows }, () => new Uint32Array(this.cols));
    this.bgs = Array.from({ length: this.rows }, () => new Uint32Array(this.cols));
  }

  // ---------- frames ----------

  private applyFrame(buf: Uint8Array) {
    if (this.disposed) return;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 0;
    /* seq */ dv.getUint32(o, true); o += 4;
    const cols = dv.getUint16(o, true); o += 2;
    const rows = dv.getUint16(o, true); o += 2;
    this.cursorX = dv.getInt16(o, true); o += 2;
    this.cursorY = dv.getInt16(o, true); o += 2;
    this.cursorShape = dv.getUint8(o); o += 1;
    const flags = dv.getUint8(o); o += 1;
    o += 2; // pad
    this.altScreen = (flags & 1) !== 0;
    this.reverseVideo = (flags & 2) !== 0;
    this.modes = dv.getUint32(o, true); o += 4;
    this.scrollbackLen = dv.getUint32(o, true); o += 4;
    this.viewportOffset = dv.getUint32(o, true); o += 4;
    this.absBase = dv.getUint32(o, true); o += 4;

    if (cols !== this.cols || rows !== this.rows) {
      // el engine manda dims propias (ej. resize aun en vuelo): realinear cache
      this.cols = cols;
      this.rows = rows;
      this.allocRows();
    }

    const nBlocks = dv.getUint16(o, true); o += 2;
    this.blocks = [];
    for (let i = 0; i < nBlocks; i++) {
      const row = dv.getUint16(o, true); o += 2;
      const running = dv.getUint8(o) !== 0; o += 1;
      const hasCmd = dv.getUint8(o) !== 0; o += 1;
      const readable = dv.getUint8(o) !== 0; o += 1;
      const exitRaw = dv.getInt32(o, true); o += 4;
      const durationMs = dv.getUint32(o, true); o += 4;
      const id = dv.getUint32(o, true); o += 4;
      this.blocks.push({
        row,
        running,
        hasCmd,
        readable,
        exit: exitRaw === -2147483648 ? null : exitRaw,
        durationMs,
        id,
      });
    }

    const nDirty = dv.getUint16(o, true); o += 2;
    for (let r = 0; r < nDirty; r++) {
      const y = dv.getUint16(o, true); o += 2;
      const chRow = this.chs[y];
      const flRow = this.flgs[y];
      const fgRow = this.fgs[y];
      const bgRow = this.bgs[y];
      for (let x = 0; x < this.cols; x++) {
        const cp = dv.getUint32(o, true); o += 4;
        const fg = dv.getUint32(o, true); o += 4;
        const bg = dv.getUint32(o, true); o += 4;
        const fl = dv.getUint16(o, true); o += 2;
        if (chRow) {
          chRow[x] = cp ? String.fromCodePoint(cp) : " ";
          fgRow[x] = fg;
          bgRow[x] = bg;
          flRow[x] = fl;
        }
      }
    }
    // Render DIRECTO (no rAF): el ticker de Rust ya coalesce a ~16ms, y ademas
    // WKWebView CONGELA requestAnimationFrame cuando la ventana esta en segundo
    // plano — con rAF, la terminal no repintaria hasta volver al frente.
    this.render();
  }

  private queueRender() {
    // repaint por interaccion (foco/seleccion/scroll): rAF cuando la ventana
    // esta al frente; setTimeout de respaldo por si rAF esta congelado.
    if (this.renderQueued) return;
    this.renderQueued = true;
    const run = () => {
      if (!this.renderQueued) return;
      this.renderQueued = false;
      this.render();
    };
    requestAnimationFrame(run);
    setTimeout(run, 40);
  }

  // ---------- pintado ----------

  private defaults(): { fg: string; bg: string } {
    const fg = this.theme.fg;
    const bg = this.theme.bg_panel;
    return this.reverseVideo ? { fg: bg, bg: fg } : { fg, bg };
  }

  private colorOf(v: number, bold: boolean, isFg: boolean): string | null {
    const tag = v >>> 24;
    if (tag === 0) return null; // default
    if (tag === 1) {
      let idx = v & 0xff;
      if (isFg && bold && idx < 8) idx += 8; // bright con bold (paridad xterm)
      if (idx < 16) return this.theme.ansi?.[idx] ?? xterm256(idx);
      return xterm256(idx);
    }
    return `rgb(${(v >> 16) & 0xff},${(v >> 8) & 0xff},${v & 0xff})`;
  }

  private render() {
    if (this.disposed || !this.chs.length) return;
    const ctx = this.ctx;
    const { fg: defFg, bg: defBg } = this.defaults();
    const W = this.cols * this.cellW;
    const H = this.rows * this.cellH;
    ctx.fillStyle = defBg;
    ctx.fillRect(0, 0, W, H);
    const baseFont = `${this.fontSize}px "${this.font}", Menlo, monospace`;
    ctx.font = baseFont;
    ctx.textBaseline = "alphabetic";

    const selRange = this.orderedSel();
    const topAbs = this.absBase - this.viewportOffset;

    for (let y = 0; y < this.rows; y++) {
      const chRow = this.chs[y];
      const flRow = this.flgs[y];
      const fgRow = this.fgs[y];
      const bgRow = this.bgs[y];
      if (!chRow) continue;
      const rowAbs = topAbs + y;
      const py = y * this.cellH;

      // resaltado de busqueda: toda la fila con un tinte
      if (this.findAbs !== null && rowAbs === this.findAbs) {
        ctx.fillStyle = this.theme.selection || "#33384455";
        ctx.fillRect(0, py, W, this.cellH);
      }

      for (let x = 0; x < this.cols; x++) {
        const fl = flRow[x];
        if (fl & WIDE_CONT) continue;
        const bold = (fl & BOLD) !== 0;
        let fg = this.colorOf(fgRow[x], bold, true) ?? defFg;
        let bg = this.colorOf(bgRow[x], false, false) ?? defBg;
        if (fl & INVERSE) [fg, bg] = [bg, fg];
        const selected =
          selRange &&
          (rowAbs > selRange.aAbs || (rowAbs === selRange.aAbs && x >= selRange.aCol)) &&
          (rowAbs < selRange.bAbs || (rowAbs === selRange.bAbs && x <= selRange.bCol));
        const wide = chRow[x] !== " " && (fl & 128) !== 0;
        const cw = wide ? this.cellW * 2 : this.cellW;
        const px = x * this.cellW;
        if (bg !== defBg) {
          ctx.fillStyle = bg;
          ctx.fillRect(px, py, cw, this.cellH);
        }
        if (selected) {
          ctx.fillStyle = this.theme.selection || "#33384455";
          ctx.fillRect(px, py, cw, this.cellH);
        }
        const ch = chRow[x];
        if (ch !== " " && !(fl & HIDDEN)) {
          ctx.fillStyle = fg;
          if (fl & DIM) ctx.globalAlpha = 0.55;
          const style = fl & ITALIC ? "italic " : "";
          const weight = bold ? "600 " : "";
          if (style || weight) ctx.font = `${style}${weight}${baseFont}`;
          ctx.fillText(ch, px, py + this.baseline, cw);
          if (style || weight) ctx.font = baseFont;
          ctx.globalAlpha = 1;
        }
        if (fl & (UNDERLINE | STRIKE)) {
          ctx.fillStyle = fg;
          if (fl & UNDERLINE) ctx.fillRect(px, py + this.cellH - 2, cw, 1);
          if (fl & STRIKE) ctx.fillRect(px, py + Math.floor(this.cellH / 2), cw, 1);
        }
      }
    }

    this.drawBlocks(ctx, W);
    this.drawCursor(ctx, defFg, defBg);

    // indicador de scroll (viendo historia)
    if (this.viewportOffset > 0) {
      const label = `↑ ${this.viewportOffset}`;
      ctx.font = `${Math.max(9, this.fontSize - 3)}px "${this.font}", monospace`;
      const w = ctx.measureText(label).width + 12;
      ctx.fillStyle = this.theme.accent;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(W - w - 6, 6, w, 18);
      ctx.globalAlpha = 1;
      ctx.fillStyle = this.theme.bg_panel;
      ctx.fillText(label, W - w, 19);
      ctx.font = baseFont;
    }
  }

  /** separador + badge por bloque: ✓/✗ exit · duracion · ↻ re-run */
  private drawBlocks(ctx: CanvasRenderingContext2D, W: number) {
    this.badgeHits = [];
    if (this.altScreen || !this.blocks.length) return;
    const small = `${Math.max(9, this.fontSize - 3)}px "${this.font}", monospace`;
    for (const b of this.blocks) {
      const py = b.row * this.cellH;
      if (py > 2) {
        ctx.strokeStyle = this.theme.border;
        ctx.globalAlpha = 0.9;
        ctx.beginPath();
        ctx.moveTo(0, py - 0.5);
        ctx.lineTo(W, py - 0.5);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      let label: string;
      let color: string;
      if (b.running) {
        label = "⟳ corriendo";
        color = this.theme.fg_dim;
      } else {
        const ok = (b.exit ?? 0) === 0;
        const dur = b.durationMs >= 1000
          ? `${(b.durationMs / 1000).toFixed(1)}s`
          : `${b.durationMs}ms`;
        label = `${ok ? "✓" : `✗ ${b.exit}`} · ${dur}`;
        color = ok ? this.theme.green : this.theme.red;
      }
      const read = b.readable ? "  ☰" : "";
      const rerun = b.hasCmd && !b.running ? "  ↻" : "";
      ctx.font = small;
      const w = ctx.measureText(label + read + rerun).width;
      const x = W - w - 8;
      // el badge vive montado sobre el separador; en el borde superior se
      // baja para no recortarse
      const y = Math.max(4, py - 0.5 - 7);
      ctx.fillStyle = this.theme.bg_panel;
      ctx.fillRect(x - 6, y - 1, w + 12, 14);
      ctx.fillStyle = color;
      ctx.fillText(label, x, y + 10);
      let cx = x + ctx.measureText(label).width;
      if (read) {
        // ☰ = Modo Lectura del bloque (vista rica + voz)
        const gx = cx + ctx.measureText("  ").width;
        ctx.fillStyle = this.theme.accent;
        ctx.fillText("☰", gx, y + 10);
        this.badgeHits.push({
          x: gx - 4, y: y - 3, w: ctx.measureText("☰").width + 8, h: 18,
          blockId: b.id, kind: "read",
        });
        cx += ctx.measureText(read).width;
      }
      if (rerun) {
        const gx = cx + ctx.measureText("  ").width;
        ctx.fillStyle = this.theme.accent;
        ctx.fillText("↻", gx, y + 10);
        this.badgeHits.push({
          x: gx - 4, y: y - 3, w: ctx.measureText("↻").width + 8, h: 18,
          blockId: b.id, kind: "rerun",
        });
      }
    }
  }

  private drawCursor(ctx: CanvasRenderingContext2D, defFg: string, defBg: string) {
    if ((this.modes & M_CURSOR_VISIBLE) === 0) return;
    if (this.cursorX < 0 || this.cursorY < 0 || this.viewportOffset > 0) return;
    const px = this.cursorX * this.cellW;
    const py = this.cursorY * this.cellH;
    ctx.fillStyle = this.theme.cursor || this.theme.accent;
    if (!this.focused) {
      ctx.strokeStyle = this.theme.cursor || this.theme.accent;
      ctx.strokeRect(px + 0.5, py + 0.5, this.cellW - 1, this.cellH - 1);
      return;
    }
    if (this.cursorShape === 2) {
      ctx.fillRect(px, py, 2, this.cellH);
    } else if (this.cursorShape === 1) {
      ctx.fillRect(px, py + this.cellH - 2, this.cellW, 2);
    } else {
      ctx.fillRect(px, py, this.cellW, this.cellH);
      const ch = this.chs[this.cursorY]?.[this.cursorX];
      if (ch && ch !== " ") {
        ctx.fillStyle = defBg;
        ctx.fillText(ch, px, py + this.baseline, this.cellW);
      }
    }
    void defFg;
  }

  // ---------- teclado ----------

  focus() {
    this.input.focus({ preventScroll: true });
  }

  blur() {
    this.input.blur();
  }

  private wireInput() {
    const input = this.input;
    input.addEventListener("keydown", (e) => {
      if (e.defaultPrevented) return; // atajo de app (window capture ya actuo)
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "Pause" || e.key === "Cancel")) {
        e.preventDefault();
        void ipc.ptyInterrupt(this.id, true);
        return;
      }
      // copy de la seleccion propia (canvas no tiene seleccion DOM)
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "c" && this.sel) {
        e.preventDefault();
        void this.copySelection();
        return;
      }
      // ATAJOS FRONTIER de edicion (21 jul 2026): mapeados a los bytes que el
      // TUI de claude entiende — VERIFICADOS empiricamente contra claude
      // 2.1.216 via la puerta ("ctrl+z suspende, ctrl+_ deshace" dixit el TUI).
      // Tambien sirven en zsh (emacs mode): ^U kill-line, ^_ undo.
      if (e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "Backspace") {
          // ⌘⌫ = borrar la linea completa hacia atras
          e.preventDefault();
          void ipc.ptyWrite(this.id, "\x15"); // Ctrl+U
          return;
        }
        if (e.key.toLowerCase() === "z" && !e.shiftKey) {
          // ⌘Z = undo del input (claude no tiene redo: ⌘⇧Z queda libre;
          // Ctrl+Y del TUI recupera texto borrado si hace falta)
          e.preventDefault();
          void ipc.ptyWrite(this.id, "\x1f"); // Ctrl+_
          return;
        }
        // ⌘V NO se intercepta (22 jul 2026, pedido de Daniel: "que se pegue
        // de una, no que me aparezca el recuadro Paste"). Leer el portapapeles
        // a mano (navigator.clipboard.readText) es lectura PROGRAMATICA y
        // WebKit la tapa con su boton de confirmacion "Paste": dos pasos para
        // algo que es uno. Dejandolo pasar, el sistema entrega el contenido
        // solo en el evento `paste` de abajo — mismo resultado, cero permiso.
        return; // demas cmd = app
      }
      if (e.ctrlKey && e.altKey && e.key === "Backspace") {
        // ⌃⌥⌫ = borrar TODO el parrafo/linea actual (End + kill-to-start)
        e.preventDefault();
        void ipc.ptyWrite(this.id, "\x05\x15");
        return;
      }
      if (e.metaKey) return; // demas cmd = app
      const bytes = this.encodeKey(e);
      if (bytes !== null) {
        e.preventDefault();
        this.clearSelection();
        if (this.viewportOffset > 0) void this.scrollTo(0);
        void ipc.ptyWrite(this.id, bytes);
      }
    });
    input.addEventListener("input", () => {
      if ((input as unknown as { isComposing?: boolean }).isComposing) return;
      const v = input.value;
      if (v) {
        input.value = "";
        this.clearSelection();
        if (this.viewportOffset > 0) void this.scrollTo(0);
        void ipc.ptyWrite(this.id, v);
      }
    });
    input.addEventListener("compositionend", (e) => {
      const v = (e as CompositionEvent).data;
      input.value = "";
      if (v) void ipc.ptyWrite(this.id, v);
    });
    // CAMINO UNICO del pegado (incluido ⌘V, que ya no se intercepta): el
    // sistema entrega el contenido YA en el evento, sin lectura programatica
    // y por lo tanto sin el boton "Paste" de WebKit. Un solo paso.
    input.addEventListener("paste", (e) => {
      e.preventDefault();
      const t = e.clipboardData?.getData("text/plain");
      if (t) this.paste(t);
      // sin texto = imagen (screenshot): ^V y el TUI de claude la adjunta
      // el solo ([Image #N]) — nosotros no tocamos el portapapeles
      else void ipc.ptyWrite(this.id, "\x16");
    });
    input.addEventListener("focus", () => {
      this.focused = true;
      if (this.modes & M_FOCUS) void ipc.ptyWrite(this.id, "\x1b[I");
      this.queueRender();
    });
    input.addEventListener("blur", () => {
      this.focused = false;
      if (this.modes & M_FOCUS) void ipc.ptyWrite(this.id, "\x1b[O");
      this.queueRender();
    });
  }

  /** teclas de control → bytes VT. null = dejar que el input event lo maneje
   *  (printables, dead keys, IME). */
  private encodeKey(e: KeyboardEvent): string | null {
    const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
    const app = (this.modes & M_APP_CURSOR) !== 0;
    const arrow = (ch: string) =>
      mod > 1 ? `\x1b[1;${mod}${ch}` : app ? `\x1bO${ch}` : `\x1b[${ch}`;
    const tilde = (n: number) => (mod > 1 ? `\x1b[${n};${mod}~` : `\x1b[${n}~`);
    switch (e.key) {
      case "Enter":
        // SALTO DE LINEA EN CUALQUIER CLI (22 jul 2026, pedido de Daniel):
        // ⇧⏎ **y** ⌥⏎ mandan ESC+CR (meta+enter) — la convencion que emiten
        // los emuladores serios (iTerm2, VSCode, Ghostty) y que por eso los
        // TUIs aprendieron a leer como "nueva linea, NO enviar". Antes ⌥⏎
        // caia al `\r` de abajo, o sea ENVIABA el mensaje.
        if ((e.shiftKey || e.altKey) && !e.metaKey && !e.ctrlKey) return "\x1b\r";
        return "\r";
      case "Backspace":
        return e.altKey ? "\x1b\x7f" : "\x7f";
      case "Tab":
        return e.shiftKey ? "\x1b[Z" : "\t";
      case "Escape":
        return "\x1b";
      case "ArrowUp": {
        // alt screen sin mouse: rueda/flechas normales
        return arrow("A");
      }
      case "ArrowDown":
        return arrow("B");
      case "ArrowRight":
        return arrow("C");
      case "ArrowLeft":
        return arrow("D");
      case "Home":
        return mod > 1 ? `\x1b[1;${mod}H` : app ? "\x1bOH" : "\x1b[H";
      case "End":
        return mod > 1 ? `\x1b[1;${mod}F` : app ? "\x1bOF" : "\x1b[F";
      case "PageUp":
        if (e.shiftKey) {
          void this.scrollBy(-(this.rows - 1));
          return "";
        }
        return tilde(5);
      case "PageDown":
        if (e.shiftKey) {
          void this.scrollBy(this.rows - 1);
          return "";
        }
        return tilde(6);
      case "Delete":
        return tilde(3);
      case "Insert":
        return tilde(2);
      case "F1": return mod > 1 ? `\x1b[1;${mod}P` : "\x1bOP";
      case "F2": return mod > 1 ? `\x1b[1;${mod}Q` : "\x1bOQ";
      case "F3": return mod > 1 ? `\x1b[1;${mod}R` : "\x1bOR";
      case "F4": return mod > 1 ? `\x1b[1;${mod}S` : "\x1bOS";
      case "F5": return tilde(15);
      case "F6": return tilde(17);
      case "F7": return tilde(18);
      case "F8": return tilde(19);
      case "F9": return tilde(20);
      case "F10": return tilde(21);
      case "F11": return tilde(23);
      case "F12": return tilde(24);
    }
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
      const c = e.key.toLowerCase().charCodeAt(0);
      if (c >= 97 && c <= 122) return String.fromCharCode(c - 96); // ctrl+a..z
      if (e.key === " ") return "\x00";
      if (e.key === "[") return "\x1b";
      if (e.key === "\\") return "\x1c";
      if (e.key === "]") return "\x1d";
    }
    return null;
  }

  paste(text: string) {
    const t = text.replace(/\r?\n/g, "\r");
    const bracketed = (this.modes & M_BRACKETED) !== 0;
    const payload = bracketed ? `\x1b[200~${t}\x1b[201~` : t;
    if (this.viewportOffset > 0) void this.scrollTo(0);
    void ipc.ptyWrite(this.id, payload);
  }

  // ---------- mouse ----------

  private cellFromEvent(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(this.cols - 1, Math.floor((e.clientX - r.left) / ((r.width || 1) / this.cols))));
    const y = Math.max(0, Math.min(this.rows - 1, Math.floor((e.clientY - r.top) / ((r.height || 1) / this.rows))));
    return { x, y };
  }

  private mouseActive(): boolean {
    return (this.modes & (M_MOUSE_X10 | M_MOUSE_DRAG | M_MOUSE_ANY)) !== 0;
  }

  private reportMouse(e: MouseEvent, kind: "down" | "up" | "move" | "wheelUp" | "wheelDown") {
    const { x, y } = this.cellFromEvent(e);
    let b: number;
    if (kind === "wheelUp") b = 64;
    else if (kind === "wheelDown") b = 65;
    else b = e.button === 1 ? 1 : e.button === 2 ? 2 : 0;
    if (kind === "move") b += 32;
    if (e.shiftKey) b += 4;
    if (e.altKey) b += 8;
    if (e.ctrlKey) b += 16;
    if (this.modes & M_MOUSE_SGR) {
      const suffix = kind === "up" ? "m" : "M";
      void ipc.ptyWrite(this.id, `\x1b[<${b};${x + 1};${y + 1}${suffix}`);
    } else {
      const bb = kind === "up" ? 3 : b;
      const enc = (v: number) => String.fromCharCode(Math.min(223, 32 + v));
      void ipc.ptyWrite(this.id, `\x1b[M${enc(bb)}${enc(x + 1)}${enc(y + 1)}`);
    }
  }

  private wireMouse() {
    const canvas = this.canvas;
    canvas.style.cursor = "text";
    canvas.addEventListener("mousedown", (e) => {
      this.focus();
      if (this.mouseActive() && !e.altKey) {
        this.reportMouse(e, "down");
        return;
      }
      const { x, y } = this.cellFromEvent(e);
      const abs = this.absBase - this.viewportOffset + y;
      this.downAt = { x: e.clientX, y: e.clientY };
      if (e.detail >= 3) {
        this.sel = { aAbs: abs, aCol: 0, bAbs: abs, bCol: this.cols - 1 };
      } else if (e.detail === 2) {
        const [c0, c1] = this.wordAt(y, x);
        this.sel = { aAbs: abs, aCol: c0, bAbs: abs, bCol: c1 };
      } else {
        this.sel = { aAbs: abs, aCol: x, bAbs: abs, bCol: x };
        this.selecting = true;
      }
      this.queueRender();
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!this.selecting || !this.sel) return;
      const { x, y } = this.cellFromEvent(e);
      const abs = this.absBase - this.viewportOffset + y;
      this.sel.bAbs = abs;
      this.sel.bCol = x;
      this.queueRender();
    });
    window.addEventListener("mouseup", (e) => {
      if (this.mouseActive() && !e.altKey && e.target === canvas && !this.selecting) {
        this.reportMouse(e, "up");
      }
      if (!this.selecting) return;
      this.selecting = false;
      const moved =
        this.downAt &&
        (Math.abs(e.clientX - this.downAt.x) > 4 || Math.abs(e.clientY - this.downAt.y) > 4);
      if (!moved && this.sel && this.sel.aAbs === this.sel.bAbs && this.sel.aCol === this.sel.bCol) {
        this.sel = null;
        if (e.target === canvas) this.clickLink(e);
      }
      this.downAt = null;
      this.queueRender();
    });
    canvas.addEventListener("mouseup", (e) => {
      if (this.mouseActive() && !e.altKey && !this.sel) this.reportMouse(e, "up");
    });
    canvas.addEventListener("click", (e) => {
      // badges de bloques: ↻ re-run
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const hit = this.badgeHits.find(
        (h) => px >= h.x && px <= h.x + h.w && py >= h.y && py <= h.y + h.h,
      );
      if (hit) {
        e.preventDefault();
        if (hit.kind === "read") {
          window.dispatchEvent(new CustomEvent("sfterm:open-reader", {
            detail: { ptyId: this.id, blockId: hit.blockId },
          }));
        } else {
          void this.rerunBlock(hit.blockId);
        }
      }
    });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (this.mouseActive() && !e.altKey) {
        this.reportMouse(e, e.deltaY < 0 ? "wheelUp" : "wheelDown");
        return;
      }
      if (this.altScreen && this.modes & M_ALT_SCROLL) {
        // alternate scroll: rueda → flechas
        const n = Math.max(1, Math.min(5, Math.round(Math.abs(e.deltaY) / 40)));
        const seq = e.deltaY < 0 ? "\x1b[A" : "\x1b[B";
        void ipc.ptyWrite(this.id, seq.repeat(n));
        return;
      }
      this.wheelAcc += e.deltaY;
      const lines = Math.trunc(this.wheelAcc / this.cellH);
      if (lines !== 0) {
        this.wheelAcc -= lines * this.cellH;
        void this.scrollBy(lines);
      }
    }, { passive: false });
  }

  private wordAt(y: number, x: number): [number, number] {
    const row = this.chs[y];
    if (!row) return [x, x];
    const isWord = (c: string) => /[\w.\-/~@]/.test(c);
    if (!isWord(row[x])) return [x, x];
    let a = x, b = x;
    while (a > 0 && isWord(row[a - 1])) a--;
    while (b < this.cols - 1 && isWord(row[b + 1])) b++;
    return [a, b];
  }

  private clickLink(e: MouseEvent) {
    const { x, y } = this.cellFromEvent(e);
    const text = this.chs[y]?.join("") ?? "";
    // URLs primero (su camino es el navegador del sistema, como siempre)
    URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(text)) !== null) {
      if (x >= m.index && x < m.index + m[0].length) {
        void ipc.openUrl(m[0]);
        return;
      }
    }
    // LINKS VIVOS: candidato bajo el cursor → la VERDAD la decide Rust al
    // click (actions.ts resuelve contra el cwd del panel; inexistente = nada)
    for (const c of scanCandidates(text)) {
      if (x >= c.start && x < c.start + c.token.length) {
        window.dispatchEvent(
          new CustomEvent("sfterm:open-token", { detail: { token: c.token, termId: this.id } }),
        );
        return;
      }
    }
  }

  private async rerunBlock(blockId: number) {
    try {
      const blocks = await ipc.engineBlocks(this.id, 200);
      const b = blocks.find((x) => x.id === blockId);
      if (b && !b.running && b.cmd) {
        await this.scrollTo(0);
        void ipc.ptyWrite(this.id, b.cmd + "\r");
      }
    } catch { /* engine ya no esta */ }
  }

  // ---------- scroll / seleccion / busqueda ----------

  private async scrollBy(lines: number) {
    // lines > 0 = hacia abajo (menos offset)
    const next = await ipc.engineSetViewport(this.id, -lines, true).catch(() => null);
    if (next !== null) this.viewportOffset = next;
  }

  private async scrollTo(offset: number) {
    const next = await ipc.engineSetViewport(this.id, offset, false).catch(() => null);
    if (next !== null) this.viewportOffset = next;
  }

  private orderedSel() {
    if (!this.sel) return null;
    const { aAbs, aCol, bAbs, bCol } = this.sel;
    if (bAbs > aAbs || (bAbs === aAbs && bCol >= aCol)) {
      return { aAbs, aCol, bAbs, bCol };
    }
    return { aAbs: bAbs, aCol: bCol, bAbs: aAbs, bCol: aCol };
  }

  clearSelection() {
    if (this.sel) {
      this.sel = null;
      this.queueRender();
    }
  }

  selectAll() {
    this.sel = {
      aAbs: this.absBase - this.scrollbackLen,
      aCol: 0,
      bAbs: this.absBase + this.rows - 1,
      bCol: this.cols - 1,
    };
    this.queueRender();
  }

  async copySelection() {
    const s = this.orderedSel();
    if (!s) return;
    try {
      const text = await ipc.engineRangeText(this.id, s.aAbs, s.aCol, s.bAbs, s.bCol);
      if (text) await navigator.clipboard.writeText(text);
    } catch { /* clipboard denegado */ }
  }

  async find(q: string, dir: "next" | "prev") {
    this.findQ = q;
    if (!q) {
      this.findAbs = null;
      this.queueRender();
      return;
    }
    const from = this.findAbs !== null
      ? dir === "next" ? this.findAbs + 1 : this.findAbs
      : undefined;
    let hit = await ipc.engineFind(this.id, q, from, dir === "prev").catch(() => null);
    if (!hit && from !== undefined) {
      // wrap-around
      hit = await ipc.engineFind(this.id, q, undefined, dir === "prev").catch(() => null);
    }
    if (hit) {
      this.findAbs = hit[0];
      // centrar el match en el viewport
      const target = this.absBase - hit[0];
      const offset = Math.max(0, Math.min(this.scrollbackLen, target + Math.floor(this.rows / 2)));
      await this.scrollTo(offset);
    }
    this.queueRender();
  }

  clearFind() {
    this.findAbs = null;
    this.findQ = "";
    void this.findQ;
    this.queueRender();
  }
}
