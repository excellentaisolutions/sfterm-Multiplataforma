import { create } from "zustand";
import type { TilingNode } from "./tiling";
import type {
  AppConfig,
  Attention,
  CheckpointInfo,
  DragSrc,
  DropHint,
  GitCommitInfo,
  GitStatusInfo,
  GitSyncState,
  PanelMeta,
  Theme,
} from "./types";
import { pathBasename } from "./path-utils";

interface UIState {
  palette: boolean;
  finder: boolean;
  settings: boolean;
  findbar: boolean;
  composer: boolean;
  /** Modo Lectura de un bloque: null = cerrado. blockId undefined = ultimo. */
  reader: { ptyId: number; blockId?: number } | null;
  /** LECTOR abierto (la conversacion de una terminal con cara de chat). */
  chat: boolean;
  /** espejo de una sesion de terminal renderizada como conversacion (solo
   *  lectura). path=null = claude vivo SIN sesion aun (0 mensajes): el lector
   *  abre en "conversacion nueva" y su watcher adopta el jsonl al nacer.
   *  cfg = CLAUDE_CONFIG_DIR no-default (bro): revivir/resumir con esa cuenta.
   *  src (22 jul) = DE DONDE sale la conversacion:
   *    "transcript" — el jsonl de Claude Code (mensajes, tools, modelo, ctx)
   *    "screen"     — la PANTALLA de la terminal via el engine (cualquier otro
   *                   CLI agentico: kimi, codex, aider…). Sin metadatos, pero
   *                   con la respuesta legible y la barra de escribir. */
  chatMirror: {
    path: string | null;
    src?: "transcript" | "screen";
    termId?: number;
    sid?: string;
    title?: string;
    cwd?: string;
    cfg?: string;
  } | null;
  /** PEEK ⌥Tab (modo Terminales): vistazo temporal a la conversacion de la
   *  terminal enfocada — overlay sobre el taller, no una superficie. */
  /** panel de atajos de teclado (⌘⌥S) */
  shortcuts: boolean;
  /** drawer inferior (⌘J): terminal rapida sobre cualquier superficie */
  drawer: boolean;
  /** Busqueda por CONTENIDO en el proyecto (⌘⇧F). */
  search: boolean;
  /** Preview del dev server (overlay iframe): null = cerrado. */
  preview: string | null;
}

export interface StoreState {
  booted: boolean;
  config: AppConfig | null;
  theme: Theme | null;
  bindingsVersion: number;

  /** Arbol de tiling. null = workspace vacio. */
  root: TilingNode | null;
  /** Version del arbol: place() imperativo se re-dispara con esto. */
  treeVersion: number;
  dock: number[];
  panels: Record<number, PanelMeta>;
  /** Terminal enfocada (ptyId) — null si el foco esta en un tab de archivo. */
  focused: number | null;
  /** Leaf con foco (para atajos y aperturas). */
  focusedLeaf: string | null;
  /** Leaf preferido para abrir archivos (el "campo viewer"). */
  viewerLeaf: string | null;
  lastDocked: number | null;
  /** Terminales del drawer ⌘J en orden de tabs (pool propio, jamas en el tiling). */
  drawerTerms: number[];
  /** La tab ACTIVA del drawer (la unica visible). Invariante: ∈ drawerTerms. */
  drawerTermId: number | null;
  /** ORDEN MANUAL del rail (22 jul 2026): ids en el orden que Daniel arrastro.
   *  Es una PISTA, no la fuente de existencia: el rail pinta `panels` y solo
   *  usa esta lista para ordenar, asi que ids muertos aqui son inofensivos y
   *  una terminal nueva (sin entrada) cae al final por id. En MEMORIA a
   *  proposito — al reabrir la app los paneles nacen con ids NUEVOS, asi que
   *  persistirlo no tendria a que agarrarse (ver el tombstone del revival). */
  railOrder: number[];
  railVisible: boolean;
  treeVisible: boolean;
  treeRoot: string;
  presetName: string;
  /** Multi-seleccion del arbol de archivos (⌘+clic/⇧+clic): paths en orden.
   *  EN MEMORIA a proposito, jamas se persiste en la sesion. Se limpia al
   *  cambiar treeRoot/preset (ver actions.setTreeRoot). */
  treeSel: string[];
  /** Ancla del ultimo clic normal en el arbol: base del rango de ⇧+clic. */
  treeAnchor: string | null;

  git: GitStatusInfo | null;
  /** Source Control espejo (28 jul 2026): sincronia + historial + checkpoints
   *  del repo del treeRoot. Lo refresca refreshGit (mismo debounce). */
  scm: {
    sync: GitSyncState | null;
    log: GitCommitInfo[];
    hasUpstream: boolean;
    checkpoints: CheckpointInfo[];
  } | null;
  /** EXPANDIR (29 jul): id del campo que se queda con TODA la pantalla; el
   *  resto se pliega sin tocar el arbol. null = reparto normal. */
  soloLeaf: string | null;
  /** vista activa del sidebar derecho (estilo VS Code, 29 jul):
   *  "files" = arbol · "scm" = source control a panel completo */
  sideView: "files" | "scm";
  metrics: { appRam: number; workloadRam: number; appCpu: number };
  /** Espejo del NAVEGADOR DEL AGENTE (F1) por webview id: lo alimenta el poll
   *  de BrowserView; las pestañas y la barra beben de aqui. */
  browserMeta: Record<
    number,
    { url: string; title: string; loading: boolean; canBack: boolean; canForward: boolean }
  >;
  /** UX del navegador por webview (29 jul): mobile = modo iPhone (frame
   *  angosto + UA movil); extraH = px extra del chrome (dialogos JS, find,
   *  toast de descarga) que Tiling descuenta al posicionar el WKWebView. */
  browserUx: Record<number, { mobile: boolean; extraH: number }>;
  /** Salto pendiente a una linea de un archivo (busqueda/gate). El FileView
   *  lo consume al cargar el texto y lo limpia. */
  pendingJump: { path: string; line: number } | null;
  ui: UIState;
  dragging: { src: DragSrc; x: number; y: number } | null;
  dropHint: DropHint | null;

  set: (p: Partial<StoreState>) => void;
  setRoot: (root: TilingNode | null) => void;
  setPanel: (id: number, p: Partial<PanelMeta>) => void;
  setAttention: (id: number, a: Attention) => void;
  setUI: (p: Partial<UIState>) => void;
}

export const useStore = create<StoreState>((set, get) => ({
  booted: false,
  config: null,
  theme: null,
  bindingsVersion: 0,

  root: null,
  treeVersion: 0,
  dock: [],
  panels: {},
  focused: null,
  focusedLeaf: null,
  viewerLeaf: null,
  lastDocked: null,
  drawerTerms: [],
  drawerTermId: null,
  railOrder: [],

  railVisible: true,
  treeVisible: true,
  treeRoot: "",
  presetName: "",
  treeSel: [],
  treeAnchor: null,

  git: null,
  scm: null,
  soloLeaf: null,
  sideView: (localStorage.getItem("sfterm-side-view") === "scm" ? "scm" : "files") as
    | "files"
    | "scm",
  metrics: { appRam: 0, workloadRam: 0, appCpu: 0 },
  browserMeta: {},
  browserUx: {},
  pendingJump: null,
  ui: { palette: false, finder: false, settings: false, findbar: false, composer: false, reader: null, chat: false, chatMirror: null, shortcuts: false, drawer: false, search: false, preview: null },
  dragging: null,
  dropHint: null,

  set: (p) => set(p),
  setRoot: (root) => set({ root, treeVersion: get().treeVersion + 1 }),
  setPanel: (id, p) => {
    const panels = { ...get().panels };
    if (!panels[id]) return;
    panels[id] = { ...panels[id], ...p };
    set({ panels });
  },
  setAttention: (id, a) => {
    const panels = { ...get().panels };
    if (!panels[id]) return;
    // no pisar 'exit' con 'output'
    if (panels[id].attention === "exit" && a === "output") return;
    panels[id] = { ...panels[id], attention: a };
    set({ panels });
  },
  setUI: (p) => set({ ui: { ...get().ui, ...p } }),
}));

/** Titulo estilo conversacion. Prioridad: custom > titulo OSC (Claude Code
 *  emite ahi su RESUMEN de la conversacion) > "proc · carpeta" > carpeta. */
export function panelTitle(p: PanelMeta): string {
  if (p.customTitle) return p.customTitle;
  // titulo OSC solo si dice algo: el default de zsh ("user@host:path") es ruido
  if (p.title && !/^[\w.-]+@[\w.-]+\s*:/.test(p.title)) return p.title;
  const folder = p.cwd ? pathBasename(p.cwd) : "";
  const proc = p.fgName && p.fgName !== "zsh" && p.fgName !== "-zsh" ? p.fgName : "";
  if (proc && folder) return `${proc} · ${folder}`;
  if (folder) return folder;
  return `terminal ${p.id}`;
}
