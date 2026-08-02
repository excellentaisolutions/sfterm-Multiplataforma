import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../core/store";
import * as actions from "../core/actions";
import * as ipc from "../core/ipc";
import { iconForFile } from "../core/icons";
import { fuzzyScore } from "../core/fuzzy";

let cache: { root: string; at: number; files: string[] } | null = null;

export default function FileFinder() {
  const open = useStore((s) => s.ui.finder);
  const treeRoot = useStore((s) => s.treeRoot);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [files, setFiles] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setSel(0);
    setTimeout(() => inputRef.current?.focus(), 30);
    const fresh = cache && cache.root === treeRoot && Date.now() - cache.at < 30_000;
    if (fresh) {
      setFiles(cache!.files);
    } else {
      setFiles([]);
      void ipc.fsIndex(treeRoot).then((f) => {
        cache = { root: treeRoot, at: Date.now(), files: f };
        setFiles(f);
      });
    }
  }, [open, treeRoot]);

  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return files.slice(0, 60);
    const scored: [number, string][] = [];
    for (const f of files) {
      const s = fuzzyScore(t, f);
      if (s >= 0) scored.push([s, f]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, 60).map(([, f]) => f);
  }, [q, files]);

  if (!open) return null;
  const close = () => useStore.getState().setUI({ finder: false });

  const openFile = (rel: string) => {
    close();
    actions.openViewer(`${treeRoot}/${rel}`);
  };

  return (
    <div className="overlay-back" onClick={close}>
      <div className="overlay-card" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="query"
          placeholder={files.length ? `Buscar entre ${files.length} archivos…` : "Indexando…"}
          value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "ArrowDown") setSel((s) => Math.min(s + 1, results.length - 1));
            else if (e.key === "ArrowUp") setSel((s) => Math.max(s - 1, 0));
            else if (e.key === "Enter" && results[sel]) openFile(results[sel]);
          }}
        />
        <div className="overlay-list">
          {results.map((f, i) => {
            const name = f.split("/").pop() ?? f;
            const dir = f.slice(0, f.length - name.length);
            return (
              <div
                key={f}
                className={`overlay-row ${i === sel ? "hot" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => openFile(f)}
              >
                <img className="ficon" src={iconForFile(name)} alt="" />
                <span>{name}</span>
                <span className="dim">{dir}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
