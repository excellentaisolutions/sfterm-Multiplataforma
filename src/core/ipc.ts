import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  AppConfig,
  CheckpointInfo,
  DirEntryInfo,
  GitLogInfo,
  GitStatusInfo,
  GitSyncState,
  SessionData,
} from "./types";

function toU8(msg: unknown): Uint8Array {
  if (msg instanceof ArrayBuffer) return new Uint8Array(msg);
  if (msg instanceof Uint8Array) return msg;
  if (Array.isArray(msg)) return new Uint8Array(msg as number[]);
  // string fallback (no deberia pasar con Raw)
  return new TextEncoder().encode(String(msg));
}

export interface FeatureCapability {
  available: boolean;
  reason: string | null;
}

export interface PlatformCapabilities {
  os: "macos" | "windows";
  browserHost: FeatureCapability;
  voiceCapture: FeatureCapability;
  windowCapture: FeatureCapability;
}

export const platformCapabilities = () =>
  invoke<PlatformCapabilities>("platform_capabilities");

export async function ptySpawn(opts: {
  cwd?: string;
  command?: string;
  cols: number;
  rows: number;
  scrollback?: number;
  shellIntegration?: boolean;
  onData: (data: Uint8Array) => void;
}): Promise<number> {
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (msg) => opts.onData(toU8(msg));
  return invoke<number>("pty_spawn", {
    cwd: opts.cwd ?? null,
    command: opts.command ?? null,
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback ?? null,
    shellIntegration: opts.shellIntegration ?? null,
    onData: ch,
  });
}

/** Terminales VIVAS en el daemon sfterm-ptyd (sobreviven a la app). */
export interface DaemonTermInfo {
  id: number;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
  born_ms: number;
  buffered: number;
}
export interface DaemonInfo {
  on: boolean;
  terms: DaemonTermInfo[];
}
export const ptyDaemonInfo = () => invoke<DaemonInfo>("pty_daemon_info");
/** Reload del webview en modo daemon: suelta TODO sin matar nada (las del
 *  daemon siguen vivas y el boot nuevo las re-adopta; las locales mueren). */
export const ptyDetachAll = () => invoke<void>("pty_detach_all");

/** Info que devuelve la adopcion: el tamaño REAL del PTY en el daemon — el
 *  replay viene formateado a ese ancho; el layout re-dimensiona despues. */
export interface AdoptInfo {
  id: number;
  pid: number;
  cwd: string;
  cols: number;
  rows: number;
}

/** Re-engancha una terminal viva del daemon: mismo canal binario que
 *  ptySpawn, pero el proceso ya existia (replay repinta la pantalla). */
export async function ptyAdopt(opts: {
  id: number;
  scrollback?: number;
  onData: (data: Uint8Array) => void;
}): Promise<AdoptInfo> {
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (msg) => opts.onData(toU8(msg));
  return invoke<AdoptInfo>("pty_adopt", {
    id: opts.id,
    scrollback: opts.scrollback ?? null,
    onData: ch,
  });
}

/** Una sesion del HISTORIAL en disco (indexada por Rust, filtros de
 *  maquinaria/cascarones incluidos). Ver src-tauri/src/hist.rs. */
export interface SessionCardIpc {
  sid: string;
  path: string;
  config_dir: string | null;
  cwd: string;
  title: string | null;
  mtime_ms: number;
  size: number;
}
export const sessionsIndex = (days?: number, limit?: number) =>
  invoke<SessionCardIpc[]>("sessions_index", {
    days: days ?? null,
    limit: limit ?? null,
  });

export const ptyWrite = (id: number, data: string) =>
  invoke<void>("pty_write", { id, data });

export const ptyInterrupt = (id: number, force = false) =>
  invoke<void>("pty_interrupt", { id, force });

export const ptyResize = (id: number, cols: number, rows: number) =>
  invoke<void>("pty_resize", { id, cols, rows });

/** ⌘R: relanza la app completa (proceso nuevo → toma el build recien
 *  instalado; la sesion se restaura como en cualquier arranque). */
export const appRelaunch = () => invoke<void>("app_relaunch");
export const ptyKill = (id: number) => invoke<void>("pty_kill", { id });
export const ptyKillAll = () => invoke<void>("pty_kill_all");
/** La sesion de Claude Code que corre DE VERDAD en el PTY (verdad del piso:
 *  nacimiento / argv / titulo). null = sin claude vivo o sin match. `path` es
 *  la ruta REAL del jsonl (respeta CLAUDE_CONFIG_DIR — bro-claude vive en
 *  ~/.claude-bro; el frontend NUNCA reconstruye la ruta a mano, bug 21 jul).
 *  `config_dir` viene solo si el proceso corre con cuenta no-default. */
export interface TermSessionInfo {
  sid: string;
  path: string;
  config_dir: string | null;
  /** COMO lo supo Rust: "argv" · "titulo" (verdades duras) · "nacimiento"
   *  (heuristica). Debug + gate `truth`: un match debil se ve identico a una
   *  verdad dura hasta que dice de donde salio. */
  how?: "argv" | "titulo" | "nacimiento";
}
export const termSession = (id: number) => invoke<TermSessionInfo | null>("term_session", { id });

export const configGet = () => invoke<AppConfig>("config_get");
export const configPath = () => invoke<string>("config_path");
export const configSet = (entries: [string, unknown][]) =>
  invoke<void>("config_set", { entries });

export const gitStatus = (root: string) =>
  invoke<GitStatusInfo>("git_status", { root });
export const gitDiffFile = (root: string, path: string) =>
  invoke<string>("git_diff_file", { root, path });

// ---- Source Control espejo (28 jul 2026): todo LECTURA ----
export const gitState = (root: string) =>
  invoke<GitSyncState>("git_state", { root });
export const gitLog = (root: string, skip: number, limit: number) =>
  invoke<GitLogInfo>("git_log", { root, skip, limit });
/** escribe el detalle del commit como .patch en el cache y devuelve la ruta */
export const gitCommitFile = (root: string, hash: string) =>
  invoke<string>("git_commit_file", { root, hash });

// ---- Checkpoints de agente: refs ocultos refs/sfterm/checkpoints/* ----
export const checkpointSave = (root: string, label?: string) =>
  invoke<CheckpointInfo>("checkpoint_save", { root, label: label ?? null });
export const checkpointList = (root: string, limit?: number) =>
  invoke<CheckpointInfo[]>("checkpoint_list", { root, limit: limit ?? null });
export const checkpointDiff = (root: string, id: string) =>
  invoke<string>("checkpoint_diff", { root, id });
export const checkpointDiffFile = (root: string, id: string) =>
  invoke<string>("checkpoint_diff_file", { root, id });
export const checkpointRestore = (root: string, id: string) =>
  invoke<CheckpointInfo>("checkpoint_restore", { root, id });

export const fsListDir = (path: string) =>
  invoke<DirEntryInfo[]>("fs_list_dir", { path });
export const fsReadFile = (path: string, maxBytes?: number) =>
  invoke<{ kind: string; content: string; size: number }>("fs_read_file", {
    path,
    maxBytes: maxBytes ?? null,
  });
export const fsHomeDir = () => invoke<string>("fs_home_dir");
export const fsTempPath = (name: string) => invoke<string>("fs_temp_path", { name });
export const fsIndex = (root: string) => invoke<string[]>("fs_index", { root });
export const fsSearch = (root: string, q: string, max?: number) =>
  invoke<{ path: string; line: number; preview: string }[]>("fs_search", {
    root,
    q,
    max: max ?? null,
  });
export const fsWatchRoot = (root: string) =>
  invoke<void>("fs_watch_root", { root });
export const revealInFinder = (path: string) =>
  invoke<void>("reveal_in_finder", { path });
/** Manda a la PAPELERA del sistema (recuperable con "Devolver" del Finder),
 *  jamas borra en duro. El backend ignora todo lo que no viva dentro de `root`
 *  y devuelve por que, path por path. */
export const fsTrash = (paths: string[], root: string) =>
  invoke<{ trashed: string[]; errors: string[] }>("fs_trash", { paths, root });
export const openUrl = (url: string) => invoke<void>("open_url", { url });
/** LINKS VIVOS (F2): resuelve un token de path del output (relativo/absoluto/
 *  ~/:linea) contra el cwd de esa terminal y verifica existencia. null = no
 *  existe → el frontend NO pinta link. */
export const fsResolveToken = (token: string, cwd: string) =>
  invoke<{ path: string; line: number | null; col: number | null; is_dir: boolean } | null>(
    "fs_resolve_token",
    { token, cwd },
  );

/** ADJUNTOS del lector (26 jul 2026). `attachSave` materializa una imagen
 *  pegada al directorio de datos local de SFTerm y devuelve su ruta (viaja al agente como
 *  ruta, no como base64 — ver attach.rs). `transcriptImage` saca bajo demanda
 *  una imagen que YA vive dentro de un transcript, que readTail stripea antes
 *  de cruzar el IPC; devuelve un data URI listo para <img src>. */
export const attachSave = (dataB64: string, ext: string) =>
  invoke<string>("attach_save", { dataB64, ext });
export const transcriptImage = (path: string, uuid: string, index: number) =>
  invoke<string>("transcript_image", { path, uuid, index });
/** Una imagen del DISCO como data URI. No usa el asset protocol a proposito:
 *  cuando ese falla, falla mudo (el <img> dispara onError y ya). Ver attach.rs. */
export const localImage = (path: string) => invoke<string>("local_image", { path });

export const fontsList = () =>
  invoke<{ all: string[]; mono: string[] }>("fonts_list");

export const sessionSave = (data: SessionData) =>
  invoke<void>("session_save", { data });
export const sessionLoad = () =>
  invoke<SessionData | null>("session_load");

// motor propio (engine): semantica + frames
import type { BlockInfo, BlockText } from "./types";

export function engineSubscribe(
  id: number,
  onFrame: (data: Uint8Array) => void,
): Promise<void> {
  const ch = new Channel<ArrayBuffer>();
  ch.onmessage = (msg) => onFrame(toU8(msg));
  return invoke<void>("engine_subscribe", { id, onFrame: ch });
}
export const engineUnsubscribe = (id: number) =>
  invoke<void>("engine_unsubscribe", { id });
export const engineSetViewport = (id: number, offset: number, relative: boolean) =>
  invoke<number>("engine_set_viewport", { id, offset, relative });
export const engineText = (id: number, lines: number) =>
  invoke<string>("engine_text", { id, lines });
export const engineBlocks = (id: number, n?: number) =>
  invoke<BlockInfo[]>("engine_blocks", { id, n: n ?? null });
export const engineBlockText = (id: number, blockId?: number, maxLines?: number) =>
  invoke<BlockText>("engine_block_text", {
    id,
    blockId: blockId ?? null,
    maxLines: maxLines ?? null,
  });
export const engineRangeText = (
  id: number,
  startAbs: number,
  startCol: number,
  endAbs: number,
  endCol: number,
) => invoke<string>("engine_range_text", { id, startAbs, startCol, endAbs, endCol });
export const engineSetTheme = (fg: string, bg: string, ansi: string[]) =>
  invoke<void>("engine_set_theme", { fg, bg, ansi });
export const engineFind = (id: number, q: string, fromAbs?: number, backward?: boolean) =>
  invoke<[number, number] | null>("engine_find", {
    id,
    q,
    fromAbs: fromAbs ?? null,
    backward: backward ?? false,
  });

// (agentSend/agentSendArbrain/arbrainHealth/subagentRadar/chipMessages/
//  attachSave murieron con el chat nativo — purga 21 jul, agent.rs fuera)

// dictado por voz (ffmpeg + whisper local)
export interface VoiceStatus {
  ffmpeg: boolean;
  whisper: boolean;
  model: string | null;
  available?: boolean;
  reason?: string | null;
  backend?: string;
  device?: string | null;
}
export const voiceStatus = () => invoke<VoiceStatus>("voice_status");
export const voiceStart = () => invoke<void>("voice_start");
export const voiceStop = () => invoke<string>("voice_stop");
export const voiceCancel = () => invoke<void>("voice_cancel");

// ---- NAVEGADOR DEL AGENTE (F1): WKWebView top-level SIN IPC de Tauri ----
export interface BrowserState {
  url: string;
  title: string;
  loading: boolean;
  /** estimatedProgress de WebKit (0-1) — barra de progreso del chrome */
  progress: number;
  can_back: boolean;
  can_forward: boolean;
}
/** Dialogo JS pendiente (alert/confirm/prompt) — se pinta in-app y se
 *  responde con browserDialogReply; el JS de la pagina espera mientras. */
export interface BrowserDialog {
  id: number;
  view: number;
  kind: "alert" | "confirm" | "prompt";
  message: string;
  default_text: string;
}
export interface BrowserDownload {
  id: number;
  url: string;
  dest: string;
  state: "running" | "done" | "failed";
  error: string | null;
}
export const browserCreate = (id: number) => invoke<void>("browser_create", { id });
export const browserClose = (id: number) => invoke<void>("browser_close", { id });
/** Rect en CSS px top-left + window.innerWidth (la escala/zoom se deriva en
 *  Rust) — mismo patron imperativo que manager.place de las terminales. */
/** `backstage` manda el webview fuera de pantalla PERO CON CUERPO (ignora el
 *  rect). Es como vive un ala plegada: con layout real, para que su agente
 *  pueda medir y clickear sin tener que desplegarla y robarle la pantalla a
 *  Daniel. Ver browser.rs::browser_place. */
export const browserPlace = (
  id: number,
  r: { x: number; y: number; w: number; h: number },
  visible: boolean,
  backstage = false,
) =>
  invoke<void>("browser_place", {
    id,
    backstage,
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    innerW: window.innerWidth,
    visible,
  });
export const browserGoto = (id: number, url: string) =>
  invoke<string>("browser_goto", { id, url });
export const browserNav = (id: number, action: "back" | "forward" | "reload" | "stop") =>
  invoke<void>("browser_nav", { id, action });
export const browserStateGet = (id: number) => invoke<BrowserState>("browser_state", { id });
/** Evalua una EXPRESION JS en la pagina (wrapper JSON.stringify en Rust).
 *  Base de los verbos read/click/type del gate. */
export const browserEval = (id: number, js: string) =>
  invoke<string>("browser_eval", { id, js });
/** PNG del navegador — la mitad "ver" del lazo del agente.
 *  `w`/`h` = MEDIDA EXACTA (px CSS): la pagina se re-maqueta a ese tamaño
 *  fuera de pantalla, se retrata y el webview vuelve a como estaba. Sin
 *  medida, retrata el panel tal cual — que depende de como tengas el layout
 *  ese dia, y eso no sirve para una lamina que debe salir a 1920. */
export const browserSnap = (id: number, path: string, w?: number, h?: number) =>
  invoke<string>("browser_snap", { id, path, w, h });
/** PNG de la PAGINA COMPLETA: height = scrollHeight (px CSS) medido con eval. */
export const browserFullsnap = (id: number, path: string, height: number) =>
  invoke<string>("browser_fullsnap", { id, path, height });
/** Zoom del contenido del navegador (magnification, 1.0 = 100%). */
export const browserZoom = (id: number, factor: number) =>
  invoke<void>("browser_zoom", { id, factor });
/** MODO iPHONE: user agent movil on/off (el caller angosta el frame y recarga). */
export const browserSetMobile = (id: number, on: boolean) =>
  invoke<void>("browser_set_mobile", { id, on });
export const browserDialogs = () => invoke<BrowserDialog[]>("browser_dialogs");
export const browserDialogReply = (id: number, accept: boolean, text?: string) =>
  invoke<void>("browser_dialog_reply", { id, accept, text: text ?? null });
export const browserDownloads = () => invoke<BrowserDownload[]>("browser_downloads");
/** SUBIR ARCHIVOS: arma las rutas que el delegate le contestara al proximo
 *  panel de seleccion, SIN mostrar dialogo nativo. Lista vacia = desarmar. */
export const browserSetFiles = (id: number, paths: string[]) =>
  invoke<void>("browser_set_files", { id, paths });
/** SESION LIMPIA: borra cookies, localStorage y cache de TODOS los sitios —
 *  para ver tu propio producto como quien llega por primera vez. */
export const browserClearSession = () => invoke<number>("browser_clear_session");
/** PDF de la pagina completa (createPDFWithConfiguration de WebKit). */
export const browserPdf = (id: number, path: string) =>
  invoke<string>("browser_pdf", { id, path });
/** Descarga DIRECTA por url (verbo del agente); path fija el destino exacto. */
export const browserDownload = (id: number, url: string, path?: string) =>
  invoke<void>("browser_download", { id, url, path: path ?? null });

// puerta de agentes + kickoff
export const gatePoll = () =>
  invoke<Record<string, unknown> | null>("gate_poll");
export const gateResult = (id: string, json: string) =>
  invoke<void>("gate_result", { id, json });
export const snapWindow = (path: string) =>
  invoke<void>("snap_window", { path });
export const shellCapture = (cmd: string, cwd?: string) =>
  invoke<string>("shell_capture", { cmd, cwd: cwd ?? null });
