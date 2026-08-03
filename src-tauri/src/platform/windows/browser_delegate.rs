//! WebView2 delegates which are safe to call from Wry callbacks.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

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

#[derive(Clone)]
struct PendingDownload {
    url: String,
    path: Option<PathBuf>,
}

#[derive(Default)]
struct DownloadState {
    next: u64,
    pending: HashMap<u32, PendingDownload>,
    entries: Vec<DownloadEntry>,
}

fn downloads() -> &'static Mutex<DownloadState> {
    static STATE: OnceLock<Mutex<DownloadState>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(DownloadState {
            next: 1,
            ..Default::default()
        })
    })
}

pub(crate) fn set_pending_download(
    view: u32,
    url: String,
    path: Option<String>,
) -> Result<(), String> {
    if let Some(path) = path.as_deref() {
        if !PathBuf::from(path).is_absolute() {
            return Err(format!("el destino de descarga debe ser absoluto: {path}"));
        }
    }
    downloads()
        .lock()
        .map_err(|_| "estado de descargas envenenado".to_string())?
        .pending
        .insert(
            view,
            PendingDownload {
                url,
                path: path.map(PathBuf::from),
            },
        );
    Ok(())
}

pub(crate) fn download_started(view: u32, url: String, dest: &mut PathBuf) -> bool {
    let Ok(mut state) = downloads().lock() else {
        return false;
    };
    if let Some(pending) = state.pending.remove(&view) {
        if pending.url == url {
            if let Some(path) = pending.path {
                *dest = path;
            }
        }
    }
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let id = state.next;
    state.next += 1;
    state.entries.push(DownloadEntry {
        id,
        url,
        dest: dest.to_string_lossy().into_owned(),
        state: "running".into(),
        error: None,
    });
    true
}

pub(crate) fn download_completed(url: String, path: Option<PathBuf>, success: bool) {
    if let Ok(mut state) = downloads().lock() {
        if let Some(entry) = state
            .entries
            .iter_mut()
            .rev()
            .find(|e| e.url == url && e.state == "running")
        {
            if let Some(path) = path {
                entry.dest = path.to_string_lossy().into_owned();
            }
            entry.state = if success { "done" } else { "failed" }.into();
            if !success {
                entry.error = Some("WebView2 no pudo completar la descarga".into());
            }
        }
    }
}

#[tauri::command]
pub async fn browser_set_files(app: AppHandle, id: u32, paths: Vec<String>) -> Result<(), String> {
    let app2 = app.clone();
    crate::browser::set_files_async(app2, id, paths).await
}

#[tauri::command]
pub async fn browser_dialogs(app: AppHandle) -> Result<Vec<DialogInfo>, String> {
    Ok(crate::browser::dialog_snapshot_async(app)
        .await?
        .into_iter()
        .map(|(id, view, kind, message, default_text)| DialogInfo {
            id,
            view,
            kind,
            message,
            default_text,
        })
        .collect())
}

#[tauri::command]
pub async fn browser_dialog_reply(
    app: AppHandle,
    id: u64,
    accept: bool,
    text: Option<String>,
) -> Result<(), String> {
    crate::browser::answer_dialog_async(app, id, accept, text).await
}

#[tauri::command]
pub async fn browser_downloads(_app: AppHandle) -> Result<Vec<DownloadEntry>, String> {
    Ok(downloads()
        .lock()
        .map_err(|_| "estado de descargas envenenado".to_string())?
        .entries
        .clone())
}

#[tauri::command]
pub async fn browser_download(
    app: AppHandle,
    id: u32,
    url: String,
    path: Option<String>,
) -> Result<(), String> {
    crate::browser::start_download_async(app, id, url, path).await
}
