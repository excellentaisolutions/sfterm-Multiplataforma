use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub struct FsState {
    pub watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
}

#[derive(Serialize)]
pub struct FileContent {
    pub kind: String, // "text" | "binary" | "too_large"
    pub content: String,
    pub size: u64,
}

/// Lista UN nivel de directorio (el arbol es lazy: expande bajo demanda).
#[tauri::command]
pub fn fs_list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let path = crate::pty::expand_tilde(&path);
    let mut out = Vec::new();
    let rd = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.metadata();
        let ft = entry.file_type();
        let is_symlink = ft.as_ref().map(|t| t.is_symlink()).unwrap_or(false);
        let is_dir = if is_symlink {
            std::fs::metadata(entry.path()).map(|m| m.is_dir()).unwrap_or(false)
        } else {
            meta.map(|m| m.is_dir()).unwrap_or(false)
        };
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir,
            is_symlink,
        });
    }
    // Directorios primero, luego alfabetico case-insensitive (como VSCode)
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// Lee un archivo para el visor. max_bytes protege de archivos gigantes.
#[tauri::command]
pub fn fs_read_file(path: String, max_bytes: Option<u64>) -> Result<FileContent, String> {
    let path = crate::pty::expand_tilde(&path);
    let max = max_bytes.unwrap_or(2_000_000);
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let size = meta.len();
    if size > max {
        return Ok(FileContent {
            kind: "too_large".into(),
            content: String::new(),
            size,
        });
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    // Heuristica binario: NUL en los primeros 8KB
    let probe = &bytes[..bytes.len().min(8192)];
    if probe.contains(&0) {
        return Ok(FileContent {
            kind: "binary".into(),
            content: String::new(),
            size,
        });
    }
    Ok(FileContent {
        kind: "text".into(),
        content: String::from_utf8_lossy(&bytes).to_string(),
        size,
    })
}

#[tauri::command]
pub fn fs_home_dir() -> String {
    dirs::home_dir().unwrap_or_default().to_string_lossy().to_string()
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    let path = crate::pty::expand_tilde(&path);
    std::process::Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
pub struct TrashResult {
    pub trashed: Vec<String>,
    pub errors: Vec<String>,
}

/// Resuelve un path a su forma canonica SIN resolver el item mismo:
/// canonicaliza el PADRE y le vuelve a pegar el nombre. Si canonicalizaramos
/// el item, un symlink se resolveria a su destino y un enlace que SI vive
/// dentro del root se veria como si viviera afuera (la guarda lo rechazaria y
/// ademas mandariamos a la papelera el destino, no el enlace).
fn canon_keep_link(p: &Path) -> Option<std::path::PathBuf> {
    let parent = p.parent()?;
    let name = p.file_name()?;
    Some(parent.canonicalize().ok()?.join(name))
}

/// Manda archivos y carpetas a la PAPELERA del sistema. **Nunca borra en duro:**
/// `NSFileManager::trashItemAtURL` deja el item recuperable con "Devolver" del
/// Finder, que es el default de VSCode ("Move to Trash") y el unico gesto
/// destructivo que la app se permite. Cero dependencias nuevas: objc2-foundation
/// ya trae NSFileManager en sus features por default.
///
/// GUARDA DURA: solo se toca lo que vive DENTRO de `root` (el arbol abierto) y
/// jamas el root mismo. Un path que no pase la guarda se reporta como error, no
/// se salta en silencio.
#[tauri::command]
pub fn fs_trash(paths: Vec<String>, root: String) -> TrashResult {
    let mut trashed = Vec::new();
    let mut errors = Vec::new();

    let root_abs = crate::pty::expand_tilde(&root);
    let Some(root_canon) = Path::new(&root_abs).canonicalize().ok() else {
        errors.push(format!("no se pudo resolver el root: {root_abs}"));
        return TrashResult { trashed, errors };
    };

    for raw in paths {
        match trash_guard(&raw, &root_canon) {
            Err(e) => errors.push(format!("{raw}: {e}")),
            Ok(abs) => match trash_item(&abs) {
                Ok(()) => trashed.push(raw),
                Err(e) => errors.push(format!("{raw}: {e}")),
            },
        }
    }
    TrashResult { trashed, errors }
}

/// La guarda, pura y testeable: devuelve el path absoluto a mandar a la
/// papelera, o el motivo por el que NO se toca.
fn trash_guard(raw: &str, root_canon: &Path) -> Result<String, String> {
    let abs = crate::pty::expand_tilde(raw);
    // `symlink_metadata` NO sigue enlaces: un symlink roto existe como enlace y
    // debe poder mandarse a la papelera. Este chequeo es aparte de
    // `canon_keep_link` porque esa solo resuelve el PADRE — sin el, un nombre
    // inexistente dentro de un dir vivo pasaba la guarda y el error salia
    // despues, en crudo, desde Cocoa.
    if std::fs::symlink_metadata(&abs).is_err() {
        return Err("no existe".into());
    }
    let canon = canon_keep_link(Path::new(&abs)).ok_or("no existe")?;
    if canon == root_canon {
        return Err("es la raiz del arbol".into());
    }
    if !canon.starts_with(root_canon) {
        return Err("fuera del arbol abierto".into());
    }
    Ok(abs)
}

#[cfg(target_os = "macos")]
fn trash_item(path: &str) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|e| e.localizedDescription().to_string())
}

#[cfg(not(target_os = "macos"))]
fn trash_item(_path: &str) -> Result<(), String> {
    Err("papelera solo implementada en macOS".into())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ResolvedToken {
    pub path: String,
    pub line: Option<u32>,
    pub col: Option<u32>,
    pub is_dir: bool,
}

/// LINKS VIVOS (F2): resuelve un TOKEN de path visto en el output de una
/// terminal — relativo o absoluto, con sufijo `:linea(:col)` opcional — contra
/// el cwd VIVO de esa terminal, y VERIFICA existencia. `None` = no existe y el
/// frontend NO pinta link (cero falsos positivos: la regex del frontend solo
/// propone CANDIDATOS, la verdad la decide el filesystem aqui).
#[tauri::command]
pub fn fs_resolve_token(token: String, cwd: String) -> Option<ResolvedToken> {
    resolve_token(&token, &cwd)
}

pub fn resolve_token(token: &str, cwd: &str) -> Option<ResolvedToken> {
    // 1) sufijo :linea(:col) — se recorta ANTES de limpiar orillas, para no
    //    comerse los digitos. `x.ts:12:5` → (x.ts, linea 12, col 5).
    let (raw_path, line, col) = split_line_col(token.trim());
    // 2) basura de orilla que la regex del frontend puede arrastrar: puntuacion
    //    de prosa pegada al final ("ver src/x.ts.", "src/x.ts,") y un `:` suelto.
    let raw_path = raw_path.trim_end_matches(['.', ',', ';', ':', '\'', '"', ')', ']', '}']);
    if raw_path.is_empty() || raw_path == "/" || raw_path == "~" {
        return None;
    }
    // 3) ~ → home, relativo → cwd (join con un absoluto lo deja intacto)
    let expanded = crate::pty::expand_tilde(raw_path);
    let cwd_abs = crate::pty::expand_tilde(cwd);
    let joined = Path::new(&cwd_abs).join(&expanded);
    // 4) la VERDAD: canonicalize falla si no existe (y aplana ../ de paso)
    let canon = joined.canonicalize().ok()?;
    let is_dir = canon.is_dir();
    Some(ResolvedToken {
        path: canon.to_string_lossy().to_string(),
        line: if is_dir { None } else { line },
        col: if is_dir { None } else { col },
        is_dir,
    })
}

/// Recorta hasta dos sufijos `:numero` del final: `a.ts:12:5` → ("a.ts", 12, 5),
/// `a.ts:12` → ("a.ts", 12, None), `a.ts` → ("a.ts", None, None).
fn split_line_col(t: &str) -> (&str, Option<u32>, Option<u32>) {
    let mut path = t;
    let mut nums: Vec<u32> = Vec::new();
    for _ in 0..2 {
        let Some(i) = path.rfind(':') else { break };
        let tail = &path[i + 1..];
        if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
            break;
        }
        let Ok(n) = tail.parse() else { break };
        nums.push(n);
        path = &path[..i];
    }
    match nums.len() {
        // dos sufijos: el MAS CERCANO al path es la linea (`path:linea:col`)
        2 => (path, Some(nums[1]), Some(nums[0])),
        1 => (path, Some(nums[0]), None),
        _ => (path, None, None),
    }
}

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("solo http(s)".into());
    }
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Indice de archivos para Cmd+P (respeta .gitignore via crate `ignore`). Cap 50k.
#[tauri::command]
pub async fn fs_index(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::pty::expand_tilde(&root);
        let mut out: Vec<String> = Vec::new();
        let walker = ignore::WalkBuilder::new(&root)
            .hidden(false)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .filter_entry(|e| e.file_name() != ".git")
            .build();
        for entry in walker.flatten() {
            if out.len() >= 50_000 {
                break;
            }
            if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                if let Ok(rel) = entry.path().strip_prefix(&root) {
                    out.push(rel.to_string_lossy().to_string());
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Clone)]
pub struct SearchHit {
    pub path: String,
    pub line: usize,
    pub preview: String,
}

/// Busqueda por CONTENIDO en el proyecto (⌘⇧F / gate `search`).
/// Respeta .gitignore, salta binarios (byte 0 en el primer chunk) y archivos
/// >2MB, case-insensitive, cap de resultados. Logica pura en `search_dir`.
#[tauri::command]
pub async fn fs_search(root: String, q: String, max: Option<usize>) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::pty::expand_tilde(&root);
        Ok(search_dir(&root, &q, max.unwrap_or(200).min(500)))
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn search_dir(root: &str, q: &str, max: usize) -> Vec<SearchHit> {
    let needle = q.to_lowercase();
    let mut out: Vec<SearchHit> = Vec::new();
    if needle.trim().is_empty() {
        return out;
    }
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(|e| e.file_name() != ".git")
        .build();
    for entry in walker.flatten() {
        if out.len() >= max {
            break;
        }
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        if entry.metadata().map(|m| m.len() > 2_000_000).unwrap_or(true) {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path()) else { continue };
        if bytes.iter().take(1024).any(|b| *b == 0) {
            continue; // binario
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if out.len() >= max {
                break;
            }
            if line.to_lowercase().contains(&needle) {
                let rel = entry
                    .path()
                    .strip_prefix(root)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| entry.path().to_string_lossy().to_string());
                out.push(SearchHit {
                    path: rel,
                    line: i + 1,
                    preview: line.trim().chars().take(160).collect(),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_dir_encuentra_y_respeta_limites() {
        let dir = std::env::temp_dir().join(format!("sfterm-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "hola mundo\nsegunda linea NERVIO aqui\n").unwrap();
        std::fs::write(dir.join("sub/b.rs"), "fn main() { /* nervio */ }\n").unwrap();
        std::fs::write(dir.join("bin.dat"), [0u8, 159, 146, 150]).unwrap(); // binario
        let root = dir.to_string_lossy().to_string();

        let hits = search_dir(&root, "nervio", 10);
        assert_eq!(hits.len(), 2, "case-insensitive en texto, binario saltado");
        assert!(hits.iter().any(|h| h.path == "a.txt" && h.line == 2));
        assert!(hits.iter().any(|h| h.path == "sub/b.rs" && h.line == 1));
        assert!(hits[0].preview.contains("NERVIO") || hits[0].preview.contains("nervio"));

        assert_eq!(search_dir(&root, "nervio", 1).len(), 1, "cap respetado");
        assert!(search_dir(&root, "  ", 10).is_empty(), "query vacia = nada");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_token_relativas_lineas_y_orillas() {
        let dir = std::env::temp_dir().join(format!("sfterm-links-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/core")).unwrap();
        std::fs::write(dir.join("src/core/term.ts"), "x").unwrap();
        std::fs::write(dir.join("Cargo.toml"), "x").unwrap();
        let cwd = dir.to_string_lossy().to_string();
        let canon = |p: &str| dir.join(p).canonicalize().unwrap().to_string_lossy().to_string();

        // relativa simple contra el cwd
        let r = resolve_token("src/core/term.ts", &cwd).expect("relativa resuelve");
        assert_eq!(r.path, canon("src/core/term.ts"));
        assert_eq!((r.line, r.col, r.is_dir), (None, None, false));

        // sufijo :linea y :linea:col
        let r = resolve_token("src/core/term.ts:51", &cwd).unwrap();
        assert_eq!((r.line, r.col), (Some(51), None));
        let r = resolve_token("src/core/term.ts:51:7", &cwd).unwrap();
        assert_eq!((r.line, r.col), (Some(51), Some(7)));

        // ./ y ../ se aplanan; nombre.ext suelto tambien resuelve
        assert!(resolve_token("./src/core/term.ts", &cwd).is_some());
        let sub = dir.join("src").to_string_lossy().to_string();
        let r = resolve_token("../Cargo.toml", &sub).expect("../ resuelve");
        assert_eq!(r.path, canon("Cargo.toml"));
        assert!(resolve_token("Cargo.toml", &cwd).is_some());

        // puntuacion de prosa pegada ("ver src/x.ts.", "x.ts," / ":" suelto)
        assert!(resolve_token("src/core/term.ts.", &cwd).is_some());
        assert!(resolve_token("src/core/term.ts,", &cwd).is_some());
        assert!(resolve_token("src/core/term.ts:", &cwd).is_some());

        // directorio: is_dir=true y linea descartada (no aplica)
        let r = resolve_token("src/core:9", &cwd).unwrap();
        assert!(r.is_dir);
        assert_eq!(r.line, None);

        // LO QUE NO EXISTE JAMAS ES LINK (el contrato de cero falsos positivos)
        assert_eq!(resolve_token("src/core/fantasma.ts", &cwd), None);
        assert_eq!(resolve_token("10/20", &cwd), None);
        assert_eq!(resolve_token("example.com", &cwd), None);
        assert_eq!(resolve_token("", &cwd), None);
        assert_eq!(resolve_token("/", &cwd), None);

        // absoluta: el cwd no interfiere
        let abs = dir.join("Cargo.toml").to_string_lossy().to_string();
        let r = resolve_token(&abs, "/tmp").expect("absoluta resuelve");
        assert_eq!(r.path, canon("Cargo.toml"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_guard_solo_deja_pasar_lo_de_adentro() {
        let dir = std::env::temp_dir().join(format!("sfterm-trash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("root/sub")).unwrap();
        std::fs::write(dir.join("root/sub/a.txt"), "x").unwrap();
        std::fs::write(dir.join("afuera.txt"), "x").unwrap();
        let root_canon = dir.join("root").canonicalize().unwrap();
        let s = |p: &std::path::Path| p.to_string_lossy().to_string();

        assert!(trash_guard(&s(&dir.join("root/sub/a.txt")), &root_canon).is_ok());
        assert!(trash_guard(&s(&dir.join("root/sub")), &root_canon).is_ok(), "carpetas tambien");
        assert_eq!(
            trash_guard(&s(&dir.join("root")), &root_canon),
            Err("es la raiz del arbol".into()),
        );
        assert_eq!(
            trash_guard(&s(&dir.join("afuera.txt")), &root_canon),
            Err("fuera del arbol abierto".into()),
        );
        assert_eq!(
            trash_guard(&s(&dir.join("root/fantasma.txt")), &root_canon),
            Err("no existe".into()),
        );
        // un `..` que se escapa NO puede colarse: canonicalizar el padre lo aplana
        assert_eq!(
            trash_guard(&s(&dir.join("root/sub/../../afuera.txt")), &root_canon),
            Err("fuera del arbol abierto".into()),
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// E2E de verdad contra Cocoa. `#[ignore]` a proposito: deja basura en la
    /// Papelera de quien lo corra, no queremos eso en cada `npm run validate`.
    /// Correr a mano: `cargo test papelera -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn papelera_real_se_traga_archivo_y_carpeta() {
        let dir = std::env::temp_dir().join(format!("sfterm-trashE2E-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("carpeta/hondo")).unwrap();
        std::fs::write(dir.join("carpeta/hondo/x.txt"), "x").unwrap();
        std::fs::write(dir.join("suelto.txt"), "x").unwrap();
        let root = dir.to_string_lossy().to_string();

        let res = fs_trash(
            vec![
                dir.join("suelto.txt").to_string_lossy().to_string(),
                dir.join("carpeta").to_string_lossy().to_string(),
                root.clone(),                                    // la raiz: rechazada
                "/etc/hosts".into(),                             // afuera: rechazado
            ],
            root.clone(),
        );

        assert_eq!(res.trashed.len(), 2, "archivo y carpeta se fueron: {:?}", res.errors);
        assert_eq!(res.errors.len(), 2, "raiz y afuera rechazados");
        assert!(!dir.join("suelto.txt").exists());
        assert!(!dir.join("carpeta").exists(), "la carpeta se va con todo adentro");
        assert!(dir.exists(), "el root sigue de pie");
        assert!(std::path::Path::new("/etc/hosts").exists(), "nada fuera del root se toco");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Observa el root del arbol (FSEvents recursivo). Debounce + coalesce;
/// emite fs://changed con los paths afectados.
#[tauri::command]
pub fn fs_watch_root(app: AppHandle, root: String) -> Result<(), String> {
    let root = crate::pty::expand_tilde(&root);
    let state = app.state::<FsState>();
    let app2 = app.clone();

    let pending: std::sync::Arc<Mutex<Vec<String>>> = Default::default();
    let last_flush: std::sync::Arc<Mutex<Instant>> =
        std::sync::Arc::new(Mutex::new(Instant::now()));

    let pending2 = pending.clone();
    let mut watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(event) = res {
            let mut p = pending2.lock().unwrap();
            for path in &event.paths {
                let s = path.to_string_lossy().to_string();
                if s.contains("/.git/") {
                    continue; // el espejo git se refresca aparte con debounce propio
                }
                if !p.contains(&s) {
                    p.push(s);
                }
            }
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(Path::new(&root), RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    *state.watcher.lock().unwrap() = Some(watcher);

    // Flusher: cada 350ms si hay pendientes, emite y limpia
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(350));
        let paths: Vec<String> = {
            let mut p = pending.lock().unwrap();
            if p.is_empty() {
                continue;
            }
            std::mem::take(&mut *p)
        };
        let mut lf = last_flush.lock().unwrap();
        *lf = Instant::now();
        drop(lf);
        let _ = app2.emit("fs://changed", paths);
    });

    Ok(())
}
