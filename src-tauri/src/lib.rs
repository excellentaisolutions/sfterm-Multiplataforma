mod attach;
#[cfg(target_os = "macos")]
mod browser;
#[cfg(target_os = "windows")]
#[path = "platform/windows/browser.rs"]
mod browser;
#[cfg(target_os = "macos")]
mod browser_delegate;
#[cfg(target_os = "windows")]
#[path = "platform/windows/browser_delegate.rs"]
mod browser_delegate;
mod checkpoints;
mod config;
#[cfg(target_os = "macos")]
mod debug_harness;
#[cfg(target_os = "windows")]
#[path = "platform/windows/debug_harness.rs"]
mod debug_harness;
mod engine;
mod events;
mod fonts;
mod fsx;
mod gate;
mod gitmirror;
mod hist;
mod metrics;
mod platform;
mod pty;
/// Daemon dueño de los PTYs: publico porque el mismo ejecutable lo arranca con
/// `--ptyd` desde `main.rs` (ver ptyd/mod.rs para el por que de no ser un
/// binario aparte).
pub mod ptyd;
mod ptyd_bridge;
mod session;
#[cfg(target_os = "macos")]
mod voice;
#[cfg(target_os = "windows")]
#[path = "platform/windows/voice.rs"]
mod voice;

/// ⌘R: relanza la app COMPLETA (proceso nuevo → toma el binario recien
/// instalado; la sesion se restaura sola como en cualquier arranque).
#[tauri::command]
fn app_relaunch(app: tauri::AppHandle) {
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // INSTANCIA UNICA (post-mortem 20 jul): un quit lento (13 PTYs) +
    // open inmediato dejaba DOS instancias vivas compartiendo gate/,
    // events.jsonl y session.json — la agonia de la vieja mato el piso
    // de la nueva y corrompio la sesion guardada. Segunda instancia →
    // solo enfoca la primera. Registrado PRIMERO (regla del plugin).
    //
    // EXCEPCION: con SFTERM_CONFIG_DIR (banco de pruebas) el candado se
    // OMITE — el peligro que motiva el plugin es COMPARTIR gate/session, y
    // un config dir redirigido no comparte nada con la instancia real. Sin
    // esta excepcion el banco es imposible: la instancia de prueba solo
    // enfocaria la ventana de la real y moriria.
    let aislada = std::env::var("SFTERM_CONFIG_DIR")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let builder = if aislada {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
    };
    builder
        .manage(pty::PtyState::default())
        .manage(engine::EngineState::default())
        .manage(voice::VoiceState::default())
        .manage(config::ConfigState {
            watcher: std::sync::Mutex::new(None),
        })
        .manage(fsx::FsState {
            watcher: std::sync::Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            app_relaunch,
            debug_harness::debug_harness_result,
            platform::platform_capabilities,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_interrupt,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_kill_all,
            pty::pty_adopt,
            pty::pty_daemon_info,
            pty::pty_detach_all,
            pty::term_session,
            hist::sessions_index,
            config::config_get,
            config::config_set,
            config::config_path,
            gitmirror::git_status,
            gitmirror::git_diff_file,
            gitmirror::git_state,
            gitmirror::git_log,
            gitmirror::git_commit_file,
            checkpoints::checkpoint_save,
            checkpoints::checkpoint_list,
            checkpoints::checkpoint_diff,
            checkpoints::checkpoint_diff_file,
            checkpoints::checkpoint_restore,
            fsx::fs_list_dir,
            fsx::fs_read_file,
            fsx::fs_home_dir,
            fsx::fs_temp_path,
            fsx::fs_index,
            fsx::fs_search,
            fsx::fs_watch_root,
            fsx::reveal_in_finder,
            fsx::fs_trash,
            fsx::open_url,
            fsx::fs_resolve_token,
            browser::browser_create,
            browser::browser_close,
            browser::browser_place,
            browser::browser_goto,
            browser::browser_nav,
            browser::browser_state,
            browser::browser_eval,
            browser::browser_snap,
            browser::browser_zoom,
            browser::browser_set_mobile,
            browser::browser_fullsnap,
            browser::browser_pdf,
            browser::browser_clear_session,
            browser_delegate::browser_set_files,
            browser_delegate::browser_dialogs,
            browser_delegate::browser_dialog_reply,
            browser_delegate::browser_downloads,
            browser_delegate::browser_download,
            attach::attach_save,
            attach::transcript_image,
            attach::local_image,
            fonts::fonts_list,
            session::session_save,
            session::session_load,
            gate::gate_poll,
            gate::gate_result,
            gate::snap_window,
            gate::shell_capture,
            engine::engine_subscribe,
            engine::engine_unsubscribe,
            engine::engine_set_viewport,
            engine::engine_text,
            engine::engine_blocks,
            engine::engine_block_text,
            engine::engine_range_text,
            engine::engine_find,
            engine::engine_set_theme,
            voice::voice_status,
            voice::voice_start,
            voice::voice_stop,
            voice::voice_cancel,
        ])
        .setup(|app| {
            config::migrate_legacy_layout().map_err(std::io::Error::other)?;
            config::start_config_watcher(app.handle().clone());
            metrics::start_metrics_loop(app.handle().clone());
            debug_harness::start(app.handle().clone());
            gate::ensure_dir();
            engine::write_shell_files();
            engine::start_ticker(app.handle().clone());
            // el puente al daemon de PTYs va AL FINAL del setup: necesita el
            // AppHandle para estados/eventos, y si no hay daemon la app queda
            // en modo clasico sin drama
            ptyd_bridge::init(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SFTerm");
}
