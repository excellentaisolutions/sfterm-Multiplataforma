use git2::{Repository, StatusOptions};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Serialize, Default)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: String,
    pub changed: usize,
    /// path relativo -> codigo: "M" modificado, "A"/"U" nuevo/untracked, "D" borrado, "R" renombrado, "C" conflicto
    pub files: HashMap<String, String>,
    /// paths (relativos) ignorados por git — archivos Y directorios
    pub ignored: Vec<String>,
}

fn status_code(s: git2::Status) -> Option<&'static str> {
    use git2::Status as S;
    if s.intersects(S::CONFLICTED) {
        return Some("C");
    }
    if s.intersects(S::WT_NEW | S::INDEX_NEW) {
        return Some("U");
    }
    if s.intersects(S::WT_MODIFIED | S::INDEX_MODIFIED | S::WT_TYPECHANGE | S::INDEX_TYPECHANGE) {
        return Some("M");
    }
    if s.intersects(S::WT_DELETED | S::INDEX_DELETED) {
        return Some("D");
    }
    if s.intersects(S::WT_RENAMED | S::INDEX_RENAMED) {
        return Some("R");
    }
    None
}

#[tauri::command]
pub async fn git_status(root: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::pty::expand_tilde(&root);
        let repo = match Repository::discover(&root) {
            Ok(r) => r,
            Err(_) => return Ok(GitStatus::default()),
        };
        let workdir = repo
            .workdir()
            .map(|p| p.to_path_buf())
            .ok_or("bare repo")?;

        let branch = repo
            .head()
            .ok()
            .and_then(|h| h.shorthand().ok().map(|s| s.to_string()))
            .unwrap_or_else(|| "HEAD".into());

        let mut opts = StatusOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .include_ignored(true)
            .recurse_ignored_dirs(false)
            .exclude_submodules(true);

        let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
        let mut files = HashMap::new();
        let mut ignored = Vec::new();
        for entry in statuses.iter() {
            let Ok(path) = entry.path() else { continue };
            let s = entry.status();
            if s.intersects(git2::Status::IGNORED) {
                ignored.push(path.trim_end_matches('/').to_string());
                continue;
            }
            if let Some(code) = status_code(s) {
                files.insert(path.to_string(), code.to_string());
            }
        }
        let changed = files.len();

        // Si el root pedido es un subdirectorio del workdir, re-relativizar los paths
        let root_path = std::path::Path::new(&root)
            .canonicalize()
            .unwrap_or_else(|_| std::path::PathBuf::from(&root));
        let workdir_c = workdir
            .canonicalize()
            .unwrap_or_else(|_| workdir.clone());
        if root_path != workdir_c {
            if let Ok(prefix) = root_path.strip_prefix(&workdir_c) {
                let prefix = format!("{}/", prefix.to_string_lossy());
                let remap = |m: HashMap<String, String>| {
                    m.into_iter()
                        .filter_map(|(k, v)| k.strip_prefix(&prefix).map(|k| (k.to_string(), v)))
                        .collect::<HashMap<_, _>>()
                };
                let files2 = remap(files);
                let ignored2: Vec<String> = ignored
                    .into_iter()
                    .filter_map(|k: String| {
                        k.strip_prefix(prefix.as_str()).map(|s: &str| s.to_string())
                    })
                    .collect();
                return Ok(GitStatus {
                    is_repo: true,
                    branch,
                    changed,
                    files: files2,
                    ignored: ignored2,
                });
            }
        }

        Ok(GitStatus {
            is_repo: true,
            branch,
            changed,
            files,
            ignored,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ───────────────────────── SOURCE CONTROL ESPEJO (28 jul 2026) ─────────────
// El panel responde tres preguntas sin teclear comandos: ¿que cambie?, ¿que
// esta commiteado pero SIN push?, ¿que hay en la nube que no tengo?  Todo es
// LECTURA: ninguno de estos comandos muta el repo.

#[derive(Serialize, Default)]
pub struct GitSyncState {
    pub is_repo: bool,
    pub branch: String,
    /// nombre corto del upstream ("origin/main") — None = rama sin upstream
    pub upstream: Option<String>,
    /// commits locales que el upstream NO tiene (solo en este disco)
    pub ahead: usize,
    /// commits del upstream que la rama local no tiene
    pub behind: usize,
    /// ¿el repo tiene ALGUN remote configurado? (sin remote = todo es local,
    /// y el panel lo dice honesto en vez de fingir estado de nube)
    pub has_remote: bool,
    pub dirty: usize,
    pub head: Option<String>,
}

/// Etiqueta de ref sobre un commit (chip del grafo): "main", "origin/main"…
#[derive(Serialize)]
pub struct GitRefChip {
    pub name: String,
    pub remote: bool,
    /// esta rama es el HEAD actual
    pub head: bool,
}

#[derive(Serialize)]
pub struct GitCommitInfo {
    pub hash: String,
    /// hash completo — los `parents` referencian estos (grafo del frontend)
    pub full: String,
    pub msg: String,
    pub time: i64,
    pub author: String,
    /// true = algun remote ya lo tiene (esta "en la nube"); false = SOLO
    /// LOCAL. Sin remotes, todos false y el frontend no pinta la marca.
    pub in_cloud: bool,
    /// padres (hashes completos) — las aristas del grafo
    pub parents: Vec<String>,
    pub refs: Vec<GitRefChip>,
}

#[derive(Serialize, Default)]
pub struct GitLog {
    pub has_upstream: bool,
    pub commits: Vec<GitCommitInfo>,
}

/// upstream de la rama actual, como (nombre corto, Oid de su punta)
fn upstream_of(repo: &Repository) -> Option<(String, git2::Oid)> {
    let head = repo.head().ok()?;
    if !head.is_branch() {
        return None;
    }
    let name = head.shorthand().ok()?.to_string();
    let branch = repo.find_branch(&name, git2::BranchType::Local).ok()?;
    let up = branch.upstream().ok()?;
    let label = up.name().ok().flatten().map(|s| s.to_string())?;
    let oid = up.get().target()?;
    Some((label, oid))
}

#[tauri::command]
pub async fn git_state(root: String) -> Result<GitSyncState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::pty::expand_tilde(&root);
        let repo = match Repository::discover(&root) {
            Ok(r) => r,
            Err(_) => return Ok(GitSyncState::default()),
        };
        Ok(sync_state(&repo))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn sync_state(repo: &Repository) -> GitSyncState {
    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(|s| s.to_string()))
        .unwrap_or_else(|| "HEAD".into());
    let head_oid = repo.head().ok().and_then(|h| h.target());
    let has_remote = repo.remotes().map(|r| !r.is_empty()).unwrap_or(false);

    let (upstream, ahead, behind) = match (head_oid, upstream_of(repo)) {
        (Some(h), Some((label, up))) => {
            let (a, b) = repo.graph_ahead_behind(h, up).unwrap_or((0, 0));
            (Some(label), a, b)
        }
        _ => (None, 0, 0),
    };

    // dirty barato: sin ignored (el status del arbol ya trae el detalle)
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .exclude_submodules(true);
    let dirty = repo
        .statuses(Some(&mut opts))
        .map(|s| s.iter().filter(|e| status_code(e.status()).is_some()).count())
        .unwrap_or(0);

    GitSyncState {
        is_repo: true,
        branch,
        upstream,
        ahead,
        behind,
        has_remote,
        dirty,
        head: head_oid.map(|o| short(o)),
    }
}

fn short(oid: git2::Oid) -> String {
    oid.to_string().chars().take(8).collect()
}

/// tips de TODAS las ramas (locales y remotas, cap 32 c/u) + chips por oid.
/// "origin/HEAD" (alias) se salta. Devuelve (locales, remotas, chips).
type RefChips = HashMap<git2::Oid, Vec<GitRefChip>>;
fn branch_tips(repo: &Repository) -> (Vec<git2::Oid>, Vec<git2::Oid>, RefChips) {
    let head_name = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(|s| s.to_string()));
    let mut locals = Vec::new();
    let mut remotes = Vec::new();
    let mut chips: RefChips = HashMap::new();
    let mut push = |oid: git2::Oid, name: String, remote: bool, head: bool| {
        chips.entry(oid).or_default().push(GitRefChip { name, remote, head });
    };
    if let Ok(branches) = repo.branches(Some(git2::BranchType::Local)) {
        for (b, _) in branches.flatten().take(32) {
            let Some(oid) = b.get().target() else { continue };
            let Ok(Some(name)) = b.name() else { continue };
            locals.push(oid);
            push(oid, name.to_string(), false, head_name.as_deref() == Some(name));
        }
    }
    if let Ok(branches) = repo.branches(Some(git2::BranchType::Remote)) {
        for (b, _) in branches.flatten().take(32) {
            let Some(oid) = b.get().target() else { continue };
            let Ok(Some(name)) = b.name() else { continue };
            if name.ends_with("/HEAD") {
                continue; // alias, ruido
            }
            remotes.push(oid);
            push(oid, name.to_string(), true, false);
        }
    }
    (locals, remotes, chips)
}

/// Historial paginado del GRAFO: camina desde TODAS las ramas (topologico),
/// con padres (aristas), chips de refs y la marca nube-vs-solo-local
/// generalizada (solo-local = alcanzable desde ramas locales pero desde
/// NINGUNA rama remota).
#[tauri::command]
pub async fn git_log(root: String, skip: usize, limit: usize) -> Result<GitLog, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::pty::expand_tilde(&root);
        let repo = match Repository::discover(&root) {
            Ok(r) => r,
            Err(_) => return Ok(GitLog::default()),
        };
        let (locals, remotes, chips) = branch_tips(&repo);
        if locals.is_empty() && remotes.is_empty() {
            return Ok(GitLog::default());
        }

        // solo-local generalizado: lo local que NINGUN remote tiene
        let local_only: HashSet<git2::Oid> = if remotes.is_empty() {
            HashSet::new()
        } else {
            let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
            for &t in &locals {
                walk.push(t).ok();
            }
            for &t in &remotes {
                walk.hide(t).ok();
            }
            walk.flatten().collect()
        };

        let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
        walk.set_sorting(git2::Sort::TOPOLOGICAL | git2::Sort::TIME)
            .map_err(|e| e.to_string())?;
        for &t in locals.iter().chain(remotes.iter()) {
            walk.push(t).ok();
        }
        let limit = limit.clamp(1, 500);
        let mut commits = Vec::with_capacity(limit);
        for oid in walk.flatten().skip(skip).take(limit) {
            let Ok(c) = repo.find_commit(oid) else { continue };
            commits.push(GitCommitInfo {
                hash: short(oid),
                full: oid.to_string(),
                msg: c.summary().ok().flatten().unwrap_or("").chars().take(120).collect(),
                time: c.time().seconds(),
                author: c.author().name().ok().unwrap_or("").to_string(),
                in_cloud: !remotes.is_empty() && !local_only.contains(&oid),
                parents: c.parent_ids().map(|p| p.to_string()).collect(),
                refs: chips.get(&oid).map(|v| {
                    v.iter()
                        .map(|r| GitRefChip { name: r.name.clone(), remote: r.remote, head: r.head })
                        .collect()
                }).unwrap_or_default(),
            });
        }
        Ok(GitLog {
            has_upstream: !remotes.is_empty(),
            commits,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Detalle de UN commit como archivo .patch en el cache de la app (el visor
/// abre paths reales; escribirlo aqui evita inventar documentos virtuales).
/// Devuelve la ruta escrita.
#[tauri::command]
pub async fn git_commit_file(root: String, hash: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::pty::expand_tilde(&root);
        let repo = Repository::discover(&root).map_err(|e| e.to_string())?;
        let obj = repo.revparse_single(&hash).map_err(|e| e.to_string())?;
        let commit = obj.peel_to_commit().map_err(|e| e.to_string())?;
        let text = commit_patch(&repo, &commit)?;

        let dir = crate::config::config_dir().join("commits");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join(format!("{}.patch", short(commit.id())));
        std::fs::write(&path, text).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// patch legible: cabecera + diff vs primer padre (o arbol vacio si es raiz)
fn commit_patch(repo: &Repository, commit: &git2::Commit) -> Result<String, String> {
    let tree = commit.tree().map_err(|e| e.to_string())?;
    let parent_tree = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let mut opts = git2::DiffOptions::new();
    opts.context_lines(3);
    let diff = repo
        .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
        .map_err(|e| e.to_string())?;

    let when = commit.time().seconds();
    let mut out = format!(
        "commit {}\nAutor: {} <{}>\nFecha: {}\n\n    {}\n\n",
        commit.id(),
        commit.author().name().unwrap_or(""),
        commit.author().email().unwrap_or(""),
        when,
        commit.message().unwrap_or("").trim_end().replace('\n', "\n    "),
    );
    const CAP: usize = 400_000;
    let mut truncated = false;
    diff.print(git2::DiffFormat::Patch, |_d, _h, line| {
        if out.len() > CAP {
            truncated = true;
            return false;
        }
        let prefix = match line.origin() {
            '+' => "+",
            '-' => "-",
            ' ' => " ",
            _ => "",
        };
        out.push_str(prefix);
        out.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .ok(); // diff.print devuelve Err al cortar por callback: el corte es a proposito
    if truncated {
        out.push_str("\n… (diff truncado — commit muy grande)\n");
    }
    Ok(out)
}

/// Diff unificado (workdir+index vs HEAD) de UN archivo, como texto.
/// Para untracked: contenido completo como agregado.
#[tauri::command]
pub async fn git_diff_file(root: String, path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::pty::expand_tilde(&root);
        let repo = Repository::discover(&root).map_err(|e| e.to_string())?;
        let workdir = repo.workdir().ok_or("bare repo")?.to_path_buf();

        // path puede venir relativo al root pedido; normalizar a relativo del workdir
        let abs = std::path::Path::new(&root).join(&path);
        let abs = abs.canonicalize().unwrap_or(abs);
        let rel = abs
            .strip_prefix(workdir.canonicalize().unwrap_or(workdir.clone()))
            .map_err(|_| "path fuera del repo")?
            .to_path_buf();

        let mut opts = git2::DiffOptions::new();
        opts.pathspec(rel.to_string_lossy().to_string());
        opts.recurse_untracked_dirs(true);
        opts.show_untracked_content(true);
        opts.context_lines(3);

        let head_tree = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_tree().ok());

        let diff = repo
            .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
            .map_err(|e| e.to_string())?;

        let mut out = String::new();
        diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
            let prefix = match line.origin() {
                '+' => "+",
                '-' => "-",
                ' ' => " ",
                _ => "",
            };
            out.push_str(prefix);
            out.push_str(&String::from_utf8_lossy(line.content()));
            true
        })
        .map_err(|e| e.to_string())?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::path::PathBuf;

    /// repo temporal REAL (git2): dir unico bajo temp, firma fija.
    pub(crate) fn make_repo(tag: &str) -> (PathBuf, Repository) {
        let dir = std::env::temp_dir().join(format!(
            "sfterm-gittest-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        // initial_head explicito: el default de libgit2 sigue siendo "master"
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("main");
        let repo = Repository::init_opts(&dir, &opts).unwrap();
        repo.config().unwrap().set_str("user.name", "test").unwrap();
        repo.config().unwrap().set_str("user.email", "t@t").unwrap();
        (dir, repo)
    }

    pub(crate) fn commit_file(repo: &Repository, name: &str, content: &str, msg: &str) -> git2::Oid {
        let workdir = repo.workdir().unwrap().to_path_buf();
        std::fs::write(workdir.join(name), content).unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new(name)).unwrap();
        idx.write().unwrap();
        let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("test", "t@t").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents)
            .unwrap()
    }

    /// simula un upstream: origin/main apuntando a `oid` + config de rama
    fn fake_upstream(repo: &Repository, oid: git2::Oid) {
        repo.remote("origin", "https://example.invalid/repo.git")
            .unwrap();
        repo.reference("refs/remotes/origin/main", oid, true, "test")
            .unwrap();
        let mut cfg = repo.config().unwrap();
        cfg.set_str("branch.main.remote", "origin").unwrap();
        cfg.set_str("branch.main.merge", "refs/heads/main").unwrap();
    }

    #[test]
    fn ahead_behind_y_clasificacion_nube_vs_local() {
        let (dir, repo) = make_repo("sync");
        let c1 = commit_file(&repo, "a.txt", "uno", "c1");
        fake_upstream(&repo, c1); // la "nube" tiene c1
        let c2 = commit_file(&repo, "a.txt", "dos", "c2"); // solo local

        let s = sync_state(&repo);
        assert_eq!(s.branch, "main");
        assert_eq!(s.upstream.as_deref(), Some("origin/main"));
        assert_eq!((s.ahead, s.behind), (1, 0));
        assert!(s.has_remote);

        // clasificacion: c2 SOLO LOCAL, c1 en la nube — via el camino real
        let root = dir.to_string_lossy().to_string();
        let log = tauri::async_runtime::block_on(git_log(root, 0, 10)).unwrap();
        let cloud = |oid: git2::Oid| {
            log.commits
                .iter()
                .find(|c| c.full == oid.to_string())
                .map(|c| c.in_cloud)
        };
        assert_eq!(cloud(c2), Some(false), "c2 es solo local");
        assert_eq!(cloud(c1), Some(true), "c1 ya esta en la nube");

        // behind: la nube avanza a c2 y el local se regresa a c1
        repo.reference("refs/remotes/origin/main", c2, true, "test")
            .unwrap();
        let c1_commit = repo.find_commit(c1).unwrap();
        repo.reset(c1_commit.as_object(), git2::ResetType::Hard, None)
            .unwrap();
        let s2 = sync_state(&repo);
        assert_eq!((s2.ahead, s2.behind), (0, 1));

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn sin_remote_es_honesto_y_log_pagina() {
        let (dir, repo) = make_repo("noremote");
        for i in 0..5 {
            commit_file(&repo, "a.txt", &format!("v{i}"), &format!("c{i}"));
        }
        let s = sync_state(&repo);
        assert!(!s.has_remote && s.upstream.is_none());
        assert_eq!((s.ahead, s.behind), (0, 0));

        // log paginado sin upstream: has_upstream=false, in_cloud jamas true
        let root = dir.to_string_lossy().to_string();
        let log = tauri::async_runtime::block_on(git_log(root.clone(), 1, 2)).unwrap();
        assert!(!log.has_upstream);
        assert_eq!(log.commits.len(), 2);
        assert_eq!(log.commits[0].msg, "c3"); // skip=1 desde c4
        assert!(log.commits.iter().all(|c| !c.in_cloud));

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn grafo_padres_y_chips_de_rama_y_merge() {
        let (dir, repo) = make_repo("grafo");
        let c1 = commit_file(&repo, "a.txt", "uno", "c1");
        // rama feature desde c1, con su propio commit
        let c1c = repo.find_commit(c1).unwrap();
        repo.branch("feature", &c1c, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
        let c2f = commit_file(&repo, "f.txt", "feat", "c2-feature");
        // de vuelta a main, commit propio + MERGE de feature (dos padres)
        repo.set_head("refs/heads/main").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
        let c2m = commit_file(&repo, "m.txt", "main", "c2-main");
        let sig = git2::Signature::now("test", "t@t").unwrap();
        let tree = repo.find_commit(c2m).unwrap().tree().unwrap();
        let parents = [repo.find_commit(c2m).unwrap(), repo.find_commit(c2f).unwrap()];
        let pref: Vec<&git2::Commit> = parents.iter().collect();
        let merge = repo
            .commit(Some("HEAD"), &sig, &sig, "merge feature", &tree, &pref)
            .unwrap();

        let root = dir.to_string_lossy().to_string();
        let log = tauri::async_runtime::block_on(git_log(root, 0, 10)).unwrap();
        let m = log.commits.iter().find(|c| c.full == merge.to_string()).unwrap();
        assert_eq!(m.parents.len(), 2, "el merge trae sus dos aristas");
        assert!(m.refs.iter().any(|r| r.name == "main" && r.head && !r.remote));
        let f = log.commits.iter().find(|c| c.full == c2f.to_string()).unwrap();
        assert!(f.refs.iter().any(|r| r.name == "feature" && !r.head));
        // todos los commits del grafo aparecen (ambas ramas caminadas)
        assert!(log.commits.len() >= 4);

        std::fs::remove_dir_all(dir).ok();
    }
}
