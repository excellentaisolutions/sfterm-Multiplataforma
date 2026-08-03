import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useStore, panelTitle } from "../core/store";
import * as actions from "../core/actions";
import * as ipc from "../core/ipc";
import { claudeResumeCommand } from "../core/shell-command";
import { pathBasename } from "../core/path-utils";
import * as drafts from "../core/drafts";
import { cachedImage, cachedLocalImage, lightbox, localImage, transcriptImage } from "../core/images";
import { manager } from "../core/term";
import { leafOfTerm } from "../core/tiling";
import { msgMarkdown, modelPretty, type ChatMsg, type MsgImage, type ToolPart } from "../core/msgs";
import { renderMarkdown, handleDocClick } from "../core/md";
import { parseProviderTranscript, readTail, type ParsedTranscript } from "../core/transcript";
import { profileForScreen, screenGhost } from "../core/screen";
import { readerSpeech } from "../core/reader-speech";
import { parseDroppedPaths } from "../core/types";
import Lightbox from "./Lightbox";
import SpeechBar from "./SpeechBar";
import { HtmlFence, MermaidFence, hasRichFences, splitRich } from "./RichFences";

/** LECTOR de conversacion (⌃Tab / ⌘L, modo Terminales) — extraido del chat
 *  nativo en la purga del 21 jul. La conversacion de UNA terminal con cara
 *  de chat: tipografia editorial, markdown rico, tool calls expandibles,
 *  escuchar por mensaje con resaltado. Leer: tail + parse del transcript por
 *  poll (la sesion en disco ES la verdad). Escribir: claude VIVO en esa
 *  terminal → directo a SU PTY (mismo proceso, misma sesion); dormida →
 *  claude --resume <sid> AHI mismo. No existe "adoptar al chat": la terminal
 *  es la unica dueña de la conversacion.
 *
 *  Este modulo tambien es la CASA de las piezas de render de mensaje
 *  (Message, ToolBlock, TypingLine…). Las reusaba el vistazo ⌥Tab, que
 *  murio el 29 jul (⌥Tab hoy cicla terminales); siguen aparte porque son
 *  el vocabulario de render de una conversacion, no del lector. */

/* ── iconos inline (trazo estilo lucide, sin dependencia) ─────────────────── */
const svgProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
const IconCopy = () => (
  <svg width={16} height={16} {...svgProps}>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </svg>
);
const IconCheck = () => (
  <svg width={16} height={16} {...svgProps}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);
const IconVolume = () => (
  <svg width={16} height={16} {...svgProps}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);
const IconStopSq = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
    <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
  </svg>
);
const IconArrowUp = () => (
  <svg width={19} height={19} {...svgProps} strokeWidth={2.5}>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </svg>
);
const IconClip = () => (
  <svg width={16} height={16} {...svgProps}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);

/** El textarea del input crece con el contenido (1 linea → max 200px). */
/** Regla horizontal con la que el TUI de claude CIERRA su caja de input.
 *  Verificado contra la pantalla real (gate `read`, 22 jul 2026):
 *      ───────────────────────────────
 *      ❯ texto tecleado que se envuelve
 *        en varios renglones
 *      ───────────────────────────────
 *        main ✗ │ Opus 4.8 │ ◕ 54% │ ⚡ xhigh   */
const TUI_RULE = /^[─—_-]{4,}\s*$/;

/** Extrae el texto YA tecleado (y no enviado) del input del TUI de claude a
 *  partir del tail de la pantalla.
 *
 *  Devuelve:
 *    `string` no vacio — el borrador (adoptarlo y limpiar el TUI)
 *    `""`              — la caja existe y esta VACIA (nada que adoptar, pero
 *                        sabemos que el TUI no guarda nada: el composer puede
 *                        quedarse con el borrador sin riesgo de duplicar)
 *    `null`            — no se pudo determinar: NO tocar nada
 *
 *  Anclas: la linea del input vive en col 0 ("❯ texto"); las continuaciones
 *  van con sangria colgante de 2 espacios y la caja CIERRA con la regla
 *  ─────. Los carets de MENUS van indentados (" ❯ 1. Yes…") y no matchean.
 *
 *  ⚠️ Antes esto abandonaba el borrador ENTERO en cuanto ocupaba dos renglones
 *  ("multi-linea: ambiguo con el wrap"), que es justo lo que le pasaba a
 *  Daniel al cambiar de vista. Con la regla de cierre como ancla, recolectar
 *  las continuaciones es DETERMINISTA — no hay que adivinar donde termina. */
export function parseTuiDraft(tail: string): string | null {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    // el espacio es opcional: la caja vacia se pinta como "❯" pelado, y
    // reconocerla IMPORTA (si no, el scan seguiria hacia arriba y podria
    // adoptar un "❯ …" viejo del scrollback como si fuera el input)
    const m = /^❯ ?(.*)$/.exec(lines[i]);
    if (!m) continue;
    const first = m[1].trim();
    if (!first) return ""; // caja vacia: el TUI no guarda nada
    // placeholder del propio TUI, o un menu abierto: no es un borrador
    if (/^Try ["“«]/.test(first) || /^\d+[.)]\s/.test(first)) return null;
    const parts = [first];
    for (let j = i + 1; j < lines.length; j++) {
      if (TUI_RULE.test(lines[j])) return parts.join(" "); // cierre: listo
      const cont = /^ {1,4}(\S.*)$/.exec(lines[j]);
      if (!cont) return null; // algo que no entendemos debajo del input
      if (/^[❯>]?\s*\d+[.)]\s/.test(cont[1])) return null; // menu de opciones
      parts.push(cont[1].trim());
    }
    return null; // nunca vimos el cierre: no arriesgar
  }
  return null;
}

/** El textarea crece con el contenido. El tope es RELATIVO al panel (45% de su
 *  alto), no los 200px fijos de antes — reporte de Daniel (26 jul 2026): "no me
 *  gusta que solo se ven como dos renglones aunque el texto sea muy largo".
 *  200px eran ~8 renglones en un panel grande y bastante menos con la barra de
 *  chips encima; un parrafo quedaba cortado sin manera de verlo entero.
 *  Pasado el tope el textarea scrollea por dentro (styles.css .chat-input), que
 *  es lo que hace cualquier composer decente en vez de comerse la pantalla. */
export function autoGrow(el: HTMLTextAreaElement) {
  const host = el.closest(".reader-back") as HTMLElement | null;
  const room = host?.clientHeight || window.innerHeight;
  const max = Math.max(120, Math.round(room * 0.45));
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}

/** Texto puesto POR CODIGO (adoptar el borrador del TUI o restaurar el guardado):
 *  el caret va al final y la vista al final. Sin esto, un borrador largo abre
 *  mostrando su PRIMER renglon y con el cursor en la posicion 0 — escribes y el
 *  texto se te mete al principio de lo que ya habias dictado. Tecleando no hace
 *  falta: el navegador ya sigue al caret. */
function caretToEnd(el: HTMLTextAreaElement) {
  const n = el.value.length;
  el.setSelectionRange(n, n);
  el.scrollTop = el.scrollHeight;
}

/** Ruta del transcript que se esta espejando. Va por contexto y no por props
 *  porque quien la necesita es un thumbnail enterrado dentro de un mensaje, y
 *  un consumidor de estas piezas puede no tenerla. Sin contexto, las imagenes
 *  del historial simplemente no se piden — no se rompe nada. */
const TranscriptPath = createContext<string | null>(null);

/* adjunto: las imagenes se pintan como THUMBNAIL real, el resto como chip
   con nombre. Click: una IMAGEN abre el visor flotante (Esc cierra); lo demas
   abre en el visor del taller, que es donde se lee de verdad.

   ⚠️ Los bytes vienen por COMANDO (images.localImage → attach.rs), no por el
   asset protocol. La v1 usaba `convertFileSrc` y Daniel reporto el 27 jul que
   no veia NINGUNA imagen: cuando ese protocolo no entrega, el <img> dispara
   onError y el thumbnail se degrada al chip de texto sin decir por que. Con el
   comando, o llega el data URI o llega un error legible, y ademas el visor
   ampliado reusa exactamente el mismo blob cacheado. */
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|heic|svg)$/i;
export function AttachView({ path, onRemove }: { path: string; onRemove?: () => void }) {
  const [broken, setBroken] = useState(false);
  const esImg = IMG_EXT.test(path);
  const [src, setSrc] = useState<string | null>(() => (esImg ? cachedLocalImage(path) ?? null : null));
  useEffect(() => {
    if (!esImg || src || broken) return;
    let dead = false;
    localImage(path)
      .then((uri) => !dead && setSrc(uri))
      .catch(() => !dead && setBroken(true));
    return () => {
      dead = true;
    };
  }, [path, esImg, src, broken]);
  const isImg = esImg && !broken;
  const openIt = () => {
    // sin bytes todavia no hay nada que ampliar: el visor de archivos del
    // taller siempre puede con el (y ahi ademas se ve la ruta)
    if (isImg && src) lightbox.open({ src, alt: pathBasename(path), path });
    else void actions.openViewer(path);
  };
  if (isImg) {
    return (
      <span
        className="chat-attach-thumb"
        role="button"
        title={`${path} — click: ampliar`}
        onClick={openIt}
      >
        {src ? (
          <img src={src} alt={pathBasename(path)} onError={() => setBroken(true)} />
        ) : (
          <span className="chat-attach-thumb-load" />
        )}
        {onRemove && (
          <button
            className="chat-attach-thumb-x"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title="Quitar adjunto"
          >
            ✕
          </button>
        )}
      </span>
    );
  }
  return (
    <span
      className={`chat-attach-chip${onRemove ? "" : " sent"}`}
      role="button"
      title={`${path} — click: abrir`}
      onClick={openIt}
    >
      {pathBasename(path)}
      {onRemove && (
        <button
          className="chat-attach-x"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="Quitar adjunto"
        >
          ✕
        </button>
      )}
    </span>
  );
}

/** Una imagen que vive DENTRO del transcript (la que Daniel pego en el TUI con
 *  ^V). readTail stripeo su base64 en el shell, asi que aqui solo hay una
 *  referencia (uuid + indice) y los bytes se piden bajo demanda.
 *
 *  Carga PEREZOSA por IntersectionObserver: una sesion vieja puede traer
 *  decenas de capturas de MBs y pedirlas todas al abrir el lector seria pagar
 *  por lo que nadie mira. Se piden cuando entran en pantalla, se cachean por
 *  (archivo, mensaje, indice) y el poll de 1.5s ya no las vuelve a pedir. */
function TranscriptImg({ img }: { img: MsgImage }) {
  const path = useContext(TranscriptPath);
  const [src, setSrc] = useState<string | null>(() =>
    path ? (cachedImage(path, img.uuid, img.index) ?? null) : null,
  );
  const [err, setErr] = useState(false);
  const hostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (src || err || !path) return;
    const el = hostRef.current;
    if (!el) return;
    let dead = false;
    const pedir = () => {
      transcriptImage(path, img.uuid, img.index)
        .then((uri) => {
          if (!dead) setSrc(uri);
        })
        .catch(() => {
          if (!dead) setErr(true);
        });
    };
    // rootMargin: empezar a traerla un poco antes de que asome
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          pedir();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => {
      dead = true;
      io.disconnect();
    };
  }, [src, err, path, img.uuid, img.index]);

  const abrir = () => {
    if (!src) return;
    lightbox.open({ src, alt: `imagen ${img.mediaType.replace("image/", "")}` });
  };

  return (
    <span
      ref={hostRef}
      className={`chat-attach-thumb tx${src ? "" : " loading"}`}
      role="button"
      title={src ? "Click: ver en grande" : err ? "no se pudo leer del transcript" : "cargando…"}
      onClick={abrir}
    >
      {src ? (
        <img src={src} alt="" />
      ) : (
        <span className="chat-img-ph">{err ? "🖼 ✕" : "🖼"}</span>
      )}
    </span>
  );
}

/** Fila de imagenes del transcript (mensaje o tool_result). */
function TranscriptImgRow({ images }: { images: MsgImage[] }) {
  if (!images.length) return null;
  return (
    <div className="chat-attach-row">
      {images.map((im) => (
        <TranscriptImg key={`${im.uuid}:${im.index}`} img={im} />
      ))}
    </div>
  );
}

/** Un tramo de markdown ya cerrado o en streaming. memo por texto. */
const MdPart = memo(
  function MdPart({ text }: { text: string }) {
    return (
      <div
        className="reader-doc chat-doc"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
      />
    );
  },
  (a, b) => a.text === b.text,
);

/** Prosa con FENCES VIVOS (21 jul, port de Arbrain): los bloques ```html y
 *  ```mermaid del mensaje se renderizan (iframe sandbox / diagrama) en vez
 *  de quedar como codigo muerto. Sin fences → MdPart directo, cero costo. */
const RichText = memo(
  function RichText({ text }: { text: string }) {
    if (!hasRichFences(text)) return <MdPart text={text} />;
    return (
      <>
        {splitRich(text).map((s, i) =>
          s.kind === "md" ? (
            <MdPart key={`m${i}`} text={s.text} />
          ) : s.kind === "html" ? (
            <HtmlFence key={`h${i}`} code={s.text} />
          ) : (
            <MermaidFence key={`d${i}`} code={s.text} />
          ),
        )}
      </>
    );
  },
  (a, b) => a.text === b.text,
);

/** Si el tool call edito/escribio un archivo, el path para el chip "ver diff"
 *  (el diff se abre en el taller). */
function toolDiffPath(part: ToolPart): string | null {
  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(part.name)) return null;
  if (part.input) {
    try {
      const p = (JSON.parse(part.input) as { file_path?: unknown }).file_path;
      if (typeof p === "string" && p.startsWith("/")) return p;
    } catch { /* input parcial: sin chip */ }
  }
  const s = (part.summary ?? "").split(/\s/)[0];
  return s.startsWith("/") ? s : null;
}

/** Un tool call: header de una linea (nombre + resumen) que expande al
 *  detalle (input JSON + output). Los <pre> internos NO los lee el TTS. */
const ToolBlock = memo(
  function ToolBlock({ part, streaming }: { part: ToolPart; streaming?: boolean }) {
    const [open, setOpen] = useState(false);
    const running = !!streaming && part.output == null;
    const dot = running ? "run" : part.isError ? "err" : "ok";
    const diffPath = toolDiffPath(part);
    return (
      <div className={`chat-tool${open ? " open" : ""}`}>
        <div className="chat-tool-head" role="button" onClick={() => setOpen(!open)} title={part.name}>
          <span className={`chat-tool-dot ${dot}`} />
          <span className="chat-tool-name">{part.name}</span>
          {part.summary && <span className="chat-tool-sum">{part.summary}</span>}
          {diffPath && (
            <button
              className="chat-tool-diff"
              title="Ver el diff de este archivo en el taller"
              onClick={(e) => {
                e.stopPropagation();
                actions.openFileTab(diffPath, "diff");
              }}
            >
              ver diff
            </button>
          )}
          <span className="chat-tool-chev">{open ? "▾" : "▸"}</span>
        </div>
        {open && (
          <div className="chat-tool-detail">
            {part.input && <pre className="chat-tool-pre">{part.input}</pre>}
            {part.output != null && (
              <pre className={`chat-tool-pre out${part.isError ? " err" : ""}`}>
                {part.output.trim() || "(sin output)"}
              </pre>
            )}
            {part.images && <TranscriptImgRow images={part.images} />}
            {part.output == null && !part.input && (
              <pre className="chat-tool-pre out">{running ? "corriendo…" : "(sin detalle)"}</pre>
            )}
          </div>
        )}
      </div>
    );
  },
  (a, b) => a.part === b.part && (!!a.streaming === !!b.streaming || a.part.output != null),
);

/** Boton copiar con check verde 2s. */
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`chat-actbtn ${copied ? "ok" : ""}`}
      title="Copiar mensaje"
      aria-label="Copiar mensaje"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

/** Acciones al pie de un mensaje del asistente: escuchar + copiar. */
function MsgActions({ msg }: { msg: ChatMsg }) {
  useSyncExternalStore(
    (cb) => readerSpeech.subscribe(cb),
    () => readerSpeech.getState(),
    () => readerSpeech.getState(),
  );
  const key = `chat:${msg.id}`;
  const listening = readerSpeech.isActive(key);
  return (
    <div className="chat-actions">
      <button
        className={`chat-actbtn ${listening ? "on" : ""}`}
        title={listening ? "Detener lectura" : "Escuchar (voz del sistema)"}
        aria-label={listening ? "Detener lectura" : "Escuchar mensaje"}
        onClick={(e) => {
          const host = (e.currentTarget as HTMLElement)
            .closest(".chat-assistant")
            ?.querySelector(".chat-body") as HTMLElement | null;
          if (host) readerSpeech.toggle(key, host);
        }}
      >
        {listening ? <IconStopSq /> : <IconVolume />}
      </button>
      <CopyBtn text={msgMarkdown(msg)} />
    </div>
  );
}

/** Un mensaje. memo por identidad: los patches son inmutables, un mensaje
 *  viejo conserva su objeto y React lo salta entero. */
export const Message = memo(
  function Message({ msg }: { msg: ChatMsg }) {
    if (msg.sys) {
      return <div className="chat-sysline">{msg.text}</div>;
    }
    if (msg.role === "user") {
      return (
        <div className="chat-user">
          <div className="chat-user-col">
            <div className="chat-user-bubble">
              {msg.text}
              {msg.attachments && (
                <div className="chat-attach-row">
                  {msg.attachments.map((p) => (
                    <AttachView key={p} path={p} />
                  ))}
                </div>
              )}
              {msg.images && <TranscriptImgRow images={msg.images} />}
            </div>
            <div className="chat-actions user">
              <CopyBtn text={msg.text} />
            </div>
          </div>
        </div>
      );
    }
    const parts = msg.parts?.length
      ? msg.parts
      : msg.text
        ? [{ type: "text" as const, text: msg.text }]
        : [];
    const hasText = msgMarkdown(msg).trim().length > 0;
    if (msg.streaming && !parts.length && !hasText && !msg.error) return null;
    return (
      <div className="chat-assistant">
        <div className="chat-body">
          {parts.map((p, i) =>
            p.type === "text" ? (
              p.text.trim() ? <RichText key={`t${i}`} text={p.text} /> : null
            ) : (
              <ToolBlock key={p.toolId || `k${i}`} part={p} streaming={msg.streaming} />
            ),
          )}
        </div>
        {msg.error && <div className="chat-error">⚠ {msg.error}</div>}
        {!msg.streaming && hasText && <MsgActions msg={msg} />}
      </div>
    );
  },
  (a, b) => a.msg === b.msg,
);

/** Duracion estilo spinner de la TUI: 42s · 2m 32s · 1h 05m. */
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function fmtTok(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

export function TypingLine({
  state,
  startedAt,
  sinceAt,
  tokens,
}: {
  state: "working" | "asking";
  startedAt?: number;
  sinceAt?: number;
  tokens?: number;
}) {
  const now = Date.now();
  const segs: string[] = [];
  if (state === "working") {
    segs.push("escribiendo…");
    if (startedAt) segs.push(fmtDur(now - startedAt));
    if (tokens) segs.push(`↓ ${fmtTok(tokens)} tokens`);
  } else {
    segs.push("esperando tu respuesta");
    if (sinceAt) segs.push(fmtDur(now - sinceAt));
  }
  return (
    <div className="chat-typing">
      <span className={`conv-status st-${state}`} />
      <span>{segs.join(" · ")}</span>
    </div>
  );
}

/** Barra del composer (recuperada de la purga, 21 jul — pedido de Daniel:
 *  "ver modelo, contexto, rama, esfuerzo"): chips informativos del claude de
 *  ESTA terminal — ⎇ rama del cwd (git poll 15s) · ◔ ctx% · modelo · effort
 *  (todo del transcript, nunca inventado: segmento sin dato no se pinta). */
function ReaderBar({
  cwd,
  data,
  onSend,
  onPick,
}: {
  cwd?: string;
  data: ParsedTranscript | null;
  onSend: () => void;
  onPick?: () => void;
}) {
  const [git, setGit] = useState<{ branch: string; dirty: boolean } | null>(null);
  useEffect(() => {
    let dead = false;
    setGit(null);
    if (!cwd) return;
    const poll = () => {
      ipc
        .gitStatus(cwd)
        .then((g) => {
          if (!dead) setGit(g.is_repo ? { branch: g.branch, dirty: g.changed > 0 } : null);
        })
        .catch(() => {
          if (!dead) setGit(null);
        });
    };
    poll();
    const t = setInterval(poll, 15_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [cwd]);
  const model = data?.model;
  const effort = data?.effort;
  const pct = data?.ctxPct;
  const ctxSymbol = pct == null ? "" : pct >= 75 ? "●" : pct >= 50 ? "◕" : pct >= 25 ? "◑" : "◔";
  return (
    <div className="composer-bar">
      {onPick && (
        <button
          className="cbar-clip"
          onClick={onPick}
          title="Adjuntar imagen (o pégala con ⌘V / arrástrala aquí)"
          aria-label="Adjuntar imagen"
        >
          <IconClip />
        </button>
      )}
      {git && (
        <span
          className={`cbar-chip sl-git ${git.dirty ? "dirty" : "clean"}`}
          title={git.dirty ? "rama con cambios sin commitear" : "rama limpia"}
        >
          ⎇ {git.branch} {git.dirty ? "✗" : "✓"}
        </span>
      )}
      <div className="cbar-spacer" />
      {pct != null && (
        <span className="cbar-chip sl-ctx" title="contexto consumido de la sesión">
          {ctxSymbol} {pct}%
        </span>
      )}
      {model && (
        <span className="cbar-chip sl-model" title={model}>
          {modelPretty(model)}
        </span>
      )}
      {effort && (
        <span className="cbar-chip sl-effort" title="reasoning effort de la sesión">
          {effort}
        </span>
      )}
      <button className="chat-sendbtn" onClick={onSend} title="Enviar (Enter)" aria-label="Enviar mensaje">
        <IconArrowUp />
      </button>
    </div>
  );
}

/** ESPEJO DE PANTALLA (22 jul 2026): la conversacion de un CLI agentico que
 *  NO es Claude Code (kimi, codex, aider…). No hay transcript en disco que
 *  parsear, asi que la verdad es lo que la terminal MUESTRA — la cola del
 *  grid + scrollback que da el engine de Rust, ya sin ANSI.
 *
 *  Se pinta MONOESPACIADO a proposito: es salida de terminal, con su
 *  alineacion y sus cajas de TUI. Meterla en la tipografia editorial del
 *  lector la rompe. Lo que gana igual: leerla comoda en el ancho del panel,
 *  seleccionarla, y sobre todo la barra de abajo para responder. */
const ScreenMirror = memo(
  function ScreenMirror({ text }: { text: string | null }) {
    if (text == null) return <div className="reader-empty">leyendo la terminal…</div>;
    const body = text.replace(/\s+$/, "");
    if (!body) return <div className="reader-empty">esta terminal todavía no muestra nada</div>;
    return <pre className="screen-mirror">{body}</pre>;
  },
  (a, b) => a.text === b.text,
);

/** EL ADELANTO (28 jul 2026): el bloque que el agente esta escribiendo AHORA,
 *  leido de la PANTALLA mientras el transcript todavia no lo tiene.
 *
 *  Va con la MISMA piel que un mensaje real (`.chat-assistant` + `MdPart`) a
 *  proposito: cuando la linea del jsonl aterriza y el fantasma se retira, no
 *  hay flash de estilo — solo el markdown definitivo ocupando su lugar. Lo
 *  unico que lo distingue es el cursor que parpadea al final (CSS).
 *
 *  ⚠️ `MdPart` y NO `RichText`: un fence ```html a medio escribir montaria y
 *  desmontaria un iframe cada 200ms. Los fences vivos son cosa del mensaje
 *  final, que es el que de verdad esta cerrado. */
const GhostBlock = memo(
  function GhostBlock({ text }: { text: string }) {
    return (
      <div className="chat-assistant ghost">
        <div className="chat-body">
          <MdPart text={text} />
        </div>
      </div>
    );
  },
  (a, b) => a.text === b.text,
);

interface PanelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

const MIN_BOX = 160; // menos que esto no es un panel usable: caer al fallback

/** Pulso del ADELANTO. 200ms porque `engine_text` es un grid EN MEMORIA (no
 *  toca disco ni shell): el poll caro es el del transcript — `tail -c 4MB |
 *  perl` cada 1.5s — y ese no se toca. Solo late mientras hay un turno en
 *  vuelo; con la conversacion quieta no se pide nada. */
const GHOST_MS = 200;
/** Cola de pantalla que se pide. Holgada a proposito: el parser exige VER el
 *  abridor del bloque (⏺) para no pintar un fragmento que arranque a media
 *  palabra, asi que un bloque largo necesita margen. 300 renglones cubren
 *  respuestas enormes y siguen siendo baratos (el grid ya esta en RAM). */
const GHOST_LINES = 300;

/** RECT DEL PANEL (22 jul 2026, pedido de Daniel: "que esa vista SOLO se vea
 *  en el espacio que ocupa la terminal"): el lector deja de tapar la app y
 *  vive DENTRO del panel de su terminal. El taller sigue visible y usable
 *  (rail, arbol, otras terminales); lo que sobre lo esconde Daniel a mano
 *  con ⌘B (arbol) y ⌘⌥B (rail) — la app no decide por el.
 *
 *  Anclaje en cascada: div de la terminal → su leaf-frame
 *  (cuando el tab activo del campo es otro y el div esta oculto) → #center.
 *  Sin rect medible devuelve null y el lector cae a PANTALLA COMPLETA (el
 *  comportamiento viejo: fallback honesto, nunca una caja rota).
 *
 *  Responsivo: ResizeObserver sobre el div de la terminal Y sobre #center
 *  (por ahi pasan los sashes, ⌘B/⌘⌥B y el zoom de app), resize de ventana, y
 *  re-medida cuando cambia el arbol de splits. Las dos re-medidas cortas
 *  cubren el commit de retraso de Tiling (mide #center y RECIEN despues
 *  coloca las terminales). Nada de rAF a proposito: una ventana sin foco no
 *  pinta frames y el callback no correria (leccion 16 jul). */
function usePanelBox(termId: number | undefined, open: boolean): PanelBox | null {
  const treeVersion = useStore((s) => s.treeVersion);
  const railVisible = useStore((s) => s.railVisible);
  const treeVisible = useStore((s) => s.treeVisible);
  const [box, setBox] = useState<PanelBox | null>(null);

  const measure = useCallback(() => {
    if (termId == null) {
      setBox(null);
      return;
    }
    const usable = (r: DOMRect | null | undefined) =>
      r && r.width >= MIN_BOX && r.height >= MIN_BOX ? r : null;
    const div = manager.get(termId)?.div;
    const leaf = leafOfTerm(useStore.getState().root, termId);
    let frame: HTMLElement | null = null;
    if (leaf) {
      for (const el of document.querySelectorAll<HTMLElement>("[data-leaf-id]")) {
        if (el.dataset.leafId === leaf.id) {
          frame = el;
          break;
        }
      }
    }
    const r =
      usable(div && div.style.display !== "none" ? div.getBoundingClientRect() : null) ??
      usable(frame?.getBoundingClientRect()) ??
      usable(document.getElementById("center")?.getBoundingClientRect());
    setBox((prev) => {
      if (!r) return null;
      const next = {
        left: Math.round(r.left),
        top: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
      return prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.width === next.width &&
        prev.height === next.height
        ? prev // misma caja: no re-render (el RO se dispara seguido)
        : next;
    });
  }, [termId]);

  useEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }
    measure();
    const t0 = setTimeout(measure, 0);
    const t1 = setTimeout(measure, 140);
    const ro = new ResizeObserver(() => measure());
    const div = termId != null ? manager.get(termId)?.div : null;
    if (div) ro.observe(div);
    const center = document.getElementById("center");
    if (center) ro.observe(center);
    window.addEventListener("resize", measure);
    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [open, termId, measure, treeVersion, railVisible, treeVisible]);

  return box;
}

/** El LECTOR. Renderiza cuando hay espejo abierto (ui.chat + ui.chatMirror —
 *  los pone el keymap ⌃Tab/⌘L) y se posa DENTRO del panel de su terminal
 *  (usePanelBox); sin rect medible cae a pantalla completa. */
export default function ConvReader() {
  const open = useStore((s) => s.ui.chat);
  const mirror = useStore((s) => s.ui.chatMirror);
  const [data, setData] = useState<ParsedTranscript | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  /** boton "ir al fondo": visible al alejarte >350px del final (29 jul) */
  const [showJump, setShowJump] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panel = useStore((s) => (mirror?.termId != null ? s.panels[mirror.termId] : undefined));
  // ESPEJO DE PANTALLA (22 jul): agente sin transcript conocido (kimi, codex,
  // aider…). No hay sesion en disco que leer — la verdad es lo que la terminal
  // MUESTRA, via el engine (que parsea VT siempre, en ambos renderers).
  const screen = mirror?.src === "screen";
  const claude = !!panel && /claude/i.test(panel.fgName ?? "");
  // "vivo" = se le puede escribir al proceso de esa terminal AHORA. En modo
  // pantalla el agente esta corriendo por definicion (si no, el candado ya
  // habria retirado el lector), asi que el PTY siempre es el destino.
  const live = !!panel && (screen || claude);
  const path = mirror?.path;
  const provider = mirror?.provider ?? "claude";
  const mirrorModel = mirror?.model;
  const termId = mirror?.termId;
  const sid = mirror?.sid;
  const [screenText, setScreenText] = useState<string | null>(null);
  // el lector vive DENTRO del panel de su terminal (null = pantalla completa)
  const box = usePanelBox(termId, open);
  // ADJUNTOS PENDIENTES (26 jul): rutas que viajaran con el proximo mensaje.
  // En estado (no en una ref como el texto) porque pintarlos ES el punto.
  const [attach, setAttach] = useState<string[]>([]);
  // ESPEJO EN MEMORIA del textarea. El textarea es NO CONTROLADO a proposito
  // (tipear no debe re-renderizar la conversacion entera), pero eso dejaba el
  // borrador viviendo SOLO en el nodo del DOM — y React desmonta ese nodo antes
  // de que corra el cleanup que lo salvaba. Esta ref es la copia que sobrevive.
  const textRef = useRef("");
  const attachRef = useRef<string[]>([]);
  attachRef.current = attach;
  // ⚠️ el sid va por REF, JAMAS como dependencia del efecto del borrador: la
  // sesion NACE (path=null → sid) y se RE-DESCUBRE post-despertar, o sea que
  // cambia sola mientras Daniel escribe. Como dep, ese cambio disparaba el
  // cleanup: le vaciaba el textarea y le escupia el parrafo dentro del TUI a
  // media escritura. Aqui solo se usa para la llave de la copia en disco.
  //
  // ⚠️⚠️ Y POR TERMINAL, no "el ultimo sid" (bug del 27 jul: "el texto de una
  // pestaña se propaga a la otra"). Una ref se lee SIEMPRE en su version mas
  // nueva, y el cleanup de este efecto corre DESPUES del render de la terminal
  // a la que te acabas de mover: `termId` ahi es el viejo (viaja en la
  // clausura) pero `sidRef.current` ya era el NUEVO. O sea que al cambiar de
  // pestaña, el borrador de A se guardaba en disco bajo la llave de B, y al
  // entrar a B aparecia el texto de A. La llave y el dueño tienen que salir
  // del MISMO sitio, asi que se recuerda el sid de cada terminal.
  const sidByTerm = useRef(new Map<number, string>());
  if (termId != null && sid) sidByTerm.current.set(termId, sid);
  const sidOf = (t: number | undefined) => (t != null ? sidByTerm.current.get(t) : undefined);
  // el listener de drops del SO se registra una vez: llama al addAttach del
  // ultimo render a traves de esta ref, no al del render en que se registro
  const addAttachRef = useRef<(paths: string[]) => void>(() => {});
  const fileInputRef = useRef<HTMLInputElement>(null);

  // cerrar = volver al taller ATERRIZANDO en su terminal (lee del store al
  // ejecutarse: identidad estable para el listener de Esc)
  const close = () => {
    readerSpeech.stop();
    const tid = useStore.getState().ui.chatMirror?.termId;
    useStore.getState().setUI({ chat: false, chatMirror: null });
    if (tid != null && useStore.getState().panels[tid]) actions.showTerm(tid);
  };

  // SEGUIR AL FOCO (22 jul 2026, pedido de Daniel): el lector dejo de ser "el
  // lector de UNA terminal" y es un MODO. Con el abierto, moverte entre
  // terminales (⌘⌥ flechas, click en el panel, rail, tabs) RE-APUNTA el
  // espejo a la conversacion de la terminal recien enfocada y lo posa en SU
  // panel (usePanelBox sigue a mirror.termId). Mismas condiciones de siempre,
  // porque pasa por la MISMA puerta que ⌃Tab (actions.openReaderFor).
  // Una terminal que NO corre claude retira el lector en vez de mentir sobre
  // que conversacion estas viendo: el teclado queda en la terminal a la que
  // te moviste (showChat(false) enfoca st.focused, que ya es la nueva).
  // Un tab de archivo deja focused=null: el lector se queda donde estaba.
  const focused = useStore((s) => s.focused);
  useEffect(() => {
    if (!open || focused == null || focused === termId) return;
    if (useStore.getState().drawerTerms.includes(focused)) return; // el drawer flota encima
    let dead = false;
    void actions.openReaderFor(focused).then((ok) => {
      if (dead || ok) return;
      readerSpeech.stop();
      actions.showChat(false);
    });
    return () => {
      dead = true;
    };
  }, [open, focused, termId]);

  // RE-DESCUBRIMIENTO post-despertar por VERDAD ESTRICTA: al revivir claude
  // aqui (--resume), su sesion real puede ser OTRO archivo (bifurcacion).
  // term_session decide (nacimiento / argv / titulo) — jamas la rifa por
  // carpeta que robaba el espejo hacia crons (bug UX 20 jul).
  const prevLiveRef = useRef(live);
  useEffect(() => {
    if (live && !prevLiveRef.current && termId != null && mirror) {
      let dead = false;
      void (async () => {
        for (let i = 0; i < 20 && !dead; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const info = await ipc.termSession(termId).catch(() => null);
          if (info && info.sid !== mirror.sid) {
            const cur = useStore.getState().ui.chatMirror;
            if (!cur || cur.termId !== termId) return;
            useStore.getState().setUI({
              chatMirror: {
                ...cur,
                sid: info.sid,
                path: info.path,
                ...(info.config_dir ? { cfg: info.config_dir } : {}),
              },
            });
            return;
          }
          if (info) return; // misma sesion confirmada
        }
      })();
      return () => {
        dead = true;
      };
    }
    prevLiveRef.current = live;
  }, [live, termId, mirror]);

  // WATCHER de sesion-por-nacer (21 jul pm): el lector ya puede abrir con
  // claude vivo y 0 mensajes (path=null — el jsonl no existe todavia). Este
  // pulso pregunta por la verdad hasta que la sesion NACE (primer intercambio)
  // y entonces engancha el espejo. La ruta viene de Rust (bro-aware).
  //
  // AMPLIADO el 27 jul: tambien vuelve a preguntar cuando el espejo YA tiene
  // ruta pero llego VACIO (0 mensajes o error de lectura) sobre una terminal
  // que corre claude. Un espejo en blanco sobre una conversacion viva es
  // SOSPECHA, no verdad: si Rust apunto mal (o apunto a un cascaron), el
  // lector se cura solo en el siguiente pulso en vez de quedarse mintiendo
  // hasta que Daniel cierre y vuelva a abrir.
  const emptyMirror = !!path && !!data && data.msgs.length === 0;
  useEffect(() => {
    if (!open || termId == null) return;
    if (path && !emptyMirror) return;
    let dead = false;
    const t = setInterval(() => {
      void ipc.termSession(termId).then((info) => {
        if (dead || !info) return;
        const cur = useStore.getState().ui.chatMirror;
        if (!cur || cur.termId !== termId) return;
        if (cur.path === info.path) return; // misma verdad: nada que mover
        useStore.getState().setUI({
          chatMirror: {
            ...cur,
            sid: info.sid,
            path: info.path,
            ...(info.config_dir ? { cfg: info.config_dir } : {}),
          },
        });
      });
    }, path ? 3000 : 1500);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [open, path, termId, emptyMirror]);

  // PANTALLA viva por poll (mismo pulso que el transcript). `engine_text` da
  // la cola del grid + scrollback ya sin ANSI: una linea logica por linea.
  useEffect(() => {
    if (!open || !screen || termId == null) return;
    let dead = false;
    setScreenText(null);
    const poll = () =>
      ipc
        .engineText(termId, 2000)
        .then((t) => {
          if (!dead) setScreenText(t);
        })
        .catch(() => {
          if (!dead) setScreenText("");
        });
    void poll();
    const t = setInterval(() => void poll(), 1500);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [open, screen, termId]);

  // transcript vivo por poll (la sesion en disco es la verdad compartida)
  useEffect(() => {
    if (!open || !path) return;
    let dead = false;
    setData(null);
    const poll = () =>
      readTail(path)
        .then((tail) => {
          if (dead) return;
          const p = parseProviderTranscript(provider, tail.content, tail.truncated);
          if (!p.model && mirrorModel) p.model = mirrorModel;
          setData(p);
          // el titlebar vive del titulo del espejo: sembrarlo del transcript
          const cur = useStore.getState().ui.chatMirror;
          if (cur && cur.path === path) {
            const title = p.title ?? cur.title;
            const model = p.model ?? cur.model;
            if (title !== cur.title || model !== cur.model) {
              useStore.getState().setUI({ chatMirror: { ...cur, title, model } });
            }
          }
        })
        .catch((e) => {
          if (!dead) {
            setData({
              msgs: [],
              truncated: false,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        });
    void poll();
    const t = setInterval(() => void poll(), 1500);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [open, path, provider, mirrorModel]);

  // ── EL ADELANTO (28 jul 2026) ────────────────────────────────────────────
  //
  // Daniel manda un mensaje y VE la respuesta escribirse, en vez de esperar a
  // que el bloque entero cierre. Medido sobre una sonda real: entre el prompt
  // y la linea del jsonl pasaron ONCE SEGUNDOS de lector mudo mientras la
  // terminal ya pintaba la respuesta creciendo — Claude Code escribe su
  // transcript por BLOQUE CERRADO, no por token, asi que acelerar el poll del
  // transcript no arregla nada. El stream vive en la PANTALLA (el motor VT de
  // Rust corre siempre en tee) y de ahi se lee.
  //
  // El TRANSCRIPT SIGUE SIENDO LA VERDAD: esto es solo el adelanto del bloque
  // en vuelo y se retira solo en cuanto su linea aterriza (core/screen.ts).
  //
  // ⚠️ El fantasma se calcula EN EL RENDER, no dentro del poll. Si viviera en
  // el efecto, al aterrizar la linea del jsonl habria hasta 200ms pintando el
  // parrafo DOS veces (el real y el fantasma) — el parpadeo que el invariante
  // prohibe. Derivandolo de [cola, transcript] el relevo ocurre en el MISMO
  // render en que llega el transcript: no hay ventana.
  const prof = useMemo(
    () => (screen ? null : profileForScreen(panel?.fgName, panel?.customTitle ?? panel?.title)),
    [screen, panel?.fgName, panel?.customTitle, panel?.title],
  );
  const turnState = data?.turn?.state;
  // "working" rancio (proceso muerto con un tool_use abierto) no debe dejar el
  // poll corriendo para siempre: mismo umbral que la TypingLine
  const turnFresh =
    data?.turn?.lastEventAt != null && Date.now() - data.turn.lastEventAt < 300_000;
  const ghostOn = !!prof && turnState === "working" && turnFresh;
  const [ghostTail, setGhostTail] = useState<string | null>(null);
  useEffect(() => {
    if (!open || termId == null || !ghostOn) {
      setGhostTail(null);
      return;
    }
    let dead = false;
    const poll = () =>
      ipc
        .engineText(termId, GHOST_LINES)
        .then((t) => {
          // sin cambio no hay setState: el poll rapido no debe repintar la
          // conversacion entera cuatro veces por segundo porque si
          if (!dead) setGhostTail((prev) => (prev === t ? prev : t));
        })
        .catch(() => {
          if (!dead) setGhostTail(null);
        });
    void poll();
    const t = setInterval(() => void poll(), GHOST_MS);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [open, termId, ghostOn]);

  // lo que el transcript YA tiene del mensaje en curso: contra esto se decide
  // si el fantasma sigue siendo noticia o ya aterrizo
  const already = useMemo(() => {
    const last = data?.msgs[data.msgs.length - 1];
    return last?.role === "assistant" ? msgMarkdown(last) : "";
  }, [data]);
  const ghost = useMemo(
    () => (prof && ghostOn && ghostTail ? screenGhost(ghostTail, already, prof) : null),
    [prof, ghostOn, ghostTail, already],
  );

  // POSICION DE LECTURA (26 jul 2026, reporte de Daniel: "al cambiarme entre
  // vistas siempre me manda hasta arriba... debería recordar la ubicación
  // exacta en la que me encontraba").
  //
  // Dos bugs distintos, un solo arreglo:
  //
  //   1. "Me manda hasta arriba" — el autoscroll corria UNA vez, cuando
  //      llegaba el primer poll, y ponia scrollTop = scrollHeight con el
  //      contenido a medio pintar. Markdown, fences vivos e imagenes cargan
  //      DESPUES y estiran el documento: quedabas anclado a lo que entonces
  //      era el fondo y ahora es el principio. El ResizeObserver de abajo
  //      re-ancla mientras sigas pegado al fondo, asi que "abajo" es abajo de
  //      verdad aunque el contenido siga creciendo.
  //   2. "Que conserve la posición exacta" — al cerrar el lector o cambiar de
  //      terminal, la posicion se guarda POR TERMINAL y se restaura al volver.
  //      Se guarda como distancia AL FONDO, no desde arriba: el tail recorta
  //      por arriba conforme la sesion crece, asi que medir desde el techo
  //      driftea y medir desde el piso no.
  const scrollMem = useRef(new Map<number, { pinned: boolean; fromBottom: number }>());
  const fromBottomRef = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !open || termId == null) return;
    const saved = scrollMem.current.get(termId);
    // restaurar en cuanto haya contenido que medir (el primer poll ya llego)
    const restore = () => {
      if (!saved || saved.pinned) {
        el.scrollTop = el.scrollHeight;
        pinnedRef.current = true;
        return;
      }
      el.scrollTop = Math.max(0, el.scrollHeight - saved.fromBottom);
      pinnedRef.current = false;
    };
    restore();
    // el contenido sigue creciendo despues del primer frame (markdown, fences
    // vivos, thumbnails): re-anclar mientras el usuario siga al fondo
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight;
    });
    const col = el.querySelector(".reader-col");
    if (col) ro.observe(col);
    const t0 = setTimeout(restore, 60);
    const t1 = setTimeout(restore, 220);
    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      ro.disconnect();
      // ⚠️ la posicion sale de la REF, no del nodo: al CERRAR el lector el
      // scroller ya se desmonto cuando corre este cleanup (misma trampa que
      // se comia el borrador). fromBottomRef lo espeja en cada scroll.
      scrollMem.current.set(termId, {
        pinned: pinnedRef.current,
        fromBottom: fromBottomRef.current,
      });
    };
  }, [open, termId, path]);

  // autoscroll al fondo si el usuario ya estaba al fondo.
  // ⚠️ `ghost` va en las deps a proposito: el adelanto crece cada 200ms y
  // quien esta pegado al fondo tiene que seguir la escritura. Y por el mismo
  // `pinnedRef`, quien scrolleo hacia ARRIBA no se mueve — el fantasma jamas
  // lo arrastra (invariante de la posicion de lectura, 26 jul).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [data?.msgs.length, screenText, ghost]);

  // Esc: cerrar el lector y ATERRIZAR en su terminal (capture, patron Reader).
  // Con el drawer abierto, Esc primero cierra el drawer.
  useEffect(() => {
    if (!open || !mirror) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      const s = useStore.getState();
      if (s.ui.drawer) {
        void actions.toggleDrawer();
        return;
      }
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, mirror?.termId]);

  // al abrir: parar cualquier TTS previo y enfocar el input
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => readerSpeech.stop();
  }, [open, path]);

  // BORRADOR COMPARTIDO taller ⇄ lector (bidireccional, 22 jul 2026 — pedido
  // de Daniel: "si cambio del lector a la terminal conserve, y viceversa").
  // INVARIANTE: UN SOLO dueño del borrador a la vez, nunca en los dos lados.
  //   abrir            → el texto del TUI viaja al composer y el TUI se limpia
  //   cerrar           → el texto del composer vuelve al TUI (sin Enter)
  //   cambiar terminal → se devuelve a la que dejas y se adopta el de la que
  //                      llegas (el cleanup corre con el termId VIEJO)
  //   enviar           → lo consume (send() resetea y suelta la propiedad)
  //
  // `ownsDraft` es el candado del intercambio: solo devolvemos al TUI cuando
  // SABEMOS que quedo vacio (lo limpiamos nosotros, o ya estaba vacio al
  // abrir). Si el parser no entendio la pantalla, el TUI conserva su texto y
  // no escribimos nada encima — jamas concatenamos dos borradores.
  //
  // ⚠️ BLINDAJE (26 jul 2026, bug reportado por Daniel: "escribo un parrafo,
  // me paso al taller y lo perdi para siempre"). El mecanismo de arriba tenia
  // DOS fugas y las dos terminaban en texto destruido:
  //
  //   1. Al CERRAR el lector, el componente hace `return null` → React
  //      desmonta el textarea y pone `inputRef.current = null` en la fase de
  //      mutacion, que corre ANTES de este cleanup (pasivo, post-paint). El
  //      cleanup leia la ref, encontraba null, y no devolvia NADA al TUI. El
  //      camino mas comun de todos era el unico que perdia siempre.
  //   2. Si `parseTuiDraft` no entendia la pantalla, `ownsDraft` quedaba en
  //      false — no se devolvia nada — pero el cleanup igual hacia
  //      `el.value = ""`. Borraba sin haber entregado.
  //
  // El blindaje son tres reglas: (a) el texto se lee de `textRef`, que es una
  // copia en memoria y no depende del DOM; (b) TODO borrador se guarda en
  // `drafts` (memoria por terminal + disco por sesion) antes de cualquier otra
  // cosa; (c) la copia solo se BORRA cuando se entrego de verdad (volvio al
  // TUI o se envio). Si el intercambio no se pudo cerrar, la copia se queda y
  // reaparece al volver. Preferimos que sobre a que falte.
  const ownsDraftRef = useRef(false);
  useEffect(() => {
    if (!open || termId == null) return;
    let dead = false;
    ownsDraftRef.current = false;
    // 1) lo guardado MANDA sobre el TUI: si volves a una terminal donde ya
    //    tenias un borrador (o la app se relanzo con ⌘R), eso es lo tuyo.
    const saved = drafts.read(termId, sidOf(termId));
    if (saved) {
      const el = inputRef.current;
      if (el) {
        el.value = saved.text;
        autoGrow(el);
        caretToEnd(el);
      }
      textRef.current = saved.text;
      setAttach(saved.attachments);
      ownsDraftRef.current = true;
    }
    const timer = setTimeout(() => {
      if (dead || saved) return; // con borrador propio no se toca el TUI
      // CLI sin parser de su TUI (kimi, codex…): no se adopta nada, pero el
      // composer arranca vacio, asi que lo que escribas aqui es tuyo y debe
      // llegar a su terminal al salir.
      if (!claude) {
        if (!inputRef.current?.value) ownsDraftRef.current = true;
        return;
      }
      void manager.readTail(termId, 40).then((tail) => {
        if (dead) return;
        const el = inputRef.current;
        if (!el || el.value) return;
        const draft = parseTuiDraft(tail);
        if (draft == null) return; // pantalla no entendida: no tocar nada
        ownsDraftRef.current = true;
        if (!draft) return; // caja vacia: nada que adoptar, pero es nuestro
        el.value = draft;
        textRef.current = draft;
        autoGrow(el);
        caretToEnd(el);
        drafts.write(termId, sidOf(termId), { text: draft, attachments: attachRef.current });
        void ipc.ptyWrite(termId, "\x05\x15"); // End + kill: una sola pluma
      });
    }, 80);
    return () => {
      dead = true;
      clearTimeout(timer);
      // el texto sale de la REF, no del nodo: al cerrar, el nodo ya no existe
      const v = textRef.current.trim();
      const pend = attachRef.current;
      const s = sidOf(termId);
      // GUARDAR SIEMPRE, primero. Si algo de lo de abajo falla, esto ya salvo
      // el borrador; si todo sale bien, se limpia dos lineas despues.
      drafts.write(termId, s, { text: v, attachments: pend });
      // devolver al TUI solo si el intercambio esta limpio Y no hay adjuntos
      // (una terminal no puede sostener un chip de imagen: si los hay, el
      // dueño del borrador se queda siendo el composer).
      // ⚠️ `manager.get` NO es de adorno: manager.paste() se va en silencio si
      // la terminal ya no existe, asi que sin este guard borrariamos la copia
      // despues de "entregarla" a la nada — el mismo bug que vinimos a matar.
      const viva = manager.get(termId) != null;
      if (ownsDraftRef.current && v && !pend.length && viva) {
        manager.paste(termId, v);
        drafts.clear(termId, s); // entregado: ya no hay copia que devolver
      }
      ownsDraftRef.current = false;
      // el textarea es el MISMO nodo al cambiar de terminal: si no se vacia,
      // el borrador de la anterior se quedaria pintado y ademas bloquearia la
      // adopcion del borrador de la nueva (`if (el.value) return`)
      const el = inputRef.current;
      if (el) {
        el.value = "";
        el.style.height = "auto";
      }
      textRef.current = "";
      setAttach([]);
    };
  }, [open, termId, claude]);

  // DROP DE ARCHIVOS DEL SISTEMA (Finder → composer, 26 jul 2026).
  //
  // Va por el evento de Tauri y NO por el `drop` del DOM: cuando el drag viene
  // del SO, el webview entrega objetos File SIN ruta (la File API no expone
  // paths) — y una ruta es exactamente lo que necesitamos para que claude lea
  // el archivo. Tauri intercepta ese drop y sí da las rutas reales. El drag
  // INTERNO (arrastrar del arbol) es otra cosa: ese sí es DOM puro con
  // "text/plain", y lo atiende el onDrop del composer.
  //
  // La posicion viene en pixeles FISICOS: en un Retina hay que dividir por el
  // devicePixelRatio o el hit-test cae al doble de lejos y nunca acierta.
  const rootRef = useRef<HTMLDivElement>(null);
  const [dropOver, setDropOver] = useState(false);
  useEffect(() => {
    if (!open) return;
    let dead = false;
    let un: (() => void) | undefined;
    const dentro = (p: { x: number; y: number }) => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return false;
      const dpr = window.devicePixelRatio || 1;
      const x = p.x / dpr;
      const y = p.y / dpr;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    void getCurrentWebview()
      .onDragDropEvent((ev) => {
        const p = ev.payload;
        if (p.type === "leave") {
          setDropOver(false);
          return;
        }
        if (p.type === "enter" || p.type === "over") {
          setDropOver(dentro(p.position));
          return;
        }
        if (p.type === "drop") {
          const ok = dentro(p.position);
          setDropOver(false);
          if (ok) addAttachRef.current(p.paths.filter((x) => typeof x === "string" && x));
        }
      })
      .then((f) => {
        if (dead) f();
        else un = f;
      });
    return () => {
      dead = true;
      un?.();
      setDropOver(false);
    };
  }, [open]);

  /* ── adjuntos del composer (26 jul 2026) ────────────────────────────────
     Cuatro gestos, UN camino: todo termina siendo una RUTA en la lista de
     pendientes. Pegar (⌘V) materializa la imagen del portapapeles a un
     archivo; Finder, el arbol y el boton 📎 ya traen archivos. */

  /** Guarda lo tecleado en la copia de seguridad (memoria + disco). */
  const saveDraft = (text: string, adj: string[]) => {
    textRef.current = text;
    if (termId != null) drafts.write(termId, sidOf(termId), { text, attachments: adj });
  };

  /** Suma rutas a los pendientes (sin duplicar) y las persiste CON el borrador:
   *  pegar tres imagenes y cerrar el lector no las pierde. */
  const addAttach = (paths: string[]) => {
    if (!paths.length) return;
    setAttach((prev) => {
      const next = [...prev, ...paths.filter((p) => p && !prev.includes(p))];
      attachRef.current = next;
      saveDraft(textRef.current, next);
      return next;
    });
  };

  const removeAttach = (path: string) => {
    setAttach((prev) => {
      const next = prev.filter((p) => p !== path);
      attachRef.current = next;
      saveDraft(textRef.current, next);
      return next;
    });
  };

  /** Imagen del portapapeles → archivo real → chip. El blob YA viene DENTRO
   *  del evento `paste`, asi que no hay lectura programatica del portapapeles y
   *  por lo tanto no salta el boton "Paste" de WebKit (la friccion que Daniel
   *  hizo quitar de la terminal el 22 jul). */
  const pasteImage = async (blob: Blob) => {
    try {
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        bin += String.fromCharCode(...buf.subarray(i, i + CHUNK));
      }
      const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
      addAttach([await ipc.attachSave(btoa(bin), ext)]);
    } catch {
      /* si no se pudo guardar, no hay chip: el mensaje sigue siendo texto */
    }
  };

  /** Boton 📎: selector de archivos del sistema. Va por un <input type="file">
   *  y no por el dialogo nativo de Tauri a proposito — no exige plugin ni
   *  capability nueva. El costo es que la File API del webview no expone la
   *  ruta, asi que los bytes se COPIAN al directorio local de adjuntos (por eso
   *  esta acotado a imagenes: los archivos del proyecto entran por el arbol o
   *  por Finder, que si traen ruta real y no se copian). */
  const pickFiles = () => fileInputRef.current?.click();

  // el listener del SO se registra una vez y viviria con un closure viejo:
  // que llame SIEMPRE al addAttach del ultimo render
  addAttachRef.current = addAttach;

  if (!open || !mirror) return null;

  /** CONTINUAR desde el espejo del historial: la terminal nueva toma el foco
   *  y el efecto seguir-al-foco re-apunta este lector solo (verdad por argv). */
  const doContinue = async (text?: string) => {
    if (!sid || !path) return;
    await actions.continueHist(
      {
        provider,
        sid,
        path,
        configDir: mirror.cfg ?? null,
        cwd: mirror.cwd ?? "",
        title: mirror.title ?? null,
        model: data?.model ?? mirror.model ?? null,
        mtimeMs: 0,
      },
      text,
    );
  };

  // ESCRIBIR SIEMPRE FUNCIONA (dentro de lo que la terminal permite):
  //   claude VIVO  → directo a SU PTY (mismo proceso, misma sesion)
  //   dormida      → UN gesto: claude --resume <sid> 'texto' en su terminal
  const send = () => {
    const el = inputRef.current;
    const escrito = (el?.value ?? "").replace(/\s+$/, "");
    const pend = attachRef.current;
    if ((!escrito && !pend.length) || termId == null) return;
    // ADJUNTOS POR RUTA (26 jul): los paths viajan DENTRO del prompt y claude
    // los lee con su herramienta Read. Por ruta y no por base64 a proposito —
    // el transcript queda liviano (un blob inline pesa hasta 4MB y le come la
    // ventana al espejo), la imagen se puede reabrir despues, y es el mismo
    // camino para los cuatro gestos (pegar, Finder, arbol, 📎). El formato es
    // el que transcript.ts::splitAttachments ya sabe separar para pintarlo
    // como thumbnail en vez de texto crudo.
    const t = pend.length
      ? `${escrito}${escrito ? "\n\n" : ""}Archivos adjuntos (leelos/analizalos):\n` +
        pend.map((p) => `- ${p}`).join("\n")
      : escrito;
    if (live) {
      // TEXTO y ENTER SIEMPRE SEPARADOS (fix 21 jul pm): el TUI de claude
      // detecta rafagas como PASTE y un \r DENTRO de la rafaga se vuelve
      // newline — el mensaje se quedaba tecleado en el input sin enviarse
      // (bug reportado con screenshot). paste (bracketed si el TUI lo pidio)
      // + \r 160ms despues = Enter real, fuera de la ventana de paste.
      manager.paste(termId, t);
      setTimeout(() => void ipc.ptyWrite(termId, "\r"), 160);
    } else if (data?.sessionId || mirror.sid) {
      const resumeSid = data?.sessionId ?? mirror.sid;
      if (!resumeSid) return;
      const base =
        useStore.getState().config?.general.agent_command ??
        "claude --dangerously-skip-permissions";
      // sesion de OTRA cuenta (bro): revivir bajo SU config dir o claude
      // no encuentra el sid (los transcripts viven por-cuenta)
      const cmd = claudeResumeCommand(base, resumeSid, mirror.cfg, t);
      manager.paste(termId, cmd);
      setTimeout(() => void ipc.ptyWrite(termId, "\r"), 160);
    } else {
      return;
    }
    if (el) {
      el.value = "";
      el.style.height = "auto";
    }
    textRef.current = "";
    setAttach([]);
    drafts.clear(termId, sidOf(termId)); // enviado = entregado
    // enviado = el TUI quedo vacio (lo acabamos de submitear), asi que el
    // composer sigue siendo el dueño del borrador para lo que escribas ahora
    ownsDraftRef.current = true;
    pinnedRef.current = true;
  };


  const boxStyle: CSSProperties | undefined = box
    ? { left: box.left, top: box.top, width: box.width, height: box.height }
    : undefined;

  return (
    <TranscriptPath.Provider value={path ?? null}>
    <div
      ref={rootRef}
      className={`reader-back chat-back${box ? " panel" : ""}${dropOver ? " dropping" : ""}`}
      style={boxStyle}
      tabIndex={-1}
    >
      <Lightbox />
      <div className="chat-layout">
        <div className="chat-main">
          <SpeechBar />
          <div
            className="reader-scroll"
            ref={scrollRef}
            onScroll={() => {
              const el = scrollRef.current;
              if (!el) return;
              const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
              pinnedRef.current = dist < 90;
              setShowJump(dist > 350);
              // espejo para el cleanup (ver POSICION DE LECTURA arriba)
              fromBottomRef.current = Math.max(0, el.scrollHeight - el.scrollTop);
            }}
            onClick={(e) => void handleDocClick(e)}
          >
            <div className="reader-col chat-col">
              {screen ? (
                <ScreenMirror text={screenText} />
              ) : (
                <>
                  {data?.truncated && (
                    <div className="chat-mirror-cut">… inicio de la conversación fuera del espejo (sesión larga)</div>
                  )}
                  {!data && (
                    <div className="reader-empty">
                      {path ? "leyendo la sesión…" : "conversación nueva — escríbele abajo para arrancar"}
                    </div>
                  )}
                  {data && !data.msgs.length && !ghost && (
                    <div className="reader-empty">
                      {data.error
                        ? `no pude leer la sesión — ${data.error}`
                        : live
                          ? "buscando la conversación de esta terminal…"
                          : "esta sesión aún no tiene mensajes legibles"}
                    </div>
                  )}
                  {data?.msgs.map((m) => <Message key={m.id} msg={m} />)}
                  {ghost && <GhostBlock text={ghost} />}
                  {data?.turn?.state === "working" &&
                    data.turn.lastEventAt != null &&
                    Date.now() - data.turn.lastEventAt < 300_000 && (
                      <TypingLine
                        state="working"
                        startedAt={data.turn.startedAt}
                        tokens={data.turn.outputTokens}
                      />
                    )}
                </>
              )}
            </div>
            {/* IR AL FONDO (29 jul, pedido de Daniel): boton sutil que aparece
                al alejarte del fondo; sticky DENTRO del scroll (se auto-ancla
                sobre el borde inferior visible, sin pelearse con el composer).
                Smooth por scrollTo behavior — y deja pinned el auto-follow. */}
            <div className={`jump-wrap ${showJump ? "on" : ""}`}>
              <button
                className="jump-bottom"
                title="Ir al final de la conversación"
                onClick={() => {
                  const el = scrollRef.current;
                  if (!el) return;
                  pinnedRef.current = true;
                  el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
                }}
              >
                ↓
              </button>
            </div>
          </div>
          {termId != null && (
            <div className="chat-inputbar">
              {/* tarjeta estilo Codex (recuperada 21 jul): texto arriba,
                  fila de chips + orbe abajo — la barra "bonita y estilizada" */}
              <div
                className="chat-composer codex"
                // DROP INTERNO: arrastrar filas del arbol de archivos. Es un
                // drag del DOM con "text/plain" (uno o varios paths, ver
                // Tree.tsx), distinto del drop del SO que atiende Tauri arriba.
                onDragOver={(e) => {
                  if (!e.dataTransfer?.types.includes("text/plain")) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(e) => {
                  const paths = parseDroppedPaths(e.dataTransfer?.getData("text/plain") ?? "");
                  if (!paths.length) return;
                  e.preventDefault();
                  e.stopPropagation();
                  addAttach(paths);
                }}
              >
                {attach.length > 0 && (
                  <div className="chat-attach-row pending">
                    {attach.map((p) => (
                      <AttachView key={p} path={p} onRemove={() => removeAttach(p)} />
                    ))}
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = ""; // permite re-elegir el mismo archivo
                    for (const f of files) void pasteImage(f);
                  }}
                />
                <textarea
                  ref={inputRef}
                  className="chat-input"
                  rows={1}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  placeholder={
                    screen
                      ? `Escríbele a ${panel ? panelTitle(panel) : "esta terminal"} — va directo a su proceso (Enter envía)`
                      : live
                        ? "Escríbele al claude de ESTA terminal — misma sesión, mismo proceso (Enter envía)"
                        : "Escribe — claude despierta en su terminal y recibe tu mensaje"
                  }
                  onInput={(e) => {
                    autoGrow(e.currentTarget);
                    // la copia de seguridad se actualiza en cada tecla: es lo
                    // unico que sobrevive al desmonte del textarea
                    saveDraft(e.currentTarget.value, attachRef.current);
                  }}
                  onPaste={(e) => {
                    // IMAGEN pegada (⌘V de un screenshot): se materializa a un
                    // archivo y entra como chip. El texto sigue de largo y lo
                    // pega el textarea solo.
                    const items = Array.from(e.clipboardData?.items ?? []);
                    const img = items.find((i) => i.type.startsWith("image/"));
                    if (!img) return;
                    e.preventDefault();
                    const f = img.getAsFile();
                    if (f) void pasteImage(f);
                  }}
                  onKeyDown={(e) => {
                    // ⇧⏎ y ⌥⏎ = salto de linea, igual que en la terminal
                    // (22 jul): el textarea ya lo inserta solo si no cortamos
                    // el evento. Enter pelado envia.
                    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
                      e.preventDefault();
                      send();
                    }
                    e.stopPropagation();
                  }}
                />
                <ReaderBar
                  cwd={panel?.cwd ?? mirror.cwd}
                  data={data}
                  onSend={send}
                  onPick={pickFiles}
                />
              </div>
            </div>
          )}
          {/* ESPEJO DEL HISTORIAL (sin terminal dueña): la conversacion se LEE
              tal cual quedo, y continuar es un GESTO — terminal nueva con
              --resume (el revival automatico sigue muerto, 21 jul). Escribir
              aqui = continuar + entregar el texto cuando el agente despierte. */}
          {termId == null && sid && (
            <div className="chat-inputbar">
              <div className="chat-composer codex hist-continue">
                <textarea
                  className="chat-input"
                  rows={1}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  placeholder="Escríbele para continuar — despierta en una terminal nueva (Enter envía)"
                  onInput={(e) => autoGrow(e.currentTarget)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
                      e.preventDefault();
                      const t = e.currentTarget.value;
                      e.currentTarget.value = "";
                      void doContinue(t);
                    }
                    e.stopPropagation();
                  }}
                />
                <div className="hist-continue-row">
                  <span className="hist-continue-hint">
                    {mirror.cwd ? pathBasename(mirror.cwd) : ""}
                  </span>
                  <button
                    className="hist-continue-btn"
                    title="Reanudar esta conversación en una terminal nueva"
                    onClick={() => void doContinue()}
                  >
                    Continuar en terminal
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    </TranscriptPath.Provider>
  );
}
