//! Dictado por voz del chat: graba el mic con ffmpeg (avfoundation) y
//! transcribe LOCAL con whisper-cli (whisper.cpp). Cero APIs de pago, cero
//! dependencia del webview (getUserMedia en WKWebView es una loteria de
//! permisos): el audio se captura desde el proceso de la app, que es quien
//! porta el permiso de microfono (NSMicrophoneUsageDescription en Info.plist).
//!
//! Flujo: voice_start → ffmpeg graba a wav 16k mono · voice_stop → SIGINT
//! (finaliza el wav limpio) → whisper-cli → texto. voice_cancel descarta.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct VoiceState {
    rec: Mutex<Option<(Child, String)>>,
}

/// Resuelve un binario probando rutas fijas de Homebrew/sistema y despues
/// `command -v` en un login shell (el PATH del .app NO trae /opt/homebrew).
fn find_bin(name: &str) -> Option<String> {
    for p in [
        format!("/opt/homebrew/bin/{name}"),
        format!("/usr/local/bin/{name}"),
        format!("/usr/bin/{name}"),
    ] {
        if std::path::Path::new(&p).exists() {
            return Some(p);
        }
    }
    let out = Command::new("/bin/zsh")
        .args(["-lc", &format!("command -v {name}")])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

fn models_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".config/sfterm/models")
}

/// Elige el mejor modelo ggml disponible en ~/.config/sfterm/models
/// (o el que apunte SFTERM_WHISPER_MODEL). Orden de calidad descendente.
pub fn pick_model() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SFTERM_WHISPER_MODEL") {
        let p = PathBuf::from(p);
        if p.exists() {
            return Some(p);
        }
    }
    let dir = models_dir();
    let mut cands: Vec<PathBuf> = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            let n = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
            n.starts_with("ggml-") && n.ends_with(".bin")
        })
        .collect();
    if cands.is_empty() {
        return None;
    }
    cands.sort_by_key(|p| rank_model(p.file_name().and_then(|s| s.to_str()).unwrap_or("")));
    cands.into_iter().next()
}

/// Menor = mejor. large-v3-turbo gana; tiny pierde.
pub fn rank_model(name: &str) -> u8 {
    for (i, pat) in ["large-v3-turbo", "large", "medium", "small", "base", "tiny"]
        .iter()
        .enumerate()
    {
        if name.contains(pat) {
            return i as u8;
        }
    }
    9
}

/// ¿Que piezas del dictado estan instaladas? El frontend lo usa para dar un
/// mensaje util (que falta y como instalarlo) en lugar de fallar a ciegas.
#[tauri::command]
pub fn voice_status() -> serde_json::Value {
    serde_json::json!({
        "ffmpeg": find_bin("ffmpeg").is_some(),
        "whisper": find_bin("whisper-cli").is_some(),
        "model": pick_model().map(|p| p.to_string_lossy().to_string()),
    })
}

#[tauri::command]
pub fn voice_start(state: State<'_, VoiceState>) -> Result<(), String> {
    let mut rec = state.rec.lock().unwrap();
    if rec.is_some() {
        return Err("ya hay una grabacion en curso".into());
    }
    let ffmpeg = find_bin("ffmpeg").ok_or("ffmpeg no esta instalado (brew install ffmpeg)")?;
    let wav = std::env::temp_dir()
        .join(format!("sfterm-dictado-{}.wav", std::process::id()))
        .to_string_lossy()
        .to_string();

    let spawn = |device: &str| -> Result<Child, String> {
        Command::new(&ffmpeg)
            .args([
                "-hide_banner", "-loglevel", "error",
                "-f", "avfoundation", "-i", device,
                "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                "-y", &wav,
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())
    };

    // ":default" = mic por defecto del sistema; si el ffmpeg local no lo
    // soporta, cae al primer dispositivo de audio (":0")
    let mut child = spawn(":default")?;
    std::thread::sleep(std::time::Duration::from_millis(400));
    if let Ok(Some(status)) = child.try_wait() {
        if !status.success() {
            child = spawn(":0")?;
            std::thread::sleep(std::time::Duration::from_millis(400));
            if let Ok(Some(s2)) = child.try_wait() {
                if !s2.success() {
                    return Err("ffmpeg no pudo abrir el microfono (¿permiso denegado?)".into());
                }
            }
        }
    }
    *rec = Some((child, wav));
    Ok(())
}

/// Detiene la grabacion con SIGINT (ffmpeg finaliza el wav bien formado),
/// espera el cierre y transcribe. Bloqueante: correr como comando async.
#[tauri::command]
pub async fn voice_stop(state: State<'_, VoiceState>) -> Result<String, String> {
    let (child, wav) = state
        .rec
        .lock()
        .unwrap()
        .take()
        .ok_or("no hay grabacion en curso")?;
    let wav2 = wav.clone();
    let text = tauri::async_runtime::spawn_blocking(move || stop_and_transcribe(child, &wav2))
        .await
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&wav);
    text
}

fn stop_and_transcribe(mut child: Child, wav: &str) -> Result<String, String> {
    unsafe { libc::kill(child.id() as i32, libc::SIGINT) };
    let t0 = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if t0.elapsed().as_secs() < 3 => {
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    let size = std::fs::metadata(wav).map(|m| m.len()).unwrap_or(0);
    // wav 16k mono s16 = 32KB/seg; menos de ~0.4s no es dictado
    if size < 12_000 {
        return Err("no se grabo audio (muy corto o mic mudo)".into());
    }
    let whisper =
        find_bin("whisper-cli").ok_or("whisper-cli no esta instalado (brew install whisper-cpp)")?;
    let model = pick_model().ok_or(
        "falta el modelo de voz: corre scripts/setup-stt.sh (descarga whisper a ~/.config/sfterm/models)",
    )?;
    let out = Command::new(&whisper)
        .args([
            "-m", &model.to_string_lossy(),
            "-l", "es",
            "-nt", "-np",
            "-f", wav,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("whisper fallo: {}", err.chars().take(300).collect::<String>()));
    }
    let text = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        return Err("no se detecto voz en el audio".into());
    }
    Ok(text)
}

/// Descarta la grabacion en curso sin transcribir (Esc durante el dictado).
#[tauri::command]
pub fn voice_cancel(state: State<'_, VoiceState>) -> Result<(), String> {
    if let Some((mut child, wav)) = state.rec.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_file(&wav);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::rank_model;

    #[test]
    fn rank_model_prefiere_turbo_sobre_small_y_tiny() {
        assert!(rank_model("ggml-large-v3-turbo-q5_0.bin") < rank_model("ggml-small-q5_1.bin"));
        assert!(rank_model("ggml-small-q5_1.bin") < rank_model("ggml-base.bin"));
        assert!(rank_model("ggml-base.bin") < rank_model("ggml-tiny.bin"));
        assert_eq!(rank_model("otro.bin"), 9);
    }
}
