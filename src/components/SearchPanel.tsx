import { useEffect, useRef, useState } from "react";
import { useStore } from "../core/store";
import * as actions from "../core/actions";
import * as ipc from "../core/ipc";
import { iconForFile } from "../core/icons";

interface Hit {
  path: string;
  line: number;
  preview: string;
}

/** Busqueda por CONTENIDO en el proyecto (⌘⇧F). Respeta .gitignore, salta
 *  binarios. Enter/click abre el archivo en el visor (solo-lectura, como
 *  manda la constitucion: editar = pedirselo al agente). */
export default function SearchPanel() {
  const open = useStore((s) => s.ui.search);
  const treeRoot = useStore((s) => s.treeRoot);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    setHits([]);
    setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  // busqueda con debounce: el walker de Rust es rapido, pero no para cada tecla
  useEffect(() => {
    if (!open) return;
    const t = q.trim();
    if (t.length < 2) {
      setHits([]);
      return;
    }
    setBusy(true);
    const h = setTimeout(() => {
      ipc.fsSearch(treeRoot, t, 200)
        .then((r) => {
          setHits(r);
          setSel(0);
        })
        .catch(() => setHits([]))
        .finally(() => setBusy(false));
    }, 250);
    return () => clearTimeout(h);
  }, [q, open, treeRoot]);

  if (!open) return null;
  const close = () => useStore.getState().setUI({ search: false });

  const openHit = (h: Hit) => {
    close();
    actions.openViewerAt(`${treeRoot}/${h.path}`, h.line);
  };

  return (
    <div className="overlay-back" onClick={close}>
      <div className="overlay-card" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="query"
          placeholder={busy ? "Buscando…" : "Buscar por contenido en el proyecto…"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, hits.length - 1));
            else if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
            else if (e.key === "Enter" && hits[sel]) openHit(hits[sel]);
          }}
        />
        <div className="overlay-list">
          {hits.map((h, i) => {
            const name = h.path.split("/").pop() ?? h.path;
            return (
              <div
                key={`${h.path}:${h.line}:${i}`}
                className={`overlay-row ${i === sel ? "hot" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => openHit(h)}
              >
                <img className="ficon" src={iconForFile(name)} alt="" />
                <span>
                  {h.path}
                  <span className="dim">:{h.line}</span>
                </span>
                <span className="dim search-preview">{h.preview}</span>
              </div>
            );
          })}
          {!busy && q.trim().length >= 2 && hits.length === 0 && (
            <div className="overlay-row dim">sin resultados</div>
          )}
        </div>
      </div>
    </div>
  );
}
