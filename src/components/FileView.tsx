import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { useStore } from "../core/store";
import * as ipc from "../core/ipc";

const IMG = ["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "ico", "avif"];
const VIDEO = ["mp4", "mov", "webm", "m4v"];
const AUDIO = ["mp3", "wav", "m4a", "ogg", "flac", "aac"];

const HL_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  py: "python", rs: "rust", go: "go", rb: "ruby", java: "java", kt: "kotlin",
  swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
  sh: "bash", zsh: "bash", bash: "bash", json: "json", toml: "ini", ini: "ini",
  yml: "yaml", yaml: "yaml", html: "xml", xml: "xml", css: "css", scss: "scss",
  sql: "sql", php: "php", lua: "lua", vim: "vim", diff: "diff", dockerfile: "dockerfile",
};

type Mode = "code" | "md-render" | "md-raw" | "img" | "video" | "audio" | "diff" | "info";

/** Visor universal SOLO-LECTURA. Vive como tab de un leaf del tiling — el
 *  UNICO host que existe (el visor "hosteado en el chat" era de la era
 *  chat-first, purgada el 21 jul). El cluster de controles (ojo markdown,
 *  diff, revelar en Finder) vive en la barra de tabs del leaf (Tiling.tsx),
 *  no aqui: `raw` es estado del TAB (tiling.ts), no local de este componente
 *  — asi sobrevive a cambiar de pestaña y puede tocarse desde la barra. */
export default function FileView(props: {
  path: string;
  mode: "auto" | "diff";
  raw: boolean;
}) {
  const { path, mode, raw } = props;
  const treeRoot = useStore((s) => s.treeRoot);
  const [text, setText] = useState("");
  const [info, setInfo] = useState("");
  const [zoom, setZoom] = useState(1);
  const bodyRef = useRef<HTMLDivElement>(null);

  // salto pendiente a linea (busqueda por contenido / gate show_file):
  // scroll proporcional. REACTIVO al store: funciona tanto en apertura
  // fresca (espera al texto) como con el archivo YA abierto (tab existente).
  const jump = useStore((s) => s.pendingJump);
  useEffect(() => {
    if (!jump || jump.path !== path || !text) return;
    useStore.getState().set({ pendingJump: null });
    const total = Math.max(1, text.split("\n").length);
    const frac = Math.min(1, (jump.line - 1) / total);
    const scroll = () => {
      const el = bodyRef.current;
      if (!el) return;
      el.scrollTop = Math.max(0, frac * el.scrollHeight - el.clientHeight / 2);
    };
    // directo + reintento: rAF NO dispara en ventanas sin foco (el gate
    // opera la app en segundo plano), jamas depender de un frame pintado
    scroll();
    const t = setTimeout(scroll, 80);
    return () => clearTimeout(t);
  }, [jump, text, path]);

  const name = path.split("/").pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";

  const baseMode: Mode = useMemo(() => {
    if (mode === "diff") return "diff";
    if (IMG.includes(ext)) return "img";
    if (VIDEO.includes(ext)) return "video";
    if (AUDIO.includes(ext)) return "audio";
    if (ext === "md" || ext === "markdown") return raw ? "md-raw" : "md-render";
    return "code";
  }, [ext, mode, raw]);

  useEffect(() => {
    setZoom(1);
    setInfo("");
    setText("");
    if (!path) return;
    if (baseMode === "img" || baseMode === "video" || baseMode === "audio") return;
    if (baseMode === "diff") {
      ipc.gitDiffFile(treeRoot, path)
        .then(setText)
        .catch((e) => setInfo(String(e)));
      return;
    }
    ipc.fsReadFile(path)
      .then((r) => {
        if (r.kind === "text") setText(r.content);
        else if (r.kind === "binary") setInfo("Archivo binario — sin preview de texto.");
        else setInfo(`Archivo grande (${(r.size / 1e6).toFixed(1)} MB) — abrelo con un agente.`);
      })
      .catch((e) => setInfo(String(e)));
  }, [path, baseMode, treeRoot]);

  const body = () => {
    if (info) return <div className="viewer-empty">{info}</div>;
    switch (baseMode) {
      case "img":
        return (
          <div
            className="img-stage"
            onClick={() => setZoom((z) => (z >= 3 ? 1 : z * 1.5))}
            onWheel={(e) => {
              if (!e.ctrlKey && !e.metaKey) return;
              e.preventDefault();
              setZoom((z) => Math.min(6, Math.max(0.2, z * (e.deltaY < 0 ? 1.1 : 0.9))));
            }}
            title="Click: zoom · ⌘+scroll: zoom fino"
          >
            <img
              src={convertFileSrc(path)}
              style={{ transform: `scale(${zoom})` }}
              alt={name}
            />
          </div>
        );
      case "video":
        return (
          <div className="media-wrap">
            <video src={convertFileSrc(path)} controls />
          </div>
        );
      case "audio":
        return (
          <div className="media-wrap">
            <audio src={convertFileSrc(path)} controls />
          </div>
        );
      case "md-render": {
        const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
        return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
      }
      case "diff": {
        const lines = text.split("\n").map((l, i) => {
          const cls = l.startsWith("+") ? "l-add" : l.startsWith("-") ? "l-del"
            : l.startsWith("@@") ? "l-hunk" : l.startsWith("diff ") || l.startsWith("index ") ? "l-meta" : "";
          return <div key={i} className={cls}>{l || " "}</div>;
        });
        return <pre className="diff">{lines}</pre>;
      }
      default: {
        const lang = HL_LANG[ext] ?? (name.toLowerCase() === "dockerfile" ? "dockerfile" : "");
        let html: string;
        try {
          html = lang
            ? hljs.highlight(text, { language: lang }).value
            : hljs.highlightAuto(text.slice(0, 60_000)).value;
        } catch {
          html = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        }
        return (
          <pre className="code hljs" dangerouslySetInnerHTML={{ __html: html }} />
        );
      }
    }
  };

  return (
    <div className="fileview">
      <div className="viewer-body" ref={bodyRef}>{body()}</div>
    </div>
  );
}
