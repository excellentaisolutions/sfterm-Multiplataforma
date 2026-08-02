/** QUE TERMINAL CUENTA COMO "AGENTE" (22 jul 2026) — SFTerm es agnostica de
 *  proveedor por diseño, pero el lector nacio cableado a Claude Code. Este
 *  modulo es el UNICO criterio: lo consumen la puerta del lector
 *  (actions.openReaderFor) y el propio lector.
 *
 *  El problema real: `fgName` no basta. Claude Code se reporta como "claude",
 *  pero Kimi Code corre bajo un interprete y `resolve_fg_name` (metrics.rs)
 *  devuelve "Python" — un nombre inservible como candado. Lo que SI lo
 *  identifica es su titulo OSC ("Kimi Code"). Por eso se matchea contra el
 *  nombre del proceso Y el titulo.
 *
 *  El candado anti-caos sigue intacto y es lo primero que se evalua: sobre un
 *  SHELL PELADO el lector no abre nunca, sin importar que diga su titulo (un
 *  `cd ~/kimi-stuff` no convierte a zsh en un agente).
 */
import type { AppConfig, PanelMeta } from "./types";

/** Fallback en codigo: los configs que ya existen no traen la llave y deben
 *  seguir funcionando sin migracion. El mismo set se documenta en el
 *  DEFAULT_CONFIG de config.rs para instalaciones nuevas. */
export const DEFAULT_AGENT_PROCS = [
  "claude",
  "kimi",
  "codex",
  "aider",
  "gemini",
  "opencode",
  "cursor-agent",
  "goose",
];

/** Shells: el candado duro. Sin `-` inicial y con el, que es como los reporta
 *  un login shell. */
const SHELLS = new Set([
  "zsh", "-zsh", "bash", "-bash", "sh", "-sh", "fish", "-fish",
  "dash", "-dash", "ksh", "-ksh", "tcsh", "-tcsh", "nu", "-nu",
]);

export function isShellProc(fgName: string | undefined | null): boolean {
  return SHELLS.has((fgName ?? "").toLowerCase());
}

/** Lista viva: `[general] agent_procs` del config.toml, o el default. */
export function agentProcs(cfg: AppConfig | null): string[] {
  const raw = cfg?.general?.agent_procs;
  if (!Array.isArray(raw)) return DEFAULT_AGENT_PROCS;
  const clean = raw
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  return clean.length ? clean : DEFAULT_AGENT_PROCS;
}

/** ¿Esta terminal corre un CLI agentico? (candado del lector) */
export function isAgentTerminal(p: PanelMeta | undefined | null, cfg: AppConfig | null): boolean {
  if (!p || p.exited) return false;
  const fg = (p.fgName ?? "").toLowerCase();
  // sin proceso en primer plano, o un shell pelado: JAMAS (candado anti-caos)
  if (!fg || isShellProc(fg)) return false;
  const title = (p.customTitle ?? p.title ?? "").toLowerCase();
  const hay = `${fg} ${title}`;
  return agentProcs(cfg).some((n) => hay.includes(n));
}

/** ¿Es Claude Code? Unico agente con adapter de TRANSCRIPT (su jsonl en
 *  ~/.claude/projects/…). Los demas caen al espejo de PANTALLA. Mismo criterio
 *  que `pty::term_session` en Rust: los dos deben decir lo mismo o un panel se
 *  veria "de claude" sin sesion-verdad detras. */
export function isClaudeTerminal(p: PanelMeta | undefined | null): boolean {
  return !!p && /claude/i.test(p.fgName ?? "");
}
