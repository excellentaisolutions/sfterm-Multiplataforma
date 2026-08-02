//! Cliente del daemon. Lo usa la app (fase 2) y los tests de integracion.
//!
//! Modelo: peticiones con respuesta (bloqueantes, por id) + un flujo de marcos
//! DATA que llega cuando quiere. Todo lo que no es la respuesta que se espera
//! se guarda en un buzon en vez de tirarse, porque el output de una terminal
//! puede llegar EN MEDIO de un ida y vuelta de control y perderlo seria perder
//! pantalla.

use crate::ptyd::proto::*;
use crate::ptyd::socket_path;
use std::io;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};

#[derive(Default)]
struct Inbox {
    /// respuestas de control por id de peticion
    res: Vec<(u32, Vec<u8>)>,
    /// marcos DATA (id de terminal, bytes) en orden de llegada
    data: Vec<(u32, Vec<u8>)>,
    /// eventos no solicitados (id 0)
    evts: Vec<Vec<u8>>,
    closed: bool,
}

pub struct Client {
    w: Mutex<UnixStream>,
    next: AtomicU32,
    inbox: Arc<(Mutex<Inbox>, Condvar)>,
}

/// Lo que `wait_frames` entrega en un drenado.
pub struct FrameBatch {
    /// (id de terminal, bytes crudos) en orden de llegada
    pub data: Vec<(u32, Vec<u8>)>,
    /// eventos no solicitados del daemon (JSON de `Evt`)
    pub evts: Vec<Vec<u8>>,
    pub closed: bool,
}

impl Client {
    /// Conecta a un daemon YA vivo. `None` si no hay ninguno.
    pub fn connect(who: &str) -> io::Result<Client> {
        let sock = UnixStream::connect(socket_path())?;
        let rsock = sock.try_clone()?;
        let inbox: Arc<(Mutex<Inbox>, Condvar)> = Arc::default();
        let inbox_r = inbox.clone();
        std::thread::spawn(move || {
            let mut r = rsock;
            loop {
                match read_frame(&mut r) {
                    Ok(Some(f)) => {
                        let (lock, cv) = &*inbox_r;
                        let mut b = lock.lock().unwrap();
                        if f.kind == KIND_DATA {
                            b.data.push((f.id, f.payload));
                        } else if f.id == 0 {
                            b.evts.push(f.payload);
                        } else {
                            b.res.push((f.id, f.payload));
                        }
                        cv.notify_all();
                    }
                    _ => {
                        let (lock, cv) = &*inbox_r;
                        lock.lock().unwrap().closed = true;
                        cv.notify_all();
                        break;
                    }
                }
            }
        });
        let c = Client {
            w: Mutex::new(sock),
            next: AtomicU32::new(1),
            inbox,
        };
        match c.request(&Req::Hello { proto: PROTO, client: who.into() })? {
            Res::Hello { proto, .. } if proto == PROTO => Ok(c),
            Res::Err { msg } => Err(io::Error::other(msg)),
            other => Err(io::Error::other(format!("handshake raro: {other:?}"))),
        }
    }

    pub fn request(&self, req: &Req) -> io::Result<Res> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        {
            let mut w = self.w.lock().unwrap();
            write_ctl(&mut *w, id, req)?;
        }
        let (lock, cv) = &*self.inbox;
        let mut b = lock.lock().unwrap();
        loop {
            if let Some(pos) = b.res.iter().position(|(rid, _)| *rid == id) {
                let (_, body) = b.res.remove(pos);
                return serde_json::from_slice(&body).map_err(io::Error::other);
            }
            if b.closed {
                return Err(io::Error::other("el daemon cerro la conexion"));
            }
            let (nb, timeout) = cv
                .wait_timeout(b, std::time::Duration::from_secs(10))
                .unwrap();
            b = nb;
            if timeout.timed_out() {
                return Err(io::Error::other("el daemon no respondio en 10s"));
            }
        }
    }

    /// Drena TODO lo acumulado (data de cualquier terminal + eventos) o espera
    /// hasta `ms` a que llegue algo. Es el corazon del drenador de la app: UN
    /// hilo que bloquea aqui y reparte a los engines/canales, en vez de N hilos
    /// sondeando. `closed=true` = el daemon se fue (y con el, sus terminales).
    pub fn wait_frames(&self, ms: u64) -> FrameBatch {
        let (lock, cv) = &*self.inbox;
        let mut b = lock.lock().unwrap();
        if b.data.is_empty() && b.evts.is_empty() && !b.closed {
            let (nb, _) = cv
                .wait_timeout(b, std::time::Duration::from_millis(ms))
                .unwrap();
            b = nb;
        }
        FrameBatch {
            data: std::mem::take(&mut b.data),
            evts: std::mem::take(&mut b.evts),
            closed: b.closed,
        }
    }

    /// Bytes de una terminal recibidos hasta ahora (se vacian al leerlos).
    pub fn take_data(&self, term: u32) -> Vec<u8> {
        let (lock, _) = &*self.inbox;
        let mut b = lock.lock().unwrap();
        let mut out = Vec::new();
        b.data.retain(|(id, bytes)| {
            if *id == term {
                out.extend_from_slice(bytes);
                false
            } else {
                true
            }
        });
        out
    }

    /// Espera hasta `ms` a que aparezcan bytes de esa terminal que casen con
    /// `pred`. Devuelve todo lo acumulado. Para tests: sondear en bucle es la
    /// unica forma honesta de esperar output real de un shell.
    pub fn wait_data(&self, term: u32, ms: u64, pred: impl Fn(&str) -> bool) -> String {
        let hasta = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        let mut acc = String::new();
        while std::time::Instant::now() < hasta {
            acc.push_str(&String::from_utf8_lossy(&self.take_data(term)));
            if pred(&acc) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        acc
    }

    pub fn write_bytes(&self, term: u32, bytes: &[u8]) -> io::Result<()> {
        let mut w = self.w.lock().unwrap();
        write_frame(&mut *w, KIND_DATA, term, bytes)
    }
}

/// Conecta, y si no hay daemon lo LEVANTA (el mismo ejecutable con `--ptyd`,
/// desprendido con setsid para que no muera con quien lo lanzo).
pub fn connect_or_start(who: &str) -> io::Result<Client> {
    if let Ok(c) = Client::connect(who) {
        return Ok(c);
    }
    start_daemon()?;
    // el socket tarda unos ms en aparecer; reintentar es mas barato y mas
    // fiable que dormir una cifra al azar
    let hasta = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut ultimo = io::Error::other("sin intentos");
    while std::time::Instant::now() < hasta {
        match Client::connect(who) {
            Ok(c) => return Ok(c),
            Err(e) => ultimo = e,
        }
        std::thread::sleep(std::time::Duration::from_millis(60));
    }
    Err(ultimo)
}

pub fn start_daemon() -> io::Result<()> {
    let exe = std::env::current_exe()?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(crate::ptyd::log_path())?;
    let err = log.try_clone()?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--ptyd").stdout(log).stderr(err).stdin(std::process::Stdio::null());
    // setsid: sesion propia. Sin esto el daemon comparte grupo con la app y una
    // señal al grupo (o cerrar la terminal que la lanzo) se lo lleva por
    // delante — justo lo que este proceso existe para evitar.
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn()?;
    Ok(())
}

/// Escribe texto (atajo legible sobre `write_bytes`).
impl Client {
    pub fn write_str(&self, term: u32, s: &str) -> io::Result<()> {
        self.write_bytes(term, s.as_bytes())
    }
}
