# SFTerm — workspace de terminales para operadores agenticos

App de escritorio macOS (Tauri 2 + Rust). Multiplexor de terminales REALES con
**tiling dinamico + pestañas por campo** (v2), rail de conversaciones, arbol de
archivos git-aware, visor universal solo-lectura y presets agenticos.

**UN SOLO MODO — terminal-first tipo Warp (purga 21 jul 2026, firmada por
Daniel: "aumento mucho la variedad, por eso la dejamos atras").** La app es
SOLO TERMINALES, agnostica de proveedor (claude, codex, aider, cualquier
CLI). El chat nativo (~6,000 lineas: ChatView/ConvList/chat.ts/historial/
fijadas/cuentas/agent.rs/chip.rs, el modo dual `app_mode`) MURIO — vive en
git (tag pre-purga: commit `242538c^`). Lo que quedo, y como se conversa:
- **LECTOR ⌃Tab / ⌘L** (`ConvReader.tsx`): la conversacion de la terminal
  enfocada con cara de chat (markdown rico, tools expandibles, ▶ escuchar
  por mensaje). VERDAD ESTRICTA: la sesion que ESA terminal corre o nada.
  Input abajo: claude vivo → directo a SU PTY; dormida → `--resume` ahi
  mismo. Esc/⌃Tab/⌘W cierran y aterrizan en su terminal.
  **Es un MODO, no una vista (22 jul):** vive DENTRO del panel de su terminal
  (no tapa la app; rail y arbol los esconde Daniel con ⌘B / ⌘⌥B) y SIGUE AL
  FOCO — moverte entre terminales lo re-apunta a la conversacion de cada una.
  **Agnostico de proveedor (22 jul):** claude se espeja con su transcript;
  cualquier otro CLI agentico, con su PANTALLA. Ver "AGENTE ≠ CLAUDE" abajo.
  **Composer completo (26 jul):** borrador blindado, adjuntos de imagen,
  posicion de lectura por conversacion y ventana de contexto real — ver
  "EL COMPOSER DEL LECTOR" abajo.
  **Escribe en vivo (28 jul):** la respuesta se VE escribirse, leida de la
  pantalla mientras el jsonl todavia no la tiene — ver "EL ADELANTO" abajo.
- **MOVERSE CON EL TECLADO (29 jul 2026, pedido de Daniel):** **⌥Tab** =
  siguiente TERMINAL (en el orden del rail, el manual incluido) · **⇧Tab** =
  siguiente PESTAÑA del campo enfocado. La logica pura vive en
  `core/cycle.ts` y el Rail IMPORTA de ahi su `sortByRail`: el orden por el
  que te mueves ES el orden que ves, imposible que driftee.
  > ⚠️ **⇧Tab tambien es del TUI de claude** (ahi cicla los modos de permiso;
  > lo dice su propio statusline). Por eso solo se intercepta **con 2 o mas
  > pestañas**: con una sola, la tecla se le deja al PTY. El interceptor de
  > xterm y el handler de window consultan lo MISMO (`App.tsx::willConsume`) —
  > si dijeran distinto la tecla se perderia en el aire, ni cambia de pestaña
  > ni llega al agente. El test que protege esto es
  > `stepIndex devuelve null con 0 o 1 elemento`.
  > ⚰️ **El VISTAZO ⌥Tab (`Peek.tsx`) MURIO** el 29 jul por decision de Daniel
  > ("no me sirve, para eso ya uso ⌃Tab"). Vive en git; su llave `cycle_pinned`
  > (y la ya difunta `pin_conversation`) se BORRAN de los configs vivos en la
  > migracion v6→v7 — un config que sigue diciendo `cycle_pinned = "alt+tab"`
  > le miente a Daniel sobre lo que hace esa tecla.
- **⌘I composer** (texto real a la terminal enfocada) · **⌘N** terminal
  nueva · **⌘⌥J** terminal CON agente (`agent_command`) · **⌘J** drawer.
- Rail = `Rail.tsx` — desde el 30 jul es UNA columna estilo Claude Desktop:
  busqueda + ACTIVAS (`TermList`, las terminales de siempre) + el HISTORIAL
  del disco (`HistRail`, ver "LA VITRINA DE HISTORIAL" abajo). **Las activas
  se REORDENAN arrastrando** (22 jul, estilo VSCode): umbral de 6px para no pelearse con el
  click, linea de acento ENTRE filas marcando el hueco, y la guia se oculta
  cuando soltar no moveria nada (sobre la fila o justo debajo). El orden vive
  en `store.railOrder` — una PISTA de orden, no la fuente de existencia: el
  rail pinta `panels` y solo consulta la lista para ordenar, asi que ids
  muertos ahi son inofensivos y una terminal nueva cae al final por id. **En
  memoria a proposito:** al reabrir, los paneles nacen con ids NUEVOS y no
  habria a que amarrar el orden (misma falta de identidad estable que mata el
  revival de sesiones — si algun dia entra el daemon dueño de los PTYs, ESE es
  el momento de persistirlo).

**Dos motores de terminal (config `appearance.renderer`):**
- `"dom"` (default) — xterm.js parsea + pinta en el webview.
- `"own"` — **MOTOR PROPIO**: el parser VT vive en Rust (`src-tauri/src/engine/`),
  el frontend solo pinta un canvas 2D. Da bloques comando+output (OSC 133) con
  exit code/duracion + re-run ↻, scrollback fuera del webview, y un modelo
  consultable por agentes via el gate. El PTY es el mismo contrato: claude/vim/
  htop corren identicos. Ver `docs/terminal-propia.md` (diseño) y el spec.
- `"webgl"` — xterm.js GPU, ROTO en WKWebView macOS 26.5 (xterm.js #5816).

**Engine (Rust, siempre activo — tee):** el reader thread del PTY alimenta el
parser vte SIEMPRE, con cualquier renderer, asi la semantica (titulos, bloques,
cwd, gate) existe en ambos modos. `grid.rs` (celdas/scrollback/regiones/wide),
`term.rs` (Perform: CSI/SGR/OSC + respuestas DSR/DA/OSC 10-11), `blocks.rs`
(comando+output), `frame.rs` (protocolo binario de damage al canvas). Shell
integration estilo VSCode: ZDOTDIR inyectado (`engine::shell_dir()`) con hooks
precmd/preexec que emiten OSC 133/633/7. `[general] shell_integration = true`.

⚠️ **ANCLA DE LECTURA — invariante del viewport (22 jul 2026).** `viewport_offset`
es relativo al FONDO VIVO, pero el fondo AVANZA con cada linea que entra. El
frontend pinta desde `topAbs = abs_base - viewport_offset` (ownterm.ts), asi que
ese numero es lo que hay que conservar: **con el viewport subido (`offset > 0`),
`scroll_up` incrementa el offset a la par de `abs_base`**, o la ventana se
DESLIZA sola sobre el contenido y el texto se te escapa hacia arriba mientras el
agente escribe (reporte de Daniel: "me quita la capacidad de leer"; en VSCode se
puede porque xterm.js ancla al contenido). Dos matices que NO se pueden perder:
`offset == 0` no se toca (auto-follow, seguir la salida es lo correcto), y si el
scrollback esta TOPADO y se desaloja por arriba el offset se queda quieto (el
contenido de arriba no crecio; si no, treparia solo). Tests:
`viewport_subido_se_ancla_al_contenido_*`, `viewport_en_el_fondo_sigue_la_salida`,
`viewport_no_trepa_cuando_el_scrollback_esta_lleno` — los tres verificados
fallando sin el fix.

**Modelo de layout (v2.3, VSCode puro):** arbol de splits. Al abrir hay UNA
terminal fullscreen. Terminal nueva = TOMA el campo enfocado completo; la
anterior queda viva en la lista de conversaciones (como la lista de terminales
de VSCode). Los splits existen SOLO si el usuario arrastra (rail o pestaña a un
borde; el cuerpo resuelve al borde mas cercano, nunca "center"). Abrir archivo =
split automatico a la derecha; los siguientes archivos son pestañas del mismo
campo viewer. Un campo sin pestañas colapsa y sus vecinos se expanden.

**Pestañas PREVIEW estilo VSCode (23 jul 2026):** un clic normal en el arbol
abre el archivo como pestaña PREVIEW (italica): una sola por leaf, se
REEMPLAZA sola en el mismo indice si clickeas otro archivo en vez de
acumularse (`TabItem.preview`, `insertOrReplacePreview` en actions.ts). Se
promueve a permanente con doble clic en la fila del arbol o en la pestaña
(`promoteFileTab`/`promoteFileByPath`), o arrastrando la pestaña para
posicionarla (la promocion ocurre al CRUZAR el umbral de drag en
`startPointerDrag`, no al soltar — si el drag termina en no-op igual queda
fijada, correcto porque ya la moviste con la mano). **`openFileTab` sin
`opts.preview` sigue PERMANENTE por default** — por eso ⌘P, el gate
(`show_file`/`show_diff`), `openChanges` y los agentes NO cambiaron: solo el
clic del arbol pasa `{ preview: true }`. Una apertura permanente promueve un
preview existente del mismo path; un preview nuevo jamas degrada uno ya
permanente.

**Raiz visible ligada a la terminal (3 ago 2026):** la vista Archivos usa el
`cwd` vivo de la terminal enfocada (OSC 7/metricas) y cambia al hacer `cd`.
Si no hay terminal enfocada, cae a `treeRoot`. La vista Source Control conserva
`treeRoot` como raiz Git independiente; cambiar de carpeta en una shell no
reapunta el repositorio ni su historial.

**Multi-seleccion + multi-drag del arbol (23 jul 2026):** ⌘+clic togglea un
path dentro de `store.treeSel`; ⇧+clic selecciona el rango contra
`treeAnchor` sobre la lista PLANA de filas visibles (misma recursion que el
render, para que el rango jamas driftee); Escape limpia la seleccion pero
SOLO si el foco DOM esta en el arbol (`document.activeElement`), para no
comerse el primer Escape de otro overlay. Arrastrar una fila que es parte de
una seleccion de >1 mueve TODA la seleccion (`DragSrc.paths`,
`parseDroppedPaths` en types.ts: un path por linea del payload
`text/plain`); arrastrar una fila fuera de la seleccion la colapsa a esa sola
fila. El drop resuelve por caso: sobre un leaf de archivos abre un tab por
path; sobre una terminal pega TODOS los paths citados en un solo comando;
como split, el PRIMER path arma el split y el resto entra como tabs del leaf
nuevo (si no, cada path fragmentaria su propio split). `treeSel` vive en
memoria a proposito (nunca se serializa) y se limpia al cambiar `treeRoot` o
aplicar un preset.

**ELIMINAR desde el arbol (27 jul 2026, clic derecho estilo VSCode).** El unico
gesto DESTRUCTIVO de la app, y por eso el mas acotado:
- **Papelera, jamas `rm`.** `fsx::fs_trash` usa `NSFileManager::trashItemAtURL`
  (recuperable con "Devolver" del Finder, igual que el "Move to Trash" de
  VSCode). **Cero dependencias nuevas:** objc2-foundation ya traia
  `NSFileManager` en sus features por default — no hace falta el crate `trash`
  (que ademas pide rustc 1.85 y este repo esta en 1.77).
- **Guarda dura en Rust, no en la UI** (`trash_guard`, pura y testeada): solo se
  toca lo que vive DENTRO del `treeRoot`, nunca el root mismo, nunca algo
  inexistente. El path se canonicaliza por el PADRE + nombre
  (`canon_keep_link`) — canonicalizar el item resolveria un symlink y (a)
  mandaria a la papelera el DESTINO en vez del enlace, (b) sacaria del root algo
  que si vive adentro. Un `..` que se escapa se aplana ahi mismo. Lo rechazado
  se REPORTA path por path (`{trashed, errors}`), jamas se salta en silencio.
- **El menu actua sobre lo que ves:** clic derecho sobre una fila fuera de la
  seleccion la colapsa a esa fila (mismo criterio que el drag). El modo de
  fallar caro era borrar una multi-seleccion vieja que Daniel ya no tiene a la
  vista.
- **Confirmacion React, no nativa** (`.trash-back`/`.trash-card`): los dialogos
  nativos estan PROHIBIDOS en este repo (bloquean el webview). Esc cancela /
  Enter confirma, en CAPTURA con stopPropagation como el resto de los overlays
  — si no, la Escape sigue de largo y le cierra el escalon al lector/preview/
  drawer que este debajo. `doTrash` viaja por REF para que el listener no
  se re-registre en cada cambio de estado ni quede con la version vieja.
- **Secuelas cerradas:** `actions.closeFileTabsUnder` cierra las pestañas del
  visor que apuntan al path muerto **o a cualquier cosa dentro de una carpeta
  borrada** (sin esto quedan tabs zombie con contenido cacheado, y la sesion
  los persiste); se limpia `treeSel`; se recarga el dir padre al instante (el
  flusher de FSEvents tiene 350ms de debounce) y se refresca el espejo git.
- Tests: `trash_guard_solo_deja_pasar_lo_de_adentro` (guarda, corre siempre) +
  `papelera_real_se_traga_archivo_y_carpeta` (**E2E real contra Cocoa**, marcado
  `#[ignore]` porque deja basura en la Papelera de quien lo corra:
  `cargo test papelera -- --ignored`).
- ⚠️ Deliberadamente NO existe borrado permanente (⇧⌦ de VSCode). Si algun dia
  se pide, es firma de Daniel: hoy todo gesto destructivo de esta app es
  reversible desde el Finder.

**Toggle raw/render + cluster de acciones del visor ahora vive en el TAB, no
en FileView (23 jul 2026):** `TabItem.raw` (tiling.ts) reemplaza el
`useState` local de FileView y el CustomEvent `"sfterm:toggle-md"` — el
estado sobrevive a cambiar de pestaña y a moverla entre leafs.
`actions.toggleFocusedMarkdownRaw()` (⌘⇧M) opera sobre el tab activo del leaf
enfocado; `setFileTabRaw(leafId, index, raw)` es el setter directo. La
`.fileview-bar` propia de FileView murio: los tres botones (ojo
render/fuente, diff, revelar en Finder) ahora son el cluster `.leaf-actions`
dentro de `.leaf-bar` (Tiling.tsx::renderActions), en la MISMA fila de 30px
que las pestañas (`TAB_H` sigue en 30 — la fila se dividio en `.leaf-tabs`
flex:1 scrolleable + `.leaf-actions` flex:0 fijo, no crecio de alto).
Sesiones viejas sin `preview`/`raw` en su `SerializedTab` restauran como
permanente/render (ambos campos opcionales, default false).

**EL COMPOSER DEL LECTOR (26 jul 2026) — cuatro arreglos que salieron del
mismo reporte de Daniel: "se borra el texto... perdí mi texto para siempre".**

1. **BORRADOR BLINDADO** (`core/drafts.ts` + `ConvReader.tsx`). El textarea es
   NO CONTROLADO (tipear no debe re-renderizar la conversacion), asi que el
   borrador vivia SOLO en el nodo del DOM. Al cerrar el lector, React desmonta
   ese nodo y pone la ref en null ANTES de que corra el cleanup que devolvia el
   texto al TUI — el cleanup leia la ref, encontraba null, y no devolvia nada:
   **el camino mas comun era el unico que perdia siempre.** Segunda fuga: si
   `parseTuiDraft` no entendia la pantalla, no se devolvia nada pero el cleanup
   igual hacia `el.value = ""`. Hoy: el texto se espeja en `textRef` (no depende
   del DOM), TODO borrador se guarda en `drafts` (memoria por termId + disco por
   sessionId, sobrevive ⌘R) y la copia se borra SOLO cuando se entrego de
   verdad. ⚠️ **El `sid` va por REF, jamas como dep del efecto** — la sesion
   nace y se re-descubre sola, y como dep vaciaba el textarea a media escritura.
2. **ADJUNTOS DE IMAGEN.** Cuatro gestos, UN camino: todo termina siendo una
   RUTA en el prompt (`Archivos adjuntos (leelos/analizalos):`, el formato que
   `splitAttachments` ya sabia separar). Pegar ⌘V materializa la imagen con
   `attach_save` (attach.rs) a `~/.config/sfterm/adjuntos`; Finder entra por el
   evento de Tauri (el DOM no da rutas en drops del SO); el arbol por su drag
   de `text/plain`; 📎 por un `<input type=file>` acotado a imagenes (copia
   bytes — por eso los archivos del proyecto van por arbol/Finder, que no
   copian). Por ruta y NO por base64 a proposito: ver el punto 3.
3. **IMAGENES DEL HISTORIAL + EL ESPEJO EN BLANCO.** Medido sobre las sesiones
   reales: **4,418 bloques `image`, con LINEAS DE HASTA 4 MB** de base64 inline.
   Con la ventana vieja de 1MB, un screenshot al final se tragaba el tail entero
   y el lector decia "esta sesión aún no tiene mensajes legibles". Hoy `readTail`
   **stripea los blobs en el shell** (`perl s!"data":"[A-Za-z0-9+/=]{200,}"!!`)
   y sube la ventana a 4MB: 4MB crudos → ~1.5MB de payload, 293 mensajes
   visibles contra 169. Las imagenes se piden bajo demanda con
   `transcript_image(path, uuid, index)` (lazy por IntersectionObserver, cache
   de 24). ⚠️ **INVARIANTE DE INDICE:** `attach.rs::collect_images` y
   `transcript.ts::collectImages` recorren IGUAL (content[] en orden; dentro de
   un tool_result, su content[] en orden) y **cuentan TODO bloque `image`
   aunque venga sin bytes** — el frontend numera sobre el tail ya stripeado,
   donde todas estan vacias, asi que descontarlas de un lado abriria una imagen
   distinta de la clickeada. Verificado sobre 1,453 imagenes reales de 89
   sesiones (1,172 de ellas dentro de tool_results): cero desfases.
4. **POSICION DE LECTURA + VENTANA DE CONTEXTO.** El lector "mandaba hasta
   arriba" porque el autoscroll corria UNA vez, con el contenido a medio pintar
   (markdown, fences vivos e imagenes cargan despues y estiran el documento):
   hoy un ResizeObserver re-ancla mientras sigas pegado al fondo, y la posicion
   se guarda **por terminal** como distancia AL FONDO (el tail recorta por
   arriba conforme crece la sesion, asi que medir desde el techo driftea).
   El `100%` de la barra era una tabla vieja: **1M es el DEFAULT de toda la
   generacion actual** (Fable 5, Opus 5, Opus 4.8/4.7/4.6, Sonnet 5/4.6); los
   200K son la EXCEPCION (Haiku 4.5 y 4.5-para-atras). Opus 5 caia al default
   de 200K y marcaba 100% con la sesion recien empezada. `ctxWindowFor`
   (msgs.ts) tiene la tabla + auto-correccion: si lo consumido supera la
   ventana asumida, sube de escalon antes que pintar un 100% mentiroso.
   El textarea ya no tiene tope de 200px (ni en CSS): crece al 45% del panel.

**EL ADELANTO (28 jul 2026) — la respuesta se VE escribirse.** Daniel manda un
mensaje desde el lector y el bloque en vuelo se pinta mientras se escribe, en
vez de aparecer de golpe cuando cierra. `src/core/screen.ts` (puro y testeado) +
`GhostBlock` en ConvReader.
- **Por que no bastaba acelerar el poll:** Claude Code escribe su jsonl **por
  BLOQUE DE CONTENIDO CERRADO**, no por token. Medido sobre una sonda real: el
  prompt salio 22:32:49.410 y el bloque de texto aterrizo 22:33:00.885 — ONCE
  SEGUNDOS de lector mudo con la terminal ya pintando la respuesta. La
  granularidad es de la FUENTE; bajarle el intervalo al `tail -c 4MB | perl` no
  la cambia (y lo encarece).
- **El stream vive en la PANTALLA.** El motor VT de Rust corre siempre en tee,
  asi que `engine_text` da el grid sin ANSI con cualquier renderer. Medido: el
  prefijo NUNCA se reescribe (~260 chars/s) — se puede pintar sin parpadeo.
  Poll de 200ms × 300 renglones, y SOLO mientras `turn.state === "working"`
  (grid en RAM: el poll caro sigue siendo el del transcript, que no se toco).
- ⚠️ **PANTALLA Y NO UN CANAL DE CLAUDE — restriccion que firma Daniel.** La
  pantalla es la fuente AGNOSTICA DE PROVEEDOR: el dia que Daniel abra Kimi /
  Codex / Gemini CLI, el adelanto se hereda agregando **un objeto** a
  `SCREEN_PROFILES` y el lector NO se toca. Los marcadores ⏺/⎿/❯ son UN PERFIL
  (`CLAUDE_SCREEN`), no la verdad universal; sin perfil no hay adelanto y el
  fallback sigue siendo el espejo crudo `src:"screen"` de siempre.
- **El transcript sigue siendo LA VERDAD.** El fantasma es solo el adelanto del
  bloque en vuelo y se retira SOLO cuando su linea aterriza. El relevo compara
  NORMALIZADO (minusculas, solo letras/numeros): el TUI *renderiza* el markdown
  — el jsonl trae `# El Mar Mediterráneo` y la pantalla muestra `El Mar
  Mediterráneo` — asi que comparar crudo dejaria al fantasma pegado debajo de su
  propio mensaje real. El `includes` va en la direccion SEGURA: ante la duda
  esconde (falso negativo = 1.5s de adelanto perdido; falso positivo = pintar
  dos veces un parrafo a medio escribir, que es lo prohibido).
- **Si el parser no entiende, NO PINTA NADA** (`null`): dialogo de permisos,
  pantalla de bienvenida, bloque cuyo ⏺ se salio de la ventana. Se queda como
  hoy, nunca inventa.
- ⚠️ **EL BULLET QUE LATE (el bug que costo encontrar).** El TUI **parpadea el
  ⏺ de la herramienta que esta corriendo**: la MISMA linea alterna entre
  `⏺ Bash(…)` y `  Bash(…)` varias veces por segundo. Sin glifo se lee como
  CONTINUACION, el recorrido se pasa de largo y resucita la prosa del bloque de
  arriba — que ya vivia en el transcript. El fantasma se prendia y apagaba al
  ritmo del latido. Dos cortes lo cierran, los dos hechos estructurales:
  `toolBlink` (encabezado de tool sin bullet) y `toolResult` (`⎿`), y **un
  bloque nunca puede tragarse otro**. Fixtures `tool-bullet-apagado.txt` /
  `tool-bullet-encendido.txt`: dos colas de la MISMA app con 0.25s de
  diferencia, misma conversacion, misma Bash — solo cambia el glifo.
- **El fantasma se calcula EN EL RENDER**, no dentro del poll: derivado de
  [cola, transcript] el relevo ocurre en el MISMO render en que llega el
  transcript. Dentro del efecto habria hasta 200ms pintando el parrafo dos
  veces. Y va con `MdPart`, jamas `RichText` — un fence ```html a medio escribir
  montaria y desmontaria un iframe cada 200ms.
- **Misma piel que un mensaje real** (`.chat-assistant` + `.chat-body`) para que
  el relevo no produzca flash; lo unico propio es el cursor que parpadea al
  final y `content-visibility: visible` (el default `auto` estimaria mal el alto
  de algo que crece cada 200ms y le daria tumbos al scroll).
- **La posicion de lectura no se toca:** el autoscroll sigue detras de
  `pinnedRef` — pegado al fondo el fantasma se sigue, scrolleado hacia arriba
  NO arrastra. Verificado en vivo: `scrollTop` clavado en 200 mientras el
  fantasma crecia de 476 a 3834 chars y durante el relevo.
- **Tests:** `tests/screen.test.ts` (16 casos) contra CAPTURAS REALES de la
  sonda en `tests/fixtures/pantalla-claude/`, incluido el relevo contra el
  transcript real que Claude Code escribio para esas mismas pantallas. Corren
  con `node --test` (Node 22 strippea TS solo: **cero dependencias nuevas**) y
  entraron a `npm run validate`.

**Cerrar SI cierra — un gesto por intencion (enmienda 22 jul 2026 pm, firmada
por Daniel: "cerrar no solo la pestaña o terminal con cmd+w, si no en general
esa conversacion quitarla del historial, como si presionara la x").** Deroga la
regla de la mañana ("⌘W jamas mata", v2.3): dejaba el rail llenandose de
conversaciones que Daniel creia cerradas. Hoy:
- **⌘W / ✕ de la pestaña / ✕ del rail = LO MISMO**: mata el PTY y borra la
  conversacion del rail (`actions.closePanel`). Sobre un tab de ARCHIVO, ⌘W
  cierra el archivo y no mata nada.
- **⌘D encajona** (fuera de vista, VIVA) y **⌘⇧D la trae de vuelta** — ese es
  el cierre suave, y por eso nada se perdio al endurecer ⌘W.
- **Escalon de seguridad:** con el lector abierto, el primer ⌘W cierra el
  lector y no toca la terminal; recien el segundo cierra la conversacion.
- **Aterriza el foco:** al cerrar la enfocada, `closePanel` enfoca la vecina
  (tab activo del leaf, o el primer leaf con terminal). Sin esto el teclado
  quedaba huerfano y el lector apuntando a nada — pasaba desapercibido cuando
  cerrar era solo un ✕ de raton, no el camino normal.
- ⚠️ **No hay revival** (murio el 21 jul pm): cerrar es irreversible. Es el
  precio que Daniel acepto a cambio de un rail que dice la verdad.

Shell que muere solo = conversacion que se cierra sola
(sin cascarones "exited"). Sin puntitos de estado: la terminal misma muestra si
escribe. El label usa el titulo OSC 0/2 (Claude Code emite ahi su RESUMEN de la
conversacion; el default ruidoso de zsh user@host se filtra).

**Regla de diseño AI-FIRST:** la UI es espejo, no cabina. Cero botones de accion
de trabajo (git/build/deploy/edicion) — eso se hace hablando con el agente en la
terminal. La unica settings UI es el panel de Configuracion (⚙ del header / ⌘,),
que escribe en el mismo config.toml.

**AGENTE ≠ CLAUDE — el lector es agnostico de proveedor (22 jul 2026, pedido
de Daniel: "el condicional deberia permitirme trabajar con otros clis
agenticos, quiza no mostrando el modelo pero si la respuesta y la input bar").**
La app siempre se declaro agnostica; el lector no lo era (candado `/claude/i`).
- **Puerta unica: `actions.openReaderFor(id)`.** Abrir (⌃Tab/⌘L) y re-apuntar
  (seguir al foco) pasan por ahi, asi las condiciones no driftean. Devuelve
  false si la terminal no califica y el que llama decide (⌃Tab no abre; el
  lector abierto se retira).
- **Candado: `core/agents.ts`.** `[general] agent_procs` (lista en config.toml,
  con fallback en codigo — los configs viejos NO necesitan migracion) se
  matchea en minusculas contra el nombre del proceso **Y el titulo OSC**. El
  titulo es obligatorio porque `fgName` no basta: Kimi Code corre bajo un
  interprete y `resolve_fg_name` devuelve **"Python"** (verificado en vivo por
  el gate: `{"title":"Kimi Code","proc":"Python"}`). Un SHELL PELADO no abre
  el lector jamas, diga lo que diga su titulo — ese candado es lo primero que
  se evalua.
- **Dos fuentes, una cara:**
  - `src:"transcript"` — Claude Code: mensajes, tools, modelo, ctx% (abajo).
  - `src:"screen"` — cualquier otro: la PANTALLA de la terminal via
    `engine_text(id, 2000)`, poll 1.5s, monoespaciada (es salida de terminal,
    la serif editorial la rompe). Sin modelo ni ctx porque no hay de donde
    sacarlos honestamente — el `ComposerBar` ya omite el segmento sin dato.
    Funciona con AMBOS renderers: el engine parsea VT siempre (el tee).
  - Escribir es igual en las dos: paste + `\r` al PTY dueño.
- El **borrador taller→lector** (`parseTuiDraft`) queda acotado a claude: ese
  parser conoce SU prompt "❯ ".
- ⏳ **Pendiente (Nivel 2, no construido):** un adapter de transcript por CLI.
  Kimi ya escribe uno muy mirroreable — `~/.kimi/sessions/<md5(cwd)>/<uuid>/
  context.jsonl` (md5 del cwd VERIFICADO), roles user/assistant/tool y un
  `_usage.token_count` que daria hasta el chip de contexto; arruga: el
  `content` del assistant es un repr de lista de **Python** (comillas
  simples), no JSON.

**EL LECTOR (la conversacion en la era terminal-first):**
- La sesion en disco (`~/.claude/projects/<slug>/<id>.jsonl`) es la VERDAD:
  el claude de la terminal la escribe; el lector la ESPEJA
  (`transcript.ts`: tail 1MB + parse poll 1.5s). Escribir SIEMPRE pasa por
  la terminal dueña (PTY vivo, o `--resume <sid> 'texto'` ahi mismo) — una
  pluma por cuaderno, cero bifurcacion.
- **BORRADOR COMPARTIDO taller ⇄ lector (bidireccional, 22 jul 2026).**
  INVARIANTE: **un solo dueño del borrador a la vez**, nunca en los dos lados.
  - abrir → el texto tecleado en el TUI se ADOPTA al composer y el TUI se
    limpia (End+kill) · cerrar → el composer vuelve al TUI **sin Enter** ·
    cambiar de terminal → se devuelve a la que dejas y se adopta el de la que
    llegas (el cleanup corre con el `termId` viejo) · enviar → lo consume.
  - El candado es `ownsDraftRef`: solo se escribe de vuelta al TUI cuando
    SABEMOS que quedo vacio (lo limpiamos nosotros, o el parser vio la caja
    vacia). Si el parser no entendio la pantalla, el TUI conserva su texto y
    no le escribimos encima — **jamas se concatenan dos borradores**.
  - El cleanup VACIA el textarea: es el mismo nodo DOM al cambiar de terminal,
    y si no, el borrador anterior se queda pintado Y bloquea la adopcion del
    nuevo (`if (el.value) return`).
  - Parser `parseTuiDraft` (ConvReader.tsx) → `string` (borrador) · `""` (caja
    vacia: nada que adoptar pero es nuestro) · `null` (no entendido: NO tocar).
    Anclado a la estructura REAL de la caja de claude, verificada con el gate
    `read` el 22 jul: regla `─────` arriba, `❯ texto` en col 0, continuaciones
    con sangria colgante de 2 espacios, regla `─────` de cierre, y recien
    despues el statusline. **Recolectar hasta el cierre es determinista.**
    ⚠️ La v1 abandonaba el borrador ENTERO en cuanto ocupaba dos renglones
    ("multi-linea: ambiguo con el wrap") — el bug que reporto Daniel. Y el
    espacio tras `❯` es OPCIONAL a proposito: reconocer la caja vacia evita
    que el scan siga hacia arriba y adopte un `❯ …` viejo del scrollback.
    Filtra placeholder 'Try "…"' y menus de opciones. 9 casos verificados
    contra pantalla real, incluida la captura del reporte.
  - CLIs sin parser de su TUI (kimi, codex…): no se adopta nada, pero el
    composer arranca vacio y lo que escribas ahi SI viaja a su terminal.
- **⌘⌥S** = panel de atajos (censo en `core/keybinds.ts`; "/" en latam es
  shift+7, por eso NO es ⌘/). Todos remapeables en config [keys].
- **Sashes estilo VSCode** (`PaneResizer.tsx`): rail y arbol; doble click =
  restaurar; anchos en localStorage (estado de layout, NO config.toml).
- **Nervio en la UI:** `needs_attention` (quiet del engine + hot de metrics)
  llega via `engine://evt` kind=`attention` → `Attention "wait"` (dot
  amarillo pulsante).
- **Reglas de reveal (reescritas 22 jul con el lector-MODO):** la linea
  divisoria es *cambiar de terminal* vs *pedir otra cosa*.
  - **NO revelan — el lector SIGUE y se re-apunta:** `showTerm` (click en el
    rail, gate `show`), `restoreLastDocked` (⌘⇧D), ⌘⌥ flechas, click en un
    panel o en una pestaña. ⚠️ `showTerm` tenia un `showChat(false)` ("mostrar
    una terminal = quererla VER") que era correcto cuando el lector tapaba la
    pantalla entera y es UN BUG con el lector-modo: cerraba el lector al
    cambiar de terminal (reportado por Daniel). NO reintroducirlo.
    Si la terminal destino no es un agente, el efecto de seguimiento retira el
    lector solo — el taller aparece cuando de verdad corresponde.
  - **SI revelan el taller:** abrir ARCHIVO (⌘P, arbol, chip "ver diff", gate
    show_file/show_diff), `openChanges`, y crear algo nuevo (⌘⌥J
    `newConversation`, `newTerminal`) — son gestos de "llevame al taller",
    no de cambiar de conversacion.
  - Preview/busqueda/paleta/finder flotan ENCIMA (overlay-back z-90 > lector
    z-80). El drawer ⌘J tambien (pool z-86).
- **Guard de foco:** `manager.focus` NO roba el foco DOM con el lector
  abierto (sin esto se enfocaria un xterm invisible debajo del overlay). Sigue
  siendo lo correcto con el lector-modo: el teclado es del input del lector, y
  el store `focused` SI se actualiza — que es lo que dispara el seguimiento.
- El invariante NO se toco: el lector es un overlay sobre el taller;
  `#term-pool` vive fuera de React y ningun PTY se re-monta.

**LIMPIEZA PREMIUM (pedido de Daniel, 17 jul — "los emojis se sienten
baratos, la UI no es simetrica ni se ve cara"):** murieron el boton de mic
(dictado = SFlow del sistema), los chips del header (cwd/local/sesion viva),
el preset-chip y hint del titlebar, y TODOS los marcadores de tipo ✦/❯_ y
badges (local/terminal/⚡) de ambos rails — conversaciones y terminales son
lo mismo, no se etiquetan. Simetria: input + enviar + statusline alineados a
la MISMA columna centrada de los mensajes (46rem, padding dinamico con max()).
⌘⌥B (`toggle_rail`) esconde el rail en AMBAS superficies (un solo concepto).

**DRAWER ⌘J (17 jul, estilo panel de VSCode):** `new_terminal` (⌘J) quedo
REPURPOSADO — abre/cierra una terminal rapida que SUBE desde abajo, en
CUALQUIER superficie. Mecanica: la terminal del drawer NACE en un pool propio
`#term-pool-drawer` (z-86, sobre el chat z-80; el pool normal es z-3 y el
chat lo tapa — por eso el segundo pool, y sin reparent = cero riesgo de
canvas). `spawnPanel {at:"drawer"}` no toca tiling ni dock; `Drawer.tsx`
ancla con el MISMO patron de Tiling (placeholder + ResizeObserver +
manager.place). Tiling EXCLUYE las terminales del drawer de su loop de hide
(si no, se pelean por el slot); ambos rails las excluyen de sus listas; el
guard de foco permite foco DOM al drawer sobre el chat. Ocultar NO mata nada
(como VSCode); Esc lo cierra primero (escalon: menu / → drawer → espejo →
visor → taller). Terminal en tiling: rail `+` o ⌘⌥J.
**MULTI-TERMINAL (17 jul):** el drawer lleva TABS como VSCode — `drawerTerms[]`
(orden) + `drawerTermId` (la activa, la unica visible en el host). `+` en la
cabecera = `newDrawerTerm()`; click en tab = `setDrawerActive` (el switch lo
hace el cleanup del useEffect del Drawer: hide vieja → place nueva); ✕ de tab
= `closePanel`, que PODA el estado del drawer (activa a la vecina; sin tabs →
cierra el drawer). Una shell que muere sola pasa por el mismo camino (no hay
tabs zombie). Los ids NO se persisten: al reabrir la app el drawer nace vacio.

**CONVERSACIONES INMORTALES — el daemon `sfterm-ptyd` INTEGRADO (30 jul 2026).**
El pedido de Daniel del 27 jul ("yo lo unico que quiero es que pueda conservar
las conversaciones, en cada rebuild") quedo CUMPLIDO E2E: los PTYs viven en el
daemon (mismo binario con `--ptyd`, setsid, sobrevive a rebuild/cierre/crash de
la app) y la app es un CLIENTE que se conecta, pinta y escribe.
- **Piezas:** `ptyd/` (server con ring de replay 4MiB + proto de marcos
  binarios + client) · `ptyd_bridge.rs` (la mitad app: UN drenador que reparte
  DATA → engine tee + Channel del frontend; `DaemonWriter` adapta `Write` →
  socket para que pty_write/composer/kickoff/respuestas-del-engine no cambien).
  `pty.rs` gano `PtyBackend::{Local,Daemon}` — TODOS los contratos (resize,
  kill, fg pgids batcheados, poll_exits via Evt::Exit) son backend-aware.
- **Boot = RECONCILIACION, no arrasar:** `pty_daemon_info` → session.json trae
  `termId` por tab/dock → lo VIVO se RE-ADOPTA (`pty_adopt`: engine con el
  tamaño real del PTY, replay repinta, MISMO proceso — verificado E2E: mismo
  PID de claude antes/despues de un SIGKILL a la app) → sobrantes al dock —
  una conversacion viva jamas queda invisible. Sin daemon → mundo clasico.
- **⌘R (reload del webview) usa `pty_detach_all`**, no kill: el proceso de la
  app sigue vivo con sesiones/sinks de la pagina anterior (Channels muertos) —
  sin soltarlas, pty_adopt decia "ya adoptada" y el boot caia a spawns frescos
  (cazado E2E). Detach suelta sin matar; el boot nuevo re-adopta mismos ids.
- **⌘W sigue siendo CERRAR de verdad** — y el daemon mata el ARBOL completo
  (`kill_term_tree`: SIGHUP al fg pgrp + shell, gracia 1.5s, SIGKILL de
  respaldo). Matar solo al shell dejaba al claude nieto de fantasma ~1 min (el
  slave del PTY vivo = master sin EOF; cazado E2E, test `kill_mata_el_arbol_completo`).
- **Config:** `[general] daemon = true` (default; false o SFTERM_NO_DAEMON=1 =
  modo clasico). **Banco de pruebas:** `SFTERM_CONFIG_DIR` redirige TODO
  (config/gate/session/socket/log, single-instance se omite) — una instancia
  dev aislada jamas roza la real. Tests E2E: `cargo test ptyd -- --ignored
  --test-threads=1` (supervivencia, kill-arbol, batch, drenado).
- ⚠️ El revival por `--resume` automatico SIGUE MUERTO (21 jul): esto NO es
  eso — el proceso ES el mismo, no una imitacion. Resumir una CERRADA es
  siempre gesto explicito (vitrina/lector/gate).

**LA VITRINA DE HISTORIAL — el rail estilo Claude Desktop (30 jul 2026).**
El rail es UNA columna: busqueda arriba (filtra activas + historial, sin
acentos), ACTIVAS (las de siempre: titulo OSC, drag para reordenar, ✕), y el
HISTORIAL COMPLETO del disco agrupado por dia (Fijadas · Hoy · Ayer · fechas ·
"Mostrar mas"). Purga del 21 jul RESPETADA: cero chat nativo — la vitrina
LISTA, el lector LEE, la terminal ESCRIBE.
- **Iteracion 2 (30 jul pm, pedida por Daniel):** TODAS las secciones
  colapsan con su header (chevron animado, colapso suave por grid-rows
  1fr→0fr, contador al cerrar; persistido en localStorage
  `sfterm-hist-collapsed`) — y la BUSQUEDA expande todo (colapsado +
  resultados ocultos = lista mentirosa). Popover de FILTROS (boton junto al
  buscador, punto de acento cuando hay filtro activo): agrupar por
  Fecha/Proyecto/Ninguno · ordenar por Reciente/Titulo · filtro por proyecto
  (top por frecuencia); prefs en `sfterm-hist-prefs`, gate `conv_prefs` las
  lee/escribe hablando (evento `sfterm:hist-prefs` sincroniza el componente
  vivo). ⚠️ Gotchas de la piel LEGACY `.histmenu` (pre-purga, sigue en el
  CSS): gana la cascada a bloques anteriores (overrides al FINAL del archivo)
  y su `.histmenu-check` trae `margin-left:auto` (el check nuevo se llama
  `.hist-popcheck`). En histgroup, el agrupado es por LLAVE via Map: un grupo
  jamas se parte en dos secciones al ordenar por titulo.
- **Indexador Rust** (`hist.rs::sessions_index`): `[history] claude_roots`
  (default `~/.claude` + `~/.claude-bro`; el config_dir viaja en la card para
  resumir con la cuenta correcta), stat-sweep + lecturas acotadas (cabeza
  256KB, cola 64KB) + cache por (mtime,size) — 121 conversaciones reales en
  ~1.6s frio / ~6ms caliente. MISMOS filtros que la verdad del piso:
  maquinaria (`entrypoint:"sdk-"` — cubre sdk-cli Y sdk-ts, el knowledge
  compiler se colaba) y cascarones, fuera.
- **Frontend:** `histgroup.ts` (agrupacion PURA, cero imports — tests/hist.test.ts)
  · `hist.ts` (carga cache 30s + fijadas en localStorage `sfterm-conv-pinned`)
  · `providers.ts` (ADAPTADOR por CLI: list + resumeCommand + atPrompt; Claude
  completo hoy, la pantalla cubre a los demas — Kimi seria un objeto mas) ·
  `Rail.tsx::HistRail`. Las VIVAS se excluyen del historial (sid real via
  term_session): una lista que se repite se contradice.
- **Click en historica = ESPEJO**: el lector sin terminal dueña (fullscreen,
  `chatMirror.termId` undefined, `focused: null` al abrir — misma semantica
  que un tab de archivo: seguir-al-foco no lo roba al abrir, y enfocar una
  terminal despues re-apunta/retira como siempre). Solo lectura + barra de
  CONTINUAR: escribir ahi = terminal nueva con `--resume` en su cwd y su
  cuenta + entrega verificada del texto. `continueHist` espera el PROMPT
  VACIO del TUI (`atPrompt`: linea que es exactamente "❯") antes de entregar —
  el resume imprime la conversacion vieja a rafagas y el quiet-gate generico
  disparaba a media carga (cazado E2E). Y `sendWhenReady` solo VERIFICA la
  sonda si la pantalla no la contenia YA (una resumida trae los prompts
  viejos: el "aparecio" era falso positivo).
- **Gate:** `conv_list {n?, q?, fresh?}` · `conv_open {sid}` (director: pinta
  el espejo; sid acepta prefijo) · `conv_resume {sid, text?}` — AI-first: todo
  lo clickeable, pedible hablando.
- Gap residual declarado (critico A/B, 4 rondas): shells ociosas identicas en
  ACTIVAS son indistinguibles (etiquetado pre-existente del rail; idea: ultimo
  comando del engine como subtitulo) · grupos de fecha no colapsables (el
  referente colapsa; un critico lo pidio y otro lo llamo fortaleza — flat gano).

*(El espacio bro murio con el chat nativo — purga 21 jul. Fijadas y busqueda
renacieron el 30 jul DENTRO de la vitrina terminal-first de arriba.)*

**VERDAD DEL PISO: `term_session` — TRES verdades, cero rifa.** La sesion
que una terminal "representa" jamas se adivina por carpeta+recencia: el
comando Rust `pty::term_session(id)` resuelve el sid REAL del claude que
corre DENTRO del PTY (tcgetpgrp → proceso claude → su cwd + CLAUDE_CONFIG_DIR
del environ) con tres verdades **en orden de FUERZA, no de antiguedad
(reordenado 27 jul 2026)**:
1. **Argv** — un `claude --resume <sid>` puede NO bifurcar (sigue escribiendo
   el jsonl ORIGINAL, nacido horas antes): se lee `--resume <uuid>` del argv.
   Si SI bifurco, un jsonl valido nacido en la ventana de arranque de ese
   mismo proceso le gana (esa es la bifurcacion).
2. **Titulo** — el titulo OSC del CLI ("<glifo> <resumen>") es el MISMO
   aiTitle del jsonl → igualdad exacta contra la cola de los 40 transcripts
   mas recientes (el engine tee ya guarda el titulo por pty). Los titulos
   GENERICOS no cuentan (<8 chars, "Claude Code", el nombre de la carpeta):
   con uno de esos la igualdad deja de ser verdad y se vuelve rifa.
3. **Nacimiento** — el jsonl cuyo birthtime calza con el arranque del
   proceso ([start-5s, start+120s]; mtime no sirve — el de una sesion ajena
   viva siempre es "ahora"). Es PROXIMIDAD, no verdad: ultimo recurso.
Sesiones de MAQUINARIA se SALTAN (`is_machinery_session`: crons 🤖, nervio,
auto-resumen y todo lo que nace con `entrypoint:"sdk-cli"` — la TUI sella
`"cli"`), y tambien los CASCARONES (`has_real_messages`: un jsonl sin un solo
mensaje user/assistant no es la conversacion de nadie).
Sin verdad → None honesto ("sin conversacion"), nunca otra conversacion.
`how` dice de CUAL de las tres salio (visible en `gate.py truth {id}`).

> ⚠️ **Por que el orden cambio (bug 27 jul, "las conversaciones viejas abren
> en blanco").** Mandaba el NACIMIENTO y las dos verdades duras eran su
> fallback. En este piso nacen sesiones de maquinaria cada dos minutos en el
> mismo slug: un jsonl de 9 lineas (bridge-session + hooks, cero mensajes)
> nacio dentro de la ventana de TRES paneles a la vez y los tres resolvieron a
> el — el lector espejaba fielmente la nada y decia "esta sesion aun no tiene
> mensajes legibles" sobre conversaciones enteras. Ademas el caso que mas duele
> — la conversacion RESUMIDA — es justo donde la ventana NUNCA puede acertar
> (su jsonl nacio horas antes) y donde el titulo SIEMPRE acierta.
Consumidores: lector ⌃Tab, re-descubrimiento post-despertar
del lector, y el verbo de gate `truth {id}`.
- **Devuelve `{sid, path, config_dir}` (21 jul pm):** la RUTA del jsonl la
  computa RUST respetando el CLAUDE_CONFIG_DIR del proceso — el frontend
  JAMAS la reconstruye con `~/.claude` hardcodeado (asi bro-claude, que vive
  en `~/.claude-bro`, funciona en lector/persistencia; bug 21 jul).
  `config_dir` viaja a `chatMirror.cfg`: el resume dormido del lector
  prefija `CLAUDE_CONFIG_DIR='...'`.
- **El lector abre con 0 mensajes (21 jul pm):** el candado anti-caos es NO
  abrir sobre SHELLS; con claude vivo (cualquier cuenta) abre SIEMPRE — sin
  verdad aun (jsonl por nacer), `chatMirror.path=null` = "conversacion nueva"
  y un watcher (1.5s) engancha el espejo cuando la sesion nace.
- **Enviar desde el lector = texto y Enter SEPARADOS (21 jul pm):** el TUI
  de claude detecta rafagas como PASTE y un `\r` dentro de la rafaga se
  vuelve newline (el mensaje quedaba tecleado sin enviar). `manager.paste`
  (bracketed) + `\r` a los 160ms = Enter real.

*(Espacio bro / cuentas, built-ins con UI nativa (/usage, /model, /effort),
el picker de modelos externos del composer y la vista chip murieron con el
chat nativo — purga 21 jul. Para modelos externos hoy: corre el CLI con env
OpenRouter en su terminal (`ANTHROPIC_BASE_URL=https://openrouter.ai/api`
sin `/v1` + `ANTHROPIC_AUTH_TOKEN`); la vista chip completa vive en la rama
`goal/vista-chip`.)*

**Tema `arbrain` DEFAULT** (paleta del dashboard: zinc #09090b + morado
#A968F7/#8C27F1 + oro; `[themes.arbrain]` en config.rs, backfilleado a
configs vivos). El pool flotante (drawer) jamas entra al tiling (showTerm lo
rutea; los rails lo excluyen).
⌘⌥J (`new_conversation`) es POR SUPERFICIE: chat abierto = conversacion de
chat, taller = agente en terminal (cwd explicito siempre terminal). ⌃Tab
(`taller`) = cambiar de vista con una mano. **Fijadas:** clic derecho →
Fijar en cualquier fila (convs: `pinned` del indice; sesiones/terminales:
`histMeta.pinned`) = grupo "Fijadas" siempre arriba + estrella sutil
(.conv-pin). El TTS del chat NO lee el bloque "Sources:/Fuentes:" (ruido).

**COMPOSER CODEX + @MENCIONES + TITLEBAR VIVO (18 jul, noche):** (1) El
composer del chat es una TARJETA en columna estilo Codex: adjuntos + textarea
+ `composer-bar` (fila de controles DENTRO: boton @ y rama a la izquierda;
ctx/modelo/effort/bypass y el orbe de enviar a la derecha). El ex-statusline
(ChatStatusBar) es ahora `ComposerBar` — mismos datos del stream, mismos
pickers con argumento y el mismo panel /usage; el strip suelto y su CSS
murieron, el inputbar flota transparente. (2) **@menciones estilo
Codex/Cursor**: teclear `@` (o el boton @) abre un menu fuzzy de
archivos+carpetas del proyecto de la conv — el indice es EL MISMO `fs_index`
de ⌘P (archivos relativos, gitignore-aware, cache 30s) y las carpetas se
DERIVAN de los paths en el cliente (cero Rust nuevo); elegir carpeta inserta
`@ruta/` y deja el menu abierto para bajar niveles, archivo inserta `@ruta `
y cierra; el texto viaja como `@ruta` (el claude del cuerpo entiende
@menciones nativamente). Deteccion RELATIVA AL CARET (`MENTION_RE`), no
anclada al inicio como `/`. (3) El titlebar muestra el TITULO VIVO de la
conversacion activa (chat) o de la terminal enfocada (taller) en vez del
logo "SF Term" (`TitlebarTitle` en App.tsx; sigue siendo drag-region).
Tambien murio un bug: `.chat-sendbtn.stop` tenia un background ROJO
duplicado que le ganaba al diseño (el detener es circulo del color del
texto, calmado).


**FIABILIDAD DEL BINDING + FEED COMPLETO (19 jul, madrugada):** el bug "la
terminal respondio y el chat quedo mudo" (convs 23/28) era el discovery de
sesion MUERTO sin recuperacion (relaunch de la app durante la ventana de 40s
= conv huerfana para siempre). Fixes: (1) **healSession** — sanador
deterministico por CONTENIDO (jsonl del cwd no reclamado que contiene el
primer prompt de la conv), corre al BOOT para toda conv local con turnos sin
sesion y como fallback del discovery antes del error de 40s; (2) cuerpo vivo
recibe el prompt SIEMPRE por bracketed paste (teclear "@..." crudo abria el
fuzzy-picker del TUI y el \r seleccionaba en vez de enviar); (3) el feed
transcript pinta el "PENSANDO" (bloques thinking como chip expandible estilo
tool call) y separa los adjuntos del prompt ("Archivos adjuntos…") en
thumbnails/chips; (4) los adjuntos son CLICKEABLES en todo el chat (click =
abrir en el visor); (5) @menu: Tab BAJA niveles en carpetas, ENTER ACEPTA lo
seleccionado y cierra (tambien carpetas).

**FIABILIDAD DEL SPAWN (18 jul, cazado E2E por el gate):** el comando inicial
del pane ya NO se teclea a los 300ms ciegos — pty.rs espera el PRIMER prompt
real (OSC 133;A del zshrc inyectado, flag `blocks.ever_prompt`; fallback 6s)
porque un zshrc pesado (p10k) se tragaba el comando y el cuerpo quedaba en
zsh pelado (conversaciones mudas). Y `sendWhenReady` es ENTREGA VERIFICADA:
pega, comprueba que el texto aparece en pantalla (readTail), y solo entonces
manda Enter; si no aparece limpia el input (ctrl+u) y reintenta (3x) — un
paste al vacio ya no pierde turnos.

**PULSO DEL TURNO:** `TypingLine` en el feed del lector
("escribiendo… · 2m 32s · ↓ 9.7k tokens"); fuente `parseTranscript().turn`
(timestamps + usage.output_tokens por message.id, subagentes incluidos;
stop_reason tool_use abre / end_turn cierra). El tick vive en el componente,
jamas repinta los Message memoizados.

**LECCION DURA — env scrub COMPLETO (17 jul; bug "hola invisible"):** el
scrub de pty.rs quita `CLAUDE_CONFIG_DIR` y `CLAUDE_PID` ademas de
CLAUDECODE/CLAUDE_EFFORT/CLAUDE_CODE_* — sin eso, relanzar la app desde una
sesion con config-dir ajeno inyectaba ese env a todos los PTYs y el claude
escribia su sesion en OTRO projects/. El `busy` del gate NO serializa dispatches (un
send de 60s bloqueaba list/ping — gate.py "colgado").

**SLASH COMMANDS (17 jul, como la TUI del CLI):** teclear `/` al inicio del
input del chat abre el menu (filtra mientras escribes; ↑↓ navega, Tab/Enter
autocompleta `/cmd `, Esc cierra — primer escalon del Esc). Catalogo en
`src/core/commands.ts`: skills del proyecto y usuario (`.claude/skills/*/
SKILL.md`, frontmatter description) + `.claude/commands/*.md` (+1 nivel
`dir:file`) + built-ins del CLI. Descubrimiento via `shellCapture`
(zsh -lc: `setopt null_glob` OBLIGATORIO — glob sin match aborta zsh), cache
60s por cwd.

**REGLA DE ORO de los built-ins (pedido de Daniel, 17 jul: "mi intencion es
que funcione IGUAL que el CLI"): NO se reimplementan JAMAS uno por uno.** Un
built-in (`/model`, `/effort`, `/usage`, `/compact`…) se le PASA al claude
TUI que ES la conversacion (`chat.builtinTurn`: sin bubble, sin spinner) y la
app REVELA la cara de terminal — ahi esta el picker/salida NATIVA de
Anthropic; ⌃Tab o Esc regresan al chat. Asi todo comando funciona hoy y los
que agreguen mañana (pass-through total: un comando fuera del catalogo igual
corre tecleandolo). El catalogo es solo DESCUBRIMIENTO/autocomplete. Los
segmentos model/effort/ctx del statusline son BOTONES que mandan el comando
bare. Skills y commands (.claude/) siguen el turno normal (su output SI vive
en el transcript). arbrain: /model y /effort los entiende el daemon (emite
model/effort_changed → statusline); el resto viaja como turno normal a Levy.

**ETIQUETA DE DEPLOY (pedido de Daniel, 17 jul): NUNCA matar la app para
instalar.** `npm run tauri build` + ditto a /Applications con la app corriendo
esta bien (el proceso vivo conserva el binario viejo en memoria); Daniel
relanza cuando EL quiera y ahi toma el build nuevo. Matar la app a media
conversacion le rompe el flow — es exactamente lo que nos pidio no hacer.

**Composer (⌘I):** campo de texto REAL hacia la terminal enfocada — edicion con
mouse, ⌘A, dictado nativo, ⇧⏎ salto de linea, ↑/↓ historial persistente
(localStorage). Multiline viaja por bracketed paste (claude lo recibe como UN
mensaje). `src/components/Composer.tsx`.

**Kickoff de presets:** `kickoff = "<comando shell>"` en un `[[presets]]` corre
el comando (cwd = root) y manda su stdout como PRIMER prompt al primer pane
"agent" cuando esta listo (espera output + quiet), pero solo al elegir ese
preset expresamente. El boot nunca ejecuta comandos ni kickoffs: en frio abre
una shell inactiva en la raiz configurada y queda esperando input.

**Puerta de agentes (gate):** SIEMPRE activa. Levy/scripts operan la app por
archivos en `~/.config/sfterm/gate/` (cmd-*.json → res-*.json). Ops: ping,
list, spawn, send (con ready/submit), read, show, close, snap, **blocks**
(lista de comandos con exit/duracion), **block_last** (ultimo bloque CON su
output — estructura, no scrape), y los **browser_*** del navegador (abajo).
Cliente: `scripts/gate.py`. Rust: `src-tauri/src/gate.rs` · ops JS:
`src/core/gate.ts`. El harness de /tmp/sfterm-cmd.json sigue existiendo solo
para debug/E2E.

**LINKS VIVOS (28 jul 2026) — toda ruta impresa en una terminal es un link.**
Antes solo las ABSOLUTAS (`~/x`, `/Users/...`) eran clickeables; hoy tambien
las RELATIVAS (`src/core/term.ts`) y el sufijo `:linea(:col)` — click = visor
abierto SALTANDO a esa linea. Arquitectura de dos mitades:
- **La regex solo propone CANDIDATOS** (`src/core/links.ts`, compartida por
  AMBOS motores — term.ts registerLinkProvider y ownterm.ts clickLink, las dos
  superficies dicen lo mismo). Cubre multi-segmento, prefijos `~/` `./` `../`
  `/`, y `nombre.ext` suelto; excluye lo que vive dentro de una URL.
- **La VERDAD la decide Rust** (`fsx.rs::fs_resolve_token`, testeado): resuelve
  contra el **cwd VIVO de esa terminal** (OSC 7 → panels[id].cwd), recorta
  puntuacion de orilla ("ver src/x.ts."), y VERIFICA existencia — lo que no
  existe JAMAS se subraya ni responde al click. Cero falsos positivos por
  construccion; `10/20` o `example.com` simplemente no resuelven.
- Carpeta → se revela en Finder; archivo → visor (`openViewerAt` si trae
  linea). El provider de xterm es ASYNC (cb despues de resolver, cache 15s).
- ⚠️ Limite conocido: la deteccion es por FILA VISUAL — un path partido por el
  wrap de pantalla no se linkea (mismo limite que tenia la version vieja).

**NAVEGADOR DEL AGENTE (28 jul 2026, world-class 29 jul) — ojos y manos
sobre la web, en la app.** Un **WKWebView REAL top-level** (no iframe) que
vive como pestaña del tiling (`{kind:"browser"}`): github y todo sitio con
X-Frame-Options cargan normal. Rust: `src-tauri/src/browser.rs`
+ `browser_delegate.rs` · chrome: `BrowserView.tsx` · verbos: `gate.ts` ·
find: `core/findpage.ts` · historial: `core/bhistory.ts`. Como funciona:
- **UNO POR CONVERSACION (29 jul 2026, pedido de Daniel: "cada agente tiene
  el suyo propio para hacer y deshacer").** Deroga el "uno solo" de v1.
  - **La IDENTIDAD es el cimiento, no un detalle.** `pty.rs` inyecta
    `SFTERM_TERM_ID` a cada terminal; `gate.py` lo estampa como `__term` en
    CADA comando; `gate.ts::requireBrowser(a)` resuelve el navegador **de
    quien pregunta**. Sin esto habria que resolver "el primero del arbol" y
    un agente actuaria sobre la pagina de otra conversacion **creyendo que es
    la suya** — el peor modo de fallar de todo esto, porque nadie se entera.
    Por eso, si el que pregunta no tiene navegador, el verbo **falla**: jamas
    se presta el ajeno. Sin remitente (cron, script de fuera) se conserva el
    comportamiento compartido de v1.
  - **La propiedad vive en el TAB** (`owner?: number`), no en un mapa del
    store: una sola verdad, cerrar el tab se lleva la relacion, y ningun mapa
    puede quedar apuntando a un webview muerto. `owner` OPCIONAL a proposito:
    un navegador de v1 sin dueño sigue siendo reclamable (si no, quedaria
    pintado pero inalcanzable) y lo adopta el primero que lo pida.
  - **EL ALA VIVE EN SU CONVERSACION — COLAPSO DE RENDER** (29 jul 2026, la
    correccion de UX de Daniel: *"no debería verlo en principio porque debería
    estar solo únicamente en el espacio donde abrió el navegador"*). El intento
    anterior dejaba el campo SIEMPRE presente con una tarjeta de estado vacio;
    resultado: hueco muerto en TODAS las conversaciones. Muerto (`.browser-empty`
    ya no existe). Ahora:
    - Un campo cuyos tabs son TODOS navegadores de otra conversacion no recibe
      rect: `tiling.leavesOcultas(root, focused)` lo saca y `layoutRects` /
      `dividerRects` reparten su espacio entre los vivos. La terminal se queda
      con la PANTALLA ENTERA — sin tarjeta, sin hueco, sin divisor colgando.
    - El colapso es de **RENDER, no del arbol**: el tab sigue vivo, el WKWebView
      no muere y la pagina no se recarga. Volver a su conversacion restaura el
      MISMO ancho (la fraccion nunca se toco). Eso desarma el miedo que motivo
      la tarjeta: no hay nada que "reabrir" en cada ⌥Tab. Test:
      `tests/browser-colapso.test.ts` (ir-y-volver compara layouts exactos).
    - ⚠️ **Clickear el navegador NO cambia de conversacion.** `focused` decide
      que ala se pinta: si `focusLeaf` lo pusiera en null al enfocar un tab
      no-terminal (lo que hacia), el navegador **desapareceria justo al tocarlo**.
      Usarlo ES estar en su conversacion, asi que adopta el `owner` del tab.
    - **Señal en el rail** (`.chat-convglobe`): las filas de conversaciones con
      navegador propio llevan un globo. Sin el, los navegadores de las demas
      serian invisibles — el ala solo se pinta en la suya. Espejo, no boton.
  - **El dueño se VALIDA contra las conversaciones vivas de ESTA app** (cazado
    en E2E el 29 jul): `caller()` en gate.ts descarta un `__term` que aqui no
    existe (un agente corriendo en OTRA instancia de SFTerm estampa su id) y
    `openBrowser` hace lo mismo con el `owner` explicito. Honrarlo pariria un
    navegador de dueño FANTASMA: invisible para todos (su ala nunca se pinta)
    y a la vez inalcanzable por el gate.
  - **⇧Tab cicla solo lo VISIBLE** (`cycle.ts::visibleTabs`). Sin esto, una
    terminal + el navegador de otro contarian como 2 pestañas y ⇧Tab se
    tragaria la tecla que le toca al TUI de claude sin hacer nada a cambio.
  - **Perezoso y mortal:** ninguna terminal nace con navegador (un WKWebView
    es un proceso completo), y ⌘W se lleva el suyo — un huerfano invisible
    comiendo RAM, ademas reclamable por otro, es justo lo que esto evita.
  - Lo que se PIERDE respecto de v1, dicho claro: ya no es cierto que lo que
    el agente navega sea lo que Daniel contempla. Un agente puede trabajar en
    una ventana que nadie mira — por eso el globo del rail (arriba) dice al
    menos DONDE estan.
- **VALVULA DE UNA VIA (la regla de oro)**: la PAGINA jamas gana un canal
  hacia la app (cero IPC de Tauri; `javascript:`/`data:` rechazados —
  testeado). Daniel y el agente SI tienen el puente entero: `file://` y rutas
  absolutas navegan (loadFileURL con acceso de lectura SOLO al folder del
  archivo), descargas a ~/Downloads, historial, cuerpos de red. Esa
  direccionalidad es el moat vs Atlas/Comet (prompt injection imparcheable
  de ellos: su agente vive DENTRO del browser; el nuestro lee por pull).
- **OMNIBOX** (`normalize_url`, testeado): dominio pelado → https; texto sin
  pinta de host → busqueda Google; `/ruta/absoluta` → file://.
- **UA de Safari real** siempre (Google login ya no bloquea); `browser_mobile`
  cambia a UA iPhone + viewport ~390px centrado (Tiling lo angosta via
  `store.browserUx`).
- **Delegates (browser_delegate.rs, define_class objc2)**: target=_blank /
  window.open → navegan EN LA MISMA VISTA; alert/confirm/prompt → cola que el
  chrome pinta como strip IN-APP (dialogos nativos prohibidos; el JS de la
  pagina espera la respuesta — semantica fiel); respuestas no-mostrables y
  anchors download → WKDownload a ~/Downloads (nombre deduplicado, toast con
  "Revelar"). ⚠️ WKWebView guarda delegates en WEAK: `DELEGATES` los retiene.
- **Threading**: WKWebView es main-thread-only; cada comando despacha con
  `run_on_main_thread` y espera por canal en el pool blocking (jamas bloquear
  el main thread esperandose a si mismo). Views en un thread_local.
- **Posicionamiento = patron term-pool**: el efecto imperativo de Tiling.tsx
  llama `browser_place` con el rect del leaf (menos TAB_H y el chrome de 34px
  — `BROWSER_CHROME_H` debe calzar con `.browser-chrome` del CSS) MENOS
  `browserUx.extraH` (strips de dialogo/find/descarga: 34/34/30px). La Y se
  voltea a bottom-left de AppKit y la escala se deriva de window.innerWidth
  (zoom-safe). ⚠️ El webview NATIVO siempre pinta ENCIMA del DOM: con
  cualquier overlay abierto (paleta, lector, drawer, search, settings,
  shortcuts, finder, preview) o un drag en curso, Tiling lo ESCONDE — findbar
  y composer quedan visibles a proposito (chicos y frecuentes).
- **ATAJOS SAFARI dentro de la pagina** (⌘L url · ⌘R recargar · ⌘F buscar ·
  ⌘[/⌘] atras/adelante · ⌘+/−/0 zoom): los captura el HOOK del documento
  (la app fisicamente no ve esas teclas: el webview nativo se las come) y el
  chrome los drena del ring `window.__sfKeys` en su poll de 500ms. En la UI
  de la app siguen mandando los bindings de SFTerm (cero conflicto).
- **EL TECLADO ES DE DANIEL, NO DE LA PAGINA (30 jul 2026 — el bug del
  omnibox).** Tres capas, cazadas el mismo dia:
  1. `SfWebView` (browser.rs): subclase del WKWebView cuyo
     `acceptsFirstResponder` solo dice SI durante un CLICK real del mouse
     (NSApp.currentEvent). Una pagina que llama `focus()` (google.com al
     cargar) ya NO puede robarse el first responder a media escritura — el
     mismo contrato de Safari. Antes: el omnibox perdia el foco, el poll le
     "regresaba" la url vieja y las teclas de Daniel caian DENTRO del sitio
     (asi nacio la busqueda fantasma de "tube").
  2. Omnibox con `dirty` (BrowserView): lo tecleado es sagrado — el poll de
     1s solo pinta la url de la pagina cuando NO esta editando NI hay texto
     suyo sin enviar. Enter navega, Esc suelta, y una navegacion real solo
     gana si el ya no esta tecleando.
  3. `zoomSmart` (actions.ts): ⌘+/−/0 en la app zoomean LA PAGINA si el campo
     enfocado muestra el navegador, y la app si no. `autofit.step` parte del
     factor vigente (manual y automatico ya no pelean) y el hook de la pagina
     acepta ⌘⇧+ (en teclado US el "+" ES shift+=).
- **Chrome (30 jul):** el "+" de pestaña nueva vive A LA DERECHA de las
  pestañas del campo (`.tab-plus` en Tiling.renderBar), como en cualquier
  navegador; el boton de captura murio (Daniel las toma a mano; el verbo
  `browser_snap` del gate sigue intacto). Pestaña nueva en blanco enfoca el
  omnibox (solo si Daniel no estaba tecleando en otro lado). El MODO SEÑALAR
  (⊹) ya no es silencioso: strip visible "tu proximo click marca el elemento
  y NO le llega a la pagina" + boton Cancelar (`pick.cancelPick`) — antes un
  pick armado se comia el click y parecia "clickeo y no se abre".
- **⌘F del navegador** = CSS Custom Highlight API (cero mutacion del DOM —
  no rompe apps React); mismo motor que el verbo `browser_find`.
- **ACTIONABILITY (29 jul) — la razon de que un clic no mienta.** `core/locator.ts`
  (+ `locator-js.ts`, la fuente inyectada, separada para poder parsearla en un
  test). Antes de tocar nada se exige: PRESENTE · VISIBLE · HABILITADO ·
  QUIETO · ALCANZABLE (hit test en el centro). Se reintenta hasta el techo y al
  fallar se dice POR QUE ("esta tapado por `<div.cookie>`"), nunca un generico.
  - Cinco formas de señalar: `{text}` · `{selector}` · **`{role, name}`** ·
    `{placeholder}` · `{label}`. El semantico sobrevive rediseños; un selector
    CSS se rompe con un cambio de clase.
  - ⚠️ **QUIETO es best-effort, no garantia** (medido E2E): con la ventana
    tapada macOS ralentiza las animaciones y dos sondeos ven la misma caja de
    algo que se mueve. No es grave: el clic se despacha AL ELEMENTO, no a una
    coordenada, asi que un blanco movil no se falla. El chequeo DURO es el hit
    test — es el que espero al banner exactamente hasta que se fue (2515ms de
    2500 en la prueba).
  - Costo medido: **~70ms sobre una llamada pelada**. El piso de un verbo del
    gate es ~514ms (arrancar python + la ida y vuelta por archivo), no el
    navegador. Optimizar aqui es optimizar el lugar equivocado.
- **El lazo del agente**: `browser_open {url}` (espera la carga) →
  `browser_read` (pagina como DATOS: text+links+inputs) / `browser_snap`
  (PNG del panel) / `browser_fullsnap` (pagina COMPLETA: estira el frame al
  scrollHeight con afterScreenUpdates y lo restaura) →
  `browser_click {text|selector}` / `browser_type {text, submit?}` /
  `browser_scroll` / `browser_eval {js}` → repetir. `browser_state` = pulso
  (incluye `progress`). Diagnostico: `browser_console` + `browser_net`
  ({bodies: true} = cuerpos de respuesta json/text cap 2KB, capturados por el
  hook). Ciudadania: `browser_download/downloads`, `browser_dialog`,
  `browser_history`, `browser_zoom`, `browser_mobile`, `browser_find`.
  Los verbos con navegacion esperan la carga (con techo 12s) antes de volver.
- **La sesion NO lo persiste** (serializeTree lo filtra y reajusta `active`):
  el webview muere con la app, mismo criterio que el revival muerto.
- `snap` (ventana) NO captura el webview nativo (es hermano del webview de la
  app): para VER la web usa `browser_snap`; para la UI usa `snap`. Los dos
  juntos son la foto completa.
- El overlay `preview` (iframe) SIGUE VIVO para dev servers localhost; el
  navegador es para la web real. Humano: paleta → "Abrir navegador".
- **Lo que NO tiene (decision, no olvido)**: subida de archivos
  (`<input type=file>` exigiria NSOpenPanel = dialogo nativo prohibido; se
  decide con Daniel), extensiones, adblock, perfiles multiples.

**SOURCE CONTROL ESPEJO (28 jul 2026) — la zona superior del sidebar derecho.**
Responde de un vistazo: ¿que cambie? ¿que esta commiteado pero SIN push? ¿que
hay en la nube que no tengo? Rust: `gitmirror.rs` (`git_state` con
ahead/behind via `graph_ahead_behind` + `git_log` GRAFO (29 jul: camina
TODAS las ramas topologico, padres = aristas, chips de refs main/origin/x;
solo-local generalizado = ningun remote lo tiene; rieles SVG por fila con el
algoritmo de carriles puro de `src/core/gitgraph.ts`; punto RELLENO acento =
sin push) + `git_commit_file` que escribe el detalle como .patch
en `~/.config/sfterm/commits/`) · UI: `SourceControl.tsx` (montado sobre el
arbol en `#side`) · estado: `store.scm` (lo refresca `refreshScm`, mismo pulso
que refreshGit: FSEvents debounced + intervalo 8s).
- **⇡N** (acento) = commits SOLO en este disco; **⇣N** = la nube tiene lo que
  tu no; `●` commit local / `○` commit en la nube. Repos sin remote/upstream
  lo dicen honesto ("sin remote") y jamas fingen estado de nube.
- **Constitucion AI-first:** el panel MUESTRA; cero botones de commit/push/
  stage/discard — eso se pide conversando. Gestos permitidos: colapsar, ⟳
  (UNICO gesto de red: `git fetch` tolerante a offline, jamas merge/pull) y
  clicks de LECTURA (archivo → diff en el visor, commit → su .patch,
  checkpoint → su diff).
- La clasificacion nube-vs-local es el "ahead set" (revwalk push(HEAD) +
  hide(upstream)) — acotado, no recorre la historia. Tests:
  `ahead_behind_y_clasificacion_nube_vs_local`, `sin_remote_es_honesto_*`.
- Verbos de gate: `git_state {fetch?}` · `git_log {n?, skip?}` ·
  `show_commit {hash}` (director: pinta el commit en el visor).

**SWITCHER DEL SIDEBAR + MULTI-REPO (29 jul 2026, estilo VS Code).** La
cabecera del sidebar (`SideHead.tsx`) trae DOS botoncitos de vista: 📁
archivos (el arbol) ↔ ⎇ source control (el panel a pantalla completa del
sidebar; ya no viven apilados). El boton de SCM lleva BADGE ambiental (⇡n sin
push, ● si hay cambios) para que la señal viva desde la vista de archivos.
- `store.sideView` ("files"|"scm"), persistido en localStorage
  (`sfterm-side-view`) — estado de layout, jamas config.toml.
- **El nombre del root es un PICKER de repos**: click → menu con PRESETS del
  config (business-os default) + RECIENTES (localStorage
  `sfterm-roots-recent`, cap 8, alimentado por `setTreeRoot`). Elegir uno
  re-apunta arbol + source control + watcher en un movimiento (todo cascadea
  de `setTreeRoot`). Para un repo nuevo: pegar su path en ⌘K (ya existia) o
  pedirlo conversando.
- Verbo de gate `root {path?}`: sin args devuelve el actual; con path cambia
  de repo — el camino AI-first del picker.
- El panel en un folder sin git lo dice honesto ("este folder no es un repo").

**CHECKPOINTS DE AGENTE (28 jul 2026) — la red de deshacer (shadow-git).**
Fotos invisibles del repo como refs ocultos en `refs/sfterm/checkpoints/*`
(`checkpoints.rs`). Tres invariantes DUROS (testeados):
- **Capturar jamas toca el index ni el working tree del usuario**: el arbol se
  construye con un `git2::Index` EN MEMORIA (`write_tree_to`) y el commit nace
  con `update_ref=None`. ⚠️ `set_index` contamina el HANDLE del repo donde se
  llama (sus statuses/reset posteriores usarian el index en memoria — cazado
  por test): `capture()` abre un SEGUNDO handle que muere adentro.
- **El namespace jamas se pushea**: fuera de las refspecs default (testeado
  contra las refspecs reales de un remote).
- **Restore SOLO conversacional** (verbo de gate, sin boton) y deshacible:
  antes de tocar nada se auto-captura "pre-restore". El checkout es force +
  remove_untracked (lo untracked POST-foto se retira; lo ignorado — .env —
  queda), y el index se devuelve al HEAD (reset Mixed) para que `git status`
  cuente la verdad sin staged fantasma.
- Retencion: poda automatica a 40 por repo al guardar. El panel muestra las 6
  mas recientes (carril "checkpoints"); click = diff DESDE la foto.
- Verbos: `checkpoint_save {label?}` · `checkpoint_list` · `checkpoint_diff
  {id, show?}` · `checkpoint_restore {id}` (pedir confirmacion a Daniel).
- Complementa (no duplica) el /rewind de Claude Code: esto es a nivel REPO y
  provider-agnostic — cubre cualquier agente que corra en SFTerm.

**TOGGLE DEL ARBOL EN EL TITLEBAR (28 jul 2026, estilo T3/Arc):** boton junto
a los semaforos (`.tb-side-toggle`, absolute left tras los traffic lights del
Overlay titlebar) = mismo destino que ⌘B. Es un `<button>`, asi que el
`data-tauri-drag-region` no lo captura y el drag de la ventana vive. El icono
(SVG inline) refleja el estado: columna derecha rellena = arbol visible.

**ELEMENT PICKER del navegador (28 jul 2026):** Daniel SEÑALA un elemento de
la pagina y llega como DATOS {selector, tag, text, href, html truncado, rect}.
`src/core/pick.ts`: inyeccion via el eval existente (overlay morado + captura
del click en fase CAPTURE — la pagina NO ve el click) + **polling** de
`window.__sfPick` (pull; el navegador sigue SIN IPC de Tauri por
construccion). Esc cancela; si la pagina navega, la variable muere y se
reporta honesto. Dos entradas, un camino: verbo `browser_pick {timeout_ms?}`
(arma y espera) o boton ⊹ del chrome (Daniel arma; el resultado queda en el
buffer y el proximo `browser_pick` lo drena al instante — `stashPick`/
`takeLastPick`).

**Nervio aferente (16 jul 2026) — la app habla SOLA:** los verbos del gate son
de ida; el nervio es la vuelta. La app escribe eventos JSONL append-only en
`~/.config/sfterm/gate/events.jsonl` (rotacion 5MB → .1): `block_start`,
`block_end` (exit + duration_ms), `needs_attention` (reason=quiet: bloque
corriendo + PTY mudo 120s = casi siempre agente esperando input), `bell`,
`term_spawned`, `term_closed`, `shell_died`. Emision: `src-tauri/src/events.rs`
(sink fs, jamas tira la app) + `src-tauri/src/engine/nervio.rs` (escaner puro,
corre en el ticker; testeable sin fs). El contador `term.activity` (bump en
`engine::feed`) es el pulso de vida. Lectura: `gate.py events` con `{"n": N}`,
`{"cursor": "nombre"}` (offset persistido en gate/cursors/, idempotente) o
`{"follow": true}` — DIRECTO del archivo, funciona con la app cerrada.
Puente al cerebro: `scripts/nervio-bridge.py` filtra señal de ruido (umbral +
cooldown 10min por term/tipo, reglas en su docstring) y POSTea al agent-server
(`SFTERM_NERVIO_URL`, default localhost:3099/chat). Heartbeat auditable:
`nervio-bridge.py --status` (leccion twitter-radar: un organo muerto se ve
identico a uno vivo si nadie chequea).

**Taller conversacional (fase 3, 16 jul 2026) — spec
`_specs/sfterm-taller-conversacional-spec.md`.** Estrella polar de Daniel:
"nadie construye a la antigua; todo conversando". La UI muestra, el agente
opera, y Levy puede PINTAR la pantalla:
- **Verbos de director (gate):** `show_file {path}` · `show_diff {path?}`
  (sin path = TODOS los cambios del repo como tabs diff via
  `actions.openChanges()`, cap 8) · `preview {url|close}` (overlay iframe;
  sin args busca localhost:PUERTO en la terminal enfocada) · `search {q, n?}`.
- **⌘⇧F** busqueda por CONTENIDO: `fsx.rs::fs_search` (walker `ignore`,
  case-insensitive, salta binarios y >2MB, cap 200) + `SearchPanel.tsx`.
  Binding default en codigo (`search_project`), remapeable via [keys].
- **Preview overlay** (`Preview.tsx`, patron Reader: NO toca el tiling ni la
  sesion). Caveat: apps con X-Frame-Options no pintan en el iframe → boton
  "navegador ↗" siempre visible.
- **Worktrees:** gate `spawn {worktree: true}` corre `git worktree add -b
  agente/<ts>` en dir hermano y spawnea ahi — agentes en paralelo sin chocar
  (el S2 resuelto). El merge de vuelta es conversacional.
- Palette: "Ver cambios del repo" · "Buscar por contenido" · "Preview del
  dev server". Edicion manual en el visor: sigue PROHIBIDA (constitucion).
- **Salto a linea:** `show_file {path, line}` y los resultados de ⌘⇧F
  scrollean proporcional a la linea. REACTIVO al store (funciona con el tab
  ya abierto). ⚠️ Leccion: JAMAS usar rAF para efectos que el gate dispara —
  una ventana sin foco no pinta frames y el callback nunca corre.
- **Multi-maquina:** `gate.py --ssh <host> <op> '<json>'` corre cualquier
  verbo contra el SFTerm de otra maquina (un cerebro, varios pisos).
  `nervio-bridge.py` lee `~/.config/sfterm/nervio.env` (URL/TOKEN) para
  maquinas satelite.
- Bundle DMG deshabilitado (fallaba headless, no se usa): build = .app directo.

**Nervio fase 2 (16 jul 2026) — spec `_specs/sfterm-nervio-fase2-spec.md`:**
(1) **Digest del piso** `scripts/nervio-digest.py`: resumen 24h compacto
(bloques/fallos/tareas largas/cwd mas activo) o NADA si el piso no trabajo;
lo consume el morning briefing (migracion v41 del scheduler de business-os) —
primer tramo del comparador. (2) **Sensor S2 de colision** (en el bridge):
reconstruye bloques CORRIENDO desde los eventos; 2+ terminales >2 min en el
MISMO cwd → aviso "posible choque" (cooldown 30 min por cwd). Solo AVISA,
jamas manda. (3) **Propiocepcion** `metrics.rs::scan_hot`: fg process con CPU
>85% sostenida 3 min → `needs_attention {reason:"hot"}` con histeresis
(re-arma <40%), una señal por episodio. Reflejos que ACTUAN solos (auto-retry,
auto-kill): declarados NO construidos — requieren pacto con Daniel.

*(UN SOLO LEVY, la plomeria arbrain (chip.rs), el radar de subagentes, ⌘F
fijar y el backend `claude -p` del chat (agent.rs) murieron con el chat
nativo — purga 21 jul. Levy conversa con la app por el GATE (spawn/send/
read/blocks) y con Daniel por las terminales. El `<task-notification>` del
harness sigue saliendo compacto en el lector via `sysLine`.)*

**Dictado por voz (`src-tauri/src/voice.rs`, sigue vivo):** 100% local y SIN
webview APIs — ffmpeg (avfoundation) graba, whisper-cli transcribe (modelo
ggml en `~/.config/sfterm/models/`, setup `scripts/setup-stt.sh`). El
permiso de microfono lo porta la APP (Info.plist
`NSMicrophoneUsageDescription`). Hoy sin UI que lo dispare (el 🎤 era del
chat); el composer ⌘I recibe el dictado de SFlow del sistema.
⚠️ Regla dura de fixtures E2E (16 jul 2026): un fake-claude para probar un
stream se escribe con `printf '%s\n'`, NUNCA `echo` — el echo de zsh
interpreta los `\n` DENTRO del JSON y parte las lineas.

**Modo Lectura de Bloques (☰):** el output de un bloque como DOCUMENTO. Se abre
con el glifo ☰ del badge (bloques con ≥3 filas de output; flag `readable` en el
frame) o desde la paleta ("Leer ultimo bloque"). Vista rica markdown (marked
instancia aislada + hljs a nivel STRING, tablas/negritas/code blocks con copiar,
serif editorial New York) o prosa (toggle md/txt), copiar-todo, y LECTURA POR
VOZ del sistema (`src/core/reader-speech.ts`, port del motor de Arbrain): 
resaltado de palabra por cajas overlay (Range.getClientRects, NO Highlight API),
barra play/pausa/velocidad/parrafos, tap en parrafo = leer desde ahi, Espacio/←/→.
Esc cierra. `engine_block_text` junta soft-wraps (una linea logica = una linea).
⚠️ REGLAS DURAS aprendidas (15 jul 2026): (1) React 19 re-setea innerHTML de un
dangerouslySetInnerHTML en CADA re-render aunque __html no cambie → el elemento
del doc va MEMOIZADO (useMemo del elemento entero) y el HTML se genera completo
a nivel string, NUNCA mutar el DOM post-render; (2) la barra de voz esta SIEMPRE
montada (display via CSS), montarla a media lectura mata los nodos colectados;
(3) el user-select:none global no aplica al reader (texto seleccionable).

**Terminal propia (diseño, sin accionar):** `docs/terminal-propia.md` — plan por
fases para reemplazar xterm.js (OSC 133 → parser vte en Rust → renderer propio)
manteniendo el PTY como contrato con Claude Code. Tiene triggers de demanda.

## Como personalizar la app (para agentes)

**Toda la personalizacion vive en `~/.config/sfterm/config.toml`** con hot-reload:
editas el archivo y la app se actualiza al instante, sin reiniciar. Preserva los
comentarios del usuario (la app escribe via toml_edit).

### Schema del config

```toml
[general]
config_version = 3                # schema (migracion automatica v1->v3; no tocar)
default_preset = "business-os"   # aporta la carpeta del arranque frio; no ejecuta comandos
agent_command = "claude --dangerously-skip-permissions"  # comando de ⌘⌥J y panes "agent"
restore_session = true            # restaurar sesion previa; en frio abre una shell inactiva
daemon = true                     # PTYs en sfterm-ptyd (inmortales); false = clasico
scrollback = 8000                 # lineas de scrollback por terminal

# [history]                       # la vitrina de historial del rail
# claude_roots = ["~/.claude", "~/.claude-bro"]  # roots de sesiones a indexar
# (home / chat_backend / app_mode: llaves muertas de la era chat-first —
#  pueden seguir en configs viejos, la app las ignora)

[appearance]
theme = "arbrain"                 # nombre de un [themes.*]: arbrain (default, paleta del dashboard Arbrain: morado #A968F7 + zinc #09090b)|titanium|graphite|midnight|paper|custom
ui_font = "Inter"                 # fuente de UI (cualquiera instalada)
ui_font_size = 13
terminal_font = "SF Mono"         # SOLO monospace (el grid del PTY exige ancho fijo)
terminal_font_size = 13           # tamaño BASE = al de la UI (el zoom de app agranda todo)
terminal_padding = 10             # px internos de cada terminal
opacity = 1.0
zoom = 1.0                        # zoom de APP completa estilo VSCode (⌘+/⌘-/⌘0), 0.6-2.0
renderer = "dom"                  # "dom" estable | "webgl" roto en WKWebView macOS 26.5 (xterm #5816)

[themes.<nombre>]                 # temas custom: agrega tu propia tabla
bg / bg_panel / bg_rail / bg_status / fg / fg_dim / accent / border /
cursor / selection / green / red / yellow = "#hex"
ansi = [16 colores hex]           # negro..blanco brillante

[keys]                            # atajos remapeables, formato "cmd+alt+j"
new_terminal / new_conversation / close_panel / toggle_tree / toggle_rail /
focus_left|right|up|down / dock_panel / restore_last / zoom_in / zoom_out /
zoom_reset / select_all / composer / search / file_finder / palette / settings /
next_terminal / next_tab / toggle_markdown / chat / taller / new_chat / search_project /
shortcuts / reload_app
# zoom y demas combos matchean por tecla fisica US *o* por caracter (layouts latam ok)
# SALTO DE LINEA (22 jul 2026, pedido de Daniel "en cualquier cli"): ⇧⏎ **y** ⌥⏎
# mandan ESC+CR (meta+enter) desde la terminal — hardcodeado en AMBOS motores
# (ownterm.ts::encodeKey y term.ts::register) y replicado en el composer del
# lector, para que las dos superficies digan lo mismo. Es la secuencia que
# emiten iTerm2/VSCode/Ghostty y que por eso los TUIs leen como "nueva linea,
# NO enviar". Antes ⌥⏎ caia al `\r` pelado, o sea ENVIABA.
# Si algun CLI quisiera otra secuencia, el lugar de hacerlo configurable es
# [general], no [keys] (esto es un mapeo a BYTES del PTY, no una accion de app).
#
# ATAJOS FRONTIER de edicion EN LA TERMINAL (hardcodeados en ownterm.ts/term.ts,
# 21 jul 2026; bytes VERIFICADOS contra claude 2.1.216 via la puerta):
#   ⌘⌫  = borrar linea hacia atras      → 0x15 (^U; el TUI ofrece ^Y para recuperar)
#   ⌥⌫  = borrar palabra                → ESC+DEL (ya existia)
#   ⌃⌥⌫ = borrar TODO el parrafo/linea  → 0x05 0x15 (End + kill-to-start)
#   ⌘Z  = undo del input                → 0x1f (^_) — ⚠️ JAMAS mandar 0x1a (^Z):
#         claude 2.x lo usa para SUSPENDER el proceso ("ctrl+z now suspends")
#   ⌘⇧Z = sin mapear (el TUI de claude NO tiene redo)
#   ⌘V  = NO se intercepta (22 jul 2026). ⚠️ REGLA DURA: jamas volver a leer
#         el portapapeles con navigator.clipboard.readText() — es lectura
#         PROGRAMATICA y WebKit la tapa con su boton de confirmacion "Paste"
#         (Daniel: "es molesto, son dos pasos cuando pudiera ser uno"). El
#         pegado vive en el evento nativo `paste`, donde el sistema YA entrega
#         el contenido sin permiso: texto → paste normal (bracketed);
#         clipboard sin texto (screenshot) → 0x16 (^V) y el TUI de claude
#         adjunta la imagen el solo. Un solo camino en ambos motores.
# El "espacio invisible" (cursor viejo tras espacio al final del input) se
# arreglo en engine/mod.rs: el ticker emite frame tambien cuando SOLO cambio
# el cursor (last_cursor), no solo con filas dirty. Tests: cuf_solo_* / dectcem_*.

[[presets]]                       # presets agenticos (la feature estrella)
name = "business-os"
root = "~/Developer/business-os"  # ~ se expande
panes = ["agent"]                 # un campo por comando: "agent" = agent_command,
                                  # "" = shell libre, otro string = comando literal.
                                  # 1 pane = fullscreen; 2-3 = lado a lado; 4+ = dos filas
```

- La sesion (layout + cwds + `termId` del daemon por tab/dock) se guarda en
  `~/.config/sfterm/session.json` (archivo de maquina, NO editarlo a mano;
  borralo para forzar arranque frio — con daemon vivo, las conversaciones
  igual se adoptan al dock: la verdad del daemon manda).
- ⚰️ **El revival de CONVERSACIONES por `--resume` automatico MURIO el 21 jul
  pm** por decision de Daniel ("si no podemos conservar la sesion abierta al
  abrir, prefiero que no la tengamos") y SIGUE muerto — era una IMITACION:
  proceso nuevo leyendo la sesion vieja. Lo que SI existe desde el 30 jul es
  la RE-ADOPCION via daemon (ver "CONVERSACIONES INMORTALES"): el proceso ES
  el mismo, que es exactamente lo que Daniel pidio el 27 jul. El resume
  MANUAL sigue: la vitrina/lector ("continuar"), gate `conv_resume`, o
  `claude --resume` con su picker.

## Desarrollo

```bash
npm run tauri dev      # dev con hot-reload
npm run validate       # COMANDO DE VALIDACION: oxlint + tsc + node --test + vite build + cargo test
npm run test           # solo los tests puros de TS (tests/*.test.ts)
npm run tauri build    # produce SFTerm.app + dmg en src-tauri/target/release/bundle/
```

## Arquitectura (mapa rapido)

- `src-tauri/src/pty.rs` — PTYs reales (portable-pty): spawn/write/resize/kill,
  streaming binario por Channel, foreground pgid para titulos/atencion.
  `PtyBackend::{Local,Daemon}` — en modo daemon todo viaja por el puente.
- `src-tauri/src/ptyd/` — el daemon dueño de los PTYs (server/proto/client) +
  `src-tauri/src/ptyd_bridge.rs` — la mitad app (drenador, DaemonWriter,
  spawn/adopt/detach/kill). Ver "CONVERSACIONES INMORTALES".
- `src-tauri/src/hist.rs` — indexador del historial de conversaciones (la
  vitrina): sessions_index con cache por mtime + filtros de maquinaria.
- `src/core/histgroup.ts` — agrupacion PURA de la vitrina (cero imports;
  tests/hist.test.ts) · `src/core/hist.ts` (carga + fijadas) ·
  `src/core/providers.ts` (adaptador por CLI: list/resumeCommand/atPrompt).
- `src-tauri/src/config.rs` — config.toml: default con comentarios, lectura como JSON,
  escritura quirurgica preservando formato (toml_edit), watcher hot-reload.
- `src-tauri/src/gitmirror.rs` — git espejo (git2): status con ignored + diff por archivo.
- `src-tauri/src/fsx.rs` — arbol lazy, watcher FSEvents, indice ⌘P (respeta .gitignore),
  visor (lectura con guardas binario/tamano), revelar en Finder, abrir URLs.
- `src-tauri/src/metrics.rs` — loop sysinfo 1.5s: RAM app vs workload, CPU por panel,
  exits de shells. Emite sys://tick.
- `src-tauri/src/voice.rs` — dictado: ffmpeg avfoundation graba, whisper-cli
  transcribe local (modelo en ~/.config/sfterm/models, `rank_model` elige el
  mejor). `voice_status` dice que falta para dar errores utiles.
- `src/core/term.ts` — pool de xterms FUERA de React (los terminales nunca se
  re-montan; el layout solo los reposiciona). WebGL con fallback DOM.
- `src/core/tiling.ts` — modelo PURO del arbol de splits + pestañas: insert/remove
  (con colapso), splitLeaf, moveTab, layoutRects, serializacion de sesion.
- `src/core/actions.ts` — orquestador: boot, presets, spawn, dock/show, openFileTab
  (split derecho + tabs del viewer), dropOn, zoom, sesion (v2 + migracion), git refresh.
- `src/core/screen.ts` — modelo PURO del ADELANTO: perfiles de pantalla por CLI
  (`SCREEN_PROFILES`) + el parser del bloque en vuelo. Cero imports, cero DOM.
- `tests/` — tests puros de TS (`node --test`, sin dependencias) con capturas
  REALES de terminal en `tests/fixtures/`. Ahi va todo parser de pantalla.
- `src/components/` — Tiling (renderer: tab bars, dividers, drops), Rail
  (terminales), ConvReader (lector ⌃Tab + piezas de mensaje),
  Tree (iconos Material + badges git), FileView (visor universal),
  Settings (⚙)/Palette/FileFinder/FindBar/StatusBar/Composer/Drawer/Reader.

## Reglas duras del repo

- Los terminales viven en `#term-pool` fuera del arbol React. NUNCA montarlos
  como children de componentes React (se destruirian al re-render).
- Dialogos nativos (alert/confirm/prompt) PROHIBIDOS: bloquean el webview.
- El visor es SOLO LECTURA para siempre. Editar = pedirselo al agente.
- Los presets viven en config.toml, jamas hardcodeados.
