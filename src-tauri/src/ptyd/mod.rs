//! `sfterm-ptyd` — el DUEÑO de los PTYs, fuera de la app.
//!
//! ## Por que existe
//!
//! Hasta hoy los PTYs eran hijos del proceso de la app (`pty.rs`). Reinstalar
//! un build = proceso nuevo = SIGHUP a cada `claude` = todas las conversaciones
//! muertas. Daniel lo dijo el 27 jul asi: "yo lo unico que quiero es que pueda
//! conservar las conversaciones, en cada rebuild".
//!
//! La unica forma real de conseguirlo es que los PTYs NO sean hijos de la app.
//! Este daemon los adopta: vive fuera, sobrevive a los rebuilds, y la app pasa
//! a ser un CLIENTE que se conecta, pinta y escribe. Cerrar la app deja de
//! matar nada; abrirla vuelve a enganchar donde estaba.
//!
//! ## Por que NO es un binario aparte
//!
//! Es el MISMO ejecutable de la app corriendo con `--ptyd` (ver `main.rs`).
//! Un segundo binario obligaria a empaquetarlo como `externalBin` de Tauri con
//! sufijo de target-triple y a mantener dos artefactos en sincronia; con el
//! flag, el daemon viaja gratis dentro del `.app` que ya se instala. No inicia
//! Tauri ni AppKit, asi que no aparece en el Dock. Y en macOS un binario
//! reemplazado en disco no molesta al proceso que ya lo tiene mapeado: el
//! daemon viejo sigue vivo con SUS terminales mientras entra la app nueva, que
//! es justamente el comportamiento que buscamos.
//!
//! ## Ciclo de vida
//!
//! - La app intenta conectar al socket; si no hay nadie, lanza el daemon.
//! - Cerrar la app: el daemon detecta la desconexion y NO mata nada.
//! - `Shutdown` (gesto explicito) mata todo y lo apaga. Nunca es automatico
//!   mientras queden terminales: un daemon sin clientes pero con conversaciones
//!   vivas es exactamente lo que queremos que exista.

pub mod client;
#[cfg(target_os = "windows")]
pub mod job;
pub mod proto;
pub mod server;
#[cfg(all(test, target_os = "macos"))]
mod tests;
pub mod transport;
#[cfg(all(test, target_os = "windows"))]
#[path = "windows_tests.rs"]
mod windows_e2e_tests;

use std::path::PathBuf;

fn base_dir() -> PathBuf {
    // Deriva del config_dir de la app (respeta SFTERM_CONFIG_DIR): un banco de
    // pruebas con config propio gana automaticamente daemon propio — socket y
    // log incluidos — sin rozar el que tiene las conversaciones reales.
    let d = crate::config::state_dir();
    let _ = std::fs::create_dir_all(&d);
    d
}

/// Socket de control. Va en `~/.config/sfterm/` (no en `/tmp`) para que no se
/// lo lleve una limpieza del sistema con terminales vivas colgando de el.
/// `SFTERM_PTYD_SOCK` lo redirige: es como las pruebas hablan con un daemon
/// propio sin tocar el que tiene las conversaciones de verdad abiertas.
pub fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("SFTERM_PTYD_SOCK") {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    base_dir().join("ptyd.sock")
}

#[cfg(target_os = "windows")]
pub fn pipe_name() -> String {
    if let Ok(name) = std::env::var("SFTERM_PTYD_PIPE") {
        if name.starts_with(r"\\.\pipe\") {
            return name;
        }
    }
    pipe_name_for_base(&base_dir(), windows_session_id())
}

#[cfg(target_os = "windows")]
fn pipe_name_for_base(base: &std::path::Path, session_id: u32) -> String {
    let key = base.to_string_lossy().to_lowercase();
    let hash = key.bytes().fold(0xcbf29ce484222325u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
    });
    format!(
        r"\\.\pipe\sfterm-ptyd-{session_id}-{hash:016x}-v{}",
        proto::PROTO
    )
}

#[cfg(target_os = "windows")]
fn windows_session_id() -> u32 {
    #[link(name = "kernel32")]
    extern "system" {
        fn ProcessIdToSessionId(process_id: u32, session_id: *mut u32) -> i32;
    }
    let mut session = u32::MAX;
    if unsafe { ProcessIdToSessionId(std::process::id(), &mut session) } == 0 {
        u32::MAX
    } else {
        session
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    #[test]
    fn pipe_aislada_por_config_y_override_validado() {
        let name = super::pipe_name();
        assert!(name.starts_with(r"\\.\pipe\sfterm-ptyd-"));
        assert!(!name.contains('/') && !name.contains(':'));
        assert!(name.ends_with(&format!("-v{}", super::proto::PROTO)));

        let a = super::pipe_name_for_base(std::path::Path::new(r"C:\a"), 7);
        let b = super::pipe_name_for_base(std::path::Path::new(r"C:\b"), 7);
        assert_ne!(a, b, "dos config dirs no pueden compartir daemon");
    }
}

pub fn log_path() -> PathBuf {
    if let Ok(p) = std::env::var("SFTERM_PTYD_SOCK") {
        if !p.is_empty() {
            return PathBuf::from(format!("{p}.log"));
        }
    }
    base_dir().join("ptyd.log")
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
