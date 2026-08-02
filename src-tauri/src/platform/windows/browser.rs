use serde::Serialize;
use tauri::AppHandle;

const UNAVAILABLE: &str =
    "el host de navegador WebView2 se implementará en la Fase 4 de la migración Windows";

fn unavailable<T>() -> Result<T, String> {
    Err(UNAVAILABLE.into())
}

#[derive(Serialize, Clone)]
pub struct BrowserState {
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub progress: f64,
    pub can_back: bool,
    pub can_forward: bool,
}

#[tauri::command]
pub async fn browser_create(app: AppHandle, id: u32) -> Result<(), String> {
    let _ = (app, id);
    unavailable()
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, id: u32) -> Result<(), String> {
    let _ = (app, id);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_place(
    app: AppHandle,
    id: u32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    inner_w: f64,
    visible: bool,
    backstage: Option<bool>,
) -> Result<(), String> {
    let _ = (app, id, x, y, w, h, inner_w, visible, backstage);
    unavailable()
}

#[tauri::command]
pub async fn browser_goto(app: AppHandle, id: u32, url: String) -> Result<String, String> {
    let _ = (app, id, url);
    unavailable()
}

#[tauri::command]
pub async fn browser_zoom(app: AppHandle, id: u32, factor: f64) -> Result<(), String> {
    let _ = (app, id, factor);
    unavailable()
}

#[tauri::command]
pub async fn browser_set_mobile(app: AppHandle, id: u32, on: bool) -> Result<(), String> {
    let _ = (app, id, on);
    unavailable()
}

#[tauri::command]
pub async fn browser_nav(app: AppHandle, id: u32, action: String) -> Result<(), String> {
    let _ = (app, id, action);
    unavailable()
}

#[tauri::command]
pub async fn browser_state(app: AppHandle, id: u32) -> Result<BrowserState, String> {
    let _ = (app, id);
    unavailable()
}

#[tauri::command]
pub async fn browser_eval(app: AppHandle, id: u32, js: String) -> Result<String, String> {
    let _ = (app, id, js);
    unavailable()
}

#[tauri::command]
pub async fn browser_snap(
    app: AppHandle,
    id: u32,
    path: String,
    w: Option<f64>,
    h: Option<f64>,
) -> Result<String, String> {
    let _ = (app, id, path, w, h);
    unavailable()
}

#[tauri::command]
pub async fn browser_fullsnap(
    app: AppHandle,
    id: u32,
    path: String,
    height: f64,
) -> Result<String, String> {
    let _ = (app, id, path, height);
    unavailable()
}

#[tauri::command]
pub async fn browser_clear_session(app: AppHandle) -> Result<u64, String> {
    let _ = app;
    unavailable()
}

#[tauri::command]
pub async fn browser_pdf(app: AppHandle, id: u32, path: String) -> Result<String, String> {
    let _ = (app, id, path);
    unavailable()
}
