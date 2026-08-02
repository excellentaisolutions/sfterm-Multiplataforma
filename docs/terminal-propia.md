# Terminal propia — diseño bajo nuestros términos (SIN accionar aún)

> Pregunta de Daniel (15 jul 2026): ¿cómo reemplazamos la terminal que usamos
> (xterm.js) con la nuestra, para tener libertad total de features sin estar
> anichados a lo que la terminal nos permite — manteniendo Claude Code CLI y el
> estándar de la industria?
>
> Respuesta corta: sí se puede, el contrato que NO se toca es el PTY, y el
> reemplazo es por capas, no big-bang. Este doc es el plano. No hay código.

## 1. El insight: qué es "una terminal" en realidad

```
   Claude Code CLI (o zsh, o htop)          ← NO SE TOCA. Solo ve un PTY.
        │  bytes ANSI/VT (stdin/stdout)
   ┌────┴─────────────────────────────────┐
   │ 1. PTY + procesos                    │  ✅ YA ES NUESTRO (Rust, portable-pty)
   ├──────────────────────────────────────┤
   │ 2. Parser VT + modelo de pantalla    │  ⬅ hoy xterm.js
   │    (bytes → grid de celdas + estado) │
   ├──────────────────────────────────────┤
   │ 3. Renderer + input                  │  ⬅ hoy xterm.js (DOM)
   │    (grid → píxeles; teclas → bytes)  │
   └──────────────────────────────────────┘
```

Claude Code no sabe ni le importa quién dibuja: escribe secuencias ANSI a un
file descriptor. **El estándar de la industria es el protocolo (VT/ANSI + PTY),
no la librería.** Mientras respetemos eso, la compatibilidad es total: claude,
vim, htop, ssh — todo corre igual en nuestra terminal.

## 2. Por qué el orden correcto es parser primero, renderer después

La libertad de features que Daniel quiere (bloques, acciones por respuesta,
media inline, orquestación) NO vive en el renderer: vive en el **modelo de
pantalla semántico**. xterm.js nos da un grid de celdas tonto; lo que queremos
es un modelo que sepa "esto fue UN comando con SU output", "esto lo escribió
claude", "aquí empieza una respuesta".

## 3. Fases (cada una shippeable, sin romper la anterior)

### Fase A — Shell integration semántica (bajo esfuerzo, xterm sigue)
- Inyectar OSC 133 (protocolo FinalTerm, el mismo que usan VSCode/WezTerm/
  Kitty) en zsh: marca prompt-start / command-start / command-end en el stream.
- xterm.js ya expone estos marcadores via su API de marks.
- Desbloquea: **bloques** (comando+output como unidad), copiar/re-correr un
  bloque, "salta al comando anterior", exit-code por bloque en la UI.
- Esfuerzo: días. Riesgo: bajo. **Este es el siguiente paso real.**

### Fase B — Parser propio en Rust (el corazón del reemplazo)
- Mover el parsing ANSI de JS a Rust con el crate `vte` (el parser de
  Alacritty: probado en millones de máquinas, es una máquina de estados pura).
- Rust mantiene el grid + scrollback + estado (modos, colores, títulos OSC,
  marcas 133) y manda al frontend **damage updates** (solo celdas que
  cambiaron), no bytes crudos.
- Ganancias: el modelo de pantalla vive en NUESTRO código (testeable con cargo
  test, sin browser), el scrollback deja de comer RAM del webview, y el
  frontend se vuelve tonto (dibuja lo que le digan).
- Claude Code: cero cambios. El PTY es el mismo.
- Esfuerzo: 2-4 semanas de trabajo enfocado. Riesgo: medio (fidelidad VT
  — se mitiga corriendo `vttest` y esult y comparando lado a lado con xterm).

### Fase C — Renderer propio (canvas → GPU si hace falta)
- Primero canvas 2D con atlas de glifos (suficiente hasta ~10-15 terminales
  visibles); wgpu/Metal solo si medimos que canvas no alcanza.
- Al ser nuestro: media inline (imágenes/video en el stream), folding de
  output largo, decoraciones por bloque, densidad variable, minimapa.
- Esfuerzo: 3-6 semanas. Riesgo: medio-alto (tipografía: ligaduras, emoji,
  CJK, doble ancho — es donde mueren los renderers caseros).

### Fase D — (opcional, lejana) ventana nativa sin webview
- Si algún día la app entera pasa a wgpu, Tauri sale de la ecuación.
- Hoy NO conviene: el webview nos da el árbol, settings, visores, gratis.

## 4. Qué desbloquea cada fase (features imposibles hoy)

| Feature | Necesita |
|---------|----------|
| Bloques comando+output, re-correr, copiar bloque | A |
| "Manda este output a otro agente" (pipe visual) | A |
| Exit code / duración por bloque en la UI | A |
| Scrollback gigante sin comer RAM del webview | B |
| Grid consultable por Levy via gate ("¿qué dice la celda X?") semántico | B |
| Replay/grabación nativa de sesión (bytes + timing ya en Rust) | B |
| Imágenes/video inline en el stream | C |
| Folding, minimapa, densidad variable | C |

## 5. Decisión y trigger

- **Hoy**: quedarnos en xterm.js. Ninguna feature del roadmap actual está
  bloqueada por él (composer, kickoff, gate: todas shippearon sin tocarlo).
- **Trigger para Fase A**: la primera feature de bloques que queramos
  (ej. "re-corre el último comando" o pipes entre agentes). Es barata: hacerla
  cuando se pida.
- **Trigger para Fase B**: cuando UNA de estas pase: (1) una feature
  semántica tope con los límites de la API de marks de xterm, (2) el RAM del
  scrollback con 10+ agentes se vuelva problema real medido, (3) queramos el
  replay nativo para contenido del canal.
- **Anti-trigger**: NO hacerlo por pureza de "todo Rust". El costo es real y
  el parser/renderer son commodity; nuestros principios viven en el modelo de
  interacción, que ya controlamos.

## 6. Riesgos honestos

1. **Fidelidad VT**: los TUIs modernos (claude usa ink) estresan modos raros.
   Mitigación: vte de Alacritty + suite vttest + A/B contra xterm.js.
2. **Tipografía** (Fase C): ligaduras, emoji ZWJ, ancho doble CJK. Es el 80%
   del dolor de un renderer. Mitigación: canvas con medición del sistema
   primero, GPU después.
3. **Costo de oportunidad**: 1-2 meses de ingeniería que no van al negocio.
   Por eso las fases tienen triggers de demanda, no fechas.
