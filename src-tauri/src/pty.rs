use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, State};

pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// Quien es el DUEÑO fisico del PTY de esta sesion.
///
/// - `Local`: el clasico — el PTY es hijo de la app (muere con ella). Es el
///   fallback cuando el daemon no esta.
/// - `Daemon`: el PTY vive en `sfterm-ptyd` (sobrevive rebuild/cierre); la app
///   solo tiene el writer-adaptador y el id. Todo lo que aqui necesita fd/child
///   (resize, kill, tcgetpgrp, try_wait) viaja por el protocolo del daemon.
pub enum PtyBackend {
    Local {
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send + Sync>,
        raw_fd: Option<i32>,
    },
    Daemon,
}

pub struct PtySession {
    pub writer: SharedWriter,
    pub backend: PtyBackend,
    pub shell_pid: u32,
    pub exited: bool,
}

impl PtySession {
    pub fn is_daemon(&self) -> bool {
        matches!(self.backend, PtyBackend::Daemon)
    }
}

#[derive(Default)]
pub struct PtyState {
    pub sessions: Mutex<HashMap<u32, PtySession>>,
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// Los ids del daemon y los locales comparten espacio (el frontend no distingue
/// — no debe). El daemon asigna los suyos; esto empuja el contador local por
/// encima para que un fallback a local jamas RE-USE un id vivo del daemon (dos
/// terminales con el mismo id = canales cruzados, el peor bug silencioso).
pub fn ensure_next_id_above(id: u32) {
    NEXT_ID.fetch_max(id + 1, Ordering::SeqCst);
}

#[derive(Clone, Serialize)]
pub struct PtyExit {
    pub id: u32,
    pub code: Option<u32>,
}

pub fn expand_tilde(p: &str) -> String {
    if p == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().to_string();
        }
    }
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    p.to_string()
}

/// El shell que corre DENTRO de un PTY, con el entorno que esta app garantiza.
/// Vive aparte porque hay DOS dueños posibles del PTY: la app (modo clasico) y
/// el daemon `sfterm-ptyd` (que sobrevive a los rebuilds). Duplicar esto seria
/// la peor deuda posible: el scrub de CLAUDE_* de abajo es la diferencia entre
/// que claude persista su sesion o escriba transcripts fantasma, y un solo lado
/// arreglado se ve idéntico a los dos arreglados hasta que no lo es.
/// Devuelve `(comando, cwd ya resuelto)`.
pub fn build_shell_command(
    cwd: Option<String>,
    shell_integration: Option<bool>,
    colorfgbg: Option<String>,
    term_id: u32,
) -> (CommandBuilder, String) {
    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    // login + interactive: lee .zprofile y .zshrc del usuario
    #[cfg(target_os = "macos")]
    cmd.args(["-l", "-i"]);
    #[cfg(target_os = "windows")]
    if shell.to_ascii_lowercase().contains("powershell")
        || shell.to_ascii_lowercase().contains("pwsh")
    {
        cmd.arg("-NoLogo");
        if shell_integration.unwrap_or(true) {
            let profile = crate::engine::shell_dir().join("sfterm-profile.ps1");
            if profile.is_file() {
                cmd.args(["-NoExit", "-ExecutionPolicy", "Bypass", "-File"]);
                cmd.arg(profile);
            }
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "SFTerm");
    // QUIEN ES ESTA TERMINAL. El agente que corre adentro puede leerlo y
    // estamparlo en sus comandos del gate, y asi la app sabe QUIEN pregunta
    // en vez de adivinar. Sin esto, cualquier recurso por-conversacion (el
    // navegador propio de cada agente) tendria que resolverse por "el primero
    // que aparezca en el arbol", que es exactamente lo que hoy hace que cinco
    // agentes compartan una sola ventana a la web.
    //
    // ⚠️ El id se asigna ANTES del spawn a proposito (los dos caminos, app y
    // ptyd, lo movieron arriba): construir el entorno con un id que todavia no
    // existe fue la unica arruga real de todo esto.
    cmd.env("SFTERM_TERM_ID", term_id.to_string());
    // SCRUB de env de sesion claude ANIDADA (17 jul): si la app fue lanzada
    // desde un Claude Code (open dentro de una sesion), los hijos heredan
    // CLAUDECODE=1 y el claude TUI se cree anidado → NO persiste su sesion
    // en ~/.claude/projects (bug real: transcripts fantasma). Un terminal
    // SIEMPRE da shells limpias, venga de donde venga el launch.
    // CLAUDE_CONFIG_DIR/CLAUDE_PID (bug real 17 jul noche): relanzar la app
    // desde un Levy bajo la cuenta bro (~/.claude-bro) redirigia el HOME de
    // claude entero — el hijo escribia su sesion en OTRO projects/ y el chat
    // jamas la encontraba ("hola" respondido pero invisible).
    for (key, _) in std::env::vars() {
        let normalized = key.to_ascii_uppercase();
        if normalized == "CLAUDECODE"
            || normalized == "CLAUDE_EFFORT"
            || normalized == "CLAUDE_CONFIG_DIR"
            || normalized == "CLAUDE_PID"
            || normalized.starts_with("CLAUDE_CODE_")
        {
            cmd.env_remove(&key);
        }
    }
    // COLORFGBG por luminancia del tema activo: refuerzo de la deteccion
    // light/dark. La via canonica es OSC 11 (el engine responde con el bg del
    // tema), pero los TUIs que leen esta env en vez de consultar OSC (vim,
    // less, algunos detectores) tambien aciertan claro/oscuro. "<fg>;<bg>" con
    // codigos ANSI: 0=negro, 15=blanco. Tema claro -> "0;15"; oscuro -> "15;0".
    if let Some(v) = colorfgbg {
        cmd.env("COLORFGBG", v);
    }
    // shell integration macOS (OSC 133/633/7): ZDOTDIR inyectado, estilo VSCode.
    // En Windows se inyecta arriba como -File, sin modificar $PROFILE.
    if shell_integration.unwrap_or(true) && shell.ends_with("zsh") {
        let inject = crate::engine::shell_dir();
        if inject.join(".zshrc").exists() {
            let user_zdot = std::env::var("ZDOTDIR").unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            });
            cmd.env("SFTERM_INJECT_DIR", inject.to_string_lossy().to_string());
            cmd.env("SFTERM_USER_ZDOTDIR", user_zdot);
            cmd.env("ZDOTDIR", inject.to_string_lossy().to_string());
        }
    }
    let cwd_final = expand_tilde(&cwd.unwrap_or_else(|| {
        dirs::home_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    }));
    if std::path::Path::new(&cwd_final).is_dir() {
        cmd.cwd(&cwd_final);
    }
    (cmd, cwd_final)
}

fn default_shell() -> String {
    if let Ok(shell) = std::env::var("SFTERM_SHELL") {
        if !shell.trim().is_empty() {
            return shell;
        }
    }

    #[cfg(target_os = "macos")]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())
    }

    #[cfg(target_os = "windows")]
    {
        for candidate in ["pwsh.exe", "powershell.exe"] {
            if executable_on_path(candidate) {
                return candidate.into();
            }
        }
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
    }
}

#[cfg(target_os = "windows")]
fn executable_on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Stable Tauri IPC command signature.
pub fn pty_spawn(
    state: State<'_, PtyState>,
    engine_state: State<'_, crate::engine::EngineState>,
    cwd: Option<String>,
    command: Option<String>,
    cols: u16,
    rows: u16,
    scrollback: Option<usize>,
    shell_integration: Option<bool>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    // COLORFGBG por luminancia del tema activo (ver build_shell_command).
    let colorfgbg = engine_state.theme.lock().unwrap().clone().map(|theme| {
        let (r, g, b) = theme.bg;
        let lum = 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32;
        (if lum > 127.0 { "0;15" } else { "15;0" }).to_string()
    });

    // CAMINO DAEMON (la inmortalidad): el PTY nace en sfterm-ptyd y sobrevive
    // a esta app. El engine y el canal del frontend se arman igual que en el
    // camino local — los bytes llegan por el drenador del puente. El comando
    // inicial lo inyecta la APP (espera del prompt real abajo), no el daemon.
    if crate::ptyd_bridge::daemon_on() {
        let sb = scrollback.unwrap_or(8000);
        let (id, _pid, writer) = crate::ptyd_bridge::spawn(
            &engine_state,
            cwd,
            cols,
            rows,
            sb,
            shell_integration,
            colorfgbg,
            on_data,
        )?;
        let cwd_final = {
            let sessions = crate::ptyd_bridge::list().unwrap_or_default();
            sessions
                .into_iter()
                .find(|t| t.id == id)
                .map(|t| t.cwd)
                .unwrap_or_default()
        };
        inject_initial_command(&engine_state, id, &writer, command);
        state.sessions.lock().unwrap().insert(
            id,
            PtySession {
                writer,
                backend: PtyBackend::Daemon,
                shell_pid: _pid,
                exited: false,
            },
        );
        crate::events::emit(
            "term_spawned",
            serde_json::json!({ "term": id, "cwd": cwd_final }),
        );
        return Ok(id);
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // el id se reserva ANTES del spawn: el hijo tiene que nacer sabiendo QUIEN
    // es (SFTERM_TERM_ID), y eso se decide al construir su entorno
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    let (cmd, cwd_final) = build_shell_command(cwd, shell_integration, colorfgbg, id);

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let shell_pid = child.process_id().unwrap_or(0);
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer: SharedWriter = Arc::new(Mutex::new(
        pair.master.take_writer().map_err(|e| e.to_string())?,
    ));
    #[cfg(target_os = "macos")]
    let raw_fd = pair.master.as_raw_fd();
    #[cfg(target_os = "windows")]
    let raw_fd = None;

    // Engine: el parser VT vive en Rust y parsea SIEMPRE (tee), con cualquier
    // renderer. Da titulos/bloques/cwd/gate semantico + frames al renderer propio.
    crate::engine::create(
        &engine_state,
        id,
        cols as usize,
        rows as usize,
        scrollback.unwrap_or(8000),
    );
    let engine_session = crate::engine::get(&engine_state, id);
    // clon para el hilo del comando inicial (el reader se lleva el original)
    let engine_for_cmd = engine_session.clone();
    let engine_writer = writer.clone();

    // Reader thread: PTY -> engine (parse + respuestas) -> UI (canal binario)
    std::thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Some(session) = &engine_session {
                        let responses = crate::engine::feed(session, &buf[..n]);
                        crate::engine::write_responses(&engine_writer, responses);
                    }
                    let _ = on_data.send(InvokeResponseBody::Raw(buf[..n].to_vec()));
                }
            }
        }
    });

    // Comando inicial: helper compartido con el camino daemon (misma espera
    // del prompt real, mismo writer).
    let _ = engine_for_cmd; // el helper re-consulta el engine por id
    inject_initial_command(&engine_state, id, &writer, command);

    state.sessions.lock().unwrap().insert(
        id,
        PtySession {
            writer,
            backend: PtyBackend::Local {
                master: pair.master,
                child,
                raw_fd,
            },
            shell_pid,
            exited: false,
        },
    );
    crate::events::emit(
        "term_spawned",
        serde_json::json!({ "term": id, "cwd": cwd_final }),
    );
    Ok(id)
}

/// Teclea el comando inicial (preset / nueva conversacion) sobre el shell,
/// asi cuando el comando termina queda el shell vivo debajo.
/// ESPERAR el primer prompt REAL (OSC 133;A de la integracion de shell) antes de
/// teclear: el sleep fijo de 300ms perdia la carrera contra zshrc pesados
/// (p10k) y el init se tragaba el comando — cuerpos que quedaban en zsh
/// pelado, conversaciones mudas (bug real 18 jul). Fallback 6s si el shell
/// no emite OSC (integration off / shell no soportado). Funciona identico con PTY local o
/// del daemon: el engine (tee) y el writer son los mismos en ambos caminos.
fn inject_initial_command(
    engine_state: &crate::engine::EngineState,
    id: u32,
    writer: &SharedWriter,
    command: Option<String>,
) {
    let Some(cmdline) = command else { return };
    if cmdline.trim().is_empty() {
        return;
    }
    let w = writer.clone();
    let eng = crate::engine::get(engine_state, id);
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(6000);
        let mut prompt_listo = false;
        while std::time::Instant::now() < deadline {
            if let Some(s) = &eng {
                if let Ok(s) = s.lock() {
                    if s.term.blocks.ever_prompt {
                        prompt_listo = true;
                    }
                }
            }
            if prompt_listo {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        // margen: el prompt ya pinto pero el shell sigue armando bindings
        std::thread::sleep(std::time::Duration::from_millis(if prompt_listo {
            150
        } else {
            300
        }));
        if let Ok(mut w) = w.lock() {
            let _ = w.write_all(format!(" {}\r", cmdline.trim()).as_bytes());
            let _ = w.flush();
        }
    });
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let writer = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&id).ok_or("no such pty")?.writer.clone()
    };
    let mut w = writer.lock().map_err(|_| "writer poisoned")?;
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// Interrumpe el workload conservando el shell. La vía normal escribe ETX y
/// deja que ConPTY/Unix PTY entregue Ctrl+C. La vía `force` implementa
/// Ctrl+Break en Windows terminando solo el árbol foreground; si todavía no
/// hay workload se degrada al ETX normal y nunca mata el shell por accidente.
#[tauri::command]
pub fn pty_interrupt(state: State<'_, PtyState>, id: u32, force: bool) -> Result<(), String> {
    let (writer, shell_pid, local) = {
        let sessions = state.sessions.lock().unwrap();
        let session = sessions.get(&id).ok_or("no such pty")?;
        (
            session.writer.clone(),
            session.shell_pid,
            matches!(&session.backend, PtyBackend::Local { .. }),
        )
    };

    #[cfg(target_os = "windows")]
    if force && local {
        let foreground = local_foreground_process(None, shell_pid);
        if foreground > 0 && foreground as u32 != shell_pid {
            return if windows_taskkill_tree(foreground as u32) {
                Ok(())
            } else {
                Err(format!(
                    "no se pudo interrumpir el árbol foreground {foreground}"
                ))
            };
        }
    }

    let _ = (force, local, shell_pid);
    let mut writer = writer.lock().map_err(|_| "writer poisoned")?;
    writer.write_all(&[0x03]).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    engine_state: State<'_, crate::engine::EngineState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    crate::engine::resize(&engine_state, id, cols as usize, rows as usize);
    let sessions = state.sessions.lock().unwrap();
    let s = sessions.get(&id).ok_or("no such pty")?;
    match &s.backend {
        PtyBackend::Local { master, .. } => master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string()),
        PtyBackend::Daemon => {
            drop(sessions);
            crate::ptyd_bridge::resize(id, cols, rows)
        }
    }
}

#[tauri::command]
pub fn pty_kill(
    state: State<'_, PtyState>,
    engine_state: State<'_, crate::engine::EngineState>,
    id: u32,
) -> Result<(), String> {
    crate::engine::remove(&engine_state, id);
    let session = state.sessions.lock().unwrap().remove(&id);
    if let Some(mut s) = session {
        let shell_pid = s.shell_pid;
        match &mut s.backend {
            PtyBackend::Local { child, .. } => {
                terminate_local_tree(shell_pid, child);
            }
            PtyBackend::Daemon => crate::ptyd_bridge::kill(id),
        }
        crate::events::emit("term_closed", serde_json::json!({ "term": id }));
    }
    Ok(())
}

/// Mata TODAS las sesiones LOCALES. La UI lo llama al boot en modo clasico:
/// una pagina fresca no debe heredar PTYs huerfanos de un reload anterior.
/// Las del DAEMON no se matan jamas por esta via — sobrevivir al reload es su
/// razon de existir; aqui solo se sueltan (el boot las re-adopta).
#[tauri::command]
pub fn pty_kill_all(
    state: State<'_, PtyState>,
    engine_state: State<'_, crate::engine::EngineState>,
) -> Result<(), String> {
    crate::engine::remove_all(&engine_state);
    let mut sessions: Vec<PtySession> = {
        let mut guard = state.sessions.lock().unwrap();
        guard.drain().map(|(_, session)| session).collect()
    };
    for s in sessions.iter_mut() {
        let shell_pid = s.shell_pid;
        if let PtyBackend::Local { child, .. } = &mut s.backend {
            terminate_local_tree(shell_pid, child);
        }
    }
    Ok(())
}

/// ¿Hay daemon y que terminales viven en el? El boot del frontend decide con
/// esto: sin daemon → mundo clasico (pty_kill_all + spawns frescos); con
/// daemon → reconciliacion (adoptar las vivas, spawnear solo lo que falte).
#[tauri::command]
pub fn pty_daemon_info() -> crate::ptyd_bridge::DaemonInfo {
    crate::ptyd_bridge::daemon_info()
}

/// DESPRENDE todo sin matar nada (el boot en modo daemon). El caso que lo
/// exige es el RELOAD del webview (⌘R): el PROCESO de la app sigue vivo con
/// sus sesiones/sinks/engines de la pagina anterior — pero los Channels de esa
/// pagina estan muertos. Sin esta limpieza, pty_adopt dice "ya esta adoptada",
/// el boot cae al spawn fresco y las conversaciones del daemon quedan
/// huerfanas e invisibles (cazado E2E en el banco, 30 jul). Las LOCALES si se
/// matan: son hijas de la pagina muerta, exactamente el caso de pty_kill_all.
#[tauri::command]
pub fn pty_detach_all(
    state: State<'_, PtyState>,
    engine_state: State<'_, crate::engine::EngineState>,
) -> Result<(), String> {
    let sessions: Vec<(u32, PtySession)> = state.sessions.lock().unwrap().drain().collect();
    for (id, s) in sessions {
        let shell_pid = s.shell_pid;
        match s.backend {
            PtyBackend::Daemon => crate::ptyd_bridge::detach(id),
            PtyBackend::Local { mut child, .. } => {
                terminate_local_tree(shell_pid, &mut child);
            }
        }
        crate::engine::remove(&engine_state, id);
    }
    Ok(())
}

fn terminate_local_tree(_shell_pid: u32, child: &mut Box<dyn Child + Send + Sync>) {
    #[cfg(target_os = "windows")]
    if windows_taskkill_tree(_shell_pid) {
        return;
    }

    let _ = child.kill();
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_taskkill_tree(pid: u32) -> bool {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    let pid_arg = pid.to_string();
    Command::new("taskkill.exe")
        .args(["/PID", pid_arg.as_str(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// Re-engancha una terminal VIVA del daemon como sesion de esta app: mismo
/// contrato de canal binario que pty_spawn, pero el proceso ya existia — el
/// replay del ring repinta la pantalla donde estaba. Devuelve el tamaño real
/// del PTY para que el frontend pinte el replay sin destrozarlo y LUEGO
/// re-dimensione a su layout (SIGWINCH normal).
#[tauri::command]
pub fn pty_adopt(
    state: State<'_, PtyState>,
    engine_state: State<'_, crate::engine::EngineState>,
    id: u32,
    scrollback: Option<usize>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<crate::ptyd_bridge::AdoptInfo, String> {
    if state.sessions.lock().unwrap().contains_key(&id) {
        return Err(format!("la terminal {id} ya esta adoptada"));
    }
    let info = crate::ptyd_bridge::adopt(&engine_state, id, scrollback.unwrap_or(8000), on_data)?;
    let writer = crate::ptyd_bridge::writer_of(id).ok_or("adopt sin writer (bug)")?;
    state.sessions.lock().unwrap().insert(
        id,
        PtySession {
            writer,
            backend: PtyBackend::Daemon,
            shell_pid: info.pid,
            exited: false,
        },
    );
    Ok(info)
}

/// La sesion de Claude Code que corre DE VERDAD dentro de un PTY (la verdad
/// del piso, no la rifa por carpeta): fg via tcgetpgrp → proceso claude → su
/// cwd → el jsonl de ~/.claude/projects/<slug>/ cuyo NACIMIENTO calza con el
/// arranque del proceso (birthtime, no mtime: el mtime de una sesion AJENA
/// viva siempre es "ahora"). Con esto dos claudes concurrentes en el mismo
/// cwd dejan de robarse las filas/espejos (bug UX 20 jul). None = sin claude
/// vivo en el PTY o sin match determinista (el frontend decide su fallback).
/// La verdad completa de la sesion: el sid + la RUTA real del jsonl (respeta
/// el CLAUDE_CONFIG_DIR del proceso — bro-claude vive en ~/.claude-bro y el
/// frontend NO debe reconstruir la ruta con ~/.claude hardcodeado, bug 21 jul)
/// + el config dir para revivir con la cuenta correcta (--resume de bro).
#[derive(serde::Serialize, Clone)]
pub struct TermSessionInfo {
    pub sid: String,
    pub path: String,
    /// Some solo cuando el proceso corre bajo CLAUDE_CONFIG_DIR no-default
    pub config_dir: Option<String>,
    /// COMO lo supo: "argv" (--resume) · "titulo" (OSC == aiTitle) ·
    /// "nacimiento" (ventana, heuristica). El sensor dice su propia fuerza:
    /// sin esto, un match debil se ve identico a una verdad dura y el dia que
    /// miente no hay por donde empezar (leccion "organo sin sensor").
    pub how: &'static str,
}

#[tauri::command]
pub fn term_session(
    state: State<'_, PtyState>,
    engine_state: State<'_, crate::engine::EngineState>,
    id: u32,
) -> Result<Option<TermSessionInfo>, String> {
    let fg = {
        let sessions = state.sessions.lock().unwrap();
        let s = sessions.get(&id).ok_or("no such pty")?;
        match &s.backend {
            PtyBackend::Local { raw_fd, .. } => local_foreground_process(*raw_fd, s.shell_pid),
            // el fd del master vive en el daemon: se le pregunta a el
            PtyBackend::Daemon => crate::ptyd_bridge::fg_pgid(id),
        }
    };
    if fg <= 0 {
        return Ok(None);
    }
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(fg as u32)]),
        true,
        sysinfo::ProcessRefreshKind::everything(),
    );
    let proc = match sys.process(sysinfo::Pid::from_u32(fg as u32)) {
        Some(p) => p,
        None => return Ok(None),
    };
    if crate::metrics::resolve_fg_name(proc) != "claude" {
        return Ok(None);
    }
    let cwd = match proc.cwd() {
        Some(c) => c.to_string_lossy().to_string(),
        None => return Ok(None),
    };
    if cwd.is_empty() {
        return Ok(None);
    }
    let start = proc.start_time(); // epoch secs
    let slug: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    // el claude puede correr bajo OTRO config dir (bro: CLAUDE_CONFIG_DIR=
    // ~/.claude-bro) — su jsonl vive ahi, no en ~/.claude (leccion "hola
    // invisible" 17 jul: adivinar el root cruza sesiones de cuentas)
    let cfg_env =
        process_env_value(proc.environ(), "CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from);
    let claude_root = cfg_env
        .clone()
        .or_else(|| dirs::home_dir().map(|h| h.join(".claude")));
    let dir = match claude_root {
        Some(r) => r.join("projects").join(slug),
        None => return Ok(None),
    };
    // ORDEN DE VERDADES (reordenado 27 jul 2026 — bug "las conversaciones
    // viejas abren en blanco"). Antes mandaba la VENTANA DE NACIMIENTO y las
    // dos verdades duras eran su fallback: al revés. La ventana es PROXIMIDAD
    // ("nació cerca de cuando arrancó este claude"), y en este piso nacen
    // sesiones de maquinaria cada dos minutos en el mismo slug — el 27 jul
    // TRES paneles resolvieron al MISMO jsonl basura (9 líneas: bridge-session
    // + hooks, cero mensajes) y el lector dijo "esta sesión aún no tiene
    // mensajes legibles" sobre conversaciones enteras. Peor: el caso que rompe
    // — la conversación RESUMIDA — es justo donde la ventana NUNCA puede
    // acertar (su jsonl nació horas antes) y donde el título SIEMPRE acierta.
    //
    //   1. argv `--resume <uuid>`  → verdad dura (lo dice la línea de comando)
    //   2. título OSC == aiTitle   → verdad dura (igualdad exacta de string)
    //   3. ventana de nacimiento   → heurística, ÚLTIMO recurso
    //
    // Y todo candidato pasa por el mismo filtro: ni maquinaria ni cascarón
    // (sesión sin un solo mensaje real). Sin conversación adentro no es la
    // conversación de nadie.
    let mut best: Option<(String, &'static str)> = None;

    // ── 1. VERDAD POR ARGV (20 jul): un claude RESUMIDO puede NO bifurcar —
    // sigue escribiendo el MISMO jsonl, nacido horas antes, y la ventana de
    // nacimiento jamas lo encuentra. El sid viaja en su linea de comando
    // (--resume <uuid>): esa es verdad dura, no adivinanza. Solo si el archivo
    // EXISTE en el dir.
    let cmd = proc.cmd();
    for (i, a) in cmd.iter().enumerate() {
        if a.to_string_lossy() == "--resume" {
            if let Some(next) = cmd.get(i + 1) {
                let v = next.to_string_lossy().to_string();
                let uuidish = v.len() == 36 && v.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
                if uuidish && dir.join(format!("{v}.jsonl")).is_file() {
                    best = Some((v, "argv"));
                    break;
                }
            }
        }
    }
    // …salvo que BIFURQUE. Un --resume puede abrir un jsonl NUEVO en vez de
    // seguir el viejo, y entonces argv apunta a un archivo que ya nadie
    // escribe. Un jsonl valido nacido en la ventana de arranque de ESTE
    // proceso es justo esa bifurcacion: gana sobre argv (el orden original de
    // 2026-07-20, que aqui se conserva solo para este caso).
    if let Some((sid, "argv")) = best.as_ref().map(|(s, h)| (s.clone(), *h)) {
        if let Some(fork) = birth_candidate(&dir, start) {
            if fork != sid {
                best = Some((fork, "nacimiento"));
            }
        }
    }

    // ── 2. VERDAD POR TITULO (21 jul): un claude resumido desde el PICKER del
    // TUI (o --continue) no trae --resume en argv Y su jsonl nacio dias atras.
    // Pero el titulo OSC que el CLI emite ("<glifo> <resumen>") es el MISMO
    // aiTitle que escribe en su jsonl: igualdad exacta = verdad dura, no rifa
    // por carpeta. El engine (tee) ya guarda el titulo por pty.
    if best.is_none() {
        let title = crate::engine::get(&engine_state, id)
            .map(|s| s.lock().unwrap().term.title.clone())
            .unwrap_or_default();
        let wanted = strip_status_glyph(title.trim());
        // solo titulos con sustancia: un match trivial ("claude", "Claude
        // Code", el nombre de la carpeta) no es verdad — es el titulo por
        // defecto de CUALQUIER claude recien abierto, y con el una terminal
        // nueva se colgaria de la sesion vieja de otra. Esas caen al 3.
        if !is_generic_title(wanted, &cwd) {
            let mut cands: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
                        if let Some(mt) = e.metadata().ok().and_then(|m| m.modified().ok()) {
                            cands.push((mt, p));
                        }
                    }
                }
            }
            // mas recientes primero: la sesion resumida se escribe al retomar.
            // 40 y no 12: en este piso nacen sesiones de maquinaria todo el dia
            // y con 12 la conversacion vieja se caia de la lista antes de que
            // la miraramos. El tail de 64KB por candidato es barato (cache).
            cands.sort_by_key(|item| std::cmp::Reverse(item.0));
            for (_, p) in cands.into_iter().take(40) {
                if last_ai_title(&p).as_deref().map(str::trim) != Some(wanted) {
                    continue;
                }
                if is_machinery_session(&p) || !has_real_messages(&p) {
                    continue;
                }
                if let Some(stem) = p.file_stem() {
                    best = Some((stem.to_string_lossy().to_string(), "titulo"));
                    break;
                }
            }
        }
    }

    // ── 3. VENTANA DE NACIMIENTO (heuristica, ultimo recurso). Sin match →
    // None (honesto): el lector dice "conversacion nueva" y su watcher vuelve
    // a preguntar hasta que la sesion nazca.
    if best.is_none() {
        if let Some(sid) = birth_candidate(&dir, start) {
            best = Some((sid, "nacimiento"));
        }
    }

    Ok(best.map(|(sid, how)| TermSessionInfo {
        path: dir
            .join(format!("{sid}.jsonl"))
            .to_string_lossy()
            .to_string(),
        config_dir: cfg_env.map(|p| p.to_string_lossy().to_string()),
        sid,
        how,
    }))
}

fn process_env_value(environment: &[std::ffi::OsString], wanted: &str) -> Option<String> {
    environment.iter().find_map(|entry| {
        let text = entry.to_string_lossy();
        let (name, value) = text.split_once('=')?;
        name.eq_ignore_ascii_case(wanted).then(|| value.to_string())
    })
}

/// El jsonl NACIDO en la ventana de arranque de este claude ([start-5s,
/// start+120s]); de varios, el de nacimiento mas cercano. Ventana CORTA a
/// proposito: con 300s dos claudes arrancados con minutos de diferencia en el
/// mismo cwd se robaban el archivo (verificacion adversarial 20 jul).
///
/// Es PROXIMIDAD, no verdad: por eso hoy corre de ultimo (y solo se adelanta
/// para cazar la bifurcacion de un --resume). Los filtros caros van al final,
/// sobre el que va ganando — un cascaron sin mensajes no es candidato de nada.
fn birth_candidate(dir: &std::path::Path, start: u64) -> Option<String> {
    let mut closest: Option<(u64, String)> = None;
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if !p.extension().map(|x| x == "jsonl").unwrap_or(false) {
            continue;
        }
        let birth = e
            .metadata()
            .ok()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let (Some(b), Some(stem)) = (birth, p.file_stem()) else {
            continue;
        };
        if b + 5 < start || b > start + 120 {
            continue;
        }
        let dist = b.abs_diff(start);
        if closest.as_ref().map(|(d, _)| dist >= *d).unwrap_or(false) {
            continue;
        }
        if is_machinery_session(&p) || !has_real_messages(&p) {
            continue;
        }
        closest = Some((dist, stem.to_string_lossy().to_string()));
    }
    closest.map(|(_, sid)| sid)
}

/// El CLI de claude emite el titulo OSC como "<glifo de estado> <resumen>"
/// (✳/⠂/✻…). Si el primer token no trae alfanumericos ASCII, el titulo real
/// es lo que sigue; si no hay glifo, el titulo va entero.
fn strip_status_glyph(t: &str) -> &str {
    match t.split_once(' ') {
        Some((first, rest)) if !first.chars().any(|c| c.is_ascii_alphanumeric()) => rest.trim(),
        _ => t,
    }
}

/// Ultimo aiTitle del transcript (cola de 64KB): el CLI re-emite el titulo
/// cuando la conversacion cambia de tema; el ULTIMO es el vigente.
pub(crate) fn last_ai_title(p: &std::path::Path) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(p).ok()?;
    let len = f.metadata().ok()?.len();
    let take = len.min(65536);
    f.seek(SeekFrom::End(-(take as i64))).ok()?;
    let mut buf = Vec::with_capacity(take as usize);
    f.read_to_end(&mut buf).ok()?;
    let s = String::from_utf8_lossy(&buf);
    for line in s.lines().rev() {
        if !line.contains("\"type\":\"ai-title\"") {
            continue;
        }
        // una linea partida por el corte de 64KB no parsea: seguir buscando
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(t) = v.get("aiTitle").and_then(|x| x.as_str()) {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// Sesiones de MAQUINARIA nacen en el mismo slug todo el dia (crons 🤖 del
/// daemon, nervio aferente, auto-resumen de Claude Code): si una nace en la
/// ventana del arranque, robaba el match y el rail/espejo aterrizaban en OTRA
/// conversacion (bug "la pantalla se cambia sola", 20 jul). Marcadores
/// ANCLADOS al inicio del valor JSON del primer prompt — una conversacion
/// real que solo MENCIONA al nervio no matchea. Espejo del set en
/// (Desde la purga del 21 jul este es el UNICO set de marcadores: el espejo
/// MACHINERY_MARKS de transcript.ts murio con el chat nativo.)
///
/// `entrypoint:"sdk-cli"` (27 jul) es el sello del SDK: TODO lo que no es la
/// TUI — crons del agent-server, subagentes, el auto-resumen — nace con el.
/// Las sesiones de una terminal de verdad son `entrypoint:"cli"`.
pub(crate) fn is_machinery_session(p: &std::path::Path) -> bool {
    use std::io::Read;
    const MARKS: [&str; 8] = [
        "\"text\":\"🤖 [",
        "\"content\":\"🤖 [",
        "\"text\":\"\\ud83e\\udd16 [",
        "\"text\":\"[nervio-",
        "\"content\":\"[nervio-",
        "\"text\":\"Review this conversation excerpt",
        "\"content\":\"Review this conversation excerpt",
        // TODO sello sdk-*: "sdk-cli" (subagentes/auto-resumen), "sdk-ts"
        // (crons del agent-server via Agent SDK — el knowledge compiler se
        // colaba al historial, cazado 30 jul con el indexador contra disco
        // real). La TUI de verdad sella "cli" y jamas matchea este prefijo.
        "\"entrypoint\":\"sdk-",
    ];
    // 64KB y no 16: el `entrypoint` viaja en la primera linea de MENSAJE, y
    // antes de ella van los adjuntos de los hooks de arranque (gordos).
    if let Ok(mut f) = std::fs::File::open(p) {
        let mut buf = Vec::with_capacity(65536);
        if std::io::Read::by_ref(&mut f)
            .take(65536)
            .read_to_end(&mut buf)
            .is_ok()
        {
            let head = String::from_utf8_lossy(&buf);
            return MARKS.iter().any(|m| head.contains(m));
        }
    }
    false
}

/// ¿El jsonl tiene siquiera UN mensaje real (user/assistant)?
///
/// El 27 jul tres paneles resolvieron al mismo CASCARON: un jsonl de 9 lineas
/// con `last-prompt`, `mode`, `permission-mode`, `bridge-session` y adjuntos de
/// hooks — cero conversacion. El lector lo espejo fielmente y dijo "esta sesion
/// aun no tiene mensajes legibles" sobre conversaciones enteras de Daniel.
/// Un archivo sin un solo mensaje no es la conversacion de NADIE: descartarlo
/// y decir None es mas honesto que apuntar a el.
///
/// Barrido acotado: 1MB de cabeza (el primer prompt siempre cae muy antes) y,
/// por si acaso, 256KB de cola. Una sesion recien nacida sin mensajes todavia
/// da `false` a proposito — el lector la pinta como "conversacion nueva" y su
/// watcher vuelve a preguntar cuando nazca de verdad.
pub(crate) fn has_real_messages(p: &std::path::Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    const MARKS: [&str; 2] = ["\"type\":\"user\"", "\"type\":\"assistant\""];
    let mut f = match std::fs::File::open(p) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut head = Vec::with_capacity(1 << 20);
    if Read::by_ref(&mut f)
        .take(1 << 20)
        .read_to_end(&mut head)
        .is_err()
    {
        return false;
    }
    let h = String::from_utf8_lossy(&head);
    if MARKS.iter().any(|m| h.contains(m)) {
        return true;
    }
    let len = match f.metadata() {
        Ok(m) => m.len(),
        Err(_) => return false,
    };
    if len <= (1 << 20) {
        return false; // ya lo leimos entero
    }
    let take = len.min(262_144);
    if f.seek(SeekFrom::End(-(take as i64))).is_err() {
        return false;
    }
    let mut tail = Vec::with_capacity(take as usize);
    if f.read_to_end(&mut tail).is_err() {
        return false;
    }
    let t = String::from_utf8_lossy(&tail);
    MARKS.iter().any(|m| t.contains(m))
}

/// Titulos que NO identifican a nadie: el que trae cualquier claude recien
/// abierto ("Claude Code"), el nombre del proceso, o el de la carpeta. Con uno
/// de estos, la igualdad titulo==aiTitle deja de ser verdad dura y se vuelve
/// una rifa entre todas las conversaciones del slug (una terminal nueva
/// colgandose de la sesion vieja de otra).
fn is_generic_title(t: &str, cwd: &str) -> bool {
    let t = t.trim();
    if t.chars().count() < 8 {
        return true;
    }
    let low = t.to_lowercase();
    const GENERIC: [&str; 6] = [
        "claude code",
        "claude ~",
        "conversación nueva",
        "conversacion nueva",
        "nueva conversación",
        "nueva conversacion",
    ];
    if GENERIC.contains(&low.as_str()) {
        return true;
    }
    let base = std::path::Path::new(cwd)
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    !base.is_empty() && low == base
}

/// (pty_id, shell_pid, fg_pgid) por sesion — para titulos, CPU por panel y
/// atencion. Las locales responden con su fd; las del daemon en UN viaje
/// batcheado (FgPgids) — el loop de metrics pregunta cada 1.5s y castigar al
/// daemon con un roundtrip por terminal seria gratuito.
type ForegroundPgid = (u32, u32, i32);
type DaemonPgid = (u32, u32);
type LocalPgid = (u32, u32, Option<i32>);

pub fn foreground_pgids(state: &PtyState) -> Vec<ForegroundPgid> {
    let (mut out, daemon_ids, local_ids): (Vec<ForegroundPgid>, Vec<DaemonPgid>, Vec<LocalPgid>) = {
        let sessions = state.sessions.lock().unwrap();
        let mut ready = Vec::new();
        #[cfg(target_os = "windows")]
        let mut locals = Vec::new();
        #[cfg(target_os = "macos")]
        let locals = Vec::new();
        let mut daemons = Vec::new();
        for (id, s) in sessions.iter() {
            match &s.backend {
                PtyBackend::Local { raw_fd, .. } => {
                    #[cfg(target_os = "macos")]
                    ready.push((
                        *id,
                        s.shell_pid,
                        local_foreground_process(*raw_fd, s.shell_pid),
                    ));
                    #[cfg(target_os = "windows")]
                    locals.push((*id, s.shell_pid, *raw_fd));
                }
                PtyBackend::Daemon => daemons.push((*id, s.shell_pid)),
            }
        }
        (ready, daemons, locals)
    };
    #[cfg(target_os = "windows")]
    {
        let shell_pids: Vec<u32> = local_ids
            .iter()
            .map(|(_, shell_pid, _)| *shell_pid)
            .collect();
        let foreground = windows_foreground_processes(&shell_pids);
        out.extend(local_ids.into_iter().map(|(id, shell_pid, _)| {
            (
                id,
                shell_pid,
                foreground
                    .get(&shell_pid)
                    .copied()
                    .unwrap_or(shell_pid as i32),
            )
        }));
    }
    #[cfg(target_os = "macos")]
    let _ = local_ids;
    if !daemon_ids.is_empty() {
        let ids: Vec<u32> = daemon_ids.iter().map(|(id, _)| *id).collect();
        let map = crate::ptyd_bridge::fg_pgids(&ids);
        for (id, shell_pid) in daemon_ids {
            out.push((id, shell_pid, map.get(&id).copied().unwrap_or(-1)));
        }
    }
    out
}

fn local_foreground_process(raw_fd: Option<i32>, _shell_pid: u32) -> i32 {
    #[cfg(target_os = "macos")]
    {
        raw_fd
            .map(|fd| unsafe { libc::tcgetpgrp(fd) })
            .unwrap_or(-1)
    }

    #[cfg(target_os = "windows")]
    {
        let _ = raw_fd;
        windows_foreground_processes(&[_shell_pid])
            .get(&_shell_pid)
            .copied()
            .unwrap_or(_shell_pid as i32)
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone, Debug)]
struct WindowsProcessNode {
    pid: u32,
    parent: Option<u32>,
    start_time: u64,
    name: String,
}

#[cfg(target_os = "windows")]
pub(crate) fn windows_foreground_processes(shell_pids: &[u32]) -> HashMap<u32, i32> {
    let mut sys = sysinfo::System::new_all();
    sys.refresh_all();
    let nodes: Vec<WindowsProcessNode> = sys
        .processes()
        .iter()
        .map(|(pid, process)| WindowsProcessNode {
            pid: pid.as_u32(),
            parent: process.parent().map(|parent| parent.as_u32()),
            start_time: process.start_time(),
            name: process.name().to_string_lossy().to_string(),
        })
        .collect();

    shell_pids
        .iter()
        .map(|shell_pid| {
            (
                *shell_pid,
                select_windows_foreground(*shell_pid, &nodes) as i32,
            )
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn select_windows_foreground(shell_pid: u32, nodes: &[WindowsProcessNode]) -> u32 {
    let mut current = shell_pid;
    loop {
        let Some(child) = nodes
            .iter()
            .filter(|node| node.parent == Some(current))
            .max_by_key(|node| (node.start_time, node.pid))
        else {
            return current;
        };

        current = child.pid;
        let name = child
            .name
            .strip_suffix(".exe")
            .unwrap_or(&child.name)
            .to_ascii_lowercase();
        if !matches!(name.as_str(), "cmd" | "conhost" | "openconsole") {
            return current;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_tilde_home() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand_tilde("~"), home.to_string_lossy());
        assert_eq!(
            expand_tilde("~/Developer"),
            home.join("Developer").to_string_lossy()
        );
        assert_eq!(
            expand_tilde("~\\Developer"),
            home.join("Developer").to_string_lossy()
        );
        assert_eq!(expand_tilde("ruta/sin/tilde"), "ruta/sin/tilde");
    }

    #[test]
    fn variables_de_proceso_son_case_insensitive_en_windows() {
        let environment = vec![
            std::ffi::OsString::from("Path=C:\\Windows"),
            std::ffi::OsString::from("Claude_Config_Dir=C:\\Users\\Iris\\.claude-work"),
        ];
        assert_eq!(
            process_env_value(&environment, "CLAUDE_CONFIG_DIR").as_deref(),
            Some("C:\\Users\\Iris\\.claude-work")
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn foreground_windows_colapsa_launcher_cmd_y_no_entra_en_hijos_del_agente() {
        let nodes = vec![
            WindowsProcessNode {
                pid: 20,
                parent: Some(10),
                start_time: 100,
                name: "cmd.exe".into(),
            },
            WindowsProcessNode {
                pid: 30,
                parent: Some(20),
                start_time: 101,
                name: "node.exe".into(),
            },
            WindowsProcessNode {
                pid: 40,
                parent: Some(30),
                start_time: 102,
                name: "git.exe".into(),
            },
        ];
        assert_eq!(select_windows_foreground(10, &nodes), 30);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn foreground_windows_prefiere_el_hijo_activo_mas_reciente() {
        let nodes = vec![
            WindowsProcessNode {
                pid: 20,
                parent: Some(10),
                start_time: 100,
                name: "old.exe".into(),
            },
            WindowsProcessNode {
                pid: 30,
                parent: Some(10),
                start_time: 200,
                name: "codex.exe".into(),
            },
        ];
        assert_eq!(select_windows_foreground(10, &nodes), 30);
        assert_eq!(select_windows_foreground(99, &nodes), 99);
    }

    /// El hijo tiene que PODER LEER quien es. No basta con que el codigo
    /// escriba la env: si el id llegara vacio o con otro valor, el agente
    /// estamparia mal sus comandos del gate y actuaria sobre el navegador de
    /// OTRA conversacion — un fallo silencioso y muy caro de diagnosticar.
    /// Por eso se comprueba contra un PTY REAL, no contra el CommandBuilder.
    #[cfg(target_os = "macos")]
    #[test]
    fn el_hijo_sabe_que_terminal_es() {
        let (cmd_builder, _) = build_shell_command(Some("/tmp".into()), Some(false), None, 42);
        assert_eq!(
            cmd_builder
                .get_env("SFTERM_TERM_ID")
                .and_then(|v| v.to_str()),
            Some("42"),
            "el entorno del hijo tiene que traer su propio id"
        );

        // …y de verdad sobrevive al spawn: zsh lo imprime desde adentro del PTY
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.args(["-f", "-c", "echo ID=[$SFTERM_TERM_ID]"]);
        cmd.env("SFTERM_TERM_ID", "42");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut out = String::new();
        let mut buf = [0u8; 4096];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
            if out.contains("ID=[") {
                break;
            }
        }
        let _ = child.wait();
        assert!(out.contains("ID=[42]"), "salida real del PTY: {out}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn spawn_real_pty_echo() {
        // PTY real: zsh corre, escribe, responde. El corazon del producto.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/zsh");
        cmd.args(["-f", "-c", "echo SFTERM_OK_$((40+2))"]);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut out = String::new();
        let mut buf = [0u8; 4096];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
        }
        let _ = child.wait();
        assert!(out.contains("SFTERM_OK_42"), "salida real del PTY: {out}");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn spawn_real_conpty_powershell_echo() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open ConPTY");
        let mut cmd = CommandBuilder::new("powershell.exe");
        cmd.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Write-Output SFTERM_WINDOWS_OK",
        ]);
        let mut child = pair.slave.spawn_command(cmd).expect("spawn PowerShell");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        let mut out = String::new();
        let mut buf = [0u8; 4096];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => out.push_str(&String::from_utf8_lossy(&buf[..n])),
            }
        }
        let _ = child.wait();
        assert!(
            out.contains("SFTERM_WINDOWS_OK"),
            "salida real de ConPTY: {out}"
        );
    }
}

/// Chequea salidas de shells LOCALES; emite pty://exit una sola vez por sesion.
/// Las del daemon no se sondean: su muerte llega como Evt::Exit por el puente
/// (ptyd_bridge::on_exit emite las MISMAS señales).
pub fn poll_exits(app: &AppHandle, state: &PtyState) {
    let mut sessions = state.sessions.lock().unwrap();
    for (id, s) in sessions.iter_mut() {
        if s.exited {
            continue;
        }
        if let PtyBackend::Local { child, .. } = &mut s.backend {
            if let Ok(Some(status)) = child.try_wait() {
                s.exited = true;
                crate::events::emit(
                    "shell_died",
                    serde_json::json!({ "term": *id, "code": status.exit_code() }),
                );
                let _ = app.emit(
                    "pty://exit",
                    PtyExit {
                        id: *id,
                        code: Some(status.exit_code()),
                    },
                );
            }
        }
    }
}

#[cfg(test)]
mod tests_machinery {
    #[test]
    fn maquinaria_anclada_vs_conversacion_real() {
        let d = std::env::temp_dir();
        let m = d.join("sfterm-test-machinery.jsonl");
        let r = d.join("sfterm-test-real.jsonl");
        std::fs::write(&m, r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"[nervio-sfterm] señal del piso"}]}}"#).unwrap();
        // una conversacion REAL que solo MENCIONA al nervio no es maquinaria
        std::fs::write(&r, r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"oye, hablemos del [nervio-sfterm] y de un 🤖 [job] que vi"}]}}"#).unwrap();
        assert!(super::is_machinery_session(&m));
        assert!(!super::is_machinery_session(&r));
        let _ = std::fs::remove_file(&m);
        let _ = std::fs::remove_file(&r);
    }

    #[test]
    fn glifo_de_estado_fuera() {
        // titulo OSC de claude = "<glifo> <resumen>"; sin glifo, entero
        assert_eq!(
            super::strip_status_glyph("✳ Actualizar sfterm"),
            "Actualizar sfterm"
        );
        assert_eq!(
            super::strip_status_glyph("⠂ Rebuild de la app"),
            "Rebuild de la app"
        );
        assert_eq!(
            super::strip_status_glyph("Actualizar sfterm"),
            "Actualizar sfterm"
        );
        // primer token con alfanumericos = parte del titulo, no glifo
        assert_eq!(
            super::strip_status_glyph("QA e2e del peek"),
            "QA e2e del peek"
        );
    }

    #[test]
    fn ultimo_ai_title_de_la_cola() {
        let d = std::env::temp_dir();
        let p = d.join("sfterm-test-aititle.jsonl");
        std::fs::write(
            &p,
            concat!(
                r#"{"type":"ai-title","aiTitle":"Titulo viejo","sessionId":"x"}"#, "\n",
                r#"{"type":"user","message":{"role":"user","content":"hola"}}"#, "\n",
                r#"{"type":"ai-title","aiTitle":"Actualizar cambios de sfterm y rebuild","sessionId":"x"}"#, "\n",
            ),
        )
        .unwrap();
        assert_eq!(
            super::last_ai_title(&p).as_deref(),
            Some("Actualizar cambios de sfterm y rebuild")
        );
        let sin = d.join("sfterm-test-sin-titulo.jsonl");
        std::fs::write(
            &sin,
            r#"{"type":"user","message":{"role":"user","content":"hola"}}"#,
        )
        .unwrap();
        assert_eq!(super::last_ai_title(&sin), None);
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_file(&sin);
    }

    /// El CASCARON que rompio el lector el 27 jul: jsonl real de 9 lineas con
    /// pura maquinaria de arranque (bridge-session + hooks) y CERO mensajes.
    /// Tres paneles resolvieron a el por la ventana de nacimiento.
    #[test]
    fn cascaron_sin_mensajes_no_es_conversacion() {
        let d = std::env::temp_dir();
        let cascaron = d.join("sfterm-test-cascaron.jsonl");
        std::fs::write(
            &cascaron,
            concat!(
                r#"{"type":"last-prompt","leafUuid":"a3","sessionId":"7d05"}"#, "\n",
                r#"{"type":"mode","mode":"normal","sessionId":"7d05"}"#, "\n",
                r#"{"type":"permission-mode","permissionMode":"bypassPermissions","sessionId":"7d05"}"#, "\n",
                r#"{"type":"bridge-session","sessionId":"7d05","bridgeSessionId":"cse_01","lastSequenceNum":0}"#, "\n",
                r#"{"parentUuid":null,"isSidechain":false,"attachment":{"type":"hook_success","hookName":"SessionStart:startup","content":"Repo synced"}}"#, "\n",
            ),
        )
        .unwrap();
        let real = d.join("sfterm-test-conversacion.jsonl");
        std::fs::write(
            &real,
            concat!(
                r#"{"type":"mode","mode":"normal","sessionId":"17c1"}"#, "\n",
                r#"{"type":"user","entrypoint":"cli","message":{"role":"user","content":"investigame la seccion"}}"#, "\n",
            ),
        )
        .unwrap();
        assert!(
            !super::has_real_messages(&cascaron),
            "cascaron: sin mensajes"
        );
        assert!(super::has_real_messages(&real), "conversacion real: si");
        let _ = std::fs::remove_file(&cascaron);
        let _ = std::fs::remove_file(&real);
    }

    /// El SDK (crons, subagentes, auto-resumen) sella `entrypoint:"sdk-cli"`;
    /// la TUI de una terminal real sella `"cli"`.
    #[test]
    fn sdk_cli_es_maquinaria_y_cli_no() {
        let d = std::env::temp_dir();
        let sdk = d.join("sfterm-test-sdk.jsonl");
        std::fs::write(
            &sdk,
            r#"{"type":"user","entrypoint":"sdk-cli","message":{"role":"user","content":"corre el cron"}}"#,
        )
        .unwrap();
        let tui = d.join("sfterm-test-tui.jsonl");
        std::fs::write(
            &tui,
            r#"{"type":"user","entrypoint":"cli","message":{"role":"user","content":"hola bro"}}"#,
        )
        .unwrap();
        assert!(super::is_machinery_session(&sdk));
        assert!(!super::is_machinery_session(&tui));
        let _ = std::fs::remove_file(&sdk);
        let _ = std::fs::remove_file(&tui);
    }

    /// Un titulo generico no identifica a nadie: con el, la igualdad
    /// titulo==aiTitle es una rifa, no una verdad.
    #[test]
    fn titulos_genericos_fuera() {
        assert!(super::is_generic_title(
            "Claude Code",
            "/Users/d/Developer/business-os"
        ));
        assert!(super::is_generic_title(
            "claude",
            "/Users/d/Developer/business-os"
        ));
        assert!(super::is_generic_title(
            "business-os",
            "/Users/d/Developer/business-os"
        ));
        assert!(super::is_generic_title("corto", "/tmp/x"));
        assert!(!super::is_generic_title(
            "Investigar sección de remodelación",
            "/Users/d/Developer/business-os"
        ));
    }
}
