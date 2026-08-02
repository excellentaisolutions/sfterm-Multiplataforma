import { useEffect, useRef, useState } from "react";
import { useStore, panelTitle } from "../core/store";
import { manager } from "../core/term";
import * as ipc from "../core/ipc";
import Logo from "./Logo";

/** Composer (⌘I): un campo de texto REAL para hablarle al agente de la
 *  terminal enfocada. Aqui el texto se edita como en cualquier app (mouse,
 *  ⌘A, dictado de SFlow nativo, saltos con ⇧⏎) y solo viaja al PTY al dar
 *  ⏎ — via bracketed paste, asi claude lo recibe como UN mensaje.
 *  Historial persistente con ↑/↓ en los bordes del texto. */

const HIST_KEY = "sfterm-composer-history";
const HIST_MAX = 120;

function loadHist(): string[] {
  try {
    const h = JSON.parse(localStorage.getItem(HIST_KEY) ?? "[]");
    return Array.isArray(h) ? h.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export default function Composer() {
  const visible = useStore((s) => s.ui.composer);
  const focused = useStore((s) => s.focused);
  const panels = useStore((s) => s.panels);
  const [text, setText] = useState("");
  const [histIdx, setHistIdx] = useState(-1); // -1 = editando texto nuevo
  const draft = useRef("");
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => ta.current?.focus());
  }, [visible]);

  // auto-grow del textarea (1 linea → hasta ~35% de la ventana)
  const grow = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.35)}px`;
  };
  useEffect(grow, [text, visible]);

  if (!visible) return null;

  const target = focused != null ? panels[focused] : null;

  const close = () => {
    useStore.getState().setUI({ composer: false });
    if (focused != null) manager.focus(focused);
  };

  const send = () => {
    const t = text.replace(/\s+$/, "");
    if (!t || focused == null || !manager.get(focused)) return;
    if (t.includes("\n")) {
      // multiline: bracketed paste → claude lo toma como un solo mensaje
      manager.paste(focused, t);
      setTimeout(() => void ipc.ptyWrite(focused, "\r"), 120);
    } else {
      void ipc.ptyWrite(focused, t + "\r");
    }
    const h = [t, ...loadHist().filter((x) => x !== t)].slice(0, HIST_MAX);
    localStorage.setItem(HIST_KEY, JSON.stringify(h));
    setText("");
    setHistIdx(-1);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation(); // que los atajos del textarea no naveguen la app
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      send();
      return;
    }
    // historial: ↑ con el caret en la primera linea / ↓ en la ultima
    const el = e.currentTarget;
    const beforeCaret = el.value.slice(0, el.selectionStart ?? 0);
    const afterCaret = el.value.slice(el.selectionEnd ?? 0);
    const hist = loadHist();
    if (e.key === "ArrowUp" && !beforeCaret.includes("\n") && histIdx < hist.length - 1) {
      e.preventDefault();
      if (histIdx === -1) draft.current = el.value;
      const i = histIdx + 1;
      setHistIdx(i);
      setText(hist[i]);
      return;
    }
    if (e.key === "ArrowDown" && !afterCaret.includes("\n") && histIdx >= 0) {
      e.preventDefault();
      const i = histIdx - 1;
      setHistIdx(i);
      setText(i === -1 ? draft.current : hist[i]);
    }
  };

  return (
    <div id="composer">
      <div className="composer-head">
        <Logo size={14} />
        <span className="composer-target">
          {target ? panelTitle(target) : "sin terminal enfocada"}
        </span>
        <span className="composer-hint">⏎ envía · ⇧⏎ salto · ↑↓ historial · esc cierra</span>
      </div>
      <textarea
        ref={ta}
        rows={1}
        value={text}
        placeholder="Escríbele al agente…"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(e) => {
          setText(e.target.value);
          setHistIdx(-1);
        }}
        onKeyDown={onKey}
      />
    </div>
  );
}
