/** Cabecera del sidebar derecho (29 jul 2026, estilo VS Code):
 *  - dos BOTONCITOS de vista: 📁 archivos (el arbol) ↔ ⎇ source control
 *    (el panel espejo a pantalla completa del sidebar). El boton de SCM
 *    lleva un BADGE ambiental (⇡n sin push, o punto si hay cambios) para
 *    que la señal viva aunque estes en la vista de archivos.
 *  - el NOMBRE DEL ROOT es un picker de repos: click → recientes + presets
 *    (default business-os, el preset). Cambiar de root re-apunta arbol,
 *    source control y watcher en un movimiento (setTreeRoot ya cascadea).
 *  AI-first: tambien se cambia conversando (verbo de gate `root {path}`). */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../core/store";
import * as actions from "../core/actions";
import { recentRoots } from "../core/actions";

function IconFiles({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <path
        d="M2.5 4.5a1.5 1.5 0 0 1 1.5-1.5h2.6l1.4 1.6h4.5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5v-7.6Z"
        stroke="currentColor"
        strokeWidth="1.2"
        fill={active ? "currentColor" : "none"}
        fillOpacity={active ? 0.25 : 0}
      />
    </svg>
  );
}

function IconScm({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
      <circle cx="4.5" cy="3.5" r="1.7" stroke="currentColor" strokeWidth="1.2" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.3 : 0} />
      <circle cx="4.5" cy="12.5" r="1.7" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="11.5" cy="5.5" r="1.7" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4.5 5.2v5.6M11.5 7.2c0 2.6-3 2.3-5 3.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export default function SideHead() {
  const treeRoot = useStore((s) => s.treeRoot);
  const view = useStore((s) => s.sideView);
  const sync = useStore((s) => s.scm?.sync ?? null);
  const config = useStore((s) => s.config);
  const [picker, setPicker] = useState(false);
  const headRef = useRef<HTMLDivElement>(null);

  const rootName = treeRoot.split("/").filter(Boolean).pop() ?? "";
  const setView = (v: "files" | "scm") => {
    useStore.getState().set({ sideView: v });
    localStorage.setItem("sfterm-side-view", v);
  };

  // cerrar el picker con click-fuera o Escape (patron ligero, sin overlay)
  useEffect(() => {
    if (!picker) return;
    const away = (e: MouseEvent) => {
      if (headRef.current && !headRef.current.contains(e.target as Node)) setPicker(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setPicker(false);
      }
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key, true);
    };
  }, [picker]);

  // repos conocidos: presets del config (business-os primero por default) +
  // recientes (localStorage). Dedupe contra el actual y entre si.
  const known: { label: string; root: string; kind: "preset" | "reciente" }[] = [];
  for (const p of config?.presets ?? []) {
    if (p.root) known.push({ label: p.name, root: p.root, kind: "preset" });
  }
  for (const r of recentRoots()) {
    if (!known.some((k) => k.root.replace(/^~/, "") === r.replace(/^~/, "") || k.root === r)) {
      known.push({ label: r.split("/").filter(Boolean).pop() ?? r, root: r, kind: "reciente" });
    }
  }

  // BADGE = CUANTOS archivos cambiados, como VS Code (29 jul, pedido de
  // Daniel: "el numero de changed files aparece en el icono de git").
  // Antes decia "⇡n sin push" o un punto mudo: dos señales distintas peleando
  // por el mismo pixel, y ninguna contestaba la pregunta que uno le hace a
  // ese icono de reojo ("¿cuanto llevo sin commitear?"). El ⇡n sin push no se
  // pierde: vive en la fila de sincronia del panel y en la barra de estado.
  // Cap a "99+" para que el badge no se deforme con un repo recien clonado.
  const dirty = sync?.is_repo ? sync.dirty : 0;
  const badge = dirty > 0 ? (dirty > 99 ? "99+" : String(dirty)) : "";

  return (
    <div className="side-head side-head--tabs" ref={headRef}>
      <button
        className={`side-tab ${view === "files" ? "active" : ""}`}
        title="Archivos"
        onClick={() => setView("files")}
      >
        <IconFiles active={view === "files"} />
      </button>
      <button
        className={`side-tab ${view === "scm" ? "active" : ""}`}
        title={
          `Source Control` +
          (dirty > 0 ? ` — ${dirty} ${dirty === 1 ? "archivo cambiado" : "archivos cambiados"}` : "") +
          (sync?.is_repo && sync.ahead > 0 ? ` · ${sync.ahead} sin push` : "")
        }
        onClick={() => setView("scm")}
      >
        <IconScm active={view === "scm"} />
        {badge && <span className="side-tab-badge">{badge}</span>}
      </button>
      <button
        className="root-pick"
        title={`${treeRoot}\nclick: cambiar de repo`}
        onClick={() => setPicker((v) => !v)}
      >
        <span className="root-name">{rootName}</span>
        <span className="root-chev">▾</span>
      </button>

      {picker && (
        <div className="root-menu">
          {known.map((k) => (
            <div
              key={k.root}
              className={`root-menu-row ${k.root.endsWith(rootName) ? "current" : ""}`}
              title={k.root}
              onClick={() => {
                setPicker(false);
                void actions.setTreeRoot(k.root);
              }}
            >
              <span className="root-menu-name">{k.label}</span>
              <span className="root-menu-kind">{k.kind}</span>
            </div>
          ))}
          <div className="root-menu-hint">otro repo: pega su path en ⌘K — o pidemelo al agente</div>
        </div>
      )}
    </div>
  );
}
