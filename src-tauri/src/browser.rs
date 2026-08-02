//! NAVEGADOR DEL AGENTE (F1): un WKWebView REAL — top-level, no iframe — que
//! vive como panel del tiling y se OPERA por la puerta de agentes (gate).
//!
//! Por que crudo via objc2 y no un webview de Tauri:
//! - SIN IPC de Tauri POR CONSTRUCCION: el contenido web (arbitrario, hostil)
//!   jamas puede invocar comandos de la app ni tocar el filesystem. No es una
//!   ACL que niega — es un puente que no existe.
//! - Sitios que bloquean iframes (X-Frame-Options/CSP) cargan normal: es un
//!   webview de primer nivel, el caveat del overlay `preview` no aplica.
//! - Control total: evaluateJavaScript (leer/actuar) y takeSnapshot (ver) son
//!   el lazo de vision del agente, mismo patron que debug_harness.rs.
//!
//! THREADING: WKWebView es main-thread-only. Cada comando despacha con
//! `run_on_main_thread` y espera el resultado por canal en el pool blocking
//! (spawn_blocking) — el main thread JAMAS se espera a si mismo. Los views
//! viven en un thread_local del main thread (Retained<WKWebView> no es Send).

use objc2::rc::Retained;
use objc2::{define_class, msg_send, MainThreadMarker, MainThreadOnly};
use objc2_web_kit::WKWebView;
use serde::Serialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

thread_local! {
    static VIEWS: RefCell<HashMap<u32, Retained<WKWebView>>> = RefCell::new(HashMap::new());
    /// Ultimo tamaño REAL con el que se pinto cada navegador. Cuando su
    /// conversacion no esta a la vista, el frontend lo pliega a 0x0 — y un
    /// view de 0x0 no se puede fotografiar. Esto recuerda su cuerpo para
    /// prestarselo fuera de pantalla durante el snapshot (ver con_cuerpo).
    static LAST_SIZE: RefCell<HashMap<u32, (f64, f64)>> = RefCell::new(HashMap::new());
}

/// Tamaño de respaldo cuando el navegador nunca llego a pintarse.
const SNAP_FALLBACK: (f64, f64) = (1280.0, 900.0);

/// Hook de consola + red inyectado en documentStart de cada navegacion
/// (WKUserScript, main frame). Escribe ring buffers en `window.__sfDebug`
/// (console cap 300, net cap 150); los verbos browser_console/browser_net los
/// LEEN por eval. La pagina jamas gana un canal hacia la app.
const DEBUG_HOOK_JS: &str = r#"(() => {
  if (window.__sfDebug) return;
  const D = { console: [], net: [] };
  window.__sfDebug = D;
  const push = (arr, item, cap) => { arr.push(item); if (arr.length > cap) arr.splice(0, arr.length - cap); };
  const fmt = (a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } };
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const orig = console[level] ? console[level].bind(console) : null;
    console[level] = (...args) => {
      push(D.console, { t: Date.now(), level, text: args.map(fmt).join(" ").slice(0, 500) }, 300);
      if (orig) orig(...args);
    };
  }
  addEventListener("error", (e) => push(D.console, { t: Date.now(), level: "exception", text: String(e.message || e).slice(0, 500) }, 300));
  addEventListener("unhandledrejection", (e) => push(D.console, { t: Date.now(), level: "rejection", text: fmt(e.reason).slice(0, 500) }, 300));
  const rec = (r) => push(D.net, r, 150);
  const ofetch = window.fetch;
  window.fetch = function (...args) {
    const t0 = Date.now();
    const url = String(typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "").slice(0, 300);
    const method = ((args[1] && args[1].method) || (args[0] && args[0].method) || "GET").toUpperCase();
    return ofetch.apply(this, args).then(
      (res) => {
        const e = { t: t0, kind: "fetch", method, url, status: res.status, ok: res.ok, ms: Date.now() - t0 };
        rec(e);
        try {
          const ct = res.headers.get("content-type") || "";
          if (/json|text|xml|javascript/.test(ct))
            res.clone().text().then((b) => { e.body = b.slice(0, 2048); }, () => {});
        } catch {}
        return res;
      },
      (err) => { rec({ t: t0, kind: "fetch", method, url, error: String(err).slice(0, 200), ms: Date.now() - t0 }); throw err; },
    );
  };
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    this.__sf = { method: String(m).toUpperCase(), url: String(u).slice(0, 300) };
    return xo.call(this, m, u, ...rest);
  };
  // ATAJOS SAFARI con el foco DENTRO de la pagina (la app nunca ve esas
  // teclas: el webview nativo se las come). El chrome drena __sfKeys por poll.
  addEventListener("keydown", (ev) => {
    if (!ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const map = { l: "url", r: "reload", f: "find", "[": "back", "]": "forward", "=": "zin", "+": "zin", "-": "zout", "_": "zout", "0": "zreset" };
    const cmd = map[ev.key] || map[ev.key.toLowerCase()];
    if (!cmd) return;
    // shift solo pasa para el ZOOM (en teclado US el "+" ES shift+"="); los
    // demas combos con shift no son nuestros y se le dejan a la pagina
    if (ev.shiftKey && cmd !== "zin" && cmd !== "zout" && cmd !== "zreset") return;
    ev.preventDefault(); ev.stopPropagation();
    (window.__sfKeys = window.__sfKeys || []).push(cmd);
  }, true);
  XMLHttpRequest.prototype.send = function (...args) {
    const meta = this.__sf || {}; const t0 = Date.now();
    this.addEventListener("loadend", () => {
      const e = {
        t: t0, kind: "xhr", method: meta.method || "GET", url: meta.url || "",
        status: this.status, ok: this.status >= 200 && this.status < 400, ms: Date.now() - t0,
      };
      try {
        if (!this.responseType || this.responseType === "text")
          e.body = String(this.responseText || "").slice(0, 2048);
      } catch {}
      rec(e);
    });
    return xs.apply(this, args);
  };
})();"#;

// ---------- SfWebView: la pagina NO se roba el teclado (30 jul 2026) ----------
//
// EL BUG QUE MATA ESTO: una pagina que llama focus() (google.com lo hace al
// cargar) hacia que WebKit pidiera makeFirstResponder → el webview NATIVO se
// quedaba el teclado A MEDIA ESCRITURA en el omnibox: la url "se regresaba
// sola" y las teclas de Daniel caian DENTRO del sitio (asi nacio la busqueda
// fantasma de "tube" del 30 jul). Safari no permite eso: el teclado solo entra
// a la pagina cuando el USUARIO la clickea. Mismo contrato aqui:
// acceptsFirstResponder solo dice SI cuando el evento en curso es un click del
// mouse; cualquier intento programatico de la pagina se rechaza y el foco se
// queda donde estaba (el omnibox, la terminal, donde sea).
define_class!(
    #[unsafe(super(WKWebView))]
    #[thread_kind = MainThreadOnly]
    pub struct SfWebView;

    impl SfWebView {
        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> objc2::runtime::Bool {
            use objc2::runtime::Bool;
            use objc2_app_kit::{NSApplication, NSEventType};
            use objc2_foundation::NSProcessInfo;
            let mtm = self.mtm();
            let Some(ev) = NSApplication::sharedApplication(mtm).currentEvent() else {
                return Bool::NO;
            };
            let t = ev.r#type();
            let es_click = t == NSEventType::LeftMouseDown
                || t == NSEventType::RightMouseDown
                || t == NSEventType::OtherMouseDown;
            if !es_click {
                return Bool::NO;
            }
            // ⚠️ currentEvent es "el ULTIMO evento procesado", no "el evento en
            // curso": un click de hace un minuto en la terminal serviria de
            // coartada (cazado en la validacion del 30 jul). Doble cerrojo:
            // el click tiene que ser DE AHORA (timestamp vs uptime) y DENTRO
            // de este view (un click en la terminal no abre la pagina).
            let fresco = (NSProcessInfo::processInfo().systemUptime() - ev.timestamp()).abs() < 2.0;
            if !fresco {
                return Bool::NO;
            }
            let p = ev.locationInWindow();
            let local = self.convertPoint_fromView(p, None);
            let b = self.bounds();
            let dentro = local.x >= b.origin.x
                && local.x <= b.origin.x + b.size.width
                && local.y >= b.origin.y
                && local.y <= b.origin.y + b.size.height;
            Bool::new(dentro)
        }
    }
);

/// Despacha `f` al MAIN THREAD y espera su resultado en el pool blocking.
/// `f` recibe el Sender: los caminos sincronos mandan de inmediato, los de
/// completion-handler (eval/snap) mandan cuando WebKit termina.
async fn run_main<T, F>(app: AppHandle, secs: u64, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(mpsc::Sender<Result<T, String>>) + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || f(tx)).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(Duration::from_secs(secs))
            .map_err(|_| "timeout esperando al main thread".to_string())?
    })
    .await
    .map_err(|e| e.to_string())?
}

fn with_view<T>(id: u32, f: impl FnOnce(&WKWebView) -> Result<T, String>) -> Result<T, String> {
    VIEWS.with(|v| {
        let map = v.borrow();
        let wk = map.get(&id).ok_or(format!("no existe el navegador {id}"))?;
        f(wk)
    })
}

/// Handle retenido del webview (para modulos hermanos, ej. browser_delegate).
/// Solo main thread.
pub(crate) fn view_handle(id: u32) -> Result<Retained<WKWebView>, String> {
    VIEWS.with(|v| {
        v.borrow()
            .get(&id)
            .cloned()
            .ok_or(format!("no existe el navegador {id}"))
    })
}

/// OMNIBOX + libertad (29 jul 2026). Acepta: http(s), about:blank, `file://`
/// y rutas absolutas de disco (→ file://, iniciadas por Daniel/agente — la
/// pagina sigue sin poder saltar de esquema sola). Un input sin pinta de host
/// se vuelve BUSQUEDA web. `javascript:` y `data:` siguen fuera: la barra
/// navega, no inyecta.
pub fn normalize_url(raw: &str) -> Result<String, String> {
    let u = raw.trim();
    if u.is_empty() {
        return Err("url vacia".into());
    }
    if u.starts_with("http://") || u.starts_with("https://") || u == "about:blank" {
        return Ok(u.to_string());
    }
    if u.starts_with("file://") {
        return Ok(u.to_string());
    }
    if u.starts_with('/') {
        // ruta de disco pelada → file:// (espacios codificados para NSURL)
        return Ok(format!("file://{}", u.replace(' ', "%20")));
    }
    if u.contains("://") || u.starts_with("javascript:") || u.starts_with("data:") {
        return Err(format!("esquema no permitido: {u}"));
    }
    let looks_like_host = !u.contains(' ') && (u.contains('.') || u.starts_with("localhost"));
    if looks_like_host {
        return Ok(format!("https://{u}"));
    }
    Ok(format!("https://www.google.com/search?q={}", search_encode(u)))
}

/// Percent-encoding minimo para el query de busqueda del omnibox.
fn search_encode(q: &str) -> String {
    let mut out = String::with_capacity(q.len() * 2);
    for b in q.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// User agent de Safari real: sin esto Google (y afines) bloquean logins en
/// webviews "no seguros". El UA movil alimenta el modo iPhone.
pub const UA_SAFARI: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
pub const UA_IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

// ---------- ciclo de vida ----------

/// Crea el WKWebView `id` (idempotente) como subview del contentView, oculto
/// y con frame cero hasta el primer `browser_place`.
#[tauri::command]
pub async fn browser_create(app: AppHandle, id: u32) -> Result<(), String> {
    let app2 = app.clone();
    run_main(app, 10, move |tx| {
        let _ = tx.send((|| unsafe {
            use objc2_app_kit::NSWindow;
            use objc2_foundation::{NSPoint, NSRect, NSSize};
            use objc2_web_kit::WKWebViewConfiguration;

            let exists = VIEWS.with(|v| v.borrow().contains_key(&id));
            if exists {
                return Ok(());
            }
            let mtm = MainThreadMarker::new().ok_or("no main thread")?;
            let win = app2.get_webview_window("main").ok_or("no window")?;
            let ns = win.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
            let content = (*ns).contentView().ok_or("sin contentView")?;

            let config = WKWebViewConfiguration::new(mtm);
            // HOOK DE DEBUG (28 jul 2026): user script en documentStart de CADA
            // navegacion (main frame) — captura console + fetch/XHR en buffers
            // window.__sfDebug desde el primer byte. NO abre IPC: el script
            // solo ESCRIBE en la pagina; leer sigue siendo browser_eval (pull).
            {
                use objc2_foundation::NSString;
                use objc2_web_kit::{WKUserScript, WKUserScriptInjectionTime};
                let ucc = config.userContentController();
                let src = NSString::from_str(DEBUG_HOOK_JS);
                let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                    mtm.alloc(),
                    &src,
                    WKUserScriptInjectionTime::AtDocumentStart,
                    true,
                );
                ucc.addUserScript(&script);
            }
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0));
            // subclase con el candado de foco (ver SfWebView arriba)
            let wk: Retained<SfWebView> =
                msg_send![mtm.alloc::<SfWebView>(), initWithFrame: frame, configuration: &*config];
            let wk: Retained<WKWebView> = Retained::into_super(wk);
            wk.setHidden(true);
            wk.setAllowsBackForwardNavigationGestures(true);
            wk.setAllowsMagnification(true);
            // UA de Safari real: sin esto Google bloquea logins ("browser not secure")
            {
                use objc2_foundation::NSString;
                wk.setCustomUserAgent(Some(&NSString::from_str(UA_SAFARI)));
            }
            content.addSubview(&wk);
            // la mitad CIUDADANA: _blank, dialogos JS, descargas (29 jul)
            crate::browser_delegate::attach(id, &wk, mtm);
            VIEWS.with(|v| v.borrow_mut().insert(id, wk));
            Ok(())
        })());
    })
    .await
}

#[tauri::command]
pub async fn browser_close(app: AppHandle, id: u32) -> Result<(), String> {
    run_main(app, 10, move |tx| {
        let _ = tx.send((|| {
            if let Some(wk) = VIEWS.with(|v| v.borrow_mut().remove(&id)) {
                wk.removeFromSuperview();
            }
            crate::browser_delegate::detach(id);
            Ok(())
        })());
    })
    .await
}

/// Posiciona/muestra el webview. Coordenadas CSS top-left del webview de la
/// app + `inner_w` (window.innerWidth): el factor de escala se deriva de ahi
/// (zoom de app incluido) y la Y se voltea a bottom-left de AppKit.
///
/// `backstage = true` ignora x/y/w/h y manda el webview FUERA DE PANTALLA pero
/// CON CUERPO (su ultimo tamaño conocido, o el fallback), sin ocultarlo.
///
/// ⚠️ Por que existe (bug 29 jul, dos agentes peleandose la pantalla): un ala
/// plegada se colocaba a 0x0 y `hidden`. Sin caja no hay layout, y sin layout
/// su agente no puede medir el ancho, ni leer `innerWidth`, ni clickear —
/// literalmente no le queda mas salida que DESPLEGARLA, y desplegarla le mueve
/// la pantalla a Daniel. Con dos agentes trabajando en paralelo eso es una
/// pelea por el foco. Backstage les devuelve un cuerpo real donde trabajar
/// sin que nadie los vea. Es el mismo truco de `prestar_cuerpo`, pero
/// permanente en vez de solo durante el retrato.
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
    if backstage.unwrap_or(false) {
        let (bw, bh) = LAST_SIZE
            .with(|m| m.borrow().get(&id).copied())
            .unwrap_or(SNAP_FALLBACK);
        let app3 = app.clone();
        return run_main(app3, 10, move |tx| {
            let _ = tx.send((|| unsafe {
                use objc2_foundation::{NSPoint, NSRect, NSSize};
                with_view(id, |wk| {
                    wk.setFrame(NSRect::new(
                        NSPoint::new(-20000.0, -20000.0),
                        NSSize::new(bw, bh),
                    ));
                    wk.setHidden(false);
                    Ok(())
                })
            })());
        })
        .await;
    }
    let app2 = app.clone();
    run_main(app, 10, move |tx| {
        let _ = tx.send((|| unsafe {
            use objc2_app_kit::NSWindow;
            use objc2_foundation::{NSPoint, NSRect, NSSize};

            let win = app2.get_webview_window("main").ok_or("no window")?;
            let ns = win.ns_window().map_err(|e| e.to_string())? as *mut NSWindow;
            let content = (*ns).contentView().ok_or("sin contentView")?;
            let b = content.bounds();
            let scale = if inner_w > 0.0 { b.size.width / inner_w } else { 1.0 };
            let (px, pw, ph) = (x * scale, w * scale, h * scale);
            let ns_y = b.size.height - (y * scale) - ph;
            with_view(id, |wk| {
                wk.setFrame(NSRect::new(NSPoint::new(px, ns_y), NSSize::new(pw, ph)));
                wk.setHidden(!visible);
                // recordar su cuerpo real para poder retratarlo aun plegado
                if pw > 10.0 && ph > 10.0 {
                    LAST_SIZE.with(|m| m.borrow_mut().insert(id, (pw, ph)));
                }
                Ok(())
            })
        })());
    })
    .await
}

// ---------- navegacion ----------

#[tauri::command]
pub async fn browser_goto(app: AppHandle, id: u32, url: String) -> Result<String, String> {
    let url = normalize_url(&url)?;
    let url2 = url.clone();
    run_main(app, 10, move |tx| {
        let _ = tx.send((|| unsafe {
            use objc2_foundation::{NSString, NSURLRequest, NSURL};
            with_view(id, |wk| {
                if let Some(path) = url2.strip_prefix("file://") {
                    // file:// va por loadFileURL: WebKit exige declarar el
                    // alcance de lectura. Se otorga el FOLDER del archivo
                    // (para css/js/img hermanos), no el disco entero — una
                    // pagina con file-access + red seria un canal de exfil.
                    let path = path.replace("%20", " ");
                    let file = NSURL::fileURLWithPath(&NSString::from_str(&path));
                    let dir = std::path::Path::new(&path)
                        .parent()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "/".into());
                    let dir_url = NSURL::fileURLWithPath_isDirectory(
                        &NSString::from_str(&dir),
                        true,
                    );
                    wk.loadFileURL_allowingReadAccessToURL(&file, &dir_url)
                        .ok_or(format!("no se pudo cargar: {path}"))?;
                    return Ok(());
                }
                let nsurl = NSURL::URLWithString(&NSString::from_str(&url2))
                    .ok_or(format!("url invalida: {url2}"))?;
                let req = NSURLRequest::requestWithURL(&nsurl);
                wk.loadRequest(&req);
                Ok(())
            })
        })());
    })
    .await?;
    Ok(url)
}

/// Zoom del contenido (⌘+/−/0): factor 1.0 = 100%.
#[tauri::command]
pub async fn browser_zoom(app: AppHandle, id: u32, factor: f64) -> Result<(), String> {
    run_main(app, 10, move |tx| {
        let _ = tx.send((|| unsafe {
            with_view(id, |wk| {
                wk.setMagnification(factor.clamp(0.3, 4.0));
                Ok(())
            })
        })());
    })
    .await
}

/// MODO iPHONE: cambia el user agent (el caller recarga y angosta el frame).
#[tauri::command]
pub async fn browser_set_mobile(app: AppHandle, id: u32, on: bool) -> Result<(), String> {
    run_main(app, 10, move |tx| {
        let _ = tx.send((|| unsafe {
            use objc2_foundation::NSString;
            with_view(id, |wk| {
                let ua = if on { UA_IPHONE } else { UA_SAFARI };
                wk.setCustomUserAgent(Some(&NSString::from_str(ua)));
                Ok(())
            })
        })());
    })
    .await
}

/// action: "back" | "forward" | "reload" | "stop"
#[tauri::command]
pub async fn browser_nav(app: AppHandle, id: u32, action: String) -> Result<(), String> {
    run_main(app, 10, move |tx| {
        let _ = tx.send((|| unsafe {
            with_view(id, |wk| {
                match action.as_str() {
                    "back" => {
                        wk.goBack();
                    }
                    "forward" => {
                        wk.goForward();
                    }
                    "reload" => {
                        wk.reload();
                    }
                    "stop" => wk.stopLoading(),
                    _ => return Err(format!("accion desconocida: {action}")),
                }
                Ok(())
            })
        })());
    })
    .await
}

#[derive(Serialize, Clone)]
pub struct BrowserState {
    pub url: String,
    pub title: String,
    pub loading: bool,
    /// estimatedProgress de WebKit (0.0-1.0) — alimenta la barra de progreso
    pub progress: f64,
    pub can_back: bool,
    pub can_forward: bool,
}

#[tauri::command]
pub async fn browser_state(app: AppHandle, id: u32) -> Result<BrowserState, String> {
    run_main(app, 10, move |tx| {
        let _ = tx.send((|| unsafe {
            with_view(id, |wk| {
                let url = wk
                    .URL()
                    .and_then(|u| u.absoluteString())
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                let title = wk.title().map(|s| s.to_string()).unwrap_or_default();
                Ok(BrowserState {
                    url,
                    title,
                    loading: wk.isLoading(),
                    progress: wk.estimatedProgress(),
                    can_back: wk.canGoBack(),
                    can_forward: wk.canGoForward(),
                })
            })
        })());
    })
    .await
}

// ---------- el lazo de vision del agente ----------

/// Evalua una EXPRESION JS en la pagina y devuelve su JSON.stringify (o
/// "JSERROR: ..."). Es la base de los verbos read/click/type del gate — el
/// snippet viaja desde gate.ts, aqui solo se ejecuta con el wrapper seguro
/// (mismo patron que debug_harness::evaljson).
#[tauri::command]
pub async fn browser_eval(app: AppHandle, id: u32, js: String) -> Result<String, String> {
    let wrapped = format!(
        "(() => {{ try {{ return JSON.stringify((() => ({js}))()) ?? 'undefined'; }} catch (e) {{ return 'JSERROR: ' + (e && e.stack || e); }} }})()"
    );
    run_main(app, 20, move |tx| {
        let setup = (|| unsafe {
            use block2::RcBlock;
            use objc2::runtime::AnyObject;
            use objc2_foundation::{NSError, NSString};
            with_view(id, |wk| {
                let script = NSString::from_str(&wrapped);
                let tx2 = tx.clone();
                let block = RcBlock::new(move |result: *mut AnyObject, err: *mut NSError| {
                    let out = if !result.is_null() {
                        // el wrapper SIEMPRE devuelve string
                        Ok((*(result as *mut NSString)).to_string())
                    } else if !err.is_null() {
                        Err(format!("eval error: {:?}", &*err))
                    } else {
                        Err("eval nil".into())
                    };
                    let _ = tx2.send(out);
                });
                wk.evaluateJavaScript_completionHandler(&script, Some(&block));
                Ok(())
            })
        })();
        // si el setup fallo (id inexistente), el error VIAJA — sin esto el
        // caller muere por timeout en vez de saber que paso
        if let Err(e) = setup {
            let _ = tx.send(Err(e));
        }
    })
    .await
}

/// Estado original de un view al que se le presto cuerpo para el snapshot.
struct CuerpoPrestado {
    frame: objc2_foundation::NSRect,
    oculto: bool,
}

/// PRESTAR CUERPO (29 jul 2026). El ala del navegador solo se pinta dentro de
/// SU conversacion; en las demas el frontend la pliega a 0x0 — y un WKWebView
/// de 0x0 no tiene pixeles que retratar (`takeSnapshot` devuelve una imagen
/// sin TIFF). Sin esto, el agente se queda CIEGO sobre su propio navegador
/// cada vez que Daniel mira otra conversacion, que es justo cuando mas util
/// seria trabajar en paralelo.
///
/// Se le da su ultimo tamaño conocido pero MUY fuera de pantalla, para que
/// WebKit tenga que maquetar y pintar sin que nada parpadee en la ventana.
/// Devuelve None si el view ya estaba a la vista (nada que restaurar).
///
/// # Safety
/// Solo main thread; el caller DEBE llamar a `devolver_cuerpo` al terminar.
unsafe fn prestar_cuerpo(
    wk: &WKWebView,
    id: u32,
    medida: Option<(f64, f64)>,
) -> Option<CuerpoPrestado> {
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let frame = wk.frame();
    let oculto = wk.isHidden();
    // MEDIDA COMANDADA (29 jul): con w/h explicitos SIEMPRE se presta cuerpo,
    // este a la vista o no. Es la unica forma de capturar a dimensiones
    // EXACTAS: si se retratara "tal cual", el ancho seria el del panel y una
    // lamina pedida a 1920 saldria a 1100 y pico segun como tenga Daniel el
    // layout ese dia. Un render que depende del tamaño de tu ventana no es un
    // render, es una casualidad.
    if let Some((w, h)) = medida {
        wk.setFrame(NSRect::new(NSPoint::new(-20000.0, -20000.0), NSSize::new(w, h)));
        wk.setHidden(false);
        return Some(CuerpoPrestado { frame, oculto });
    }
    if frame.size.width > 10.0 && frame.size.height > 10.0 && !oculto {
        return None; // esta a la vista: se retrata tal cual
    }
    let (w, h) = LAST_SIZE
        .with(|m| m.borrow().get(&id).copied())
        .unwrap_or(SNAP_FALLBACK);
    wk.setFrame(NSRect::new(NSPoint::new(-20000.0, -20000.0), NSSize::new(w, h)));
    wk.setHidden(false);
    Some(CuerpoPrestado { frame, oculto })
}

/// # Safety
/// Solo main thread. Restaura EXACTO lo que `prestar_cuerpo` encontro.
unsafe fn devolver_cuerpo(wk: &WKWebView, prestado: Option<CuerpoPrestado>) {
    if let Some(c) = prestado {
        wk.setFrame(c.frame);
        wk.setHidden(c.oculto);
    }
}

/// Convierte el NSImage del snapshot a PNG en disco (comparte snap/fullsnap).
///
/// # Safety
/// `img`/`err` vienen del completion handler de takeSnapshot (nullables).
unsafe fn png_write(
    img: *mut objc2_app_kit::NSImage,
    err: *mut objc2_foundation::NSError,
    dest: &str,
) -> Result<String, String> {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::NSDictionary;
    if img.is_null() {
        return Err(if err.is_null() {
            "snapshot nil".to_string()
        } else {
            format!("snapshot error: {:?}", &*err)
        });
    }
    let image: &NSImage = &*img;
    let tiff = image.TIFFRepresentation().ok_or("sin tiff")?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff).ok_or("sin rep")?;
    let props: Retained<NSDictionary<_, AnyObject>> = NSDictionary::new();
    let png = rep
        .representationUsingType_properties(NSBitmapImageFileType::PNG, &props)
        .ok_or("sin png")?;
    std::fs::write(dest, png.to_vec()).map_err(|e| format!("write {e}"))?;
    Ok(dest.to_string())
}

/// Screenshot PNG SOLO del panel del navegador (no la ventana entera):
/// takeSnapshot del propio WKWebView — la mitad "ver" del lazo del agente.
#[tauri::command]
pub async fn browser_snap(
    app: AppHandle,
    id: u32,
    path: String,
    w: Option<f64>,
    h: Option<f64>,
) -> Result<String, String> {
    let medida = match (w, h) {
        (Some(w), Some(h)) if w >= 16.0 && h >= 16.0 => Some((w, h)),
        _ => None,
    };
    let path2 = path.clone();
    run_main(app, 20, move |tx| {
        let setup = (|| unsafe {
            use block2::RcBlock;
            use objc2_app_kit::NSImage;
            use objc2_foundation::NSError;
            use objc2_web_kit::WKSnapshotConfiguration;

            let mtm = MainThreadMarker::new().ok_or("no main thread")?;
            with_view(id, |wk| {
                let config = WKSnapshotConfiguration::new(mtm);
                // si su conversacion no esta a la vista, el view viene plegado
                // a 0x0: se le presta cuerpo fuera de pantalla para retratarlo
                let prestado = RefCell::new(prestar_cuerpo(wk, id, medida));
                if prestado.borrow().is_some() {
                    config.setAfterScreenUpdates(true); // forzar maquetado
                }
                let tx2 = tx.clone();
                let dest = path2.clone();
                let wk2 = view_handle(id)?;
                let block = RcBlock::new(move |img: *mut NSImage, err: *mut NSError| {
                    let out = png_write(img, err, &dest);
                    // el cuerpo se devuelve SIEMPRE, haya salido bien o mal:
                    // dejarlo prestado seria un view gigante fuera de pantalla
                    devolver_cuerpo(&wk2, prestado.borrow_mut().take());
                    let _ = tx2.send(out);
                });
                wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
                Ok(())
            })
        })();
        if let Err(e) = setup {
            let _ = tx.send(Err(e));
        }
    })
    .await
}

/// Screenshot de la PAGINA COMPLETA (29 jul): estira el frame del webview al
/// alto del documento (`height` en px CSS, lo mide el caller con eval),
/// snapshotea con afterScreenUpdates y RESTAURA el frame en el completion.
/// Un flash de layout es el costo; el techo de 16000 evita paginas infinitas.
#[tauri::command]
pub async fn browser_fullsnap(
    app: AppHandle,
    id: u32,
    path: String,
    height: f64,
) -> Result<String, String> {
    let path2 = path.clone();
    run_main(app, 30, move |tx| {
        let setup = (|| unsafe {
            use block2::RcBlock;
            use objc2_app_kit::NSImage;
            use objc2_foundation::{NSError, NSRect, NSSize};
            use objc2_web_kit::WKSnapshotConfiguration;

            let mtm = MainThreadMarker::new().ok_or("no main thread")?;
            with_view(id, |wk| {
                // plegado (otra conversacion a la vista) = 0x0 y sin pixeles:
                // se le presta cuerpo fuera de pantalla antes de estirarlo
                let prestado = prestar_cuerpo(wk, id, None);
                let old = wk.frame();
                let mag = wk.magnification();
                let full_h = (height * mag).clamp(old.size.height, 16000.0);
                wk.setFrame(NSRect::new(old.origin, NSSize::new(old.size.width, full_h)));

                let config = WKSnapshotConfiguration::new(mtm);
                config.setAfterScreenUpdates(true);
                let tx2 = tx.clone();
                let dest = path2.clone();
                let wk2 = view_handle(id)?;
                let prestado = RefCell::new(prestado);
                let block = RcBlock::new(move |img: *mut NSImage, err: *mut NSError| {
                    let out = png_write(img, err, &dest);
                    wk2.setFrame(old); // restaurar SIEMPRE, incluso si fallo
                    devolver_cuerpo(&wk2, prestado.borrow_mut().take());
                    let _ = tx2.send(out);
                });
                wk.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block);
                Ok(())
            })
        })();
        if let Err(e) = setup {
            let _ = tx.send(Err(e));
        }
    })
    .await
}

/// SESION LIMPIA (29 jul): borra cookies, localStorage y cache de TODOS los
/// sitios — el navegador vuelve a ser un desconocido.
///
/// Para que sirve de verdad, y no es teoria: probar TU propio producto como lo
/// ve alguien que llega por primera vez. Con la sesion guardada, saasfactory.so
/// abre logueado y jamas ves tu propio onboarding, tu landing, tu muro de pago.
/// Es la unica forma de mirar tu producto con ojos de extraño sin pedir prestada
/// otra computadora.
#[tauri::command]
pub async fn browser_clear_session(app: AppHandle) -> Result<u64, String> {
    run_main(app, 20, move |tx| {
        let setup = (|| unsafe {
            use block2::RcBlock;
            use objc2_foundation::NSDate;
            use objc2_web_kit::WKWebsiteDataStore;

            let mtm = MainThreadMarker::new().ok_or("no main thread")?;
            let store = WKWebsiteDataStore::defaultDataStore(mtm);
            let tipos = WKWebsiteDataStore::allWebsiteDataTypes(mtm);
            let desde = NSDate::distantPast();
            let tx2 = tx.clone();
            let block = RcBlock::new(move || {
                let _ = tx2.send(Ok(0u64));
            });
            store.removeDataOfTypes_modifiedSince_completionHandler(&tipos, &desde, &block);
            Ok(())
        })();
        if let Err(e) = setup {
            let _ = tx.send(Err(e));
        }
    })
    .await
}

/// PDF de la pagina completa. WebKit lo pagina solo (no es una foto estirada:
/// es el mismo motor que imprime desde Safari), asi que sirve para lo que una
/// imagen no puede — un pergamino largo que se lee, no que se mira.
/// Como el snapshot, si el ala esta plegada se le presta cuerpo fuera de
/// pantalla: un view de 0x0 pagina un PDF vacio.
#[tauri::command]
pub async fn browser_pdf(app: AppHandle, id: u32, path: String) -> Result<String, String> {
    let path2 = path.clone();
    run_main(app, 30, move |tx| {
        let setup = (|| unsafe {
            use block2::RcBlock;
            use objc2_foundation::{NSData, NSError};

            with_view(id, |wk| {
                let prestado = RefCell::new(prestar_cuerpo(wk, id, None));
                let tx2 = tx.clone();
                let dest = path2.clone();
                let wk2 = view_handle(id)?;
                let block = RcBlock::new(move |data: *mut NSData, err: *mut NSError| {
                    let out = (|| {
                        if data.is_null() {
                            return Err(if err.is_null() {
                                "pdf nil".to_string()
                            } else {
                                format!("pdf error: {:?}", &*err)
                            });
                        }
                        std::fs::write(&dest, (*data).to_vec()).map_err(|e| format!("write {e}"))?;
                        Ok(dest.clone())
                    })();
                    devolver_cuerpo(&wk2, prestado.borrow_mut().take());
                    let _ = tx2.send(out);
                });
                wk.createPDFWithConfiguration_completionHandler(None, &block);
                Ok(())
            })
        })();
        if let Err(e) = setup {
            let _ = tx.send(Err(e));
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_url_web_y_hosts() {
        assert_eq!(normalize_url("github.com").unwrap(), "https://github.com");
        assert_eq!(normalize_url(" https://x.dev/a ").unwrap(), "https://x.dev/a");
        assert_eq!(normalize_url("http://localhost:3000").unwrap(), "http://localhost:3000");
        assert_eq!(normalize_url("localhost:8080").unwrap(), "https://localhost:8080");
        assert_eq!(normalize_url("about:blank").unwrap(), "about:blank");
        assert!(normalize_url("javascript:alert(1)").is_err(), "inyeccion NO");
        assert!(normalize_url("data:text/html,x").is_err());
        assert!(normalize_url("").is_err());
    }

    #[test]
    fn normalize_url_omnibox_busca_lo_que_no_es_host() {
        assert_eq!(
            normalize_url("polar api docs").unwrap(),
            "https://www.google.com/search?q=polar+api+docs"
        );
        assert_eq!(
            normalize_url("sfterm").unwrap(),
            "https://www.google.com/search?q=sfterm",
            "una palabra sin punto se busca, no se navega"
        );
        assert_eq!(
            normalize_url("¿que es rust?").unwrap(),
            "https://www.google.com/search?q=%C2%BFque+es+rust%3F"
        );
    }

    #[test]
    fn normalize_url_file_y_rutas_de_disco() {
        // LIBERTAD 29 jul: file:// entra (lo inicia Daniel/agente por barra/gate)
        assert_eq!(normalize_url("file:///tmp/x.html").unwrap(), "file:///tmp/x.html");
        assert_eq!(
            normalize_url("/Users/d/mi reporte.html").unwrap(),
            "file:///Users/d/mi%20reporte.html",
            "ruta absoluta pelada → file:// con espacios codificados"
        );
    }
}
