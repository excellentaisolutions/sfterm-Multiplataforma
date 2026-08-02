import { useEffect, useRef, useState } from "react";
import { useStore } from "../core/store";
import { manager } from "../core/term";

/** Cmd+F: busqueda en el scrollback de la terminal enfocada. */
export default function FindBar() {
  const open = useStore((s) => s.ui.findbar);
  const focused = useStore((s) => s.focused);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
    else if (focused != null) manager.clearFind(focused);
  }, [open, focused]);

  if (!open || focused == null) return null;
  const close = () => {
    useStore.getState().setUI({ findbar: false });
    manager.focus(focused);
  };

  return (
    <div id="findbar" style={{ top: 46, right: 340 }}>
      <input
        ref={inputRef}
        placeholder="Buscar en scrollback…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          manager.find(focused, e.target.value, "next");
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") close();
          else if (e.key === "Enter" && e.shiftKey) manager.find(focused, q, "prev");
          else if (e.key === "Enter") manager.find(focused, q, "next");
        }}
      />
      <button className="icon-btn" title="Anterior (⇧↵)" onClick={() => manager.find(focused, q, "prev")}>↑</button>
      <button className="icon-btn" title="Siguiente (↵)" onClick={() => manager.find(focused, q, "next")}>↓</button>
      <button className="icon-btn" onClick={close}>✕</button>
    </div>
  );
}
