# SFTerm Multiplataforma

> **Nota:** este repositorio de adaptación permanece privado durante el
> desarrollo y la auditoría. Está previsto publicarlo cuando la migración
> alcance el nivel de estabilidad documentado en este README y en el PRP.

## Procedencia, autoría y propósito de esta modificación

Este repositorio contiene una **modificación del proyecto SFTerm original de
Daniel Carreón**, adaptada y mantenida por **Excellent AI Solutions** para
convertir la aplicación originalmente orientada a macOS en una base
multiplataforma, reproducible y funcional en Windows.

- Autor y proyecto original: **Daniel Carreón — SFTerm**,
  [repositorio oficial](https://github.com/saas-factory-community/sfterm).
- Adaptación multiplataforma: **Excellent AI Solutions**.
- Repositorio de esta adaptación:
  [excellentaisolutions/sfterm-Multiplataforma](https://github.com/excellentaisolutions/sfterm-Multiplataforma).
- Estado: migración Windows en curso; no se presenta como una versión oficial
  publicada o respaldada por Daniel Carreón.

El snapshot local recibido para esta adaptación no incluía el historial `.git`
ni una licencia raíz. El enlace upstream oficial fue confirmado posteriormente
y se conserva también como remoto Git `upstream`. Esta nota reconoce la
autoría, pero **no concede por sí misma derechos adicionales** sobre el código
original; cualquier uso o redistribución debe respetar la licencia o
autorización aplicable de Daniel Carreón y del repositorio oficial.

## Registro auditable de problemas detectados y mejoras

La siguiente tabla distingue entre defectos generales encontrados durante la
auditoría y limitaciones de portabilidad del código original. El detalle de
implementación, estado y criterios de aceptación vive en el
[PRP de migración Windows](docs/PRP-WINDOWS.md).

| ID | Problema detectado en la base original | Corrección incorporada en esta adaptación | Evidencia/estado |
|---|---|---|---|
| WIN-001 | Los scripts frontend dependían de `rm`, `cp` y quoting POSIX, por lo que el build fallaba en Windows. | Scripts Node neutrales al shell y bootstrap PowerShell reproducible. | Corregido; `npm run validate:frontend` verde. |
| WIN-002 | `npm test` podía finalizar correctamente ejecutando cero tests por un glob no expandido. | Runner con descubrimiento explícito que falla si no encuentra tests. | Corregido; 66/66 tests ejecutados en Windows y macOS. |
| WIN-003 | Dependencias Objective-C, AppKit, WebKit y `font-kit` se resolvían también para Windows. | Dependencias por target y frontera explícita de adaptadores macOS/Windows. | Corregido; `cargo check`, Clippy estricto y tests Rust verdes en ambos sistemas. |
| WIN-004 | El terminal asumía zsh, señales Unix y shell integration macOS. | ConPTY, selección PowerShell 7/5.1 y perfil OSC 7/133/633 aislado sin modificar `$PROFILE`. | Contratos PowerShell y prueba ConPTY real automatizados y verdes. |
| WIN-005 | Foreground, interrupciones y cierre de descendientes no tenían semántica Windows. | Snapshot de procesos, ETX para Ctrl+C, Ctrl+Break dedicado y terminación segura del árbol. | Prueba Windows de padre/hijo verde. |
| WIN-006 | El daemon usaba Unix sockets; ejecutar el daemon desde el EXE instalable bloquearía updates en Windows. | Named Pipes con DACL, Job Objects, replay compartido y copia versionada en LocalAppData. | Primitivas Win32 verificadas; E2E completo pendiente. |
| WIN-007 | Paths tratados mediante `split("/")`, drops solo POSIX y rutas temporales `/tmp`. | Helpers drive/UNC/POSIX, CRLF drag/drop, temp del sistema y quoting por shell. | 66 tests frontend, incluidos casos drive y UNC. |
| WIN-008 | Configuración, estado y textos asumían `~/.config`, Finder y layout macOS. | `%APPDATA%`/`%LOCALAPPDATA%`, migración legacy idempotente y etiquetas Explorer/Finder dinámicas. | Implementado con pruebas Rust añadidas. |
| WIN-009 | Comandos para reanudar agentes y crear worktrees emitían sintaxis POSIX bajo PowerShell. | Generación por familia de shell, comillas literales seguras y propagación de stderr/exit code. | Tests de quoting PowerShell/POSIX verdes. |
| CORE-001 | La validación inicial descubrió una llave de función ausente que impedía compilar el frontend. | Se corrigió el bloque y se añadió el build TypeScript al pipeline obligatorio. | Corregido y cubierto por CI. |
| CORE-002 | La cola del daemon se declaraba limitada pero era ilimitada; el writer retenía su propio `Sender` tras desconexión. | Cola acotada no bloqueante y eliminación de la autorreferencia que retenía hilo/handle. | Corregido en `src-tauri/src/ptyd/server.rs`. |
| CORE-003 | La base Rust no cumplía `cargo fmt`, haciendo fallar un gate estándar antes de compilar. | Normalización completa con Rust 1.97.0 y comprobación obligatoria en CI. | Formato y Clippy estricto verdes en Windows y macOS. |
| CORE-004 | Las capturas de terminal se parseaban solo con LF; un checkout Windows convertía fixtures a CRLF y anulaba todos los perfiles anclados. | Normalización CRLF/CR en el parser y EOL canónico para fixtures reales. | Caso CRLF específico añadido; suite 66/66. |
| CORE-005 | Varias pruebas nativas asumían rutas macOS y la prueba ConPTY podía esperar indefinidamente sin contestar la consulta DSR de PowerShell. | Expectativas por plataforma, separadores canónicos, timeouts y respuesta DSR igual a la del motor real. | Suite Windows estable; cero fallos ni esperas indefinidas. |
| CORE-006 | La UI no disponía del contrato `platform_capabilities` previsto en el PRP y podía intentar abrir adaptadores aún pendientes. | Capacidades tipadas desde Rust, cargadas en el boot y aplicadas antes de mutar el layout. | En Windows el navegador queda deshabilitado con una razón explícita; contrato cubierto por test Rust. |
| CORE-007 | Operaciones nativas de AppKit, Explorer, PowerShell, zsh y registro de fuentes permanecían dispersas dentro de módulos neutrales. | Adaptadores `platform/desktop`, `platform/fonts`, `platform/permissions` y `platform/shell`, más un verificador que impide regresiones. | Fronteras verificadas en CI Windows/macOS; Fase 1 completada. |

Para reproducir la evidencia actualmente disponible en Windows:

```powershell
npm run validate:frontend
npm run test:shell:windows
npm run test:process-tree:windows
npm run test:ptyd-primitives:windows
npm run check:rust
npm run test:rust
```

La ejecución de referencia en una máquina limpia es
[GitHub Actions #30761586029](https://github.com/excellentaisolutions/sfterm-Multiplataforma/actions/runs/30761586029):
los cuatro jobs de frontend y backend nativo finalizaron correctamente en
`windows-latest` y `macos-latest`, incluidos formato, `cargo check`, Clippy con
warnings como error y la suite Rust.

Las áreas todavía no cerradas —WebView2 completo, daemon E2E, atajos/ventana,
voz, instaladores firmados y hardening final— permanecen marcadas como
pendientes o en curso en el PRP; este repositorio evita declarar paridad sin
evidencia reproducible.


> La conversación con tu agente es el HOME; las terminales son el backstage.
> El workspace del operador agéntico, sin grasa.

App de escritorio Tauri 2 + Rust + React, originalmente diseñada para macOS y
actualmente en adaptación multiplataforma con soporte nativo Windows: sin
cuenta, sin cloud y sin telemetría. Parte de la familia SaaS Factory
(SFlow · SFCast · SFPoint · SFTerm).

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
git clone https://github.com/excellentaisolutions/sfterm-Multiplataforma.git
cd sfterm-Multiplataforma
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

## Preparación reproducible de Windows

El entorno local de un desarrollador nunca forma parte implícita del proyecto.
WinTerm declara Node y Rust, verifica los requisitos nativos y mantiene sus
artefactos en `src-tauri/target`. Solo se comparten las instalaciones del
sistema y las cachés de fuentes gestionadas por npm, Cargo y rustup.

En una máquina Windows nueva, abre PowerShell:

```powershell
git clone https://github.com/excellentaisolutions/sfterm-Multiplataforma.git
cd sfterm-Multiplataforma
.\scripts\setup-windows.ps1 -InstallPrerequisites
```

El modo `-InstallPrerequisites` usa WinGet para instalar Node 24 LTS, rustup,
WebView2 Evergreen y Visual Studio Build Tools con el workload C++ definido en
`.vsconfig`. Sin ese modificador, el script no instala software del sistema:
comprueba el entorno, instala el toolchain fijado por `rust-toolchain.toml`,
ejecuta `npm ci`, descarga el lockfile Cargo y valida el frontend.

Diagnóstico sin instalar ni descargar dependencias:

```powershell
npm run env:check
# salida consumible por automatización:
node scripts/check-environment.mjs --json
# toolchain, acceso a crates.io y estado de la caché Cargo:
npm run cargo:doctor
# prueba además cargo fetch --locked (puede descargar fuentes):
npm run cargo:doctor:online
# contratos nativos que no requieren compilar Rust:
npm run test:shell:windows
npm run test:process-tree:windows
npm run test:ptyd-primitives:windows
```

Si los endpoints de crates.io aparecen como accesibles pero el diagnóstico
online devuelve `cargo_process_socket_blocked`, Windows está denegando sockets
al proceso `cargo.exe` (por ejemplo, mediante firewall por aplicación,
antivirus/EDR o un sandbox). Es un problema de la máquina o del entorno de
ejecución, no de `Cargo.toml`: no se cambia `Cargo.lock` ni se introduce un
mirror para esconderlo. Tras autorizar Cargo, repite `npm run
cargo:doctor:online` y `npm run check:rust`.

La compilación nativa Windows ya está habilitada en CI y usa el overlay Tauri
específico de Windows. Consulta el estado y los bloqueos restantes en el
[PRP de migración](docs/PRP-WINDOWS.md); el bootstrap valida cada prerrequisito
sin presentar como terminados los subsistemas que aún siguen por fases.

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
- **Adjuntos:** arrastra archivos desde Explorer/Finder o pega una imagen del clipboard; los
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

- **Gate** (`%LOCALAPPDATA%\SFTerm\gate` en Windows,
  `~/.config/sfterm/gate` en macOS, siempre activo): un agente externo (Levy, un
  cron, un script) opera la app por archivos JSON: `ping`, `list`, `spawn`, `send`,
  `read`, `blocks` (comandos con exit/duración), `block_last` (último bloque CON su
  output — estructura, no scrape de pantalla), `show`, `close`, `snap` (screenshot).
  Cliente de referencia: `scripts/gate.py`.
- **Harness de debug macOS** (`/tmp/sfterm-cmd.json`, solo dev o `SFTERM_DEBUG=1`):
  `eval`/`evaljson`/`snap` para E2E. Los singletons clave están expuestos:
  `window.__sfterm` (store, actions, ipc), `window.__chat`, `window.__readerSpeech`.
- **El motor de bloques es consultable:** un agente no "lee la pantalla", pide
  `block_last` y recibe comando + exit + output estructurado del motor en Rust.

Guía completa para agentes (schema del config, arquitectura, reglas duras):
[CLAUDE.md](CLAUDE.md).

## Config

`config.toml` vive en `%APPDATA%\SFTerm` en Windows y en
`~/.config/sfterm` en macOS, con hot-reload y comentarios preservados
(toml_edit). El estado ligado a la máquina se guarda en
`%LOCALAPPDATA%\SFTerm`. Temas, fuentes, atajos remapeables y presets agénticos
con kickoff. Schema completo en [CLAUDE.md](CLAUDE.md).

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

La suite Windows de `cargo test` descubre 93 tests: 91 superados y 2 ignorados
de forma explícita. Cubre el motor (parser, grid, bloques, soft-wraps), paths y
configuración multiplataforma, transporte/daemon y piezas puras como ranking de
modelos whisper y base64 de adjuntos.

## Reglas duras del repo

- Los terminales viven en `#term-pool` FUERA del árbol React (nunca como children).
- Diálogos nativos (alert/confirm/prompt) prohibidos: bloquean el webview.
- El visor es solo-lectura para siempre. Editar = pedírselo al agente.
- React 19 re-setea `dangerouslySetInnerHTML` en cada re-render: todo documento
  renderizado va memoizado y el HTML se genera completo a nivel string.
- `npm run validate` en verde antes de cualquier commit.
