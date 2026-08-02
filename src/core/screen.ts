/** EL ADELANTO — streaming del bloque EN VUELO, leido de la PANTALLA.
 *
 *  El problema (medido el 28 jul 2026 sobre una sesion real): Claude Code
 *  escribe su jsonl **por BLOQUE DE CONTENIDO CERRADO**, no por token. En la
 *  sonda controlada, el prompt salio a las 22:32:49.410 y el bloque de texto
 *  aterrizo a las 22:33:00.885 — ONCE SEGUNDOS de lector mudo mientras la
 *  terminal ya pintaba la respuesta creciendo. Bajarle el intervalo al poll del
 *  transcript no arregla nada: la granularidad es de la FUENTE.
 *
 *  Donde SI esta el stream es en la PANTALLA — el motor VT en Rust corre
 *  siempre en tee, y `engine_text` devuelve el grid ya sin ANSI. Medido: el
 *  prefijo NUNCA se reescribe (crece a ~260 chars/s), asi que se puede pintar
 *  sin parpadeo.
 *
 *  ⚠️ POR QUE PANTALLA Y NO UN CANAL DE CLAUDE (restriccion que firma Daniel):
 *  la pantalla es la fuente AGNOSTICA DE PROVEEDOR. Construido asi, el dia que
 *  Daniel abra Kimi Code / Codex / Gemini CLI el adelanto se hereda agregando
 *  un objeto a `SCREEN_PROFILES` — cero cambios en el lector. Construido sobre
 *  un canal especifico de Claude, se paga otra vez por cada CLI nuevo.
 *
 *  Los marcadores ⏺/⎿/❯ son UN PERFIL, no la verdad universal: viven en
 *  `CLAUDE_SCREEN` y el parser generico no sabe nada de ellos.
 *
 *  INVARIANTES (mismos que `parseTuiDraft` y `trash_guard`):
 *   · funcion PURA y testeada contra capturas REALES (tests/screen.test.ts,
 *     fixtures en tests/fixtures/pantalla-claude/ — sonda del 28 jul).
 *   · **si el parser no entiende lo que ve, NO PINTA NADA** (`null`). Jamas
 *     inventar, jamas dejar texto a medias colgado como si fuera final: el modo
 *     de fallar caro es que Daniel lea como definitiva una frase a medio
 *     escribir, o peor, texto de otro bloque.
 *   · el TRANSCRIPT sigue siendo la verdad. Esto es solo el adelanto del bloque
 *     en vuelo, y se retira solo en cuanto la linea del jsonl aterriza.
 */

export interface ScreenProfile {
  /** nombre del perfil (para debug y para el censo del CLAUDE.md) */
  id: string;
  /** substrings que lo activan, contra "<nombre del proceso> <titulo OSC>"
   *  en minusculas — mismo criterio que core/agents.ts (fgName no basta:
   *  Kimi Code se reporta como "Python" y solo su titulo lo identifica). */
  procs: string[];
  /** linea de col 0 que ABRE un bloque del agente. Captura 1 = su contenido. */
  bullet: RegExp;
  /** contenido de un bullet que NO es prosa sino una llamada a herramienta
   *  ("Bash(...)", "Read(...)", "Web Search(...)"). */
  toolCall: RegExp;
  /** el MISMO encabezado de herramienta con el bullet APAGADO — el TUI hace
   *  latir el glifo de la herramienta que esta corriendo, asi que la linea
   *  alterna entre "⏺ Bash(…)" y "  Bash(…)" varias veces por segundo. Sin
   *  este reconocimiento, el renglon sin glifo se lee como CONTINUACION y el
   *  recorrido se pasa de largo hasta el bloque de arriba: el adelanto
   *  resucita prosa que ya aterrizo, parpadeando al ritmo del latido.
   *
   *  Se busca DENTRO del bloque que se iba a pintar, no como abridor: con el
   *  glifo apagado la linea lleva sangria, o sea que es indistinguible de una
   *  continuacion hasta que se mira su contenido. */
  toolBlink: RegExp;
  /** salida de una herramienta ("  ⎿  Running…"). Marca frontera de bloque. */
  toolResult: RegExp;
  /** linea de col 0 con el mensaje del usuario — y tambien la caja de input. */
  user: RegExp;
  /** continuacion de un bloque: sangria colgante. Captura 1 = el texto. */
  cont: RegExp;
  /** linea de col 0 del spinner ("· Honking… (3m 59s · ↓ 22.3k tokens)"):
   *  RUIDO, se descarta junto con sus continuaciones. */
  spinner: RegExp;
  /** la regla ───── con la que el TUI abre y cierra su caja de input. */
  rule: RegExp;
  /** linea que ARRANCA estructura propia (viñeta, numeral, titulo, cita): no
   *  se pega a la anterior aunque venga con la misma sangria. */
  breakLine: RegExp;
}

/** Perfil de CLAUDE CODE. Anclado a la pantalla REAL, capturada por la puerta
 *  el 28 jul 2026 (claude 2.1.220):
 *
 *      ❯ Escribe un parrafo corto explicando que vas a hacer, luego corre …
 *        bash `sleep 6 && echo hola` con la herramienta Bash, y despues …
 *
 *      ⏺ Voy a ejecutar un comando bash que esperará 6 segundos y luego …
 *        mensaje "hola". Este ejercicio ilustra cómo se pueden encadenar …
 *
 *      ⏺ Bash(sleep 6 && echo hola)
 *        ⎿  Running…
 *
 *      ✻ Wrangling… (6s · ↓ 279 tokens · thought for 1s)
 *        ⎿  Tip: Ask Claude to create subagents for specific tasks. Eg. …
 *
 *      ────────────────────────────────────────────────────────────────
 *      ❯
 *      ────────────────────────────────────────────────────────────────
 *        Haiku 4.5 │ ◔ 16%
 *
 *  Glifos censados sobre 33 capturas reales: ⏺ U+23FA (bullet del agente),
 *  ❯ U+276F (prompt), ─ U+2500 (regla), y el spinner rotando entre
 *  · ✢ ✳ ✶ ✻ ✽ (U+00B7 U+2722 U+2733 U+2736 U+273B U+273D).
 */
export const CLAUDE_SCREEN: ScreenProfile = {
  id: "claude",
  procs: ["claude"],
  bullet: /^⏺ ?(.*)$/,
  // Un tool call es "Nombre(" o "Web Search(" — TitleCase pegado al parentesis.
  // El pegado NO es decorativo: sin el, una prosa que arranque "Perfecto (ya
  // está)…" se leeria como herramienta y el adelanto se apagaria solo.
  toolCall: /^[A-Z][A-Za-z0-9_]*(?: [A-Z][A-Za-z0-9_]*)*\(/,
  toolBlink: /^ {2}[A-Z][A-Za-z0-9_]*(?: [A-Z][A-Za-z0-9_]*)*\(/,
  toolResult: /^ {2,}⎿/,
  user: /^❯ ?(.*)$/,
  cont: /^ {1,2}(.*)$/,
  spinner: /^[·✢✳✶✻✽∗*✱]\s/,
  rule: /^[─—_-]{4,}\s*$/,
  breakLine: /^\s*(?:[-*•+]\s|\d+[.)]\s|#{1,6}\s|>\s)/,
};

/** El censo. Agregar un CLI = agregar un objeto AQUI; el lector no se toca.
 *  (Nivel 2 — adapters de transcript por CLI — es otro encargo: esto es solo
 *  la costura de PANTALLA.) */
export const SCREEN_PROFILES: ScreenProfile[] = [CLAUDE_SCREEN];

/** Perfil de la terminal, o null si ninguno la reconoce (⇒ sin adelanto, que
 *  es exactamente el comportamiento de hoy: el fallback generico de un CLI sin
 *  perfil sigue siendo el espejo crudo de pantalla, `src:"screen"`). */
export function profileForScreen(fgName: string | undefined | null, title?: string | null): ScreenProfile | null {
  const hay = `${fgName ?? ""} ${title ?? ""}`.toLowerCase();
  if (!hay.trim()) return null;
  return SCREEN_PROFILES.find((p) => p.procs.some((n) => hay.includes(n))) ?? null;
}

/** Indice EXCLUSIVO donde termina la conversacion: la linea de la regla que
 *  ABRE la caja de input. null = no se encontro la caja ⇒ no entendemos la
 *  pantalla (dialogo de permisos, pantalla de bienvenida, TUI en otro estado).
 *
 *  Determinista y anclado, igual que `parseTuiDraft`: la ULTIMA regla del tail
 *  es la que cierra la caja; arriba de ella va el prompt (con sus
 *  continuaciones si el borrador ocupa varios renglones) y arriba del prompt la
 *  regla que la abre. Cualquier otra cosa en el camino ⇒ null. */
function inputBoxTop(lines: string[], p: ScreenProfile): number | null {
  let lastRule = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (p.rule.test(lines[i])) {
      lastRule = i;
      break;
    }
  }
  if (lastRule < 1) return null;
  let i = lastRule - 1;
  let seenPrompt = false;
  // la caja no puede ser mas alta que esto sin que dejemos de entenderla
  for (let k = 0; k < 20 && i >= 0; k++, i--) {
    if (p.user.test(lines[i])) {
      seenPrompt = true;
      break;
    }
    if (!lines[i].trim()) continue; // renglon en blanco dentro de la caja
    if (/^ {1,4}\S/.test(lines[i])) continue; // continuacion del borrador
    return null; // contenido de la conversacion: la caja no estaba ahi
  }
  if (!seenPrompt || i < 1) return null;
  if (!p.rule.test(lines[i - 1])) return null;
  return i - 1;
}

/** Reconstruye el markdown de un bloque de prosa a partir de sus renglones de
 *  pantalla. El TUI envuelve a lo ancho de la terminal con sangria colgante de
 *  2 espacios, asi que por DEFECTO un renglon se pega al anterior con un
 *  espacio (era wrap, no salto). Rompen la linea, y solo ellos:
 *    · el renglon en blanco  → parrafo nuevo
 *    · viñeta / numeral / titulo / cita → renglon propio (`breakLine`)
 *    · sangria de 4+ tras quitar la colgante → bloque de codigo, se preserva
 *
 *  Verificado contra la captura real: las continuaciones de una viñeta NO
 *  llevan sangria extra (`  - La presencia de delfines, que nadan…` seguido de
 *  `  marina mediterránea`), asi que pegarlas con espacio es lo correcto. */
function joinProse(first: string, rest: string[], p: ScreenProfile): string {
  const out: string[] = [];
  let cur = first.trimEnd();
  let blank = false;
  for (const raw of rest) {
    const t = raw.replace(/^ {1,2}/, ""); // fuera la sangria colgante
    if (!t.trim()) {
      blank = true;
      continue;
    }
    const rompe = p.breakLine.test(t) || /^ {4,}/.test(t);
    if (blank) {
      out.push(cur, "");
      cur = t.trimEnd();
      blank = false;
    } else if (rompe) {
      out.push(cur);
      cur = t.trimEnd();
    } else {
      cur = cur ? `${cur} ${t.trim()}` : t.trimEnd();
    }
  }
  out.push(cur);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** PROSA DEL BLOQUE EN VUELO — lo ultimo que el agente esta escribiendo.
 *
 *    `string` no vacio — esa prosa (el adelanto)
 *    `""`              — pantalla entendida, pero abajo no hay prosa (el ultimo
 *                        bloque es una herramienta, o tu propio mensaje, o la
 *                        conversacion esta vacia)
 *    `null`            — NO entendida: no pintar nada
 *
 *  Recorre BLOQUES de abajo hacia arriba (un bloque = linea de col 0 + sus
 *  continuaciones y renglones en blanco) descartando el ruido del spinner, que
 *  tambien trae continuaciones propias:
 *
 *      ✻ Wrangling… (15s · ↓ 552 tokens · thought for 1s)
 *        ⎿  Tip: Ask Claude to create subagents for specific tasks. Eg. …
 *           Architect, Code Writer, Code Reviewer
 *
 *  Si el abridor del ultimo bloque se salio de la ventana de pantalla (bloque
 *  gigantesco) devuelve null en vez de un fragmento que arrancaria a media
 *  palabra — por eso el lector pide una cola holgada. */
export function parseLiveProse(tail: string, p: ScreenProfile): string | null {
  const lines = tail.split("\n");
  const top = inputBoxTop(lines, p);
  if (top == null) return null;
  let end = top; // exclusivo
  for (let guard = 0; guard < 60; guard++) {
    while (end > 0 && !lines[end - 1].trim()) end--;
    if (end === 0) return ""; // conversacion vacia: nada en vuelo
    let start = end - 1;
    while (start >= 0 && (!lines[start].trim() || p.cont.test(lines[start]))) start--;
    if (start < 0) return null; // el abridor no entra en la ventana
    const head = lines[start];
    if (p.spinner.test(head)) {
      end = start; // ruido del spinner: seguir mirando hacia arriba
      continue;
    }
    const b = p.bullet.exec(head);
    if (b) {
      if (p.toolCall.test(b[1].trim())) return ""; // el ultimo bloque es un tool
      const body = lines.slice(start + 1, end);
      // ⚠️ EL BLOQUE NO PUEDE TRAGARSE OTRO BLOQUE. Con el bullet de la
      // herramienta APAGADO (late), su encabezado y su "⎿ Running…" parecen
      // continuaciones de la prosa de arriba — y esa prosa YA aterrizo en el
      // transcript. Sin este corte, el adelanto la repintaba debajo de su
      // propio mensaje real, prendiendose y apagandose al ritmo del latido
      // (medido en vivo el 28 jul: colas 004/005/008/009 contra 003/006/007).
      if (body.some((l) => p.toolResult.test(l) || p.toolBlink.test(l))) return "";
      return joinProse(b[1], body, p);
    }
    if (p.user.test(head)) return ""; // lo ultimo es tu propio mensaje
    return null; // algo que no sabemos leer
  }
  return null;
}

/** Normaliza para COMPARAR pantalla contra transcript: minusculas y solo
 *  letras/numeros.
 *
 *  ⚠️ Es lo que hace posible el relevo sin duplicar. El TUI RENDERIZA el
 *  markdown (el transcript trae "# El Mar Mediterráneo" y la pantalla muestra
 *  "El Mar Mediterráneo" en negritas), asi que comparar crudo jamas casaria y
 *  el fantasma se quedaria pegado debajo de su propio mensaje real. Tirando
 *  puntuacion y espacios, `**negritas**`, `- viñeta` y `## Titulo` colapsan a
 *  lo mismo de los dos lados. */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Menos que esto no vale la pena pintarlo (una viñeta suelta, un guion). */
const MIN_GHOST = 3;

/** EL ADELANTO, listo para pintar — o null.
 *
 *  `already` es el markdown que el TRANSCRIPT ya tiene del mensaje en curso.
 *  Si la prosa de pantalla YA esta ahi (normalizada), la linea del jsonl
 *  aterrizo: el fantasma se retira y manda el markdown real. Ese es el relevo.
 *
 *  El `includes` va a proposito en la direccion segura: ante la duda ESCONDE.
 *  Un falso negativo cuesta 1.5s de adelanto que no se vio; un falso positivo
 *  costaria pintar dos veces el mismo parrafo, uno de ellos a medio escribir —
 *  exactamente lo que el invariante prohibe. */
export function screenGhost(tail: string, already: string, p: ScreenProfile): string | null {
  const prose = parseLiveProse(tail, p);
  if (!prose) return null; // null (no entendido) y "" (nada en vuelo) → igual
  const n = normalizeForMatch(prose);
  if (n.length < MIN_GHOST) return null;
  if (normalizeForMatch(already).includes(n)) return null; // ya aterrizo
  return prose;
}
