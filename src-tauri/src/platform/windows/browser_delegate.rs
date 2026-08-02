use serde::Serialize;
use tauri::AppHandle;

const UNAVAILABLE: &str = "las delegaciones y descargas WebView2 se implementarán en la Fase 4";

fn unavailable<T>() -> Result<T, String> {
    Err(UNAVAILABLE.into())
}

#[derive(Serialize, Clone)]
pub struct DialogInfo {
    pub id: u64,
    pub view: u32,
    pub kind: String,
    pub message: String,
    pub default_text: String,
}

#[derive(Serialize, Clone)]
pub struct DownloadEntry {
    pub id: u64,
    pub url: String,
    pub dest: String,
    pub state: String,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn browser_set_files(app: AppHandle, id: u32, paths: Vec<String>) -> Result<(), String> {
    let _ = (app, id, paths);
    unavailable()
}

#[tauri::command]
pub async fn browser_dialogs(app: AppHandle) -> Result<Vec<DialogInfo>, String> {
    let _ = app;
    Ok(Vec::new())
}

#[tauri::command]
pub async fn browser_dialog_reply(
    app: AppHandle,
    id: u64,
    accept: bool,
    text: Option<String>,
) -> Result<(), String> {
    let _ = (app, id, accept, text);
    unavailable()
}

#[tauri::command]
pub async fn browser_downloads(app: AppHandle) -> Result<Vec<DownloadEntry>, String> {
    let _ = app;
    Ok(Vec::new())
}

#[tauri::command]
pub async fn browser_download(
    app: AppHandle,
    id: u32,
    url: String,
    path: Option<String>,
) -> Result<(), String> {
    let _ = (app, id, url, path);
    unavailable()
}
