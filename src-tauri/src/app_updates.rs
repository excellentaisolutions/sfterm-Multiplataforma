//! Canal de actualizacion controlado desde Rust.
//!
//! El webview solo puede consultar, descargar e instalar la actualizacion que
//! este modulo guarda como pendiente. La firma Ed25519 del feed sigue siendo
//! obligatoria en `tauri-plugin-updater`; aceptar una version anterior permite
//! un rollback operativo sin relajar la autenticidad del artefacto.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

pub struct PendingUpdate(pub Mutex<Option<Update>>);

impl Default for PendingUpdate {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    version: String,
    current_version: String,
    body: Option<String>,
    date: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        content_length: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Progress {
        chunk_length: usize,
    },
    Finished,
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<Option<UpdateMetadata>, String> {
    let updater = app
        .updater_builder()
        // Un rollback se publica como release firmada. La clave embebida sigue
        // siendo la frontera de confianza; solo cambia la comparacion SemVer.
        .version_comparator(|current, candidate| candidate.version != current)
        .build()
        .map_err(|error| error.to_string())?;
    let update = updater.check().await.map_err(|error| error.to_string())?;
    let metadata = update.as_ref().map(|candidate| UpdateMetadata {
        version: candidate.version.clone(),
        current_version: candidate.current_version.clone(),
        body: candidate.body.clone(),
        date: candidate.date.map(|value| value.to_string()),
    });

    *pending
        .0
        .lock()
        .map_err(|_| "estado del updater bloqueado".to_string())? = update;
    Ok(metadata)
}

#[tauri::command]
pub async fn update_install(
    pending: State<'_, PendingUpdate>,
    on_event: Channel<DownloadEvent>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "estado del updater bloqueado".to_string())?
        .take()
        .ok_or_else(|| "no hay una actualizacion pendiente".to_string())?;
    let mut started = false;

    update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(DownloadEvent::Started { content_length });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eventos_de_descarga_conservan_el_contrato_camel_case() {
        let value = serde_json::to_value(DownloadEvent::Started {
            content_length: Some(42),
        })
        .unwrap();
        assert_eq!(value["event"], "Started");
        assert_eq!(value["data"]["contentLength"], 42);
    }
}
