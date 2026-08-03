import { useEffect, useRef, useState, type CSSProperties } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useStore, panelTitle } from "./core/store";
import { manager } from "./core/term";
import { compileBindings, isPrimaryEvent, matchBinding, type ShortcutPlatform } from "./core/keys";
import * as actions from "./core/actions";
import * as ipc from "./core/ipc";
import * as tiling from "./core/tiling";
import Tiling from "./components/Tiling";
import Rail from "./components/Rail";
import Tree from "./components/Tree";
import SourceControl from "./components/SourceControl";
import SideHead from "./components/SideHead";
import StatusBar from "./components/StatusBar";
import Palette from "./components/Palette";
import FileFinder from "./components/FileFinder";
import SearchPanel from "./components/SearchPanel";
import Preview from "./components/Preview";
import Settings from "./components/Settings";
import ShortcutsPanel from "./components/ShortcutsPanel";
import FindBar from "./components/FindBar";
import Composer from "./components/Composer";
import Reader from "./components/Reader";
import Drawer from "./components/Drawer";
import ConvReader from "./components/ConvReader";
import PaneResizer, { usePaneWidth } from "./components/PaneResizer";
import { pathBasename } from "./core/path-utils";
import { startGate } from "./core/gate";
import { ACTION_LABEL, isCapturingKeys } from "./core/keybinds";

/** Titulo VIVO del titlebar (18 jul, pedido de Daniel — muere el logo):
 *  lector abierto = el titulo de la conversacion espejada; taller = la
 *  terminal enfocada. */
function WindowTitle(props: { platform: ShortcutPlatform }) {
  const chatOpen = useStore((s) => s.ui.chat);
  const focused = useStore((s) => s.focused);
  const panels = useStore((s) => s.panels);
  const mirror = useStore((s) => s.ui.chatMirror);
  const title =
    (chatOpen && mirror
      ? `✦ ${mirror.title ?? "sesión espejo"}`
      : focused != null && panels[focused]
        ? panelTitle(panels[focused])
        : null) ?? "SFTerm";
  useEffect(() => {
    if (props.platform === "windows") void getCurrentWindow().setTitle(title);
  }, [props.platform, title]);
  if (props.platform === "windows") return null;
  return (
    <span className="brand" title={title}>
      {title}
    </span>
  );
}

/** ¿Esta accion se va a TRAGAR la tecla?
 *
 *  El interceptor de xterm y el handler de window tienen que contestar lo
 *  MISMO, o la tecla se pierde en el aire: el interceptor la bloquea "porque
 *  hay binding" y despues el dispatch decide que no hacia nada, asi que ni
 *  actua ni llega al PTY. Hoy el unico condicional es ⇧Tab (`next_tab`):
 *  con menos de 2 pestañas la tecla es de claude, que la usa para ciclar sus
 *  modos de permiso. Todo lo demas consume siempre — este helper preserva el
 *  comportamiento previo tal cual y solo abre la puerta para el caso nuevo. */
function willConsume(action: string): boolean {
  if (action === "next_tab") return actions.focusedLeafTabCount() > 1;
  return true;
}

export default function App() {
  const booted = useStore((s) => s.booted);
  const railVisible = useStore((s) => s.railVisible);
  const treeVisible = useStore((s) => s.treeVisible);
  const sideView = useStore((s) => s.sideView);
  const dragging = useStore((s) => s.dragging);
  const bindingsVersion = useStore((s) => s.bindingsVersion);
  const platform = (useStore((s) => s.capabilities?.os) ?? "macos") as ShortcutPlatform;
  const bootedRef = useRef(false);
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null);
  // paneles del taller redimensionables (sash VSCode, persisten local).
  // MISMA llave y MISMOS limites que el chat: un solo ancho por panel —
  // cambiar de superficie jamas mueve nada (ChatView usa las mismas llaves)
  const railPane = usePaneWidth("sfterm-w-rail", 264, 180, 440, ["sfterm-w-chatside"]);
  const sidePane = usePaneWidth("sfterm-w-tree", 300, 170, 720, ["sfterm-w-side"]);

  // boot una sola vez (StrictMode-safe)
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    // API para el harness E2E (debug_harness.rs evalua JS via window.__sfterm)
    (window as unknown as Record<string, unknown>).__sfterm = {
      actions,
      store: useStore,
      manager,
      ipc,
      tiling,
    };
    void actions.boot();
    startGate(); // puerta de agentes: state dir local de SFTerm/gate/
    // badge ☰ de un bloque (canvas del motor propio) → abrir Modo Lectura
    window.addEventListener("sfterm:open-reader", ((e: CustomEvent) => {
      useStore.getState().setUI({ reader: e.detail });
    }) as EventListener);
  }, []);

  // keymap global: window (capture) + interceptor de xterm
  useEffect(() => {
    const cfg = useStore.getState().config;
    if (!cfg) return;
    // defaults en codigo (configs viejas sin estas llaves), remapeables en
    // [keys]. Solo acciones del CENSO (keybinds.ts): un config viejo con
    // llaves muertas (cycle_next, split_1) creaba bindings fantasma que se
    // COMIAN la tecla del PTY sin hacer nada (verificacion adversarial 20 jul)
    const known = new Set(Object.keys(ACTION_LABEL));
    const userKeys = Object.fromEntries(
      Object.entries(cfg.keys ?? {}).filter(([k]) => known.has(k)),
    );
    const bindings = compileBindings({
      chat: "primary+l",
      new_chat: "primary+n",
      search_project: "primary+shift+f",
      taller: "primary+alt+t",
      shortcuts: "primary+alt+s",
      next_tab: "shift+tab",
      next_terminal: "alt+tab",
      toggle_theme: "primary+shift+t",
      ...userKeys,
    }, platform);

    const dispatch = (action: string): boolean => {
      const st = useStore.getState();
      // (aqui vivia un "revealing" que cerraba el lector antes de restore_last.
      //  Murio con la misma regla obsoleta de showTerm, 22 jul: restaurar una
      //  terminal encajonada mueve el foco y el lector la sigue. Abrir un
      //  ARCHIVO o crear algo nuevo si revelan el taller — eso vive en las
      //  propias actions, y ahi si corresponde.)
      switch (action) {
        // ⌘J REPURPOSADO (pedido 17 jul): terminal rapida desde ABAJO, en
        // cualquier superficie (estilo VSCode). Terminal en tiling: rail/⌘⌥J.
        case "new_terminal":
          void actions.toggleDrawer();
          return true;
        case "new_conversation": void actions.newConversation(); return true;
        case "close_panel":
          // con el lector abierto, ⌘W lo cierra (mismo destino que Esc) — la
          // terminal de abajo NO se toca: primero sales del lector, y recien
          // el segundo ⌘W cierra la conversacion. Ese escalon es la red de
          // seguridad del gesto ahora que ⌘W mata (ver closeFocusedTab).
          if (st.ui.chat) {
            actions.showChat(false);
            return true;
          }
          actions.closeFocusedTab();
          return true;
        // ⌘⇧E: el campo enfocado se queda con TODA la pantalla (y vuelve). El
        // arbol no se toca — solo se pliegan los demas, asi que contraer
        // devuelve el layout EXACTO (mismo mecanismo del ala del navegador).
        case "expand_leaf":
          st.set({ soloLeaf: st.soloLeaf ? null : st.focusedLeaf });
          return true;
        case "toggle_theme": {
          // ⌘⇧T (pedido 22 jul): alterna papel ⇄ arbrain sin abrir Settings.
          // configSet escribe config.toml -> watcher -> applyConfig re-aplica
          // el tema Y empuja engineSetTheme (OSC 10/11 -> las terminales NUEVAS
          // detectan light/dark; las vivas conservan el suyo de su arranque).
          const cur = st.config?.appearance?.theme;
          const next = cur === "paper" ? "arbrain" : "paper";
          void ipc.configSet([["appearance.theme", next]]);
          return true;
        }
        case "toggle_tree": st.set({ treeVisible: !st.treeVisible }); return true;
        case "toggle_rail": st.set({ railVisible: !st.railVisible }); return true;
        case "focus_left": actions.moveFocus("left"); return true;
        case "focus_right": actions.moveFocus("right"); return true;
        case "focus_up": actions.moveFocus("up"); return true;
        case "focus_down": actions.moveFocus("down"); return true;
        case "dock_panel":
          if (st.focused != null) actions.dockPanel(st.focused);
          return true;
        case "restore_last": actions.restoreLastDocked(); return true;
        // ⇧Tab = siguiente PESTAÑA del campo enfocado (29 jul, pedido de
        // Daniel: "para moverme entre tabs vamos a usar shift+tab").
        //
        // ⚠️ Devuelve FALSE con menos de 2 pestañas, y eso es la feature, no
        // un borde: ⇧Tab es del TUI de claude (ahi cicla los modos de
        // permiso — dice "shift+tab to cycle" en su propio statusline). Con
        // una sola pestaña no hay nada que ciclar, asi que la tecla se le
        // deja al PTY y claude conserva lo suyo. El interceptor de xterm
        // consulta lo MISMO via willConsume: si los dos lados no dijeran
        // igual, la tecla se perderia en el aire (ni cambia de pestaña ni
        // llega al agente).
        case "next_tab": return actions.cycleTab(1);
        // ⌥Tab = siguiente TERMINAL del rail, en el orden que Daniel ve.
        // Reemplaza al VISTAZO, que murio el 29 jul por pedido suyo ("no me
        // sirve, para eso ya uso ⌃Tab"). Tombstone en CLAUDE.md.
        case "next_terminal": return actions.cycleTerminal(1);
        // zoom con criterio: pagina si el navegador esta enfocado, app si no
        case "zoom_in": actions.zoomSmart(1); return true;
        case "zoom_out": actions.zoomSmart(-1); return true;
        case "zoom_reset": actions.zoomSmart("reset"); return true;
        case "search":
          if (st.focused != null) st.setUI({ findbar: true });
          return true;
        case "file_finder": st.setUI({ finder: true, palette: false }); return true;
        case "search_project": st.setUI({ search: true, palette: false, finder: false }); return true;
        case "palette": st.setUI({ palette: true, finder: false }); return true;
        case "settings": case "appearance": st.setUI({ settings: true }); return true;
        // ⌘R: relanzar la app (pedido 20 jul — "recarga esta mierda").
        // Proceso NUEVO: toma el build recien instalado. ANTES de morir se
        // guarda el LAYOUT (el revival de conversaciones murio 21 jul pm
        // por decision de Daniel — tombstone en CLAUDE.md).
        case "reload_app":
          void actions.saveSession().finally(() => void ipc.appRelaunch());
          return true;
        case "composer": st.setUI({ composer: !st.ui.composer }); return true;
        case "chat": {
          // ⌘L = el LECTOR de la terminal enfocada (misma conversacion como
          // chat para leer/escucharla/responder), toggle.
          if (st.ui.chat) {
            st.setUI({ chat: false, chatMirror: null });
            return true;
          }
          // CANDADO + VERDAD ESTRICTA viven en la puerta unica del lector
          // (actions.openReaderFor): el mismo camino que usa el lector para
          // SEGUIR AL FOCO, asi abrir y re-apuntar nunca driftean. No abre
          // sobre shells; sobre claude abre SIEMPRE, aun con 0 mensajes.
          if (st.focused != null) void actions.openReaderFor(st.focused);
          return true;
        }
        case "taller": {
          // ⌃Tab = mismo gesto que ⌘L — abre/cierra el LECTOR de la
          // terminal enfocada. Al cerrar, aterriza en SU terminal.
          if (st.ui.chat) {
            const m = st.ui.chatMirror;
            st.setUI({ chat: false, chatMirror: null });
            if (m?.termId != null && st.panels[m.termId]) actions.showTerm(m.termId);
            return true;
          }
          return dispatch("chat");
        }
        case "shortcuts": st.setUI({ shortcuts: !st.ui.shortcuts }); return true;
        case "new_chat":
          // ⌘N = terminal nueva en el tiling (Warp-style; el agente se abre
          // con ⌘⌥J o tecleando su CLI — cualquier proveedor)
          void actions.gateSpawn({ show: true });
          return true;
        case "toggle_markdown":
          actions.toggleFocusedMarkdownRaw();
          return true;
        case "select_all": {
          // solo cuando el foco esta EN una terminal (no en palette/settings/inputs)
          const ae = document.activeElement;
          const inTerm =
            ae instanceof HTMLElement &&
            (ae.classList.contains("xterm-helper-textarea") ||
              ae.classList.contains("ownterm-input"));
          if (inTerm && st.focused != null) {
            manager.selectAll(st.focused);
            return true;
          }
          return false;
        }
        default: return false;
      }
    };

    const onKey = (e: KeyboardEvent) => {
      // el panel de Atajos esta capturando un combo: NO despachar (⌘W
      // cerraria un panel a media captura)
      if (isCapturingKeys()) return;
      const action = matchBinding(e, bindings);
      if (action) {
        // solo tragar el evento si la accion existe (configs viejas pueden
        // traer bindings muertos como split_1)
        if (dispatch(action)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      // zoom LAYOUT-PROOF por caracter: en latam "+" es la tecla fisica
      // BracketRight y "-" es Slash, asi que los bindings por e.code no bastan.
      // Acepta cmd con +/=/-/0 sin importar shift ni layout.
      if (isPrimaryEvent(e, platform) && !e.altKey) {
        if (e.key === "+" || e.key === "=") {
          e.preventDefault(); e.stopPropagation();
          actions.zoomSmart(1);
          return;
        }
        if (e.key === "-") {
          e.preventDefault(); e.stopPropagation();
          actions.zoomSmart(-1);
          return;
        }
        if (e.key === "0") {
          e.preventDefault(); e.stopPropagation();
          actions.zoomSmart("reset");
          return;
        }
      }
    };
    // interceptor: xterm NO procesa nuestros atajos; el evento burbujea a window
    manager.setKeyInterceptor((e) => {
      if (isCapturingKeys()) return true;
      const a = matchBinding(e, bindings);
      if (a !== null && willConsume(a)) return false;
      if (isPrimaryEvent(e, platform) && !e.altKey && ["+", "=", "-", "0"].includes(e.key)) return false;
      return true;
    });
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [bindingsVersion, platform]);

  // ghost del drag
  useEffect(() => {
    if (!dragging) {
      setGhost(null);
      return;
    }
    const s = useStore.getState();
    let label = "⌁";
    if (dragging.src.kind === "rail") {
      const p = s.panels[dragging.src.ptyId];
      label = `⌁ ${p?.fgName || "terminal"}`;
    } else if (dragging.src.kind === "tab") {
      const leaf = tiling.findLeaf(s.root, dragging.src.leafId);
      const tab = leaf?.tabs[dragging.src.index];
      if (tab?.kind === "term") label = `⌁ ${s.panels[tab.id]?.fgName || "terminal"}`;
      else if (tab?.kind === "file") label = `⌁ ${pathBasename(tab.path)}`;
    }
    setGhost({ x: dragging.x, y: dragging.y, label });
  }, [dragging]);

  return (
    <div id="app">
      {platform === "windows" && <WindowTitle platform={platform} />}
      {/* titlebar vivo (18 jul): el TITULO de la conversacion/terminal activa
          en vez del logo (pedido de Daniel). ⌃Tab taller · ⌘L superficie ·
          ⌘⌥S atajos */}
      {platform === "macos" && <div id="titlebar" data-tauri-drag-region>
        {/* toggle del arbol junto a los semaforos (estilo T3/Arc, 28 jul).
            Gesto de VISTA (permitido): mismo destino que ⌘B. Es un <button>,
            asi que el drag-region no lo captura y el drag de la ventana vive */}
        <button
          className="icon-btn tb-side-toggle"
          title={`Árbol (⌘B) — ${treeVisible ? "ocultar" : "mostrar"}`}
          onClick={() => useStore.getState().set({ treeVisible: !treeVisible })}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
            {treeVisible ? (
              <rect x="10" y="4" width="3" height="8" rx="0.8" fill="currentColor" />
            ) : (
              <path d="M10.5 4.5v7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            )}
          </svg>
        </button>
        <WindowTitle platform={platform} />
        <button
          className="icon-btn gear"
          title="Configuración (⌘,)"
          onClick={() => useStore.getState().setUI({ settings: true })}
        >
          ⚙
        </button>
      </div>}
      <div id="main" style={{ "--rail-w": `${railPane.w}px` } as CSSProperties}>
        {railVisible && (
          <>
            <Rail />
            <PaneResizer pane={railPane} dir={1} />
          </>
        )}
        <Tiling />
        {treeVisible && (
          <>
            <PaneResizer pane={sidePane} dir={-1} />
            <aside id="side" style={{ width: sidePane.w }}>
              <SideHead />
              {sideView === "scm" ? <SourceControl /> : <Tree />}
            </aside>
          </>
        )}
      </div>
      <Composer />
      {/* Reader DESPUES de ConvReader: mismo z-index (80), el hermano
          posterior pinta encima — "Leer ultimo bloque" gana al lector */}
      <ConvReader />
      <Reader />
      <Drawer />
      <StatusBar />
      <Palette />
      <FileFinder />
      <SearchPanel />
      <Preview />
      <Settings />
      <ShortcutsPanel />
      <FindBar />
      {ghost && (
        <div className="drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
          {ghost.label}
        </div>
      )}
      {!booted && (
        <div className="overlay-back" style={{ background: "var(--bg)" }}>
          <span style={{ color: "var(--dim)", marginTop: "30vh" }}>SFTerm</span>
        </div>
      )}
    </div>
  );
}
