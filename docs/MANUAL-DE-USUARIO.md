# Manual de usuario de SFTerm / WinTerm

Este manual explica la aplicación desde cero y está pensado para una persona
que no necesita saber programar. También incluye secciones avanzadas para
quien quiera usar agentes de inteligencia artificial, Git, automatizaciones y
el navegador integrado.

> El ejecutable y la interfaz se llaman **SFTerm**. En este repositorio también
> se usa **WinTerm** para identificar la adaptación multiplataforma,
> especialmente la edición de Windows.

## 1. Qué es la aplicación

SFTerm es un espacio de trabajo que reúne en una sola ventana:

- terminales reales de Windows o macOS;
- agentes que funcionan dentro de esas terminales, como Claude Code, Codex o
  Kimi Code;
- un historial local de conversaciones de varios proveedores;
- un explorador de archivos ligado a la carpeta actual de la terminal;
- un visor de archivos y diferencias que no modifica el contenido;
- un navegador web integrado que tú y el agente podéis utilizar;
- un panel de estado de Git y checkpoints;
- dictado local opcional y lectura en voz alta;
- terminales persistentes que pueden sobrevivir al cierre o actualización de
  la interfaz.

La idea principal es **terminal primero**. Al abrir la aplicación aparece una
shell limpia y queda esperando. SFTerm no escribe `npm run tauri dev`, no inicia
un agente y no ejecuta un preset automáticamente. Cualquier comando empieza
porque tú lo escribes, eliges expresamente una acción o se lo pides a un agente.

## 2. Qué puede aportar

Algunos usos prácticos son:

- trabajar con PowerShell sin cambiar entre varias ventanas;
- mantener Claude, Codex y Kimi en terminales separadas;
- consultar conversaciones antiguas aunque el proveedor no esté conectado;
- continuar cada conversación con el mismo CLI y el último modelo detectado;
- desarrollar una web y verla en el navegador integrado;
- comparar cambios de Git sin ejecutar comandos destructivos;
- dejar tareas largas en terminales persistentes y volver más tarde;
- dividir la pantalla para comparar terminal, archivo, diff y navegador;
- escuchar una respuesta o un bloque largo en vez de leerlo entero;
- permitir que un agente local maneje SFTerm mediante el gate avanzado.

## 3. Requisitos básicos

### Windows

Para usar un instalador normal necesitas:

- Windows 10 u 11 de 64 bits;
- WebView2, incluido mediante bootstrapper en el instalador preparado por el
  proyecto;
- PowerShell 7 (`pwsh`) o Windows PowerShell. SFTerm prefiere PowerShell 7,
  después Windows PowerShell y, si ninguno existe, `cmd.exe`;
- el CLI de cada agente que quieras usar, instalado y autenticado por separado.

Un instalador personal autofirmado solo es de confianza en los equipos donde
se haya importado previamente su certificado público. No ofrece confianza
pública ni elimina necesariamente el aviso de SmartScreen.

### macOS

La aplicación usa zsh por defecto. El comportamiento general es el mismo, pero
los atajos muestran `⌘` en lugar de `Ctrl`, el explorador abre Finder y el
navegador integrado usa WKWebView.

### Agentes opcionales

SFTerm no incluye cuentas, suscripciones ni credenciales de proveedores. Para
continuar una conversación necesitas que su CLI esté disponible y autenticado
en ese ordenador:

- Claude Code: comando `claude`;
- Codex CLI: comando `codex`;
- Kimi Code: comando `kimi`.

Puedes usar la terminal sin instalar ninguno de ellos.

## 4. Primer inicio en cinco minutos

1. Abre SFTerm. Verás una terminal vacía esperando entrada.
2. Abre **Configuración → General**.
3. En **Ruta de trabajo**, escribe la carpeta que utilizas normalmente, por
   ejemplo `C:/Proyectos`, y pulsa **Guardar**.
4. Crea una terminal nueva para aplicar esa ruta. La terminal que ya estaba
   abierta conserva su carpeta actual.
5. Escribe `Get-Location` y pulsa `Enter` para comprobar dónde estás.
6. Escribe `Get-ChildItem` para listar archivos y carpetas.
7. Observa la zona derecha: la vista **Archivos** debe mostrar la misma ruta.
8. Si tienes un agente instalado, escribe `claude`, `codex` o `kimi`, o usa
   **Ctrl+Alt+J** para ejecutar el agente configurado.

La ruta se puede cambiar más tarde desde Configuración o desde la propia
terminal con:

```powershell
Set-Location "C:\Ruta\A\Tu\Proyecto"
```

Con la integración de shell activa, el árbol de archivos sigue este cambio.

## 5. Mapa de la ventana

La interfaz se divide en cinco zonas:

1. **Rail izquierdo**: terminales activas e historial de conversaciones.
2. **Área central**: terminales, archivos, diffs y navegador organizados en
   pestañas o divisiones.
3. **Sidebar derecho**: árbol de archivos o Source Control.
4. **Barra inferior**: repositorio, rama, cambios, número de terminales, RAM y
   CPU de la aplicación.
5. **Paneles flotantes**: paleta, búsquedas, configuración, lector, composer y
   terminal rápida.

Los separadores laterales se pueden arrastrar. Sus anchos se recuerdan en el
equipo.

## 6. El rail izquierdo

### Terminales activas

La sección **Activas** contiene los procesos que siguen vivos.

- Haz clic en una fila para mostrar y enfocar esa terminal.
- Arrastra una fila para cambiar su orden o crear una división en el área
  central.
- La `X` de la fila **mata el proceso** y cierra de verdad esa terminal.
- Cerrar solo la pestaña central no mata la terminal: la deja viva en el rail.
- Una marca de atención indica que un proceso ha sonado, espera entrada o está
  trabajando fuera de la vista.
- El icono de globo indica que esa conversación tiene navegador propio.

El botón **+ Nueva terminal** abre una shell normal, sin agente ni comando
automático.

### Historial local

Debajo de las activas aparecen conversaciones guardadas por los CLIs. Se puede:

- buscar por título, proyecto, proveedor o modelo;
- agrupar por fecha, proyecto o sin grupos;
- ordenar por actividad reciente o título;
- filtrar por proyecto;
- fijar conversaciones con la estrella;
- colapsar cualquier sección;
- cargar más resultados.

Las preferencias se recuerdan localmente. Una conversación viva no se duplica
en el historial si SFTerm puede identificarla con seguridad.

## 7. Uso de la terminal

La terminal acepta cualquier programa compatible con la shell del sistema.
En Windows se inicia PowerShell con `-NoLogo -NoProfile`: no carga el perfil
global del usuario y evita que ese perfil inyecte comandos o predicciones. Si
está activa la integración de SFTerm, solo se carga su perfil aislado para
informar del directorio y de los bloques de comandos.

### Gestos básicos

- `Enter`: ejecutar el comando o enviar el mensaje al CLI.
- `Ctrl+C`: interrumpir el programa en primer plano.
- Flechas arriba/abajo: historial de la shell o del CLI activo.
- `Tab`: autocompletar cuando el programa lo admita.
- `Shift+Enter` o `Alt+Enter`: salto de línea en los TUIs compatibles sin
  enviar todavía el mensaje.
- Pegar: conserva texto multilínea y Unicode mediante bracketed paste.

### Cambiar de carpeta

```powershell
Get-Location
Set-Location "C:\Proyectos\MiAplicacion"
Set-Location ..
Set-Location $env:USERPROFILE
```

El cambio de ruta actualiza el árbol derecho. Al abrir un archivo, el árbol
permanece visible y conserva la última ruta semántica de la terminal enfocada.

### Terminal normal, terminal con agente y terminal rápida

- **Ctrl+N**: terminal normal en el área central.
- **Ctrl+Alt+J**: terminal nueva con `general.agent_command`.
- **Ctrl+J**: abre u oculta el panel inferior de terminal rápida.

El panel inferior admite varias pestañas mediante `+`. Ocultarlo no mata sus
terminales. La `X` de una pestaña del panel inferior sí la mata.

### Composer

**Ctrl+I** abre un campo de texto normal conectado a la terminal enfocada. Es
útil para escribir mensajes largos, seleccionar con el ratón o dictar.

- `Enter`: enviar;
- `Shift+Enter`: nueva línea;
- flechas arriba/abajo, en los límites del texto: recorrer el historial del
  composer;
- `Esc`: cancelar dictado o cerrar.

El historial del composer se guarda solo en este equipo, con un máximo de 120
entradas.

## 8. Pestañas, divisiones y organización

El área central se comporta como un mosaico de campos con pestañas.

- Arrastra una pestaña al encabezado de otro campo para convertirla en
  pestaña de ese campo.
- Arrástrala a un borde para crear una división izquierda, derecha, superior o
  inferior.
- Arrastra el separador entre campos para cambiar su tamaño.
- **Ctrl+Shift+E** expande el campo enfocado a toda la pantalla; repetirlo
  restaura exactamente el diseño anterior.
- **Ctrl+D** encajona una terminal: sale de la vista pero continúa viva.
- **Ctrl+Shift+D** restaura la última terminal encajonada.
- **Shift+Tab** cambia de pestaña solo cuando el campo tiene al menos dos. Con
  una sola, SFTerm deja la tecla al agente.
- **Ctrl+W** cierra un archivo o navegador. En una terminal quita la pestaña de
  la vista y deja el proceso vivo en el rail.

En Windows, `Alt+Tab` suele pertenecer al sistema operativo. El atajo
predeterminado para recorrer terminales activas puede no llegar a SFTerm. Se
recomienda reasignar **Siguiente terminal** desde Configuración → Atajos.

## 9. Explorador de archivos

La pestaña de carpeta del sidebar muestra la ruta actual de la terminal
enfocada. No cambia al abrir un archivo; únicamente cambia cuando cambia la
terminal enfocada o su directorio.

### Acciones

- Clic en carpeta: expandir o contraer.
- Clic en archivo: abrir como preview temporal.
- Doble clic en archivo: fijar su pestaña.
- `Shift+clic`: seleccionar un rango visible.
- Arrastrar uno o varios elementos: abrirlos como pestañas o divisiones.
- Clic derecho:
  - revelar en Explorer o Finder;
  - copiar la ruta;
  - abrir una terminal en esa carpeta;
  - mover a la papelera del sistema.

La eliminación desde el árbol es recuperable. SFTerm rechaza el borrado del
propio root y los paths que salgan de él. Aun así, comprueba siempre la lista
antes de confirmar.

### Cambiar el root del proyecto

En la vista **Archivos**, el nombre superior es informativo y sigue a la
terminal. En **Source Control**, el nombre permite elegir entre repositorios
recientes y presets. También puedes abrir la paleta y pegar una ruta.

## 10. Visor de archivos

El visor es deliberadamente **solo lectura**. Para modificar un archivo debes
usar la terminal, un editor externo o pedírselo a un agente.

Admite:

- código y texto con resaltado de sintaxis;
- Markdown renderizado o como fuente;
- imágenes con zoom;
- audio y vídeo con controles;
- diffs de Git;
- aviso claro para binarios o archivos demasiado grandes.

En la barra de la pestaña puedes alternar Markdown, abrir el diff, revelar el
archivo en Explorer/Finder, cerrar o mover la pestaña.

## 11. Búsqueda y paleta de comandos

### Buscar archivo por nombre

**Ctrl+P** indexa el root del proyecto y busca de forma aproximada. Usa flechas
para moverte y `Enter` para abrir.

### Buscar contenido

**Ctrl+Shift+F** busca texto dentro del proyecto, respeta `.gitignore` y omite
binarios. Escribe al menos dos caracteres. Un resultado abre el archivo cerca
de la línea encontrada.

### Buscar dentro de la terminal

**Ctrl+Alt+F** busca en el scrollback de la terminal enfocada. `Enter` avanza y
`Shift+Enter` retrocede.

### Paleta

**Ctrl+K** ofrece:

- aplicar presets definidos en `config.toml`;
- abrir terminal normal o terminal con agente;
- leer el último bloque;
- ver todos los cambios del repositorio;
- buscar por contenido;
- detectar y abrir un preview de desarrollo;
- abrir el navegador integrado;
- mostrar u ocultar árbol y rail;
- abrir Configuración;
- abrir `config.toml` en el visor.

En macOS puedes pegar rutas `/...` o `~/...` directamente. En Windows se
recomienda configurar la ruta desde Configuración o usar el selector de Source
Control, porque la detección rápida de la paleta está orientada actualmente a
paths POSIX.

## 12. Lector de conversaciones vivas

**Ctrl+L** o **Ctrl+Tab** abre la conversación de la terminal enfocada con una
presentación tipo chat. Repetir el atajo o pulsar `Esc` vuelve a la terminal.

- Claude Code dispone de transcript enriquecido: mensajes, herramientas,
  modelo, contexto y adjuntos.
- Otros agentes reconocidos pueden mostrarse como espejo de la pantalla viva
  cuando no existe adaptador de transcript en tiempo real.
- Se pueden copiar mensajes y escucharlos con la voz del sistema.
- El composer del lector envía el texto a la misma terminal.
- Los archivos se pueden arrastrar o pegar como adjuntos cuando el flujo lo
  admite.

Un shell normal no abre el lector aunque cambie el título de la ventana. La
lista configurable `general.agent_procs` evita confundir una shell con un
agente.

## 13. Historial multiproveedor

La consulta del historial es local y de solo lectura. Al hacer clic en una
tarjeta SFTerm lee el transcript del disco, no inicia el agente, no envía ningún
prompt y no necesita credenciales para mostrar lo ya guardado.

| Proveedor | Lectura local | Continuación |
|---|---|---|
| Claude Code | Sí | `claude --resume`, cuenta/config, cwd y modelo |
| Codex CLI | Sí | `codex resume`, `CODEX_HOME`, cwd y modelo |
| Kimi Code | Sí | `kimi --session`, `KIMI_CODE_HOME` y modelo |

La barra inferior del lector permite **Continuar en terminal** o escribir el
primer mensaje que se entregará al despertar el CLI. La continuación siempre:

- abre una terminal nueva;
- usa el mismo proveedor;
- conserva la carpeta de trabajo;
- propone el último modelo detectado;
- conserva la raíz de configuración/cuenta no predeterminada cuando existe.

Si el CLI no está instalado, la sesión expiró, falta autenticación o el modelo
ya no está disponible, el propio CLI mostrará el error. SFTerm no cambia el
modelo silenciosamente ni mueve una conversación a otro proveedor.

Los agentes `aider`, `gemini`, `opencode`, `cursor-agent` y `goose` pueden ser
reconocidos como procesos vivos si aparecen en `agent_procs`, pero no se
anuncian como históricos reanudables hasta disponer de indexador, parser y
comando de reanudación verificados.

## 14. Navegador integrado

Abre **Ctrl+K → Abrir navegador**. En Windows usa WebView2 y en macOS WKWebView,
por lo que puede cargar páginas que un `iframe` normal bloquearía.

### Controles visibles

- atrás, adelante, recargar o detener;
- barra de URL o búsqueda e historial;
- errores de consola detectados;
- ajuste automático de ancho;
- modo móvil tipo iPhone;
- selector visual de elemento para el agente;
- sesión limpia, que borra cookies y datos de todos los sitios;
- expandir a pantalla completa;
- abrir en el navegador del sistema;
- buscar dentro de la página;
- responder `alert`, `confirm` y `prompt` sin ventanas externas;
- mostrar el estado de descargas.

Dentro de la página, usa `Ctrl+L`, `Ctrl+R`, `Ctrl+F`, `Ctrl+[`, `Ctrl+]` y
`Ctrl++/-/0` en Windows. En macOS sustituye Ctrl por `⌘`.

El navegador pertenece a la conversación/terminal desde la que se abrió. Al
cerrar definitivamente esa terminal también se cierra su navegador para no
dejar procesos invisibles consumiendo memoria.

### Seguridad del navegador

La página no recibe acceso al IPC de SFTerm. Sin embargo, el usuario y el gate
local sí pueden leer, hacer clic, escribir, subir archivos, descargar, evaluar
JavaScript y capturar la página. Usa el gate solo con agentes y scripts en los
que confíes. **Sesión limpia** borra los datos de todos los sitios del navegador
integrado, no solo del sitio actual.

## 15. Source Control y Git

Pulsa el icono de ramas del sidebar derecho. El panel es un espejo de lectura:
no hace commit, push, merge ni restore por sí solo.

Muestra rama y upstream, commits por delante o detrás, archivos modificados,
diffs, grafo de commits, ramas y checkpoints locales. El botón de refresco
ejecuta únicamente `git fetch`. El punto relleno del grafo identifica un commit
local que aún no está en el upstream cuando este existe.

Las operaciones que cambian el repositorio se hacen conversando con un agente
o escribiendo comandos Git. Revisa siempre el diff antes de `commit`, `push`,
`merge`, `reset` o `restore`.

### Checkpoints

Son fotos ocultas bajo `refs/sfterm/checkpoints/*`. No modifican el índice ni
el working tree al crearse y no se publican por defecto. Restaurar sí cambia
archivos; debe hacerse solo tras confirmación. Antes de restaurar, SFTerm crea
un checkpoint `pre-restore` para poder deshacer la operación.

## 16. Lectura de bloques y voz

Con `general.shell_integration = true`, SFTerm identifica inicio, fin, salida,
código de retorno y duración de los comandos.

**Ctrl+K → Leer último bloque** abre su salida como documento. Permite recargar,
alternar Markdown/texto, copiar, escuchar con la voz del sistema y renderizar
tablas, código, HTML aislado y diagramas Mermaid compatibles.

La lectura TTS utiliza las voces instaladas en el sistema. El dictado STT es
independiente y opcional.

### Dictado local en Windows

Necesita:

- micrófono predeterminado de Windows;
- `whisper-cli.exe` accesible por `PATH` o `SFTERM_WHISPER_BIN`;
- un modelo `ggml-*.bin` en `%APPDATA%\SFTerm\models` o indicado por
  `SFTERM_WHISPER_MODEL`.

Windows captura por WASAPI/CPAL, convierte a 16 kHz y ejecuta Whisper
localmente. Si falta alguna pieza, el botón queda desactivado y muestra el
motivo; el composer sigue funcionando con teclado.

## 17. Configuración visible

Abre el engranaje o **Ctrl+,**.

### General

- **Ruta de trabajo**: carpeta para el arranque y las terminales nuevas.
- **Usar ruta actual**: copia el cwd de la terminal enfocada.
- **Paleta**: temas incluidos y cualquier tema añadido por el usuario.
- **Fuente de terminal**: solo fuentes monoespaciadas.
- **Tamaño de terminal**.
- **Fuente y tamaño de interfaz**.
- **Padding de terminal**.
- **Abrir config.toml**.

Los cambios visuales se aplican en vivo. La ruta de trabajo se aplica al
arranque y a terminales nuevas, no mueve una terminal ya abierta.

### Atajos

Cada acción permite capturar un nuevo combo, restaurar el predeterminado,
desasignar, detectar colisiones y avisar de combinaciones que pertenecen al
terminal. `Esc` cancela una captura sin guardar.

### Actualizaciones

Muestra versión instalada, consulta el canal estable, descarga, valida la firma
del updater e instala. Esta función solo opera si el build incorpora una clave
pública y un endpoint válidos. Un build unsigned o sin canal configurado puede
mostrar un error de consulta; no significa que la terminal esté dañada.

## 18. Atajos predeterminados

`Primary` significa `Ctrl` en Windows y `⌘` en macOS.

| Acción | Windows | macOS |
|---|---|---|
| Terminal normal en el área central | Ctrl+N | ⌘N |
| Terminal rápida inferior | Ctrl+J | ⌘J |
| Terminal con el agente configurado | Ctrl+Alt+J | ⌘⌥J |
| Abrir/cerrar lector | Ctrl+L o Ctrl+Tab | ⌘L o Ctrl+Tab |
| Cerrar pestaña/retirarla de la vista | Ctrl+W | ⌘W |
| Recorrer terminales activas | Alt+Tab* | ⌥Tab |
| Cambiar pestaña del campo | Shift+Tab | ⇧Tab |
| Buscar archivo | Ctrl+P | ⌘P |
| Buscar contenido | Ctrl+Shift+F | ⌘⇧F |
| Buscar en terminal | Ctrl+Alt+F | ⌘⌥F |
| Paleta | Ctrl+K | ⌘K |
| Árbol de archivos | Ctrl+B | ⌘B |
| Rail izquierdo | Ctrl+Alt+B | ⌘⌥B |
| Foco entre divisiones | Ctrl+Alt+flecha | ⌘⌥flecha |
| Encajonar / restaurar | Ctrl+D / Ctrl+Shift+D | ⌘D / ⌘⇧D |
| Expandir campo | Ctrl+Shift+E | ⌘⇧E |
| Composer | Ctrl+I | ⌘I |
| Seleccionar buffer de terminal | Ctrl+A | ⌘A |
| Markdown render/fuente | Ctrl+Shift+M | ⌘⇧M |
| Tema claro/oscuro | Ctrl+Shift+T | ⌘⇧T |
| Zoom | Ctrl++ / Ctrl+- / Ctrl+0 | ⌘+ / ⌘- / ⌘0 |
| Configuración | Ctrl+, | ⌘, |
| Panel completo de atajos | Ctrl+Alt+S | ⌘⌥S |
| Relanzar aplicación | Ctrl+R | ⌘R |

\* Windows suele reservar `Alt+Tab`; reasigna esta acción si el sistema la
intercepta.

## 19. Configuración avanzada mediante config.toml

En Windows vive en `%APPDATA%\SFTerm\config.toml`. En macOS vive en
`~/.config/sfterm/config.toml`.

SFTerm conserva comentarios al escribir desde la interfaz y observa los
cambios del archivo. Haz una copia antes de editarlo manualmente. Un TOML
inválido impide cargar la configuración hasta corregir la sintaxis.

### Sección general

| Clave | Función |
|---|---|
| `default_preset` | Preset que aporta la ruta si `working_directory` está vacío |
| `agent_command` | Comando de Ctrl+Alt+J y de los panes `agent` |
| `working_directory` | Ruta predeterminada de terminales nuevas |
| `restore_session` | Restaurar layout y terminales al arrancar |
| `daemon` | Mantener PTYs fuera de la interfaz para que sobrevivan |
| `scrollback` | Líneas guardadas por terminal |
| `shell_integration` | Cwd en vivo y bloques de comandos |
| `agent_procs` | Procesos/títulos reconocidos por el lector vivo |

Las claves antiguas `app_mode` y `home` pueden existir en configuraciones
migradas, pero el frontend actual siempre arranca en el taller de terminales y
no depende de ellas.

### Apariencia

`theme`, `ui_font`, `ui_font_size`, `terminal_font`,
`terminal_font_size`, `terminal_padding`, `opacity`, `zoom` y `renderer`.

- `dom`: xterm.js, estable y predeterminado;
- `own`: motor Rust/canvas con bloques visibles y scrollback propio;
- `webgl`: no recomendado donde el WebView no lo soporte correctamente.

El renderer y la integración de shell se aplican a terminales nuevas. El
daemon y la restauración se deben comprobar tras reiniciar la aplicación.

### Historial Claude adicional

```toml
[history]
claude_roots = ["~/.claude", "~/.claude-trabajo"]
```

Una raíz inexistente simplemente no aporta conversaciones. No publiques rutas
si identifican una cuenta real.

### Presets

Los presets **solo se ejecutan al elegirlos expresamente desde la paleta**.

```toml
[[presets]]
name = "mi-proyecto"
root = "C:/Proyectos/MiProyecto"
panes = ["", "agent"]
```

- `""`: shell libre;
- `"agent"`: ejecuta `general.agent_command`;
- cualquier otro texto: comando literal para ese pane;
- `kickoff`: comando opcional cuya salida se entrega como primer prompt al
  primer pane `agent`.

Un preset puede encajonar terminales visibles, cambiar el root y crear varios
panes. Revisa muy bien `panes` y `kickoff`: son la excepción explícita a la
regla de arranque inactivo.

### Ejemplo conservador para Windows

```toml
[general]
default_preset = "personal"
agent_command = "claude"
working_directory = "C:/Proyectos"
restore_session = true
daemon = true
scrollback = 12000
shell_integration = true
agent_procs = ["claude", "codex", "kimi", "aider", "gemini", "opencode"]

[appearance]
theme = "arbrain"
ui_font = "Inter"
ui_font_size = 13
terminal_font = "Cascadia Mono"
terminal_font_size = 13
terminal_padding = 10
opacity = 1.0
zoom = 1.0
renderer = "dom"

[[presets]]
name = "personal"
root = "C:/Proyectos"
panes = [""]
```

Usar `agent_command = "claude"` conserva las confirmaciones normales del CLI.
Si añades flags que omiten permisos, el agente podrá ejecutar acciones sin
preguntar; hazlo únicamente si entiendes ese riesgo.

## 20. Comandos útiles de PowerShell

SFTerm no limita los comandos. Estos son ejemplos para orientarse.

### Navegar, consultar y buscar

```powershell
Get-Location
Get-ChildItem
Get-ChildItem -Force
Set-Location "C:\Proyectos\MiProyecto"
Get-Content .\README.md
Get-ChildItem -Recurse -File | Select-String -Pattern "texto a buscar"
```

En proyectos grandes suele ser más rápido `rg` si está instalado:

```powershell
rg "texto a buscar"
rg --files
```

### Crear y mover

```powershell
New-Item -ItemType Directory -Path .\NuevaCarpeta
Copy-Item .\origen.txt .\copia.txt
Move-Item .\copia.txt .\NuevaCarpeta\copia.txt
```

Para borrar manualmente, comprueba siempre la ruta exacta. El menú del árbol
es preferible porque usa la papelera recuperable.

### Git de consulta

```powershell
git status
git diff
git log --oneline --graph --decorate --all
git fetch --prune
```

### Git que modifica o publica

```powershell
git add .
git commit -m "Describe el cambio"
git pull --ff-only
git push
```

`add`, `commit`, `pull` y `push` cambian estado local o remoto. Lee `git status`
y `git diff` antes de ejecutarlos.

### Proyectos Node y agentes

```powershell
npm install
npm test
npm run build
npm run dev
npm run
claude
codex
kimi
```

Los scripts de npm dependen de cada `package.json`. Cada agente requiere su
instalación y autenticación.

## 21. Recetas de trabajo

### Trabajar en un proyecto con un agente

1. Configura la ruta del proyecto.
2. Abre una terminal normal y comprueba `git status`.
3. Pulsa Ctrl+Alt+J para abrir el agente configurado.
4. Usa Ctrl+L para leer la conversación de forma cómoda.
5. Revisa Source Control y los diffs antes de aceptar cambios.

### Comparar dos agentes

1. Abre una terminal con Claude y otra con Codex.
2. Arrastra una fila del rail al borde del área central para dividir.
3. Entrega el mismo problema a ambos.
4. Abre sus resultados o diffs como pestañas.
5. No dejes a dos agentes editar los mismos archivos a la vez; usa worktrees
   mediante el gate avanzado si necesitas paralelismo real.

### Continuar una conversación antigua

1. Busca por título, proveedor, modelo o proyecto en el rail.
2. Haz clic para leerla sin iniciar nada.
3. Comprueba modelo y ruta.
4. Pulsa **Continuar en terminal**.
5. Si aparece un error, autentica el CLI correcto o elige un modelo válido
   desde ese mismo proveedor.

### Desarrollar una web

1. Ejecuta el servidor en una terminal, por ejemplo `npm run dev`.
2. Abre Ctrl+K → **Preview del dev server** o **Abrir navegador**.
3. Usa modo móvil para revisar responsive.
4. Usa el selector de elemento para indicar al agente una zona concreta.
5. Consulta consola y red mediante el gate cuando sea necesario.

### Dejar una tarea larga

1. Mantén `daemon = true`.
2. Inicia la tarea.
3. Encajona con Ctrl+D o cierra solo la pestaña.
4. Vuelve desde el rail. No pulses su `X`, porque mata el proceso.

## 22. Privacidad y seguridad

- Los comandos se ejecutan con los permisos de tu usuario del sistema.
- SFTerm no guarda contraseñas de Claude, OpenAI o Kimi; las gestiona cada CLI.
- Los historiales se leen desde los archivos locales de cada proveedor.
- Abrir un histórico no contacta con APIs externas.
- Continuar sí puede contactar con el proveedor mediante su CLI.
- Los adjuntos pegados se guardan en el estado local para que el transcript
  pueda seguir mostrándolos.
- El navegador conserva cookies hasta usar **Sesión limpia** o borrar sus datos.
- El gate permite acciones potentes a procesos locales. No ejecutes clientes
  de gate de origen desconocido.
- Source Control es de lectura, pero la terminal y los agentes pueden cambiar
  y publicar el repositorio.
- Nunca publiques transcripts, tokens, cookies, certificados, PFX, claves del
  updater, contraseñas, fingerprints ni rutas personales.

## 23. Datos, copias de seguridad y restablecimiento

### Windows

| Tipo | Ruta |
|---|---|
| Configuración editable | `%APPDATA%\SFTerm\config.toml` |
| Estado del equipo | `%LOCALAPPDATA%\SFTerm` |
| Layout | `%LOCALAPPDATA%\SFTerm\session.json` |
| Adjuntos | `%LOCALAPPDATA%\SFTerm\adjuntos` |
| Gate | `%LOCALAPPDATA%\SFTerm\gate` |
| Datos del navegador | `%LOCALAPPDATA%\SFTerm\browser-webview2` |
| Modelos Whisper | `%APPDATA%\SFTerm\models` |

En macOS, la configuración y el estado principal viven en
`~/.config/sfterm`.

Con la aplicación cerrada, guarda `config.toml`, `session.json` y los adjuntos
que necesites. Los transcripts de proveedores se respaldan por separado.

### Restablecer solo la configuración

1. Cierra SFTerm.
2. Renombra `config.toml` en vez de borrarlo.
3. Abre SFTerm para generar uno nuevo.
4. Recupera manualmente solo las secciones necesarias.

### Restablecer solo el layout

Con SFTerm cerrado, renombra `session.json`. Esto no borra los historiales. Si
el daemon conserva terminales, pueden reaparecer en el rail.

## 24. Solución de problemas

### Aparece un comando escrito automáticamente al iniciar

El comportamiento correcto es una shell esperando. Comprueba que no aplicaste
un preset con `panes` o `kickoff`, que el comando no procede de una sesión
reanudada, `restore_session` y que no existe una automatización externa
escribiendo por el gate.

En Windows, SFTerm ignora el perfil global de PowerShell. Un script `.sh` de
otra aplicación o plugin no forma parte del arranque normal de SFTerm.

### El árbol no sigue a Set-Location

- confirma que la terminal está enfocada;
- ejecuta `Get-Location`;
- comprueba `shell_integration = true`;
- crea una terminal nueva después de activar la integración;
- usa una ruta absoluta si el prompt no emite cwd correctamente.

### El árbol desaparece al abrir un archivo

Pulsa Ctrl+B y selecciona el icono de carpeta del sidebar. En la versión actual
el archivo se abre como pestaña central y no debe sustituir el explorador.

### Un histórico carga sin terminar o no se puede continuar

- comprueba que el archivo local existe;
- ejecuta manualmente `claude`, `codex` o `kimi` para probar instalación/login;
- verifica que el modelo aún existe para tu cuenta;
- no intentes reanudar una sesión con otro proveedor.

### El dictado está desactivado

Pasa el cursor sobre el botón para leer el diagnóstico. Comprueba micrófono,
`whisper-cli` y modelo `ggml`.

### El navegador no abre en Windows

Instala o repara Microsoft Edge WebView2 Runtime. Si una web falla, prueba otra
URL y consulta consola/red antes de borrar toda la sesión.

### Alt+Tab cambia de aplicación

Es normal en Windows. Reasigna **Siguiente terminal** desde Configuración →
Atajos.

### La actualización no está disponible

El build puede no tener canal firmado configurado. Usa el instalador personal
correspondiente; no desactives la verificación de firma.

### SmartScreen avisa con una firma autofirmada

Una firma personal no tiene reputación pública. Verifica procedencia, hash y
certificado antes de confiar. Nunca importes una clave privada o un PFX recibido
de un tercero.

## 25. Gate avanzado para agentes y automatización

El gate es una interfaz local por archivos JSON. En Windows vive en
`%LOCALAPPDATA%\SFTerm\gate`. El cliente de referencia es `scripts/gate.py` y
se ejecuta con Python, no con Bash:

```powershell
python .\scripts\gate.py ping
python .\scripts\gate.py list
python .\scripts\gate.py read '{"id":3,"lines":60}'
```

| Grupo | Operaciones |
|---|---|
| Terminal | `ping`, `list`, `spawn`, `send`, `read`, `show`, `close`, `truth` |
| Bloques | `blocks`, `block_last` |
| Historial | `conv_list`, `conv_open`, `conv_resume`, `conv_prefs` |
| Director | `show_file`, `show_diff`, `preview`, `search`, `root` |
| Navegador | `browser_open`, `goto`, `read`, `click`, `type`, `upload`, `wait`, `snap`, `pdf`, `console`, `net`, `history`, `download`, `dialog`, `mobile`, `clear_session`, `close` |
| Git | `git_state`, `git_log`, `show_commit` |
| Checkpoints | `checkpoint_save`, `checkpoint_list`, `checkpoint_diff`, `checkpoint_restore` |
| Eventos | `events` con últimas entradas, cursor o seguimiento |

`spawn` admite worktrees para agentes paralelos. `checkpoint_restore`, `close`,
envíos a terminales y acciones del navegador pueden modificar estado o causar
efectos externos. Un agente debe solicitar confirmación antes de una operación
destructiva o de publicar cambios.

La referencia completa de parámetros está al principio de `scripts/gate.py` y
en `CLAUDE.md`.

## 26. Glosario

- **CLI**: programa que se usa escribiendo comandos.
- **Shell**: intérprete como PowerShell o zsh.
- **PTY/ConPTY**: terminal virtual para programas interactivos.
- **Daemon**: proceso auxiliar que mantiene terminales vivas fuera de la UI.
- **Cwd**: carpeta de trabajo actual.
- **Rail**: columna izquierda de terminales e historial.
- **Tiling**: organización en pestañas y divisiones.
- **Harness/proveedor**: CLI que creó y puede reanudar una conversación.
- **Transcript**: archivo local con el historial de una sesión.
- **Root**: carpeta base del proyecto.
- **Diff**: comparación entre versiones de un archivo.
- **Upstream**: rama remota asociada a la rama local.
- **Checkpoint**: foto local y oculta del estado de un repositorio.
- **Gate**: canal local de automatización de SFTerm.
- **TTS/STT**: texto a voz / voz a texto.

## 27. Regla de oro

Antes de una acción importante, confirma:

1. qué terminal está enfocada;
2. qué carpeta muestra `Get-Location`;
3. qué cambios muestra `git status`.

Esa comprobación evita la mayoría de errores al trabajar con varias terminales,
repositorios y agentes a la vez.
