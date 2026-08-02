//! Modelo semantico de bloques: cada comando + su output es una UNIDAD.
//! Alimentado por OSC 133 (A=prompt, C=exec, D=fin+exit) y OSC 633;E (comando)
//! que emite la shell integration de SFTerm (zsh hooks).

use serde::Serialize;
use std::collections::VecDeque;
use std::time::Instant;

const MAX_BLOCKS: usize = 500;

#[derive(Clone, Serialize)]
pub struct Block {
    pub id: u64,
    /// comando como lo tecleo el usuario (via OSC 633;E)
    pub cmd: String,
    pub cwd: String,
    /// fila ABSOLUTA donde empezo el prompt (para dibujar el separador)
    pub start_abs: u64,
    /// fila absoluta donde empezo el output
    pub output_abs: u64,
    /// fila absoluta al terminar (None = sigue corriendo)
    pub end_abs: Option<u64>,
    pub exit: Option<i32>,
    pub duration_ms: Option<u64>,
    /// true si un ED2/clear borro su contenido de pantalla: el bloque vive
    /// para el gate (historia) pero ya no se dibuja su separador/badge
    pub erased: bool,
    #[serde(skip)]
    started: Option<Instant>,
}

impl Block {
    pub fn running(&self) -> bool {
        self.end_abs.is_none()
    }
}

#[derive(Default)]
pub struct Blocks {
    pub list: VecDeque<Block>,
    next_id: u64,
    pending_prompt: Option<u64>,
    pending_cmd: Option<String>,
    /// version: sube con cada cambio (la UI/gate saben si refrescar)
    pub version: u64,
    /// hubo al menos un OSC 133;A: el shell ya pinto su PRIMER prompt real.
    /// pty.rs lo usa para teclear el comando inicial sin perder la carrera
    /// contra zshrc pesados (bug "cuerpos zsh mudos", 18 jul).
    pub ever_prompt: bool,
}

impl Blocks {
    pub fn new() -> Self {
        Blocks::default()
    }

    /// OSC 133;A — empieza un prompt (fin visual del bloque anterior)
    pub fn on_prompt(&mut self, abs: u64) {
        self.pending_prompt = Some(abs);
        self.ever_prompt = true;
        self.version += 1;
    }

    /// OSC 633;E — el comando que se va a ejecutar (preexec)
    pub fn on_cmd(&mut self, cmd: String) {
        self.pending_cmd = Some(cmd);
    }

    /// OSC 133;C — el comando arranco: nace el bloque
    pub fn on_exec(&mut self, abs: u64, cwd: String) {
        let id = self.next_id;
        self.next_id += 1;
        self.list.push_back(Block {
            id,
            cmd: self.pending_cmd.take().unwrap_or_default(),
            cwd,
            start_abs: self.pending_prompt.take().unwrap_or(abs),
            output_abs: abs,
            end_abs: None,
            exit: None,
            duration_ms: None,
            erased: false,
            started: Some(Instant::now()),
        });
        if self.list.len() > MAX_BLOCKS {
            self.list.pop_front();
        }
        self.version += 1;
    }

    /// OSC 133;D;exit — el comando termino
    pub fn on_finished(&mut self, exit: Option<i32>, abs: u64) {
        if let Some(b) = self.list.iter_mut().rev().find(|b| b.running()) {
            b.exit = exit;
            b.end_abs = Some(abs);
            b.duration_ms = b.started.map(|s| s.elapsed().as_millis() as u64);
            self.version += 1;
        }
    }

    pub fn last(&self) -> Option<&Block> {
        self.list.back()
    }

    /// bloques cuyo separador (start_abs) cae dentro de [from, to)
    pub fn visible_in(&self, from: u64, to: u64) -> Vec<&Block> {
        self.list
            .iter()
            .filter(|b| !b.erased && b.start_abs >= from && b.start_abs < to)
            .collect()
    }

    /// un clear (ED 2) borro la pantalla: los bloques que vivian ahi dejan
    /// de dibujarse (siguen en la historia del gate)
    pub fn erase_from(&mut self, abs_base: u64) {
        for b in self.list.iter_mut() {
            if b.start_abs >= abs_base || b.end_abs.is_none() {
                b.erased = true;
            }
        }
        self.version += 1;
    }
}
