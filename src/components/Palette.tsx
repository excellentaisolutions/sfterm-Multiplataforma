import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../core/store";
import * as actions from "../core/actions";
import * as ipc from "../core/ipc";

interface Cmd {
  label: string;
  hint?: string;
  run: () => void | Promise<void>;
}

export default function Palette() {
  const open = useStore((s) => s.ui.palette);
  const config = useStore((s) => s.config);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const cmds = useMemo<Cmd[]>(() => {
    if (!config) return [];
    const c: Cmd[] = [];
    for (const p of config.presets ?? []) {
      c.push({
        label: `Preset: ${p.name}`,
        hint: `${p.root} · ${p.panes?.length ?? 0} panes`,
        run: () => actions.applyPreset(p),
      });
    }
    c.push(
      { label: "Nueva terminal", hint: "⌘J", run: () => void actions.newTerminal() },
      { label: "Terminal con el agente", hint: "⌘⌥J", run: () => void actions.newConversation() },
      {
        label: "Leer último bloque (modo lectura)",
        hint: "☰ vista rica + voz",
        run: () => {
          const st = useStore.getState();
          if (st.focused != null) st.setUI({ reader: { ptyId: st.focused } });
        },
      },
      {
        label: "Ver cambios del repo (diffs)",
        hint: "abre los archivos modificados en modo diff",
        run: () => void actions.openChanges(),
      },
      {
        label: "Buscar por contenido en el proyecto",
        hint: "⌘⇧F",
        run: () => useStore.getState().setUI({ search: true }),
      },
      {
        label: "Preview del dev server",
        hint: "busca localhost:PUERTO en la terminal enfocada",
        run: () => void actions.openDevPreview(),
      },
      {
        label: "Abrir navegador",
        hint: "panel web nativo — el agente lo opera por el gate",
        run: () => void actions.openBrowser(),
      },
      { label: "Toggle árbol", hint: "⌘B", run: () => useStore.getState().set({ treeVisible: !useStore.getState().treeVisible }) },
      { label: "Toggle rail", hint: "⌘⌥B", run: () => useStore.getState().set({ railVisible: !useStore.getState().railVisible }) },
      { label: "Configuración", hint: "⌘,", run: () => useStore.getState().setUI({ settings: true }) },
      {
        label: "Abrir config.toml en el visor",
        run: async () => actions.openFileTab(await ipc.configPath()),
      },
    );
    // input que parece path -> acciones de root
    const t = q.trim();
    if (t.startsWith("/") || t.startsWith("~")) {
      c.unshift(
        { label: `Árbol → ${t}`, hint: "cambiar root", run: () => void actions.setTreeRoot(t) },
        { label: `Terminal en ${t}`, run: () => void actions.newTerminal(t) },
      );
    }
    return c;
  }, [config, q]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t || t.startsWith("/") || t.startsWith("~")) return cmds;
    return cmds.filter((c) => c.label.toLowerCase().includes(t));
  }, [cmds, q]);

  if (!open) return null;
  const close = () => useStore.getState().setUI({ palette: false });

  return (
    <div className="overlay-back" onClick={close}>
      <div className="overlay-card" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="query"
          placeholder="Comando… o pega un path (~/… o /…) para el árbol"
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, filtered.length - 1));
            else if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
            else if (e.key === "Enter" && filtered[sel]) {
              close();
              void filtered[sel].run();
            }
          }}
        />
        <div className="overlay-list">
          {filtered.map((c, i) => (
            <div
              key={c.label + i}
              className={`overlay-row ${i === sel ? "hot" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => { close(); void c.run(); }}
            >
              <span>{c.label}</span>
              {c.hint && <span className="hint">{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
