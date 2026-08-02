/** Lectura por voz del Modo Lectura de bloques, con la VOZ DEL SISTEMA
 *  (Web Speech API): resaltado del la palabra exacta que suena, tap en un
 *  parrafo para saltar, y barra de control (⏮ ⏯ ⏭ · velocidad · ✕).
 *
 *  PORT del motor ya resuelto de Arbrain (chat-speech.ts, 15 jul 2026),
 *  recortado a la unica superficie de SFTerm: WKWebView macOS. Los fixes
 *  duros que NO hay que redescubrir viajan completos:
 *   · WKWebView NO emite `boundary` ni `onend` confiables → "reloj propio":
 *     si la plataforma habla, manda ella; si calla, el reloj mueve el
 *     resaltado y destraba el avance de frase.
 *   · `cancel()` es ASINCRONO en WebKit: hablar en el mismo tick se traga la
 *     utterance nueva → tick de 60ms entre cancel y speak.
 *   · La voz no debe verbalizar ruido (URLs, rutas, emojis): se sanea ANTES
 *     de hablar con un MAPA hablado→visible para no desincronizar el
 *     resaltado.
 *   · UNA sola Highlight persistente (clear+add), nunca delete/set.
 *   · WebKit no expone las voces "mejoradas" por nombre: si Juan no aparece,
 *     NO fijar utterance.voice (la default del sistema = Contenido Hablado).
 */

const RATES = [1, 1.25, 1.5, 1.75, 2];

// ---- Texto HABLADO vs texto VISIBLE ----
// El orden ES la prioridad: la primera regla que toca un tramo gana.
const NOISE: Array<{ re: RegExp; say: string }> = [
  { re: /https?:\/\/[^\s)>\]]+/gu, say: " un enlace " },
  // Rutas: DOS o mas segmentos con barra (una sola barra se tragaba "80/20").
  { re: /[\w.~-]*(?:\/[\w.~-]+){2,}/gu, say: " una ruta " },
  { re: /\b[\w-]+\.(?:ts|tsx|js|jsx|py|md|rs|css|json|sh|html|sql|yml|yaml|toml)\b/gu, say: " un archivo " },
  { re: /[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, say: "" },
  { re: /[→⇒➜►]/gu, say: " hacia " },
  { re: /[←⇐◄]/gu, say: " desde " },
  { re: /§\s*(?=\d)/gu, say: " sección " },
  { re: /[·•▍|§#*_`✓✗↻⟳]/gu, say: " " },
  { re: /[«»“”„‟‹›"']/gu, say: " " },
];

/** Texto que se le manda a la voz + map[i] = indice VISIBLE del i-esimo char
 *  hablado. `boundary.charIndex` viene en coordenadas del texto hablado; el
 *  resaltado necesita las del visible. */
export function buildSpoken(text: string): { spoken: string; map: number[] } {
  type Hit = { start: number; end: number; say: string };
  const hits: Hit[] = [];
  for (const { re, say } of NOISE) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (!m[0].length) {
        re.lastIndex++;
        continue;
      }
      hits.push({ start: m.index, end: m.index + m[0].length, say });
    }
  }
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const clean: Hit[] = [];
  let guard = -1;
  for (const h of hits) {
    if (h.start < guard) continue;
    clean.push(h);
    guard = h.end;
  }

  let spoken = "";
  const map: number[] = [];
  let i = 0;
  for (const h of clean) {
    for (; i < h.start; i++) {
      map.push(i);
      spoken += text[i];
    }
    const span = h.end - h.start;
    for (let k = 0; k < h.say.length; k++) {
      map.push(h.start + Math.floor((k / h.say.length) * span));
      spoken += h.say[k];
    }
    i = h.end;
  }
  for (; i < text.length; i++) {
    map.push(i);
    spoken += text[i];
  }
  return { spoken, map };
}

export interface SpeechState {
  active: boolean;
  paused: boolean;
  rate: number;
  idx: number;
  total: number;
}

const INACTIVE_STATE: SpeechState = { active: false, paused: false, rate: 1, idx: 0, total: 0 };

class ReaderSpeechController {
  private synth: SpeechSynthesis | null =
    typeof window !== "undefined" ? window.speechSynthesis : null;
  private playing = false;
  private paused = false;
  private container: HTMLElement | null = null;
  private blocks: HTMLElement[] = [];
  private idx = 0;
  private rateIdx = 0;
  private tapHandlers: Array<() => void> = [];
  private speakTimer: ReturnType<typeof setTimeout> | null = null;
  private curId: string | null = null;
  private uttSeq = 0;
  private listeners = new Set<() => void>();
  // Snapshot CACHEADO para useSyncExternalStore: misma referencia mientras el
  // estado no cambie (si no, render loop infinito).
  private cached: SpeechState = INACTIVE_STATE;

  subscribe(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit() {
    this.cached = {
      active: this.curId != null,
      paused: this.paused,
      rate: RATES[this.rateIdx],
      idx: this.idx,
      total: this.blocks.length,
    };
    this.listeners.forEach((l) => l());
  }
  getState(): SpeechState {
    return this.cached;
  }

  isActive(id: string) {
    return this.curId === id;
  }

  /** Toggle desde el boton: si este contenido ya esta cargado, cierra. */
  toggle(id: string, el: HTMLElement) {
    if (!this.synth) return;
    if (this.curId === id) {
      this.stop();
      return;
    }
    this.stop();
    this.curId = id;
    this.container = el;
    this.collectBlocks();
    if (!this.blocks.length) {
      this.curId = null;
      return;
    }
    this.idx = 0;
    this.paused = false;
    this.attachKeys();
    this.play();
  }

  private collectBlocks() {
    if (!this.container) return;
    const cands = Array.from(
      this.container.querySelectorAll("p,li,h1,h2,h3,h4,blockquote"),
    ) as HTMLElement[];
    const set = new Set(cands);
    this.blocks = cands.filter((el) => {
      if (!el.innerText.trim()) return false;
      // los code blocks no se leen (ni sus hijos)
      if (el.closest("pre")) return false;
      // el bloque de fuentes ("Sources: …" / "Fuentes: …") es ruido en voz
      if (/^\s*(sources|fuentes)\s*:/i.test(el.innerText)) return false;
      for (const d of Array.from(el.querySelectorAll("p,li,h1,h2,h3,h4,blockquote")))
        if (set.has(d as HTMLElement)) return false;
      return true;
    });
    this.clearTaps();
    this.blocks.forEach((el, i) => {
      el.style.cursor = "pointer";
      const h = () => {
        const sel = window.getSelection();
        if (sel && sel.type === "Range" && sel.toString().trim()) return;
        this.jumpTo(i);
      };
      el.addEventListener("click", h);
      this.tapHandlers.push(() => el.removeEventListener("click", h));
    });
  }
  private clearTaps() {
    this.tapHandlers.forEach((r) => r());
    this.tapHandlers = [];
    this.blocks.forEach((el) => (el.style.cursor = ""));
  }

  // Espacio = pausa/reanuda · ←/→ = parrafo ant/sig. Solo si el foco NO esta
  // en un input/textarea (la terminal escribe en un textarea oculto: protegida).
  private keyHandler = (e: KeyboardEvent) => {
    if (!this.curId) return;
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
    if (e.code === "Space") {
      e.preventDefault();
      this.pauseResume();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      this.next();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      this.prev();
    }
  };
  private attachKeys() {
    window.addEventListener("keydown", this.keyHandler);
  }
  private detachKeys() {
    window.removeEventListener("keydown", this.keyHandler);
  }

  private currentVoice(): SpeechSynthesisVoice | null {
    if (!this.synth) return null;
    const es = this.synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith("es"));
    const local = es.filter((v) => v.localService);
    const pool = local.length ? local : es;
    const enh = (v: SpeechSynthesisVoice) => /(enhanced|mejorad|premium|siri|neural)/i.test(v.name);
    // SOLO fijar voz si aparece JUAN por nombre; si no (WKWebView no expone las
    // mejoradas), devolver null y suena la default del sistema. NUNCA forzar otra.
    return (
      pool.find((v) => /Juan/i.test(v.name) && enh(v)) ||
      pool.find((v) => /Juan/i.test(v.name)) ||
      null
    );
  }

  // Une fragmentos cuando el punto NO cierra frase: abreviaturas, iniciales
  // y decimales/paginas ("p. 217"). Sin esto el resaltado se desincroniza.
  private static ABBR_END =
    /(?:\b(?:pp?|p[aá]gs?|caps?|figs?|n[uú]m|nro|vols?|eds?|op|cit|arts?|Dr|Dra|Sr|Sra|Srta|Prof|Ing|Lic|Gral|Av|etc|vs|Ej|ej|ss)|\b[\p{Lu}])\.[\s"»”’)\]]*$/u;
  private static NUM_END = /\d\.[\s"»”’)\]]*$/;
  private static NUM_START = /^[\s"«“(]*\d/;

  private sentencesOf(el: HTMLElement) {
    const text = el.textContent || "";
    const raw = text.match(/[^.!?…]+[.!?…]+[\s"»”’)\]]*|[^.!?…]+$/g) || [text];
    const C = ReaderSpeechController;
    const parts: string[] = [];
    for (const seg of raw) {
      const prev = parts.length ? parts[parts.length - 1] : null;
      if (prev != null && (C.ABBR_END.test(prev) || (C.NUM_END.test(prev) && C.NUM_START.test(seg)))) {
        parts[parts.length - 1] = prev + seg;
      } else {
        parts.push(seg);
      }
    }
    const out: Array<{ text: string; start: number; end: number }> = [];
    let pos = 0;
    for (const p of parts) {
      const rawStart = text.indexOf(p, pos);
      pos = rawStart + p.length;
      const lead = p.length - p.trimStart().length;
      const t = p.trim();
      out.push({ text: t, start: rawStart + lead, end: rawStart + lead + t.length });
    }
    return out.filter((s) => s.text.length);
  }

  // Resaltado por CAJAS OVERLAY (divs absolutos posicionados con los rects de
  // la Range), NO por la Highlight API: WKWebView es caprichoso pintandola
  // (user-select, snapshots que no la componen) y una caja real se ve SIEMPRE,
  // en pantalla y en cualquier captura. Las cajas viven dentro del container
  // (position:relative) asi scrollean con el contenido.
  private hlBoxes: HTMLDivElement[] = [];
  private highlightWord(el: HTMLElement, start: number, end: number) {
    if (!this.container) return;
    try {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      let off = 0;
      const range = document.createRange();
      let s = false;
      let e = false;
      while ((node = walker.nextNode())) {
        const len = node.textContent?.length || 0;
        if (!s && off + len > start) {
          range.setStart(node, start - off);
          s = true;
        }
        if (s && off + len >= end) {
          range.setEnd(node, Math.min(end - off, len));
          e = true;
          break;
        }
        off += len;
      }
      if (!s || !e) return;
      this.clearHighlight();
      const host = this.container;
      const hostRect = host.getBoundingClientRect();
      for (const r of Array.from(range.getClientRects())) {
        if (!r.width || !r.height) continue;
        const box = document.createElement("div");
        box.className = "reader-wordhl";
        Object.assign(box.style, {
          left: `${r.left - hostRect.left}px`,
          top: `${r.top - hostRect.top}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        });
        host.appendChild(box);
        this.hlBoxes.push(box);
      }
    } catch { /* cosmetico */ }
  }
  private clearHighlight() {
    this.hlBoxes.forEach((b) => b.remove());
    this.hlBoxes = [];
  }

  /** Ancla "estas aqui": primera palabra HABLADA del bloque, pintada al entrar,
   *  ANTES de la voz. No depende de que llegue ningun boundary. */
  private markBlockStart() {
    const el = this.blocks[this.idx];
    if (!el) return;
    const text = el.textContent || "";
    const { spoken, map } = buildSpoken(text);
    const m = /\S+/.exec(spoken);
    if (!m) return;
    const from = m.index;
    const to = from + m[0].length;
    const vFrom = map[from];
    if (vFrom == null) return;
    this.highlightWord(el, vFrom, (map[to - 1] ?? vFrom) + 1);
  }

  private speakBlock() {
    if (!this.synth) return;
    const el = this.blocks[this.idx];
    if (!el) return this.stop();
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    this.markBlockStart();
    this.emit();
    const sents = this.sentencesOf(el);
    let si = 0;
    const next = () => {
      if (!this.playing) return;
      if (si >= sents.length) {
        if (this.idx < this.blocks.length - 1) {
          this.idx++;
          this.speakBlock();
        } else this.stop();
        return;
      }
      const s = sents[si++];
      // guard de staleness: un boundary/onend de una utterance vieja se ignora
      const seq = ++this.uttSeq;
      const { spoken, map } = buildSpoken(s.text);
      if (!spoken.trim()) return next();
      const u = new SpeechSynthesisUtterance(spoken);
      const v = this.currentVoice();
      if (v) {
        u.voice = v;
        u.lang = v.lang;
      } else u.lang = "es-MX";
      u.rate = RATES[this.rateIdx];
      const words: Array<{ from: number; to: number }> = [];
      const wre = /\S+/g;
      let wm: RegExpExecArray | null;
      while ((wm = wre.exec(spoken))) words.push({ from: wm.index, to: wm.index + wm[0].length });

      const pintaPalabra = (w: { from: number; to: number }) => {
        const vFrom = map[w.from];
        if (vFrom == null) return;
        this.highlightWord(el, s.start + vFrom, s.start + (map[w.to - 1] ?? vFrom) + 1);
      };

      u.onboundary = (ev) => {
        if (seq !== this.uttSeq) return;
        if (ev.name && ev.name !== "word") return;
        this.gotBoundary = true; // la plataforma si habla: el reloj se apaga
        const m = /\S+/.exec(spoken.slice(ev.charIndex));
        if (!m) return;
        pintaPalabra({ from: ev.charIndex + m.index, to: ev.charIndex + m.index + m[0].length });
      };
      u.onend = () => {
        if (seq !== this.uttSeq) return;
        this.uttSeq++;
        this.clearClock();
        next();
      };
      u.onerror = () => {
        if (seq !== this.uttSeq) return;
        this.uttSeq++;
        this.clearClock();
        // sin metralleta: un synth caido dispara onerror INSTANTANEO por
        // utterance y sin esta pausa se quema el documento entero en <1s
        setTimeout(next, 150);
      };
      this.synth!.speak(u);
      this.armClock(seq, spoken, words, pintaPalabra, next);
    };
    next();
  }

  // ---- El reloj propio ----
  // WKWebView: la voz suena pero boundary/onend NO llegan. El reloj es el piso
  // comun: si los boundaries llegan, manda la plataforma; si no, el reloj mueve
  // el resaltado y destraba la lectura al final de cada frase.
  private clockWord: ReturnType<typeof setInterval> | null = null;
  private clockEnd: ReturnType<typeof setTimeout> | null = null;
  private gotBoundary = false;

  private clearClock() {
    if (this.clockWord) {
      clearInterval(this.clockWord);
      this.clockWord = null;
    }
    if (this.clockEnd) {
      clearTimeout(this.clockEnd);
      this.clockEnd = null;
    }
  }

  /** Duracion hablada estimada (ms). Español ≈ 14 chars/seg a velocidad 1. */
  private estimateMs(text: string) {
    return Math.max(600, (text.length / (14 * RATES[this.rateIdx])) * 1000);
  }

  private armClock(
    seq: number,
    spoken: string,
    words: Array<{ from: number; to: number }>,
    pinta: (w: { from: number; to: number }) => void,
    next: () => void,
  ) {
    this.clearClock();
    this.gotBoundary = false;
    const total = this.estimateMs(spoken);

    // 1) resaltado por reloj: solo si la plataforma no dio señales de vida
    const porPalabra = Math.max(90, total / Math.max(words.length, 1));
    let wi = 0;
    this.clockWord = setInterval(() => {
      if (seq !== this.uttSeq || this.paused) return;
      if (this.gotBoundary) {
        if (this.clockWord) clearInterval(this.clockWord);
        this.clockWord = null;
        return;
      }
      if (wi >= words.length) return;
      pinta(words[wi++]);
    }, porPalabra);

    // 2) destrabe: avanza cuando la voz YA callo y onend nunca llego
    const inicio = performance.now();
    const vigila = (espera: number) => {
      this.clockEnd = setTimeout(() => {
        if (seq !== this.uttSeq) return;
        if (this.paused) return vigila(600);
        const colgada = performance.now() - inicio > total * 3 + 5000;
        if (this.synth?.speaking && !colgada) return vigila(600);
        if (colgada) this.synth?.cancel();
        this.uttSeq++;
        this.clearClock();
        next();
      }, espera);
    };
    vigila(total + 900);
  }

  /** Cancela lo que suena y arranca el bloque actual con un tick de aire:
   *  cancel() es asincrono en WebKit y se traga la utterance del mismo tick. */
  private cancelAndSpeak() {
    if (!this.synth) return;
    this.uttSeq++;
    this.clearClock();
    this.synth.cancel();
    // nudge anti-wedge de WebKit: un paused fantasma tras una tormenta de
    // cancel() deja el queue muerto y toda utterance nueva muere en onerror.
    // resume() sin nada sonando es no-op; con el flag atorado, lo destraba.
    this.synth.resume();
    if (this.speakTimer) clearTimeout(this.speakTimer);
    this.speakTimer = setTimeout(() => {
      this.speakTimer = null;
      if (this.playing && !this.paused && this.curId) this.speakBlock();
    }, 60);
  }

  private play() {
    if (!this.synth || this.playing) return;
    this.playing = true;
    this.paused = false;
    this.markBlockStart();
    this.cancelAndSpeak();
    this.emit();
  }

  // ---- controles de la barra ----
  pauseResume() {
    if (!this.synth || !this.curId) return;
    if (this.paused) {
      this.paused = false;
      if (this.synth.paused && this.synth.speaking) {
        this.synth.resume();
      } else {
        if (!this.playing) this.playing = true;
        this.cancelAndSpeak();
      }
    } else {
      this.paused = true;
      this.synth.pause();
    }
    // En pausa NO se limpia el resaltado: el ancla es el "estas aqui".
    this.emit();
  }
  prev() {
    this.jump(this.idx - 1);
  }
  next() {
    this.jump(this.idx + 1);
  }
  cycleRate() {
    this.rateIdx = (this.rateIdx + 1) % RATES.length;
    this.emit();
    // solo re-arrancar si REALMENTE esta sonando (en pausa solo memoriza)
    if (this.playing && !this.paused && this.curId) this.cancelAndSpeak();
  }

  /** Tap/click en un parrafo: SIEMPRE leer desde ahi (aunque este en pausa). */
  private jumpTo(i: number) {
    if (!this.blocks.length || !this.synth) return;
    this.idx = Math.max(0, Math.min(this.blocks.length - 1, i));
    this.paused = false;
    if (!this.playing) this.playing = true;
    this.markBlockStart();
    this.cancelAndSpeak();
    this.emit();
  }

  private jump(i: number) {
    if (!this.blocks.length || !this.synth) return;
    this.idx = Math.max(0, Math.min(this.blocks.length - 1, i));
    if (this.paused) {
      // navegar SIN reproducir: el ancla se muda al parrafo nuevo
      this.uttSeq++;
      this.clearClock();
      this.synth.cancel();
      if (this.speakTimer) {
        clearTimeout(this.speakTimer);
        this.speakTimer = null;
      }
      this.playing = false;
      this.markBlockStart();
      this.blocks[this.idx]?.scrollIntoView({ behavior: "smooth", block: "center" });
      this.emit();
      return;
    }
    if (!this.playing) this.playing = true;
    this.markBlockStart();
    this.cancelAndSpeak();
    this.emit();
  }

  stop() {
    this.playing = false;
    this.paused = false;
    if (this.synth) this.synth.cancel();
    this.clearHighlight();
    this.clearClock();
    this.uttSeq++;
    if (this.speakTimer) {
      clearTimeout(this.speakTimer);
      this.speakTimer = null;
    }
    this.clearTaps();
    this.detachKeys();
    this.container = null;
    this.blocks = [];
    this.curId = null;
    this.emit();
  }
}

export const readerSpeech = new ReaderSpeechController();

// expuesto para el harness E2E y para operar la lectura desde el gate
(window as unknown as Record<string, unknown>).__readerSpeech = readerSpeech;
