//! La prueba que decide si el daemon vale la pena: **una terminal sobrevive a
//! que el cliente se vaya, y al volver la pantalla sigue donde estaba.**
//!
//! Corre contra un daemon REAL (mismo codigo que el de produccion) en un socket
//! propio (`SFTERM_PTYD_SOCK`), nunca contra el que tiene las conversaciones de
//! Daniel abiertas.
//!
//! `#[ignore]` por el mismo criterio que el test de la Papelera: arranca
//! procesos de verdad y tarda segundos. Se corre a mano:
//! `cargo test ptyd -- --ignored --test-threads=1`

use crate::ptyd::client::Client;
use crate::ptyd::proto::*;
use crate::ptyd::server;

fn arranca_daemon(nombre: &str) -> String {
    let sock = std::env::temp_dir().join(format!("sfterm-test-{nombre}.sock"));
    let s = sock.to_string_lossy().to_string();
    std::env::set_var("SFTERM_PTYD_SOCK", &s);
    let _ = std::fs::remove_file(&sock);
    std::thread::spawn(server::run);
    // el bind tarda un pestañeo; reintentar es mas honesto que dormir a ojo
    for _ in 0..50 {
        if std::os::unix::net::UnixStream::connect(&sock).is_ok() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(40));
    }
    s
}

#[test]
#[ignore]
fn la_conversacion_sobrevive_a_que_el_cliente_se_vaya() {
    arranca_daemon("supervivencia");

    // --- la app abre una terminal y "trabaja" en ella ---
    let app1 = Client::connect("test-app-1").expect("conectar");
    let id = match app1
        .request(&Req::Spawn {
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
            scrollback: Some(8000),
            shell_integration: Some(false),
            colorfgbg: None,
            command: None,
        })
        .expect("spawn")
    {
        Res::Spawned { id, .. } => id,
        otro => panic!("spawn devolvio {otro:?}"),
    };
    app1.request(&Req::Attach { id }).expect("attach");
    app1.wait_data(id, 4000, |s| {
        s.contains('$') || s.contains('%') || s.contains('#')
    });

    // un marcador irrepetible: si aparece en el replay, la pantalla se conservo
    app1.write_str(id, "echo MARCA-DE-LA-CONVERSACION\n")
        .unwrap();
    let visto = app1.wait_data(id, 4000, |s| s.contains("MARCA-DE-LA-CONVERSACION"));
    assert!(
        visto.contains("MARCA-DE-LA-CONVERSACION"),
        "la terminal no respondio: {visto:?}"
    );

    // --- la app MUERE (rebuild) ---
    drop(app1);
    std::thread::sleep(std::time::Duration::from_millis(300));

    // --- la app nueva abre y engancha donde estaba ---
    let app2 = Client::connect("test-app-2").expect("reconectar");
    let terms = match app2.request(&Req::List).expect("list") {
        Res::List { terms } => terms,
        otro => panic!("list devolvio {otro:?}"),
    };
    assert!(
        terms.iter().any(|t| t.id == id),
        "la terminal murio con la app: {terms:?}",
    );

    match app2.request(&Req::Attach { id }).expect("re-attach") {
        Res::Attached { bytes, .. } => assert!(bytes > 0, "replay vacio"),
        otro => panic!("attach devolvio {otro:?}"),
    }
    let replay = app2.wait_data(id, 3000, |s| s.contains("MARCA-DE-LA-CONVERSACION"));
    assert!(
        replay.contains("MARCA-DE-LA-CONVERSACION"),
        "el replay no trajo la pantalla anterior: {replay:?}",
    );

    // y sobre todo: el PROCESO sigue vivo, no es una foto
    app2.write_str(id, "echo SIGUE-VIVO\n").unwrap();
    let vivo = app2.wait_data(id, 4000, |s| s.contains("SIGUE-VIVO"));
    assert!(vivo.contains("SIGUE-VIVO"), "el shell quedo mudo: {vivo:?}");

    let _ = app2.request(&Req::Kill { id });
}

/// Las piezas que el PUENTE de la app usa: fg pgids en UN viaje (loop de
/// metrics) y el drenado bloqueante de frames (el drenador unico).
#[test]
#[ignore]
fn fg_pgids_batcheado_y_drenado_de_frames() {
    arranca_daemon("batch");
    let app = Client::connect("test-batch").expect("conectar");
    let id = match app
        .request(&Req::Spawn {
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
            scrollback: None,
            shell_integration: Some(false),
            colorfgbg: None,
            command: None,
        })
        .unwrap()
    {
        Res::Spawned { id, .. } => id,
        otro => panic!("{otro:?}"),
    };
    // batcheado: la terminal aparece con SU pid y un pgid real (>0 cuando el
    // shell ya tomo el foreground; -1 es valido en la ventana de arranque)
    match app.request(&Req::FgPgids).unwrap() {
        Res::Pgids { list } => {
            let e = list
                .iter()
                .find(|e| e.id == id)
                .expect("terminal en el batch");
            assert!(e.pid > 0, "pid del shell: {e:?}");
        }
        otro => panic!("FgPgids devolvio {otro:?}"),
    }
    // drenado: attach + un echo → wait_frames entrega los bytes de ESA terminal
    app.request(&Req::Attach { id }).unwrap();
    app.write_str(id, "echo DRENADO-OK\n").unwrap();
    let hasta = std::time::Instant::now() + std::time::Duration::from_secs(4);
    let mut visto = String::new();
    while std::time::Instant::now() < hasta && !visto.contains("DRENADO-OK") {
        let batch = app.wait_frames(300);
        for (t, bytes) in batch.data {
            if t == id {
                visto.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
        assert!(!batch.closed, "el daemon se cayo a media prueba");
    }
    assert!(
        visto.contains("DRENADO-OK"),
        "wait_frames no trajo el output: {visto:?}"
    );
    let _ = app.request(&Req::Kill { id });
}

/// Kill mata el ARBOL, no solo al shell (bug cazado E2E 30 jul): un nieto que
/// conserva el slave del PTY (claude, o aqui un sleep) quedaba de fantasma
/// ~1 min porque el master jamas daba EOF. Con kill_term_tree muere al vuelo.
#[test]
#[ignore]
fn kill_mata_el_arbol_completo() {
    arranca_daemon("arbol");
    let app = Client::connect("test-arbol").expect("conectar");
    let (id, shell_pid) = match app
        .request(&Req::Spawn {
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
            scrollback: None,
            shell_integration: Some(false),
            colorfgbg: None,
            command: None,
        })
        .unwrap()
    {
        Res::Spawned { id, pid } => (id, pid),
        otro => panic!("{otro:?}"),
    };
    app.request(&Req::Attach { id }).unwrap();
    app.wait_data(id, 4000, |s| {
        s.contains('%') || s.contains('$') || s.contains('#')
    });
    app.write_str(id, "sleep 300\n").unwrap();
    // el nieto: el sleep hijo del shell (via pgrep, contra procesos REALES)
    let mut nieto: Option<i32> = None;
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let out = std::process::Command::new("pgrep")
            .args(["-P", &shell_pid.to_string(), "sleep"])
            .output()
            .expect("pgrep");
        if let Some(p) = String::from_utf8_lossy(&out.stdout).lines().next() {
            if let Ok(p) = p.trim().parse::<i32>() {
                nieto = Some(p);
                break;
            }
        }
    }
    let nieto = nieto.expect("el sleep nunca aparecio como hijo del shell");

    app.request(&Req::Kill { id }).unwrap();
    // SIGHUP inmediato (sleep no lo ignora): muerto en bastante menos que la
    // gracia de 1.5s del SIGKILL de respaldo
    let mut murio = false;
    for _ in 0..30 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if unsafe { libc::kill(nieto, 0) } != 0 {
            murio = true;
            break;
        }
    }
    assert!(
        murio,
        "el nieto (sleep {nieto}) sobrevivio al Kill: fantasma"
    );
}

/// El unico gesto que SI mata: pedirlo. Ninguna desconexion debe hacerlo.
#[test]
#[ignore]
fn kill_explicito_si_cierra_la_terminal() {
    arranca_daemon("kill");
    let app = Client::connect("test-kill").expect("conectar");
    let id = match app
        .request(&Req::Spawn {
            cwd: Some("/tmp".into()),
            cols: 80,
            rows: 24,
            scrollback: None,
            shell_integration: Some(false),
            colorfgbg: None,
            command: None,
        })
        .unwrap()
    {
        Res::Spawned { id, .. } => id,
        otro => panic!("{otro:?}"),
    };
    app.request(&Req::Kill { id }).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(200));
    match app.request(&Req::List).unwrap() {
        Res::List { terms } => assert!(!terms.iter().any(|t| t.id == id), "seguia viva tras Kill"),
        otro => panic!("{otro:?}"),
    }
}
