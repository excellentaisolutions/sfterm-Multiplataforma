/** Tests del ADELANTO (src/core/screen.ts) contra CAPTURAS REALES.
 *
 *  Las fixtures de tests/fixtures/pantalla-claude/ no son inventadas: salieron
 *  de una sonda del 28 jul 2026 por la puerta de agentes — un `claude --model
 *  haiku` invisible al que se le pidio prosa larga y despues prosa + Bash, con
 *  la pantalla muestreada ~1Hz mientras respondia (claude 2.1.220).
 *
 *  Corre con `node --test tests/` (sin dependencias: Node 22 strippea TS solo).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CLAUDE_SCREEN,
  normalizeForMatch,
  parseLiveProse,
  profileForScreen,
  screenGhost,
} from "../src/core/screen.ts";

const AQUI = dirname(fileURLToPath(import.meta.url));
const cap = (n: string) => readFileSync(join(AQUI, "fixtures", "pantalla-claude", `${n}.txt`), "utf8");
const P = CLAUDE_SCREEN;

/* ── el caso feliz: prosa larga sin herramientas ──────────────────────────── */

test("prosa en vuelo: devuelve el bloque que se esta escribiendo", () => {
  const prosa = parseLiveProse(cap("prosa-en-vuelo"), P);
  assert.ok(prosa, "deberia haber prosa");
  assert.match(prosa, /^El Mar Mediterráneo\n\nEl mar Mediterráneo es uno de los cuerpos/);
  // el wrap del TUI se deshace: una linea logica por parrafo
  assert.match(prosa, /conectando tres continentes: Europa, África y Asia/);
  // y lo ultimo es justo donde iba escribiendo, sin colgar la caja de input
  assert.match(prosa, /un destino turístico de primer$/);
  assert.ok(!prosa.includes("❯"), "no se cuela la caja de input");
  assert.ok(!prosa.includes("─────"), "no se cuela la regla del TUI");
});

test("la pantalla CRLF de Windows se interpreta igual que LF", () => {
  const lf = cap("prosa-en-vuelo").replace(/\r\n?/g, "\n");
  assert.equal(parseLiveProse(lf.replace(/\n/g, "\r\n"), P), parseLiveProse(lf, P));
});

test("prosa con lista: viñetas y parrafos sobreviven al desenvuelto", () => {
  const prosa = parseLiveProse(cap("prosa-con-lista"), P);
  assert.ok(prosa);
  // las viñetas arrancan renglon propio y su continuacion SE PEGA (el TUI no
  // les mete sangria extra: verificado en la captura)
  assert.match(prosa, /\n- La presencia de delfines, que nadan en sus aguas y son símbolo de la vida marina mediterránea\n/);
  assert.match(prosa, /\n- Las praderas de posidonia, una planta acuática endémica/);
  // parrafos separados por linea en blanco
  assert.match(prosa, /encuentran:\n\n- La presencia/);
  // el mensaje del usuario que esta MAS ARRIBA no entra
  assert.ok(!prosa.includes("Sin usar NINGUNA herramienta"));
});

test("prosa terminada: el spinner ✻ de cierre es ruido, la prosa sigue ahi", () => {
  const prosa = parseLiveProse(cap("prosa-terminada"), P);
  assert.ok(prosa);
  assert.ok(!prosa.includes("Sautéed for"), "el spinner no se pinta");
  assert.match(prosa, /el pasado glorioso con un presente dinámico y lleno de posibilidades\.$/);
});

/* ── lo que NO se pinta ───────────────────────────────────────────────────── */

test("todavia no respondio: solo tu mensaje y el spinner ⇒ nada en vuelo", () => {
  // spinner CON continuacion propia ("⎿ Tip: …"), que es la trampa del caso
  assert.equal(parseLiveProse(cap("spinner-sin-respuesta"), P), "");
  assert.equal(screenGhost(cap("spinner-sin-respuesta"), "", P), null);
});

test("herramienta corriendo: el ultimo bloque es un tool ⇒ nada en vuelo", () => {
  assert.equal(parseLiveProse(cap("tool-corriendo"), P), "");
  assert.equal(parseLiveProse(cap("tool-listo"), P), "");
});

test("BULLET QUE LATE: la herramienta corriendo apaga su ⏺ y no debe resucitar la prosa", () => {
  // Dos colas capturadas con 0.25s de diferencia en la MISMA app, con la misma
  // conversacion y el mismo Bash corriendo. La unica diferencia es el glifo:
  //     "  Bash(sleep 12 && echo ok)"   ← apagado (parece continuacion)
  //     "⏺ Bash(sleep 12 && echo ok)"   ← encendido
  // La v1 devolvia la prosa de ARRIBA en la primera y "" en la segunda: el
  // fantasma se prendia y apagaba varias veces por segundo, repintando un
  // parrafo que ya vivia en el transcript. Las dos tienen que decir lo mismo.
  const apagado = cap("tool-bullet-apagado");
  const encendido = cap("tool-bullet-encendido");
  assert.match(apagado, /\n {2}Bash\(sleep 12 && echo ok\)/, "la fixture debe traer el bullet apagado");
  assert.match(encendido, /\n⏺ Bash\(sleep 12 && echo ok\)/, "la fixture debe traer el bullet encendido");
  assert.equal(parseLiveProse(apagado, P), "");
  assert.equal(parseLiveProse(encendido, P), "");
});

test("prosa final en vuelo tras el tool: eso SI se adelanta", () => {
  const prosa = parseLiveProse(cap("prosa-final-en-vuelo"), P);
  assert.ok(prosa);
  assert.match(prosa, /^El resultado de este comando/);
  assert.ok(!prosa.includes("⎿"));
  assert.ok(!prosa.includes("Bash(sleep"));
});

test("pantalla que no entendemos ⇒ null (no pinta nada, no rompe)", () => {
  // dialogo "Is this a project you trust?": no hay caja de input
  assert.equal(parseLiveProse(cap("dialogo-confianza"), P), null);
  // pantalla de bienvenida: caja de input pero arriba no hay conversacion
  assert.equal(parseLiveProse(cap("bienvenida"), P), null);
  assert.equal(screenGhost(cap("bienvenida"), "", P), null);
  // basura pura
  assert.equal(parseLiveProse("", P), null);
  assert.equal(parseLiveProse("hola\nmundo", P), null);
});

test("bloque gigante cuyo abridor ⏺ se salio de la ventana ⇒ null", () => {
  const lines = cap("prosa-con-lista").split("\n");
  const i = lines.findIndex((l) => l.startsWith("⏺"));
  assert.ok(i > 0, "la fixture debe traer un ⏺");
  assert.equal(parseLiveProse(lines.slice(i + 1).join("\n"), P), null);
});

/* ── varios bloques seguidos en un mismo turno ────────────────────────────── */

test("prosa DESPUES de una herramienta: se adelanta el segundo bloque, no el primero", () => {
  const prosa = parseLiveProse(cap("prosa-tras-tool"), P);
  assert.ok(prosa);
  assert.match(prosa, /^El comando se ejecutó exitosamente/);
  assert.ok(!prosa.includes("Voy a ejecutar un comando bash"), "el bloque anterior ya vive en el transcript");
  assert.ok(!prosa.includes("Bash(sleep 6"), "el tool no se cuela");
  assert.ok(!prosa.includes("⎿"), "el resultado del tool no se cuela");
});

/* ── EL RELEVO fantasma → mensaje real ────────────────────────────────────── */

test("RELEVO contra el transcript REAL de la sonda: el fantasma se retira", () => {
  // Las dos mitades del relevo, las dos capturadas en vivo el mismo dia:
  //   · la PANTALLA con el bloque ya escrito (fixture prosa-terminada)
  //   · el TEXTO que Claude Code escribio en su jsonl para ESE bloque
  // El transcript arranca "# El Mar Mediterráneo" y la pantalla lo mostro sin
  // la almohadilla (el TUI renderiza el markdown): sin normalizar, el fantasma
  // se quedaria pegado DEBAJO de su propio mensaje real, que es el modo de
  // fallar mas feo de todos.
  const tail = cap("prosa-terminada");
  const real = readFileSync(join(AQUI, "fixtures", "pantalla-claude", "transcript-bloque-1.md"), "utf8");
  assert.match(real, /^# El Mar Mediterráneo/);
  const prosa = parseLiveProse(tail, P)!;
  assert.ok(prosa);
  assert.equal(screenGhost(tail, "", P), prosa); // sin transcript: se adelanta
  assert.equal(screenGhost(tail, real, P), null); // ya aterrizo: se retira
});

test("RELEVO del segundo bloque: el turno anterior NO lo apaga por accidente", () => {
  const tail = cap("prosa-tras-tool"); // segundo bloque a medio escribir
  const b1 = readFileSync(join(AQUI, "fixtures", "pantalla-claude", "transcript-bloque-1.md"), "utf8");
  const b3 = readFileSync(join(AQUI, "fixtures", "pantalla-claude", "transcript-bloque-3.md"), "utf8");
  // el transcript trae el bloque de ANTES: el fantasma tiene que verse igual
  const ghost = screenGhost(tail, b1, P);
  assert.ok(ghost);
  assert.match(ghost, /^El comando se ejecutó exitosamente/);
  // y en cuanto aterriza SU linea, se retira (el fantasma era un PREFIJO del
  // bloque final: por eso la comparacion va por contencion y no por igualdad)
  assert.ok(b3.startsWith("El comando se ejecutó exitosamente"));
  assert.equal(screenGhost(tail, b3, P), null);
});

test("relevo: el markdown del transcript matchea aunque el TUI lo haya renderizado", () => {
  const pantalla = "Listo. Puse la clave en negritas y agregue la lista.";
  const transcript = "Listo. Puse la **clave** en negritas y agregué la lista.";
  // el acento de "agregué" NO se pierde en la normalizacion, asi que esto NO
  // matchea: la pantalla es lo que se ve, y lo que se ve es lo que se compara
  assert.notEqual(normalizeForMatch(pantalla), normalizeForMatch(transcript));
  // pero el markdown SI se disuelve
  assert.equal(
    normalizeForMatch("## Titulo\n\n- **uno**\n- `dos`"),
    normalizeForMatch("Titulo\n\nuno\ndos"),
  );
});

test("relevo: un fantasma a medio escribir NO esta en el transcript ⇒ se pinta", () => {
  const tail = cap("prosa-en-vuelo");
  // el transcript del turno anterior no tiene nada de este bloque
  const ghost = screenGhost(tail, "Perfecto, ahí va.", P);
  assert.ok(ghost);
  assert.match(ghost, /^El Mar Mediterráneo/);
});

/* ── el perfil es una COSTURA, no un cableado ─────────────────────────────── */

test("perfiles: claude se reconoce por proceso o por titulo; lo demas no", () => {
  assert.equal(profileForScreen("claude")?.id, "claude");
  assert.equal(profileForScreen("node", "Claude Code — refactor")?.id, "claude");
  assert.equal(profileForScreen("zsh"), null);
  assert.equal(profileForScreen("Python", "Kimi Code"), null); // Nivel 2: sin perfil aun
  assert.equal(profileForScreen(""), null);
  assert.equal(profileForScreen(undefined), null);
});

test("tool call vs prosa que empieza con mayuscula y parentesis", () => {
  assert.ok(P.toolCall.test("Bash(sleep 6 && echo hola)"));
  assert.ok(P.toolCall.test("Read(/tmp/x.ts)"));
  assert.ok(P.toolCall.test("Web Search(\"mar mediterraneo\")"));
  // prosa: el espacio antes del parentesis la salva de leerse como herramienta
  assert.ok(!P.toolCall.test("Perfecto (ya está) — sigo."));
  assert.ok(!P.toolCall.test("El comando se ejecutó (bien)."));
});
