# SFTerm

> **Nota:** este repositorio es un snapshot público del código de SFTerm, compartido con la comunidad de SaaS Factory. El desarrollo activo ocurre en un repo privado; este espejo se actualiza por tandas.


> La conversación con tu agente es el HOME; las terminales son el backstage.
> El workspace del operador agéntico, sin grasa.

App de escritorio macOS (Tauri 2 + Rust + React) **100% soberana**: sin cuenta, sin cloud,
sin telemetría, un solo binario. Parte de la familia SaaS Factory (SFlow · SFCast · SFPoint · SFTerm).

## Qué es

**Chat-first:** abres la app y estás en una conversación con tu agente (⌘N = agente
fresco, cero fricción). Las terminales siguen ahí con toda su potencia — como
backstage al que te asomas (Esc / ❯_ Taller), con badges cuando algo pide tu
atención. `general.home = "terminals"` en el config restaura el arranque clásico.

Tres superficies en una app de ~17MB que usa ~90MB de RAM:

1. **Chat nativo con el agente (el HOME, ⌘L)** — la conversación estilo chat premium:
   markdown rico (tablas, código con copiar), tool calls expandibles con input y
   output (+ chip "ver diff" cuando el agente edita un archivo), múltiples
   conversaciones con memoria (resume), rail estilo mensajería con las terminales
   vivas y su atención, adjuntos por drag & drop / pegar imagen, dictado por voz
   100% local (whisper) y cada respuesta se puede ESCUCHAR con la voz del sistema
   siguiendo la palabra exacta.
2. **Multiplexor de terminales REALES (el taller)** — rail de conversaciones, splits por
   drag & drop, árbol de archivos git-aware, visor universal solo-lectura, presets
   agénticos (abres la app y tus agentes ya están corriendo, con kickoff automático de
   prompt).
3. **Motor de terminal PROPIO en Rust** (`renderer = "own"`) — parser VT (crate vte) + grid
   + scrollback viven en Rust; el frontend solo pinta un canvas. Cada comando es un **bloque**
   (OSC 133) con exit code, duración, re-run ↻ y botón ☰ que abre su output como documento
   (Modo Lectura: markdown rico + lectura por voz con resaltado de palabra).

## Instalación en una Mac nueva

```bash
git clone <este repo> && cd sfterm
./scripts/setup.sh
```

El script instala toolchain (node/rust si faltan), deps, el STT local del dictado
(ffmpeg + whisper-cpp + modelo ~550MB), compila release e instala en `/Applications`.

Requisitos previos: [Homebrew](https://brew.sh). Para el chat (⌘L): `claude` CLI
(`npm i -g @anthropic-ai/claude-code`). El dictado pide permiso de micrófono la
primera vez (un click).

Manual, si prefieres por partes:

```bash
npm install
npm run tauri dev        # desarrollo con hot-reload
npm run validate         # oxlint + tsc + vite build + cargo test
npm run tauri build      # SFTerm.app + dmg en src-tauri/target/release/bundle/
./scripts/setup-stt.sh   # solo las piezas del dictado por voz
```

## Atajos

| Atajo | Acción |
|-------|--------|
| ⌘L | **Chat con el agente** (el home) ↔ taller de terminales |
| ⌘N | **Nueva conversación con un agente fresco** (en el chat) |
| ⌘J / ⌘⌥J | Nueva terminal / nueva terminal con agente (taller) |
| ⌘I | Composer (campo de texto real hacia la terminal enfocada) |
| ⌥Tab / ⌥⇧Tab | Ciclar conversaciones vivas |
| ⌘W | Cerrar panel (la conversación sigue viva en la lista) |
| ⌘⌥flechas | Mover foco entre splits |
| ⌘D / ⇧⌘D | Dockear al rail / restaurar |
| ⌘B / ⌘⌥B | Toggle árbol / toggle rail |
| ⌘F / ⌘P / ⌘K | Buscar en scrollback / buscar archivo / paleta |
| ⌘, | Configuración |

Dentro del chat: Enter envía · ⇧Enter salto · Esc cancela dictado o cierra ·
Espacio pausa la lectura por voz · ←/→ párrafo anterior/siguiente · tap en un
párrafo = leer desde ahí.

## El chat nativo, en detalle

- **Backend sin daemon:** cada turno corre `claude -p --output-format stream-json
  --include-partial-messages` (un proceso por turno, prompt por stdin); la sesión
  continúa con `--resume <session_id>`. El comando base sale de
  `general.agent_command` del config, así que sirve cualquier CLI compatible.
- **Multi-conversación:** sidebar con lista; cada conversación tiene su sesión de
  claude y pueden streamear en paralelo. Historial persistente (localStorage).
- **Tool calls de verdad:** cada herramienta que usa el agente aparece en su lugar
  del mensaje como bloque expandible: resumen de una línea (el comando, el path,
  la url) → input JSON completo + output real, con estado corriendo/ok/error.
- **Adjuntos:** arrastra archivos de Finder o pega una imagen del clipboard; los
  paths viajan en el prompt y el agente los lee con sus herramientas.
- **Dictado 🎤:** ffmpeg graba el mic, whisper-cli (whisper.cpp) transcribe LOCAL
  con `large-v3-turbo` cuantizado. Nada sale de tu máquina.
- **Escuchar ▶:** TTS del sistema con resaltado de la palabra exacta que suena
  (motor propio anti-WKWebView: reloj de respaldo, cajas overlay, saneado de
  URLs/rutas/emojis para que la voz no lea ruido).
- **Robustez ganada en combate:** el session_id solo se confirma con exit 0 (evita
  sesiones envenenadas); un resume inválido dispara auto-recovery (reintenta una
  vez con sesión limpia); stderr del proceso aflora en el error visible.

## AI-first: la app es operable por agentes

La regla de diseño: **la UI es espejo, no cabina**. Cero botones de trabajo; el
trabajo se hace hablándole al agente. Y la app misma es una superficie que los
agentes pueden operar:

- **Gate** (`~/.config/sfterm/gate/`, siempre activo): un agente externo (Levy, un
  cron, un script) opera la app por archivos JSON: `ping`, `list`, `spawn`, `send`,
  `read`, `blocks` (comandos con exit/duración), `block_last` (último bloque CON su
  output — estructura, no scrape de pantalla), `show`, `close`, `snap` (screenshot).
  Cliente de referencia: `scripts/gate.py`.
- **Harness de debug** (`/tmp/sfterm-cmd.json`, solo dev o `SFTERM_DEBUG=1`):
  `eval`/`evaljson`/`snap` para E2E. Los singletons clave están expuestos:
  `window.__sfterm` (store, actions, ipc), `window.__chat`, `window.__readerSpeech`.
- **El motor de bloques es consultable:** un agente no "lee la pantalla", pide
  `block_last` y recibe comando + exit + output estructurado del motor en Rust.

Guía completa para agentes (schema del config, arquitectura, reglas duras):
[CLAUDE.md](CLAUDE.md).

## Config

`~/.config/sfterm/config.toml` con hot-reload y comentarios preservados
(toml_edit). Temas (titanium/graphite/midnight/paper/custom), fuentes, atajos
remapeables, presets agénticos con kickoff. Schema completo en
[CLAUDE.md](CLAUDE.md).

## Arquitectura (mapa rápido)

```
src-tauri/src/
  pty.rs        PTYs reales (portable-pty), streaming binario por Channel
  engine/       MOTOR PROPIO: parser vte, grid, bloques OSC 133, frames binarios
  agent.rs      chat nativo: claude -p stream-json por turno + adjuntos
  voice.rs      dictado: ffmpeg (mic) + whisper-cli (STT local)
  gate.rs       puerta de agentes (archivos JSON) + screenshots
  config.rs     config.toml quirúrgico (toml_edit) + hot-reload
  fsx.rs        árbol lazy + watcher + índice ⌘P + visor solo-lectura
src/
  core/         term (pool xterm FUERA de React), ownterm (canvas del motor),
                tiling (árbol puro de splits), chat (conversaciones + parse del
                stream), md (markdown compartido), reader-speech (TTS), gate
  components/   Tiling, Rail, Tree, ChatView, Reader, Composer, Palette, …
```

Los 35 tests de `cargo test` cubren el motor (parser, grid, bloques, soft-wraps)
y las piezas puras nuevas (ranking de modelos whisper, base64 de adjuntos).

## Reglas duras del repo

- Los terminales viven en `#term-pool` FUERA del árbol React (nunca como children).
- Diálogos nativos (alert/confirm/prompt) prohibidos: bloquean el webview.
- El visor es solo-lectura para siempre. Editar = pedírselo al agente.
- React 19 re-setea `dangerouslySetInnerHTML` en cada re-render: todo documento
  renderizado va memoizado y el HTML se genera completo a nivel string.
- `npm run validate` en verde antes de cualquier commit.
