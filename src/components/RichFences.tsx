import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ESTUDIO_INLINE } from "../core/estudio-inline";

/** FENCES VIVOS en el lector/vistazo (21 jul 2026 — port del chat de Arbrain,
 *  "no reinventes la rueda"): los bloques ```html y ```mermaid de un mensaje
 *  se RENDERIZAN en vez de mostrarse como codigo muerto.
 *
 *  - ```html → iframe sandbox (`allow-scripts` SIN allow-same-origin = origen
 *    opaco: el contenido no toca la app, ni cookies, ni localStorage), con
 *    toggle Vista/Codigo, fullscreen, srcdoc debounced para streaming, y la
 *    barra de estudio de libro-os AUTO-INYECTADA (opt-out: "sin-estudio").
 *  - ```mermaid → mermaid.render (import dinamico, tema oscuro de marca).
 *
 *  Fuente original: arbrain/src/features/chat/components/{HtmlPreview,
 *  MermaidDiagram}.tsx — misma sandbox, mismo debounce, misma inyeccion. */

export interface RichSeg {
  kind: "md" | "html" | "mermaid";
  text: string;
}

/** Parte el markdown en segmentos: prosa (md) y fences vivos. Un fence SIN
 *  cerrar al final (streaming) ya cuenta como su tipo — el debounce del
 *  iframe/mermaid absorbe los re-renders token a token. */
export function splitRich(text: string): RichSeg[] {
  const out: RichSeg[] = [];
  const re = /```(html|mermaid)[^\S\n]*\n([\s\S]*?)(?:```|$)/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ kind: "md", text: text.slice(last, m.index) });
    out.push({ kind: m[1].toLowerCase() as "html" | "mermaid", text: m[2] });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ kind: "md", text: text.slice(last) });
  return out.filter((s) => s.kind !== "md" || s.text.trim());
}

/** ¿El texto trae fences vivos? (para que Message no pague el split si no) */
export function hasRichFences(text: string): boolean {
  return /```(html|mermaid)/i.test(text);
}

// ─── ```html → iframe sandbox ────────────────────────────────────────────────

const FRAGMENT_WRAP_HEAD = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;padding:16px;background:#0d0d12;color:#e7e7ea;
    font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;
    font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
  a{color:#a78bfa}
  img,svg,canvas,video{max-width:100%;height:auto}
</style></head><body>`;

function injectEstudio(code: string): string {
  if (/id=["']estudio-bar["']/.test(code) || /sin-estudio/.test(code)) return code;
  const cierre = code.search(/<\/body>/i);
  if (cierre >= 0) return code.slice(0, cierre) + ESTUDIO_INLINE + code.slice(cierre);
  return code + ESTUDIO_INLINE;
}

function buildSrcDoc(code: string): string {
  if (/<html[\s>]|<!doctype/i.test(code)) return injectEstudio(code);
  return `${FRAGMENT_WRAP_HEAD}${injectEstudio(code)}</body></html>`;
}

function useDebouncedSrcDoc(code: string) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  useEffect(() => {
    const trimmed = code.trim();
    if (!trimmed) return;
    const timer = setTimeout(() => setSrcDoc(buildSrcDoc(trimmed)), 400);
    return () => clearTimeout(timer);
  }, [code]);
  return srcDoc;
}

function FullscreenHtml({ srcDoc, onClose }: { srcDoc: string; onClose: () => void }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [onClose]);
  return createPortal(
    <div className="fence-full">
      <div className="fence-full-head">
        <span className="fence-label">VISTA HTML</span>
        <button className="reader-btn" onClick={onClose} title="Cerrar (Esc)">✕</button>
      </div>
      <iframe srcDoc={srcDoc} sandbox="allow-scripts" title="Vista HTML" className="fence-full-frame" />
    </div>,
    document.body,
  );
}

export const HtmlFence = memo(function HtmlFence({ code }: { code: string }) {
  const srcDoc = useDebouncedSrcDoc(code);
  const [view, setView] = useState<"vista" | "codigo">("vista");
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="fence-card">
      <div className="fence-head">
        <span className="fence-label">HTML</span>
        <div className="fence-actions">
          <button
            className="reader-btn"
            onClick={() => setView((v) => (v === "vista" ? "codigo" : "vista"))}
            title={view === "vista" ? "Ver código" : "Ver render"}
          >
            {view === "vista" ? "código" : "vista"}
          </button>
          <button
            className="reader-btn"
            onClick={() => {
              void navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
            title="Copiar el código"
          >
            {copied ? "✓" : "⧉"}
          </button>
          <button
            className="reader-btn"
            disabled={!srcDoc}
            onClick={() => setFullscreen(true)}
            title="Pantalla completa"
          >
            ⛶
          </button>
        </div>
      </div>
      {view === "vista" ? (
        srcDoc ? (
          <iframe srcDoc={srcDoc} sandbox="allow-scripts" title="Vista HTML" className="fence-frame" />
        ) : (
          <div className="fence-wait">preparando vista…</div>
        )
      ) : (
        <pre className="fence-code">{code}</pre>
      )}
      {fullscreen && srcDoc && <FullscreenHtml srcDoc={srcDoc} onClose={() => setFullscreen(false)} />}
    </div>
  );
});

// ─── ```mermaid → diagrama ───────────────────────────────────────────────────

/** Mismo hook de Arbrain: import dinamico + debounce 250ms + tema oscuro. */
function useMermaidRender(code: string) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastCode = useRef("");
  useEffect(() => {
    const trimmed = code.trim();
    if (!trimmed || lastCode.current === trimmed) return;
    setError(null);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const mermaid = (await import("mermaid")).default;
          mermaid.initialize({
            startOnLoad: false,
            theme: "dark",
            securityLevel: "loose",
            logLevel: "fatal",
            suppressErrorRendering: true,
            themeVariables: {
              primaryColor: "#7c3aed",
              primaryTextColor: "#f1f5f9",
              primaryBorderColor: "#6d28d9",
              lineColor: "#8b5cf6",
              secondaryColor: "#1e1b4b",
              tertiaryColor: "#0f0f14",
              background: "transparent",
              mainBkg: "#18181f",
              nodeBorder: "#6d28d9",
              clusterBkg: "#1a1a2e",
              titleColor: "#e2e8f0",
              edgeLabelBackground: "#1e1b4b",
              fontFamily: "ui-sans-serif, system-ui, sans-serif",
            },
          });
          const clean = trimmed.replace(/<br\s*\/?>/gi, " ").replace(/<\/?b>/gi, "");
          const id = `sf-mermaid-${Math.random().toString(36).slice(2, 9)}`;
          const { svg: rendered } = await mermaid.render(id, clean);
          setSvg(rendered);
          lastCode.current = trimmed;
        } catch (e) {
          setError(e instanceof Error ? e.message.slice(0, 120) : "Syntax error");
        }
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [code]);
  return { svg, error };
}

export const MermaidFence = memo(function MermaidFence({ code }: { code: string }) {
  const { svg, error } = useMermaidRender(code);
  const [copied, setCopied] = useState(false);
  return (
    <div className="fence-card">
      <div className="fence-head">
        <span className="fence-label">DIAGRAMA</span>
        <div className="fence-actions">
          <button
            className="reader-btn"
            onClick={() => {
              void navigator.clipboard.writeText(code);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
            title="Copiar el código mermaid"
          >
            {copied ? "✓" : "⧉"}
          </button>
        </div>
      </div>
      {error ? (
        <div className="fence-wait">⚠ {error}</div>
      ) : svg ? (
        // el SVG viene de mermaid.render local (no del modelo): confiable
        <div className="fence-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="fence-wait">dibujando…</div>
      )}
    </div>
  );
});
