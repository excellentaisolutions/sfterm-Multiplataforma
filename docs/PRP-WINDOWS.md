# PRP — Transformación de SFTerm/WinTerm para Windows

> Documento vivo de implementación. La fuente de verdad del avance es la
> sección **Estado de ejecución**. No se considera completada una fase sin la
> evidencia y los criterios de aceptación definidos aquí.

## 1. Misión

Transformar la aplicación Tauri 2 + Rust + React, actualmente acoplada a
macOS, en una aplicación Windows de primera clase sin degradar el producto ni
mantener forks divergentes.

La aplicación Windows final debe ofrecer terminales reales, motor VT propio,
persistencia de PTYs, navegador nativo aislado, árbol y visor de archivos,
Git, gate para agentes, voz local, configuración dinámica, instalador firmado
y actualizaciones seguras. macOS debe continuar funcionando desde la misma
base de código.

## 2. Principios no negociables

1. Una sola base de código y contratos neutrales entre UI y backend.
2. Adaptadores de plataforma concentrados; no dispersar `cfg(windows)` por la
   lógica de negocio.
3. Conservar los contratos IPC actuales siempre que sea posible.
4. Windows no será un modo degradado: las funciones principales deben tener
   implementación nativa real.
5. Las funciones opcionales deben anunciar capacidades y degradarse de forma
   explícita, nunca fallar silenciosamente.
6. Ningún pipeline puede quedar verde ejecutando cero tests.
7. El navegador de contenido externo nunca recibe el bridge IPC de Tauri.
8. Cerrar una terminal explícitamente elimina todo su árbol de procesos;
   cerrar o actualizar la GUI no elimina PTYs persistentes.
9. Todas las operaciones destructivas del árbol usan la papelera recuperable.
10. Cada fase debe dejar el repositorio verificable y, cuando corresponda,
    distribuible.

## 3. Alcance de soporte

### Matriz principal

- Windows 11 24H2 y 25H2, x64.
- PowerShell 7 como shell preferente.
- Windows PowerShell 5.1 como fallback.
- WebView2 Evergreen.
- Instalador NSIS per-user y MSI corporativo.

### Matriz secundaria

- Windows 10 1809 o posterior a nivel técnico, con validación prioritaria en
  LTSC. ConPTY no existe antes de 1809.
- Windows on ARM64 después de cerrar la paridad x64.
- `cmd.exe` funcional como terminal, aunque las funciones semánticas avanzadas
  pueden quedar limitadas si el shell no ofrece hooks suficientes.
- WSL como perfil opt-in posterior a la paridad nativa PowerShell.

## 4. Arquitectura objetivo

```text
React / Zustand / xterm / canvas / motor VT / Git / historial
                              │
                    contratos neutrales IPC
                              │
          ┌───────────────────┴───────────────────┐
          │                                       │
      adaptador macOS                       adaptador Windows
      WKWebView                             WebView2
      Unix PTY + zsh                        ConPTY + PowerShell
      Unix Domain Socket                    Named Pipe
      grupos POSIX                          Job Objects
      NSFileManager                         Recycle Bin / IFileOperation
      AVFoundation                          WASAPI
```

Estructura prevista:

```text
src-tauri/src/platform/
  mod.rs
  traits.rs
  macos/
    browser.rs
    process.rs
    transport.rs
    shell.rs
    desktop.rs
    capture.rs
    voice.rs
  windows/
    browser.rs
    process.rs
    transport.rs
    shell.rs
    desktop.rs
    capture.rs
    voice.rs
```

Contratos iniciales:

- `PlatformShell`
- `PlatformProcessTree`
- `PlatformTransport`
- `PlatformBrowserHost`
- `PlatformDesktop`
- `PlatformCapture`
- `PlatformVoice`
- `PlatformCapabilities`

## 5. Estado de ejecución

| Fase | Estado | Evidencia |
|---|---|---|
| 0. Baseline y CI | En curso | Scripts, runner y CI multiplataforma |
| 1. Frontera de plataforma | En curso | Compilación Rust macOS + Windows |
| 2. Terminal Windows | En curso | ConPTY + integración PowerShell OSC validada; E2E pendiente |
| 3. Daemon persistente | En curso | Named Pipe + Job Object + copia versionada; E2E pendiente |
| 4. Navegador WebView2 | Pendiente | Gate completo contra navegador |
| 5. Filesystem y paths | En curso | AppData + migración + rutas drive/UNC + temp nativo |
| 6. Atajos, ventana y voz | Pendiente | UX Windows y captura WASAPI |
| 7. Distribución | Pendiente | NSIS/MSI firmados y updater |
| 8. Hardening y release | Pendiente | Matriz E2E y auditoría de seguridad |

### Registro de ejecución

#### 2026-08-02 — Inicio de Fase 0

- PRP incorporado al repositorio como documento vivo.
- Scripts de iconos y tests convertidos a utilidades Node independientes del shell.
- Eliminado el falso verde de `npm test`: ahora descubre seis archivos y
  ejecuta 60 tests; cero archivos provoca error.
- Añadida matriz CI frontend para Windows/macOS y validación nativa macOS.
- `npm ci`: 153 paquetes instalados, cero vulnerabilidades reportadas.
- `npm run validate:frontend`: verde en Windows (lint sin errores, 60 tests,
  TypeScript y build Vite de producción).
- La nueva validación detectó y permitió corregir una llave de función ausente
  en `src/core/gate.ts`, defecto que impedía compilar el frontend.
- `cargo check` aún no produce evidencia nativa: el entorno local no puede
  conectar con `index.crates.io` para descargar `font-kit`. No se registra
  como fallo de código ni como validación superada.

#### 2026-08-02 — Inventario del entorno Windows reutilizable

- `C:\h` no es una instalación de Rust: es el directorio de salida Cargo
  compartido definido por la variable de usuario `CARGO_TARGET_DIR=C:\h`.
  Contiene unos 21,6 GB de artefactos `debug`/`release` de otros proyectos.
- Toolchain ya disponible y reutilizable: Rust/Cargo 1.97.0 estable,
  `x86_64-pc-windows-msvc`, con `rustfmt` y `clippy`. Está instalado mediante
  rustup en el perfil de usuario, no dentro de `C:\h`.
- Cadena nativa ya disponible y reutilizable: Visual Studio Build Tools 2022
  17.14, MSVC 14.44, Windows SDK 10.0.26100.0 y `signtool.exe` x64/x86.
  `cl.exe` no está en el PATH ordinario, pero `vcvars64.bat` está instalado.
- Runtime ya disponible y reutilizable: Microsoft Edge WebView2 Evergreen
  150.0.4078.105.
- Herramientas frontend ya disponibles: Node 24.15.0, npm 11.12.1 y CMake
  4.4.0. Ninja no está instalado, pero no es requisito del baseline Tauri.
- Los artefactos de `C:\h` demuestran que este equipo ya compiló Tauri/Wry,
  WebView2, `cpal`, Windows APIs y generó instaladores NSIS y MSI. También hay
  componentes DirectML/Vulkan y Whisper/GGML, potencialmente útiles para fases
  posteriores, pero no se incorporarán sin revisar origen, licencia y versión.
- La caché Cargo de fuentes no contiene `font-kit 0.14.3`; por ello los
  binarios ya compilados de `C:\h` no resuelven el bloqueo actual de
  `cargo check --offline`. Solo falta descargar esa dependencia y las que Cargo
  determine, no reinstalar el toolchain ni los SDK de Windows.
- Política: reutilizar instalaciones, SDK y caché de fuentes; no tratar
  `C:\h` como dependencia del proyecto ni copiar artefactos de otro producto.
  WinTerm fuerza `src-tauri/target` como target propio mediante la configuración
  local de Cargo y los wrappers npm, incluso si el entorno de usuario conserva
  `CARGO_TARGET_DIR=C:\h`. `C:\h` se conserva sin cambios para no afectar a
  otros proyectos. Se evaluará `sccache` únicamente si aporta una mejora medida.
- Reproducibilidad en máquinas nuevas: el repositorio fija Node 24.15.0, npm
  11.12.1 y Rust 1.97.0; incluye `.vsconfig`, diagnóstico multiplataforma y
  bootstrap PowerShell opcional con WinGet. Ningún componente detectado en la
  máquina de desarrollo se considera un prerrequisito implícito.
- El bootstrap reutiliza un toolchain instalado cuando su `rustc` coincide
  exactamente con 1.97.0, aunque el alias rustup sea `stable`; evita descargar
  una segunda copia sin relajar la versión exigida a máquinas nuevas o CI.
- Evidencia local: `npm run env:check` valida los siete requisitos, el bootstrap
  en modo no destructivo completa correctamente, Cargo informa
  `src-tauri/target` como destino y `npm run validate:frontend` permanece
  verde con 60 tests.

#### 2026-08-02 — Inicio de Fase 1

- Dependencias Objective-C, AppKit, WebKit, `font-kit` y `libc` limitadas a
  `target_os = "macos"`; Windows ya no intenta resolverlas ni compilarlas.
- Añadidos adaptadores Windows explícitos para navegador, delegados WebView2,
  harness de captura, voz y daemon PTY. Los subsistemas de fases posteriores
  fallan con errores funcionales y trazables en vez de enlazar código macOS.
- El camino PTY local permanece activo en Windows mediante
  `portable-pty`/ConPTY: selecciona PowerShell 7, Windows PowerShell o
  `cmd.exe`, en ese orden. Añadida prueba nativa ConPTY.
- Filesystem Windows ya abre Explorer, revela archivos y manda elementos a la
  Papelera de reciclaje manteniendo la guarda de raíz. La enumeración de fuentes
  usa el registro de Windows y `shell_capture` usa PowerShell.
- Añadida configuración Tauri específica de Windows: ventana con decoración
  nativa, NSIS principal, bloque de downgrade y bootstrapper WebView2 embebido.
- CI nativa Windows habilitada sin `continue-on-error`: `cargo check --locked`
  y `cargo test --locked`.
- La validación local de resolución avanza más allá de `font-kit`, pero
  `cargo check --offline` se detiene ahora en `git2`, tampoco presente en la
  caché de fuentes. Hasta disponer de crates.io no se declara la Fase 1 cerrada.
- Diagnóstico ampliado: Rust/Cargo 1.97.0 MSVC y los endpoints
  `index.crates.io`/`static.crates.io` están operativos desde la máquina, sin
  proxy. Sin embargo, `cargo.exe` y `rustup.exe` reciben `WSAEACCES` (error
  10013) al abrir sockets, mientras `curl.exe` conecta a los mismos hosts. El
  bloqueo es una política local por proceso (firewall, EDR o sandbox), no un
  defecto del manifiesto. `npm run cargo:doctor[:online]` deja esta diferencia
  reproducible y el bootstrap la muestra si falla la descarga. No se adoptan
  mirrors ni se altera el lockfile como falsa solución.

#### 2026-08-02 — Inicio de Fase 2

- Añadida integración PowerShell aislada por proceso. WinTerm ejecuta un perfil
  propio mediante `-File`, pero no crea, edita ni reemplaza `$PROFILE`; los
  perfiles normales de PowerShell siguen cargándose antes y su función
  `prompt` se conserva y se envuelve durante la sesión hija.
- PowerShell 7 y Windows PowerShell 5.1 reciben OSC 7 para el directorio actual,
  OSC 133 para los límites y exit code del bloque, y OSC 633 para el comando.
  El hook encadena un `AddToHistoryHandler` previo en vez de descartarlo.
- El parser normaliza el URI canónico `file:///C:/...` a un path Win32 sin el
  slash sintáctico inicial y conserva el percent-decoding. Añadida prueba Rust
  específica para drive letter, espacios codificados y evento `Cwd`.
- Evidencia local automatizada con `npm run test:shell:windows`: Windows
  PowerShell 5.1 y PowerShell 7.6 aceptan el script y producen en orden
  `633;E`, `133;C`, `133;D`, `7` y `133;A`. La prueba forma parte del job
  nativo Windows de CI. El arranque exacto con
  `-NoExit -ExecutionPolicy Bypass -File` también presenta prompt y termina
  limpiamente al recibir `exit`.
- El foreground local Windows ya se resuelve con un único snapshot de procesos
  por tick: selecciona el hijo vivo más reciente del shell, atraviesa launchers
  transparentes como `cmd.exe` y se detiene en el líder del workload para no
  confundir los helpers transitorios de un agente con el agente principal.
  Los nombres de ejecutable Windows se normalizan sin el sufijo `.exe`.
- `Ctrl+C` conserva la semántica VT/ConPTY mediante ETX. `Ctrl+Break`
  dispone de un comando IPC separado que termina el árbol foreground sin
  cerrar PowerShell; cerrar una terminal usa `taskkill /T /F` sobre el PID del
  shell para impedir descendientes huérfanos. La prueba automatizada crea un
  árbol desechable, comprueba que mueren padre e hijo y forma parte de CI.
- Los comandos para reanudar Claude ya se generan por familia de shell:
  asignación `$env:...;` y comillas PowerShell en Windows, sintaxis POSIX en
  macOS. Las rutas con espacios/apóstrofes y prompts multilínea están cubiertos
  por tests. La detección de shims npm reconoce los paquetes oficiales de
  Claude y Codex en vez de reportar `node`, `cli` o `codex.js`.
- Quedan por cerrar la validación interactiva E2E de Ctrl+C/Ctrl+Break,
  PowerShell 7/5.1, Claude/Codex y otra TUI, además de compilar toda la suite
  Rust cuando las fuentes Cargo estén disponibles.

#### 2026-08-02 — Inicio de Fase 3

- Eliminados los stubs del daemon Windows: protocolo, cliente, bridge, replay y
  servidor pasan a ser implementación común; solo el transporte y las
  primitivas de proceso cambian por plataforma.
- Añadido transporte byte-mode mediante Named Pipes Win32, compatible con el
  framing binario existente. El nombre se aísla por sesión Windows y hash del
  directorio de estado; `SFTERM_PTYD_PIPE` permite bancos totalmente aislados.
- Cada instancia del pipe usa una DACL protegida que concede acceso completo
  únicamente a SYSTEM y al propietario del objeto. La primera instancia usa
  `FILE_FLAG_FIRST_PIPE_INSTANCE` para impedir dos daemons sobre el mismo canal.
- Cada ConPTY del daemon se asigna a su propio Job Object con
  `KILL_ON_JOB_CLOSE`. `Kill` termina el Job completo y, si el daemon cae, el
  cierre del handle impide árboles huérfanos. `taskkill /T /F` queda como
  fallback explícito.
- El daemon arranca desacoplado y sin ventana desde una copia inmutable bajo
  `%LOCALAPPDATA%\SFTerm\daemon\<versión-tamaño-mtime>\sfterm-ptyd.exe`; un
  rebuild o updater puede reemplazar el ejecutable principal sin quedar
  bloqueado por el proceso persistente anterior.
- Foreground batch reutiliza un único snapshot de procesos Windows para todas
  las terminales del daemon. Las colas por cliente ahora son realmente
  acotadas; además se eliminó una autorreferencia que retenía el hilo escritor
  y el handle de transporte después de una desconexión.
- Añadida `npm run test:ptyd-primitives:windows`: compila con la versión Rust
  fijada, verifica un roundtrip real por Named Pipe y demuestra la terminación
  de un proceso mediante Job Object. La prueba está integrada en CI Windows.
- Evidencia local: primitives, process-tree, 65 tests frontend, TypeScript y
  build Vite verdes; todos los Rust tocados parsean con `rustfmt`. Sigue
  pendiente compilar y ejecutar el daemon completo porque `git2` no existe en
  la caché Cargo offline y la red del entorno está bloqueada.

#### 2026-08-02 — Inicio de Fase 5

- Separada la configuración humana del estado local: `config.toml` y
  `nervio.env` usan `%APPDATA%\SFTerm`; sesión, adjuntos, gate, eventos y
  runtime usan `%LOCALAPPDATA%\SFTerm`; shell generado y previews se almacenan
  bajo la caché local. macOS conserva `~/.config/sfterm` sin cambios.
- `SFTERM_CONFIG_DIR` sigue siendo una redirección total a una única raíz para
  bancos E2E, por lo que dos instancias aisladas no mezclan estado ni gate.
- Añadida migración idempotente desde `%USERPROFILE%\.config\sfterm`: nunca
  sobrescribe destinos, prefiere `rename` y, si cruza volúmenes, solo elimina
  el origen después de copiar, sincronizar y verificar el tamaño. Los enlaces
  simbólicos se rechazan explícitamente en vez de seguirlos.
- El cliente Python del gate y el puente nervio resuelven las mismas rutas
  Windows que Rust. La interfaz deja de mostrar una ubicación macOS fija.
- Centralizada la semántica frontend de `basename`, `dirname`, ruta relativa y
  ruta absoluta para aceptar separadores Windows/POSIX, unidades y shares UNC.
  Árbol, historial, títulos, lectores, buscadores y Source Control ya no parten
  paths manualmente con `split("/")`.
- El drag/drop del sistema acepta `C:\...`, UNC y saltos CRLF, deduplica entradas
  y rechaza texto relativo. Al soltar sobre una terminal, cada path se cita según
  la familia activa: comillas PowerShell en Windows y POSIX en macOS.
- Corregido el árbol para calcular rutas Git y directorios padre desde paths
  Win32. Esto cubre badges Git, nueva terminal en la carpeta del archivo,
  refresco tras Papelera y nombres en el diálogo de borrado.
- El gate dejó de asumir `/tmp`: solicita a Rust un destino validado bajo
  `std::env::temp_dir()`. La creación de worktrees emite PowerShell en Windows,
  conserva POSIX en macOS y devuelve también stderr/exit code de Git.
- Las acciones visibles usan Explorer en Windows y Finder en macOS. Las
  operaciones de revelar y Papelera siguen pasando argumentos directamente al
  backend nativo, sin construir comandos shell con paths.
- El parser OSC 7 conserva ahora la autoridad de `file://servidor/share` como
  ruta UNC en Windows (`//servidor/share`) y mantiene el comportamiento POSIX
  de descartar el hostname. Las unidades `file:///C:/...` siguen normalizadas
  sin el slash sintáctico inicial; hay cobertura Rust específica para ambos.
- Evidencia local: `npm run validate:frontend` verde con 65/65 tests, TypeScript
  y build Vite; contratos OSC correctos en PowerShell 5.1 y 7; prueba de
  terminación del árbol de procesos correcta; `rustfmt` parsea los Rust tocados.
  El check completo Rust continúa bloqueado antes de compilar porque la caché
  offline no contiene `git2` y este entorno no puede acceder a crates.io.

## 6. Fases de implementación

### Fase 0 — Baseline confiable

#### Trabajo

- Sustituir comandos POSIX de `package.json` por scripts Node neutrales.
- Pasar rutas de test explícitas a `node --test`.
- Fallar si se descubren cero tests.
- Separar validación frontend, Rust y completa.
- Añadir CI frontend para Windows y macOS.
- Añadir CI nativo macOS mientras se construye la frontera Windows.
- Registrar versiones de Node y Rust usadas por CI.
- Documentar comandos PowerShell de desarrollo.

#### Criterios de aceptación

- `npm test` ejecuta 60 o más tests en Windows.
- `npm run build` no depende de `rm`, `cp`, globbing del shell o `cd`.
- `npm run validate:frontend` pasa en Windows y macOS.
- Cero tests ejecutados produce exit code distinto de cero.

### Fase 1 — Frontera de plataforma

#### Trabajo

- Crear `platform` y sus traits.
- Encapsular browser, transporte, proceso, desktop, captura, shell y voz.
- Mover crates Objective-C a dependencias target macOS.
- Añadir dependencias Win32 únicamente bajo `cfg(windows)`.
- Crear `tauri.macos.conf.json` y `tauri.windows.conf.json`.
- Mover traffic lights y bundle `app` al overlay macOS.
- Añadir comando `platform_capabilities` para la UI.
- Proveer stubs Windows explícitos solo mientras se completa cada subsistema.

#### Criterios de aceptación

- `cargo check` compila en macOS y Windows.
- Ningún módulo neutral importa AppKit, WebKit, Unix sockets o Win32.
- La UI puede ocultar o explicar funciones aún no disponibles usando
  capacidades, sin capturar excepciones genéricas.

### Fase 2 — Terminal Windows

#### Trabajo

- Usar `portable-pty`/ConPTY en Windows.
- Resolver shell por configuración, `pwsh.exe`, `powershell.exe`, `cmd.exe`.
- Introducir perfiles de shell dinámicos.
- Mantener `TERM`, `COLORTERM`, `TERM_PROGRAM` y `SFTERM_TERM_ID`.
- Crear integración PowerShell OSC 133/633/7 conservando el perfil del usuario.
- Adaptar espera de prompt e inyección del comando inicial.
- Reemplazar foreground PGID por resolución del árbol descendiente.
- Adaptar detección de Claude/transcripts a procesos y paths Windows.
- Validar resize, Unicode, paste, IME, Ctrl+C, Ctrl+Break y salida.

#### Criterios de aceptación

- PowerShell 7 y 5.1 son plenamente interactivos.
- Claude/Codex y una TUI adicional funcionan sin consola externa.
- Los bloques conservan comando, output, exit code y duración.
- El renderer DOM y el renderer propio reciben exactamente el mismo stream.

### Fase 3 — Daemon persistente Windows

#### Trabajo

- Abstraer Unix socket/Named Pipe detrás de `PlatformTransport`.
- Usar `\\.\pipe\sfterm-<sid>-<config-hash>-v<protocol>`.
- Aplicar DACL del SID actual y denegar acceso remoto.
- Mantener el framing y ring buffer existentes.
- Crear un Job Object por terminal.
- Terminar el árbol mediante `TerminateJobObject`.
- Arrancar daemon desacoplado, sin ventana ni handles heredados.
- Añadir mutex nominal por config y versión de protocolo.
- Ejecutar el daemon desde una copia versionada en
  `%LOCALAPPDATA%\SFTerm\daemon\`; nunca desde el EXE instalable bloqueado.
- Definir handshake, compatibilidad de protocolo y limpieza de binarios viejos.

#### Criterios de aceptación

- El PID de la TUI no cambia tras cerrar/reabrir la GUI.
- Un rebuild o update puede reemplazar el ejecutable principal.
- `close` elimina shell y todos sus descendientes sin huérfanos.
- Un cliente lento o desconectado no bloquea el PTY.
- Dos config dirs aislados nunca comparten daemon.

### Fase 4 — Navegador WebView2

#### Trabajo

- Host WebView2 como child HWND del proceso principal.
- Perfil y data directory separados del webview Tauri principal.
- No registrar Tauri IPC ni host objects.
- Implementar navegación, estado, eval, zoom y modo móvil.
- Implementar focus, z-order, DPI y bounds físicos.
- Manejar `NewWindowRequested`, diálogos, file picker y descargas.
- Implementar `CapturePreview`, captura full-page y `PrintToPdf`.
- Limpiar cookies/cache por sesión.
- Preservar todos los verbos browser del gate.

#### Criterios de aceptación

- GitHub y páginas que bloquean iframe cargan correctamente.
- `read`, `click`, `type`, `snap`, `fullsnap`, `pdf` y descargas pasan E2E.
- La página externa no puede invocar comandos Tauri.
- Múltiples navegadores conservan sesión y propietario correctos.

### Fase 5 — Filesystem, paths y escritorio

#### Trabajo

- Helpers compartidos para basename, absolutas, normalización y file URI.
- Aceptar `C:\`, UNC, `/`, `\`, `~/` y `~\`.
- Corregir drag/drop, chips, historial, títulos, live links y paleta.
- Adaptar OSC 7 a `file:///C:/...` y UNC.
- Revelar con Explorer usando argumentos, no strings de shell.
- Abrir URLs mediante ShellExecute.
- Implementar papelera recuperable con IFileOperation o backend equivalente.
- Config en `%APPDATA%`; cache/logs/daemon en `%LOCALAPPDATA%`.
- Migrar el estado legado desde `%USERPROFILE%\.config\sfterm` si existe.

#### Criterios de aceptación

- Paths con espacios, Unicode, drive letters y UNC funcionan de extremo a extremo.
- Ninguna operación construye comandos shell con un path interpolado.
- La papelera rechaza root, paths fuera del árbol y ataques mediante enlaces.

### Fase 6 — Atajos, ventana y voz

#### Trabajo

- Introducir modificador semántico `primary`.
- Mapear `primary` a Meta en macOS y Control en Windows.
- Mantener `cmd`, `meta`, `ctrl` y `alt` como modificadores físicos avanzados.
- Presentar símbolos macOS o nombres Windows según plataforma.
- Añadir minimizar, maximizar/restaurar, cerrar, Alt+Space y doble clic.
- Revisar conflictos con Alt+Tab, Windows y layouts de teclado.
- Capturar audio vía WASAPI/`cpal` y generar WAV local.
- Mantener Whisper opcional con diagnóstico y modelo configurable.
- Validar Web Speech/TTS en WebView2 y conservar fallback temporal.

#### Criterios de aceptación

- Todos los atajos tienen comportamiento y representación nativos.
- La ventana funciona con Snap Layouts, DPI y varios monitores.
- Voz instalada funciona; voz ausente se desactiva sin afectar el resto.

### Fase 7 — Distribución y actualización

#### Trabajo

- NSIS per-user como canal principal.
- MSI para despliegue corporativo.
- WebView2 Evergreen con bootstrapper embebido.
- Firma Authenticode con timestamp.
- Updater firmado y rollback.
- Assets x64 y ARM64 cuando exista paridad.
- SBOM, auditoría de dependencias y comprobación de artefactos.

#### Criterios de aceptación

- Instalación limpia sin toolchain de desarrollo.
- Upgrade conserva config, sesiones y PTYs vivos.
- Uninstall elimina aplicación y pregunta antes de borrar datos del usuario.
- Artefactos y updater verifican firma antes de ejecutar.

### Fase 8 — Hardening y release

#### Trabajo

- CSP estricta para el webview principal.
- Reducir scope de `assetProtocol`.
- ACL explícita para gate, Named Pipe y archivos sensibles.
- Validar reparse points, symlinks y TOCTOU en operaciones de archivos.
- Pruebas E2E de 8 horas y ciclos repetidos de update/relaunch.
- Pruebas DPI 100/125/150/200 %, dos monitores, suspensión y reanudación.
- Benchmarks de RAM, CPU, scrollback y replay.

#### Criterios de aceptación

- Sin procesos huérfanos, corrupción de sesión ni canales cruzados.
- Browser externo sin acceso a IPC privilegiado.
- CI completa verde en Windows y macOS.
- Checklist de release firmado por evidencia reproducible.

## 7. Estrategia de pruebas

### Unitarias

- Paths Windows/Unix y file URIs.
- Framing de transporte y handshake.
- Ranking/detección de shells.
- Árbol de procesos Windows.
- Keybindings `primary` y modificadores físicos.
- Config migration y platform defaults.

### Integración

- ConPTY local y daemon.
- Named Pipe multi-cliente y reconexión.
- Job Object y kill tree.
- PowerShell shell integration.
- WebView2 callbacks y descargas.
- Papelera y guards.

### E2E

- Spawn → agente → output → bloque → lector.
- Cerrar GUI → reabrir → adoptar el mismo PTY.
- Update con daemon vivo.
- Navegador operado exclusivamente por gate.
- Paths en drives distintos y shares UNC.
- Instalación en usuario sin permisos administrativos.

## 8. Riesgos principales

| Riesgo | Impacto | Mitigación |
|---|---:|---|
| EXE del daemon bloquea update | Crítico | Copia versionada en LocalAppData |
| Foreground process no equivale a PGID | Alto | Árbol de procesos + señales OSC |
| Browser externo recibe IPC | Crítico | WebView2 aislado sin bridge/capabilities |
| Named Pipe accesible a otros usuarios | Crítico | DACL por SID y transporte local |
| Atajos pisan gestos del sistema | Alto | `primary`, catálogo por plataforma, E2E |
| Paths Windows tratados como Unix | Alto | Módulo único de paths y tests adversariales |
| CI verde con cero tests | Alto | Runner con descubrimiento y assert de conteo |
| Regresión macOS durante el port | Alto | Adaptador existente + matriz CI desde Fase 0 |

## 9. Estimación

- Un ingeniero senior: 6–9 semanas.
- Dos ingenieros trabajando en subsistemas independientes: 4–6 semanas.
- Primer build Windows utilizable sin navegador/voz completos: 2–3 semanas.

La secuencia obligatoria es baseline → frontera → ConPTY → daemon → WebView2
→ escritorio → distribución. Adelantar la UI o el instalador produciría una
aplicación aparentemente Windows sobre fundamentos todavía macOS.

## 10. Definition of Done global

- Build reproducible Windows x64 en máquina limpia.
- Todos los tests Rust y frontend se ejecutan realmente.
- Terminal estable durante ocho horas y bajo scrollback pesado.
- Agente TUI, resize, paste, Unicode, IME y señales verificados.
- Bloques semánticos y renderer propio en paridad con macOS.
- PTYs sobreviven cierre, crash, rebuild y update.
- Cierre explícito no deja descendientes.
- Navegador y gate completos sin exponer IPC privilegiado.
- Drive letters, UNC, papelera, Git y watcher verificados.
- Voz local funcional u opcionalmente desactivada con diagnóstico claro.
- NSIS/MSI y updater firmados.
- Windows y macOS verdes en CI.
