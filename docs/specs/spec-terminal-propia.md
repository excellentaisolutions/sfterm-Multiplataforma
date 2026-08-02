# SFTerm — Motor de terminal PROPIO — Spec

> Compilado por goal-compiler (15 jul 2026). Diseño original y fases:
> `docs/terminal-propia.md` (leerlo tambien). Este spec es la orden de build.

## MISION

Reemplazar xterm.js por un **motor VT propio** en SFTerm, manteniendo intacto el
contrato PTY (Claude Code CLI, zsh, vim, htop corren IDENTICOS, sin enterarse).
El resultado world-class tiene tres organos:

1. **Parser + modelo de pantalla en Rust** — el parsing ANSI/VT vive en nuestro
   backend (el crate `vte` de Alacritty es la sugerencia obvia, no un requisito).
   Rust mantiene grid, scrollback, modos, colores, titulos OSC, y manda al
   frontend *damage updates* (solo lo que cambio), no bytes crudos. El modelo es
   testeable con `cargo test` sin browser. El scrollback deja de comer RAM del
   webview.
2. **Modelo SEMANTICO de bloques** — shell integration OSC 133 (protocolo
   FinalTerm, el mismo de VSCode/WezTerm/Kitty) inyectado en zsh: cada comando +
   su output es una UNIDAD con exit code y duracion. Los bloques son objetos de
   primera clase: saltar entre bloques, copiar bloque, re-correr bloque. El gate
   (`src/core/gate.ts`) gana ops semanticas: leer el ultimo bloque, su exit code,
   su comando — un agente lee ESTRUCTURA, no texto plano.
3. **Renderer propio** — canvas 2D con atlas de glifos primero (WebGL/WebGPU solo
   si se mide que hace falta; ojo: el addon WebGL de xterm ya esta roto en
   WKWebView macOS 26.5, xterm #5816 — sospecha de todo lo GPU en este webview).
   Al ser nuestro: decoraciones por bloque, folding de output largo, y la puerta
   abierta a tipografia por-bloque y media inline (no exigidas en esta pasada,
   pero la arquitectura NO debe cerrarlas).

La barra de calidad: fidelidad de Alacritty, bloques de Warp, pero AI-first —
el modelo semantico se diseña para que agentes lo lean por el gate.

### Detalles UI incluidos en este goal (pedidos exactos de Daniel)

- **option+tab cicla entre terminales** (y option+shift+tab al reves): rota el
  campo enfocado entre las conversaciones vivas (las no visibles se muestran al
  ciclar, estilo VSCode). Remapeable en `[keys]` del config. DEBE funcionar con
  el foco dentro de un xterm (el interceptor de term.ts tiene que dejarlo pasar,
  mismo patron que los atajos existentes).
- **Quitar el boton manual "+" de nueva terminal** del header del rail. Queda
  SOLO el boton de nueva conversacion de agente. El atajo cmd+j sigue vivo para
  quien quiera shell pelado; el boton muere.

## LIBERTAD TECNICA

Tu eliges arquitectura, crates, protocolo de damage updates, formato del atlas,
estrategia de migracion. Todo lo tecnico de arriba es sugerencia descartable,
salvo RESTRICCIONES. Optimiza por el mejor resultado, no el camino corto.

## INVESTIGA ANTES DE CONSTRUIR

Alacritty (vte, grid), WezTerm, Kitty, Warp (bloques), la shell integration de
VSCode (OSC 133/633), y la API de marks de xterm.js. Decide el enfoque a partir
de eso. Reafirma el objetivo en una linea antes de cada edicion grande.

## ORDEN SUGERIDO (cada fase deja la app shippeable)

A) OSC 133 en zsh + bloques sobre xterm.js (API de marks) — valor inmediato.
B) Parser+grid en Rust con damage updates; el frontend se vuelve tonto.
C) Renderer propio consumiendo el grid de B.
El switch vive en config: `renderer = "own" | "xterm"` (o "dom"). xterm.js queda
como fallback VIVO y demostrable hasta que el motor propio lo supere.

## DEFINICION DE HECHO (evidencia visible en la conversacion)

- `npm run validate` en verde (pegado), incluyendo cargo tests del motor
  (parser/grid: secuencias CSI/SGR/OSC, resize, scrollback, wrap, wide chars).
- Screenshots del harness pegados (Read de los PNG):
  - claude corriendo COMPLETO en el motor nuevo (banner, colores, spinner)
  - vim y htop fieles, A/B lado a lado contra xterm.js
  - bloques: comando+output con exit code y duracion visibles; re-run de bloque
  - option+tab: antes/despues del ciclo de terminales
  - rail con UN solo boton + (el de agente)
- Fidelidad: corre vttest (o esctest) y pega resumen honesto de que pasa/falla.
- Fallback demostrado: cambiar `renderer` en config y screenshot con xterm.js.
- Gate semantico: una op nueva leyendo el ultimo bloque (comando, exit, output)
  con su output JSON pegado.
- Reporte de decisiones (que elegiste y por que) + lista de formas en que
  podria estar mal/incompleto, y su resolucion.

## COMANDO DE VALIDACION

`npm run validate` (oxlint + tsc + vite build + cargo test) tras cada cambio
grande, output surfeado. Para E2E visual: `SFTERM_DEBUG=1 npm run tauri dev` +
harness `/tmp/sfterm-cmd.json` (ops snap/eval/evaljson) — ver CLAUDE.md del repo.

## RESTRICCIONES REALES

- El PTY (`src-tauri/src/pty.rs`) es EL contrato: no cambia su interfaz hacia
  los procesos. Claude Code CLI y cualquier TUI corren sin modificacion.
- NO romper lo shippeado: composer (⌘I), gate, kickoff, zoom de app, sesion,
  splits/drag, titulos OSC, temas del config. Correr sus flujos tras cambios.
- Invariante del repo: los terminales viven en #term-pool FUERA de React.
- Cada fase deja `main` shippeable; nada de big-bang roto a medias.
- macOS WKWebView es el runtime real; desconfia de WebGL ahi (historial roto).
- NO robar el foco a Daniel al probar: spawns/probes ocultos via gate/harness,
  nunca focus() de ventana. Snaps si, activate no.
- Sin APIs de pago. Repo: ~/Developer/software/sfterm.
- `tauri dev` recompila y mata PTYs al tocar Rust; el boot hace ptyKillAll —
  no dejes claudes de Daniel corriendo dentro de tu instancia dev.

## GOTCHAS HEREDADOS (te ahorran horas)

- zsh instant-prompt se traga typeahead temprano: espera ~3s post-spawn.
- Alias de Daniel: `cat` = bat → usa `command cat` en probes.
- HMR de vite NO reemplaza setInterval vivos; recarga si cambias loops.
- Los titulos OSC de zsh default ("user@host:path") se filtran en panelTitle.
