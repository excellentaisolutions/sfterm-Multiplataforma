/** Adaptadores completos de historial por proveedor.
 *
 * La vitrina solo registra un proveedor si sabe descubrir, leer y reanudar
 * sus sesiones. Leer nunca ejecuta el CLI ni requiere credenciales.
 */
import * as ipc from "./ipc";
import type { ConvCard } from "./histgroup";
import {
  claudeResumeCommand,
  codexResumeCommand,
  kimiResumeCommand,
} from "./shell-command";

export type { ConvCard } from "./histgroup";

export interface ConvProvider {
  key: ConvCard["provider"];
  list(): Promise<ConvCard[]>;
  resumeCommand(card: ConvCard, agentCommand: string, prompt?: string): string;
  /** El CLI acepta el primer turno en argv y evita carreras durante replay. */
  promptInCommand?: boolean;
  atPrompt?(tail: string): boolean;
}

const fromIpc = (
  provider: ConvCard["provider"],
  cards: ipc.SessionCardIpc[],
): ConvCard[] =>
  cards.map((c) => ({
    provider,
    sid: c.sid,
    path: c.path,
    configDir: c.config_dir,
    cwd: c.cwd,
    title: c.title,
    model: c.model ?? null,
    mtimeMs: c.mtime_ms,
  }));

export const claudeProvider: ConvProvider = {
  key: "claude",
  async list() {
    return fromIpc("claude", await ipc.sessionsIndex().catch(() => []));
  },
  promptInCommand: true,
  resumeCommand(card, agentCommand, prompt) {
    return claudeResumeCommand(
      agentCommand,
      card.sid,
      card.configDir,
      prompt,
      undefined,
      card.model,
    );
  },
  atPrompt(tail) {
    return tail.split("\n").some((line) => line.trim() === "❯");
  },
};

export const codexProvider: ConvProvider = {
  key: "codex",
  promptInCommand: true,
  async list() {
    return fromIpc("codex", await ipc.codexSessionsIndex().catch(() => []));
  },
  resumeCommand(card, _agentCommand, prompt) {
    return codexResumeCommand(card.sid, card.cwd, card.model, card.configDir, prompt);
  },
};

export const kimiProvider: ConvProvider = {
  key: "kimi",
  async list() {
    return fromIpc("kimi", await ipc.kimiSessionsIndex().catch(() => []));
  },
  resumeCommand(card) {
    return kimiResumeCommand(card.sid, card.model, card.configDir);
  },
  atPrompt(tail) {
    // Kimi Code dibuja el editor con `>` y bordes laterales. Mirar solo el
    // fondo evita confundir citas del replay con el input vacio.
    return tail
      .split("\n")
      .slice(-12)
      .some((line) => /^[│┃┆┊|]?\s*>\s*[│┃┆┊|]?$/.test(line.trim()));
  },
};

export const providers: ConvProvider[] = [claudeProvider, codexProvider, kimiProvider];

export function providerOf(card: ConvCard): ConvProvider {
  return providers.find((provider) => provider.key === card.provider) ?? claudeProvider;
}
