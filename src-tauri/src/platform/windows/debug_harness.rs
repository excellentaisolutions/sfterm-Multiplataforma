use tauri::{AppHandle, Manager};

fn command_file() -> std::path::PathBuf {
    std::env::var_os("SFTERM_DEBUG_CMD")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("sfterm-cmd.json"))
}

fn done_file() -> std::path::PathBuf {
    std::env::var_os("SFTERM_DEBUG_DONE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("sfterm-cmd.done"))
}

pub fn enabled() -> bool {
    cfg!(debug_assertions) || std::env::var("SFTERM_DEBUG").ok().as_deref() == Some("1")
}

pub fn start(app: AppHandle) {
    if !enabled() {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(200));
        let command = command_file();
        let Ok(raw) = std::fs::read_to_string(&command) else {
            continue;
        };
        let _ = std::fs::remove_file(&command);
        let parsed: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(error) => {
                let _ = std::fs::write(done_file(), format!("error: json {error}"));
                continue;
            }
        };
        let Some(window) = app.get_webview_window("main") else {
            let _ = std::fs::write(done_file(), "error: no window");
            continue;
        };
        let js = parsed["js"].as_str().unwrap_or("");
        match parsed["op"].as_str().unwrap_or("") {
            "eval" => {
                let result = window.eval(js);
                let _ = std::fs::write(
                    done_file(),
                    result.map_or_else(|error| format!("error: {error}"), |_| "ok".into()),
                );
            }
            "evaljson" => {
                let wrapped = format!(
                    "(() => {{ let value; try {{ value = JSON.stringify((() => ({js}))()) ?? 'undefined'; }} catch (e) {{ value = 'JSERROR: ' + (e && e.stack || e); }} window.__TAURI_INTERNALS__.invoke('debug_harness_result', {{ value }}); }})()"
                );
                if let Err(error) = window.eval(&wrapped) {
                    let _ = std::fs::write(done_file(), format!("error: {error}"));
                }
            }
            _ => {
                let _ = std::fs::write(done_file(), "error: op desconocida");
            }
        }
    });
}

#[tauri::command]
pub fn debug_harness_result(value: String) -> Result<(), String> {
    if !enabled() {
        return Err("debug harness desactivado".into());
    }
    std::fs::write(done_file(), value).map_err(|error| error.to_string())
}

pub fn snap_to(
    app: &AppHandle,
    path: String,
    done: impl Fn(Result<(), String>) + Send + Sync + 'static,
) {
    let _ = (app, path);
    done(Err(
        "snapshot de ventana pendiente del adaptador WebView2 de Windows".into(),
    ));
}
