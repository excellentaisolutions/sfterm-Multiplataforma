//! El puente app ↔ daemon `sfterm-ptyd`: la mitad que faltaba del wip del 27 jul.
//!
//! El daemon (ptyd/server.rs) hostea los PTYs y sobrevive a los rebuilds; este
//! modulo hace que la APP sea su cliente sin que el resto del codigo se entere:
//! `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill` conservan su contrato con el
//! frontend, y el engine (tee) sigue viviendo aqui — el daemon manda BYTES, el
//! parser VT de la app los come identico a como comia los del PTY local.
//!
//! Piezas:
//! - **UN drenador**: hilo unico que bloquea en `Client::wait_frames` y reparte
//!   cada frame DATA a su terminal (engine::feed + canal binario al frontend).
//!   N hilos sondeando era la alternativa; un cliente ya serializa igual.
//! - **`DaemonWriter`**: adapta `Write` → `write_bytes` del socket, para que
//!   `SharedWriter` (la firma que ya usan pty_write, el composer, el kickoff y
//!   las respuestas del engine) funcione sin tocar a NINGUN consumidor.
//! - **Adopcion**: al abrir la app, las terminales vivas del daemon se
//!   re-enganchan (Attach + replay del ring) — la pantalla se repinta donde
//!   estaba y el proceso ni se entera. Cero adivinanza: el proceso ES el mismo.
//!
//! Si el daemon no arranca (o `[general] daemon = false`, o SFTERM_NO_DAEMON),
//! `client()` devuelve None y pty.rs cae a su camino local de siempre: la
//! degradacion es a la app de ayer, nunca a una app rota.

use crate::ptyd::client::{connect_or_start, Client};
use crate::ptyd::proto::{Evt, PgidEntry, Req, Res, TermInfo};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

pub struct Sink {
    pub chan: Channel<InvokeResponseBody>,
    /// El writer de RESPUESTAS del engine (DSR/DA/OSC 10-11) hacia el PTY:
    /// mismo Arc que guarda PtySession.writer.
    pub writer: crate::pty::SharedWriter,
}

struct Bridge {
    client: Mutex<Option<Arc<Client>>>,
    sinks: Mutex<HashMap<u32, Arc<Sink>>>,
    app: OnceLock<AppHandle>,
}

static BRIDGE: OnceLock<Bridge> = OnceLock::new();

fn bridge() -> &'static Bridge {
    BRIDGE.get_or_init(|| Bridge {
        client: Mutex::new(None),
        sinks: Mutex::new(HashMap::new()),
        app: OnceLock::new(),
    })
}

/// El cliente vivo, o None (daemon apagado/caido → pty.rs usa el camino local).
pub fn client() -> Option<Arc<Client>> {
    bridge().client.lock().unwrap().clone()
}

pub fn daemon_on() -> bool {
    client().is_some()
}

/// Adaptador `Write` → daemon. Es el writer que viaja en PtySession/Sink: todo
/// lo que hoy escribe a un PTY local (composer, gate send, kickoff, respuestas
/// del engine) escribe aqui sin saber que el PTY vive en otro proceso.
struct DaemonWriter {
    term: u32,
}

impl Write for DaemonWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match client() {
            Some(c) => {
                c.write_bytes(self.term, buf)?;
                Ok(buf.len())
            }
            None => Err(std::io::Error::other("daemon caido")),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn daemon_writer(term: u32) -> crate::pty::SharedWriter {
    Arc::new(Mutex::new(
        Box::new(DaemonWriter { term }) as Box<dyn Write + Send>
    ))
}

/// ¿El config pide daemon? Default TRUE: la inmortalidad es el punto de todo
/// esto. `[general] daemon = false` o SFTERM_NO_DAEMON=1 lo apagan (escape
/// operativo si un dia el daemon da lata; se degrada al comportamiento clasico).
fn wanted() -> bool {
    if std::env::var("SFTERM_NO_DAEMON")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return false;
    }
    crate::config::config_get()
        .ok()
        .and_then(|c| c.get("general")?.get("daemon")?.as_bool())
        .unwrap_or(true)
}

/// Arranque (setup de la app): conecta (o levanta) el daemon y arma el
/// drenador. Nunca truena la app: sin daemon la app funciona como ayer.
pub fn init(app: AppHandle) {
    let b = bridge();
    let _ = b.app.set(app);
    if !wanted() {
        return;
    }
    match connect_or_start("sfterm-app") {
        Ok(c) => {
            *b.client.lock().unwrap() = Some(Arc::new(c));
            std::thread::spawn(drain_loop);
        }
        Err(e) => {
            eprintln!("[ptyd_bridge] sin daemon ({e}); camino local");
        }
    }
}

/// El drenador: frames del daemon → engine (tee) + canal binario del frontend.
fn drain_loop() {
    loop {
        let Some(c) = client() else { return };
        let batch = c.wait_frames(500);
        if !batch.data.is_empty() || !batch.evts.is_empty() {
            let app = bridge().app.get().cloned();
            for (term, bytes) in batch.data {
                let sink = bridge().sinks.lock().unwrap().get(&term).cloned();
                let Some(sink) = sink else { continue };
                if let Some(app) = &app {
                    let engine_state = app.state::<crate::engine::EngineState>();
                    if let Some(session) = crate::engine::get(&engine_state, term) {
                        let (responses, dom_bytes) = crate::engine::fanout_chunk(&session, &bytes);
                        crate::engine::write_responses(&sink.writer, responses);
                        let _ = sink.chan.send(InvokeResponseBody::Raw(dom_bytes));
                        continue;
                    }
                }
                let _ = sink.chan.send(InvokeResponseBody::Raw(bytes));
            }
            for evt in batch.evts {
                if let Ok(Evt::Exit { id, code }) = serde_json::from_slice::<Evt>(&evt) {
                    on_exit(id, code);
                }
            }
        }
        if batch.closed {
            on_daemon_down();
            return;
        }
    }
}

/// Muerte de un shell en el daemon = MISMAS señales que la muerte local
/// (poll_exits): el frontend ya sabe cerrar la conversacion con ellas.
fn on_exit(id: u32, code: Option<i32>) {
    bridge().sinks.lock().unwrap().remove(&id);
    let Some(app) = bridge().app.get() else {
        return;
    };
    let state = app.state::<crate::pty::PtyState>();
    let mut sessions = state.sessions.lock().unwrap();
    if let Some(s) = sessions.get_mut(&id) {
        if s.exited {
            return;
        }
        s.exited = true;
    } else {
        return;
    }
    drop(sessions);
    crate::events::emit(
        "shell_died",
        serde_json::json!({ "term": id, "code": code.unwrap_or(-1) }),
    );
    let _ = app.emit(
        "pty://exit",
        crate::pty::PtyExit {
            id,
            code: code.map(|c| c as u32),
        },
    );
}

/// El daemon entero se fue (crash/Shutdown ajeno): sus PTYs murieron con el.
/// Se reporta terminal por terminal con las señales de siempre — el rail dice
/// la verdad — y el cliente queda en None (spawns nuevos caen al camino local).
fn on_daemon_down() {
    *bridge().client.lock().unwrap() = None;
    let ids: Vec<u32> = {
        let Some(app) = bridge().app.get() else {
            return;
        };
        let state = app.state::<crate::pty::PtyState>();
        let sessions = state.sessions.lock().unwrap();
        sessions
            .iter()
            .filter(|(_, s)| s.is_daemon() && !s.exited)
            .map(|(id, _)| *id)
            .collect()
    };
    for id in ids {
        on_exit(id, None);
    }
}

fn req(r: &Req) -> Result<Res, String> {
    let c = client().ok_or("daemon apagado")?;
    c.request(r).map_err(|e| e.to_string())
}

/// Spawn via daemon. El comando inicial NO viaja al daemon: la app lo inyecta
/// ella misma esperando el prompt real (OSC 133) del engine — la entrega fuerte
/// que el daemon, sin parser, no puede dar (su sleep de 700ms es para headless).
#[allow(clippy::too_many_arguments)]
pub fn spawn(
    engine_state: &crate::engine::EngineState,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    scrollback: usize,
    shell_integration: Option<bool>,
    colorfgbg: Option<String>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<(u32, u32, crate::pty::SharedWriter), String> {
    let res = req(&Req::Spawn {
        cwd,
        cols,
        rows,
        scrollback: Some(scrollback),
        shell_integration,
        colorfgbg,
        command: None,
    })?;
    let (id, pid) = match res {
        Res::Spawned { id, pid } => (id, pid),
        Res::Err { msg } => return Err(msg),
        other => return Err(format!("spawn devolvio {other:?}")),
    };
    crate::pty::ensure_next_id_above(id);
    // engine + sink ANTES del Attach: el primer byte que el daemon mande ya
    // encuentra a quien pintarlo (el ring del daemon cubre el hueco previo)
    crate::engine::create(engine_state, id, cols as usize, rows as usize, scrollback);
    let writer = daemon_writer(id);
    bridge().sinks.lock().unwrap().insert(
        id,
        Arc::new(Sink {
            chan: on_data,
            writer: writer.clone(),
        }),
    );
    let attach_err = match req(&Req::Attach { id }) {
        Ok(Res::Attached { .. }) => None,
        Ok(Res::Err { msg }) | Err(msg) => Some(msg),
        Ok(other) => Some(format!("attach devolvio {other:?}")),
    };
    if let Some(msg) = attach_err {
        // recien nacida y ya inalcanzable: limpiar TODO (sink, engine, y la
        // terminal en el daemon) — dejarla viva sin nadie escuchando seria un
        // huerfano invisible comiendo RAM del daemon
        bridge().sinks.lock().unwrap().remove(&id);
        if let Some(app) = bridge().app.get() {
            let engine_state = app.state::<crate::engine::EngineState>();
            crate::engine::remove(&engine_state, id);
        }
        let _ = req(&Req::Kill { id });
        return Err(msg);
    }
    Ok((id, pid, writer))
}

#[derive(Serialize, Clone)]
pub struct AdoptInfo {
    pub id: u32,
    pub pid: u32,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
}

/// Re-engancha una terminal VIVA del daemon: engine con el TAMAÑO REAL del
/// PTY (el replay se emitio bajo ese ancho; parsearlo con otro lo destroza),
/// sink registrado ANTES del Attach (el replay no puede caer al vacio), y
/// recien despues el frontend la re-dimensiona a su layout (SIGWINCH normal:
/// el TUI repinta, como en cualquier resize).
pub fn adopt(
    engine_state: &crate::engine::EngineState,
    id: u32,
    scrollback: usize,
    on_data: Channel<InvokeResponseBody>,
) -> Result<AdoptInfo, String> {
    let terms = list()?;
    let info = terms
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("la terminal {id} ya no vive en el daemon"))?;
    crate::pty::ensure_next_id_above(id);
    crate::engine::create(
        engine_state,
        id,
        info.cols as usize,
        info.rows as usize,
        scrollback,
    );
    let writer = daemon_writer(id);
    bridge().sinks.lock().unwrap().insert(
        id,
        Arc::new(Sink {
            chan: on_data,
            writer: writer.clone(),
        }),
    );
    match req(&Req::Attach { id }) {
        Ok(Res::Attached { .. }) => Ok(AdoptInfo {
            id,
            pid: info.pid,
            cwd: info.cwd,
            cols: info.cols,
            rows: info.rows,
        }),
        Ok(Res::Err { msg }) | Err(msg) => {
            // limpiar lo armado: un sink/engine colgando de un attach fallido
            // seria un canal que jamas recibe y una terminal fantasma
            bridge().sinks.lock().unwrap().remove(&id);
            crate::engine::remove(engine_state, id);
            Err(msg)
        }
        Ok(other) => {
            bridge().sinks.lock().unwrap().remove(&id);
            crate::engine::remove(engine_state, id);
            Err(format!("attach devolvio {other:?}"))
        }
    }
}

/// El writer registrado para una terminal adoptada/spawneada via daemon
/// (pty_adopt lo necesita para armar su PtySession con el MISMO Arc del sink).
pub fn writer_of(id: u32) -> Option<crate::pty::SharedWriter> {
    bridge()
        .sinks
        .lock()
        .unwrap()
        .get(&id)
        .map(|s| s.writer.clone())
}

pub fn list() -> Result<Vec<TermInfo>, String> {
    match req(&Req::List)? {
        Res::List { terms } => Ok(terms),
        Res::Err { msg } => Err(msg),
        other => Err(format!("list devolvio {other:?}")),
    }
}

pub fn kill(id: u32) {
    bridge().sinks.lock().unwrap().remove(&id);
    let _ = req(&Req::Kill { id });
}

/// Suelta la terminal SIN matarla (reload del webview): sink fuera, Detach al
/// daemon (deja de mandar DATA), y la conversacion sigue viva para que el boot
/// de la pagina nueva la re-adopte.
pub fn detach(id: u32) {
    bridge().sinks.lock().unwrap().remove(&id);
    let _ = req(&Req::Detach { id });
}

pub fn resize(id: u32, cols: u16, rows: u16) -> Result<(), String> {
    match req(&Req::Resize { id, cols, rows })? {
        Res::Ok => Ok(()),
        Res::Err { msg } => Err(msg),
        other => Err(format!("resize devolvio {other:?}")),
    }
}

/// fg pgid de UNA terminal del daemon (term_session).
pub fn fg_pgid(id: u32) -> i32 {
    match req(&Req::FgPgid { id }) {
        Ok(Res::Pgid { pgid, .. }) => pgid,
        _ => -1,
    }
}

/// fg pgids de TODAS en un viaje (loop de metrics). Fallback per-terminal si el
/// daemon es viejo y no conoce el op batcheado.
pub fn fg_pgids(ids: &[u32]) -> HashMap<u32, i32> {
    match req(&Req::FgPgids) {
        Ok(Res::Pgids { list }) => list
            .into_iter()
            .map(|PgidEntry { id, pgid, .. }| (id, pgid))
            .collect(),
        _ => ids.iter().map(|id| (*id, fg_pgid(*id))).collect(),
    }
}

/// Estado para el frontend al boot: ¿hay daemon? ¿que terminales viven?
#[derive(Serialize, Clone)]
pub struct DaemonInfo {
    pub on: bool,
    pub terms: Vec<TermSummary>,
}

#[derive(Serialize, Clone)]
pub struct TermSummary {
    pub id: u32,
    pub pid: u32,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub born_ms: u64,
    pub buffered: usize,
}

pub fn daemon_info() -> DaemonInfo {
    if !daemon_on() {
        return DaemonInfo {
            on: false,
            terms: vec![],
        };
    }
    let terms = list()
        .unwrap_or_default()
        .into_iter()
        .map(|t| TermSummary {
            id: t.id,
            pid: t.pid,
            cwd: t.cwd,
            cols: t.cols,
            rows: t.rows,
            born_ms: t.born_ms,
            buffered: t.buffered,
        })
        .collect();
    DaemonInfo { on: true, terms }
}
