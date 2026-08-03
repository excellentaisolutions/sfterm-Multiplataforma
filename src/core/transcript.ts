/** Lector de transcripts de Claude Code (~/.claude/projects/<slug>/<sesion>.jsonl).
 *
 *  La sesion en disco ES la verdad: el `claude` que corre en una terminal
 *  escribe ahi cada turno, y el LECTOR (⌃Tab) y el VISTAZO (⌥Tab) la
 *  ESPEJAN con cara de chat — solo lectura, tail + parse por poll. Escribir
 *  siempre pasa por la terminal dueña (PTY vivo o --resume ahi mismo):
 *  una sola pluma por cuaderno.
 */
import * as ipc from "./ipc";
import { toolSummary, ctxPctFrom, type ChatMsg, type MsgImage, type Part } from "./msgs";

export interface ParsedTranscript {
  msgs: ChatMsg[];
  title?: string;
  model?: string;
  /** effort del ultimo assistant (campo top-level del jsonl) */
  effort?: string;
  sessionId?: string;
  cwd?: string;
  /** % de contexto consumido (del usage del ultimo mensaje assistant) */
  ctxPct?: number;
  /** el tail corto el archivo: el inicio de la conversacion no esta */
  truncated: boolean;
  /** el espejo NO pudo leer (archivo inexistente, permiso, timeout). Existe
   *  para no confundir "no pude leerla" con "esta vacia": hasta el 27 jul las
   *  dos salian como "esta sesion aun no tiene mensajes legibles" y el fallo
   *  se veia identico a una conversacion recien nacida. */
  error?: string;
  /** Pulso del turno actual (espejo del spinner de la TUI): estado + inicio +
   *  ultima actividad + tokens de salida del turno (subagentes incluidos) +
   *  si la ultima respuesta termina preguntandote algo. */
  turn?: {
    state: "working" | "done";
    startedAt?: number;
    lastEventAt?: number;
    outputTokens: number;
    endsAsk: boolean;
  };
}

/** Slug de carpeta que usa Claude Code para agrupar sesiones por cwd. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Maquinaria de slash-commands en el jsonl → linea de SISTEMA sutil.
 *  undefined = no es maquinaria (prompt real) · null = descartar ·
 *  string = pintar como chip ("/model opus" · "Set model to Opus 4.8"). */
function fmtDurMs(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function sysLine(raw: string): string | null | undefined {
  const t = raw.trim();
  if (!t.startsWith("<")) return undefined;
  // aviso del harness al terminar un agente de fondo: NO es texto de Daniel —
  // se pinta como evento compacto (antes salia la burbuja con el XML crudo)
  if (t.startsWith("<task-notification>")) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(t)?.[1]?.trim() ?? "";
    const status = /<status>([^<]*)<\/status>/.exec(t)?.[1]?.trim();
    const tok = /<subagent_tokens>(\d+)<\/subagent_tokens>/.exec(t)?.[1];
    const dur = /<duration_ms>(\d+)<\/duration_ms>/.exec(t)?.[1];
    const nice = summary.replace(/^Agent "(.+)" finished$/, "Agente «$1» terminó")
      || "agente de fondo terminó";
    return [
      nice,
      dur ? fmtDurMs(+dur) : null,
      tok ? `↓${(+tok >= 1000 ? `${(+tok / 1000).toFixed(1)}k` : tok)} tokens` : null,
      status && status !== "completed" ? status : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }
  const name = /<command-name>([^<]+)<\/command-name>/.exec(t);
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim();
    return `${name[1].trim()}${args ? ` ${args}` : ""}`;
  }
  const out = /<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/.exec(t);
  if (out) {
    // fuera ANSI ([1m etc) y saltos: es un chip de una linea
    const clean = out[1].replace(/\u001b?\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
    return clean ? clean.slice(0, 200) : null;
  }
  if (t.startsWith("<command-message>") || t.startsWith("<local-command")) return null;
  return undefined;
}

/** El prompt del chat pega los adjuntos al final ("Archivos adjuntos…"):
 *  separarlos para pintarlos como thumbnails/chips, no como texto crudo. */
function splitAttachments(text: string): { text: string; attachments?: string[] } {
  const m = /\n?\n?Archivos adjuntos \(leelos\/analizalos\):\n((?:- .+\n?)+)\s*$/.exec(text);
  if (!m) return { text };
  const attachments = m[1]
    .split("\n")
    .map((l) => l.replace(/^- /, "").trim())
    .filter(Boolean);
  return { text: text.slice(0, m.index).trim(), attachments };
}

/** Cola del transcript. Los transcripts traen thinking/outputs gordos (400KB
 *  apenas daban ~3 mensajes en una sesion real), y sobre todo IMAGENES: cada
 *  screenshot pegado en el TUI se guarda como base64 INLINE en la misma linea
 *  del mensaje.
 *
 *  ⚠️ Medido el 26 jul sobre las sesiones reales de Daniel: 4,418 bloques
 *  `image`, con LINEAS DE HASTA 4 MB. Con la ventana vieja de 1MB, un solo
 *  screenshot al final se tragaba el tail entero y el lector mostraba "esta
 *  sesión aún no tiene mensajes legibles" — el espejo en blanco por una foto.
 *
 *  El backend Rust lee los ultimos 4 MB directamente, sin depender de `tail`,
 *  Perl ni de la familia del shell. Tambien vacia blobs base64 antes del IPC.
 *  El bloque `image` sobrevive con `data:""`, que es justo lo que necesita el
 *  frontend para saber que ahi hubo una imagen y pedirla bajo demanda
 *  (ipc.transcriptImage). */
export const readTail = (path: string) => ipc.transcriptTail(path);

/** Imagenes de UNA linea del jsonl, en ORDEN DE DOCUMENTO, con el hueco al que
 *  pertenecen: `slot` null = pegada por Daniel en el mensaje; `slot` = id de un
 *  tool_use = la devolvio ese tool_result (screenshot de Playwright y demas).
 *
 *  ⚠️ ESPEJO EXACTO de attach.rs::collect_images — content[] en orden y, dentro
 *  de un tool_result, su content[] en orden. El indice es el UNICO amarre entre
 *  los dos lados: cambiar el recorrido aqui sin cambiarlo alla hace que se abra
 *  una imagen distinta de la que se clickeo. Cuenta TODO bloque `image` aunque
 *  venga sin bytes (aqui SIEMPRE vienen sin bytes: readTail los stripeo). */
export function collectImages(
  message: Record<string, unknown> | undefined,
  uuid: string,
): Array<MsgImage & { slot: string | null }> {
  const out: Array<MsgImage & { slot: string | null }> = [];
  const content = message?.content;
  if (!Array.isArray(content)) return out;
  const push = (b: Record<string, unknown>, slot: string | null) => {
    const src = b.source as Record<string, unknown> | undefined;
    const mt = typeof src?.media_type === "string" ? src.media_type : "image/png";
    out.push({ uuid, index: out.length, mediaType: mt, slot });
  };
  for (const raw of content as Array<Record<string, unknown>>) {
    if (raw?.type === "image") {
      push(raw, null);
    } else if (raw?.type === "tool_result" && Array.isArray(raw.content)) {
      const slot = typeof raw.tool_use_id === "string" ? raw.tool_use_id : null;
      for (const ib of raw.content as Array<Record<string, unknown>>) {
        if (ib?.type === "image") push(ib, slot);
      }
    }
  }
  return out;
}

/** Tope de mensajes que se pintan. La ventana del tail subio a 4MB (ver
 *  readTail) y sin tope una sesion larga de puro texto pintaria miles de
 *  burbujas sin virtualizacion. 600 deja mas historia que la ventana vieja de
 *  1MB (~500) y protege el render. Recortar marca `truncated`: el lector avisa
 *  "inicio de la conversación fuera del espejo". */
const MAX_MSGS = 600;

/** Transcript jsonl → mensajes del chat. Ignora sidechains (subagentes),
 *  entradas meta y thinking. Los tool_result se pegan a su tool_use. */
export function parseTranscript(raw: string): ParsedTranscript {
  const lines = raw.split("\n").filter((l) => l.trim());
  const msgs: ChatMsg[] = [];
  // ids altos: no chocan con los de conversaciones reales (TTS usa el id)
  let id = 1_000_000;
  let title: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let truncated = false;
  let lastUsage: Record<string, unknown> | null = null;
  let open: ChatMsg | null = null; // assistant en curso (los tool_result no lo cierran)
  // pulso del turno: arranca en el ultimo prompt real; stop_reason lo cierra.
  // tool_use tambien lo ABRE (robusto cuando el tail corto el prompt inicial).
  let turnWorking = false;
  let turnStartedAt: number | undefined;
  let turnLastEventAt: number | undefined;
  // tokens por message.id (un mensaje API se parte en varias lineas jsonl con
  // el MISMO usage: contar por id evita duplicar)
  const tokByMsg = new Map<string, number>();

  const findTool = (toolUseId: string) => {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const p = msgs[i].parts?.find(
        (pp): pp is Extract<Part, { type: "tool" }> =>
          pp.type === "tool" && pp.toolId === toolUseId,
      );
      if (p) return p;
    }
    return null;
  };

  const attachResult = (toolUseId: string, out: string, isError: boolean) => {
    const p = findTool(toolUseId);
    if (!p) return;
    p.output = out.slice(0, 4000);
    p.isError = isError;
  };

  /** Las imagenes que devolvio un tool_result cuelgan de SU bloque de tool
   *  (se ven al expandirlo), no de una burbuja: no las mando Daniel. */
  const attachToolImages = (imgs: Array<MsgImage & { slot: string | null }>) => {
    for (const img of imgs) {
      if (!img.slot) continue;
      const p = findTool(img.slot);
      if (!p) continue;
      (p.images ??= []).push({ uuid: img.uuid, index: img.index, mediaType: img.mediaType });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      if (i === 0) truncated = true; // el tail corto la primera linea
      continue;
    }
    const ts = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : NaN;
    if (ev.isSidechain === true) {
      // los subagentes no se pintan, pero SI gastan tokens del turno
      if (ev.type === "assistant") {
        const m = ev.message as Record<string, unknown> | undefined;
        const u = m?.usage as Record<string, unknown> | undefined;
        if (u && typeof u.output_tokens === "number") {
          tokByMsg.set(typeof m?.id === "string" ? m.id : `sc-${i}`, u.output_tokens);
        }
        if (!Number.isNaN(ts)) turnLastEventAt = ts;
      }
      continue;
    }
    if (ev.isMeta === true) continue;
    if (typeof ev.sessionId === "string") sessionId = ev.sessionId;
    if (typeof ev.cwd === "string") cwd = ev.cwd;

    if (ev.type === "ai-title" && typeof ev.aiTitle === "string") {
      title = ev.aiTitle;
      continue;
    }
    if (ev.type !== "user" && ev.type !== "assistant") continue;
    const message = ev.message as Record<string, unknown> | undefined;
    if (!message) continue;

    if (ev.type === "assistant") {
      if (typeof message.model === "string") model = message.model;
      if (typeof ev.effort === "string") effort = ev.effort;
      if (message.usage && typeof message.usage === "object") {
        lastUsage = message.usage as Record<string, unknown>;
        const ot = (lastUsage as { output_tokens?: unknown }).output_tokens;
        if (typeof ot === "number") {
          tokByMsg.set(typeof message.id === "string" ? message.id : `l-${i}`, ot);
        }
      }
      if (!Number.isNaN(ts)) turnLastEventAt = ts;
      if (message.stop_reason === "tool_use") turnWorking = true;
      else if (typeof message.stop_reason === "string") turnWorking = false;
      if (!open) {
        open = { id: id++, role: "assistant", text: "", parts: [] };
        msgs.push(open);
      }
      const blocks = (Array.isArray(message.content) ? message.content : []) as Array<
        Record<string, unknown>
      >;
      for (const b of blocks) {
        if (b.type === "text" && typeof b.text === "string") {
          const parts = open.parts!;
          const last = parts[parts.length - 1];
          if (last?.type === "text") last.text += b.text;
          else parts.push({ type: "text", text: b.text });
        } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          // el "pensando por detras" VISIBLE (19 jul): bloque expandible con
          // la misma piel de un tool call (dot + resumen + detalle)
          open.parts!.push({
            type: "tool",
            toolId: `think-${i}-${open.parts!.length}`,
            name: "Pensando",
            summary: b.thinking.trim().split("\n")[0].slice(0, 80),
            input: b.thinking.trim(),
          });
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          const input = (
            b.input && typeof b.input === "object" ? b.input : {}
          ) as Record<string, unknown>;
          open.parts!.push({
            type: "tool",
            toolId: typeof b.id === "string" ? b.id : `m-${id}`,
            name: b.name,
            summary: toolSummary(b.name, input),
            input: JSON.stringify(input, null, 2),
          });
        }
      }
      continue;
    }

    // user: prompt real (string/text) cierra el assistant; tool_result no
    const content = message.content;
    if (!Number.isNaN(ts)) turnLastEventAt = ts;
    if (typeof content === "string") {
      // maquinaria de slash-commands: chip de sistema, NO burbuja ni turno
      const sys = sysLine(content);
      if (sys !== undefined) {
        open = null;
        if (sys) msgs.push({ id: id++, role: "user", sys: true, text: sys });
        continue;
      }
      open = null;
      const ua = splitAttachments(content);
      msgs.push({
        id: id++,
        role: "user",
        text: ua.text || "(adjuntos)",
        ...(ua.attachments ? { attachments: ua.attachments } : {}),
      });
      turnWorking = true;
      if (!Number.isNaN(ts)) turnStartedAt = ts;
      tokByMsg.clear();
    } else if (Array.isArray(content)) {
      let userText = "";
      for (const b of content as Array<Record<string, unknown>>) {
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          let out = "";
          if (typeof b.content === "string") out = b.content;
          else if (Array.isArray(b.content)) {
            out = (b.content as Array<Record<string, unknown>>)
              .map((x) => (x.type === "text" && typeof x.text === "string" ? x.text : ""))
              .join("\n");
          }
          attachResult(b.tool_use_id, out, b.is_error === true);
        } else if (b.type === "text" && typeof b.text === "string") {
          userText += (userText ? "\n" : "") + b.text;
        }
      }
      // IMAGENES de la linea (26 jul 2026). Las de tool_result cuelgan de su
      // bloque; las de arriba son las que Daniel pego en el TUI con ^V.
      const lineUuid = typeof ev.uuid === "string" ? ev.uuid : "";
      const allImgs = lineUuid ? collectImages(message, lineUuid) : [];
      attachToolImages(allImgs);
      const ownImgs: MsgImage[] = allImgs
        .filter((im) => !im.slot)
        .map((im) => ({ uuid: im.uuid, index: im.index, mediaType: im.mediaType }));
      // ⚠️ `|| ownImgs.length`: un mensaje que es SOLO imagen (pegar y enviar
      // sin escribir nada) no pintaba NADA — el mensaje entero desaparecia del
      // espejo porque no habia texto que empujar. Ahora la burbuja existe y
      // lleva su thumbnail.
      if (userText.trim() || ownImgs.length) {
        const sys = userText.trim() ? sysLine(userText) : undefined;
        if (sys !== undefined) {
          open = null;
          if (sys) msgs.push({ id: id++, role: "user", sys: true, text: sys });
        } else {
          open = null;
          const ua = splitAttachments(userText);
          msgs.push({
            id: id++,
            role: "user",
            text: ua.text || (ownImgs.length ? "" : "(adjuntos)"),
            ...(ua.attachments ? { attachments: ua.attachments } : {}),
            ...(ownImgs.length ? { images: ownImgs } : {}),
          });
          turnWorking = true;
          if (!Number.isNaN(ts)) turnStartedAt = ts;
          tokByMsg.clear();
        }
      }
    }
  }
  const ctxPct = lastUsage ? (ctxPctFrom(lastUsage, model) ?? undefined) : undefined;
  // ¿la ultima respuesta (turno cerrado) termina preguntandote algo?
  let endsAsk = false;
  const lastMsg = msgs[msgs.length - 1];
  if (!turnWorking && lastMsg?.role === "assistant") {
    const parts = lastMsg.parts ?? [];
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.type === "text" && p.text.trim()) {
        endsAsk = p.text.trim().endsWith("?");
        break;
      }
    }
  }
  let outputTokens = 0;
  for (const v of tokByMsg.values()) outputTokens += v;
  // tope de render (ver MAX_MSGS): el recorte es del INICIO, lo ultimo siempre
  // se ve, y `truncated` hace que el lector lo diga en vez de mentir
  const shown = msgs.length > MAX_MSGS ? msgs.slice(-MAX_MSGS) : msgs;
  if (shown.length < msgs.length) truncated = true;
  return {
    msgs: shown, title, model, effort, sessionId, cwd, ctxPct, truncated,
    turn: {
      state: turnWorking ? "working" : "done",
      startedAt: turnStartedAt,
      lastEventAt: turnLastEventAt,
      outputTokens,
      endsAsk,
    },
  };
}

function jsonLines(raw: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out.push(value as Record<string, unknown>);
      }
    } catch {
      // Una cola puede empezar a mitad de una linea; el backend ya informa el
      // recorte de forma separada.
    }
  }
  return out;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

function textParts(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) =>
      stringField(part, "text") ?? stringField(part, "content") ?? "",
    )
    .filter(Boolean)
    .join("\n");
}

/** Rollout JSONL de Codex: usa los eventos de UI para evitar duplicar los
 * `response_item` internos que tambien se guardan para restaurar contexto. */
export function parseCodexTranscript(raw: string, truncated = false): ParsedTranscript {
  const msgs: ChatMsg[] = [];
  const tools = new Map<string, Extract<Part, { type: "tool" }>>();
  let id = 2_000_000;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let working = false;
  let lastEventAt: number | undefined;
  for (const ev of jsonLines(raw)) {
    const payload = ev.payload as Record<string, unknown> | undefined;
    const time = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : NaN;
    if (!Number.isNaN(time)) lastEventAt = time;
    if (ev.type === "session_meta" && payload) {
      sessionId = stringField(payload, "session_id") ?? stringField(payload, "id") ?? sessionId;
      cwd = stringField(payload, "cwd") ?? cwd;
    } else if (ev.type === "turn_context" && payload) {
      cwd = stringField(payload, "cwd") ?? cwd;
      model = stringField(payload, "model") ?? model;
      effort = stringField(payload, "effort") ?? effort;
    } else if (ev.type === "event_msg" && payload) {
      const kind = payload.type;
      if (kind === "task_started") working = true;
      if (kind === "task_complete" || kind === "task_completed" || kind === "turn_complete") working = false;
      if (kind === "user_message") {
        const text = stringField(payload, "message")?.trim();
        if (text) msgs.push({ id: id++, role: "user", text });
        working = true;
      } else if (kind === "agent_message") {
        const text = stringField(payload, "message")?.trim();
        if (text) msgs.push({ id: id++, role: "assistant", text, parts: [{ type: "text", text }] });
      }
    } else if (ev.type === "response_item" && payload) {
      const kind = payload.type;
      if ((kind === "function_call" || kind === "custom_tool_call") && typeof payload.name === "string") {
        const toolId = stringField(payload, "call_id") ?? stringField(payload, "id") ?? `codex-${id}`;
        const rawInput = stringField(payload, "arguments") ?? stringField(payload, "input") ?? "";
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(rawInput) as Record<string, unknown>; } catch { input = { input: rawInput }; }
        const part: Extract<Part, { type: "tool" }> = {
          type: "tool", toolId, name: payload.name, summary: toolSummary(payload.name, input),
          input: rawInput || undefined,
        };
        tools.set(toolId, part);
        let target = msgs[msgs.length - 1];
        if (!target || target.role !== "assistant") {
          target = { id: id++, role: "assistant", text: "", parts: [] };
          msgs.push(target);
        }
        (target.parts ??= []).push(part);
      } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
        const toolId = stringField(payload, "call_id");
        const tool = toolId ? tools.get(toolId) : undefined;
        if (tool) tool.output = textParts(payload.output).slice(0, 4000);
      }
    }
  }
  const shown = msgs.length > MAX_MSGS ? msgs.slice(-MAX_MSGS) : msgs;
  return {
    msgs: shown, model, effort, sessionId, cwd,
    truncated: truncated || shown.length < msgs.length,
    turn: { state: working ? "working" : "done", lastEventAt, outputTokens: 0, endsAsk: false },
  };
}

/** Wire journal de Kimi Code. El formato oficial persiste los mensajes como
 * `context.append_message`; el resto de records son estado y telemetria. */
export function parseKimiTranscript(raw: string, truncated = false): ParsedTranscript {
  const msgs: ChatMsg[] = [];
  let id = 3_000_000;
  let model: string | undefined;
  let lastEventAt: number | undefined;
  for (const ev of jsonLines(raw)) {
    if (typeof ev.time === "number") lastEventAt = ev.time;
    if (ev.type === "llm.request") {
      model = stringField(ev, "modelAlias") ?? stringField(ev, "model") ?? model;
      continue;
    }
    if (ev.type === "usage.record") {
      model = stringField(ev, "model") ?? model;
      continue;
    }
    if (ev.type !== "context.append_message") continue;
    const message = ev.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const role = message.role;
    const text = textParts(message.content).trim();
    if (!text || (role !== "user" && role !== "assistant")) continue;
    msgs.push(role === "assistant"
      ? { id: id++, role, text, parts: [{ type: "text", text }] }
      : { id: id++, role, text });
  }
  const shown = msgs.length > MAX_MSGS ? msgs.slice(-MAX_MSGS) : msgs;
  return {
    msgs: shown, model, truncated: truncated || shown.length < msgs.length,
    turn: { state: "done", lastEventAt, outputTokens: 0, endsAsk: false },
  };
}

export function parseProviderTranscript(
  provider: "claude" | "codex" | "kimi",
  raw: string,
  truncated = false,
): ParsedTranscript {
  const parsed = provider === "codex"
    ? parseCodexTranscript(raw, truncated)
    : provider === "kimi"
      ? parseKimiTranscript(raw, truncated)
      : parseTranscript(raw);
  if (truncated) parsed.truncated = true;
  return parsed;
}
