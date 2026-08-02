import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as ipc from "./ipc";
import * as autofit from "./autofit";
import * as L from "./links";
import { manager } from "./term";
import { useStore, panelTitle } from "./store";
import { isAgentTerminal, isClaudeTerminal } from "./agents";
import * as H from "./hist";
import * as P from "./providers";
import * as T from "./tiling";
import * as C from "./cycle";
import type { LeafNode, Side, TabItem, TilingNode } from "./tiling";
import type {
  AppConfig,
  Preset,
  SessionData,
  SessionDataV1,
  SysTick,
  Theme,
} from "./types";

const st = () => useStore.getState();

// ---------- config / tema ----------

export function activeTheme(cfg: AppConfig): Theme {
  const name = cfg.appearance?.theme ?? "titanium";
  const t = cfg.themes?.[name] ?? Object.values(cfg.themes ?? {})[0];
  return t;
}

export function applyConfig(cfg: AppConfig) {
  const theme = activeTheme(cfg);
  const r = document.documentElement.style;
  r.setProperty("--bg", theme.bg);
  r.setProperty("--panel", theme.bg_panel);
  r.setProperty("--rail", theme.bg_rail);
  r.setProperty("--status", theme.bg_status);
  r.setProperty("--fg", theme.fg);
  r.setProperty("--dim", theme.fg_dim);
  r.setProperty("--accent", theme.accent);
  r.setProperty("--border", theme.border);
  r.setProperty("--green", theme.green);
  r.setProperty("--red", theme.red);
  r.setProperty("--yellow", theme.yellow);
  r.setProperty("--ui-font", `"${cfg.appearance.ui_font}", -apple-system, sans-serif`);
  r.setProperty("--ui-size", `${cfg.appearance.ui_font_size}px`);
  r.setProperty("--term-font", `"${cfg.appearance.terminal_font}"`);
  // zoom de pagina completa (WKWebView pageZoom): escala TODA la app
  void getCurrentWebview().setZoom(cfg.appearance.zoom ?? 1.0);
  // el engine responde OSC 10/11/4 con el tema real (deteccion light/dark de CLIs)
  void ipc.engineSetTheme(theme.fg, theme.bg_panel, theme.ansi ?? []).catch(() => {});
  manager.applyAppearance(cfg, theme);
  st().set({ config: cfg, theme, bindingsVersion: st().bindingsVersion + 1 });
}

// ---------- zoom de APP completa, estilo VSCode (persiste en config.toml) ----------

let zoomTimer: ReturnType<typeof setTimeout> | null = null;
let zoomPending: number | null = null;

export function zoomApp(delta: number | "reset") {
  const cfg = st().config;
  if (!cfg) return;
  const cur = zoomPending ?? cfg.appearance.zoom ?? 1.0;
  const next =
    delta === "reset"
      ? 1.0
      : Math.min(2.0, Math.max(0.6, Math.round((cur + delta * 0.1) * 10) / 10));
  zoomPending = next;
  cfg.appearance.zoom = next;
  // feedback INMEDIATO (pageZoom escala toda la pagina; el resize reflowea
  // las terminales via fit); el write a config va con debounce
  void getCurrentWebview().setZoom(next);
  if (zoomTimer) clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => {
    const v = zoomPending;
    zoomPending = null;
    if (v != null) void ipc.configSet([["appearance.zoom", v]]);
  }, 350);
}

/** ⌘+/−/0 con criterio (30 jul 2026, bug de Daniel: "cmd+/- no hace zoom como
 *  un navegador normal"): si el campo enfocado esta MOSTRANDO el navegador, el
 *  zoom es de la PAGINA; si no, de la app (layout, como VSCode). El caso "foco
 *  DENTRO del sitio" no pasa por aqui — lo captura el hook de la pagina y el
 *  chrome lo drena — asi que este cubre el resto: omnibox, chrome, el ala
 *  recien clickeada. */
export function zoomSmart(delta: number | "reset") {
  const s = st();
  const leaf = s.focusedLeaf ? T.findLeaf(s.root, s.focusedLeaf) : null;
  const act = leaf ? T.activeTab(leaf) : null;
  if (act?.kind === "browser") {
    if (delta === "reset") {
      void ipc.browserZoom(act.id, 1);
      autofit.manual(act.id, 1); // vuelve al ajuste automatico
    } else {
      autofit.step(act.id, delta * 0.1);
    }
    return;
  }
  zoomApp(delta);
}

// ---------- superficies (chat-first) ----------

/** Cambia de superficie: home (la conversacion) <-> taller (terminales).
 *  Al volver al taller, la terminal enfocada recupera el foco DOM (el guard
 *  de manager.focus lo bloquea mientras el chat esta abierto). */
export function showChat(open: boolean) {
  st().setUI({ chat: open });
  if (!open) {
    // el espejo es de la superficie chat: al salir al taller no queda colgado
    if (st().ui.chatMirror) st().setUI({ chatMirror: null });
    const f = st().focused;
    if (f != null && manager.get(f)) manager.focus(f);
  }
}

/** PUERTA UNICA del lector: abre (⌃Tab/⌘L) o RE-APUNTA (el lector siguiendo
 *  al foco, 22 jul) el espejo a la conversacion de UNA terminal. Vive aqui y
 *  no en el keymap para que las condiciones existan en UN solo lugar:
 *   - nunca sobre las terminales del drawer (flotan, tienen su propio dueño)
 *   - CANDADO: solo sobre un CLI agentico (`agents.isAgentTerminal`: lista
 *     `[general] agent_procs`, matcheada contra proceso Y titulo), jamas
 *     sobre un shell pelado
 *   - DOS FUENTES, segun el agente:
 *     · Claude Code → TRANSCRIPT. VERDAD ESTRICTA: la sesion la decide
 *       `term_session` en Rust (nacimiento / argv / titulo) y el PATH lo
 *       computa Rust (respeta CLAUDE_CONFIG_DIR: el jsonl de bro vive en
 *       ~/.claude-bro, jamas reconstruirlo aqui). Claude vivo sin jsonl
 *       todavia (0 mensajes) = "conversacion nueva": path null y el watcher
 *       del lector engancha cuando la sesion nace.
 *     · Cualquier otro CLI → PANTALLA (`engine_text`). Sin modelo ni ctx
 *       (no hay de donde sacarlos honestamente), pero con la respuesta
 *       legible y la barra para escribirle. El engine parsea VT SIEMPRE
 *       (el tee), con cualquier renderer, asi que esto funciona igual en
 *       "dom" que en "own".
 *  Devuelve false si la terminal NO califica; el que llama decide que hacer
 *  (⌃Tab no abre; el lector abierto se retira). */
export async function openReaderFor(id: number): Promise<boolean> {
  const s0 = st();
  const p0 = s0.panels[id];
  if (!p0 || s0.drawerTerms.includes(id)) return false;
  if (!isAgentTerminal(p0, s0.config)) return false;

  // ── agente SIN transcript conocido: espejo de PANTALLA, sin ida a Rust
  if (!isClaudeTerminal(p0)) {
    st().setUI({
      chatMirror: { path: null, src: "screen", termId: id, cwd: p0.cwd, title: panelTitle(p0) },
    });
    showChat(true);
    return true;
  }

  let info: Awaited<ReturnType<typeof ipc.termSession>> = null;
  for (let i = 0; i < 2 && !info; i++) {
    info = await ipc.termSession(id).catch(() => null);
    if (!info) await new Promise((r) => setTimeout(r, 400));
  }
  // el foco pudo moverse otra vez mientras Rust resolvia: el ULTIMO manda
  const s = st();
  if (s.focused !== id || !s.panels[id]) return false;
  const cwd = s.panels[id].cwd;
  s.setUI({
    chatMirror: info
      ? {
          path: info.path,
          src: "transcript",
          termId: id,
          sid: info.sid,
          cwd,
          ...(info.config_dir ? { cfg: info.config_dir } : {}),
        }
      : { path: null, src: "transcript", termId: id, cwd },
  });
  showChat(true);
  return true;
}

/** Abre el ESPEJO de una sesion del HISTORIAL (sin terminal dueña): el lector
 *  a pantalla completa (usePanelBox sin termId → box null → fullscreen), solo
 *  lectura + la barra de CONTINUAR. `focused: null` a proposito — es la misma
 *  situacion que un tab de archivo ("el lector se queda donde estaba"): el
 *  efecto seguir-al-foco del lector no se dispara al abrir, y en cuanto Daniel
 *  enfoca una terminal (rail, click) el MISMO efecto re-apunta o retira el
 *  espejo. Cero reglas nuevas de reveal. */
export function openHistMirror(card: H.ConvCard) {
  const s = st();
  s.set({ focused: null });
  s.setUI({
    chatMirror: {
      path: card.path,
      src: "transcript",
      sid: card.sid,
      cwd: card.cwd,
      ...(card.title ? { title: card.title } : {}),
      ...(card.configDir ? { cfg: card.configDir } : {}),
    },
  });
  showChat(true);
}

/** CONTINUAR una conversacion del historial: terminal NUEVA con el comando de
 *  resume del proveedor (gesto explicito SIEMPRE — el revival automatico
 *  murio el 21 jul y sigue muerto). El lector abierto se re-apunta solo (la
 *  terminal nueva toma el foco → efecto seguir-al-foco → verdad por argv).
 *  `text` opcional viaja con entrega verificada cuando el agente este listo. */
export async function continueHist(card: H.ConvCard, text?: string) {
  const cfg = st().config!;
  const base = cfg.general.agent_command ?? "claude --dangerously-skip-permissions";
  const command = P.providerOf(card).resumeCommand(card, base);
  const id = await spawnPanel({
    cwd: card.cwd || undefined,
    command,
    target: { at: "auto" },
  });
  if (text?.trim()) {
    const t = text.trim();
    void (async () => {
      // esperar el PROMPT VACIO del TUI resumido antes de entregar (25s cap;
      // sin atPrompt del proveedor, sendWhenReady se defiende solo)
      const listo = P.providerOf(card).atPrompt;
      if (listo) {
        for (let i = 0; i < 50; i++) {
          await new Promise((r) => setTimeout(r, 500));
          if (!manager.get(id)) return; // murio antes de despertar
          const tail = await ipc.engineText(id, 10).catch(() => "");
          if (listo(tail)) break;
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      await sendWhenReady(id, t).catch((e) => {
        // nunca silencio: un turno perdido sin rastro es el peor modo de fallar
        console.error("continuar-historial: el texto no se entrego:", e);
      });
    })();
  }
  return id;
}

// ---------- helpers de arbol ----------

/** El campo donde va a aparecer una terminal que se muestra desde el rail.
 *
 *  ⚠️ JAMAS devuelve el ala del navegador (un campo con navegadores dentro):
 *  meter ahi una terminal revuelve dos conversaciones en un panel — el bug
 *  que Daniel vio como "le doy clic y se pasa a la derecha". */
function focusedTermLeaf(): LeafNode | null {
  const s = st();
  const esAla = (l: LeafNode) => l.tabs.some((t) => t.kind === "browser");
  const leaf = s.focusedLeaf ? T.findLeaf(s.root, s.focusedLeaf) : null;
  if (leaf && !esAla(leaf) && T.activeTab(leaf)?.kind === "term") return leaf;
  // primer leaf cuyo tab activo sea terminal
  for (const l of T.leaves(s.root)) {
    if (!esAla(l) && T.activeTab(l)?.kind === "term") return l;
  }
  return null;
}

/** Enfoca el tab activo de un leaf (term -> xterm focus; file -> foco logico). */
export function focusLeaf(leafId: string) {
  const leaf = T.findLeaf(st().root, leafId);
  if (!leaf) return;
  const tab = T.activeTab(leaf);
  st().set({ focusedLeaf: leafId });
  if (tab?.kind === "term") {
    manager.focus(tab.id); // setea focused + limpia attention
    // el ala del navegador sigue a la conversacion: se abre la de ESTA (o no
    // se abre ninguna y la terminal se queda con la pantalla entera)
    syncBrowserSlot();
  } else {
    manager.blurAll();
    // ⚠️ CLICKEAR EL NAVEGADOR NO CAMBIA DE CONVERSACION. `focused` es quien
    // manda cual ala se pinta: si se pusiera en null aqui, el navegador
    // desapareceria justo al tocarlo (su dueño dejaria de ser el enfocado).
    // Usarlo ES estar en su conversacion.
    const dueño = tab?.kind === "browser" ? tab.owner : undefined;
    st().set({ focused: dueño != null && st().panels[dueño] ? dueño : null });
  }
}

export function activateTabAt(leafId: string, index: number) {
  const root = T.mapActivate(st().root, leafId, index);
  st().setRoot(root);
  focusLeaf(leafId);
  scheduleSessionSave();
}

/** ¿El campo enfocado tiene pestañas que ciclar? Lo consulta el keymap ANTES
 *  de tragarse ⇧Tab: con una sola pestaña la tecla tiene que llegar al PTY
 *  (en claude cicla los modos de permiso). Ver App.tsx::willConsume. */
export function focusedLeafTabCount(): number {
  return visibleTabIndices().length;
}

/** Los indices de las pestañas que Daniel VE en el campo enfocado.
 *
 *  ⚠️ No es lo mismo que `leaf.tabs`: los navegadores de OTRAS conversaciones
 *  siguen vivos en el arbol pero no se pintan (el slot muestra uno a la vez).
 *  Si ⇧Tab ciclara sobre la lista cruda, se detendria en pestañas invisibles y
 *  parecerian pulsaciones muertas — y con una sola pestaña real mas un
 *  navegador ajeno, ⇧Tab se tragaria la tecla que le toca a claude. */
function visibleTabIndices(): number[] {
  const s = st();
  const leaf = s.focusedLeaf ? T.findLeaf(s.root, s.focusedLeaf) : null;
  return leaf ? C.visibleTabs(leaf.tabs, s.focused) : [];
}

/** ⇧Tab: siguiente PESTAÑA del campo enfocado. false = no habia que ciclar
 *  (0 o 1 pestaña) y el que llama deja pasar la tecla. */
export function cycleTab(dir: 1 | -1 = 1): boolean {
  const s = st();
  const leaf = s.focusedLeaf ? T.findLeaf(s.root, s.focusedLeaf) : null;
  if (!leaf) return false;
  // se cicla sobre lo VISIBLE, no sobre leaf.tabs (ver visibleTabIndices)
  const vis = visibleTabIndices();
  const here = vis.indexOf(leaf.active);
  const step = C.stepIndex(vis.length, here < 0 ? 0 : here, dir);
  if (step == null) return false;
  activateTabAt(leaf.id, vis[step]);
  return true;
}

/** ⌥Tab: siguiente TERMINAL del rail, en el orden que Daniel ve (el manual
 *  incluido). `showTerm` hace el resto — y como NO revela el taller, el
 *  lector abierto la sigue y se re-apunta solo (regla de reveal, 22 jul). */
export function cycleTerminal(dir: 1 | -1 = 1): boolean {
  const s = st();
  const ordered = C.cyclableTerms(s.panels, s.drawerTerms, s.railOrder);
  const id = C.nextTermId(ordered, s.focused, dir);
  if (id == null) return false;
  showTerm(id);
  return true;
}

// ---------- spawn / close ----------

type SpawnTarget =
  | { at: "dock" }
  | { at: "drawer" } // pool propio z-85 (⌘J): jamas entra al tiling ni al dock
  | { at: "tab"; leafId: string; index?: number }
  | { at: "side"; leafId: string; side: Side }
  | { at: "auto" }; // tab en el leaf de terminal enfocado; sin arbol -> fullscreen

async function spawnPanel(opts: {
  cwd?: string;
  command?: string;
  target: SpawnTarget;
}): Promise<number> {
  const cfg = st().config!;
  const theme = st().theme!;
  const floating = opts.target.at === "drawer";
  const entry = manager.create(cfg, theme, floating ? "drawer" : "main");
  let spawnedId: number | null = null;
  const id = await ipc.ptySpawn({
    cwd: opts.cwd,
    command: opts.command,
    cols: 80,
    rows: 24,
    scrollback: cfg.general?.scrollback ?? 8000,
    shellIntegration: cfg.general?.shell_integration !== false,
    onData: (d) =>
      manager.feed(
        (spawnedId != null ? manager.get(spawnedId) : undefined) ?? entry,
        d,
      ),
  });
  spawnedId = id;
  manager.register(id, entry);

  const meta = {
    id,
    title: "",
    fgName: "",
    cwd: opts.cwd ?? "",
    cpu: 0,
    attention: null,
    exited: false,
  };
  const panels = { ...st().panels, [id]: meta };
  st().set({ panels });

  const tab: TabItem = { kind: "term", id };
  const t = opts.target;
  if (t.at === "dock") {
    st().set({ dock: [...st().dock, id] });
    manager.hide(id);
  } else if (t.at === "drawer") {
    manager.hide(id); // el host (Drawer) la pinta con place directo
  } else if (t.at === "side") {
    const { root, newLeafId } = T.splitLeaf(st().root, t.leafId, t.side, tab);
    st().setRoot(root);
    if (newLeafId) st().set({ focusedLeaf: newLeafId });
    requestAnimationFrame(() => manager.focus(id));
  } else if (t.at === "tab") {
    st().setRoot(T.insertTab(st().root, t.leafId, tab, t.index));
    st().set({ focusedLeaf: t.leafId });
    requestAnimationFrame(() => manager.focus(id));
  } else {
    // auto (modelo VSCode, regla de Daniel 15 jul): la terminal nueva TOMA el
    // campo enfocado COMPLETO; la anterior queda viva en la lista de
    // conversaciones. Los splits existen SOLO si el usuario arrastra.
    const leaf = focusedTermLeaf();
    if (leaf) {
      const act = T.activeTab(leaf)!;
      const root = T.mapReplaceTab(st().root, leaf.id, leaf.active, tab);
      if (act.kind === "term") {
        const dock = st().dock.includes(act.id) ? st().dock : [...st().dock, act.id];
        st().set({ dock });
        manager.hide(act.id);
      }
      st().set({ focusedLeaf: leaf.id });
      st().setRoot(root);
    } else if (st().root) {
      // hay arbol pero sin leaf de terminal (solo archivos): terminal a la izquierda
      const first = T.leaves(st().root)[0];
      const { root, newLeafId } = T.splitLeaf(st().root, first.id, "left", tab);
      st().setRoot(root);
      if (newLeafId) st().set({ focusedLeaf: newLeafId });
    } else {
      const leafNew = T.makeLeaf([tab]);
      st().setRoot(leafNew);
      st().set({ focusedLeaf: leafNew.id });
    }
    requestAnimationFrame(() => manager.focus(id));
  }
  scheduleSessionSave();
  return id;
}

export async function newTerminal(cwd?: string) {
  // pediste una terminal → se tiene que VER (revela el taller si el chat tapa)
  if (st().ui.chat) showChat(false);
  return spawnPanel({ cwd: cwd ?? st().treeRoot, target: { at: "auto" } });
}

/** DRAWER ⌘J (estilo VSCode, 17 jul): terminal rapida que SUBE desde abajo,
 *  disponible en AMBAS superficies (su pool z-86 pinta sobre el chat z-80).
 *  MULTI-TERMINAL: tabs en la cabecera, `+` abre otra, solo la activa se ve.
 *  Ocultar el drawer NO mata nada (como VSCode). */
export async function toggleDrawer() {
  const s = st();
  if (s.ui.drawer) {
    s.setUI({ drawer: false });
    for (const tid of s.drawerTerms) manager.hide(tid);
    // regresar el teclado a donde estaba
    const f = s.focused;
    if (!s.ui.chat && f != null && !s.drawerTerms.includes(f) && manager.get(f)) manager.focus(f);
    return;
  }
  // podar tabs cuya terminal ya no existe antes de decidir la activa
  const terms = s.drawerTerms.filter((t) => manager.get(t));
  let id = s.drawerTermId != null && terms.includes(s.drawerTermId)
    ? s.drawerTermId
    : (terms[terms.length - 1] ?? null);
  if (id == null) {
    id = await spawnPanel({ cwd: s.treeRoot, target: { at: "drawer" } });
    terms.push(id);
  }
  // el FOCO lo da el efecto del Drawer tras place() (aqui el slot aun esta
  // display:none y focus() no aterrizaria)
  st().set({ drawerTerms: terms, drawerTermId: id });
  st().setUI({ drawer: true });
}

/** `+` del drawer: OTRA terminal como tab (multi-terminal estilo VSCode). */
export async function newDrawerTerm() {
  const id = await spawnPanel({ cwd: st().treeRoot, target: { at: "drawer" } });
  const s = st();
  s.set({
    drawerTerms: [...s.drawerTerms.filter((t) => manager.get(t) && t !== id), id],
    drawerTermId: id,
  });
  return id;
}

/** Cambiar de tab en el drawer: el efecto del Drawer oculta la anterior,
 *  ancla la nueva y le da el foco — aqui solo el estado. */
export function setDrawerActive(id: number) {
  const s = st();
  if (!s.drawerTerms.includes(id) || !manager.get(id)) return;
  if (s.drawerTermId === id) return;
  s.set({ drawerTermId: id });
}

/** ⌘⌥J: terminal nueva CON el agente adentro (config general.agent_command
 *  — claude por default, cualquier CLI). En warp la conversacion nace y vive
 *  en su terminal; el lector ⌃Tab es su otra cara. */
export async function newConversation(cwd?: string) {
  if (st().ui.chat) showChat(false);
  const cfg = st().config!;
  return spawnPanel({
    cwd: cwd ?? st().treeRoot,
    command: cfg.general.agent_command,
    target: { at: "auto" },
  });
}

export function closePanel(id: number) {
  const wasFocused = st().focused === id;
  const wasDrawer = st().drawerTerms.includes(id);
  void ipc.ptyKill(id);
  manager.dispose(id);
  const panels = { ...st().panels };
  delete panels[id];
  // SU navegador muere con ella. Un WKWebView es un proceso completo: dejarlo
  // vivo sin dueño seria un huerfano invisible comiendo RAM, y ademas quedaria
  // reclamable por otra conversacion (owner undefined), que es justo lo que
  // este diseño vino a evitar.
  const mine = T.browserIdOf(st().root, id);
  let root = T.removeTab(st().root, (t) => t.kind === "term" && t.id === id);
  if (mine != null) {
    void ipc.browserClose(mine);
    root = T.removeTab(root, (t) => t.kind === "browser" && t.id === mine);
    const bm = { ...st().browserMeta };
    delete bm[mine];
    st().set({ browserMeta: bm });
  }
  const dock = st().dock.filter((d) => d !== id);
  const focused = wasFocused ? null : st().focused;
  st().set({ panels, dock, focused });
  st().setRoot(root);
  // si era tab del drawer (✕ del tab o shell muerta): activar la vecina;
  // sin tabs restantes, el drawer se cierra solo
  const s = st();
  if (s.drawerTerms.includes(id)) {
    const idx = s.drawerTerms.indexOf(id);
    const rest = s.drawerTerms.filter((t) => t !== id);
    const next = s.drawerTermId === id
      ? (rest[Math.min(idx, rest.length - 1)] ?? null)
      : s.drawerTermId;
    s.set({ drawerTerms: rest, drawerTermId: next });
    // el foco a la vecina lo da el efecto del Drawer (termId cambio)
    if (s.ui.drawer && next == null) s.setUI({ drawer: false });
  }
  // ATERRIZAR EL FOCO (22 jul 2026): cerrar era un gesto de raton en el rail,
  // asi que quedarse sin foco pasaba desapercibido. Con ⌘W cerrando de verdad
  // es el camino NORMAL, y dejar `focused: null` deja el teclado huerfano (y al
  // lector, que sigue al foco, apuntando a nada). Se enfoca la vecina: el tab
  // activo del leaf enfocado — `removeTab` ya recalculo `active` — o, si ese
  // leaf murio con ella, el primer leaf que tenga terminal.
  if (wasFocused && !wasDrawer) {
    const s2 = st();
    const leaf =
      (s2.focusedLeaf ? T.findLeaf(s2.root, s2.focusedLeaf) : null) ??
      T.leaves(s2.root).find((l) => T.activeTab(l)?.kind === "term") ??
      null;
    if (leaf) focusLeaf(leaf.id);
  }
  scheduleSessionSave();
}

/** Cierra un tab. Terminal -> CIERRA la conversacion de verdad: mata el proceso
 *  y la saca del rail, igual que el ✕ del rail (firmado por Daniel el 22 jul
 *  2026: "quitarla del historial, como si presionara la x"). Archivo -> se quita.
 *  Esconder una terminal SIN matarla sigue existiendo: es ⌘D (`dockPanel`). */
export function closeTab(leafId: string, index: number) {
  const leaf = T.findLeaf(st().root, leafId);
  const tab = leaf?.tabs[index];
  if (!leaf || !tab) return;
  if (tab.kind === "term") {
    // ⚠️ LA PESTAÑA NO MATA (29 jul 2026, correccion de Daniel: "si cierro la
    // tab se cierra la conversacion... no deberia ser asi! la terminal solo
    // se cierra dando clic en la x de la izquierda"). Cerrar una pestaña es
    // un gesto de VISTA: la conversacion sale del campo pero sigue VIVA en el
    // rail. Matar de verdad es la ✕ del rail (closePanel). Un gesto de vista
    // que mata un proceso es irreversible disfrazado de reversible.
    dockPanel(tab.id);
    return;
  }
  if (tab.kind === "browser") {
    void ipc.browserClose(tab.id);
    const browserMeta = { ...st().browserMeta };
    delete browserMeta[tab.id];
    st().set({ browserMeta });
    st().setRoot(
      T.removeTab(st().root, (t, l) => l.id === leafId && t.kind === "browser" && t.id === tab.id),
    );
    scheduleSessionSave();
    return;
  }
  const root = T.removeTab(
    st().root,
    (t, l) => l.id === leafId && t.kind === "file" && t.path === tab.path,
  );
  st().setRoot(root);
  scheduleSessionSave();
}

/** ⌘W = EXACTAMENTE el ✕ del RAIL (firmado por Daniel el 22 jul 2026, tarde:
 *  "cerrar no solo la pestaña o terminal, si no en general esa conversacion
 *  quitarla del historial, como si presionara la x"). Enmienda la regla de la
 *  mañana ("⌘W jamas mata") porque dejaba el rail llenandose de conversaciones
 *  que Daniel creia cerradas.
 *  Esconder una terminal SIN matarla no se pierde: es ⌘D (`dockPanel`,
 *  "encajonar"), y ⌘⇧D la trae de vuelta. Un gesto por intencion.
 *  Sobre un tab de ARCHIVO ⌘W sigue siendo cerrar el archivo (no mata nada);
 *  sobre el drawer (⌘J), cerrar su pestaña. */
export function closeFocusedTab() {
  const s = st();
  // el drawer tiene el foco: cerrar ESA. Sin este guard, focusedLeaf sigue
  // apuntando al arbol (leafOfTerm no encuentra las del drawer) y ⌘W
  // dockearia la terminal EQUIVOCADA, la del tiling que quedo debajo.
  if (s.focused != null && s.drawerTerms.includes(s.focused)) {
    closePanel(s.focused);
    return;
  }
  const leaf = s.focusedLeaf ? T.findLeaf(s.root, s.focusedLeaf) : null;
  if (leaf) {
    closeTab(leaf.id, leaf.active);
    return;
  }
  if (s.focused != null) closePanel(s.focused);
}

// ---------- dock / show / move ----------

export function dockPanel(id: number) {
  const root = T.removeTab(st().root, (t) => t.kind === "term" && t.id === id);
  const dock = st().dock.includes(id) ? st().dock : [...st().dock, id];
  st().set({ dock, lastDocked: id });
  st().setRoot(root);
  manager.hide(id);
  scheduleSessionSave();
}

/** Muestra una terminal: si esta en el arbol la enfoca; si esta dockeada,
 *  REEMPLAZA la terminal activa del leaf enfocado (la desplazada va al dock). */
export function showTerm(id: number) {
  // GUARD (bug 19 jul): las terminales del DRAWER (pool flotante) JAMAS
  // entran al tiling — su div vive en #term-pool-drawer (z-86) y el tiling
  // la dejaria PINTADA encima del chat para siempre. Se muestran en su dueño.
  const s0 = st();
  if (s0.drawerTerms.includes(id)) {
    s0.set({ drawerTermId: id });
    if (!s0.ui.drawer) s0.setUI({ drawer: true });
    return;
  }
  // El lector NO se cierra aqui (22 jul 2026). La regla vieja era "mostrar una
  // terminal = quererla VER, asi que revela el taller", y tenia sentido cuando
  // el lector tapaba la pantalla entera. Hoy vive DENTRO del panel y SIGUE AL
  // FOCO: mostrar una terminal solo mueve el foco, y el lector se re-apunta
  // solo a la conversacion de esa terminal (el efecto de ConvReader escucha
  // `focused`, que `focusLeaf`/`manager.focus` setean mas abajo). Si la
  // terminal destino NO es un agente, ese mismo efecto retira el lector — o
  // sea el taller igual aparece cuando de verdad corresponde.
  const s = st();
  const inTree = T.leafOfTerm(s.root, id);
  if (inTree) {
    const idx = inTree.tabs.findIndex((t) => t.kind === "term" && t.id === id);
    activateTabAt(inTree.id, idx);
    return;
  }
  let dock = s.dock.filter((d) => d !== id);
  const leaf = focusedTermLeaf();
  const tab: TabItem = { kind: "term", id };
  if (leaf) {
    const act = T.activeTab(leaf)!;
    // swap: la activa se va al dock, la nueva toma su lugar
    let root = st().root;
    root = T.mapReplaceTab(root, leaf.id, leaf.active, tab);
    if (act.kind === "term") {
      dock = [...dock, act.id];
      manager.hide(act.id);
    }
    st().set({ dock, focusedLeaf: leaf.id });
    st().setRoot(root);
  } else if (s.root) {
    const first = T.leaves(s.root)[0];
    const { root, newLeafId } = T.splitLeaf(s.root, first.id, "left", tab);
    st().set({ dock });
    if (newLeafId) st().set({ focusedLeaf: newLeafId });
    st().setRoot(root);
  } else {
    const leafNew = T.makeLeaf([tab]);
    st().set({ dock, focusedLeaf: leafNew.id });
    st().setRoot(leafNew);
  }
  st().setAttention(id, null);
  requestAnimationFrame(() => manager.focus(id));
  scheduleSessionSave();
}

export function restoreLastDocked() {
  const last = st().lastDocked;
  if (last !== null && st().dock.includes(last)) {
    showTerm(last);
    return;
  }
  const dock = st().dock;
  if (dock.length) showTerm(dock[dock.length - 1]);
}

/** Drop de un drag (tab / rail / archivo) sobre un leaf o region. */
export function dropOn(
  src: import("./types").DragSrc,
  targetLeafId: string | null,
  region: import("./types").DropRegion,
  tabIndex?: number,
) {
  const s = st();
  // workspace vacio: lo que caiga se vuelve el arbol
  if (!s.root || targetLeafId === null) {
    if (src.kind === "rail") {
      const dock = s.dock.filter((d) => d !== src.ptyId);
      const leaf = T.makeLeaf([{ kind: "term", id: src.ptyId }]);
      st().set({ dock, focusedLeaf: leaf.id });
      st().setRoot(leaf);
      requestAnimationFrame(() => manager.focus(src.ptyId));
    } else if (src.kind === "file") {
      for (const p of src.paths) openFileTab(p);
    }
    scheduleSessionSave();
    return;
  }

  // solo rail usa esto hoy: los tabs de archivo (uno o varios) se resuelven
  // caso por caso mas abajo, jamas via un TabItem generico
  const tabOf = (): TabItem | null => {
    if (src.kind === "rail") return { kind: "term", id: src.ptyId };
    return null;
  };

  if (region === "tabs") {
    // drop sobre la tab bar: SIEMPRE se vuelve pestaña de ese campo
    if (src.kind === "tab") {
      st().setRoot(T.moveTab(s.root, src.leafId, src.index, targetLeafId, tabIndex));
      focusLeafSoon(targetLeafId);
    } else if (src.kind === "rail") {
      const dock = s.dock.filter((d) => d !== src.ptyId);
      st().set({ dock });
      st().setRoot(T.insertTab(st().root, targetLeafId, tabOf()!, tabIndex));
      st().setAttention(src.ptyId, null);
      requestAnimationFrame(() => manager.focus(src.ptyId));
      st().set({ focusedLeaf: targetLeafId });
    } else {
      for (const p of src.paths) openFileTab(p, "auto", { leafId: targetLeafId });
    }
  } else if (region === "center") {
    if (src.kind === "tab") {
      if (src.leafId !== targetLeafId) {
        st().setRoot(T.moveTab(s.root, src.leafId, src.index, targetLeafId));
        focusLeafSoon(targetLeafId);
      }
    } else if (src.kind === "rail") {
      const dock = s.dock.filter((d) => d !== src.ptyId);
      st().set({ dock });
      st().setRoot(T.insertTab(st().root, targetLeafId, tabOf()!));
      st().setAttention(src.ptyId, null);
      requestAnimationFrame(() => manager.focus(src.ptyId));
      st().set({ focusedLeaf: targetLeafId });
    } else if (src.kind === "file") {
      // centro sobre terminal = pegar TODOS los paths (util para agentes);
      // sobre archivo = tabs
      const leaf = T.findLeaf(s.root, targetLeafId);
      const act = leaf ? T.activeTab(leaf) : null;
      if (act?.kind === "term") {
        const quoted = src.paths.map((p) =>
          /[\s'"]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p,
        );
        void ipc.ptyWrite(act.id, `${quoted.join(" ")} `);
        manager.focus(act.id);
      } else {
        for (const p of src.paths) openFileTab(p, "auto", { leafId: targetLeafId });
      }
    }
  } else {
    const side = region as Side;
    if (src.kind === "tab") {
      const { root, newLeafId } = T.moveTabToSide(
        s.root, src.leafId, src.index, targetLeafId, side,
      );
      st().setRoot(root);
      if (newLeafId) focusLeafSoon(newLeafId);
    } else if (src.kind === "file") {
      // split UNA sola vez con el primer path; el resto entra como tabs del
      // leaf nuevo (si no, cada path arma su propio split fragmentado)
      const [first, ...rest] = src.paths;
      const { root, newLeafId } = T.splitLeaf(
        s.root, targetLeafId, side,
        { kind: "file", path: first, mode: "auto", preview: false },
      );
      let r = root;
      if (newLeafId) {
        for (const p of rest) {
          r = T.insertTab(r, newLeafId, { kind: "file", path: p, mode: "auto", preview: false });
        }
        st().set({ viewerLeaf: newLeafId });
        focusLeafSoon(newLeafId);
      }
      st().setRoot(r);
    } else {
      const dock = s.dock.filter((d) => d !== src.ptyId);
      st().set({ dock });
      st().setAttention(src.ptyId, null);
      const { root, newLeafId } = T.splitLeaf(s.root, targetLeafId, side, tabOf()!);
      st().setRoot(root);
      if (newLeafId) focusLeafSoon(newLeafId);
      requestAnimationFrame(() => manager.focus(src.ptyId));
    }
  }
  scheduleSessionSave();
}

function focusLeafSoon(leafId: string) {
  requestAnimationFrame(() => focusLeaf(leafId));
}

export function moveFocus(dir: "left" | "right" | "up" | "down") {
  const s = st();
  const rects = T.layoutRects(s.root, { x: 0, y: 0, w: 1000, h: 1000 }, 8);
  if (!rects.length) return;
  const cur = rects.find((r) => r.leafId === s.focusedLeaf) ?? rects[0];
  const cx = cur.rect.x + cur.rect.w / 2;
  const cy = cur.rect.y + cur.rect.h / 2;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const r of rects) {
    if (r.leafId === cur.leafId) continue;
    const dx = r.rect.x + r.rect.w / 2 - cx;
    const dy = r.rect.y + r.rect.h / 2 - cy;
    const ok =
      (dir === "left" && dx < -1) ||
      (dir === "right" && dx > 1) ||
      (dir === "up" && dy < -1) ||
      (dir === "down" && dy > 1);
    if (!ok) continue;
    const dist = Math.abs(dx) + Math.abs(dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = r.leafId;
    }
  }
  if (best) focusLeaf(best);
}

// ---------- archivos como tabs ----------

type FileTab = Extract<TabItem, { kind: "file" }>;

/** Inserta un tab de archivo en un leaf. Si el tab es PREVIEW y el leaf ya
 *  tiene un preview vivo (maximo uno por leaf, estilo VSCode), lo REEMPLAZA
 *  en su mismo indice en vez de acumular una pestaña nueva. */
function insertOrReplacePreview(
  root: TilingNode | null,
  leafId: string,
  tab: FileTab,
): TilingNode | null {
  if (tab.preview) {
    const leaf = T.findLeaf(root, leafId);
    const idx = leaf?.tabs.findIndex((t) => t.kind === "file" && t.preview) ?? -1;
    if (leaf && idx >= 0) return T.mapReplaceTab(root, leafId, idx, tab);
  }
  return T.insertTab(root, leafId, tab);
}

export function openFileTab(
  path: string,
  mode: "auto" | "diff" = "auto",
  opts?: { leafId?: string; side?: Side; preview?: boolean },
) {
  // el LECTOR no tiene visor propio: abrir un archivo = revelar el taller y
  // abrirlo como tab (ver diff, ⌘P, paleta, arbol, gate show_file/show_diff)
  if (st().ui.chat && !opts?.leafId) showChat(false);
  const s = st();
  const preview = opts?.preview ?? false;
  const tab: FileTab = { kind: "file", path, mode, preview };

  // ¿ya esta abierto? activalo (actualiza mode/preview si cambiaron). Un
  // preview NUNCA degrada un tab ya permanente; una apertura permanente SI
  // promueve un preview existente.
  const existing = T.leafOfFile(s.root, path);
  if (existing) {
    const idx = existing.tabs.findIndex((t) => t.kind === "file" && t.path === path);
    const cur = existing.tabs[idx] as FileTab;
    const nextPreview = !!cur.preview && preview;
    let root = s.root;
    if (cur.mode !== mode || !!cur.preview !== nextPreview) {
      root = T.mapReplaceTab(root, existing.id, idx, { ...cur, mode, preview: nextPreview });
    }
    root = T.mapActivate(root, existing.id, idx);
    st().setRoot(root);
    focusLeaf(existing.id);
    scheduleSessionSave();
    return;
  }

  if (opts?.leafId) {
    if (opts.side) {
      const { root, newLeafId } = T.splitLeaf(s.root, opts.leafId, opts.side, tab);
      st().setRoot(root);
      if (newLeafId) {
        st().set({ viewerLeaf: newLeafId });
        focusLeafSoon(newLeafId);
      }
    } else {
      st().setRoot(insertOrReplacePreview(s.root, opts.leafId, tab));
      st().set({ viewerLeaf: opts.leafId });
      focusLeafSoon(opts.leafId);
    }
    scheduleSessionSave();
    return;
  }

  // ¿hay campo viewer vivo? -> nueva pestaña ahi. Preferimos el leaf ENFOCADO
  // si ya muestra archivos (el usuario esta MIRANDO ahi ahora mismo); viewerLeaf
  // puede quedar apuntando a un leaf viejo que un drag/split mas reciente dejo
  // atras sin que nadie lo actualizara (viewerLeaf y focusedLeaf pueden divergir).
  const focusedLeaf = s.focusedLeaf ? T.findLeaf(s.root, s.focusedLeaf) : null;
  const focusedShowsFiles =
    focusedLeaf && focusedLeaf.tabs.some((t) => t.kind === "file") ? focusedLeaf : null;
  const viewer = focusedShowsFiles ?? (s.viewerLeaf ? T.findLeaf(s.root, s.viewerLeaf) : null);
  if (viewer) {
    st().setRoot(insertOrReplacePreview(s.root, viewer.id, tab));
    if (s.viewerLeaf !== viewer.id) st().set({ viewerLeaf: viewer.id });
    focusLeafSoon(viewer.id);
    scheduleSessionSave();
    return;
  }
  // si algun leaf ya muestra archivos, ese es el campo viewer
  const fileLeaf = T.leaves(s.root).find((l) => l.tabs.some((t) => t.kind === "file"));
  if (fileLeaf) {
    st().set({ viewerLeaf: fileLeaf.id });
    st().setRoot(insertOrReplacePreview(s.root, fileLeaf.id, tab));
    focusLeafSoon(fileLeaf.id);
    scheduleSessionSave();
    return;
  }

  // primer archivo: split automatico a la DERECHA del workspace entero
  if (!s.root) {
    const leaf = T.makeLeaf([tab]);
    st().set({ viewerLeaf: leaf.id, focusedLeaf: leaf.id });
    st().setRoot(leaf);
  } else {
    const rects = T.layoutRects(s.root, { x: 0, y: 0, w: 1000, h: 1000 }, 8);
    const rightmost = rects.reduce((a, b) =>
      b.rect.x + b.rect.w > a.rect.x + a.rect.w ? b : a,
    );
    const { root, newLeafId } = T.splitLeaf(s.root, rightmost.leafId, "right", tab);
    st().setRoot(root);
    if (newLeafId) {
      st().set({ viewerLeaf: newLeafId });
      focusLeafSoon(newLeafId);
    }
  }
  scheduleSessionSave();
}

/** Cambia el mode (auto/diff) de un tab de archivo. */
export function setFileTabMode(leafId: string, index: number, mode: "auto" | "diff") {
  const leaf = T.findLeaf(st().root, leafId);
  const tab = leaf?.tabs[index];
  if (!tab || tab.kind !== "file") return;
  st().setRoot(T.mapReplaceTab(st().root, leafId, index, { ...tab, mode }));
}

/** Cambia el toggle render<->fuente (⌘⇧M) de un tab de archivo markdown. */
export function setFileTabRaw(leafId: string, index: number, raw: boolean) {
  const leaf = T.findLeaf(st().root, leafId);
  const tab = leaf?.tabs[index];
  if (!tab || tab.kind !== "file") return;
  st().setRoot(T.mapReplaceTab(st().root, leafId, index, { ...tab, raw }));
}

/** ⌘⇧M: togglea render<->fuente del tab de archivo ACTIVO del leaf enfocado.
 *  No-op si no hay leaf enfocado, el activo no es archivo, esta en modo diff,
 *  o no es markdown (reemplaza el CustomEvent "sfterm:toggle-md", que vivia
 *  como estado local de FileView y se perdia al cambiar de pestaña). */
export function toggleFocusedMarkdownRaw() {
  const s = st();
  const leaf = s.focusedLeaf ? T.findLeaf(s.root, s.focusedLeaf) : null;
  const tab = leaf ? T.activeTab(leaf) : null;
  if (!leaf || !tab || tab.kind !== "file" || tab.mode === "diff") return;
  const name = tab.path.split("/").pop() ?? "";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (ext !== "md" && ext !== "markdown") return;
  setFileTabRaw(leaf.id, leaf.active, !tab.raw);
}

/** Promueve un tab de archivo de preview a permanente (deja de italizarse y
 *  de ser reemplazable). Triggers: doble clic en la pestaña/fila del arbol,
 *  arrastrar la pestaña (ver Tiling.tsx::startPointerDrag). No-op si ya era
 *  permanente o el indice no es un archivo. */
export function promoteFileTab(leafId: string, index: number) {
  const leaf = T.findLeaf(st().root, leafId);
  const tab = leaf?.tabs[index];
  if (!tab || tab.kind !== "file" || !tab.preview) return;
  st().setRoot(T.mapReplaceTab(st().root, leafId, index, { ...tab, preview: false }));
  scheduleSessionSave();
}

/** Cierra las pestañas del visor que apunten a algo que dejo de existir: el
 *  path exacto, o CUALQUIER archivo dentro de una carpeta que se fue. Sin
 *  esto quedan tabs zombie mostrando el contenido cacheado de un archivo
 *  muerto (y la sesion los persiste).
 *  `removeTab` saca UNA por llamada, por eso el loop; corta cuando ya no
 *  queda ninguna muerta, asi que termina siempre. */
export function closeFileTabsUnder(paths: string[]) {
  if (paths.length === 0) return;
  const dead = (p: string) => paths.some((d) => p === d || p.startsWith(d + "/"));
  const hasDead = (r: TilingNode | null) =>
    T.leaves(r).some((l) => l.tabs.some((t) => t.kind === "file" && dead(t.path)));

  let root = st().root;
  if (!hasDead(root)) return;
  while (hasDead(root)) {
    root = T.removeTab(root, (t) => t.kind === "file" && dead(t.path));
  }
  st().setRoot(root);
  scheduleSessionSave();
}

/** Igual que promoteFileTab pero localizando el tab por path (doble clic en
 *  el arbol, que no conoce leafId/index). */
export function promoteFileByPath(path: string) {
  const leaf = T.leafOfFile(st().root, path);
  if (!leaf) return;
  const idx = leaf.tabs.findIndex((t) => t.kind === "file" && t.path === path);
  if (idx >= 0) promoteFileTab(leaf.id, idx);
}

// ---------- presets ----------

export async function applyPreset(preset: Preset) {
  // Los paneles vivos se van al dock: no se mata trabajo.
  const live = T.termIds(st().root);
  live.forEach((id) => manager.hide(id));
  const dock = [...st().dock, ...live];
  st().set({ dock, presetName: preset.name, viewerLeaf: null, focusedLeaf: null });
  st().setRoot(null);
  await setTreeRoot(preset.root);
  const cfg = st().config!;
  const panes = preset.panes ?? [];
  const tree = T.buildPresetTree(panes.length);
  st().setRoot(tree);
  const leafList = T.leaves(tree);
  let kicked = false;
  for (let i = 0; i < Math.min(panes.length, leafList.length); i++) {
    const pane = panes[i];
    const command = pane === "agent" ? cfg.general.agent_command : pane || undefined;
    const id = await spawnPanel({
      cwd: preset.root,
      command,
      target: { at: "tab", leafId: leafList[i].id },
    });
    // kickoff: el primer pane "agent" arranca la conversacion del dia solo
    if (!kicked && preset.kickoff && pane === "agent") {
      kicked = true;
      void kickoffPane(id, preset.kickoff);
    }
  }
  scheduleSessionSave();
}

/** Corre el comando kickoff del preset y manda su stdout como primer prompt
 *  al agente cuando este listo (Daniel abre la app = el dia ya arranco). */
async function kickoffPane(id: number, cmd: string, cwd?: string) {
  markKickoffToday();
  try {
    const prompt = (await ipc.shellCapture(cmd, cwd ?? st().treeRoot)).trim();
    if (prompt) await sendWhenReady(id, prompt);
  } catch (e) {
    console.warn("kickoff fallo:", e);
  }
}

const KICKOFF_DAY_KEY = "sfterm-kickoff-day";
function markKickoffToday() {
  localStorage.setItem(KICKOFF_DAY_KEY, new Date().toDateString());
}

/** Briefing diario aunque haya sesion restaurada: la PRIMERA apertura del dia
 *  abre un agente fresco (toma la vista, modelo VSCode) con el kickoff del
 *  preset default. Una vez por dia. */
async function maybeDailyKickoff(cfg: AppConfig) {
  const preset =
    cfg.presets?.find((p) => p.name === cfg.general.default_preset) ??
    cfg.presets?.[0];
  if (!preset?.kickoff) return;
  if (localStorage.getItem(KICKOFF_DAY_KEY) === new Date().toDateString()) return;
  markKickoffToday();
  let rootAbs = preset.root;
  if (rootAbs === "~" || rootAbs.startsWith("~/")) {
    const home = await ipc.fsHomeDir();
    rootAbs = rootAbs === "~" ? home : home + rootAbs.slice(1);
  }
  const id = await spawnPanel({
    cwd: rootAbs,
    command: cfg.general.agent_command,
    target: { at: "auto" },
  });
  void kickoffPane(id, preset.kickoff, rootAbs);
}

/** Espera a que el pane haya ARRANCADO (hubo output y luego quiet ~1.5s,
 *  ej. el banner de claude ya se pinto) y le pega el texto + enter.
 *  THROW si el pane murio antes de recibir el prompt (17 jul): un return
 *  silencioso aqui = turno perdido sin error ni fallback — nunca silencio.
 *  ENTREGA VERIFICADA (18 jul): pegar y COMPROBAR que el texto aparece en la
 *  pantalla antes del Enter — si el TUI aun no estaba listo el paste se
 *  pierde en el vacio (el bug del "hola" mudo); reintenta hasta 3 veces. */
export async function sendWhenReady(id: number, text: string) {
  const spawn = Date.now();
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const e = manager.get(id);
    if (!e) throw new Error("el cuerpo murió antes de recibir el prompt");
    const quiet = Date.now() - e.lastData;
    if (quiet > 1500 && Date.now() - spawn > 2500) break;
  }
  // sonda corta (10 chars de la primera linea): el wrap de pantalla parte
  // textos largos y rompe el includes
  const probe = text.trim().split("\n")[0].slice(0, 10);
  // ⚠️ VERIFICABLE solo si la pantalla NO contiene ya la sonda (cazado E2E 30
  // jul con una sesion RESUMIDA: la conversacion vieja traia el mismo prefijo
  // y el "aparecio" era falso positivo — Enter al vacio, turno perdido en
  // silencio). Sonda pre-existente = no hay como verificar: se confia en el
  // bracketed paste y se envia, que es estrictamente mejor que mentirse.
  const antes = await manager.readTail(id, 25).catch(() => "");
  const verificable = !!probe && !antes.includes(probe);
  for (let intento = 0; intento < 3; intento++) {
    if (!manager.get(id)) throw new Error("el cuerpo murió antes de recibir el prompt");
    if (intento > 0) {
      // limpiar el input (ctrl+u) por si un paste anterior llego a medias
      void ipc.ptyWrite(id, "\u0015");
      await new Promise((r) => setTimeout(r, 150));
    }
    // paste (bracketed): los TUIs como claude lo reciben como UN mensaje
    manager.paste(id, text.trimEnd());
    await new Promise((r) => setTimeout(r, 700));
    const screen = await manager.readTail(id, 25).catch(() => "");
    if (!verificable || screen.includes(probe)) {
      await new Promise((r) => setTimeout(r, 120));
      void ipc.ptyWrite(id, "\r");
      // paste largo: si el Enter se perdio y el texto SIGUE en el input
      // (ultimas lineas), retapear — con el input vacio un \r extra es no-op.
      // Solo con sonda VERIFICABLE: con una pre-existente este check releeria
      // la conversacion vieja y mandaria un Enter fantasma de mas.
      await new Promise((r) => setTimeout(r, 900));
      const after = await manager.readTail(id, 6).catch(() => "");
      if (verificable && after.includes(probe)) void ipc.ptyWrite(id, "\r");
      return;
    }
    // no aparecio: el receptor seguia sordo — esperar y reintentar
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("el prompt no aparecio en la pantalla del cuerpo (3 intentos)");
}

/** Spawn para la puerta de agentes: visible (toma la vista) u oculta. */
export async function gateSpawn(opts: {
  cwd?: string;
  command?: string;
  show?: boolean;
}): Promise<number> {
  return spawnPanel({
    cwd: opts.cwd ?? st().treeRoot,
    command: opts.command,
    target: opts.show === false ? { at: "dock" } : { at: "auto" },
  });
}

// ---------- arbol de archivos / git ----------

let gitTimer: ReturnType<typeof setTimeout> | null = null;

/** Repos/roots RECIENTES para el picker del sidebar (localStorage, cap 8).
 *  Estado de layout como los sashes — jamas viaja al config.toml. */
export function recentRoots(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem("sfterm-roots-recent") ?? "[]");
    return Array.isArray(raw) ? raw.filter((r) => typeof r === "string") : [];
  } catch {
    return [];
  }
}

function pushRecentRoot(root: string) {
  const list = [root, ...recentRoots().filter((r) => r !== root)].slice(0, 8);
  localStorage.setItem("sfterm-roots-recent", JSON.stringify(list));
}

export async function setTreeRoot(rootRaw: string) {
  let root = rootRaw;
  if (root === "~" || root.startsWith("~/")) {
    const home = await ipc.fsHomeDir();
    root = root === "~" ? home : home + root.slice(1);
  }
  root = root.replace(/\/+$/, "");
  // la multi-seleccion del arbol es del ROOT anterior: cambiar de raiz (o
  // aplicar un preset, que llama aqui) la vuelve invalida
  st().set({ treeRoot: root, treeSel: [], treeAnchor: null });
  pushRecentRoot(root);
  try {
    await ipc.fsWatchRoot(root);
  } catch { /* root sin permisos */ }
  void refreshGit();
  scheduleSessionSave();
}

export async function refreshGit() {
  const root = st().treeRoot;
  if (!root) return;
  try {
    const git = await ipc.gitStatus(root);
    st().set({ git });
  } catch {
    st().set({ git: null });
  }
  void refreshScm();
}

/** Cuantos commits del historial trae el panel (crece con "cargar mas"). */
let scmLogWant = 50;

/** Source Control espejo: sincronia + historial + checkpoints. Corre con el
 *  mismo pulso que refreshGit (FSEvents debounced + intervalo 8s). Todo
 *  LECTURA; los errores dejan el panel en null (repo sin git = panel ausente). */
export async function refreshScm() {
  const root = st().treeRoot;
  if (!root) return;
  try {
    const [sync, log, checkpoints] = await Promise.all([
      ipc.gitState(root),
      ipc.gitLog(root, 0, scmLogWant),
      ipc.checkpointList(root, 20).catch(() => []),
    ]);
    if (!sync.is_repo) {
      st().set({ scm: null });
      return;
    }
    st().set({
      scm: { sync, log: log.commits, hasUpstream: log.has_upstream, checkpoints },
    });
  } catch {
    st().set({ scm: null });
  }
}

export async function scmLoadMore() {
  scmLogWant = Math.min(scmLogWant + 50, 500);
  await refreshScm();
}

/** Refresh MANUAL del panel (unico gesto de red permitido): `git fetch`
 *  tolerante a offline/sin-credenciales — SOLO fetch, jamas merge/pull. */
export async function scmFetch() {
  const root = st().treeRoot;
  if (!root) return;
  try {
    await ipc.shellCapture("git fetch --quiet 2>&1 | head -3; true", root);
  } catch { /* offline / sin remote: el estado local sigue siendo la verdad */ }
  await refreshScm();
}

/** VER un commit: su detalle (.patch escrito por Rust al cache de la app)
 *  abierto en el visor. Gesto de LECTURA — nada del repo se toca. */
export async function openCommitDetail(hash: string) {
  const root = st().treeRoot;
  if (!root) return;
  const path = await ipc.gitCommitFile(root, hash);
  openFileTab(path, "auto");
}

/** VER que cambio desde un checkpoint (patch al cache, visor). */
export async function openCheckpointDiff(id: string) {
  const root = st().treeRoot;
  if (!root) return;
  const path = await ipc.checkpointDiffFile(root, id);
  openFileTab(path, "auto");
}

export function scheduleGitRefresh() {
  if (gitTimer) clearTimeout(gitTimer);
  gitTimer = setTimeout(() => void refreshGit(), 800);
}

// compat: el resto del codigo llama openViewer
export function openViewer(path: string, mode: "auto" | "diff" = "auto") {
  openFileTab(path, mode);
}

/** Abre un archivo y salta a una linea (busqueda por contenido / gate). */
export function openViewerAt(path: string, line: number) {
  st().set({ pendingJump: { path, line: Math.max(1, line) } });
  openFileTab(path, "auto");
}

// ---------- NAVEGADOR DEL AGENTE (F1) ----------

let nextBrowserId = 1;

/** El navegador de una CONVERSACION, o null si esa no abrio ninguno. */
export function browserIdFor(owner: number): number | null {
  return T.browserIdOf(st().root, owner);
}

/** La conversacion que manda: la terminal enfocada. Es el "dueño por default"
 *  de todo lo que se abra sin decir de quien es — incluido lo que abre Daniel
 *  a mano. Asi no hay dos conceptos ("el mio" y "el del agente"): si abres un
 *  navegador con la terminal 3 enfocada, ese navegador ES de la terminal 3. */
export function focusedOwner(): number | null {
  const s = st();
  return s.focused != null && s.panels[s.focused] ? s.focused : null;
}

/** Compat: "algun navegador" para los caminos que todavia no saben de quien
 *  preguntan. Prefiere el de la conversacion enfocada. */
export function browserId(): number | null {
  const own = focusedOwner();
  const mine = own != null ? T.browserIdOf(st().root, own) : null;
  return mine ?? T.browserIds(st().root)[0] ?? null;
}

/** Abre (o enfoca) el navegador DE UNA CONVERSACION. Cada agente tiene el
 *  suyo, para hacer y deshacer sin pisar a los demas.
 *
 *  `owner` = de quien es. Por default, la terminal enfocada. Si esa
 *  conversacion ya tiene navegador, se activa y navega; si no, nace uno.
 *  Todos viven en el MISMO campo (el slot), porque el modelo es "sigue al
 *  foco": lo que cambia al moverte entre conversaciones es el contenido del
 *  slot, jamas tu layout. */
/** PESTAÑAS del navegador (29 jul): `nuevo` fuerza otro webview aunque esta
 *  conversacion ya tenga uno. No hace falta una segunda barra de pestañas — el
 *  campo del ala YA tiene la suya (la del tiling), asi que cada navegador de
 *  esta conversacion aparece ahi como una pestaña mas. Claude Desktop necesita
 *  su propia barra porque su navegador es un panel monolitico; el nuestro es
 *  una pestaña del taller y hereda el mecanismo gratis. */
export async function openBrowser(
  url?: string,
  owner?: number,
  nuevo = false,
  opts?: { focus?: boolean },
): Promise<number> {
  // ⚠️ EL GATE NO MUEVE LA PANTALLA DE DANIEL (bug 29 jul). Un agente abriendo
  // o navegando SU navegador es trabajo de BACKSTAGE, no una peticion de
  // Daniel de mirar algo. Mientras el gate revelaba y enfocaba, dos agentes en
  // paralelo se turnaban el robo de foco y el no podia sostener una tarea.
  // Solo un gesto SUYO (paleta ⌘K) enfoca.
  const focus = opts?.focus !== false;
  if (focus && st().ui.chat) showChat(false);
  // el dueño tiene que ser una conversacion VIVA de esta app: uno inventado
  // dejaria el navegador sin casa donde pintarse (ver caller() en gate.ts)
  const pedido = owner != null && st().panels[owner] ? owner : undefined;
  const own = pedido ?? focusedOwner() ?? undefined;
  const s = st();
  if (nuevo) {
    const id = nextBrowserId++;
    await ipc.browserCreate(id);
    const tab: TabItem = own != null ? { kind: "browser", id, owner: own } : { kind: "browser", id };
    const ala = T.leafSoloBrowsers(s.root);
    if (ala) {
      st().setRoot(T.insertTab(s.root, ala.id, tab));
      if (focus) focusLeafSoon(ala.id);
    } else if (s.root) {
      const at = (s.focusedLeaf ? T.findLeaf(s.root, s.focusedLeaf) : null) ?? T.leaves(s.root)[0];
      const { root, newLeafId } = T.splitLeaf(s.root, at.id, "right", tab);
      st().setRoot(root);
      if (newLeafId) if (focus) focusLeafSoon(newLeafId);
    }
    if (url) await ipc.browserGoto(id, url);
    return id;
  }

  // ¿esta conversacion YA tiene el suyo? (o hay uno sin dueño, de la era
  // compartida, que puede reclamar — si no, quedaria pintado e inalcanzable)
  const existing = own != null ? T.leafOfBrowser(s.root, own) : T.leafOfAnyBrowser(s.root);
  if (existing) {
    const tab = existing.leaf.tabs[existing.index] as Extract<TabItem, { kind: "browser" }>;
    let root = s.root;
    if (own != null && tab.owner === undefined) {
      // adopcion: el compartido de v1 pasa a ser de quien lo pidio
      root = T.mapReplaceTab(root, existing.leaf.id, existing.index, { ...tab, owner: own });
    }
    st().setRoot(T.mapActivate(root, existing.leaf.id, existing.index));
    if (focus) focusLeafSoon(existing.leaf.id);
    if (url) await ipc.browserGoto(tab.id, url);
    return tab.id;
  }

  const id = nextBrowserId++;
  await ipc.browserCreate(id);
  const tab: TabItem = own != null ? { kind: "browser", id, owner: own } : { kind: "browser", id };
  const s2 = st();
  // EL ALA: si ya existe un campo de PURO navegador, el nuevo entra ahi.
  // Abrir uno jamas parte la pantalla dos veces.
  //
  // ⚠️ NUNCA se mete en un campo que tenga terminales o archivos (bug del 29
  // jul: se colaba como pestaña junto a la terminal de su conversacion, y
  // clickear esa conversacion en el rail la mandaba "a la derecha", revuelta
  // con el navegador). Antes se probaba `viewerLeaf` — el campo del visor,
  // que casi siempre tiene archivos. Por eso: campo propio o split, nada mas.
  const slot = T.leafSoloBrowsers(s2.root);
  if (slot) {
    st().setRoot(T.insertTab(s2.root, slot.id, tab));
    if (focus) focusLeafSoon(slot.id);
  } else if (s2.root) {
    const at =
      (s2.focusedLeaf ? T.findLeaf(s2.root, s2.focusedLeaf) : null) ?? T.leaves(s2.root)[0];
    const { root, newLeafId } = T.splitLeaf(s2.root, at.id, "right", tab);
    st().setRoot(root);
    // ⚠️ este campo NO se marca como `viewerLeaf`: si lo fuera, los ARCHIVOS
    // se abririan dentro del ala del navegador (la misma contaminacion, al
    // reves). El ala es solo para navegadores.
    if (newLeafId) if (focus) focusLeafSoon(newLeafId);
  } else {
    const leaf = T.makeLeaf([tab]);
    st().set({ focusedLeaf: leaf.id });
    st().setRoot(leaf);
  }
  if (url) await ipc.browserGoto(id, url);
  return id;
}

/** EL SLOT SIGUE AL FOCO. Al cambiar de conversacion, el campo del navegador
 *  activa el tab de la conversacion nueva. Si esa no tiene navegador, el campo
 *  NO se cierra: se queda mostrando el estado vacio (Tiling no coloca un
 *  webview ajeno). Cerrarlo colapsaria y reabriria tu layout en cada ⌥Tab,
 *  que es peor que el problema que esto vino a resolver. */
export function syncBrowserSlot(): void {
  const s = st();
  const own = focusedOwner();
  if (own == null) return;
  const mine = T.leafOfBrowser(s.root, own);
  if (!mine) return; // sin navegador propio: el slot se queda en vacio
  const leaf = T.findLeaf(s.root, mine.leaf.id);
  if (!leaf || leaf.active === mine.index) return;
  // ⚠️ sin focusLeaf: activar el tab NO puede robarle el teclado a la
  // terminal a la que Daniel acaba de moverse
  st().setRoot(T.mapActivate(s.root, mine.leaf.id, mine.index));
}

/** Abre los archivos CAMBIADOS del repo como tabs en modo diff (cap 8).
 *  La capa conversacional de la revision: "¿que me cambiaste?" → los diffs
 *  ABIERTOS en pantalla. Modificados primero, untracked despues. */
export async function openChanges(): Promise<string[]> {
  // revision multi-archivo: eso vive en el tiling del taller (tabs diff)
  if (st().ui.chat) showChat(false);
  await refreshGit();
  const s = st();
  const git = s.git;
  if (!git?.is_repo || !git.files) return [];
  const entries = Object.entries(git.files);
  const order = (code: string) => (code === "M" ? 0 : code === "D" ? 1 : code === "R" ? 2 : 3);
  entries.sort((a, b) => order(a[1]) - order(b[1]) || a[0].localeCompare(b[0]));
  const opened: string[] = [];
  for (const [rel] of entries.slice(0, 8)) {
    openFileTab(`${s.treeRoot}/${rel}`, "diff");
    opened.push(rel);
  }
  return opened;
}

/** Busca la URL de un dev server en el output reciente de la terminal
 *  enfocada (o la dada) y abre el overlay de preview. */
export async function openDevPreview(ptyId?: number): Promise<string | null> {
  const id = ptyId ?? st().focused;
  let url: string | null = null;
  if (id != null && manager.get(id)) {
    try {
      const text = await manager.readTail(id, 400);
      const matches = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+[^\s"')\]]*/g);
      if (matches && matches.length) {
        url = matches[matches.length - 1].replace("0.0.0.0", "localhost");
      }
    } catch { /* sin terminal legible */ }
  }
  if (url) st().setUI({ preview: url });
  return url;
}

// ---------- sesion ----------

let sessTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleSessionSave() {
  if (sessTimer) clearTimeout(sessTimer);
  sessTimer = setTimeout(() => void saveSession(), 1200);
}

export async function saveSession() {
  const s = st();
  if (!s.booted) return;
  // Solo LAYOUT (arbol/cwd/archivos/dock). El revival de conversaciones por
  // --resume al abrir MURIO el 21 jul pm (decision de Daniel: "si no podemos
  // conservar la sesion abierta al abrir, prefiero que no la tengamos").
  const data: SessionData = {
    version: 2,
    treeRoot: s.treeRoot,
    preset: s.presetName,
    tree: T.serializeTree(s.root, (id) => s.panels[id]?.cwd || s.treeRoot),
    dock: s.dock.map((d) => ({ cwd: s.panels[d]?.cwd || s.treeRoot, termId: d })),
  };
  try {
    await ipc.sessionSave(data);
  } catch { /* best effort */ }
}

/** Reconstruye el arbol de una sesion serializada, spawneando terminales. */
async function restoreTree(node: T.SerializedNode): Promise<TilingNode | null> {
  if (node.kind === "leaf") {
    const leaf = T.makeLeaf([], 0);
    const tabs: TabItem[] = [];
    for (const t of node.tabs) {
      if (t.kind === "file") {
        // preview/raw sin llave (sesiones viejas) = permanente/render, jamas
        // rompe la restauracion (SerializedTab.preview/raw son opcionales)
        tabs.push({
          kind: "file",
          path: t.path,
          mode: t.mode ?? "auto",
          preview: t.preview ?? false,
          raw: t.raw ?? false,
        });
      } else {
        // la terminal sigue VIVA en el daemon → re-adoptarla (mismo proceso,
        // pantalla intacta); muerta o sin daemon → spawn fresco de siempre
        const adopted =
          t.termId != null && adoptable.has(t.termId)
            ? await adoptDetached(t.termId)
            : null;
        const id = adopted ?? (await spawnDetached(t.cwd));
        tabs.push({ kind: "term", id });
      }
    }
    if (!tabs.length) return null;
    leaf.tabs = tabs;
    leaf.active = Math.min(node.active ?? 0, tabs.length - 1);
    return leaf;
  }
  const children: TilingNode[] = [];
  const sizes: number[] = [];
  for (let i = 0; i < node.children.length; i++) {
    const c = await restoreTree(node.children[i]);
    if (c) {
      children.push(c);
      sizes.push(node.sizes?.[i] ?? 1 / node.children.length);
    }
  }
  if (!children.length) return null;
  if (children.length === 1) return children[0];
  const sum = sizes.reduce((a, b) => a + b, 0) || 1;
  return {
    kind: "split",
    id: T.nextNodeId(),
    dir: node.dir,
    children,
    sizes: sizes.map((x) => x / sum),
  };
}

/** Terminales del daemon aun sin dueño durante el boot (id → info). Se van
 *  consumiendo conforme la sesion restaurada las reclama; lo que sobre se
 *  adopta al dock — una conversacion viva JAMAS se queda invisible. */
const adoptable = new Map<number, ipc.DaemonTermInfo>();

/** Re-adopta una terminal viva del daemon sin tocar el arbol. El replay puede
 *  llegar ANTES de que exista el xterm (el canal se abre en el invoke): se
 *  bufferea y se entrega al registrar. null = la adopcion fallo (murio en la
 *  ventana / daemon caido) y el caller decide su fallback. */
async function adoptDetached(id: number): Promise<number | null> {
  const cfg = st().config!;
  const theme = st().theme!;
  let entry: ReturnType<typeof manager.create> | null = null;
  const pending: Uint8Array[] = [];
  try {
    const info = await ipc.ptyAdopt({
      id,
      scrollback: cfg.general?.scrollback ?? 8000,
      onData: (d) => {
        const e = manager.get(id) ?? entry;
        if (e) manager.feed(e, d);
        else pending.push(d);
      },
    });
    entry = manager.create(cfg, theme);
    manager.register(id, entry);
    for (const d of pending) manager.feed(entry, d);
    pending.length = 0;
    adoptable.delete(id);
    const panels = {
      ...st().panels,
      [id]: { id, title: "", fgName: "", cwd: info.cwd, cpu: 0, attention: null, exited: false },
    };
    st().set({ panels });
    manager.hide(id);
    return id;
  } catch {
    adoptable.delete(id);
    return null;
  }
}

/** Spawn sin tocar el arbol (para restauracion). */
async function spawnDetached(cwd: string): Promise<number> {
  const cfg = st().config!;
  const theme = st().theme!;
  const entry = manager.create(cfg, theme);
  let spawnedId: number | null = null;
  const id = await ipc.ptySpawn({
    cwd,
    cols: 80,
    rows: 24,
    scrollback: cfg.general?.scrollback ?? 8000,
    shellIntegration: cfg.general?.shell_integration !== false,
    onData: (d) =>
      manager.feed(
        (spawnedId != null ? manager.get(spawnedId) : undefined) ?? entry,
        d,
      ),
  });
  spawnedId = id;
  manager.register(id, entry);
  const panels = {
    ...st().panels,
    [id]: { id, title: "", fgName: "", cwd, cpu: 0, attention: null, exited: false },
  };
  st().set({ panels });
  manager.hide(id);
  return id;
}

// ---------- eventos del backend ----------

function handleTick(t: SysTick) {
  const s = st();
  const panels = { ...s.panels };
  let dirty = false;
  for (const p of t.panels) {
    const meta = panels[p.id];
    if (!meta) continue;
    const fgName = p.fg_name.replace(/^-/, "");
    if (
      meta.fgName !== fgName ||
      meta.cwd !== p.cwd ||
      Math.abs(meta.cpu - p.cpu) > 2
    ) {
      panels[p.id] = { ...meta, fgName, cwd: p.cwd || meta.cwd, cpu: p.cpu };
      dirty = true;
    }
  }
  const metrics = {
    appRam: t.app_ram_mb,
    workloadRam: t.workload_ram_mb,
    appCpu: t.app_cpu,
  };
  if (dirty) s.set({ panels, metrics });
  else s.set({ metrics });
}

// ---------- boot ----------

export async function boot() {
  // ¿Hay daemon con conversaciones vivas? Con daemon, el boot RECONCILIA
  // (re-adopta) en vez de arrasar. Sin daemon, mundo clasico: pagina fresca =
  // sin PTYs huerfanos de reloads anteriores.
  const dinfo = await ipc.ptyDaemonInfo().catch(() => ({ on: false, terms: [] as ipc.DaemonTermInfo[] }));
  if (dinfo.on) {
    // RELOAD del webview (⌘R): el proceso de la app sigue vivo con las
    // sesiones/sinks de la pagina ANTERIOR (channels muertos). Soltarlas sin
    // matar — pty_adopt exige estado limpio, y sin esto decia "ya adoptada"
    // y el boot caia a spawns frescos dejando las conversaciones huerfanas
    // (cazado E2E 30 jul). En arranque de proceso nuevo es un no-op.
    await ipc.ptyDetachAll().catch(() => {});
  } else {
    await ipc.ptyKillAll().catch(() => {});
  }
  adoptable.clear();
  for (const t of dinfo.terms) adoptable.set(t.id, t);
  const cfg = await ipc.configGet();
  applyConfig(cfg);

  // la app SIEMPRE abre en el taller — el lector (espejo) solo aparece
  // cuando lo pides (⌃Tab / ⌘L)

  await listen<SysTick>("sys://tick", (e) => handleTick(e.payload));
  await listen<{ id: number; code: number | null }>("pty://exit", (e) => {
    const { id } = e.payload;
    // modelo VSCode: shell muerto = conversacion cerrada. Nada de cascarones
    // "exited" ocupando campo (el bug del espacio vacio).
    if (st().panels[id]) closePanel(id);
  });
  await listen<AppConfig>("config://changed", (e) => applyConfig(e.payload));
  // eventos semanticos del engine (parsea SIEMPRE, con cualquier renderer)
  await listen<{ id: number; kind: string; data: string }>("engine://evt", (e) => {
    const { id, kind, data } = e.payload;
    const s = st();
    const p = s.panels[id];
    if (!p) return;
    if (kind === "title") {
      if (data.trim() && data !== p.title) s.setPanel(id, { title: data });
    } else if (kind === "bell") {
      if (s.focused !== id) s.setAttention(id, "bell");
    } else if (kind === "cwd") {
      if (data && data !== p.cwd) {
        s.setPanel(id, { cwd: data });
        scheduleSessionSave();
      }
    } else if (kind === "attention") {
      // nervio aferente en la UI: agente esperando input (quiet) o proceso
      // caliente (hot). Con el chat abierto aplica aunque este "enfocada":
      // Daniel no la esta viendo.
      if (s.focused !== id || s.ui.chat) s.setAttention(id, "wait");
    } else if (kind === "clipboard") {
      // OSC 52: el programa pide copiar al clipboard del sistema
      void navigator.clipboard?.writeText(data).catch(() => {});
    }
  });
  await listen<string[]>("fs://changed", () => {
    scheduleGitRefresh();
    window.dispatchEvent(new CustomEvent("sfterm:fs-changed"));
  });

  // git espejo tambien por intervalo (ops dentro de .git no disparan fs://changed)
  setInterval(() => void refreshGit(), 8000);
  // refresco periodico de sesion (cwd drift)
  setInterval(() => scheduleSessionSave(), 15000);

  const raw = cfg.general.restore_session ? await ipc.sessionLoad() : null;
  const session = migrateSession(raw);
  if (session && (session.tree || session.dock.length)) {
    st().set({ presetName: session.preset || "" });
    await setTreeRoot(session.treeRoot || (await ipc.fsHomeDir()));
    const tree = session.tree ? await restoreTree(session.tree) : null;
    st().setRoot(tree);
    for (const d of session.dock ?? []) {
      const adopted =
        d.termId != null && adoptable.has(d.termId)
          ? await adoptDetached(d.termId)
          : null;
      const id = adopted ?? (await spawnDetached(d.cwd));
      st().set({ dock: [...st().dock, id] });
    }
    const firstLeaf = tree ? T.leaves(tree)[0] : null;
    if (firstLeaf) {
      st().set({ focusedLeaf: firstLeaf.id });
      const act = T.activeTab(firstLeaf);
      if (act?.kind === "term") requestAnimationFrame(() => manager.focus(act.id));
    }
    // recuerda el campo viewer si quedo alguno con archivos
    const fileLeaf = T.leaves(tree).find((l) => l.tabs.some((t) => t.kind === "file"));
    if (fileLeaf) st().set({ viewerLeaf: fileLeaf.id });
    // primera apertura del dia: briefing automatico aunque haya sesion
    void maybeDailyKickoff(cfg);
  } else if (adoptable.size > 0) {
    // sin sesion guardada pero el daemon tiene conversaciones VIVAS (p.ej.
    // session.json borrado): se adoptan como pestañas de un solo campo — la
    // verdad del daemon manda sobre el preset frio
    await setTreeRoot(await ipc.fsHomeDir());
    const leaf = T.makeLeaf([], 0);
    const tabs: TabItem[] = [];
    for (const t of [...adoptable.values()]) {
      const id = await adoptDetached(t.id);
      if (id != null) tabs.push({ kind: "term", id });
    }
    if (tabs.length) {
      leaf.tabs = tabs;
      leaf.active = 0;
      st().setRoot(leaf);
      st().set({ focusedLeaf: leaf.id });
    } else {
      await spawnPanel({ target: { at: "auto" } });
    }
    void maybeDailyKickoff(cfg);
  } else {
    const preset =
      cfg.presets?.find((p) => p.name === cfg.general.default_preset) ??
      cfg.presets?.[0];
    if (preset) {
      await applyPreset(preset);
    } else {
      await setTreeRoot(await ipc.fsHomeDir());
      await spawnPanel({ target: { at: "auto" } });
    }
  }
  // SOBRANTES del daemon: conversaciones vivas que la sesion no reclamo (nacieron
  // despues del ultimo save, o el layout las perdio). Al dock — visibles en el
  // rail, sin robar layout. Una conversacion viva jamas se queda invisible.
  for (const t of [...adoptable.values()]) {
    const id = await adoptDetached(t.id);
    if (id != null) st().set({ dock: [...st().dock, id] });
  }
  st().set({ booted: true });
}

/** Migra sesiones v1 (grid de zonas) al arbol. */
function migrateSession(raw: unknown): SessionData | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.version === 2) return raw as SessionData;
  if (!("zones" in o)) return null;
  const v1 = raw as unknown as SessionDataV1;
  const cwds = (v1.zones ?? []).filter((z): z is { cwd: string } => z !== null);
  const tree: T.SerializedNode | null = cwds.length
    ? cwds.length === 1
      ? { kind: "leaf", tabs: [{ kind: "term", cwd: cwds[0].cwd }], active: 0 }
      : {
          kind: "split",
          dir: "row",
          sizes: cwds.map(() => 1 / cwds.length),
          children: cwds.map((z) => ({
            kind: "leaf" as const,
            tabs: [{ kind: "term" as const, cwd: z.cwd }],
            active: 0,
          })),
        }
    : null;
  return {
    version: 2,
    treeRoot: v1.treeRoot,
    preset: v1.preset,
    tree,
    dock: v1.dock ?? [],
  };
}

// ---------- paths clickeados (LINKS VIVOS, F2) ----------

/** Un token YA resuelto por Rust abre lo que ES: carpeta → Finder; con
 *  :linea → visor saltando a ella; archivo pelado → visor. */
function openResolved(r: L.ResolvedToken) {
  if (r.is_dir) void ipc.revealInFinder(r.path);
  else if (r.line) openViewerAt(r.path, r.line);
  else openFileTab(r.path);
}

L.setOnOpenResolved(openResolved);
// candidatos clickeados en el renderer propio (canvas): la VERDAD se decide
// al click, contra el cwd VIVO de esa terminal; inexistente = click muerto
window.addEventListener("sfterm:open-token", (e) => {
  const d = (e as CustomEvent<{ token: string; termId: number }>).detail;
  if (!d?.token) return;
  const cwd = st().panels[d.termId]?.cwd || st().treeRoot;
  void L.resolveToken(d.token, cwd).then((r) => {
    if (r) openResolved(r);
  });
});
