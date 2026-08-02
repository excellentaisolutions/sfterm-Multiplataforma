use serde::Serialize;
use std::collections::{HashMap, HashSet};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone)]
pub struct PanelInfo {
    pub id: u32,
    pub shell_pid: u32,
    pub fg_pid: i32,
    pub fg_name: String,
    pub cwd: String,
    pub cpu: f32,
}

#[derive(Serialize, Clone)]
pub struct SysTick {
    /// RAM de la APP: proceso principal + helpers de WebKit (MB)
    pub app_ram_mb: f64,
    /// RAM del workload: shells + procesos corriendo dentro de los PTYs (MB)
    pub workload_ram_mb: f64,
    pub app_cpu: f32,
    pub panels: Vec<PanelInfo>,
}

/// Nombre honesto de un proceso: si es un interprete (node, python...), usar
/// el script que corre ("claude", no "node"). COMPARTIDO entre el loop de
/// metricas (fgName del frontend) y pty::term_session — deben usar el MISMO
/// criterio o un panel se veria "vivo" con /claude/i pero sin sesion-verdad.
pub fn resolve_fg_name(p: &sysinfo::Process) -> String {
    let cmd = p.cmd();
    let base = |s: &std::ffi::OsStr| {
        std::path::Path::new(s)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default()
    };
    let first = cmd
        .first()
        .map(|c| base(c))
        .unwrap_or_else(|| p.name().to_string_lossy().to_string());
    let interp = ["node", "python", "python3", "bun", "deno", "ruby"];
    if interp.contains(&first.as_str()) {
        if let Some(second) = cmd.get(1) {
            let s = base(second);
            if !s.is_empty() && !s.starts_with('-') {
                return s;
            }
        }
    }
    first
}

// ---------- propiocepcion (nervio): sensor de proceso caliente ----------

const HOT_CPU: f32 = 85.0;
const COOL_CPU: f32 = 40.0;
const HOT_SUSTAIN_S: u64 = 180;

/// Memoria del sensor: desde cuando esta caliente cada panel y a quien ya
/// se le aviso (histeresis: re-arma solo al enfriarse de verdad).
#[derive(Default)]
pub struct HotTrack {
    hot_since: HashMap<u32, std::time::Instant>,
    flagged: HashSet<u32>,
}

/// Deteccion pura y testeable: fg process con CPU > 85% sostenida >= 3 min
/// emite UNA señal; no vuelve a emitir hasta que el proceso baje de 40%.
/// Atenuador por diseño: de ~57k ticks/dia a ~0-2 señales/dia.
pub fn scan_hot(
    track: &mut HotTrack,
    samples: &[(u32, f32, String)],
    now: std::time::Instant,
    sink: &mut dyn FnMut(u32, &str, f32),
) {
    let seen: HashSet<u32> = samples.iter().map(|(id, _, _)| *id).collect();
    track.hot_since.retain(|id, _| seen.contains(id));
    track.flagged.retain(|id| seen.contains(id));
    for (id, cpu, name) in samples {
        if *cpu > HOT_CPU {
            let since = *track.hot_since.entry(*id).or_insert(now);
            if now.duration_since(since).as_secs() >= HOT_SUSTAIN_S && !track.flagged.contains(id) {
                track.flagged.insert(*id);
                sink(*id, name, *cpu);
            }
        } else {
            track.hot_since.remove(id);
            if *cpu < COOL_CPU {
                track.flagged.remove(id);
            }
        }
    }
}

/// Loop de metricas: cada 1.5s refresca sysinfo, resuelve titulos (fg process),
/// CPU por panel, RAM de la app, y chequea shells muertos. Emite sys://tick.
pub fn start_metrics_loop(app: AppHandle) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        let my_pid = std::process::id();
        let mut hot = HotTrack::default();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            let state = app.state::<crate::pty::PtyState>();

            // Salidas de shells (emite pty://exit)
            crate::pty::poll_exits(&app, &state);

            let sessions = crate::pty::foreground_pgids(&state);
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .with_cpu()
                    .with_memory()
                    .with_cwd(sysinfo::UpdateKind::Always),
            );

            // Mapa pid -> (parent, mem, cpu, name, cwd)
            let mut parent_of: HashMap<u32, u32> = HashMap::new();
            for (pid, proc_) in sys.processes() {
                if let Some(pp) = proc_.parent() {
                    parent_of.insert(pid.as_u32(), pp.as_u32());
                }
            }

            // RAM de la app = main + descendientes que NO son shells de PTY
            let shell_pids: HashSet<u32> = sessions.iter().map(|(_, sp, _)| *sp).collect();
            let is_descendant_of = |mut pid: u32, root: u32, stop_at: &HashSet<u32>| -> bool {
                let mut hops = 0;
                while let Some(&pp) = parent_of.get(&pid) {
                    if stop_at.contains(&pid) {
                        return false;
                    }
                    if pp == root {
                        return !stop_at.contains(&pid);
                    }
                    pid = pp;
                    hops += 1;
                    if hops > 32 {
                        break;
                    }
                }
                false
            };

            let mut app_ram: u64 = 0;
            let mut workload_ram: u64 = 0;
            let mut app_cpu: f32 = 0.0;
            for (pid, proc_) in sys.processes() {
                let p = pid.as_u32();
                if p == my_pid {
                    app_ram += proc_.memory();
                    app_cpu += proc_.cpu_usage();
                } else if shell_pids.contains(&p) || sessions.iter().any(|(_, sp, _)| is_descendant_of(p, *sp, &HashSet::new())) {
                    workload_ram += proc_.memory();
                } else if is_descendant_of(p, my_pid, &shell_pids) {
                    // helpers de WebKit y demas hijos de la app (sin contar shells)
                    app_ram += proc_.memory();
                    app_cpu += proc_.cpu_usage();
                }
            }

            let panels: Vec<PanelInfo> = sessions
                .iter()
                .map(|(id, shell_pid, fg)| {
                    let fg_proc = if *fg > 0 {
                        sys.process(Pid::from_u32(*fg as u32))
                    } else {
                        None
                    };
                    let shell_proc = sys.process(Pid::from_u32(*shell_pid));
                    let fg_name = fg_proc.map(resolve_fg_name).unwrap_or_default();
                    let cwd = fg_proc
                        .and_then(|p| p.cwd().map(|c| c.to_string_lossy().to_string()))
                        .or_else(|| {
                            shell_proc.and_then(|p| p.cwd().map(|c| c.to_string_lossy().to_string()))
                        })
                        .unwrap_or_default();
                    let cpu = fg_proc.map(|p| p.cpu_usage()).unwrap_or(0.0);
                    PanelInfo {
                        id: *id,
                        shell_pid: *shell_pid,
                        fg_pid: *fg,
                        fg_name,
                        cwd,
                        cpu,
                    }
                })
                .collect();

            // nervio: proceso quemando CPU sostenido → needs_attention (hot)
            {
                let samples: Vec<(u32, f32, String)> = panels
                    .iter()
                    .map(|p| (p.id, p.cpu, p.fg_name.clone()))
                    .collect();
                scan_hot(&mut hot, &samples, std::time::Instant::now(), &mut |id, name, cpu| {
                    crate::events::emit(
                        "needs_attention",
                        serde_json::json!({ "term": id, "reason": "hot", "proc": name, "cpu": cpu }),
                    );
                    // tambien al frontend: badge de atencion visible en el HOME
                    let _ = app.emit(
                        "engine://evt",
                        crate::engine::EngineEvt { id, kind: "attention".into(), data: "hot".into() },
                    );
                });
            }

            let tick = SysTick {
                app_ram_mb: app_ram as f64 / 1_048_576.0,
                workload_ram_mb: workload_ram as f64 / 1_048_576.0,
                app_cpu,
                panels,
            };
            let _ = app.emit("sys://tick", tick);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn collect(track: &mut HotTrack, samples: &[(u32, f32, &str)], now: Instant) -> Vec<u32> {
        let s: Vec<(u32, f32, String)> = samples.iter().map(|(i, c, n)| (*i, *c, n.to_string())).collect();
        let mut got = Vec::new();
        scan_hot(track, &s, now, &mut |id, _, _| got.push(id));
        got
    }

    #[test]
    fn hot_sostenido_emite_una_vez_e_histeresis() {
        let mut t = HotTrack::default();
        let t0 = Instant::now();
        // caliente pero recien: no emite
        assert!(collect(&mut t, &[(1, 95.0, "node")], t0).is_empty());
        // 3 min despues, sigue caliente: emite UNA vez
        let t1 = t0 + Duration::from_secs(HOT_SUSTAIN_S + 1);
        assert_eq!(collect(&mut t, &[(1, 97.0, "node")], t1), vec![1]);
        // sigue caliente: NO repite
        let t2 = t1 + Duration::from_secs(300);
        assert!(collect(&mut t, &[(1, 99.0, "node")], t2).is_empty());
        // baja a 60 (tibio): flag sigue puesto, no re-arma
        assert!(collect(&mut t, &[(1, 60.0, "node")], t2).is_empty());
        let t3 = t2 + Duration::from_secs(HOT_SUSTAIN_S + 1);
        collect(&mut t, &[(1, 95.0, "node")], t2);
        assert!(collect(&mut t, &[(1, 95.0, "node")], t3).is_empty(), "tibio no re-arma");
        // se enfria de verdad (<40): re-arma, y un nuevo episodio vuelve a emitir
        collect(&mut t, &[(1, 10.0, "node")], t3);
        let t4 = t3 + Duration::from_secs(10);
        collect(&mut t, &[(1, 95.0, "node")], t4);
        let t5 = t4 + Duration::from_secs(HOT_SUSTAIN_S + 1);
        assert_eq!(collect(&mut t, &[(1, 95.0, "node")], t5), vec![1]);
    }

    #[test]
    fn picos_cortos_no_molestan_y_paneles_muertos_se_podan() {
        let mut t = HotTrack::default();
        let t0 = Instant::now();
        // pico de 30s: nunca emite
        collect(&mut t, &[(2, 99.0, "cargo")], t0);
        let t1 = t0 + Duration::from_secs(30);
        assert!(collect(&mut t, &[(2, 20.0, "cargo")], t1).is_empty());
        let t2 = t1 + Duration::from_secs(HOT_SUSTAIN_S * 2);
        assert!(collect(&mut t, &[(2, 99.0, "cargo")], t2).is_empty(), "reloj reseteado");
        // panel desaparece: su memoria se poda
        collect(&mut t, &[], t2);
        assert!(t.hot_since.is_empty() && t.flagged.is_empty());
    }
}
