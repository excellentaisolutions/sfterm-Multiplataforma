//! Puerta de agentes (SIEMPRE activa, a diferencia del harness de debug):
//! deja que un agente local (Levy via Claude Code, scripts, crons) OPERE la app.
//!
//! Protocolo por archivos en el state dir local de SFTerm (solo el usuario):
//!   cliente escribe  cmd-<id>.json   {"op": "list" | "spawn" | "send" | "read"
//!                                      | "show" | "close" | "snap" | "ping", ...}
//!   la app responde  res-<id>.json   {"ok": true, "data": ...} | {"ok": false, "error"}
//!
//! El lado JS (src/core/gate.ts) hace polling via gate_poll/gate_result y ejecuta
//! las ops con el estado real de la app. Cliente de referencia: scripts/gate.py.

use tauri::AppHandle;

pub fn gate_dir() -> std::path::PathBuf {
    crate::config::state_dir().join("gate")
}

/// Crea el directorio de la puerta al arrancar (con permisos solo-usuario).
pub fn ensure_dir() {
    let dir = gate_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = crate::platform::permissions::restrict_directory_to_user(&dir);
}

/// Devuelve el siguiente comando pendiente (y lo consume), o null.
/// El payload trae "__id" para que el JS responda con gate_result.
#[tauri::command]
pub fn gate_poll() -> Option<serde_json::Value> {
    let dir = gate_dir();
    let entries = std::fs::read_dir(&dir).ok()?;
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with("cmd-") || !name.ends_with(".json") {
            continue;
        }
        let raw = std::fs::read_to_string(e.path()).unwrap_or_default();
        let _ = std::fs::remove_file(e.path());
        let id = name
            .trim_start_matches("cmd-")
            .trim_end_matches(".json")
            .to_string();
        let mut v: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(err) => {
                let _ = gate_result(id, format!("{{\"ok\":false,\"error\":\"json: {err}\"}}"));
                continue;
            }
        };
        v["__id"] = serde_json::Value::String(id);
        return Some(v);
    }
    None
}

/// Escribe la respuesta de un comando (atomico: tmp + rename).
#[tauri::command]
pub fn gate_result(id: String, json: String) -> Result<(), String> {
    let dir = gate_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let tmp = dir.join(format!(".res-{safe}.tmp"));
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join(format!("res-{safe}.json"))).map_err(|e| e.to_string())
}

/// Screenshot de la ventana para la puerta (WKWebView takeSnapshot, sin TCC).
#[tauri::command]
pub async fn snap_window(app: AppHandle, path: String) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    crate::debug_harness::snap_to(&app, path, move |r| {
        let _ = tx.send(r);
    });
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|_| "timeout de snapshot".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Corre un comando de shell y captura stdout (para kickoff de presets).
/// Usa zsh login en macOS y PowerShell sin perfil en Windows. Timeout: 20s.
#[tauri::command]
pub async fn shell_capture(cmd: String, cwd: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        use std::process::Stdio;
        let mut c = crate::platform::shell::capture_command(&cmd);
        c.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(d) = &cwd {
            c.current_dir(d);
        }
        let mut child = c.spawn().map_err(|e| e.to_string())?;
        // leer stdout en paralelo: si el hijo llena el pipe, try_wait jamas avanza
        let stdout = child.stdout.take();
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(mut so) = stdout {
                let _ = so.read_to_string(&mut s);
            }
            s
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if std::time::Instant::now() > deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("kickoff: timeout (20s)".into());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(reader.join().unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}
