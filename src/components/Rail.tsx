import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, panelTitle } from "../core/store";
import * as actions from "../core/actions";
import * as H from "../core/hist";
import * as ipc from "../core/ipc";
// ⚠️ sortByRail vive en core/cycle.ts, NO aqui: ⌥Tab tiene que recorrer las
// terminales en el MISMO orden que esta lista pinta. Dos copias = arrastras
// una fila y el teclado sigue moviendose por el orden viejo.
import { sortByRail } from "../core/cycle";
import * as T from "../core/tiling";
import { pathBasename } from "../core/path-utils";
import { nativeShortcutText } from "../core/keybinds";

/** Rail del taller — UNA columna estilo Claude Desktop (30 jul 2026):
 *  busqueda + filtros arriba, ACTIVAS (terminales vivas), y el HISTORIAL del
 *  disco agrupado (fecha/proyecto/ninguno) con fijadas. TODAS las secciones
 *  colapsan con su header (chevron, animado); las preferencias del popover
 *  (agrupar/ordenar/proyecto) y los colapsos persisten en localStorage.
 *  Con BUSQUEDA activa el colapso se ignora: buscar y no ver resultados
 *  seria una lista mintiendo. */
export default function Rail() {
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useState<H.HistPrefs>(() => H.histPrefs());
  const [menu, setMenu] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const filterRef = useRef<HTMLButtonElement>(null);

  // AI-first: el gate (conv_prefs) cambia los filtros hablando; este oido
  // sincroniza el componente montado con lo que el agente escribio
  useEffect(() => {
    const ear = () => setPrefs(H.histPrefs());
    window.addEventListener("sfterm:hist-prefs", ear);
    return () => window.removeEventListener("sfterm:hist-prefs", ear);
  }, []);

  const openMenu = () => {
    if (!menu) {
      // proyectos para el filtro: del cache del historial (30s), sin bloquear
      void H.loadHistory().then((cs) => setProjects(H.projectsOf(cs).slice(0, 8)));
    }
    setMenu((m) => !m);
  };

  const filtered = prefs.project != null || prefs.groupBy !== "date" || prefs.sortBy !== "recency";

  return (
    <div id="rail">
      <aside className="chat-side termrail">
        <button
          className="chat-newconv"
          title={nativeShortcutText("Terminal nueva (⌘N)")}
          onClick={() => void actions.gateSpawn({ show: true })}
        >
          + Nueva terminal
        </button>
        <div className="rail-searchrow">
          <input
            className="rail-search"
            type="text"
            placeholder="Buscar conversaciones…"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          <button
            ref={filterRef}
            className={`rail-filter${filtered ? " on" : ""}${menu ? " open" : ""}`}
            title="Filtros del historial (agrupar · ordenar · proyecto)"
            onClick={openMenu}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 6h16M7 12h10M10 18h4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        {menu && (
          <HistMenu
            anchor={filterRef.current}
            prefs={prefs}
            projects={projects}
            onChange={(p) => setPrefs(H.saveHistPrefs(p))}
            onClose={() => setMenu(false)}
          />
        )}
        <div className="rail-scroll">
          <TermList query={query} />
          <HistRail query={query} prefs={prefs} />
        </div>
      </aside>
    </div>
  );
}

/** Header de seccion colapsable (chevron animado + contador al cerrar). */
function SectionHead(props: {
  label: string;
  count: number;
  closed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={`hist-headrow${props.closed ? " closed" : ""}`}
      onClick={props.onToggle}
      title={props.closed ? "Expandir" : "Colapsar"}
    >
      <svg className="hist-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="hist-headlabel">{props.label}</span>
      {props.closed && props.count > 0 && <span className="hist-count">{props.count}</span>}
    </button>
  );
}

/** Cuerpo colapsable SUAVE: grid-template-rows 1fr→0fr (transiciona alto
 *  desconocido sin medirlo — el truco moderno, cero JS de alturas). */
function Collapse(props: { closed: boolean; children: React.ReactNode }) {
  return (
    <div className={`hist-body${props.closed ? " closed" : ""}`}>
      <div className="hist-bodyin">{props.children}</div>
    </div>
  );
}

/** El popover de filtros (estilo Claude Desktop): agrupar · ordenar ·
 *  proyecto. Reusa la piel .histmenu; cierra con Esc o click afuera. */
function HistMenu(props: {
  anchor: HTMLElement | null;
  prefs: H.HistPrefs;
  projects: string[];
  onChange: (p: H.HistPrefs) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && e.target !== props.anchor) props.onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const r = props.anchor?.getBoundingClientRect();
  const style = r ? { top: r.bottom + 6, left: Math.max(8, r.right - 236) } : { top: 90, left: 12 };
  const { prefs } = props;
  const row = (
    label: string,
    on: boolean,
    apply: () => void,
  ) => (
    <button key={label} className={`histmenu-row${on ? " on" : ""}`} onClick={apply}>
      <span className="hist-popcheck">{on ? "✓" : ""}</span>
      <span>{label}</span>
    </button>
  );
  return (
    <div ref={ref} className="histmenu hist-pop" style={style}>
      <div className="histmenu-head">Agrupar por</div>
      {row("Fecha", prefs.groupBy === "date", () => props.onChange({ ...prefs, groupBy: "date" }))}
      {row("Proyecto", prefs.groupBy === "project", () => props.onChange({ ...prefs, groupBy: "project" }))}
      {row("Ninguno", prefs.groupBy === "none", () => props.onChange({ ...prefs, groupBy: "none" }))}
      <div className="histmenu-head">Ordenar por</div>
      {row("Reciente", prefs.sortBy === "recency", () => props.onChange({ ...prefs, sortBy: "recency" }))}
      {row("Título", prefs.sortBy === "title", () => props.onChange({ ...prefs, sortBy: "title" }))}
      <div className="histmenu-head">Proyecto</div>
      {row("Todos", prefs.project == null, () => props.onChange({ ...prefs, project: null }))}
      {props.projects.map((p) =>
        row(p, prefs.project === p, () =>
          props.onChange({ ...prefs, project: prefs.project === p ? null : p }),
        ),
      )}
    </div>
  );
}

/** Umbral antes de considerar que es un drag y no un click (mismo que el
 *  drag del tiling: 6px). Sin esto, un click con el pulso tembloroso
 *  reordenaria en vez de mostrar la terminal. */
const DRAG_THRESHOLD = 6;

function TermList({ query }: { query: string }) {
  const panels = useStore((s) => s.panels);
  const focused = useStore((s) => s.focused);
  const drawerTerms = useStore((s) => s.drawerTerms);
  const railOrder = useStore((s) => s.railOrder);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => H.collapsedLabels());
  // que conversaciones tienen navegador propio (el ala solo se ve dentro de
  // la suya: sin esta marca los demas serian invisibles). ⚠️ useMemo y no un
  // selector: un Set nuevo por lectura jamas es Object.is-igual y repintaria
  // el rail en CADA tick del store (metricas incluidas).
  const treeVersion = useStore((s) => s.treeVersion);
  const rootRef = useStore((s) => s.root);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const conBrowser = useMemo(() => T.ownersConBrowser(rootRef), [rootRef, treeVersion]);
  const listRef = useRef<HTMLDivElement>(null);
  // fila que se esta arrastrando + hueco donde caeria (indice de INSERCION,
  // 0..n, igual que VSCode: la linea vive ENTRE filas)
  const [drag, setDrag] = useState<{ id: number; to: number } | null>(null);

  const all = sortByRail(
    Object.values(panels).filter((p) => !drawerTerms.includes(p.id)),
    railOrder,
  );
  // la busqueda tambien filtra las activas (una sola caja manda en la columna
  // entera); el DRAG opera siempre sobre la lista completa del store
  const q = query.trim().toLowerCase();
  const list = q
    ? all.filter((p) =>
        `${panelTitle(p)} ${pathBasename(p.cwd)}`.toLowerCase().includes(q),
      )
    : all;
  const closed = !q && collapsed.has("Activas");
  // ¿soltar en `drag.to` moveria la fila? Sobre si misma (to === from) o justo
  // debajo (to === from + 1) el resultado es identico — misma condicion que el
  // no-op del `up`, para que la guia y el efecto digan siempre lo mismo.
  const dragFrom = drag ? list.findIndex((p) => p.id === drag.id) : -1;
  const showLine = !!drag && dragFrom >= 0 && drag.to !== dragFrom && drag.to !== dragFrom + 1;

  /** Indice de insercion segun la Y del puntero: se compara contra el CENTRO
   *  de cada fila, que es lo que hace que el hueco se sienta natural. */
  const dropIndexAt = (clientY: number): number => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-rail-id]");
    if (!rows?.length) return 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return rows.length;
  };

  const onRowPointerDown = (e: React.PointerEvent, id: number) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".chat-convdel")) return; // el ✕ es suyo
    const startY = e.clientY;
    const startX = e.clientX;
    let started = false;

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
        started = true;
        document.body.classList.add("dragging");
      }
      setDrag({ id, to: dropIndexAt(ev.clientY) });
    };

    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging");
      setDrag(null);
      if (!started) {
        actions.showTerm(id); // fue un click: mostrar la terminal
        return;
      }
      const cur = sortByRail(
        Object.values(useStore.getState().panels).filter(
          (p) => !useStore.getState().drawerTerms.includes(p.id),
        ),
        useStore.getState().railOrder,
      ).map((p) => p.id);
      const from = cur.indexOf(id);
      let to = dropIndexAt(ev.clientY);
      if (from < 0) return;
      // el hueco se mide sobre la lista CON la fila puesta: al sacarla, todo
      // lo que estaba debajo sube uno
      if (to > from) to -= 1;
      if (to === from) return; // no se movio: no ensuciar el estado
      const next = [...cur];
      next.splice(from, 1);
      next.splice(to, 0, id);
      useStore.getState().set({ railOrder: next });
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="termrail-list" ref={listRef}>
      {all.length > 0 && (
        <SectionHead
          label="Activas"
          count={list.length}
          closed={closed}
          onToggle={() => setCollapsed(new Set(H.toggleCollapsed("Activas")))}
        />
      )}
      <Collapse closed={closed}>
        {list.map((p, i) => (
          <div
            key={p.id}
            data-rail-id={p.id}
            className={[
              "chat-convitem term",
              p.id === focused ? "active" : "",
              drag?.id === p.id ? "dragging" : "",
              // la linea NO se pinta si soltar ahi no moveria nada (sobre la
              // propia fila o justo debajo): una guia que promete un cambio
              // que no ocurre confunde mas de lo que ayuda
              showLine && drag!.to === i ? "drop-before" : "",
              showLine && drag!.to === list.length && i === list.length - 1
                ? "drop-after"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={`${p.cwd} — mostrar la terminal (arrastra para reordenar)`}
            onPointerDown={(e) => onRowPointerDown(e, p.id)}
          >
            <div className="chat-convrow">
              <span className="chat-convtitle">{panelTitle(p)}</span>
              <button
                className="chat-convdel kill"
                title={nativeShortcutText("Cerrar la conversación: mata la terminal y la quita del rail (⌘W)")}
                onClick={(e) => {
                  e.stopPropagation();
                  actions.closePanel(p.id);
                }}
              >
                ✕
              </button>
            </div>
            <div className="chat-convrow sub">
              <span className="chat-convsnip">
                {p.fgName || "zsh"}
                {p.cpu > 5 ? ` · ${p.cpu.toFixed(0)}%` : ""}
              </span>
              {/* El ala del navegador solo se ve dentro de SU conversacion, asi
                  que sin esta marca los otros serian invisibles: el rail dice
                  cuales tienen uno abierto (espejo, no boton). */}
              {conBrowser.has(p.id) && (
                <span className="chat-convglobe" title="Esta conversación tiene un navegador abierto">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18" />
                  </svg>
                </span>
              )}
            </div>
          </div>
        ))}
      </Collapse>
      {!all.length && (
        <div className="termrail-empty">{nativeShortcutText("⌘N abre una terminal")}</div>
      )}
    </div>
  );
}

/** El HISTORIAL: todas las conversaciones del disco (la verdad — sobreviven a
 *  ⌘W, a rebuilds y a la app entera), agrupadas segun las prefs del popover.
 *  Click = leerla en el lector; estrella (hover) = fijar; continuar vive
 *  dentro del lector. Las VIVAS de arriba se excluyen: una lista que se
 *  repite se contradice. */
function HistRail({ query, prefs }: { query: string; prefs: H.HistPrefs }) {
  const [cards, setCards] = useState<H.ConvCard[]>([]);
  const [pinned, setPinned] = useState<Set<string>>(() => H.pinnedSids());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => H.collapsedLabels());
  const [liveSids, setLiveSids] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(30);
  const panels = useStore((s) => s.panels);
  const nPanels = Object.keys(panels).length;

  useEffect(() => {
    let dead = false;
    const refresh = async () => {
      const cs = await H.loadHistory();
      if (dead) return;
      setCards(cs);
      // dedup contra las vivas: el sid real de cada claude corriendo (verdad
      // del piso, no adivinanza). Solo terminales que corren claude — los
      // demas CLIs no tienen adaptador de historial todavia.
      const ids = Object.values(useStore.getState().panels)
        .filter((p) => /claude/i.test(p.fgName ?? ""))
        .map((p) => p.id);
      const sids = new Set<string>();
      for (const id of ids) {
        const info = await ipc.termSession(id).catch(() => null);
        if (info?.sid) sids.add(info.sid);
      }
      if (!dead) setLiveSids(sids);
    };
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [nPanels]);

  const grouped = useMemo(
    () =>
      H.groupHistory(cards, {
        query,
        pinned,
        exclude: liveSids,
        limit,
        nowMs: Date.now(),
        prefs,
      }),
    [cards, query, pinned, liveSids, limit, prefs],
  );

  if (!cards.length) return null;
  if (query && !grouped.sections.length)
    return <div className="hist-empty">sin resultados en el historial</div>;

  return (
    <div className="hist-rail">
      {grouped.sections.map((sec) => {
        // buscar EXPANDE todo: colapsado + resultados ocultos = lista mentirosa
        const closed = !query && collapsed.has(sec.label);
        return (
          <div key={sec.label} className="hist-section">
            <SectionHead
              label={sec.label}
              count={sec.cards.length}
              closed={closed}
              onToggle={() => setCollapsed(new Set(H.toggleCollapsed(sec.label)))}
            />
            <Collapse closed={closed}>
              {sec.cards.map((c) => (
                <div
                  key={c.sid}
                  className="chat-convitem hist"
                  title={`${c.cwd}\nLeer la conversación (continuar desde el lector)`}
                  onClick={() => actions.openHistMirror(c)}
                >
                  <div className="chat-convrow">
                    <span className="chat-convtitle">{c.title ?? "(sin título)"}</span>
                    <button
                      className={`hist-pin${pinned.has(c.sid) ? " on" : ""}`}
                      title={pinned.has(c.sid) ? "Desfijar" : "Fijar arriba"}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPinned(new Set(H.togglePin(c.sid)));
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill={pinned.has(c.sid) ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6">
                        <path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6L12 16.8 6.6 19.6l1.1-6L3.2 9.4l6.1-.8z" />
                      </svg>
                    </button>
                  </div>
                  <div className="chat-convrow sub">
                    <span className="chat-convsnip">{pathBasename(c.cwd)}</span>
                  </div>
                </div>
              ))}
            </Collapse>
          </div>
        );
      })}
      {grouped.hasMore && (
        <button className="hist-more" onClick={() => setLimit((l) => l + 50)}>
          Mostrar más
        </button>
      )}
    </div>
  );
}
