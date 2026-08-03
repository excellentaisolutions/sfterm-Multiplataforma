//! Unprivileged WebView2 host used by the agent browser on Windows.
//!
//! This deliberately uses Wry directly instead of creating a Tauri webview.
//! No IPC handler, custom protocol or host object is registered, therefore an
//! arbitrary page has no path to `invoke` application commands.  All control
//! remains pull-only through the Rust commands in this module.

use base64::Engine as _;
use serde::Serialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Deferral, ICoreWebView2ScriptDialogOpeningEventArgs,
    ICoreWebView2Settings2, ICoreWebView2_7, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT, COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM,
    COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT,
};
use webview2_com::{
    CapturePreviewCompletedHandler, PrintToPdfCompletedHandler, ScriptDialogOpeningEventHandler,
};
use windows::core::{Interface, HSTRING};
use windows::Win32::System::Com::{STGM_CREATE, STGM_READWRITE, STGM_SHARE_EXCLUSIVE};
use windows::Win32::UI::Shell::SHCreateStreamOnFileEx;
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{PageLoadEvent, Rect, WebContext, WebView, WebViewBuilder, WebViewExtWindows};

const UA_DESKTOP: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0";
const UA_MOBILE: &str = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36";
const SNAP_FALLBACK: (f64, f64) = (1280.0, 900.0);

// Document-start instrumentation mirrors the macOS browser.  It only writes
// into page-local buffers; there is intentionally no native message channel.
const INIT_JS: &str = r#"(() => {
  if (window.__sfDebug) return;
  const D = { console: [], net: [] }; window.__sfDebug = D;
  const push=(a,x,n)=>{a.push(x);if(a.length>n)a.splice(0,a.length-n)};
  const fmt=(x)=>{try{return typeof x==='string'?x:JSON.stringify(x)}catch{return String(x)}};
  for(const level of ['log','info','warn','error','debug']) { const orig=console[level]?.bind(console);
    console[level]=(...args)=>{push(D.console,{t:Date.now(),level,text:args.map(fmt).join(' ').slice(0,500)},300);orig?.(...args)} }
  addEventListener('error',e=>push(D.console,{t:Date.now(),level:'exception',text:String(e.message||e).slice(0,500)},300));
  addEventListener('unhandledrejection',e=>push(D.console,{t:Date.now(),level:'rejection',text:fmt(e.reason).slice(0,500)},300));
  const rec=x=>push(D.net,x,150), ofetch=window.fetch;
  window.fetch=function(...args){const t=Date.now(),url=String(typeof args[0]==='string'?args[0]:args[0]?.url||'').slice(0,300),method=String(args[1]?.method||args[0]?.method||'GET').toUpperCase();return ofetch.apply(this,args).then(r=>{const x={t,kind:'fetch',method,url,status:r.status,ok:r.ok,ms:Date.now()-t};rec(x);try{if(/json|text|xml|javascript/.test(r.headers.get('content-type')||''))r.clone().text().then(b=>x.body=b.slice(0,2048),()=>{})}catch{}return r},e=>{rec({t,kind:'fetch',method,url,error:String(e).slice(0,200),ms:Date.now()-t});throw e})};
  const xo=XMLHttpRequest.prototype.open,xs=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u,...r){this.__sf={method:String(m).toUpperCase(),url:String(u).slice(0,300)};return xo.call(this,m,u,...r)};
  XMLHttpRequest.prototype.send=function(...a){const meta=this.__sf||{},t=Date.now();this.addEventListener('loadend',()=>{const x={t,kind:'xhr',method:meta.method||'GET',url:meta.url||'',status:this.status,ok:this.status>=200&&this.status<400,ms:Date.now()-t};try{if(!this.responseType||this.responseType==='text')x.body=String(this.responseText||'').slice(0,2048)}catch{}rec(x)});return xs.apply(this,a)};
  addEventListener('keydown',ev=>{if(!ev.ctrlKey||ev.metaKey||ev.altKey)return;const map={l:'url',r:'reload',f:'find','[':'back',']':'forward','=':'zin','+':'zin','-':'zout','_':'zout','0':'zreset'};const cmd=map[ev.key]||map[ev.key.toLowerCase()];if(!cmd)return;if(ev.shiftKey&&!['zin','zout','zreset'].includes(cmd))return;ev.preventDefault();ev.stopPropagation();(window.__sfKeys=window.__sfKeys||[]).push(cmd)},true);
})();"#;

#[derive(Clone, Default)]
struct RuntimeState {
    loading: bool,
    progress: f64,
    title: String,
    last_size: Option<(f64, f64)>,
    mobile: bool,
}

pub(crate) struct PendingDialog {
    pub id: u64,
    pub view: u32,
    pub kind: String,
    pub message: String,
    pub default_text: String,
    args: ICoreWebView2ScriptDialogOpeningEventArgs,
    deferral: ICoreWebView2Deferral,
}

thread_local! {
    static VIEWS: RefCell<HashMap<u32, WebView>> = RefCell::new(HashMap::new());
    static STATES: RefCell<HashMap<u32, RuntimeState>> = RefCell::new(HashMap::new());
    static CONTEXT: RefCell<Option<WebContext>> = const { RefCell::new(None) };
    static DIALOGS: RefCell<Vec<PendingDialog>> = const { RefCell::new(Vec::new()) };
    static NEXT_DIALOG: RefCell<u64> = const { RefCell::new(1) };
}

async fn run_main<T, F>(app: AppHandle, secs: u64, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(mpsc::Sender<Result<T, String>>) + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || f(tx))
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(secs))
            .map_err(|_| "timeout esperando WebView2".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

fn with_view<T>(id: u32, f: impl FnOnce(&WebView) -> Result<T, String>) -> Result<T, String> {
    VIEWS.with(|views| {
        let views = views.borrow();
        f(views
            .get(&id)
            .ok_or_else(|| format!("no existe el navegador {id}"))?)
    })
}

fn context_dir() -> PathBuf {
    crate::config::state_dir().join("browser-webview2")
}

fn wry_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn search_encode(query: &str) -> String {
    let mut out = String::with_capacity(query.len() * 2);
    for byte in query.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn normalize_url(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err("url vacia".into());
    }
    if value.starts_with("http://")
        || value.starts_with("https://")
        || value == "about:blank"
        || value.starts_with("file://")
    {
        return Ok(value.to_string());
    }
    let path = Path::new(value);
    if path.is_absolute() || value.starts_with("\\\\") {
        let canonical = value.replace('\\', "/").replace(' ', "%20");
        return Ok(if canonical.starts_with("//") {
            format!("file:{canonical}")
        } else {
            format!("file:///{canonical}")
        });
    }
    if value.contains("://") || value.starts_with("javascript:") || value.starts_with("data:") {
        return Err(format!("esquema no permitido: {value}"));
    }
    if !value.contains(' ') && (value.contains('.') || value.starts_with("localhost")) {
        return Ok(format!("https://{value}"));
    }
    Ok(format!(
        "https://www.google.com/search?q={}",
        search_encode(value)
    ))
}

fn attach_dialog_handler(id: u32, core: &ICoreWebView2) -> Result<(), String> {
    // WebView2 only raises ScriptDialogOpening when its native modal UI is
    // disabled.  This lets the React chrome/gate answer without blocking the
    // browser's UI thread.
    unsafe {
        core.Settings()
            .map_err(wry_error)?
            .SetAreDefaultScriptDialogsEnabled(false)
            .map_err(wry_error)?;
    }
    let handler = ScriptDialogOpeningEventHandler::create(Box::new(move |_sender, args| {
        let Some(args) = args else {
            return Ok(());
        };
        let result = (|| unsafe {
            let deferral = args.GetDeferral()?;
            let mut kind = Default::default();
            args.Kind(&mut kind)?;
            let mut message = windows::core::PWSTR::null();
            let mut default_text = windows::core::PWSTR::null();
            args.Message(&mut message)?;
            args.DefaultText(&mut default_text)?;
            let kind_name = if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT {
                "alert"
            } else if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM {
                "confirm"
            } else if kind == COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT {
                "prompt"
            } else {
                "beforeunload"
            };
            let dialog_id = NEXT_DIALOG.with(|next| {
                let mut next = next.borrow_mut();
                let id = *next;
                *next += 1;
                id
            });
            DIALOGS.with(|dialogs| {
                dialogs.borrow_mut().push(PendingDialog {
                    id: dialog_id,
                    view: id,
                    kind: kind_name.into(),
                    message: message.to_string().unwrap_or_default(),
                    default_text: default_text.to_string().unwrap_or_default(),
                    args,
                    deferral,
                })
            });
            Ok(())
        })();
        if let Err(error) = &result {
            eprintln!("WebView2 dialog handler failed: {error}");
        }
        result
    }));
    unsafe {
        core.add_ScriptDialogOpening(&handler, &mut 0i64)
            .map_err(wry_error)
    }
}

#[tauri::command]
pub async fn browser_create(app: AppHandle, id: u32) -> Result<(), String> {
    let app2 = app.clone();
    run_main(app, 30, move |tx| {
        let result = (|| {
            if VIEWS.with(|views| views.borrow().contains_key(&id)) {
                return Ok(());
            }
            let main = app2.get_webview_window("main").ok_or("no window main")?;
            std::fs::create_dir_all(context_dir()).map_err(wry_error)?;
            STATES.with(|states| {
                states.borrow_mut().insert(
                    id,
                    RuntimeState {
                        loading: true,
                        ..Default::default()
                    },
                );
            });
            let builder = CONTEXT
                .with(|slot| {
                    let mut slot = slot.borrow_mut();
                    let context = slot.get_or_insert_with(|| WebContext::new(Some(context_dir())));
                    let title_id = id;
                    let load_id = id;
                    let download_id = id;
                    WebViewBuilder::new_with_web_context(context)
                        .with_id(Box::leak(format!("agent-browser-{id}").into_boxed_str()))
                        .with_url("about:blank")
                        .with_visible(false)
                        .with_bounds(Rect {
                            position: LogicalPosition::new(-20000.0, -20000.0).into(),
                            size: LogicalSize::new(SNAP_FALLBACK.0, SNAP_FALLBACK.1).into(),
                        })
                        .with_user_agent(UA_DESKTOP)
                        .with_initialization_script(INIT_JS)
                        .with_clipboard(true)
                        .with_document_title_changed_handler(move |title| {
                            STATES.with(|s| {
                                if let Some(v) = s.borrow_mut().get_mut(&title_id) {
                                    v.title = title
                                }
                            })
                        })
                        .with_on_page_load_handler(move |event, _url| {
                            STATES.with(|s| {
                                if let Some(v) = s.borrow_mut().get_mut(&load_id) {
                                    match event {
                                        PageLoadEvent::Started => {
                                            v.loading = true;
                                            v.progress = 0.1
                                        }
                                        PageLoadEvent::Finished => {
                                            v.loading = false;
                                            v.progress = 1.0
                                        }
                                    }
                                }
                            })
                        })
                        .with_download_started_handler(move |url, dest| {
                            crate::browser_delegate::download_started(download_id, url, dest)
                        })
                        .with_download_completed_handler(move |url, path, success| {
                            crate::browser_delegate::download_completed(url, path, success)
                        })
                        .with_new_window_req_handler(|url, features| {
                            unsafe {
                                let _ = features.opener.webview.Navigate(&HSTRING::from(url));
                            }
                            wry::NewWindowResponse::Deny
                        })
                        .build_as_child(&main)
                })
                .map_err(wry_error)?;
            attach_dialog_handler(id, &builder.webview())?;
            VIEWS.with(|views| {
                views.borrow_mut().insert(id, builder);
            });
            Ok(())
        })();
        let _ = tx.send(result);
    })
    .await
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, id: u32) -> Result<(), String> {
    run_main(app, 10, move |tx| {
        VIEWS.with(|views| {
            views.borrow_mut().remove(&id);
        });
        STATES.with(|states| {
            states.borrow_mut().remove(&id);
        });
        DIALOGS.with(|dialogs| dialogs.borrow_mut().retain(|d| d.view != id));
        let _ = tx.send(Ok(()));
    })
    .await
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
    _inner_w: f64,
    visible: bool,
    backstage: Option<bool>,
) -> Result<(), String> {
    run_main(app, 10, move |tx| {
        let result = with_view(id, |view| {
            let (x, y, w, h, visible) = if backstage.unwrap_or(false) {
                let size = STATES.with(|s| {
                    s.borrow()
                        .get(&id)
                        .and_then(|v| v.last_size)
                        .unwrap_or(SNAP_FALLBACK)
                });
                (-20000.0, -20000.0, size.0, size.1, true)
            } else {
                (x, y, w, h, visible)
            };
            if w > 10.0 && h > 10.0 {
                STATES.with(|s| {
                    if let Some(v) = s.borrow_mut().get_mut(&id) {
                        v.last_size = Some((w, h))
                    }
                });
            }
            view.set_bounds(Rect {
                position: LogicalPosition::new(x, y).into(),
                size: LogicalSize::new(w.max(1.0), h.max(1.0)).into(),
            })
            .map_err(wry_error)?;
            view.set_visible(visible).map_err(wry_error)
        });
        let _ = tx.send(result);
    })
    .await
}

#[tauri::command]
pub async fn browser_goto(app: AppHandle, id: u32, url: String) -> Result<String, String> {
    let normalized = normalize_url(&url)?;
    let output = normalized.clone();
    run_main(app, 10, move |tx| {
        STATES.with(|states| {
            if let Some(state) = states.borrow_mut().get_mut(&id) {
                state.loading = true;
                state.progress = 0.05;
            }
        });
        let r = with_view(id, |v| v.load_url(&normalized).map_err(wry_error));
        let _ = tx.send(r);
    })
    .await?;
    Ok(output)
}

#[tauri::command]
pub async fn browser_zoom(app: AppHandle, id: u32, factor: f64) -> Result<(), String> {
    run_main(app, 10, move |tx| {
        let r = with_view(id, |v| v.zoom(factor.clamp(0.3, 4.0)).map_err(wry_error));
        let _ = tx.send(r);
    })
    .await
}

#[tauri::command]
pub async fn browser_set_mobile(app: AppHandle, id: u32, on: bool) -> Result<(), String> {
    let ua = if on { UA_MOBILE } else { UA_DESKTOP };
    run_main(app, 10, move |tx| {
        let r = with_view(id, |v| {
            let settings: ICoreWebView2Settings2 = unsafe { v.webview().Settings() }
                .map_err(wry_error)?
                .cast()
                .map_err(wry_error)?;
            unsafe { settings.SetUserAgent(&HSTRING::from(ua)).map_err(wry_error) }
        });
        STATES.with(|s| {
            if let Some(v) = s.borrow_mut().get_mut(&id) {
                v.mobile = on
            }
        });
        let _ = tx.send(r);
    })
    .await
}

#[tauri::command]
pub async fn browser_nav(app: AppHandle, id: u32, action: String) -> Result<(), String> {
    run_main(app, 10, move |tx| {
        let r = with_view(id, |v| {
            let core = v.webview();
            unsafe {
                match action.as_str() {
                    "back" => core.GoBack(),
                    "forward" => core.GoForward(),
                    "reload" => core.Reload(),
                    "stop" => core.Stop(),
                    _ => return Err(format!("accion desconocida: {action}")),
                }
                .map_err(wry_error)
            }
        });
        let _ = tx.send(r);
    })
    .await
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
pub async fn browser_state(app: AppHandle, id: u32) -> Result<BrowserState, String> {
    run_main(app, 10, move |tx| {
        let r = with_view(id, |v| {
            let core = v.webview();
            let mut back = false.into();
            let mut forward = false.into();
            unsafe {
                core.CanGoBack(&mut back).map_err(wry_error)?;
                core.CanGoForward(&mut forward).map_err(wry_error)?;
            }
            let state = STATES.with(|s| s.borrow().get(&id).cloned().unwrap_or_default());
            Ok(BrowserState {
                url: v.url().unwrap_or_default(),
                title: state.title,
                loading: state.loading,
                progress: state.progress,
                can_back: back.as_bool(),
                can_forward: forward.as_bool(),
            })
        });
        let _ = tx.send(r);
    })
    .await
}

#[tauri::command]
pub async fn browser_eval(app: AppHandle, id: u32, js: String) -> Result<String, String> {
    let wrapped=format!("(() => {{ try {{ return JSON.stringify((() => ({js}))()) ?? 'undefined'; }} catch (e) {{ return 'JSERROR: ' + (e && e.stack || e); }} }})()");
    run_main(app, 20, move |tx| {
        let setup = with_view(id, |v| {
            let tx2 = tx.clone();
            v.evaluate_script_with_callback(&wrapped, move |raw| {
                let decoded = serde_json::from_str::<String>(&raw).unwrap_or(raw);
                let _ = tx2.send(Ok(decoded));
            })
            .map_err(wry_error)
        });
        if let Err(e) = setup {
            let _ = tx.send(Err(e));
        }
    })
    .await
}

fn ensure_parent(path: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        std::fs::create_dir_all(parent).map_err(wry_error)?;
    }
    Ok(())
}

fn capture(
    id: u32,
    core: ICoreWebView2,
    path: String,
    restore: Option<Rect>,
    tx: mpsc::Sender<Result<String, String>>,
) -> Result<(), String> {
    ensure_parent(&path)?;
    let wide = HSTRING::from(&path);
    let stream = unsafe {
        SHCreateStreamOnFileEx(
            &wide,
            (STGM_CREATE | STGM_READWRITE | STGM_SHARE_EXCLUSIVE).0,
            0,
            true,
            None,
        )
    }
    .map_err(wry_error)?;
    let dest = path.clone();
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        if let Some(bounds) = restore {
            VIEWS.with(|views| {
                if let Some(view) = views.borrow().get(&id) {
                    let _ = view.set_bounds(bounds);
                }
            });
        }
        let _ = tx.send(result.map(|_| dest.clone()).map_err(wry_error));
        Ok(())
    }));
    unsafe {
        core.CapturePreview(
            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
            &stream,
            &handler,
        )
        .map_err(wry_error)
    }
}

#[tauri::command]
pub async fn browser_snap(
    app: AppHandle,
    id: u32,
    path: String,
    w: Option<f64>,
    h: Option<f64>,
) -> Result<String, String> {
    run_main(app, 30, move |tx| {
        let setup = with_view(id, |v| {
            let mut restore = None;
            if let (Some(w), Some(h)) = (w, h) {
                restore = Some(v.bounds().map_err(wry_error)?);
                v.set_bounds(Rect {
                    position: LogicalPosition::new(-20000.0, -20000.0).into(),
                    size: LogicalSize::new(w, h).into(),
                })
                .map_err(wry_error)?;
            }
            capture(id, v.webview(), path, restore, tx.clone())
        });
        if let Err(e) = setup {
            let _ = tx.send(Err(e));
        }
    })
    .await
}

#[tauri::command]
pub async fn browser_fullsnap(
    app: AppHandle,
    id: u32,
    path: String,
    height: f64,
) -> Result<String, String> {
    run_main(app, 30, move |tx| {
        let setup = with_view(id, |v| {
            let old = v.bounds().map_err(wry_error)?;
            let width = match old.size {
                wry::dpi::Size::Logical(s) => s.width,
                wry::dpi::Size::Physical(s) => s.width as f64,
            };
            v.set_bounds(Rect {
                position: LogicalPosition::new(-20000.0, -20000.0).into(),
                size: LogicalSize::new(width, height.clamp(16.0, 16000.0)).into(),
            })
            .map_err(wry_error)?;
            capture(id, v.webview(), path, Some(old), tx.clone())
        });
        if let Err(e) = setup {
            let _ = tx.send(Err(e));
        }
    })
    .await
}

#[tauri::command]
pub async fn browser_clear_session(app: AppHandle) -> Result<u64, String> {
    run_main(app, 20, move |tx| {
        let mut count = 0u64;
        let mut error = None;
        VIEWS.with(|views| {
            for v in views.borrow().values() {
                match v.clear_all_browsing_data() {
                    Ok(()) => count += 1,
                    Err(e) => error = Some(wry_error(e)),
                }
            }
        });
        let _ = tx.send(error.map_or(Ok(count), Err));
    })
    .await
}

#[tauri::command]
pub async fn browser_pdf(app: AppHandle, id: u32, path: String) -> Result<String, String> {
    ensure_parent(&path)?;
    run_main(app, 30, move |tx| {
        let setup = with_view(id, |v| {
            let core: ICoreWebView2_7 = v.webview().cast().map_err(wry_error)?;
            let dest = path.clone();
            let tx2 = tx.clone();
            let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                let out = result.map_err(wry_error).and_then(|_| {
                    if ok {
                        Ok(dest.clone())
                    } else {
                        Err("WebView2 no pudo crear el PDF".into())
                    }
                });
                let _ = tx2.send(out);
                Ok(())
            }));
            unsafe {
                core.PrintToPdf(&HSTRING::from(&path), None, &handler)
                    .map_err(wry_error)
            }
        });
        if let Err(e) = setup {
            let _ = tx.send(Err(e));
        }
    })
    .await
}

pub(crate) fn dialog_snapshot() -> Vec<(u64, u32, String, String, String)> {
    DIALOGS.with(|d| {
        d.borrow()
            .iter()
            .map(|x| {
                (
                    x.id,
                    x.view,
                    x.kind.clone(),
                    x.message.clone(),
                    x.default_text.clone(),
                )
            })
            .collect()
    })
}

pub(crate) async fn dialog_snapshot_async(
    app: AppHandle,
) -> Result<Vec<(u64, u32, String, String, String)>, String> {
    run_main(app, 10, move |tx| {
        let _ = tx.send(Ok(dialog_snapshot()));
    })
    .await
}

fn answer_dialog(id: u64, accept: bool, text: Option<String>) -> Result<(), String> {
    let dialog = DIALOGS
        .with(|d| {
            let mut d = d.borrow_mut();
            let pos = d.iter().position(|x| x.id == id)?;
            Some(d.remove(pos))
        })
        .ok_or_else(|| format!("no existe el dialogo {id}"))?;
    unsafe {
        if accept {
            if dialog.kind == "prompt" {
                dialog
                    .args
                    .SetResultText(&HSTRING::from(text.unwrap_or(dialog.default_text)))
                    .map_err(wry_error)?;
            }
            dialog.args.Accept().map_err(wry_error)?;
        }
        dialog.deferral.Complete().map_err(wry_error)
    }
}

fn set_files(id: u32, paths: Vec<String>) -> Result<(), String> {
    for path in &paths {
        if !Path::new(path).is_file() {
            return Err(format!("no existe el archivo: {path}"));
        }
    }
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        let bytes = std::fs::read(&path).map_err(wry_error)?;
        files.push(serde_json::json!({
            "name":Path::new(&path).file_name().and_then(|n|n.to_str()).unwrap_or("upload.bin"),
            "data":base64::engine::general_purpose::STANDARD.encode(bytes),
        }));
    }
    let payload = serde_json::to_string(&files).map_err(wry_error)?;
    let script = format!(
        r#"(() => {{
      const input=document.querySelector('input[type=file]'); if(!input) throw new Error('no hay input file');
      const dt=new DataTransfer(); for(const f of {payload}){{const bin=atob(f.data),bytes=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);dt.items.add(new File([bytes],f.name));}}
      input.files=dt.files; input.dispatchEvent(new Event('input',{{bubbles:true}})); input.dispatchEvent(new Event('change',{{bubbles:true}}));
      const cancel=e=>{{if(e.target===input){{e.preventDefault();e.stopImmediatePropagation();document.removeEventListener('click',cancel,true);}}}}; document.addEventListener('click',cancel,true);
    }})()"#
    );
    with_view(id, |v| v.evaluate_script(&script).map_err(wry_error))
}

fn start_download(id: u32, url: String, path: Option<String>) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("solo se descarga http(s), no: {url}"));
    }
    crate::browser_delegate::set_pending_download(id, url.clone(), path)?;
    with_view(id, |v| v.load_url(&url).map_err(wry_error))
}

pub(crate) async fn set_files_async(
    app: AppHandle,
    id: u32,
    paths: Vec<String>,
) -> Result<(), String> {
    run_main(app, 20, move |tx| {
        let _ = tx.send(set_files(id, paths));
    })
    .await
}

pub(crate) async fn answer_dialog_async(
    app: AppHandle,
    id: u64,
    accept: bool,
    text: Option<String>,
) -> Result<(), String> {
    run_main(app, 10, move |tx| {
        let _ = tx.send(answer_dialog(id, accept, text));
    })
    .await
}

pub(crate) async fn start_download_async(
    app: AppHandle,
    id: u32,
    url: String,
    path: Option<String>,
) -> Result<(), String> {
    run_main(app, 10, move |tx| {
        let _ = tx.send(start_download(id, url, path));
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_windows_paths_and_queries() {
        assert_eq!(
            normalize_url(r"C:\Program Files\SFTerm\index.html").unwrap(),
            "file:///C:/Program%20Files/SFTerm/index.html"
        );
        assert_eq!(
            normalize_url(r"\\server\share\a b.html").unwrap(),
            "file://server/share/a%20b.html"
        );
        assert_eq!(normalize_url("github.com").unwrap(), "https://github.com");
        assert!(normalize_url("javascript:alert(1)").is_err());
    }
}
