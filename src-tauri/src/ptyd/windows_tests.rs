//! E2E del daemon real sobre ConPTY + Named Pipe. Estas pruebas crean shells y
//! procesos Windows reales, por eso se ejecutan de forma explícita y serial.

use crate::ptyd::client::Client;
use crate::ptyd::proto::{Req, Res};
use crate::ptyd::server;
use std::time::{Duration, Instant};

fn watchdog(test: &'static str) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        eprintln!("WATCHDOG: {test} superó 60 segundos");
        std::process::abort();
    });
}

fn start_daemon(name: &str) -> Client {
    let pipe = format!(r"\\.\pipe\sfterm-e2e-{}-{name}", std::process::id());
    std::env::set_var("SFTERM_PTYD_PIPE", pipe);
    std::env::set_var("SFTERM_PTYD_E2E_TRACE", "1");
    std::thread::spawn(server::run);

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut last = None;
    while Instant::now() < deadline {
        match Client::connect("windows-e2e") {
            Ok(client) => return client,
            Err(error) => last = Some(error),
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("el daemon no aceptó conexiones: {last:?}");
}

fn spawn_shell(client: &Client) -> (u32, u32) {
    match client
        .request(&Req::Spawn {
            cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
            cols: 100,
            rows: 30,
            scrollback: Some(8000),
            shell_integration: Some(false),
            colorfgbg: None,
            command: None,
        })
        .expect("crear ConPTY en el daemon")
    {
        Res::Spawned { id, pid } => (id, pid),
        other => panic!("spawn devolvió {other:?}"),
    }
}

fn wait_for_occurrences(client: &Client, id: u32, marker: &str, count: usize) -> String {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = String::new();
    let mut answered_dsr = 0usize;
    while Instant::now() < deadline {
        output.push_str(&String::from_utf8_lossy(&client.take_data(id)));
        if output.matches(marker).count() >= count {
            break;
        }
        let requested_dsr = output.matches("\x1b[6n").count();
        while answered_dsr < requested_dsr {
            client
                .write_bytes(id, b"\x1b[1;1R")
                .expect("responder DSR de ConPTY");
            answered_dsr += 1;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    assert!(
        output.matches(marker).count() >= count,
        "la terminal no produjo {count} apariciones de {marker:?}: {output:?}"
    );
    output
}

fn process_is_alive(pid: u32) -> bool {
    let output = std::process::Command::new("tasklist.exe")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .expect("consultar tasklist");
    String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
}

fn child_pid_from(output: &str, marker: &str) -> Option<u32> {
    output.match_indices(marker).find_map(|(at, _)| {
        output[at + marker.len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .parse()
            .ok()
    })
}

fn wait_for_child_pid(client: &Client, id: u32, marker: &str) -> (u32, String) {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = String::new();
    let mut answered_dsr = 0usize;
    while Instant::now() < deadline {
        output.push_str(&String::from_utf8_lossy(&client.take_data(id)));
        if let Some(pid) = child_pid_from(&output, marker) {
            return (pid, output);
        }
        let requested_dsr = output.matches("\x1b[6n").count();
        while answered_dsr < requested_dsr {
            client
                .write_bytes(id, b"\x1b[1;1R")
                .expect("responder DSR de ConPTY");
            answered_dsr += 1;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
    panic!("el shell no informó el PID descendiente: {output:?}");
}

#[test]
#[ignore = "crea un daemon, un ConPTY y procesos Windows reales"]
fn terminal_sobrevive_reconexion_y_conserva_pid_y_replay() {
    watchdog("terminal_sobrevive_reconexion_y_conserva_pid_y_replay");
    eprintln!("E2E survival: arrancando daemon");
    let app1 = start_daemon("survival");
    eprintln!("E2E survival: creando ConPTY");
    let (id, shell_pid) = spawn_shell(&app1);
    app1.request(&Req::Attach { id }).expect("attach inicial");
    app1.write_str(id, "Write-Output 'SFTERM-E2E-ANTES'\r")
        .expect("escribir marcador");
    // Una aparición es el eco de entrada de ConPTY; la segunda demuestra que
    // PowerShell ejecutó el comando y produjo output.
    wait_for_occurrences(&app1, id, "SFTERM-E2E-ANTES", 2);

    eprintln!("E2E survival: desconectando primer cliente");
    drop(app1);
    std::thread::sleep(Duration::from_millis(250));

    eprintln!("E2E survival: conectando segundo cliente");
    let app2 = Client::connect("windows-e2e-reconnect").expect("reconectar");
    let terms = match app2.request(&Req::List).expect("listar terminales") {
        Res::List { terms } => terms,
        other => panic!("list devolvió {other:?}"),
    };
    let term = terms
        .iter()
        .find(|term| term.id == id)
        .expect("terminal viva");
    assert_eq!(term.pid, shell_pid, "el shell cambió al reconectar la GUI");

    eprintln!("E2E survival: reanudando terminal {id}");
    match app2
        .request(&Req::Attach { id })
        .expect("reanudar terminal")
    {
        Res::Attached { bytes, .. } => assert!(bytes > 0, "replay vacío"),
        other => panic!("attach devolvió {other:?}"),
    }
    wait_for_occurrences(&app2, id, "SFTERM-E2E-ANTES", 2);
    app2.write_str(id, "Write-Output 'SFTERM-E2E-DESPUES'\r")
        .expect("escribir tras reconectar");
    wait_for_occurrences(&app2, id, "SFTERM-E2E-DESPUES", 2);
    eprintln!("E2E survival: cerrando terminal");
    app2.request(&Req::Kill { id }).expect("cerrar terminal");
    eprintln!("E2E survival: OK");
}

#[test]
#[ignore = "crea un daemon, un ConPTY y procesos Windows reales"]
fn close_elimina_shell_y_descendiente_sin_huerfanos() {
    watchdog("close_elimina_shell_y_descendiente_sin_huerfanos");
    eprintln!("E2E tree: arrancando daemon");
    let app = start_daemon("process-tree");
    eprintln!("E2E tree: creando ConPTY");
    let (id, shell_pid) = spawn_shell(&app);
    app.request(&Req::Attach { id }).expect("attach");

    let command = "$p=Start-Process powershell.exe -WindowStyle Hidden "
        .to_owned()
        + "-ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 300' -PassThru;"
        + "Write-Output ('SFTERM-CHILD-' + $p.Id)\r";
    app.write_str(id, &command).expect("crear descendiente");
    let (child_pid, _output) = wait_for_child_pid(&app, id, "SFTERM-CHILD-");
    eprintln!("E2E tree: shell={shell_pid}, child={child_pid}");
    assert!(process_is_alive(shell_pid));
    assert!(process_is_alive(child_pid));

    app.request(&Req::Kill { id }).expect("close terminal");
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && (process_is_alive(shell_pid) || process_is_alive(child_pid))
    {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!process_is_alive(shell_pid), "el shell quedó huérfano");
    assert!(
        !process_is_alive(child_pid),
        "el descendiente quedó huérfano"
    );
    eprintln!("E2E tree: OK");
}
