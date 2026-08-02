use std::path::PathBuf;

fn session_file() -> PathBuf {
    crate::config::state_dir().join("session.json")
}

/// Estado de sesion (layout + paneles + cwd + root del arbol). Lo escribe la UI
/// con debounce; NO es user-facing (el user-facing es config.toml).
#[tauri::command]
pub fn session_save(data: serde_json::Value) -> Result<(), String> {
    std::fs::create_dir_all(crate::config::state_dir()).map_err(|e| e.to_string())?;
    std::fs::write(
        session_file(),
        serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_load() -> Result<Option<serde_json::Value>, String> {
    let path = session_file();
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&raw).ok())
}
