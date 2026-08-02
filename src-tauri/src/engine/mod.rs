//! Motor de terminal propio. El parsing VT vive AQUI (Rust), no en el webview:
//! - El reader thread del PTY alimenta el engine SIEMPRE (tee), asi el modelo
//!   semantico (titulos, bloques, cwd, gate) existe con cualquier renderer.
//! - Las respuestas (DSR/DA/OSC 10/11) se escriben al PTY de inmediato.
//! - Un ticker global (16ms) empuja frames binarios al renderer propio
//!   (subscriber) solo cuando hay filas dirty, y drena eventos a la UI.

pub mod blocks;
pub mod frame;
pub mod grid;
pub mod nervio;
pub mod term;
#[cfg(test)]
mod tests;

use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};
use term::{Term, TermEvent, ThemeColors};

pub struct EngineSession {
    pub parser: vte::Parser,
    pub term: Term,
    pub subscriber: Option<Channel<InvokeResponseBody>>,
    pub seq: u32,
    /// memoria del nervio aferente: que bloques ya reporto este engine
    pub nervio: nervio::NervioTrack,
    /// ultimo estado de cursor EMITIDO (x, y, viewport, visible, shape):
    /// un movimiento de cursor sin celdas dirty (ej. espacio al final del
    /// input de claude = CUF puro) tambien merece frame — sin esto el
    /// cursor en pantalla se queda VIEJO hasta el siguiente caracter
    /// ("no se ve el salto del espacio", bug 21 jul 2026).
    pub last_cursor: (usize, usize, usize, bool, u8),
}

#[derive(Default)]
pub struct EngineState {
    pub sessions: Mutex<HashMap<u32, Arc<Mutex<EngineSession>>>>,
    pub theme: Mutex<Option<ThemeColors>>,
}

#[derive(Clone, Serialize)]
pub struct EngineEvt {
    pub id: u32,
    pub kind: String,
    pub data: String,
}

// ---------- ciclo de vida (lo llama pty.rs) ----------

pub fn create(state: &EngineState, id: u32, cols: usize, rows: usize, scrollback: usize) {
    let mut term = Term::new(cols, rows, scrollback);
    if let Some(theme) = state.theme.lock().unwrap().clone() {
        term.theme = theme;
    }
    let session = EngineSession {
        parser: vte::Parser::new(),
        term,
        subscriber: None,
        seq: 0,
        nervio: nervio::NervioTrack::default(),
        last_cursor: (0, 0, 0, true, 0),
    };
    state
        .sessions
        .lock()
        .unwrap()
        .insert(id, Arc::new(Mutex::new(session)));
}

pub fn get(state: &EngineState, id: u32) -> Option<Arc<Mutex<EngineSession>>> {
    state.sessions.lock().unwrap().get(&id).cloned()
}

pub fn remove(state: &EngineState, id: u32) {
    state.sessions.lock().unwrap().remove(&id);
}

pub fn remove_all(state: &EngineState) {
    state.sessions.lock().unwrap().clear();
}

/// Alimenta bytes del PTY al parser. Devuelve las respuestas (DSR/DA/...)
/// que hay que escribir de vuelta al PTY.
pub fn feed(session: &Arc<Mutex<EngineSession>>, bytes: &[u8]) -> Vec<u8> {
    let mut s = session.lock().unwrap();
    let EngineSession { parser, term, .. } = &mut *s;
    parser.advance(term, bytes);
    if !bytes.is_empty() {
        // pulso de vida para el nervio: "este PTY sigue hablando"
        term.activity = term.activity.wrapping_add(1);
    }
    std::mem::take(&mut s.term.responses)
}

pub fn resize(state: &EngineState, id: u32, cols: usize, rows: usize) {
    if let Some(session) = get(state, id) {
        let mut s = session.lock().unwrap();
        let template = grid::Cell::default();
        s.term.grid.resize(cols, rows, template);
    }
}

// ---------- ticker: frames + eventos ----------

pub fn start_ticker(app: AppHandle) {
    std::thread::spawn(move || {
        use tauri::Manager;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(16));
            let state = app.state::<EngineState>();
            let sessions: Vec<(u32, Arc<Mutex<EngineSession>>)> = state
                .sessions
                .lock()
                .unwrap()
                .iter()
                .map(|(k, v)| (*k, v.clone()))
                .collect();
            let mut evts: Vec<EngineEvt> = Vec::new();
            for (id, session) in sessions {
                let mut s = session.lock().unwrap();
                // synchronized output (DECSET 2026): retener frames, con escape
                if s.term.modes.synchronized {
                    let stuck = s
                        .term
                        .sync_since
                        .map(|t| t.elapsed().as_millis() > 150)
                        .unwrap_or(true);
                    if !stuck {
                        continue;
                    }
                    s.term.modes.synchronized = false;
                }
                for e in std::mem::take(&mut s.term.events) {
                    if matches!(e, TermEvent::Bell) {
                        // campanazo del CLI (Claude Code avisa asi): al nervio
                        crate::events::emit("bell", serde_json::json!({ "term": id }));
                    }
                    let (kind, data) = match e {
                        TermEvent::Title(t) => ("title", t),
                        TermEvent::Bell => ("bell", String::new()),
                        TermEvent::Cwd(p) => ("cwd", p),
                        TermEvent::Clipboard(t) => ("clipboard", t),
                    };
                    evts.push(EngineEvt { id, kind: kind.into(), data });
                }
                // nervio aferente: bloques nacidos/terminados + silencios
                {
                    let now = std::time::Instant::now();
                    let EngineSession { term, nervio: track, .. } = &mut *s;
                    nervio::scan(term, track, id, now, &mut |ev, fields| {
                        // needs_attention tambien al frontend (badge en el
                        // HOME chat-first); reason viaja en data ("quiet")
                        if ev == "needs_attention" {
                            let reason = fields
                                .get("reason")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            evts.push(EngineEvt { id, kind: "attention".into(), data: reason });
                        }
                        crate::events::emit(ev, fields);
                    });
                }
                let cursor_now = {
                    let c = s.term.grid.cursor();
                    (
                        c.x,
                        c.y,
                        s.term.grid.viewport_offset,
                        s.term.modes.cursor_visible,
                        s.term.modes.cursor_shape,
                    )
                };
                if s.subscriber.is_some()
                    && (s.term.grid.has_dirty() || s.last_cursor != cursor_now)
                {
                    s.seq = s.seq.wrapping_add(1);
                    let seq = s.seq;
                    let buf = frame::build(&mut s.term, seq);
                    s.last_cursor = cursor_now;
                    if let Some(ch) = &s.subscriber {
                        let _ = ch.send(InvokeResponseBody::Raw(buf));
                    }
                }
            }
            for e in evts {
                let _ = app.emit("engine://evt", e);
            }
        }
    });
}

// ---------- comandos tauri ----------

#[tauri::command]
pub fn engine_subscribe(
    state: State<'_, EngineState>,
    id: u32,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let session = get(&state, id).ok_or("no such engine")?;
    let mut s = session.lock().unwrap();
    s.subscriber = Some(on_frame);
    s.term.grid.mark_all_dirty();
    Ok(())
}

#[tauri::command]
pub fn engine_unsubscribe(state: State<'_, EngineState>, id: u32) -> Result<(), String> {
    if let Some(session) = get(&state, id) {
        session.lock().unwrap().subscriber = None;
    }
    Ok(())
}

/// offset absoluto en lineas hacia el scrollback (0 = live). relative=true
/// suma delta. Devuelve el offset efectivo.
#[tauri::command]
pub fn engine_set_viewport(
    state: State<'_, EngineState>,
    id: u32,
    offset: i64,
    relative: bool,
) -> Result<u32, String> {
    let session = get(&state, id).ok_or("no such engine")?;
    let mut s = session.lock().unwrap();
    let max = s.term.grid.scrollback.len() as i64;
    let cur = s.term.grid.viewport_offset as i64;
    let next = if relative { cur + offset } else { offset }.clamp(0, max) as usize;
    if next != s.term.grid.viewport_offset {
        s.term.grid.viewport_offset = next;
        s.term.grid.mark_all_dirty();
    }
    Ok(next as u32)
}

#[tauri::command]
pub fn engine_text(state: State<'_, EngineState>, id: u32, lines: usize) -> Result<String, String> {
    let session = get(&state, id).ok_or("no such engine")?;
    let s = session.lock().unwrap();
    Ok(s.term.grid.tail_text(lines.min(5000)))
}

#[derive(Serialize)]
pub struct BlockInfo {
    pub id: u64,
    pub cmd: String,
    pub cwd: String,
    pub exit: Option<i32>,
    pub duration_ms: Option<u64>,
    pub running: bool,
}

#[tauri::command]
pub fn engine_blocks(
    state: State<'_, EngineState>,
    id: u32,
    n: Option<usize>,
) -> Result<Vec<BlockInfo>, String> {
    let session = get(&state, id).ok_or("no such engine")?;
    let s = session.lock().unwrap();
    let n = n.unwrap_or(20).min(500);
    Ok(s.term
        .blocks
        .list
        .iter()
        .rev()
        .take(n)
        .map(|b| BlockInfo {
            id: b.id,
            cmd: b.cmd.clone(),
            cwd: b.cwd.clone(),
            exit: b.exit,
            duration_ms: b.duration_ms,
            running: b.running(),
        })
        .collect())
}

#[derive(Serialize)]
pub struct BlockText {
    pub cmd: String,
    pub cwd: String,
    pub exit: Option<i32>,
    pub duration_ms: Option<u64>,
    pub running: bool,
    pub text: String,
}

/// Output de un bloque (default: el ultimo). La materia prima del gate
/// semantico: un agente lee ESTRUCTURA, no scrape de pantalla.
#[tauri::command]
pub fn engine_block_text(
    state: State<'_, EngineState>,
    id: u32,
    block_id: Option<u64>,
    max_lines: Option<usize>,
) -> Result<BlockText, String> {
    let session = get(&state, id).ok_or("no such engine")?;
    let s = session.lock().unwrap();
    block_text_of(&s.term, block_id, max_lines)
        .ok_or_else(|| "sin bloques (¿shell integration activa?)".to_string())
}

/// Logica pura de block_text (testeable sin State de tauri).
pub fn block_text_of(term: &Term, block_id: Option<u64>, max_lines: Option<usize>) -> Option<BlockText> {
    let block = match block_id {
        Some(bid) => term.blocks.list.iter().find(|b| b.id == bid),
        None => term.blocks.last(),
    }?;
    let end = block.end_abs.unwrap_or_else(|| term.grid.cursor_abs());
    let max = max_lines.unwrap_or(200).min(2000);
    // Soft-wraps se JUNTAN: una linea logica que envolvio N veces vuelve como
    // UNA linea (markdown/prosa lo exigen; el cap sigue contando filas fisicas).
    let mut lines: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut joining = false;
    let mut abs = block.output_abs;
    let mut physical = 0usize;
    while abs <= end && physical < max {
        let row = term.grid.line_abs(abs);
        let wrapped = row.map(|r| r.wrapped).unwrap_or(false);
        match row {
            Some(r) => cur.push_str(&if wrapped { r.text_raw() } else { r.text() }),
            None => {} // ya recortada del scrollback
        }
        if !wrapped {
            lines.push(std::mem::take(&mut cur));
            joining = false;
        } else {
            joining = true;
        }
        physical += 1;
        abs += 1;
    }
    if joining && !cur.is_empty() {
        lines.push(cur);
    }
    while lines.last().map(|l| l.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    Some(BlockText {
        cmd: block.cmd.clone(),
        cwd: block.cwd.clone(),
        exit: block.exit,
        duration_ms: block.duration_ms,
        running: block.running(),
        text: lines.join("\n"),
    })
}

/// Texto de un rango (seleccion del renderer propio). Filas absolutas,
/// columnas inclusive. Junta soft-wraps sin salto de linea.
#[tauri::command]
pub fn engine_range_text(
    state: State<'_, EngineState>,
    id: u32,
    start_abs: u64,
    start_col: usize,
    end_abs: u64,
    end_col: usize,
) -> Result<String, String> {
    let session = get(&state, id).ok_or("no such engine")?;
    let s = session.lock().unwrap();
    let mut out = String::new();
    let mut abs = start_abs;
    while abs <= end_abs {
        if let Some(row) = s.term.grid.line_abs(abs) {
            // wrapped: sin trim (los espacios del borde son contenido real)
            let full = if row.wrapped && abs != end_abs { row.text_raw() } else { row.text() };
            let chars: Vec<char> = full.chars().collect();
            let from = if abs == start_abs { start_col.min(chars.len()) } else { 0 };
            let to = if abs == end_abs {
                (end_col + 1).min(chars.len())
            } else {
                chars.len()
            };
            if from < to {
                out.extend(&chars[from..to]);
            }
            if abs != end_abs && !row.wrapped {
                out.push('\n');
            }
        } else if abs != end_abs {
            out.push('\n');
        }
        abs += 1;
    }
    Ok(out)
}

/// Busqueda en scrollback + pantalla (case-insensitive). Devuelve la fila
/// absoluta y columna del match, o None. `from_abs` acota: siguiente match
/// ESTRICTAMENTE antes (backward=true) o despues/igual (backward=false).
#[tauri::command]
pub fn engine_find(
    state: State<'_, EngineState>,
    id: u32,
    q: String,
    from_abs: Option<u64>,
    backward: bool,
) -> Result<Option<(u64, usize)>, String> {
    let session = get(&state, id).ok_or("no such engine")?;
    let s = session.lock().unwrap();
    if q.is_empty() {
        return Ok(None);
    }
    let needle = q.to_lowercase();
    let grid = &s.term.grid;
    let first_abs = grid.abs_base - grid.scrollback.len() as u64;
    let last_abs = grid.abs_base + grid.rows as u64 - 1;
    let hit = |abs: u64| -> Option<(u64, usize)> {
        let row = grid.line_abs(abs)?;
        let hay = row.text().to_lowercase();
        hay.find(&needle)
            .map(|byte| (abs, hay[..byte].chars().count()))
    };
    if backward {
        let start = from_abs.unwrap_or(last_abs + 1).saturating_sub(1);
        let mut abs = start.min(last_abs);
        loop {
            if let Some(h) = hit(abs) {
                return Ok(Some(h));
            }
            if abs <= first_abs {
                break;
            }
            abs -= 1;
        }
    } else {
        let mut abs = from_abs.unwrap_or(first_abs).max(first_abs);
        while abs <= last_abs {
            if let Some(h) = hit(abs) {
                return Ok(Some(h));
            }
            abs += 1;
        }
    }
    Ok(None)
}

/// Colores del tema activo: para responder OSC 10/11/4 (deteccion light/dark
/// de los CLIs) y como default de nuevos engines.
#[tauri::command]
pub fn engine_set_theme(
    state: State<'_, EngineState>,
    fg: String,
    bg: String,
    ansi: Vec<String>,
) -> Result<(), String> {
    let parse = |s: &str| -> (u8, u8, u8) {
        let h = s.trim_start_matches('#');
        if h.len() >= 6 {
            (
                u8::from_str_radix(&h[0..2], 16).unwrap_or(0),
                u8::from_str_radix(&h[2..4], 16).unwrap_or(0),
                u8::from_str_radix(&h[4..6], 16).unwrap_or(0),
            )
        } else {
            (0, 0, 0)
        }
    };
    let mut theme = ThemeColors {
        fg: parse(&fg),
        bg: parse(&bg),
        ansi: [(0, 0, 0); 16],
    };
    for (i, c) in ansi.iter().take(16).enumerate() {
        theme.ansi[i] = parse(c);
    }
    *state.theme.lock().unwrap() = Some(theme.clone());
    for session in state.sessions.lock().unwrap().values() {
        session.lock().unwrap().term.theme = theme.clone();
    }
    Ok(())
}

// ---------- shell integration (zsh, estilo VSCode: ZDOTDIR inyectado) ----------

pub fn shell_dir() -> std::path::PathBuf {
    crate::config::config_dir().join("shell")
}

const ZSHENV: &str = r#"# SFTerm shell integration (auto-generado en cada arranque; no editar)
if [[ -z "$SFTERM_USER_ZDOTDIR" ]]; then
  export SFTERM_USER_ZDOTDIR="$HOME"
fi
ZDOTDIR="$SFTERM_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zshenv" ]] && builtin source "$ZDOTDIR/.zshenv"
if [[ "$ZDOTDIR" == "$SFTERM_USER_ZDOTDIR" ]]; then
  # seguimos inyectados para .zprofile/.zshrc
  ZDOTDIR="$SFTERM_INJECT_DIR"
else
  # el .zshenv del usuario cambio ZDOTDIR: su arbol gana, nos apagamos
  SFTERM_USER_ZDOTDIR="$ZDOTDIR"
fi
"#;

const ZPROFILE: &str = r#"# SFTerm shell integration (auto-generado; no editar)
_sfterm_z="$ZDOTDIR"; ZDOTDIR="$SFTERM_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zprofile" ]] && builtin source "$ZDOTDIR/.zprofile"
ZDOTDIR="$_sfterm_z"; unset _sfterm_z
"#;

const ZLOGIN: &str = r#"# SFTerm shell integration (auto-generado; no editar)
_sfterm_z="$ZDOTDIR"; ZDOTDIR="$SFTERM_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zlogin" ]] && builtin source "$ZDOTDIR/.zlogin"
ZDOTDIR="$_sfterm_z"; unset _sfterm_z
"#;

const ZSHRC: &str = r#"# SFTerm shell integration (auto-generado; no editar)
_sfterm_z="$ZDOTDIR"; ZDOTDIR="$SFTERM_USER_ZDOTDIR"
[[ -f "$ZDOTDIR/.zshrc" ]] && builtin source "$ZDOTDIR/.zshrc"
ZDOTDIR="$_sfterm_z"; unset _sfterm_z

# OSC 133 (bloques) + OSC 7 (cwd) + OSC 633;E (comando). Solo bajo SFTerm.
if [[ "$TERM_PROGRAM" == "SFTerm" && -z "$SFTERM_SI_LOADED" ]]; then
  typeset -g SFTERM_SI_LOADED=1
  autoload -Uz add-zsh-hook

  __sfterm_cwd() {
    printf '\033]7;file://%s%s\007' "${HOST:-localhost}" "$PWD"
  }
  __sfterm_precmd() {
    local __ec=$?
    if [[ -n "$SFTERM_CMD_RUNNING" ]]; then
      printf '\033]133;D;%s\007' "$__ec"
      unset SFTERM_CMD_RUNNING
    fi
    __sfterm_cwd
    printf '\033]133;A\007'
  }
  __sfterm_preexec() {
    local __c="${1//$'\033'/ }"
    __c="${__c//$'\007'/ }"
    __c="${__c//$'\n'/  }"
    printf '\033]633;E;%s\007' "$__c"
    printf '\033]133;C\007'
    typeset -g SFTERM_CMD_RUNNING=1
  }
  add-zsh-hook precmd __sfterm_precmd
  add-zsh-hook preexec __sfterm_preexec
fi
"#;

/// Escribe los archivos de integracion (cada arranque: siempre frescos).
pub fn write_shell_files() {
    let dir = shell_dir();
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let _ = std::fs::write(dir.join(".zshenv"), ZSHENV);
    let _ = std::fs::write(dir.join(".zprofile"), ZPROFILE);
    let _ = std::fs::write(dir.join(".zlogin"), ZLOGIN);
    let _ = std::fs::write(dir.join(".zshrc"), ZSHRC);
}

/// Vuelca las respuestas del engine al writer del PTY (helper del reader thread).
pub fn write_responses(writer: &Arc<Mutex<Box<dyn Write + Send>>>, responses: Vec<u8>) {
    if responses.is_empty() {
        return;
    }
    if let Ok(mut w) = writer.lock() {
        let _ = w.write_all(&responses);
        let _ = w.flush();
    }
}
