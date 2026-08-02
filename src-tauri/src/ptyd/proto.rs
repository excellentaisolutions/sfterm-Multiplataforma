//! Protocolo del daemon de PTYs (`sfterm-ptyd`).
//!
//! UN socket unix multiplexado. Todo viaja en el mismo marco binario para no
//! mezclar "lineas JSON" con bytes crudos de terminal (un `\n` dentro del
//! output de una terminal partiria el mensaje de control de al lado):
//!
//! ```text
//! [u8 kind][u32 id LE][u32 len LE][payload de `len` bytes]
//! ```
//!
//! - `kind = CTL`  → `payload` es JSON (`Req` del cliente / `Res` del daemon).
//!   `id` es el numero de peticion, para poder responder fuera de orden.
//! - `kind = DATA` → `payload` son BYTES CRUDOS del PTY. `id` es la terminal.
//!   Cero parsing: el engine de la app ya sabe comerse este stream tal cual.
//!
//! La version de PROTOCOLO es lo unico que tiene que casar entre app y daemon,
//! y por eso se mueve lo menos posible: un rebuild de la app deja vivo al
//! daemon viejo (ESE es el punto de todo esto), asi que los dos lados van a
//! estar desfasados casi siempre. Si algun dia cambia, el handshake lo detecta
//! y la app decide (reciclar el daemon, con las terminales que eso cuesta).

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

/// Sube SOLO si el formato deja de ser compatible hacia atras.
pub const PROTO: u32 = 1;

pub const KIND_CTL: u8 = 1;
pub const KIND_DATA: u8 = 2;

/// Peticiones del cliente (la app) al daemon.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Req {
    /// Primer mensaje. Sin handshake, el daemon no atiende nada mas.
    Hello { proto: u32, client: String },
    /// Terminales vivas (las de la sesion anterior incluidas: ese es el punto).
    List,
    Spawn {
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        scrollback: Option<usize>,
        shell_integration: Option<bool>,
        /// "0;15" claro / "15;0" oscuro — lo calcula la app desde su tema.
        colorfgbg: Option<String>,
        /// Comando inicial opcional (paneles "agent" de los presets).
        command: Option<String>,
    },
    /// Empieza a recibir DATA de esta terminal. Responde `Attached` y a
    /// continuacion manda el REPLAY (frames DATA con lo que el daemon guardo
    /// mientras la app no existia): eso es lo que repinta la pantalla donde se
    /// quedo, con colores y todo, sin que el proceso se entere de nada.
    Attach { id: u32 },
    Detach { id: u32 },
    Write { id: u32, data: String },
    Resize { id: u32, cols: u16, rows: u16 },
    Kill { id: u32 },
    /// Grupo de proceso en primer plano del PTY (tcgetpgrp). Lo necesita
    /// `term_session` para resolver la verdad del piso, y solo se puede
    /// preguntar desde quien tiene el fd del master: el daemon.
    FgPgid { id: u32 },
    /// Todos los fg pgids en UN viaje: el loop de metrics pregunta cada 1.5s
    /// por TODAS las terminales — un roundtrip por terminal por tick seria
    /// castigar al daemon por existir. Un daemon viejo que no conozca este op
    /// responde Err y el cliente cae al per-terminal (degradacion, no muerte).
    FgPgids,
    /// Mata TODO y apaga el daemon. Gesto explicito, nunca automatico.
    Shutdown,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "res", rename_all = "snake_case")]
pub enum Res {
    Hello { proto: u32, pid: u32, terms: usize },
    Spawned { id: u32, pid: u32 },
    List { terms: Vec<TermInfo> },
    /// `bytes` = cuanto replay viene detras en frames DATA.
    Attached { id: u32, bytes: usize, cols: u16, rows: u16 },
    Pgid { id: u32, pgid: i32 },
    Pgids { list: Vec<PgidEntry> },
    Ok,
    Err { msg: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PgidEntry {
    pub id: u32,
    pub pid: u32,
    pub pgid: i32,
}

/// Aviso del daemon sin peticion previa (id de peticion = 0).
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "evt", rename_all = "snake_case")]
pub enum Evt {
    Exit { id: u32, code: Option<i32> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TermInfo {
    pub id: u32,
    pub pid: u32,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    /// Bytes guardados para el replay (0 = nacio y no ha escrito nada).
    pub buffered: usize,
    /// Nacimiento del PTY (epoch ms): la app decide que hacer con las huerfanas.
    pub born_ms: u64,
}

// ---------- marcos ----------

pub fn write_frame(w: &mut impl Write, kind: u8, id: u32, payload: &[u8]) -> std::io::Result<()> {
    let mut head = [0u8; 9];
    head[0] = kind;
    head[1..5].copy_from_slice(&id.to_le_bytes());
    head[5..9].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    w.write_all(&head)?;
    w.write_all(payload)?;
    w.flush()
}

pub fn write_ctl<T: Serialize>(w: &mut impl Write, id: u32, msg: &T) -> std::io::Result<()> {
    let body = serde_json::to_vec(msg).unwrap_or_else(|_| b"{}".to_vec());
    write_frame(w, KIND_CTL, id, &body)
}

pub struct Frame {
    pub kind: u8,
    pub id: u32,
    pub payload: Vec<u8>,
}

/// Lee un marco completo. `Ok(None)` = el otro lado cerro limpio.
pub fn read_frame(r: &mut impl Read) -> std::io::Result<Option<Frame>> {
    let mut head = [0u8; 9];
    if let Err(e) = r.read_exact(&mut head) {
        // EOF limpio en el primer byte no es un error: es "se fue"
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            return Ok(None);
        }
        return Err(e);
    }
    let kind = head[0];
    let id = u32::from_le_bytes(head[1..5].try_into().unwrap());
    let len = u32::from_le_bytes(head[5..9].try_into().unwrap()) as usize;
    // techo de cordura: un marco de control absurdo es un stream desincronizado,
    // y seguir leyendo solo empeora el diagnostico
    if len > 64 * 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "marco absurdo (stream desincronizado)",
        ));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok(Some(Frame { kind, id, payload }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marco_ida_y_vuelta() {
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, KIND_DATA, 7, b"hola \x1b[31mrojo\x1b[0m").unwrap();
        let mut cur = std::io::Cursor::new(buf);
        let f = read_frame(&mut cur).unwrap().unwrap();
        assert_eq!(f.kind, KIND_DATA);
        assert_eq!(f.id, 7);
        assert_eq!(f.payload, b"hola \x1b[31mrojo\x1b[0m");
        // stream agotado = None, no error
        assert!(read_frame(&mut cur).unwrap().is_none());
    }

    #[test]
    fn control_json_ida_y_vuelta() {
        let mut buf: Vec<u8> = Vec::new();
        write_ctl(&mut buf, 3, &Req::Attach { id: 42 }).unwrap();
        let mut cur = std::io::Cursor::new(buf);
        let f = read_frame(&mut cur).unwrap().unwrap();
        assert_eq!(f.kind, KIND_CTL);
        assert_eq!(f.id, 3);
        match serde_json::from_slice::<Req>(&f.payload).unwrap() {
            Req::Attach { id } => assert_eq!(id, 42),
            other => panic!("mensaje equivocado: {other:?}"),
        }
    }

    /// El caso que motiva los marcos binarios: output de terminal con \n y con
    /// JSON adentro no puede partir el canal de control.
    #[test]
    fn data_con_saltos_de_linea_no_rompe_el_canal() {
        let sucio = b"{\"op\":\"kill\"}\nmas basura\n\n";
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, KIND_DATA, 1, sucio).unwrap();
        write_ctl(&mut buf, 9, &Req::List).unwrap();
        let mut cur = std::io::Cursor::new(buf);
        let a = read_frame(&mut cur).unwrap().unwrap();
        assert_eq!(a.payload, sucio);
        let b = read_frame(&mut cur).unwrap().unwrap();
        assert_eq!(b.kind, KIND_CTL);
        assert_eq!(b.id, 9);
    }
}
