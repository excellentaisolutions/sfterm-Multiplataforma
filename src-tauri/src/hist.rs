//! El INDEXADOR del historial de conversaciones (la vitrina).
//!
//! La verdad vive en disco: `<root>/projects/<slug>/<sid>.jsonl` — cada claude
//! (de esta app, del CLI pelado, de otra ventana) escribe ahi y el archivo
//! sobrevive a todo. Este modulo lo indexa BARATO para que el rail pueda
//! listar el historial completo estilo Claude Desktop:
//!
//! - **stat sweep primero**: mtime/size de todos los jsonl, orden por
//!   recencia, y solo los que pueden entrar a la lista se abren.
//! - **lecturas acotadas**: cabeza (cwd + primer prompt) y cola (aiTitle) —
//!   jamas el archivo entero (hay sesiones de cientos de MB con imagenes).
//! - **cache por (mtime, size)**: el segundo index solo re-lee lo que cambio.
//!   El veredicto NEGATIVO (maquinaria/cascaron) tambien se cachea — es la
//!   mayoria del disco y re-descartarla cada vez seria pagar el filtro
//!   completo por refresco.
//! - **mismos filtros que la verdad del piso** (`pty.rs`): maquinaria de
//!   crons/sdk fuera, cascarones sin un solo mensaje real fuera. Daniel no
//!   debe ver el ruido — medido en julio: era el 63% del disco.
//!
//! Roots: `[history] claude_roots` en config.toml (default `~/.claude` +
//! `~/.claude-bro`). Un root que no existe simplemente no aporta. Para roots
//! NO-default la card viaja con su `config_dir`: el resume necesita
//! `CLAUDE_CONFIG_DIR` o la sesion reviviria en la cuenta equivocada.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Serialize, Clone, Debug)]
pub struct SessionCard {
    pub sid: String,
    pub path: String,
    /// Some SOLO para roots no-default: el resume la necesita como env.
    pub config_dir: Option<String>,
    pub cwd: String,
    /// aiTitle del tail (lo que Claude Code resume) o el primer prompt real.
    pub title: Option<String>,
    pub mtime_ms: u64,
    pub size: u64,
}

/// path → (mtime_ms, size, veredicto). None = filtrada (maquinaria/cascaron).
type Cache = HashMap<PathBuf, (u64, u64, Option<SessionCard>)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

fn cache() -> &'static Mutex<Cache> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn default_root() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude")
}

fn roots_from_config() -> Vec<PathBuf> {
    let defaults = || {
        let home = dirs::home_dir().unwrap_or_default();
        vec![home.join(".claude"), home.join(".claude-bro")]
    };
    let Ok(cfg) = crate::config::config_get() else {
        return defaults();
    };
    let list: Vec<PathBuf> = cfg
        .get("history")
        .and_then(|h| h.get("claude_roots"))
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .map(|s| PathBuf::from(crate::pty::expand_tilde(s)))
                .collect()
        })
        .unwrap_or_default();
    if list.is_empty() {
        defaults()
    } else {
        list
    }
}

fn mtime_ms_of(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// El corazon, puro sobre `roots` para poder testearlo con un tempdir.
pub fn index(roots: &[PathBuf], days: f64, limit: usize) -> Vec<SessionCard> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let cut_ms = if days > 0.0 {
        now_ms.saturating_sub((days * 86_400_000.0) as u64)
    } else {
        0
    };
    let default = default_root();

    // 1) stat sweep: candidatos por recencia, sin abrir nada
    let mut files: Vec<(u64, u64, PathBuf, Option<String>)> = Vec::new();
    for root in roots {
        let cfg_dir = if *root == default {
            None
        } else {
            Some(root.to_string_lossy().to_string())
        };
        let projects = root.join("projects");
        let Ok(slugs) = std::fs::read_dir(&projects) else {
            continue;
        };
        for slug in slugs.flatten() {
            let dir = slug.path();
            if !dir.is_dir() {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for e in entries.flatten() {
                let p = e.path();
                if !p.extension().map(|x| x == "jsonl").unwrap_or(false) {
                    continue;
                }
                let Ok(md) = e.metadata() else { continue };
                let size = md.len();
                // <500 bytes no alcanza ni para un mensaje: cascaron seguro
                if size < 500 {
                    continue;
                }
                let mtime = mtime_ms_of(&md);
                if mtime < cut_ms {
                    continue;
                }
                files.push((mtime, size, p, cfg_dir.clone()));
            }
        }
    }
    files.sort_by_key(|item| std::cmp::Reverse(item.0));

    // 2) abrir SOLO hasta llenar la lista (los filtrados no cuentan)
    let mut out = Vec::with_capacity(limit.min(files.len()));
    for (mtime, size, path, cfg_dir) in files {
        if out.len() >= limit {
            break;
        }
        if let Some(card) = card_for(&path, mtime, size, cfg_dir) {
            out.push(card);
        }
    }
    out
}

fn card_for(
    path: &Path,
    mtime_ms: u64,
    size: u64,
    config_dir: Option<String>,
) -> Option<SessionCard> {
    if let Some((m, s, v)) = cache().lock().unwrap().get(path) {
        if *m == mtime_ms && *s == size {
            return v.clone();
        }
    }
    // el lock NO se sostiene durante la IO: indexar no debe serializar con nadie
    let verdict = build_card(path, mtime_ms, size, config_dir);
    cache()
        .lock()
        .unwrap()
        .insert(path.to_path_buf(), (mtime_ms, size, verdict.clone()));
    verdict
}

fn build_card(
    path: &Path,
    mtime_ms: u64,
    size: u64,
    config_dir: Option<String>,
) -> Option<SessionCard> {
    if crate::pty::is_machinery_session(path) || !crate::pty::has_real_messages(path) {
        return None;
    }
    let head = read_head(path, 256 * 1024)?;
    let mut cwd: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    for line in head.lines() {
        if cwd.is_some() && first_prompt.is_some() {
            break;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue; // linea partida por el corte: seguir
        };
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                if !c.is_empty() {
                    cwd = Some(c.to_string());
                }
            }
        }
        if first_prompt.is_none()
            && v.get("type").and_then(|x| x.as_str()) == Some("user")
            && !v
                .get("isSidechain")
                .and_then(|x| x.as_bool())
                .unwrap_or(false)
            && !v.get("isMeta").and_then(|x| x.as_bool()).unwrap_or(false)
        {
            if let Some(t) = user_text(&v) {
                first_prompt = Some(t);
            }
        }
    }
    let title = crate::pty::last_ai_title(path)
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .or(first_prompt);
    let sid = path.file_stem()?.to_string_lossy().to_string();
    Some(SessionCard {
        sid,
        path: path.to_string_lossy().to_string(),
        config_dir,
        cwd: cwd.unwrap_or_default(),
        title,
        mtime_ms,
        size,
    })
}

fn read_head(path: &Path, cap: usize) -> Option<String> {
    use std::io::Read;
    let f = std::fs::File::open(path).ok()?;
    let mut buf = Vec::with_capacity(cap.min(1 << 20));
    f.take(cap as u64).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// El texto del primer prompt REAL de un mensaje user, limpio de envolturas
/// (slash-commands `<command-name>`, caveats del CLI, salidas locales). Una
/// linea, truncada: es un TITULO de fallback, no el mensaje.
fn user_text(v: &serde_json::Value) -> Option<String> {
    let content = v.get("message")?.get("content")?;
    let raw: String = if let Some(s) = content.as_str() {
        s.to_string()
    } else {
        content
            .as_array()?
            .iter()
            .find_map(|b| {
                (b.get("type").and_then(|x| x.as_str()) == Some("text"))
                    .then(|| b.get("text").and_then(|x| x.as_str()))
                    .flatten()
            })?
            .to_string()
    };
    let line = raw
        .lines()
        .map(str::trim)
        .find(|l| {
            !l.is_empty()
                && !l.starts_with('<') // <command-name>, <local-command-stdout>, <system-reminder>
                && !l.starts_with("Caveat:")
        })?
        .to_string();
    let mut t: String = line.chars().take(90).collect();
    if line.chars().count() > 90 {
        t.push('…');
    }
    Some(t)
}

/// El comando de la vitrina: historial indexado, mas reciente primero.
#[tauri::command]
pub fn sessions_index(days: Option<f64>, limit: Option<usize>) -> Vec<SessionCard> {
    index(
        &roots_from_config(),
        days.unwrap_or(90.0),
        limit.unwrap_or(250),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Diagnostico contra el disco REAL del operador (por eso #[ignore]):
    /// `cargo test diagnostico_disco_real -- --ignored --nocapture`
    /// Mide el costo del primer index (cache frio) y enseña la cabeza de la
    /// lista — la forma honesta de saber si los filtros y titulos sirven.
    #[test]
    #[ignore]
    fn diagnostico_disco_real() {
        let home = dirs::home_dir().unwrap();
        let roots = vec![home.join(".claude"), home.join(".claude-bro")];
        let t0 = std::time::Instant::now();
        let cards = index(&roots, 90.0, 250);
        let frio = t0.elapsed();
        let t1 = std::time::Instant::now();
        let _ = index(&roots, 90.0, 250);
        let caliente = t1.elapsed();
        println!(
            "cards: {} · frio {frio:?} · caliente {caliente:?}",
            cards.len()
        );
        for c in cards.iter().take(12) {
            println!(
                "  [{}] {} · {} · {}",
                if c.config_dir.is_some() { "bro" } else { "def" },
                c.title.as_deref().unwrap_or("(sin titulo)"),
                c.cwd.rsplit('/').next().unwrap_or(""),
                c.sid.chars().take(8).collect::<String>()
            );
        }
        assert!(!cards.is_empty());
    }

    fn tempdir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sfterm-hist-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("projects").join("-tmp-proyecto")).unwrap();
        d
    }

    fn write(root: &Path, name: &str, body: &str) -> PathBuf {
        let p = root.join("projects").join("-tmp-proyecto").join(name);
        std::fs::write(&p, body).unwrap();
        p
    }

    fn relleno(n: usize) -> String {
        // los archivos de prueba deben pasar el gate de 500 bytes sin
        // inventar mensajes: una linea de comentario JSON valida y gorda
        format!("{{\"type\":\"pad\",\"x\":\"{}\"}}\n", "x".repeat(n))
    }

    #[test]
    fn indexa_solo_conversaciones_reales() {
        let root = tempdir("filtros");
        // real: cwd + user + assistant + ai-title
        write(
            &root,
            "aaaaaaaa-1111-4111-8111-111111111111.jsonl",
            &format!(
                concat!(
                    "{{\"type\":\"user\",\"cwd\":\"/tmp/proyecto\",\"message\":{{\"role\":\"user\",\"content\":\"hola, arregla el scroll\"}}}}\n",
                    "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"va\"}}]}}}}\n",
                    "{{\"type\":\"ai-title\",\"aiTitle\":\"Arreglar el scroll del lector\",\"sessionId\":\"x\"}}\n",
                    "{}"
                ),
                relleno(600)
            ),
        );
        // maquinaria: sello del SDK
        write(
            &root,
            "bbbbbbbb-2222-4222-8222-222222222222.jsonl",
            &format!(
                "{{\"type\":\"user\",\"entrypoint\":\"sdk-cli\",\"message\":{{\"role\":\"user\",\"content\":\"🤖 [cron] corre\"}}}}\n{}",
                relleno(600)
            ),
        );
        // cascaron grande: pasa el gate de bytes pero cero mensajes reales
        write(
            &root,
            "cccccccc-3333-4333-8333-333333333333.jsonl",
            &format!(
                "{{\"type\":\"queue-operation\",\"operation\":\"enqueue\"}}\n{}",
                relleno(600)
            ),
        );

        let cards = index(std::slice::from_ref(&root), 0.0, 50);
        assert_eq!(cards.len(), 1, "solo la real: {cards:?}");
        let c = &cards[0];
        assert_eq!(c.sid, "aaaaaaaa-1111-4111-8111-111111111111");
        assert_eq!(c.cwd, "/tmp/proyecto");
        assert_eq!(c.title.as_deref(), Some("Arreglar el scroll del lector"));
        // root == este tempdir (no default) → config_dir viaja
        assert_eq!(
            c.config_dir.as_deref(),
            Some(root.to_string_lossy().as_ref())
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn titulo_cae_al_primer_prompt_sin_ai_title() {
        let root = tempdir("fallback");
        write(
            &root,
            "dddddddd-4444-4444-8444-444444444444.jsonl",
            &format!(
                concat!(
                    "{{\"type\":\"user\",\"cwd\":\"/tmp/x\",\"message\":{{\"role\":\"user\",\"content\":\"Caveat: esto es ruido del CLI\\n<command-name>foo</command-name>\\nquiero un dashboard de ventas\"}}}}\n",
                    "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"va\"}}]}}}}\n",
                    "{}"
                ),
                relleno(600)
            ),
        );
        let cards = index(std::slice::from_ref(&root), 0.0, 50);
        assert_eq!(cards.len(), 1);
        assert_eq!(
            cards[0].title.as_deref(),
            Some("quiero un dashboard de ventas")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// El cache respeta (mtime, size): tocar el archivo re-lee; igual = hit.
    #[test]
    fn cache_por_mtime_y_size() {
        let root = tempdir("cache");
        let p = write(
            &root,
            "eeeeeeee-5555-4555-8555-555555555555.jsonl",
            &format!(
                "{{\"type\":\"user\",\"cwd\":\"/tmp/c1\",\"message\":{{\"role\":\"user\",\"content\":\"primero\"}}}}\n{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"ok\"}}]}}}}\n{}",
                relleno(600)
            ),
        );
        let a = index(std::slice::from_ref(&root), 0.0, 50);
        assert_eq!(a[0].title.as_deref(), Some("primero"));
        // mismo mtime/size → veredicto cacheado aunque el contenido cambiara
        // (no debe pasar en la vida real; aqui prueba que el cache MANDA)
        // …y un cambio real (size distinto) invalida:
        std::fs::write(
            &p,
            format!(
                "{{\"type\":\"user\",\"cwd\":\"/tmp/c1\",\"message\":{{\"role\":\"user\",\"content\":\"segundo prompt distinto\"}}}}\n{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"ok\"}}]}}}}\n{}",
                relleno(700)
            ),
        )
        .unwrap();
        let b = index(std::slice::from_ref(&root), 0.0, 50);
        assert_eq!(b[0].title.as_deref(), Some("segundo prompt distinto"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
