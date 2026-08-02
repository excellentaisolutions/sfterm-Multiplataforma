//! E2E del daemon real sobre ConPTY + Named Pipe. Estas pruebas crean shells y
//! procesos Windows reales, por eso se ejecutan de forma explícita y serial.

use crate::ptyd::client::Client;
use crate::ptyd::proto::{read_frame, write_ctl, Req, Res, KIND_CTL};
use crate::ptyd::server;
use crate::ptyd::transport;
use std::time::{Duration, Instant};

fn watchdog(test: &'static str) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(60));
        eprintln!("WATCHDOG: {test} superó 60 segundos");
        std::process::abort();
    });
}

fn start_daemon_on_pipe(pipe: &str, client_name: &str) -> Client {
    std::env::set_var("SFTERM_PTYD_PIPE", pipe);
    std::env::set_var("SFTERM_PTYD_E2E_TRACE", "1");
    std::thread::spawn(server::run);

    connect_to_daemon(pipe, client_name)
}

fn connect_to_daemon(pipe: &str, client_name: &str) -> Client {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut last = None;
    while Instant::now() < deadline {
        std::env::set_var("SFTERM_PTYD_PIPE", pipe);
        match Client::connect(client_name) {
            Ok(client) => return client,
            Err(error) => last = Some(error),
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("el daemon no aceptó conexiones: {last:?}");
}

fn start_daemon(name: &str) -> Client {
    let pipe = format!(r"\\.\pipe\sfterm-e2e-{}-{name}", std::process::id());
    start_daemon_on_pipe(&pipe, "windows-e2e")
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

fn raw_request(stream: &mut transport::Stream, request_id: u32, request: &Req) -> Res {
    write_ctl(stream, request_id, request).expect("enviar petición raw");
    loop {
        let frame = read_frame(stream)
            .expect("leer respuesta raw")
            .expect("daemon cerró el cliente raw");
        if frame.kind == KIND_CTL && frame.id == request_id {
            return serde_json::from_slice(&frame.payload).expect("decodificar respuesta raw");
        }
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

fn wait_for_foreground(client: &Client, id: u32, shell_pid: u32, expect_shell: bool) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut output = String::new();
    let mut answered_dsr = 0usize;
    while Instant::now() < deadline {
        output.push_str(&String::from_utf8_lossy(&client.take_data(id)));
        let requested_dsr = output.matches("\x1b[6n").count();
        while answered_dsr < requested_dsr {
            client
                .write_bytes(id, b"\x1b[1;1R")
                .expect("responder DSR del foreground");
            answered_dsr += 1;
        }
        let pid = match client
            .request(&Req::FgPgid { id })
            .expect("consultar foreground")
        {
            Res::Pgid { pgid, .. } if pgid > 0 => pgid as u32,
            _ => {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
        };
        if (expect_shell && pid == shell_pid) || (!expect_shell && pid != shell_pid) {
            return pid;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!(
        "foreground no llegó al estado esperado (shell={shell_pid}, expect_shell={expect_shell}): {output:?}"
    );
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

    let vim = r"C:\Program Files\Git\usr\bin\vim.exe";
    assert!(
        std::path::Path::new(vim).is_file(),
        "Vim E2E no está instalado"
    );
    app1.write_str(
        id,
        "& 'C:\\Program Files\\Git\\usr\\bin\\vim.exe' -u NONE -N\r",
    )
    .expect("arrancar Vim en el daemon");
    let tui_pid = wait_for_foreground(&app1, id, shell_pid, false);
    assert!(
        process_is_alive(tui_pid),
        "Vim no quedó vivo antes de reconectar"
    );

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
    let reconnected_tui_pid = match app2
        .request(&Req::FgPgid { id })
        .expect("consultar TUI tras reconectar")
    {
        Res::Pgid { pgid, .. } if pgid > 0 => pgid as u32,
        other => panic!("foreground tras reconectar devolvió {other:?}"),
    };
    assert_eq!(
        reconnected_tui_pid, tui_pid,
        "el PID de la TUI cambió al reconectar la GUI"
    );

    eprintln!("E2E survival: reanudando terminal {id}");
    match app2
        .request(&Req::Attach { id })
        .expect("reanudar terminal")
    {
        Res::Attached { bytes, .. } => assert!(bytes > 0, "replay vacío"),
        other => panic!("attach devolvió {other:?}"),
    }
    wait_for_occurrences(&app2, id, "SFTERM-E2E-ANTES", 2);
    app2.write_bytes(id, b"\x1b:q!\r").expect("cerrar Vim");
    wait_for_foreground(&app2, id, shell_pid, true);
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

#[test]
#[ignore = "crea dos daemons y dos ConPTY Windows reales"]
fn dos_config_dirs_no_comparten_daemon_ni_terminales() {
    watchdog("dos_config_dirs_no_comparten_daemon_ni_terminales");
    let root = std::env::temp_dir().join(format!("sfterm-e2e-config-{}", std::process::id()));
    let pipe_a = super::pipe_name_for_base(&root.join("a"), 4242);
    let pipe_b = super::pipe_name_for_base(&root.join("b"), 4242);
    assert_ne!(pipe_a, pipe_b, "dos config dirs derivaron el mismo pipe");

    eprintln!("E2E isolation: arrancando daemon A");
    let app_a = start_daemon_on_pipe(&pipe_a, "windows-e2e-config-a");
    let (id_a, pid_a) = spawn_shell(&app_a);

    eprintln!("E2E isolation: arrancando daemon B");
    let app_b = start_daemon_on_pipe(&pipe_b, "windows-e2e-config-b");
    let (id_b, pid_b) = spawn_shell(&app_b);
    assert_ne!(pid_a, pid_b, "cada daemon debe poseer su propio shell");

    let terms_a = match app_a.request(&Req::List).expect("listar daemon A") {
        Res::List { terms } => terms,
        other => panic!("list A devolvió {other:?}"),
    };
    let terms_b = match app_b.request(&Req::List).expect("listar daemon B") {
        Res::List { terms } => terms,
        other => panic!("list B devolvió {other:?}"),
    };
    assert_eq!(terms_a.len(), 1, "daemon A vio terminales ajenas");
    assert_eq!(terms_b.len(), 1, "daemon B vio terminales ajenas");
    assert_eq!(terms_a[0].id, id_a);
    assert_eq!(terms_a[0].pid, pid_a);
    assert_eq!(terms_b[0].id, id_b);
    assert_eq!(terms_b[0].pid, pid_b);

    app_a.request(&Req::Kill { id: id_a }).expect("cerrar A");
    app_b.request(&Req::Kill { id: id_b }).expect("cerrar B");
    eprintln!("E2E isolation: OK");
}

#[test]
#[ignore = "genera output suficiente para saturar un cliente Named Pipe lento"]
fn cliente_lento_no_bloquea_el_pty_ni_el_control() {
    watchdog("cliente_lento_no_bloquea_el_pty_ni_el_control");
    let pipe = format!(r"\\.\pipe\sfterm-e2e-{}-slow", std::process::id());
    // La capacidad de producción es 4096. Reducirla solo en este binario de
    // test provoca la misma rama de saturación sin generar más de 100 MiB.
    std::env::set_var("SFTERM_PTYD_E2E_CLIENT_QUEUE_MAX", "8");
    eprintln!("E2E slow: arrancando daemon");
    let app = start_daemon_on_pipe(&pipe, "windows-e2e-fast-client");
    let (id, _) = spawn_shell(&app);
    app.request(&Req::Attach { id })
        .expect("attach de preparación");
    app.write_str(id, "Write-Output 'SFTERM-SLOW-READY'\r")
        .expect("comprobar prompt");
    wait_for_occurrences(&app, id, "SFTERM-SLOW-READY", 2);
    app.request(&Req::Detach { id })
        .expect("detach del cliente sano");

    std::env::set_var("SFTERM_PTYD_PIPE", &pipe);
    let mut slow = transport::connect().expect("conectar cliente lento");
    match raw_request(
        &mut slow,
        1,
        &Req::Hello {
            proto: super::proto::PROTO,
            client: "windows-e2e-slow-client".into(),
        },
    ) {
        Res::Hello { .. } => {}
        other => panic!("hello lento devolvió {other:?}"),
    }
    match raw_request(&mut slow, 2, &Req::Attach { id }) {
        Res::Attached { .. } => {}
        other => panic!("attach lento devolvió {other:?}"),
    }
    // A partir de aquí el cliente conserva el pipe abierto pero deja de leer.
    // Ocho MiB fuerzan a llenar tanto el buffer Win32 como la cola acotada del
    // daemon. El PTY debe seguir drenándose hasta crear el marcador.
    let marker = std::env::temp_dir().join(format!("sfterm-e2e-slow-{}.done", std::process::id()));
    let _ = std::fs::remove_file(&marker);
    let marker_ps = marker.to_string_lossy().replace('\'', "''");
    let command = format!(
        "$chunk='X'*16384; 1..512 | ForEach-Object {{ [Console]::Out.Write($chunk) }}; Set-Content -LiteralPath '{marker_ps}' -Value done\r"
    );
    eprintln!("E2E slow: generando output con el lector detenido");
    app.write_str(id, &command).expect("iniciar output masivo");

    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && !marker.is_file() {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        marker.is_file(),
        "el output del PTY quedó bloqueado por el cliente lento"
    );

    let control_started = Instant::now();
    match app.request(&Req::List).expect("control tras cliente lento") {
        Res::List { terms } => assert!(terms.iter().any(|term| term.id == id)),
        other => panic!("list tras cliente lento devolvió {other:?}"),
    }
    assert!(
        control_started.elapsed() < Duration::from_secs(2),
        "el cliente lento degradó el canal de control sano"
    );

    drop(slow);
    app.request(&Req::Kill { id }).expect("cerrar terminal");
    let _ = std::fs::remove_file(marker);
    std::env::remove_var("SFTERM_PTYD_E2E_CLIENT_QUEUE_MAX");
    eprintln!("E2E slow: OK");
}

#[test]
#[ignore = "arranca el binario app real desde su copia versionada"]
fn daemon_versionado_permite_reemplazar_el_ejecutable_principal() {
    watchdog("daemon_versionado_permite_reemplazar_el_ejecutable_principal");
    let app_exe = std::env::var_os("SFTERM_WINDOWS_PTYD_APP_EXE")
        .map(std::path::PathBuf::from)
        .expect("el harness debe compilar y proporcionar app.exe");
    assert!(app_exe.is_file(), "no existe {}", app_exe.display());

    let root = std::env::temp_dir().join(format!("sfterm-e2e-rebuild-{}", std::process::id()));
    let install_dir = root.join("install");
    let state_dir = root.join("state");
    std::fs::create_dir_all(&install_dir).expect("crear instalación temporal");
    let installed = install_dir.join("sfterm.exe");
    std::fs::copy(&app_exe, &installed).expect("crear ejecutable instalable");
    let daemon_exe = crate::ptyd::client::daemon_executable_from(&installed, &state_dir)
        .expect("crear copia versionada del daemon");
    assert_ne!(daemon_exe, installed);

    let pipe = format!(r"\\.\pipe\sfterm-e2e-{}-rebuild", std::process::id());
    eprintln!("E2E rebuild: arrancando {}", daemon_exe.display());
    let mut daemon = std::process::Command::new(&daemon_exe)
        .arg("--ptyd")
        .env("SFTERM_PTYD_PIPE", &pipe)
        .env("SFTERM_CONFIG_DIR", &state_dir)
        .env("SFTERM_PTYD_E2E_TRACE", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("arrancar daemon versionado");
    let app = connect_to_daemon(&pipe, "windows-e2e-rebuild-client");
    let (id, shell_pid) = spawn_shell(&app);
    app.request(&Req::Attach { id })
        .expect("attach antes del rebuild");
    app.write_str(id, "Write-Output 'SFTERM-ANTES-REBUILD'\r")
        .expect("marcador previo");
    wait_for_occurrences(&app, id, "SFTERM-ANTES-REBUILD", 2);

    // Si el daemon estuviera ejecutándose desde `installed`, Windows impediría
    // borrar este archivo. La copia versionada mantiene libre el instalable.
    let replacement = install_dir.join("sfterm-replacement.tmp");
    std::fs::copy(&app_exe, &replacement).expect("preparar reemplazo");
    std::fs::remove_file(&installed).expect("el ejecutable principal quedó bloqueado");
    std::fs::rename(&replacement, &installed).expect("instalar reemplazo");

    assert!(
        process_is_alive(shell_pid),
        "el shell murió durante el reemplazo"
    );
    app.write_str(id, "Write-Output 'SFTERM-DESPUES-REBUILD'\r")
        .expect("marcador posterior");
    wait_for_occurrences(&app, id, "SFTERM-DESPUES-REBUILD", 2);
    app.request(&Req::Kill { id }).expect("cerrar terminal");
    let _ = app.request(&Req::Shutdown);
    drop(app);

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && daemon.try_wait().ok().flatten().is_none() {
        std::thread::sleep(Duration::from_millis(50));
    }
    if daemon.try_wait().ok().flatten().is_none() {
        let _ = daemon.kill();
        let _ = daemon.wait();
    }
    let _ = std::fs::remove_dir_all(root);
    eprintln!("E2E rebuild: OK");
}
