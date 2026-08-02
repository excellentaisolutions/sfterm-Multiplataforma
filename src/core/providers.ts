/** ADAPTADORES por proveedor de CLI agentico — la puerta multi-proveedor.
 *
 *  La vitrina y el lector son AGNOSTICOS: hablan `ConvCard` y esta interfaz.
 *  Lo que varia por CLI vive en su adaptador: como DESCUBRIR conversaciones
 *  en disco, y como REANUDAR una en una terminal nueva. Hoy hay UNO completo
 *  (Claude Code — el 100% del uso real); un CLI sin adaptador no aparece en
 *  el historial, pero su terminal viva se sigue leyendo por PANTALLA (el
 *  espejo `src:"screen"` del lector, que no pasa por aqui).
 *
 *  Para enchufar otro (p.ej. Kimi: `~/.kimi/sessions/<md5(cwd)>/<uuid>/
 *  context.jsonl`, roles user/assistant/tool): un objeto mas en `providers`
 *  con su list() (idealmente un comando Rust que indexe barato) y su
 *  resumeCommand(). La interfaz es deliberadamente MINIMA — pedirle mas a un
 *  proveedor del que no sabemos nada seria diseñar en el aire. */
import * as ipc from "./ipc";
import type { ConvCard } from "./histgroup";
import { claudeResumeCommand } from "./shell-command";

export type { ConvCard } from "./histgroup";

export interface ConvProvider {
  key: string;
  /** Historial en disco, mas reciente primero (filtrado de ruido). */
  list(): Promise<ConvCard[]>;
  /** Comando de shell que REANUDA la conversacion en una terminal nueva.
   *  `agentCommand` = la base configurada ([general] agent_command). */
  resumeCommand(card: ConvCard, agentCommand: string): string;
  /** ¿El TUI resumido ya esta EN SU PROMPT, listo para recibir texto? Recibe
   *  la cola de pantalla (engine, sin ANSI). Cazado E2E 30 jul: el resume
   *  imprime la conversacion vieja a rafagas con pausas largas — un quiet-gate
   *  generico se dispara a media carga y el texto cae al vacio. */
  atPrompt?(tail: string): boolean;
}

export const claudeProvider: ConvProvider = {
  key: "claude",
  async list() {
    const raw = await ipc.sessionsIndex().catch(() => [] as ipc.SessionCardIpc[]);
    return raw.map((c) => ({
      provider: "claude",
      sid: c.sid,
      path: c.path,
      configDir: c.config_dir,
      cwd: c.cwd,
      title: c.title,
      mtimeMs: c.mtime_ms,
    }));
  },
  resumeCommand(card, agentCommand) {
    return claudeResumeCommand(agentCommand, card.sid, card.configDir);
  },
  atPrompt(tail) {
    // la caja de input VACIA: una linea que es exactamente "❯". Los ecos de
    // la conversacion vieja son "❯ texto" — jamas la caja vacia.
    return tail.split("\n").some((l) => l.trim() === "❯");
  },
};

export const providers: ConvProvider[] = [claudeProvider];

export function providerOf(card: ConvCard): ConvProvider {
  return providers.find((p) => p.key === card.provider) ?? claudeProvider;
}
