//! El daemon: hostea los PTYs y multiplexa clientes por Unix socket/Named Pipe.
//!
//! Invariantes:
//! 1. **Nadie mata una terminal por accidente.** Solo `Kill`/`Shutdown`
//!    explicitos, o que el proceso muera solo. Perder una desconexion NO es
//!    razon para matar: la razon de existir de este proceso es sobrevivir a
//!    que la app se vaya.
//! 2. **El replay es bytes crudos, jamas interpretados.** El daemon no parsea
//!    VT: guarda el stream tal cual y lo devuelve al reconectar. Quien sabe
//!    pintarlo es el engine de la app, que ya se come exactamente ese stream.
//! 3. **Un cliente lento no puede frenar una terminal.** Cada cliente tiene su
//!    hilo escritor y su cola; si se atasca, se le corta a el, no al PTY.

use crate::ptyd::proto::*;
use crate::ptyd::transport::{self, Listener, Stream};
use crate::ptyd::{log_path, now_ms};
use portable_pty::{native_pty_system, Child, MasterPty, PtySize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};

/// Cuanto output se guarda por terminal para el replay. 4 MiB ~ el scrollback
/// util de una sesion larga de claude; pasado eso se descarta lo mas viejo.
const RING_MAX: usize = 4 * 1024 * 1024;
/// Cola de salida por cliente antes de considerarlo atascado.
const CLIENT_QUEUE_MAX: usize = 4096;

static NEXT_TERM: AtomicU32 = AtomicU32::new(1);
static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);

type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

struct Term {
    id: u32,
    pid: u32,
    cwd: String,
    size: Mutex<(u16, u16)>,
    writer: SharedWriter,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    ring: Mutex<VecDeque<u8>>,
    #[cfg(target_os = "macos")]
    raw_fd: Option<i32>,
    #[cfg(target_os = "windows")]
    job: crate::ptyd::job::Job,
    born_ms: u64,
}

struct Client {
    #[allow(dead_code)]
    id: u64,
    out: SyncSender<Vec<u8>>,
    attached: Mutex<HashSet<u32>>,
    alive: Arc<AtomicBool>,
}

#[derive(Default)]
struct Hub {
    terms: Mutex<HashMap<u32, Arc<Term>>>,
    clients: Mutex<Vec<Arc<Client>>>,
}

impl Client {
    fn queue(&self, frame: Vec<u8>) {
        if !self.alive.load(Ordering::Relaxed) {
            return;
        }
        if matches!(
            self.out.try_send(frame),
            Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_))
        ) {
            self.alive.store(false, Ordering::Relaxed);
        }
    }
}

impl Hub {
    /// Manda un marco a los clientes que estan mirando esa terminal.
    fn broadcast(&self, term: u32, kind: u8, payload: &[u8]) {
        let mut frame = Vec::with_capacity(payload.len() + 9);
        frame.push(kind);
        frame.extend_from_slice(&term.to_le_bytes());
        frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        frame.extend_from_slice(payload);
        let clients = self.clients.lock().unwrap();
        for c in clients.iter() {
            if kind == KIND_DATA && !c.attached.lock().unwrap().contains(&term) {
                continue;
            }
            c.queue(frame.clone());
        }
    }

    fn evt(&self, e: &Evt) {
        let body = serde_json::to_vec(e).unwrap_or_default();
        // los eventos van a TODOS (id de peticion 0 = no solicitado)
        let mut frame = Vec::with_capacity(body.len() + 9);
        frame.push(KIND_CTL);
        frame.extend_from_slice(&0u32.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        for c in self.clients.lock().unwrap().iter() {
            c.queue(frame.clone());
        }
    }
}

fn log(msg: &str) {
    let line = format!("[{}] {}\n", now_ms(), msg);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Punto de entrada del proceso daemon (`app --ptyd`). No retorna hasta que
/// alguien pida `Shutdown` o el socket se caiga.
pub fn run() {
    // ¿ya hay uno vivo? Conectar es la unica prueba honesta: un .sock en disco
    // puede ser el cadaver de un daemon que murio sin limpiar.
    if transport::connect().is_ok() {
        log("ya habia un daemon vivo, salgo");
        return;
    }
    transport::cleanup_endpoint();
    let listener = match Listener::bind() {
        Ok(l) => l,
        Err(e) => {
            log(&format!("no pude abrir el transporte local: {e}"));
            return;
        }
    };
    log(&format!("daemon arriba (pid {})", std::process::id()));

    let hub = Arc::new(Hub::default());
    loop {
        match listener.accept() {
            Ok(s) => {
                let hub = hub.clone();
                std::thread::spawn(move || serve_client(hub, s));
            }
            Err(e) => log(&format!("accept fallo: {e}")),
        }
    }
}

fn serve_client(hub: Arc<Hub>, stream: Stream) {
    let id = NEXT_CLIENT.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = sync_channel::<Vec<u8>>(CLIENT_QUEUE_MAX);
    let client = Arc::new(Client {
        id,
        out: tx,
        attached: Mutex::new(HashSet::new()),
        alive: Arc::new(AtomicBool::new(true)),
    });
    hub.clients.lock().unwrap().push(client.clone());

    // hilo escritor: un cliente lento nunca frena el PTY (invariante 3)
    let mut wsock = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            log(&format!("clon del socket fallo: {e}"));
            return;
        }
    };
    let walive = client.alive.clone();
    std::thread::spawn(move || {
        while let Ok(frame) = rx.recv() {
            if wsock.write_all(&frame).is_err() {
                walive.store(false, Ordering::Relaxed);
                break;
            }
        }
    });

    let mut rsock = stream;
    let mut saludado = false;
    loop {
        let frame = match read_frame(&mut rsock) {
            Ok(Some(f)) => f,
            Ok(None) => break, // se fue: NO se mata nada
            Err(e) => {
                log(&format!("cliente {id} rompio el stream: {e}"));
                break;
            }
        };
        if frame.kind == KIND_DATA {
            // atajo binario: escribir a la terminal sin pasar por JSON
            write_term(&hub, frame.id, &frame.payload);
            continue;
        }
        let req: Req = match serde_json::from_slice(&frame.payload) {
            Ok(r) => r,
            Err(e) => {
                client.queue(ctl_frame(frame.id, &Res::Err { msg: e.to_string() }));
                continue;
            }
        };
        if !saludado {
            match &req {
                Req::Hello { proto, client: who } => {
                    saludado = true;
                    let terms = hub.terms.lock().unwrap().len();
                    log(&format!(
                        "hello de {who} (proto {proto}), {terms} terminales vivas"
                    ));
                    let res = if *proto == PROTO {
                        Res::Hello {
                            proto: PROTO,
                            pid: std::process::id(),
                            terms,
                        }
                    } else {
                        // el desfase es ESPERADO (app nueva, daemon viejo): se
                        // reporta y decide la app, aqui no se mata nada
                        Res::Err {
                            msg: format!("proto {proto} != {PROTO}"),
                        }
                    };
                    client.queue(ctl_frame(frame.id, &res));
                    continue;
                }
                _ => {
                    client.queue(ctl_frame(
                        frame.id,
                        &Res::Err {
                            msg: "falta hello".into(),
                        },
                    ));
                    continue;
                }
            }
        }
        let res = handle(&hub, &client, req);
        client.queue(ctl_frame(frame.id, &res));
        if matches!(res, Res::Ok) && client.attached.lock().unwrap().is_empty() {
            // nada que hacer: solo evita un warning de rama vacia
        }
    }

    hub.clients.lock().unwrap().retain(|c| c.id != id);
    log(&format!(
        "cliente {id} desconectado (las terminales siguen vivas)"
    ));
}

fn ctl_frame<T: serde::Serialize>(req_id: u32, msg: &T) -> Vec<u8> {
    let body = serde_json::to_vec(msg).unwrap_or_default();
    let mut frame = Vec::with_capacity(body.len() + 9);
    frame.push(KIND_CTL);
    frame.extend_from_slice(&req_id.to_le_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(&body);
    frame
}

fn write_term(hub: &Hub, id: u32, bytes: &[u8]) {
    let w = hub.terms.lock().unwrap().get(&id).map(|t| t.writer.clone());
    if let Some(w) = w {
        if let Ok(mut w) = w.lock() {
            let _ = w.write_all(bytes);
            let _ = w.flush();
        }
    }
}

fn handle(hub: &Arc<Hub>, client: &Arc<Client>, req: Req) -> Res {
    match req {
        Req::Hello { .. } => Res::Ok, // ya saludo
        Req::List => {
            let terms = hub
                .terms
                .lock()
                .unwrap()
                .values()
                .map(|t| {
                    let (cols, rows) = *t.size.lock().unwrap();
                    TermInfo {
                        id: t.id,
                        pid: t.pid,
                        cwd: t.cwd.clone(),
                        cols,
                        rows,
                        buffered: t.ring.lock().unwrap().len(),
                        born_ms: t.born_ms,
                    }
                })
                .collect();
            Res::List { terms }
        }
        Req::Spawn {
            cwd,
            cols,
            rows,
            scrollback: _,
            shell_integration,
            colorfgbg,
            command,
        } => match spawn_term(hub, cwd, cols, rows, shell_integration, colorfgbg, command) {
            Ok((id, pid)) => Res::Spawned { id, pid },
            Err(e) => Res::Err { msg: e },
        },
        Req::Attach { id } => {
            let term = hub.terms.lock().unwrap().get(&id).cloned();
            let Some(term) = term else {
                return Res::Err {
                    msg: format!("no existe la terminal {id}"),
                };
            };
            client.attached.lock().unwrap().insert(id);
            let ring: Vec<u8> = term.ring.lock().unwrap().iter().copied().collect();
            let (cols, rows) = *term.size.lock().unwrap();
            // el replay va DESPUES de la respuesta para que el cliente sepa
            // cuantos bytes esperar antes de empezar a pintar
            let res = Res::Attached {
                id,
                bytes: ring.len(),
                cols,
                rows,
            };
            let mut frame = Vec::with_capacity(ring.len() + 9);
            frame.push(KIND_DATA);
            frame.extend_from_slice(&id.to_le_bytes());
            frame.extend_from_slice(&(ring.len() as u32).to_le_bytes());
            frame.extend_from_slice(&ring);
            client.queue(frame);
            res
        }
        Req::Detach { id } => {
            client.attached.lock().unwrap().remove(&id);
            Res::Ok
        }
        Req::Write { id, data } => {
            write_term(hub, id, data.as_bytes());
            Res::Ok
        }
        Req::Resize { id, cols, rows } => {
            let term = hub.terms.lock().unwrap().get(&id).cloned();
            let Some(term) = term else {
                return Res::Err {
                    msg: format!("no existe la terminal {id}"),
                };
            };
            *term.size.lock().unwrap() = (cols, rows);
            let r = term.master.lock().unwrap().resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
            match r {
                Ok(()) => Res::Ok,
                Err(e) => Res::Err { msg: e.to_string() },
            }
        }
        Req::Kill { id } => {
            let term = hub.terms.lock().unwrap().remove(&id);
            if let Some(t) = term {
                kill_term_tree(&t);
                log(&format!(
                    "terminal {id} matada por peticion (arbol completo)"
                ));
            }
            Res::Ok
        }
        Req::FgPgid { id } => {
            let term = hub.terms.lock().unwrap().get(&id).cloned();
            match term {
                Some(term) => {
                    let pgid = foreground_process(&term);
                    Res::Pgid { id, pgid }
                }
                None => Res::Err {
                    msg: format!("no existe la terminal {id}"),
                },
            }
        }
        Req::FgPgids => {
            let terms: Vec<Arc<Term>> = hub.terms.lock().unwrap().values().cloned().collect();
            #[cfg(target_os = "windows")]
            let foreground = {
                let shell_pids: Vec<u32> = terms.iter().map(|term| term.pid).collect();
                crate::pty::windows_foreground_processes(&shell_pids)
            };
            let list = terms
                .iter()
                .map(|t| PgidEntry {
                    id: t.id,
                    pid: t.pid,
                    #[cfg(target_os = "macos")]
                    pgid: foreground_process(t),
                    #[cfg(target_os = "windows")]
                    pgid: foreground.get(&t.pid).copied().unwrap_or(t.pid as i32),
                })
                .collect();
            Res::Pgids { list }
        }
        Req::Shutdown => {
            let mut terms = hub.terms.lock().unwrap();
            for (_, t) in terms.iter() {
                kill_term_tree(t);
            }
            terms.clear();
            log("shutdown pedido: mato todo y me apago");
            transport::cleanup_endpoint();
            // el proceso entero se va; no hay estado que valga la pena salvar
            std::process::exit(0);
        }
    }
}

/// Mata la terminal ENTERA, no solo al shell — cazado E2E en el banco (30
/// jul): `child.kill()` mata a zsh, pero su nieto (el claude TUI) conserva el
/// slave del PTY abierto → el master jamas da EOF, el reader queda bloqueado
/// reteniendo el Arc del Term (y con el, el master), y el nieto sobrevive de
/// fantasma ~1 min hasta notarlo solo. En el camino local esto no pasaba: el
/// drop inmediato del master mandaba SIGHUP al vuelo. Aqui se replica esa
/// semantica a mano, cortesia primero y certeza despues:
/// 1. SIGHUP al grupo de FOREGROUND (el TUI guarda estado y sale limpio) y al
///    grupo del shell — lo mismo que cerrar la ventana de cualquier terminal.
/// 2. `child.kill()` al shell.
/// 3. Gracia de 1.5s en un hilo aparte y SIGKILL al grupo fg si ignoro el
///    SIGHUP — cerrar es cerrar, no una sugerencia.
fn kill_term_tree(t: &Term) {
    #[cfg(target_os = "macos")]
    {
        let fg = t
            .raw_fd
            .map(|fd| unsafe { libc::tcgetpgrp(fd) })
            .unwrap_or(-1);
        if fg > 0 {
            unsafe { libc::killpg(fg, libc::SIGHUP) };
        }
        if t.pid > 0 && (t.pid as i32) != fg {
            unsafe { libc::killpg(t.pid as i32, libc::SIGHUP) };
        }
        let _ = t.child.lock().unwrap().kill();
        if fg > 0 {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1500));
                // killpg(pg, 0) = ¿el grupo sigue existiendo? Solo entonces el 9.
                if unsafe { libc::killpg(fg, 0) } == 0 {
                    unsafe { libc::killpg(fg, libc::SIGKILL) };
                }
            });
        }
    }
    #[cfg(target_os = "windows")]
    {
        if t.job.terminate().is_err() && !crate::pty::windows_taskkill_tree(t.pid) {
            let _ = t.child.lock().unwrap().kill();
        }
    }
}

#[cfg(target_os = "macos")]
fn foreground_process(t: &Term) -> i32 {
    t.raw_fd
        .map(|fd| unsafe { libc::tcgetpgrp(fd) })
        .unwrap_or(-1)
}

#[cfg(target_os = "windows")]
fn foreground_process(t: &Term) -> i32 {
    crate::pty::windows_foreground_processes(&[t.pid])
        .get(&t.pid)
        .copied()
        .unwrap_or(t.pid as i32)
}

#[allow(clippy::too_many_arguments)]
fn spawn_term(
    hub: &Arc<Hub>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    shell_integration: Option<bool>,
    colorfgbg: Option<String>,
    command: Option<String>,
) -> Result<(u32, u32), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // MISMA construccion que la app: un solo lugar donde vive el scrub de
    // CLAUDE_* y la shell integration (ver pty::build_shell_command)
    // id ANTES del spawn: el hijo nace sabiendo quien es (SFTERM_TERM_ID)
    let id = NEXT_TERM.fetch_add(1, Ordering::SeqCst);
    let (cmd, cwd_final) = crate::pty::build_shell_command(cwd, shell_integration, colorfgbg, id);
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let pid = child.process_id().unwrap_or(0);
    #[cfg(target_os = "windows")]
    let (child, job) = match crate::ptyd::job::Job::assign(pid) {
        Ok(job) => (child, job),
        Err(error) => {
            let mut child = child;
            let _ = child.kill();
            return Err(format!(
                "no pude aislar el árbol ConPTY en un Job Object: {error}"
            ));
        }
    };
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: SharedWriter = Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| e.to_string())?,
    ));
    #[cfg(target_os = "macos")]
    let raw_fd = pair.master.as_raw_fd().map(|fd| fd as i32);

    let term = Arc::new(Term {
        id,
        pid,
        cwd: cwd_final.clone(),
        size: Mutex::new((cols, rows)),
        writer: writer.clone(),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        ring: Mutex::new(VecDeque::new()),
        #[cfg(target_os = "macos")]
        raw_fd,
        #[cfg(target_os = "windows")]
        job,
        born_ms: now_ms(),
    });
    hub.terms.lock().unwrap().insert(id, term.clone());

    // lector: PTY -> ring (para el replay) -> clientes attachados
    let hub_r = hub.clone();
    let term_r = term.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    {
                        let mut ring = term_r.ring.lock().unwrap();
                        ring.extend(buf[..n].iter().copied());
                        let sobra = ring.len().saturating_sub(RING_MAX);
                        if sobra > 0 {
                            ring.drain(..sobra);
                        }
                    }
                    hub_r.broadcast(term_r.id, KIND_DATA, &buf[..n]);
                }
            }
        }
        // el shell murio solo: eso SI cierra la terminal
        let code = term_r
            .child
            .lock()
            .unwrap()
            .try_wait()
            .ok()
            .flatten()
            .map(|s| s.exit_code() as i32);
        hub_r.terms.lock().unwrap().remove(&term_r.id);
        hub_r.evt(&Evt::Exit {
            id: term_r.id,
            code,
        });
        log(&format!(
            "terminal {} termino sola (code {:?})",
            term_r.id, code
        ));
    });

    // comando inicial (presets / ⌘⌥J). Sin engine aqui, asi que no se puede
    // esperar el OSC 133 del prompt como hace la app: se espera un margen fijo
    // y la app puede reintentar con su propia entrega verificada.
    if let Some(cmdline) = command {
        if !cmdline.trim().is_empty() {
            let w = writer.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(700));
                if let Ok(mut w) = w.lock() {
                    let _ = w.write_all(format!(" {}\r", cmdline.trim()).as_bytes());
                    let _ = w.flush();
                }
            });
        }
    }

    log(&format!("terminal {id} nacida (pid {pid}) en {cwd_final}"));
    Ok((id, pid))
}

/// Techo de cola por cliente: expuesto para que el dia que se instrumente,
/// el numero viva en un solo lugar.
pub const fn client_queue_max() -> usize {
    CLIENT_QUEUE_MAX
}
