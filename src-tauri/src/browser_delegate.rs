//! DELEGATES del navegador del agente (29 jul 2026): la mitad CIUDADANA.
//! Sin esto el webview era mudo: los links target=_blank no hacian NADA, los
//! alert()/confirm() morian en silencio y "download" no descargaba.
//!
//! Un SFBrowserDelegate por webview (retenido en DELEGATES — WKWebView guarda
//! sus delegates en weak) implementa:
//! - WKUIDelegate: window.open/target=_blank → navegar EN LA MISMA VISTA
//!   (predecible, sin gestor de ventanas); alert/confirm/prompt → COLA de
//!   dialogos que el frontend pinta in-app (dialogos nativos PROHIBIDOS) y
//!   responde via browser_dialog_reply. Mientras no haya respuesta, el JS de
//!   la pagina espera — semantica fiel de alert().
//! - WKNavigationDelegate: anchors con atributo download y respuestas que no
//!   se pueden mostrar (octet-stream, attachments) → se vuelven WKDownload.
//! - WKDownloadDelegate: destino en ~/Downloads (nombre deduplicado), estado
//!   consultable por browser_downloads (espejo del toast del chrome).
//!
//! THREADING: igual que browser.rs — todo vive en thread_locals del main
//! thread; los comandos entran por run_on_main_thread y responden por canal.

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
use objc2_foundation::{
    MainThreadMarker, NSArray, NSData, NSError, NSObject, NSObjectProtocol, NSString, NSURLRequest,
    NSURLResponse, NSURL,
};
use objc2_web_kit::{
    WKDownload, WKDownloadDelegate, WKFrameInfo, WKNavigationAction, WKNavigationActionPolicy,
    WKNavigationDelegate, WKNavigationResponse, WKNavigationResponsePolicy, WKOpenPanelParameters,
    WKUIDelegate, WKWebView, WKWebViewConfiguration, WKWindowFeatures,
};
use serde::Serialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc;
use std::time::Duration;
use tauri::AppHandle;

// ---------- estado (main thread only) ----------

thread_local! {
    /// Delegates vivos por webview id — la retencion que WKWebView no hace.
    static DELEGATES: RefCell<HashMap<u32, Retained<SfBrowserDelegate>>> =
        RefCell::new(HashMap::new());
    /// Dialogos JS pendientes de respuesta (el frontend los pinta in-app).
    static DIALOGS: RefCell<Vec<PendingDialog>> = const { RefCell::new(Vec::new()) };
    /// Descargas de la sesion (estado espejo para el chrome y el gate).
    static DOWNLOADS: RefCell<Vec<DownloadEntry>> = const { RefCell::new(Vec::new()) };
    /// Objetos WKDownload vivos, apareados por id (para matchear callbacks).
    static DL_OBJS: RefCell<Vec<(u64, Retained<WKDownload>)>> = const { RefCell::new(Vec::new()) };
    /// Destino explicito para la PROXIMA descarga (browser_download {path}).
    static PENDING_DEST: RefCell<Option<String>> = const { RefCell::new(None) };
    /// SUBIDA DE ARCHIVOS (29 jul): rutas con las que se contestara el proximo
    /// panel de seleccion, por webview. Vacio = no hay nada armado y el panel
    /// se CANCELA (jamas se muestra un dialogo nativo: prohibido en esta app).
    static PENDING_FILES: RefCell<HashMap<u32, Vec<String>>> = RefCell::new(HashMap::new());
    static NEXT_ID: RefCell<u64> = const { RefCell::new(1) };
}

fn next_id() -> u64 {
    NEXT_ID.with(|n| {
        let mut n = n.borrow_mut();
        let id = *n;
        *n += 1;
        id
    })
}

enum Completion {
    Alert(RcBlock<dyn Fn()>),
    Confirm(RcBlock<dyn Fn(Bool)>),
    Prompt(RcBlock<dyn Fn(*mut NSString)>),
}

struct PendingDialog {
    id: u64,
    view: u32,
    kind: &'static str, // alert | confirm | prompt
    message: String,
    default_text: String,
    completion: Completion,
}

/// Snapshot serializable de un dialogo (lo que viaja al frontend/gate).
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
    pub state: String, // running | done | failed
    pub error: Option<String>,
}

fn push_dialog(
    view: u32,
    kind: &'static str,
    message: String,
    default_text: String,
    completion: Completion,
) {
    DIALOGS.with(|d| {
        d.borrow_mut().push(PendingDialog {
            id: next_id(),
            view,
            kind,
            message,
            default_text,
            completion,
        })
    });
}

/// ~/Downloads/<nombre>, deduplicado con " (n)" antes de la extension.
fn unique_dest(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
    let base = dir.join(name);
    if !base.exists() {
        return base;
    }
    let stem = std::path::Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let ext = std::path::Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 1..1000 {
        let cand = dir.join(format!("{stem} ({n}){ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    dir.join(format!("{stem}.{}{ext}", next_id()))
}

fn register_download(delegate: &SfBrowserDelegate, download: &WKDownload) -> u64 {
    let id = next_id();
    let url = unsafe {
        download
            .originalRequest()
            .and_then(|r| r.URL())
            .and_then(|u| u.absoluteString())
            .map(|s| s.to_string())
            .unwrap_or_default()
    };
    unsafe {
        let proto: &ProtocolObject<dyn WKDownloadDelegate> = ProtocolObject::from_ref(delegate);
        download.setDelegate(Some(proto));
    }
    // retener el WKDownload para poder matchear sus callbacks por puntero
    if let Some(kept) =
        unsafe { Retained::retain(download as *const WKDownload as *mut WKDownload) }
    {
        DL_OBJS.with(|o| o.borrow_mut().push((id, kept)));
    }
    DOWNLOADS.with(|d| {
        d.borrow_mut().push(DownloadEntry {
            id,
            url,
            dest: String::new(),
            state: "running".into(),
            error: None,
        })
    });
    id
}

fn download_id_of(download: &WKDownload) -> Option<u64> {
    DL_OBJS.with(|o| {
        o.borrow()
            .iter()
            .find(|(_, kept)| core::ptr::eq(Retained::as_ptr(kept), download))
            .map(|(id, _)| *id)
    })
}

fn update_download(id: u64, f: impl FnOnce(&mut DownloadEntry)) {
    DOWNLOADS.with(|d| {
        if let Some(e) = d.borrow_mut().iter_mut().find(|e| e.id == id) {
            f(e)
        }
    });
}

fn drop_download_obj(download: &WKDownload) {
    DL_OBJS.with(|o| {
        o.borrow_mut()
            .retain(|(_, kept)| !core::ptr::eq(Retained::as_ptr(kept), download))
    });
}

// ---------- el delegate ----------

pub struct DelegateIvars {
    view: u32,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    pub struct SfBrowserDelegate;

    unsafe impl NSObjectProtocol for SfBrowserDelegate {}

    unsafe impl WKUIDelegate for SfBrowserDelegate {
        // target=_blank / window.open: navegar EN LA MISMA VISTA. Devolver
        // None le dice a WebKit "no cree ventana"; el load ya quedo pedido.
        #[unsafe(method_id(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:))]
        unsafe fn create_webview(
            &self,
            webview: &WKWebView,
            _config: &WKWebViewConfiguration,
            action: &WKNavigationAction,
            _features: &WKWindowFeatures,
        ) -> Option<Retained<WKWebView>> {
            unsafe {
                let req = action.request();
                webview.loadRequest(&req);
            }
            None
        }

        #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
        unsafe fn js_alert(
            &self,
            _webview: &WKWebView,
            message: &NSString,
            _frame: &WKFrameInfo,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            push_dialog(
                self.ivars().view,
                "alert",
                message.to_string(),
                String::new(),
                Completion::Alert(handler.copy()),
            );
        }

        #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
        unsafe fn js_confirm(
            &self,
            _webview: &WKWebView,
            message: &NSString,
            _frame: &WKFrameInfo,
            handler: &block2::DynBlock<dyn Fn(Bool)>,
        ) {
            push_dialog(
                self.ivars().view,
                "confirm",
                message.to_string(),
                String::new(),
                Completion::Confirm(handler.copy()),
            );
        }

        // EL PANEL DE ARCHIVOS SE CONTESTA, NO SE MUESTRA. La pagina pide
        // "elige archivos" y aqui se le entregan las rutas que el agente armo
        // con browser_set_files — cero dialogo nativo (prohibido en la app) y
        // cero manos humanas. Sin nada armado se cancela: mejor que la pagina
        // sepa que no hay archivo a que se quede colgada esperando un panel
        // que nunca va a aparecer.
        #[unsafe(method(webView:runOpenPanelWithParameters:initiatedByFrame:completionHandler:))]
        unsafe fn panel_archivos(
            &self,
            _webview: &WKWebView,
            parameters: &WKOpenPanelParameters,
            _frame: &WKFrameInfo,
            handler: &block2::DynBlock<dyn Fn(*mut NSArray<NSURL>)>,
        ) {
            let view = self.ivars().view;
            let rutas = PENDING_FILES
                .with(|m| m.borrow_mut().remove(&view))
                .unwrap_or_default();
            if rutas.is_empty() {
                handler.call((std::ptr::null_mut(),));
                return;
            }
            // respetar lo que la pagina admite: si no acepta multiples, va una
            let multi = unsafe { parameters.allowsMultipleSelection() };
            let urls: Vec<Retained<NSURL>> = rutas
                .iter()
                .take(if multi { rutas.len() } else { 1 })
                .map(|p| NSURL::fileURLWithPath(&NSString::from_str(p)))
                .collect();
            let refs: Vec<&NSURL> = urls.iter().map(|u| &**u).collect();
            let arr = NSArray::from_slice(&refs);
            handler.call((Retained::as_ptr(&arr).cast_mut(),));
        }

        #[unsafe(method(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:))]
        unsafe fn js_prompt(
            &self,
            _webview: &WKWebView,
            prompt: &NSString,
            default_text: Option<&NSString>,
            _frame: &WKFrameInfo,
            handler: &block2::DynBlock<dyn Fn(*mut NSString)>,
        ) {
            push_dialog(
                self.ivars().view,
                "prompt",
                prompt.to_string(),
                default_text.map(|s| s.to_string()).unwrap_or_default(),
                Completion::Prompt(handler.copy()),
            );
        }
    }

    unsafe impl WKNavigationDelegate for SfBrowserDelegate {
        // anchor con atributo download → descarga (no navegacion)
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        unsafe fn decide_action(
            &self,
            _webview: &WKWebView,
            action: &WKNavigationAction,
            handler: &block2::DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            let policy = if unsafe { action.shouldPerformDownload() } {
                WKNavigationActionPolicy::Download
            } else {
                WKNavigationActionPolicy::Allow
            };
            handler.call((policy,));
        }

        // respuesta que el webview NO puede pintar (zip, csv, octet-stream,
        // Content-Disposition: attachment) → descarga
        #[unsafe(method(webView:decidePolicyForNavigationResponse:decisionHandler:))]
        unsafe fn decide_response(
            &self,
            _webview: &WKWebView,
            response: &WKNavigationResponse,
            handler: &block2::DynBlock<dyn Fn(WKNavigationResponsePolicy)>,
        ) {
            let policy = if unsafe { response.canShowMIMEType() } {
                WKNavigationResponsePolicy::Allow
            } else {
                WKNavigationResponsePolicy::Download
            };
            handler.call((policy,));
        }

        #[unsafe(method(webView:navigationAction:didBecomeDownload:))]
        unsafe fn action_became_download(
            &self,
            _webview: &WKWebView,
            _action: &WKNavigationAction,
            download: &WKDownload,
        ) {
            register_download(self, download);
        }

        #[unsafe(method(webView:navigationResponse:didBecomeDownload:))]
        unsafe fn response_became_download(
            &self,
            _webview: &WKWebView,
            _response: &WKNavigationResponse,
            download: &WKDownload,
        ) {
            register_download(self, download);
        }
    }

    unsafe impl WKDownloadDelegate for SfBrowserDelegate {
        #[unsafe(method(download:decideDestinationUsingResponse:suggestedFilename:completionHandler:))]
        unsafe fn decide_destination(
            &self,
            download: &WKDownload,
            _response: &NSURLResponse,
            suggested: &NSString,
            handler: &block2::DynBlock<dyn Fn(*mut NSURL)>,
        ) {
            let explicit = PENDING_DEST.with(|p| p.borrow_mut().take());
            let dest = match explicit {
                Some(p) => std::path::PathBuf::from(p),
                None => {
                    let dir =
                        dirs::download_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
                    unique_dest(&dir, &suggested.to_string())
                }
            };
            // WKDownload CANCELA en silencio si el folder destino no existe
            // (cazado en E2E con un HOME sin ~/Downloads): crearlo antes.
            if let Some(parent) = dest.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Some(id) = download_id_of(download) {
                let d = dest.to_string_lossy().into_owned();
                update_download(id, |e| e.dest = d);
            }
            let url = NSURL::fileURLWithPath(&NSString::from_str(&dest.to_string_lossy()));
            handler.call((Retained::as_ptr(&url).cast_mut(),));
        }

        #[unsafe(method(downloadDidFinish:))]
        unsafe fn download_finished(&self, download: &WKDownload) {
            if let Some(id) = download_id_of(download) {
                update_download(id, |e| e.state = "done".into());
            }
            drop_download_obj(download);
        }

        #[unsafe(method(download:didFailWithError:resumeData:))]
        unsafe fn download_failed(
            &self,
            download: &WKDownload,
            error: &NSError,
            _resume: Option<&NSData>,
        ) {
            if let Some(id) = download_id_of(download) {
                let msg = error.localizedDescription().to_string();
                update_download(id, |e| {
                    e.state = "failed".into();
                    e.error = Some(msg.clone());
                });
            }
            drop_download_obj(download);
        }
    }
);

impl SfBrowserDelegate {
    fn new(view: u32, mtm: MainThreadMarker) -> Retained<Self> {
        let this = mtm.alloc::<Self>().set_ivars(DelegateIvars { view });
        unsafe { msg_send![super(this), init] }
    }
}

/// Crea el delegate del webview `id`, lo cablea (UI + navegacion) y lo
/// RETIENE. Llamar desde browser_create; idempotente por el mapa.
pub fn attach(id: u32, wk: &WKWebView, mtm: MainThreadMarker) {
    let delegate = SfBrowserDelegate::new(id, mtm);
    unsafe {
        let ui: &ProtocolObject<dyn WKUIDelegate> = ProtocolObject::from_ref(&*delegate);
        wk.setUIDelegate(Some(ui));
        let nav: &ProtocolObject<dyn WKNavigationDelegate> = ProtocolObject::from_ref(&*delegate);
        wk.setNavigationDelegate(Some(nav));
    }
    DELEGATES.with(|d| d.borrow_mut().insert(id, delegate));
}

/// Suelta el delegate y limpia dialogos pendientes del webview (al cerrarlo).
pub fn detach(id: u32) {
    DELEGATES.with(|d| d.borrow_mut().remove(&id));
    DIALOGS.with(|d| d.borrow_mut().retain(|dlg| dlg.view != id));
    PENDING_FILES.with(|m| m.borrow_mut().remove(&id));
}

/// Arma las rutas con las que se contestara el PROXIMO panel de seleccion de
/// archivos de este webview. Lista vacia = desarmar.
#[tauri::command]
pub async fn browser_set_files(app: AppHandle, id: u32, paths: Vec<String>) -> Result<(), String> {
    for p in &paths {
        if !std::path::Path::new(p).exists() {
            return Err(format!("no existe el archivo: {p}"));
        }
    }
    run_main(app, 10, move |tx| {
        PENDING_FILES.with(|m| {
            let mut m = m.borrow_mut();
            if paths.is_empty() {
                m.remove(&id);
            } else {
                m.insert(id, paths);
            }
        });
        let _ = tx.send(Ok(()));
    })
    .await
}

// ---------- comandos ----------

/// mismo helper que browser.rs: despachar al main thread y esperar por canal
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
            .map_err(|_| "timeout esperando al main thread".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Dialogos JS pendientes (el frontend/gate los pinta y responde).
#[tauri::command]
pub async fn browser_dialogs(app: AppHandle) -> Result<Vec<DialogInfo>, String> {
    run_main(app, 10, move |tx| {
        let snap = DIALOGS.with(|d| {
            d.borrow()
                .iter()
                .map(|p| DialogInfo {
                    id: p.id,
                    view: p.view,
                    kind: p.kind.to_string(),
                    message: p.message.clone(),
                    default_text: p.default_text.clone(),
                })
                .collect::<Vec<_>>()
        });
        let _ = tx.send(Ok(snap));
    })
    .await
}

/// Responde un dialogo: alert → accept ignorado; confirm → accept; prompt →
/// accept + text (None = el default_text). El completion handler de WebKit se
/// invoca aqui — el JS de la pagina despierta con la respuesta.
#[tauri::command]
pub async fn browser_dialog_reply(
    app: AppHandle,
    id: u64,
    accept: bool,
    text: Option<String>,
) -> Result<(), String> {
    run_main(app, 10, move |tx| {
        let _ = tx.send((|| {
            let dlg = DIALOGS.with(|d| {
                let mut v = d.borrow_mut();
                let i = v.iter().position(|p| p.id == id)?;
                Some(v.remove(i))
            });
            let dlg = dlg.ok_or(format!("no existe el dialogo {id}"))?;
            match dlg.completion {
                Completion::Alert(b) => b.call(()),
                Completion::Confirm(b) => b.call((Bool::new(accept),)),
                Completion::Prompt(b) => {
                    if accept {
                        let s = text.unwrap_or(dlg.default_text);
                        let ns = NSString::from_str(&s);
                        b.call((Retained::as_ptr(&ns).cast_mut(),));
                    } else {
                        b.call((std::ptr::null_mut(),));
                    }
                }
            }
            Ok(())
        })());
    })
    .await
}

/// Estado de las descargas de la sesion (mas recientes al final).
#[tauri::command]
pub async fn browser_downloads(app: AppHandle) -> Result<Vec<DownloadEntry>, String> {
    run_main(app, 10, move |tx| {
        let _ = tx.send(Ok(DOWNLOADS.with(|d| d.borrow().clone())));
    })
    .await
}

/// Descarga DIRECTA de una url (el verbo del agente): arranca un WKDownload
/// del webview `id`; path opcional fija el destino exacto.
#[tauri::command]
pub async fn browser_download(
    app: AppHandle,
    id: u32,
    url: String,
    path: Option<String>,
) -> Result<(), String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(format!("solo se descarga http(s), no: {url}"));
    }
    run_main(app, 10, move |tx| {
        let _ = tx.send((|| unsafe {
            let wk = crate::browser::view_handle(id)?;
            let delegate = DELEGATES
                .with(|d| d.borrow().get(&id).cloned())
                .ok_or(format!("navegador {id} sin delegate"))?;
            if let Some(p) = path {
                PENDING_DEST.with(|pd| *pd.borrow_mut() = Some(p));
            }
            let nsurl = NSURL::URLWithString(&NSString::from_str(&url))
                .ok_or(format!("url invalida: {url}"))?;
            let req = NSURLRequest::requestWithURL(&nsurl);
            let block = RcBlock::new(move |dl: core::ptr::NonNull<WKDownload>| {
                let dl: &WKDownload = dl.as_ref();
                register_download(&delegate, dl);
            });
            wk.startDownloadUsingRequest_completionHandler(&req, &block);
            Ok(())
        })());
    })
    .await
}
