import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "../core/store";
import { manager } from "../core/term";
import * as ipc from "../core/ipc";
import { renderMarkdown, handleDocClick } from "../core/md";
import { readerSpeech, type SpeechState } from "../core/reader-speech";
import SpeechBar from "./SpeechBar";
import type { BlockText } from "../core/types";

/** Modo Lectura de Bloques: el output de un bloque como DOCUMENTO (markdown
 *  rico o prosa serif) + lectura por voz del sistema con resaltado de palabra.
 *  La terminal (grid) sigue siendo la verdad debajo; esto es una capa de
 *  lectura que se abre desde el badge ☰ del bloque o desde la paleta.
 *
 *  REGLA DURA de este componente: el HTML del documento se genera COMPLETO a
 *  nivel string (marked renderer custom + hljs.highlight) y NUNCA se muta el
 *  DOM despues del render. React re-setea el innerHTML de un nodo con
 *  dangerouslySetInnerHTML cuando reconcilia inserciones de hermanos (medido
 *  15 jul 2026: montar la barra de voz nukeaba los wrappers añadidos por un
 *  useEffect y dejaba al TTS con nodos detached). Por lo mismo, la barra de
 *  voz esta SIEMPRE montada (se oculta por CSS): sin mount/unmount no hay
 *  re-set del subtree del documento a media lectura. */

const INACTIVE: SpeechState = { active: false, paused: false, rate: 1, idx: 0, total: 0 };

/** ¿El texto trae señales de markdown de verdad? (decide el modo default) */
export function looksMarkdown(text: string): boolean {
  let score = 0;
  if (/^#{1,4}\s+\S/m.test(text)) score += 2;
  if (/^```/m.test(text)) score += 2;
  if (/^\s{0,3}[-*]\s+\S/m.test(text)) score += 1;
  if (/^\s{0,3}\d+\.\s+\S/m.test(text)) score += 1;
  if (/\*\*[^*\n]+\*\*/.test(text)) score += 2;
  if (/^\|.+\|\s*\n\s*\|[\s:|-]+\|/m.test(text)) score += 3;
  if (/\[[^\]\n]+\]\([^)\n]+\)/.test(text)) score += 1;
  return score >= 2;
}

/** Limpieza suave para prosa (modo txt): fuera las lineas que son puro chrome
 *  de TUI (bordes de cajas) y los huecos gigantes. En md NO se toca (un code
 *  fence puede contener arte de cajas legitimo). */
function cleanProse(t: string): string {
  return t
    .split("\n")
    .filter((l) => !(l.trim() && /^[\s─│╭╮╰╯┌┐└┘├┤┬┴═║▁▔╌╍]+$/.test(l)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function fmtDur(ms: number | null): string {
  if (ms == null) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export default function Reader() {
  const target = useStore((s) => s.ui.reader);
  const [data, setData] = useState<BlockText | null>(null);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"md" | "txt">("md");
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLDivElement>(null);

  const speech = useSyncExternalStore(
    (cb) => readerSpeech.subscribe(cb),
    () => readerSpeech.getState(),
    () => INACTIVE,
  );

  const speechKey = target ? `${target.ptyId}:${target.blockId ?? "last"}` : "";

  const load = useCallback(() => {
    if (!target) return;
    ipc.engineBlockText(target.ptyId, target.blockId, 2000)
      .then((bt) => {
        setData(bt);
        setErr("");
        setMode(looksMarkdown(bt.text) ? "md" : "txt");
      })
      .catch((e) => setErr(String(e)));
  }, [target]);

  const close = useCallback(() => {
    readerSpeech.stop();
    const pty = useStore.getState().ui.reader?.ptyId;
    useStore.getState().setUI({ reader: null });
    if (pty != null && manager.get(pty)) manager.focus(pty);
  }, []);

  // abrir: cargar el bloque + mover el foco al overlay (que la terminal no
  // siga comiendose el teclado); cerrar: parar la voz
  useEffect(() => {
    if (!target) {
      setData(null);
      setErr("");
      setCopied(false);
      return;
    }
    load();
    requestAnimationFrame(() => backRef.current?.focus());
    return () => readerSpeech.stop();
  }, [target, load]);

  // Esc cierra (capture: antes que cualquier otro listener)
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [target, close]);

  // ELEMENTO memoizado (no solo el string): React 19 re-setea el innerHTML de
  // un dangerouslySetInnerHTML en cada re-render aunque __html no cambie
  // (medido 15 jul 2026: cada emit de la voz detachaba los nodos del doc y
  // mataba resaltado + taps). Mismo ELEMENTO entre renders = React no toca el
  // subtree, garantizado por inmutabilidad de elementos.
  const doc = useMemo<React.ReactNode>(() => {
    if (!data || !data.text.trim()) return null;
    if (mode === "md") {
      return <div className="reader-doc" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.text) }} />;
    }
    const paras = cleanProse(data.text).split(/\n{2,}/).filter((p) => p.trim());
    return (
      <div className="reader-doc">
        {paras.map((p, i) => (
          <p key={i} className="reader-p">{p}</p>
        ))}
      </div>
    );
  }, [data, mode]);

  if (!target) return null;

  const copyAll = () => {
    if (!data) return;
    void navigator.clipboard.writeText(data.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  // delegacion sobre el documento (copiar de code blocks + links): compartida
  const onBodyClick = (e: React.MouseEvent) => void handleDocClick(e);

  const listening = speech.active && readerSpeech.isActive(speechKey);
  const ok = (data?.exit ?? 0) === 0;

  let body: React.ReactNode = null;
  if (err) {
    body = <div className="reader-empty">{err}</div>;
  } else if (data) {
    body = data.text.trim()
      ? doc
      : <div className="reader-empty">Este bloque no tiene output que leer.</div>;
  }

  return (
    <div className="reader-back" ref={backRef} tabIndex={-1}>
      <div className="reader-head">
        <div className="reader-meta">
          {data?.cmd ? <span className="reader-cmd" title={data.cmd}>$ {data.cmd}</span> : null}
          {data ? (
            data.running ? (
              <span className="reader-badge run">⟳ corriendo</span>
            ) : (
              <span className={`reader-badge ${ok ? "ok" : "bad"}`}>
                {ok ? "✓" : `✗ ${data.exit}`}{data.duration_ms != null ? ` · ${fmtDur(data.duration_ms)}` : ""}
              </span>
            )
          ) : null}
          {data?.cwd ? <span className="reader-cwd" title={data.cwd}>{data.cwd.split("/").filter(Boolean).pop()}</span> : null}
        </div>
        <div className="reader-actions">
          {data?.running && (
            <button
              className="reader-btn"
              onClick={() => {
                readerSpeech.stop(); // el reload reemplaza los nodos del doc
                load();
              }}
              title="Recargar el output (el bloque sigue corriendo)"
            >
              ↻
            </button>
          )}
          <button
            className={`reader-btn ${listening ? "on" : ""}`}
            onClick={() => bodyRef.current && readerSpeech.toggle(speechKey, bodyRef.current)}
            title={listening ? "Detener lectura" : "Escuchar con la voz del sistema"}
          >
            {listening ? "◼ voz" : "▶ escuchar"}
          </button>
          <button
            className="reader-btn"
            onClick={() => {
              readerSpeech.stop();
              setMode((m) => (m === "md" ? "txt" : "md"));
            }}
            title="Alternar markdown / texto plano"
          >
            {mode === "md" ? "md" : "txt"}
          </button>
          <button className="reader-btn" onClick={copyAll} title="Copiar todo el output">
            {copied ? "✓ copiado" : "⧉ copiar"}
          </button>
          <button className="reader-btn" onClick={close} title="Cerrar (Esc)">
            ✕
          </button>
        </div>
      </div>

      <SpeechBar />

      <div className="reader-scroll" onClick={onBodyClick}>
        <div className="reader-col" ref={bodyRef}>
          {body}
        </div>
      </div>
    </div>
  );
}
