# Modo Lectura de Bloques — Spec

## MISION

SFTerm ya tiene motor de terminal propio (`renderer = "own"`): cada comando es un
BLOQUE con cmd/cwd/exit/duracion/output (OSC 133, `src-tauri/src/engine/blocks.rs`).
Hoy ese output vive preso del grid monospace. La mision: **liberar la prosa del grid**.

Cuando el output de un bloque es prosa/markdown (tipicamente la respuesta de un agente
Claude), Daniel debe poder:

1. **Verla como documento rico**, a la altura del chat de Arbrain (la referencia visual
   canonica, la interfaz que Daniel ama): tipografia proporcional elegante estilo
   editorial, negritas/italicas, headings con jerarquia real, TABLAS renderizadas de
   verdad (header row, bordes, zebra), listas, blockquotes, code blocks con syntax
   highlight y boton de copiar, inline code con fondo tipo pill, boton de copiar-todo
   al final del bloque. La vista rica es una CAPA DE LECTURA sobre el bloque: se abre
   y se cierra con un gesto; el grid sigue siendo la verdad debajo.

2. **Escucharla con la voz del sistema** (TTS neural de Apple, on-device, Web Speech
   API): boton de escuchar por bloque; resaltado con fondo (color acento del theme) de
   la PALABRA exacta que suena; lectura dividida por parrafos; barra de control
   flotante: play/pausa, velocidad ciclica (1x → 1.25 → 1.5 → 1.75 → 2x), parrafo
   anterior/siguiente, cerrar, progreso "n/total parrafos"; tap/click en un parrafo =
   leer desde ahi; atajos Espacio (pausa) y ←/→ (parrafos) cuando el foco no esta en
   la terminal. Exactamente la experiencia de Arbrain: Daniel lee MIENTRAS escucha y
   asi se le queda la informacion.

Deteccion: el modo lectura se ofrece donde tiene sentido (output con señales de
markdown/prosa) sin estorbar en outputs de maquina (ls, build logs, htop). Como se
activa (boton en el badge del bloque, atajo, auto) lo decides tu; que sea obvio y de
UN gesto.

## APALANCAMIENTO YA RESUELTO (no redescubras esto)

- **El motor TTS completo ya existe**, con los fixes duros de WKWebView ya pagados, en
  `/Users/danielcarreon/Developer/business-os/arbrain/src/features/chat/lib/chat-speech.ts`
  (+ su barra de control: buscar `chatSpeech` en `arbrain/src/features/chat/`). Leelo
  ENTERO antes de decidir. Contiene resueltos: WKWebView NO emite `boundary`/`onend`
  confiables (solucion: el "reloj propio"), `cancel()` asincrono de WebKit (tick de
  60ms antes de re-hablar), saneado de ruido hablado (URLs → "un enlace", rutas →
  "una ruta", emojis fuera) con MAPA hablado→visible para no desincronizar el
  resaltado, Highlight API unica persistente, voces expuestas distintas por
  superficie (no forzar voz: default del sistema). Portarlo/adaptarlo es
  apalancamiento; reinventarlo es quemar turnos en bugs ya resueltos.
- **La estructura del bloque ya existe en Rust:** engine (`blocks.rs`) + comandos
  tauri `engine_blocks` / `engine_block_text` (JSON con output completo). El frontend
  (`src/core/ownterm.ts`) ya pinta badges ✓/✗ + ↻ por bloque.
- **Referencia visual:** el chat de Arbrain (`arbrain/src/features/chat/`, estilos en
  sus componentes + `arbrain/src/app/globals.css`). Daniel quiere ESA sensacion.

## LIBERTAD TECNICA

Tu eliges arquitectura, libreria de markdown, syntax highlight y el diseño de
interaccion: probablemente sabes mejor que nadie que conviene. Lo de arriba es
apalancamiento y referencia, NO jaula, salvo la seccion RESTRICCIONES. Optimiza por
la experiencia de lectura mas hermosa posible, no por el camino corto.

## INVESTIGA ANTES DE CONSTRUIR

Mira como Warp presenta sus bloques y como los lectores serios (iA Writer, lectores
de libros) tratan tipografia, medida de linea e interlineado. Inspecciona el codigo
real del chat de Arbrain para clavar la referencia. Reafirma el objetivo en una linea
antes de cada edicion grande para no driftar.

## DEFINICION DE HECHO (evidencia visible EN la conversacion)

- Ultimo `npm run validate` pegado, en verde.
- Screenshots (instancia dev o `gate snap`):
  1. Un bloque con respuesta larga de agente en vista rica: TABLA renderizada +
     negritas + heading + code block con boton de copiar visible.
  2. TTS activo: barra de control visible + palabra resaltada; DOS capturas que
     demuestren que el resaltado AVANZA (antes/despues).
  3. Controles demostrados: velocidad cambiada (label visible, ej. 1.5x) y salto de
     parrafo (resaltado movido a otro parrafo).
  4. La terminal intacta: el mismo bloque en el grid normal + vim o htop corriendo
     bien en el motor propio.
- Boton copiar demostrado (contenido copiado pegado en la conversacion o estado
  "copiado" visible en captura).
- Reporte de decisiones: librerias elegidas y por que, como detectas prosa, que
  portaste del motor de Arbrain y que cambiaste.
- Lista las formas en que podria estar mal/incompleto (markdown malformado, output
  gigante, bloque aun corriendo, resize/zoom, theme paper vs titanium, wrap de lineas
  largas) y resuelvelas o documenta el limite explicitamente.

## COMANDO DE VALIDACION

`npm run validate` en `~/Developer/software/sfterm` (oxlint + tsc + vite build +
cargo test). Correlo tras cada cambio grande y surfea su output en la conversacion.

## RESTRICCIONES REALES

- Repo: `~/Developer/software/sfterm`. Commit del estado limpio ANTES de empezar y
  commits atomicos al avanzar.
- El grid/PTY no se toca: la vista rica es capa adicional. El motor propio
  (`renderer = "own"`) y el fallback xterm (`"dom"`) siguen funcionando igual.
- No romper lo existente: composer ⌘I, gate completo (ping/list/spawn/send/read/
  blocks/block_last/show/close/snap), kickoff de presets, option+tab, zoom, sesion,
  seleccion/copy del grid, find, re-run ↻.
- Los terminales viven en `#term-pool` FUERA de React (regla dura del repo).
  Dialogos nativos (alert/confirm/prompt) PROHIBIDOS.
- Los temas mandan: la vista rica respeta paper Y titanium (paper es el activo de
  Daniel; probar minimo ese, idealmente ambos).
- El modo lectura NO roba foco ni atajos de la terminal cuando no esta activo.
- TTS: voz del SISTEMA via Web Speech API. Sin APIs de pago, sin red, sin ElevenLabs.
- El `config.toml` personal de Daniel no se toca salvo agregar defaults sensatos de
  la feature nueva (via el mecanismo de migracion/hot-reload existente).
