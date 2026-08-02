/** "wait" = el nervio detecto un agente esperando input (quiet) o un proceso
 *  caliente (hot): la señal fuerte del backstage hacia el HOME. */
export type Attention = null | "output" | "bell" | "exit" | "wait";

/** Origen de un drag: terminal del rail, tab de un leaf, o archivo(s) del
 *  arbol. `path` = el primero (compat de un solo archivo); `paths` = la
 *  lista completa (multi-seleccion, ver Tree.tsx). */
export type DragSrc =
  | { kind: "rail"; ptyId: number }
  | { kind: "tab"; leafId: string; index: number }
  | { kind: "file"; path: string; paths: string[] };

export type DropRegion = "center" | "left" | "right" | "top" | "bottom" | "tabs";

/** Parsea el payload "text/plain" de un drag nativo del arbol: uno o varios
 *  paths absolutos separados por "\n" (multi-seleccion). Un solo path sin
 *  salto de linea es 100% compatible con el caso de siempre. Sin dependencias
 *  (usado por Tiling.tsx y term.ts — importar desde actions.ts crearia un
 *  ciclo, term.ts -> actions.ts -> term.ts). */
export function parseDroppedPaths(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((p) => p.startsWith("/"));
}

export interface DropHint {
  leafId: string | null; // null = workspace vacio (drop en todo el centro)
  region: DropRegion;
  tabIndex?: number; // para drops sobre la tab bar
}

export interface PanelMeta {
  id: number;
  title: string;
  customTitle?: string;
  fgName: string;
  cwd: string;
  cpu: number;
  attention: Attention;
  exited: boolean;
}

export interface Theme {
  bg: string;
  bg_panel: string;
  bg_rail: string;
  bg_status: string;
  fg: string;
  fg_dim: string;
  accent: string;
  border: string;
  cursor: string;
  selection: string;
  green: string;
  red: string;
  yellow: string;
  ansi: string[];
}

export interface Preset {
  name: string;
  root: string;
  /** legacy v1 (se ignora: el arbol se arma por numero de panes) */
  layout?: number;
  panes: string[];
  /** comando de shell (cwd = root): su stdout se manda como PRIMER prompt al
   *  primer pane "agent" cuando este listo. El morning briefing automatico. */
  kickoff?: string;
}

export interface AppConfig {
  general: {
    default_preset: string;
    agent_command: string;
    restore_session: boolean;
    scrollback: number;
    /** OSC 133/633/7 en zsh (bloques + cwd). default true */
    shell_integration?: boolean;
    /** CLIs agenticos que el LECTOR (⌃Tab) reconoce. Se matchea contra el
     *  nombre del proceso Y el titulo OSC, en minusculas (kimi corre bajo
     *  python: su nombre no sirve, su titulo si). Ausente = el default de
     *  `core/agents.ts` — por eso los configs viejos no necesitan migracion. */
    agent_procs?: string[];
    // chat_backend / home / app_mode: llaves muertas de la era chat-first
    // (purga 21 jul) — pueden seguir en configs viejos, la app las ignora
  };
  appearance: {
    theme: string;
    ui_font: string;
    ui_font_size: number;
    terminal_font: string;
    terminal_font_size: number;
    terminal_padding: number;
    opacity: number;
    renderer?: string;
    /** zoom de pagina completa estilo VSCode (cmd+/-/0). 1.0 = 100% */
    zoom?: number;
  };
  themes: Record<string, Theme>;
  keys: Record<string, string>;
  presets: Preset[];
}

export interface GitStatusInfo {
  is_repo: boolean;
  branch: string;
  changed: number;
  files: Record<string, string>;
  ignored: string[];
}

/** Source Control espejo (28 jul 2026): estado de sincronia local ↔ nube. */
export interface GitSyncState {
  is_repo: boolean;
  branch: string;
  /** "origin/main" — null = rama sin upstream */
  upstream: string | null;
  /** commits solo en este disco (sin push) */
  ahead: number;
  /** commits de la nube que no tengo */
  behind: number;
  has_remote: boolean;
  dirty: number;
  head: string | null;
}

/** chip de ref sobre un commit: "main", "origin/main"… */
export interface GitRefChip {
  name: string;
  remote: boolean;
  head: boolean;
}

export interface GitCommitInfo {
  hash: string;
  /** hash completo — parents referencia estos (grafo) */
  full: string;
  msg: string;
  time: number;
  author: string;
  /** true = algun remote ya lo tiene; false = SOLO LOCAL (o sin remotes) */
  in_cloud: boolean;
  parents: string[];
  refs: GitRefChip[];
}

export interface GitLogInfo {
  has_upstream: boolean;
  commits: GitCommitInfo[];
}

/** Checkpoint de agente: foto invisible del repo (ref oculto). */
export interface CheckpointInfo {
  id: string;
  label: string;
  time: number;
  files: number;
}

export interface SysTick {
  app_ram_mb: number;
  workload_ram_mb: number;
  app_cpu: number;
  panels: {
    id: number;
    shell_pid: number;
    fg_pid: number;
    fg_name: string;
    cwd: string;
    cpu: number;
  }[];
}

export interface DirEntryInfo {
  name: string;
  path: string;
  is_dir: boolean;
  is_symlink: boolean;
}

import type { SerializedNode } from "./tiling";

export interface SessionData {
  version: 2;
  treeRoot: string;
  preset: string;
  tree: SerializedNode | null;
  /** termId = terminal del daemon a re-adoptar si sigue viva (ver SerializedTab) */
  dock: { cwd: string; termId?: number }[];
}

/** Formato v1 (grid): se migra al cargar. */
export interface SessionDataV1 {
  layout: number;
  treeRoot: string;
  preset: string;
  zones: ({ cwd: string } | null)[];
  dock: { cwd: string }[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------- motor propio ----------

export interface BlockInfo {
  id: number;
  cmd: string;
  cwd: string;
  exit: number | null;
  duration_ms: number | null;
  running: boolean;
}

export interface BlockText extends Omit<BlockInfo, "id"> {
  text: string;
}
