import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../core/store";
import * as ipc from "../core/ipc";
import * as actions from "../core/actions";
import { iconForFile, iconForFolder } from "../core/icons";
import type { DirEntryInfo } from "../core/types";

interface NodeState {
  entries: DirEntryInfo[] | null;
  expanded: boolean;
}

export default function Tree() {
  const treeRoot = useStore((s) => s.treeRoot);
  const treeSel = useStore((s) => s.treeSel);
  const git = useStore((s) => s.git);
  const root = treeRoot;
  const [nodes, setNodes] = useState<Record<string, NodeState>>({});
  const treeRef = useRef<HTMLDivElement>(null);

  const loadDir = useCallback(async (path: string) => {
    try {
      const entries = await ipc.fsListDir(path);
      setNodes((n) => ({
        ...n,
        [path]: { entries, expanded: n[path]?.expanded ?? true },
      }));
    } catch { /* sin permisos */ }
  }, []);

  useEffect(() => {
    if (!root) return;
    setNodes({});
    void loadDir(root);
  }, [root, loadDir]);

  // refresco en vivo: recarga los dirs expandidos afectados
  useEffect(() => {
    const handler = () => {
      setNodes((current) => {
        for (const [path, ns] of Object.entries(current)) {
          if (ns.expanded) void loadDir(path);
        }
        return current;
      });
    };
    window.addEventListener("sfterm:fs-changed", handler);
    return () => window.removeEventListener("sfterm:fs-changed", handler);
  }, [loadDir]);

  // Escape limpia la multi-seleccion — SOLO con el foco realmente en el
  // arbol (document.activeElement === el div #tree, que se enfoca al
  // clickear una fila). Sin este guard, un listener global en window/capture
  // se comeria la primera Escape de CUALQUIER otro consumidor (terminal
  // enfocada, FileFinder, Palette, SearchPanel) apenas hubiera una seleccion
  // viva — el capture+stopPropagation corta el evento antes de llegar a sus
  // handlers en fase bubble.
  useEffect(() => {
    if (treeSel.length === 0) return;
    const h = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (document.activeElement !== treeRef.current) return;
      ev.preventDefault();
      ev.stopPropagation();
      useStore.getState().set({ treeSel: [], treeAnchor: null });
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [treeSel]);

  const rel = (abs: string) =>
    abs.startsWith(treeRoot + "/") ? abs.slice(treeRoot.length + 1) : abs === treeRoot ? "" : abs;

  const gitBadge = (e: DirEntryInfo): { code: string; ignored: boolean } => {
    if (!git?.is_repo) return { code: "", ignored: false };
    const r = rel(e.path);
    if (!r) return { code: "", ignored: false };
    if (git.ignored.some((ig) => r === ig || r.startsWith(ig + "/"))) {
      return { code: "", ignored: true };
    }
    if (e.is_dir) {
      const dirty = Object.keys(git.files).some((f) => f.startsWith(r + "/"));
      return { code: dirty ? "dirty-dot" : "", ignored: false };
    }
    return { code: git.files[r] ?? "", ignored: false };
  };

  const toggleDir = (path: string) => {
    setNodes((n) => {
      const cur = n[path];
      if (cur?.entries && cur.expanded) {
        return { ...n, [path]: { ...cur, expanded: false } };
      }
      if (cur?.entries) {
        return { ...n, [path]: { ...cur, expanded: true } };
      }
      void loadDir(path);
      return { ...n, [path]: { entries: null, expanded: true } };
    });
  };

  // lista PLANA de filas visibles, en el mismo orden que renderDir pinta —
  // misma forma de recursion (mismo guard !ns.expanded) para que ⇧+clic
  // jamas driftee del render real
  const flattenVisible = (): DirEntryInfo[] => {
    const out: DirEntryInfo[] = [];
    const walk = (path: string) => {
      const ns = nodes[path];
      if (!ns?.entries || !ns.expanded) return;
      for (const en of ns.entries) {
        out.push(en);
        if (en.is_dir) walk(en.path);
      }
    };
    if (root) walk(root);
    return out;
  };

  const rangeSelect = (targetPath: string) => {
    const s = useStore.getState();
    const anchor = s.treeAnchor;
    // sin anchor: se comporta como clic normal
    if (!anchor) {
      s.set({ treeSel: [targetPath], treeAnchor: targetPath });
      return;
    }
    const flat = flattenVisible().map((en) => en.path);
    const ai = flat.indexOf(anchor);
    const ti = flat.indexOf(targetPath);
    if (ai < 0 || ti < 0) {
      s.set({ treeSel: [targetPath], treeAnchor: targetPath });
      return;
    }
    const [lo, hi] = ai < ti ? [ai, ti] : [ti, ai];
    s.set({ treeSel: flat.slice(lo, hi + 1) });
  };

  const [menu, setMenu] = useState<{ x: number; y: number; entry: DirEntryInfo } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [menu]);

  const contextMenu = (e: React.MouseEvent, entry: DirEntryInfo) => {
    e.preventDefault();
    e.stopPropagation();
    // clic derecho sobre una fila FUERA de la seleccion la colapsa a esa sola
    // fila (mismo criterio que el drag): asi el menu jamas actua sobre algo
    // que no esta debajo del cursor — el modo de fallar caro seria borrar una
    // seleccion vieja que Daniel ya no ve.
    const s = useStore.getState();
    if (!s.treeSel.includes(entry.path)) {
      s.set({ treeSel: [entry.path], treeAnchor: entry.path });
    }
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  // ---- papelera (estilo VSCode: "Move to Trash", recuperable) ----
  const [trash, setTrash] = useState<{ paths: string[]; errors: string[]; busy: boolean } | null>(
    null,
  );
  const trashBtn = useRef<HTMLButtonElement>(null);
  // se reasigna en cada render (abajo): el listener de teclado llama SIEMPRE
  // a la version fresca, sin re-registrarse
  const doTrashRef = useRef<() => Promise<void>>(async () => {});

  // Esc cancela / Enter confirma. En CAPTURA y con stopPropagation, como el
  // resto de los overlays: si no, la Escape sigue de largo y le cierra el
  // escalon a quien este debajo (lector, preview, drawer).
  useEffect(() => {
    if (!trash) return;
    trashBtn.current?.focus();
    const h = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape" && ev.key !== "Enter") return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === "Escape") setTrash(null);
      else void doTrashRef.current();
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
    // solo la APERTURA importa: re-registrar en cada cambio de `trash`
    // (busy, errors) es ruido, y `doTrash` viaja por ref para no quedar viejo
  }, [trash !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const doTrash = async () => {
    if (!trash || trash.busy) return;
    setTrash({ ...trash, busy: true, errors: [] });
    try {
      const res = await ipc.fsTrash(trash.paths, root);
      // las pestañas del visor que apuntan a lo que se fue se cierran solas
      actions.closeFileTabsUnder(res.trashed);
      const gone = new Set(res.trashed);
      const s = useStore.getState();
      s.set({
        treeSel: s.treeSel.filter((p) => !gone.has(p)),
        treeAnchor: null,
      });
      // FSEvents refresca el arbol solo, pero recargar el padre aqui lo hace
      // instantaneo (el flusher del watcher tiene 350ms de debounce)
      const parents = new Set(res.trashed.map((p) => p.replace(/\/[^/]+$/, "")));
      parents.forEach((p) => void loadDir(p));
      actions.scheduleGitRefresh();
      if (res.errors.length > 0) {
        setTrash({ paths: trash.paths, errors: res.errors, busy: false });
        return;
      }
      setTrash(null);
    } catch (e) {
      setTrash({ paths: trash.paths, errors: [String(e)], busy: false });
    }
  };
  doTrashRef.current = doTrash;

  const renderDir = (path: string, depth: number): React.ReactNode => {
    const ns = nodes[path];
    if (!ns?.entries || !ns.expanded) return null;
    return ns.entries.map((e) => {
      const { code, ignored } = gitBadge(e);
      const expanded = nodes[e.path]?.expanded ?? false;
      const selected = treeSel.includes(e.path);
      return (
        <div key={e.path}>
          <div
            className={`tree-row ${ignored ? "ignored" : ""} ${selected ? "selected" : ""}`}
            style={{ paddingLeft: 6 + depth * 14 }}
            draggable
            onDragStart={(ev) => {
              // fila parte de una seleccion de >1 -> arrastra TODA la
              // seleccion; si no, arrastrar la colapsa a esta sola fila
              // (estilo VSCode: "una fila fuera de la seleccion va sola")
              const s = useStore.getState();
              const multi = s.treeSel.includes(e.path) && s.treeSel.length > 1;
              const paths = multi ? s.treeSel : [e.path];
              if (!multi) s.set({ treeSel: [e.path], treeAnchor: e.path });
              ev.dataTransfer.setData("text/plain", paths.join("\n"));
              ev.dataTransfer.effectAllowed = "copy";
              // los term-slot (fuera de #center) dejan pasar el drag con esta clase
              document.body.classList.add("dragging-file");
            }}
            onDragEnd={() => {
              document.body.classList.remove("dragging-file");
              useStore.getState().set({ dropHint: null });
            }}
            onClick={(ev) => {
              if (ev.metaKey) {
                // toggle en la seleccion: NO abre, NO expande/colapsa
                const s = useStore.getState();
                const sel = s.treeSel.includes(e.path)
                  ? s.treeSel.filter((p) => p !== e.path)
                  : [...s.treeSel, e.path];
                s.set({ treeSel: sel });
                return;
              }
              if (ev.shiftKey) {
                // rango desde el anchor: NO abre, NO expande/colapsa
                rangeSelect(e.path);
                return;
              }
              useStore.getState().set({ treeSel: [e.path], treeAnchor: e.path });
              if (e.is_dir) toggleDir(e.path);
              else actions.openFileTab(e.path, "auto", { preview: true });
            }}
            onDoubleClick={() => {
              // doble clic promueve el preview a permanente (drag ya lo
              // hace desde onDragStart); en carpetas no hay nada que promover
              if (!e.is_dir) actions.promoteFileByPath(e.path);
            }}
            onContextMenu={(ev) => contextMenu(ev, e)}
            title={e.path}
          >
            <img
              className="ficon"
              src={e.is_dir ? iconForFolder(e.name, expanded) : iconForFile(e.name)}
              alt=""
              draggable={false}
            />
            <span className="name">{e.name}</span>
            {code && <span className={`badge ${code}`}>{code === "dirty-dot" ? "●" : code}</span>}
          </div>
          {e.is_dir && renderDir(e.path, depth + 1)}
        </div>
      );
    });
  };

  const menuMulti = menu ? treeSel.includes(menu.entry.path) && treeSel.length > 1 : false;

  return (
    <div
      id="tree"
      ref={treeRef}
      tabIndex={-1}
      onClick={(ev) => {
        // cualquier clic dentro del arbol le da el foco DOM (asi Escape sabe
        // que "el foco esta en el arbol" via document.activeElement)
        treeRef.current?.focus();
        // clic en el vacio (no en una fila): limpia la seleccion
        if (ev.target === ev.currentTarget) {
          useStore.getState().set({ treeSel: [], treeAnchor: null });
        }
      }}
    >
      {root ? renderDir(root, 0) : null}
      {menu && (
        <div
          className="ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="ctx-item"
            onClick={() => { void ipc.revealInFinder(menu.entry.path); setMenu(null); }}
          >
            Revelar en Finder
          </div>
          <div
            className="ctx-item"
            onClick={() => {
              void navigator.clipboard.writeText(menuMulti ? treeSel.join("\n") : menu.entry.path);
              setMenu(null);
            }}
          >
            {menuMulti ? `Copiar ${treeSel.length} paths` : "Copiar path"}
          </div>
          <div
            className="ctx-item"
            onClick={() => {
              void actions.newTerminal(
                menu.entry.is_dir ? menu.entry.path : menu.entry.path.replace(/\/[^/]+$/, ""),
              );
              setMenu(null);
            }}
          >
            Nueva terminal aqui
          </div>
          <div className="ctx-sep" />
          <div
            className="ctx-item danger"
            onClick={() => {
              setTrash({
                paths: menuMulti ? [...treeSel] : [menu.entry.path],
                errors: [],
                busy: false,
              });
              setMenu(null);
            }}
          >
            {menuMulti ? `Eliminar ${treeSel.length} elementos` : "Eliminar"}
          </div>
        </div>
      )}
      {trash && (
        <div className="trash-back" onClick={() => setTrash(null)}>
          <div className="trash-card" onClick={(e) => e.stopPropagation()}>
            <div className="trash-title">
              {trash.paths.length === 1
                ? `¿Eliminar ${trash.paths[0].replace(/^.*\//, "")}?`
                : `¿Eliminar ${trash.paths.length} elementos?`}
            </div>
            <div className="trash-sub">
              Se va a la <b>Papelera</b> — lo recuperas con "Devolver" del Finder.
            </div>
            {trash.errors.length > 0 && (
              <div className="trash-errors">
                {trash.errors.map((err) => (
                  <div key={err}>{err}</div>
                ))}
              </div>
            )}
            <div className="trash-actions">
              <button className="trash-btn" onClick={() => setTrash(null)}>
                Cancelar
              </button>
              <button
                ref={trashBtn}
                className="trash-btn danger"
                disabled={trash.busy}
                onClick={() => void doTrash()}
              >
                {trash.busy ? "Eliminando…" : "Mover a la papelera"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
