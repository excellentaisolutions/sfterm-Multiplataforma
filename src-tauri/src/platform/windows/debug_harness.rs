use tauri::AppHandle;

pub fn start(app: AppHandle) {
    let _ = app;
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
