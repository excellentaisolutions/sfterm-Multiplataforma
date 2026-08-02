use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct VoiceState {
    active: Mutex<bool>,
}

#[tauri::command]
pub fn voice_status() -> serde_json::Value {
    serde_json::json!({
        "ffmpeg": false,
        "whisper": false,
        "model": null,
        "available": false,
        "reason": "captura WASAPI pendiente de la Fase 6"
    })
}

#[tauri::command]
pub fn voice_start(state: State<'_, VoiceState>) -> Result<(), String> {
    let _ = state.active.lock().map(|active| *active);
    Err("captura de voz WASAPI pendiente de la Fase 6".into())
}

#[tauri::command]
pub async fn voice_stop(state: State<'_, VoiceState>) -> Result<String, String> {
    let _ = state.active.lock().map(|active| *active);
    Err("no hay una grabación WASAPI activa".into())
}

#[tauri::command]
pub fn voice_cancel(state: State<'_, VoiceState>) -> Result<(), String> {
    if let Ok(mut active) = state.active.lock() {
        *active = false;
    }
    Ok(())
}
