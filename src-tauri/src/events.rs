//! Nervio aferente: el canal por donde la APP habla sola (16 jul 2026).
//!
//! Los 10 verbos del gate son de IDA (el agente pregunta, la app responde).
//! Este modulo es la VUELTA: la app escribe sola lo que pasa en el piso
//! (bloques que terminan con exit/duracion, terminales que piden atencion,
//! vida/muerte de shells) en un JSONL append-only:
//!
//!   ~/.config/sfterm/gate/events.jsonl
//!
//! Los agentes lo leen DIRECTO del archivo (gate.py events) — sin round-trip
//! por la puerta, y la historia sobrevive aunque la app se cierre. El puente
//! a Levy (scripts/nervio-bridge.py) filtra señal de ruido y la sube al
//! agent-server. Filosofia: watchdog silencioso — el canal es crudo aqui,
//! el criterio vive en el puente.
//!
//! Regla de oro: el nervio JAMAS tira la app. Todo error de IO se ignora.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());

/// Rotacion simple: al pasar este tamaño, events.jsonl -> events.jsonl.1
const MAX_BYTES: u64 = 5 * 1024 * 1024;

pub fn path() -> PathBuf {
    crate::gate::gate_dir().join("events.jsonl")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Emite un evento al canal de produccion. `fields` es un objeto JSON que se
/// funde con {"t": epoch_ms, "ev": <ev>}.
pub fn emit(ev: &str, fields: Value) {
    emit_to(&path(), now_ms(), ev, fields);
}

/// Nucleo testeable (el path y el timestamp entran de afuera): escribe UNA
/// linea JSONL, con rotacion. Serializado por un lock de proceso para que
/// ticker/metrics/pty no intercalen bytes.
pub fn emit_to(p: &Path, t: u64, ev: &str, fields: Value) {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut obj = serde_json::json!({ "t": t, "ev": ev });
    if let (Some(o), Value::Object(f)) = (obj.as_object_mut(), fields) {
        for (k, v) in f {
            o.insert(k, v);
        }
    }
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(md) = std::fs::metadata(p) {
        if md.len() > MAX_BYTES {
            let _ = std::fs::rename(p, p.with_extension("jsonl.1"));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = writeln!(f, "{obj}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("sfterm-nervio-{}-{}", name, std::process::id()))
    }

    #[test]
    fn escribe_lineas_jsonl_validas() {
        let dir = tmp("emit");
        let _ = std::fs::remove_dir_all(&dir);
        let p = dir.join("events.jsonl");
        emit_to(&p, 111, "block_end", serde_json::json!({"term": 3, "exit": 1, "cmd": "npm test"}));
        emit_to(&p, 222, "bell", serde_json::json!({"term": 2}));
        let raw = std::fs::read_to_string(&p).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 2);
        let v: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(v["t"], 111);
        assert_eq!(v["ev"], "block_end");
        assert_eq!(v["term"], 3);
        assert_eq!(v["exit"], 1);
        assert_eq!(v["cmd"], "npm test");
        let v2: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(v2["ev"], "bell");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rota_al_pasar_el_limite() {
        let dir = tmp("rota");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("events.jsonl");
        // archivo gordo artificial (> MAX_BYTES) sin escribir 5MB reales
        let f = std::fs::File::create(&p).unwrap();
        f.set_len(MAX_BYTES + 1).unwrap();
        drop(f);
        emit_to(&p, 333, "term_spawned", serde_json::json!({"term": 9}));
        assert!(p.with_extension("jsonl.1").exists(), "debio rotar a .1");
        let raw = std::fs::read_to_string(&p).unwrap();
        assert_eq!(raw.lines().count(), 1, "el archivo nuevo solo trae el evento fresco");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
