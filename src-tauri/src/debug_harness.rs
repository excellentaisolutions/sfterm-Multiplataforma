//! Harness de testing E2E: SOLO se activa con SFTERM_DEBUG=1 (o dev build).
//!
//! Protocolo: escribir JSON en /tmp/sfterm-cmd.json →
//!   {"op":"snap","path":"/tmp/out.png"}   captura la ventana (WKWebView takeSnapshot,
//!                                          contenido propio: NO requiere TCC)
//!   {"op":"eval","js":"..."}              evalua JS en el webview (window.__sfterm)
//! El resultado se escribe en /tmp/sfterm-cmd.done (ok | error: ...).

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::NSBitmapImageFileType;
use objc2_foundation::NSDictionary;
use tauri::{AppHandle, Manager};

const CMD_FILE: &str = "/tmp/sfterm-cmd.json";
const DONE_FILE: &str = "/tmp/sfterm-cmd.done";

pub fn enabled() -> bool {
    cfg!(debug_assertions) || std::env::var("SFTERM_DEBUG").ok().as_deref() == Some("1")
}

pub fn start(app: AppHandle) {
    if !enabled() {
        return;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let Ok(raw) = std::fs::read_to_string(CMD_FILE) else {
            continue;
        };
        let _ = std::fs::remove_file(CMD_FILE);
        let cmd: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                let _ = std::fs::write(DONE_FILE, format!("error: json {e}"));
                continue;
            }
        };
        let op = cmd["op"].as_str().unwrap_or("");
        match op {
            "snap" => {
                let path = cmd["path"].as_str().unwrap_or("/tmp/sfterm-snap.png").to_string();
                snap(&app, path);
            }
            "eval" => {
                let js = cmd["js"].as_str().unwrap_or("").to_string();
                if let Some(w) = app.get_webview_window("main") {
                    let r = w.eval(js.as_str());
                    let _ = std::fs::write(
                        DONE_FILE,
                        if r.is_ok() { "ok".into() } else { format!("error: {r:?}") },
                    );
                } else {
                    let _ = std::fs::write(DONE_FILE, "error: no window");
                }
            }
            // evaljson: evalua una EXPRESION y escribe su resultado (JSON.stringify)
            // en DONE_FILE. REPL real dentro de la app.
            "evaljson" => {
                let js = cmd["js"].as_str().unwrap_or("null").to_string();
                if let Some(w) = app.get_webview_window("main") {
                    let wrapped = format!(
                        "(() => {{ try {{ return JSON.stringify((() => ({js}))()) ?? 'undefined'; }} catch (e) {{ return 'JSERROR: ' + (e && e.stack || e); }} }})()"
                    );
                    let res = w.with_webview(move |webview| unsafe {
                        use block2::RcBlock;
                        use objc2::runtime::AnyObject;
                        use objc2_foundation::{NSError, NSString};
                        use objc2_web_kit::WKWebView;
                        let wk_ptr = webview.inner() as *mut WKWebView;
                        let wk: &WKWebView = &*wk_ptr;
                        let script = NSString::from_str(&wrapped);
                        let block = RcBlock::new(
                            move |result: *mut AnyObject, err: *mut NSError| {
                                let out = if !result.is_null() {
                                    // el JS envuelto SIEMPRE devuelve string
                                    (*(result as *mut NSString)).to_string()
                                } else if !err.is_null() {
                                    format!("error: {:?}", &*err)
                                } else {
                                    "error: nil".into()
                                };
                                let _ = std::fs::write(DONE_FILE, out);
                            },
                        );
                        wk.evaluateJavaScript_completionHandler(&script, Some(&block));
                    });
                    if res.is_err() {
                        let _ = std::fs::write(DONE_FILE, format!("error: {res:?}"));
                    }
                } else {
                    let _ = std::fs::write(DONE_FILE, "error: no window");
                }
            }
            _ => {
                let _ = std::fs::write(DONE_FILE, "error: op desconocida");
            }
        }
    });
}

fn snap(app: &AppHandle, path: String) {
    snap_to(app, path, |r| {
        let _ = std::fs::write(
            DONE_FILE,
            match r {
                Ok(()) => "ok".to_string(),
                Err(e) => format!("error: {e}"),
            },
        );
    });
}

/// Captura la ventana a PNG y llama `done` al terminar. Compartido entre el
/// harness de debug (escribe DONE_FILE) y la puerta de agentes (gate.rs).
pub fn snap_to(
    app: &AppHandle,
    path: String,
    done: impl Fn(Result<(), String>) + Send + Sync + 'static,
) {
    let done = std::sync::Arc::new(done);
    let Some(window) = app.get_webview_window("main") else {
        done(Err("no window".into()));
        return;
    };
    let done2 = done.clone();
    let res = window.with_webview(move |webview| {
        unsafe {
            use block2::RcBlock;
            use objc2_app_kit::{NSBitmapImageRep, NSImage};
            use objc2_foundation::NSError;
            use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

            let mtm = objc2::MainThreadMarker::new()
                .expect("with_webview corre en main thread");
            let wk_ptr = webview.inner() as *mut WKWebView;
            let wk: &WKWebView = &*wk_ptr;
            let config = WKSnapshotConfiguration::new(mtm);
            let path2 = path.clone();
            let done3 = done2.clone();
            let block = RcBlock::new(move |img: *mut NSImage, err: *mut NSError| {
                if img.is_null() {
                    let msg = if err.is_null() {
                        "snapshot nil".to_string()
                    } else {
                        format!("snapshot error: {:?}", &*err)
                    };
                    done3(Err(msg));
                    return;
                }
                let image: &NSImage = &*img;
                let Some(tiff) = image.TIFFRepresentation() else {
                    done3(Err("sin tiff".into()));
                    return;
                };
                let Some(rep) = NSBitmapImageRep::imageRepWithData(&tiff) else {
                    done3(Err("sin bitmap rep".into()));
                    return;
                };
                let props: Retained<NSDictionary<_, AnyObject>> = NSDictionary::new();
                let Some(png) =
                    rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props)
                else {
                    done3(Err("sin png".into()));
                    return;
                };
                let bytes = png.to_vec();
                match std::fs::write(&path2, bytes) {
                    Ok(_) => done3(Ok(())),
                    Err(e) => done3(Err(format!("write {e}"))),
                }
            });
            wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
        }
    });
    if res.is_err() {
        done(Err(format!("with_webview {res:?}")));
    }
}
