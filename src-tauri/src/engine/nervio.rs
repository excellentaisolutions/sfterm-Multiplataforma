//! El escaner del nervio aferente: detecta QUE cambio en el modelo semantico
//! de una terminal (bloques OSC 133 + actividad del PTY) y lo reporta como
//! eventos NUEVOS a un sink. Puro respecto al filesystem: el ticker le pasa
//! `events::emit` en produccion y los tests le pasan un Vec.
//!
//! Señales:
//!   block_start      — nacio un comando (OSC 133;C)
//!   block_end        — termino, con exit code y duracion (OSC 133;D)
//!   needs_attention  — un bloque sigue "corriendo" pero el PTY lleva
//!                      QUIET_MS sin producir un solo byte: casi siempre es
//!                      un agente/CLI esperando input humano. Una vez por bloque.

use super::term::Term;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{Duration, Instant};

/// Silencio (sin bytes del PTY) con un bloque corriendo => pide atencion.
pub const QUIET_MS: u64 = 120_000;

pub struct NervioTrack {
    started: HashSet<u64>,
    ended: HashSet<u64>,
    last_activity_counter: u64,
    last_activity_at: Instant,
    quiet_flagged: Option<u64>,
}

impl Default for NervioTrack {
    fn default() -> Self {
        NervioTrack {
            started: HashSet::new(),
            ended: HashSet::new(),
            last_activity_counter: 0,
            last_activity_at: Instant::now(),
            quiet_flagged: None,
        }
    }
}

/// Un paso del escaner. Idempotente: cada señal sale UNA sola vez.
pub fn scan(
    term: &Term,
    track: &mut NervioTrack,
    term_id: u32,
    now: Instant,
    sink: &mut dyn FnMut(&str, Value),
) {
    // actividad: el reader thread bumpea term.activity con cada feed de bytes
    if term.activity != track.last_activity_counter {
        track.last_activity_counter = term.activity;
        track.last_activity_at = now;
    }

    // bloques: nacimientos y muertes que no hemos reportado
    for b in term.blocks.list.iter() {
        if track.started.insert(b.id) {
            sink(
                "block_start",
                json!({ "term": term_id, "block": b.id, "cmd": b.cmd, "cwd": b.cwd }),
            );
        }
        if !b.running() && track.ended.insert(b.id) {
            sink(
                "block_end",
                json!({
                    "term": term_id,
                    "block": b.id,
                    "cmd": b.cmd,
                    "cwd": b.cwd,
                    "exit": b.exit,
                    "duration_ms": b.duration_ms,
                }),
            );
            if track.quiet_flagged == Some(b.id) {
                track.quiet_flagged = None;
            }
        }
    }

    // poda: ids que ya salieron de la historia (MAX_BLOCKS) no crecen los sets
    if let Some(front) = term.blocks.list.front().map(|b| b.id) {
        track.started.retain(|id| *id >= front);
        track.ended.retain(|id| *id >= front);
    }

    // silencio sospechoso: bloque corriendo + PTY mudo por QUIET_MS
    if let Some(b) = term.blocks.list.iter().rev().find(|b| b.running()) {
        let quiet_for = now.duration_since(track.last_activity_at);
        if quiet_for >= Duration::from_millis(QUIET_MS) && track.quiet_flagged != Some(b.id) {
            track.quiet_flagged = Some(b.id);
            sink(
                "needs_attention",
                json!({
                    "term": term_id,
                    "block": b.id,
                    "reason": "quiet",
                    "cmd": b.cmd,
                    "quiet_ms": quiet_for.as_millis() as u64,
                }),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk() -> (Term, vte::Parser) {
        (Term::new(80, 24, 500), vte::Parser::new())
    }

    fn feed(t: &mut Term, p: &mut vte::Parser, s: &str) {
        p.advance(t, s.as_bytes());
        t.activity = t.activity.wrapping_add(1); // igual que engine::feed
    }

    fn collect(term: &Term, track: &mut NervioTrack, now: Instant) -> Vec<(String, Value)> {
        let mut got = Vec::new();
        scan(term, track, 7, now, &mut |ev, f| got.push((ev.to_string(), f)));
        got
    }

    #[test]
    fn ciclo_de_vida_de_un_bloque() {
        let (mut t, mut p) = mk();
        let mut track = NervioTrack::default();
        let t0 = Instant::now();

        // prompt + comando + exec (OSC 133/633 reales, como los emite el zshrc)
        feed(&mut t, &mut p, "\x1b]133;A\x07$ ");
        feed(&mut t, &mut p, "\x1b]633;E;npm test\x07\x1b]133;C\x07");
        let evs = collect(&t, &mut track, t0);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].0, "block_start");
        assert_eq!(evs[0].1["cmd"], "npm test");
        assert_eq!(evs[0].1["term"], 7);

        // output + fin con exit 1
        feed(&mut t, &mut p, "FAIL: 3 tests\r\n\x1b]133;D;1\x07");
        let evs = collect(&t, &mut track, t0);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].0, "block_end");
        assert_eq!(evs[0].1["exit"], 1);
        assert!(evs[0].1["duration_ms"].is_u64());

        // re-escanear: idempotente, nada nuevo
        assert!(collect(&t, &mut track, t0).is_empty());
    }

    #[test]
    fn silencio_pide_atencion_una_sola_vez() {
        let (mut t, mut p) = mk();
        let mut track = NervioTrack::default();
        let t0 = Instant::now();

        feed(&mut t, &mut p, "\x1b]633;E;claude\x07\x1b]133;C\x07");
        let evs = collect(&t, &mut track, t0);
        assert_eq!(evs.len(), 1, "solo el block_start");

        // 2 minutos despues, sin un solo byte nuevo: atencion
        let later = t0 + Duration::from_millis(QUIET_MS + 1_000);
        let evs = collect(&t, &mut track, later);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].0, "needs_attention");
        assert_eq!(evs[0].1["reason"], "quiet");
        assert_eq!(evs[0].1["cmd"], "claude");

        // mas tarde todavia: NO se repite (una vez por bloque)
        let much_later = t0 + Duration::from_millis(QUIET_MS * 3);
        assert!(collect(&t, &mut track, much_later).is_empty());

        // el bloque termina: block_end sale y el flag se limpia
        feed(&mut t, &mut p, "\x1b]133;D;0\x07");
        let evs = collect(&t, &mut track, much_later);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].0, "block_end");
        assert_eq!(evs[0].1["exit"], 0);
    }

    #[test]
    fn actividad_reciente_no_es_silencio() {
        let (mut t, mut p) = mk();
        let mut track = NervioTrack::default();
        let t0 = Instant::now();

        feed(&mut t, &mut p, "\x1b]633;E;cargo build\x07\x1b]133;C\x07");
        collect(&t, &mut track, t0);

        // a los 100s llegan bytes (spinner/logs): el reloj de silencio se resetea
        let t1 = t0 + Duration::from_secs(100);
        feed(&mut t, &mut p, "compilando...\r\n");
        assert!(collect(&t, &mut track, t1).is_empty());

        // a los 200s (solo 100s desde la ultima actividad): sigue sin señal
        let t2 = t0 + Duration::from_secs(200);
        assert!(collect(&t, &mut track, t2).is_empty());

        // a los 100s + QUIET: ahora si
        let t3 = t1 + Duration::from_millis(QUIET_MS);
        let evs = collect(&t, &mut track, t3);
        assert_eq!(evs.len(), 1);
        assert_eq!(evs[0].0, "needs_attention");
    }
}
