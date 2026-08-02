//! CHECKPOINTS DE AGENTE (28 jul 2026) — la red de deshacer, inspirada en el
//! shadow-git de T3 Code/Conductor.
//!
//! Fotos invisibles del repo completo como REFS OCULTOS en namespace propio
//! (`refs/sfterm/checkpoints/…`). Tres invariantes duros:
//!  1. CAPTURAR jamas toca el index ni el working tree del usuario: el arbol
//!     se construye con un `git2::Index` EN MEMORIA (`write_tree_to`), y el
//!     commit se crea con `update_ref = None` — solo objetos + un ref oculto.
//!  2. El namespace vive FUERA de las refspecs por default (`refs/heads/*`,
//!     `refs/tags/*`): un `git push` normal jamas lo sube (testeado).
//!  3. RESTORE es la unica operacion que escribe el working tree, es SOLO
//!     conversacional (verbo de gate, sin boton), y antes de tocar nada se
//!     auto-captura un checkpoint "pre-restore" — el propio restore es
//!     deshacible.
//!
//! Retencion: al guardar se podan los refs mas alla de `KEEP` (40 por repo).

use git2::Repository;
use serde::Serialize;

const NAMESPACE: &str = "refs/sfterm/checkpoints";
const KEEP: usize = 40;

#[derive(Serialize)]
pub struct CheckpointInfo {
    /// id = hash corto del commit oculto (estable, unico)
    pub id: String,
    pub label: String,
    pub time: i64,
    /// archivos que difieren del HEAD del momento de la captura
    pub files: usize,
}

fn short(oid: git2::Oid) -> String {
    oid.to_string().chars().take(8).collect()
}

fn open(root: &str) -> Result<Repository, String> {
    let root = crate::pty::expand_tilde(root);
    Repository::discover(&root).map_err(|e| e.to_string())
}

/// Foto del working tree SIN tocar el index del usuario. Devuelve el oid del
/// commit oculto. Nucleo puro compartido por save y por el pre-restore.
///
/// ⚠️ Trabaja sobre un SEGUNDO handle del mismo repo: `set_index` contamina el
/// handle donde se llama (sus `statuses()`/`reset()` posteriores usarian el
/// index en memoria — cazado por test). Un handle propio muere aqui adentro y
/// el del caller queda pristino.
fn capture(repo: &Repository, label: &str) -> Result<(git2::Oid, usize), String> {
    let repo = Repository::open(repo.path()).map_err(|e| e.to_string())?;
    let repo = &repo;
    // arbol desde el working tree via index EN MEMORIA (jamas .git/index):
    // add_all respeta .gitignore e incluye untracked — la foto es lo que un
    // `git add -A` veria, sin ejecutarlo de verdad.
    let mut idx = git2::Index::new().map_err(|e| e.to_string())?;
    repo.set_index(&mut idx).map_err(|e| e.to_string())?;
    // ⚠️ REPOS ANIDADOS (cazado en vivo 29 jul con business-os): add_all
    // truena con "invalid path ...; class=Index" al toparse un directorio
    // que es OTRO repo git (submodule o clon embebido) — llega al callback
    // con trailing '/'. Se SALTAN: son sus repos, no de este (mismo criterio
    // que git). El checkpoint cubre exactamente los archivos de ESTE repo.
    idx.add_all(
        ["*"].iter(),
        git2::IndexAddOption::DEFAULT,
        Some(&mut |path: &std::path::Path, _spec: &[u8]| {
            if path.to_string_lossy().ends_with('/') {
                1
            } else {
                0
            }
        }),
    )
    .map_err(|e| e.to_string())?;
    let tree_oid = idx.write_tree_to(repo).map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_oid).map_err(|e| e.to_string())?;

    let head = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    // cuantos archivos difieren del HEAD (metadato del panel)
    let files = match &head {
        Some(h) => repo
            .diff_tree_to_tree(h.tree().ok().as_ref(), Some(&tree), None)
            .map(|d| d.deltas().len())
            .unwrap_or(0),
        None => tree.len(),
    };

    let sig =
        git2::Signature::now("sfterm", "checkpoint@sfterm.local").map_err(|e| e.to_string())?;
    let parents: Vec<&git2::Commit> = head.iter().collect();
    let msg = if label.trim().is_empty() {
        "checkpoint"
    } else {
        label.trim()
    };
    let oid = repo
        .commit(None, &sig, &sig, msg, &tree, &parents)
        .map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    repo.reference(
        &format!("{NAMESPACE}/{ts}-{}", short(oid)),
        oid,
        true,
        "sfterm checkpoint",
    )
    .map_err(|e| e.to_string())?;
    prune(repo);
    Ok((oid, files))
}

/// refs del namespace, mas reciente primero
fn refs_sorted(repo: &Repository) -> Vec<(String, git2::Oid, i64)> {
    let mut out = Vec::new();
    let Ok(refs) = repo.references_glob(&format!("{NAMESPACE}/*")) else {
        return out;
    };
    for r in refs.flatten() {
        let Ok(name) = r.name().map(|s| s.to_string()) else {
            continue;
        };
        let Some(oid) = r.target() else { continue };
        let Ok(c) = repo.find_commit(oid) else {
            continue;
        };
        out.push((name, oid, c.time().seconds()));
    }
    out.sort_by(|a, b| b.2.cmp(&a.2).then(b.0.cmp(&a.0)));
    out
}

fn prune(repo: &Repository) {
    for (name, _, _) in refs_sorted(repo).into_iter().skip(KEEP) {
        if let Ok(mut r) = repo.find_reference(&name) {
            r.delete().ok();
        }
    }
}

fn find_by_id(repo: &Repository, id: &str) -> Result<git2::Oid, String> {
    refs_sorted(repo)
        .into_iter()
        .find(|(_, oid, _)| short(*oid) == id || oid.to_string().starts_with(id))
        .map(|(_, oid, _)| oid)
        .ok_or_else(|| format!("checkpoint {id} no existe"))
}

#[tauri::command]
pub async fn checkpoint_save(
    root: String,
    label: Option<String>,
) -> Result<CheckpointInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = open(&root)?;
        let label = label.unwrap_or_default();
        let (oid, files) = capture(&repo, &label)?;
        let c = repo.find_commit(oid).map_err(|e| e.to_string())?;
        Ok(CheckpointInfo {
            id: short(oid),
            label: c.message().unwrap_or("checkpoint").trim().to_string(),
            time: c.time().seconds(),
            files,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn checkpoint_list(
    root: String,
    limit: Option<usize>,
) -> Result<Vec<CheckpointInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = open(&root)?;
        let n = limit.unwrap_or(20).clamp(1, KEEP);
        let head_tree = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .and_then(|c| c.tree().ok());
        Ok(refs_sorted(&repo)
            .into_iter()
            .take(n)
            .filter_map(|(_, oid, time)| {
                let c = repo.find_commit(oid).ok()?;
                // files = cuanto difiere la foto del HEAD ACTUAL (barato:
                // tree-a-tree, sin tocar el working tree)
                let files = c
                    .tree()
                    .ok()
                    .and_then(|t| {
                        repo.diff_tree_to_tree(head_tree.as_ref(), Some(&t), None)
                            .ok()
                    })
                    .map(|d| d.deltas().len())
                    .unwrap_or(0);
                Some(CheckpointInfo {
                    id: short(oid),
                    label: c.message().unwrap_or("checkpoint").trim().to_string(),
                    time,
                    files,
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Que cambio DESDE la foto hasta el working tree de hoy (patch, capado).
#[tauri::command]
pub async fn checkpoint_diff(root: String, id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = open(&root)?;
        let oid = find_by_id(&repo, &id)?;
        let tree = repo
            .find_commit(oid)
            .and_then(|c| c.tree())
            .map_err(|e| e.to_string())?;
        let mut opts = git2::DiffOptions::new();
        opts.include_untracked(true)
            .recurse_untracked_dirs(true)
            .show_untracked_content(true)
            .context_lines(3);
        let diff = repo
            .diff_tree_to_workdir(Some(&tree), Some(&mut opts))
            .map_err(|e| e.to_string())?;
        let mut out = String::new();
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
        .ok(); // el corte por callback es a proposito
        if truncated {
            out.push_str("\n… (diff truncado)\n");
        }
        if out.is_empty() {
            out = "(sin diferencias con el working tree actual)\n".into();
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// El diff del checkpoint como archivo .patch en el cache (para el visor —
/// mismo patron que gitmirror::git_commit_file). Devuelve la ruta.
#[tauri::command]
pub async fn checkpoint_diff_file(root: String, id: String) -> Result<String, String> {
    let text = checkpoint_diff(root, id.clone()).await?;
    let dir = crate::config::cache_dir().join("commits");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("checkpoint-{id}.patch"));
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Regresa el WORKING TREE a la foto. Solo-conversacional (verbo de gate).
/// Antes de tocar nada se captura "pre-restore" (el restore es deshacible).
/// El index queda alineado al HEAD (reset mixed) para que `git status` cuente
/// la verdad: diferencias honestas workdir-vs-HEAD, nada "staged" fantasma.
#[tauri::command]
pub async fn checkpoint_restore(root: String, id: String) -> Result<CheckpointInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = open(&root)?;
        let oid = find_by_id(&repo, &id)?;
        let (pre, _) = capture(&repo, "pre-restore")?;

        let obj = repo.find_object(oid, None).map_err(|e| e.to_string())?;
        let tree_obj = obj
            .peel(git2::ObjectType::Tree)
            .map_err(|e| e.to_string())?;
        let mut co = git2::build::CheckoutBuilder::new();
        co.force().remove_untracked(true); // untracked POST-foto se van; ignored quedan
        repo.checkout_tree(&tree_obj, Some(&mut co))
            .map_err(|e| e.to_string())?;
        // checkout_tree tambien escribio el index → devolverlo al HEAD
        if let Ok(head) = repo.head().and_then(|h| h.peel_to_commit()) {
            repo.reset(head.as_object(), git2::ResetType::Mixed, None)
                .map_err(|e| e.to_string())?;
        }
        Ok(CheckpointInfo {
            id: short(oid),
            label: format!("restaurado (deshacer: {})", short(pre)),
            time: 0,
            files: 0,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitmirror::tests::{commit_file, make_repo};

    #[test]
    fn capture_no_ensucia_index_ni_working_tree() {
        let (dir, repo) = make_repo("cp-limpio");
        commit_file(&repo, "a.txt", "uno", "c1");
        // estado sucio a proposito: modificado + untracked + staged
        std::fs::write(dir.join("a.txt"), "dos").unwrap();
        std::fs::write(dir.join("nuevo.txt"), "hola").unwrap();
        std::fs::write(dir.join("staged.txt"), "s").unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("staged.txt")).unwrap();
        idx.write().unwrap();

        let index_bytes = std::fs::read(dir.join(".git/index")).unwrap();
        let statuses_antes: Vec<(String, git2::Status)> = repo
            .statuses(None)
            .unwrap()
            .iter()
            .map(|e| (e.path().unwrap().to_string(), e.status()))
            .collect();

        let (oid, files) = capture(&repo, "prueba").unwrap();
        assert!(files >= 3, "la foto vio los 3 archivos ({files})");

        // el index EN DISCO no cambio ni un byte; los statuses tampoco
        assert_eq!(index_bytes, std::fs::read(dir.join(".git/index")).unwrap());
        let statuses_despues: Vec<(String, git2::Status)> = repo
            .statuses(None)
            .unwrap()
            .iter()
            .map(|e| (e.path().unwrap().to_string(), e.status()))
            .collect();
        assert_eq!(statuses_antes, statuses_despues);
        // y el working tree tampoco
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "dos");

        // la foto SI contiene el contenido sucio
        let tree = repo.find_commit(oid).unwrap().tree().unwrap();
        assert!(tree.get_name("nuevo.txt").is_some());

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn restore_regresa_el_working_tree_y_es_deshacible() {
        let (dir, repo) = make_repo("cp-restore");
        commit_file(&repo, "a.txt", "base", "c1");
        std::fs::write(dir.join("a.txt"), "version-foto").unwrap();
        std::fs::write(dir.join("extra.txt"), "existia").unwrap();
        let (foto, _) = capture(&repo, "foto").unwrap();

        // el "agente" sigue trabajando: cambia a.txt, borra extra, crea post
        std::fs::write(dir.join("a.txt"), "arruinado").unwrap();
        std::fs::remove_file(dir.join("extra.txt")).unwrap();
        std::fs::write(dir.join("post.txt"), "nacio despues").unwrap();

        let root = dir.to_string_lossy().to_string();
        tauri::async_runtime::block_on(checkpoint_restore(root, short(foto))).unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "version-foto"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("extra.txt")).unwrap(),
            "existia"
        );
        assert!(
            !dir.join("post.txt").exists(),
            "untracked post-foto se retira"
        );
        // el restore dejo un pre-restore para deshacer (foto + pre-restore)
        let labels: Vec<String> = refs_sorted(&repo)
            .iter()
            .filter_map(|(_, oid, _)| repo.find_commit(*oid).ok())
            .map(|c| c.message().unwrap_or("").trim().to_string())
            .collect();
        assert!(labels.contains(&"pre-restore".to_string()));

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn namespace_fuera_de_las_refspecs_de_push() {
        let (dir, repo) = make_repo("cp-refspec");
        commit_file(&repo, "a.txt", "uno", "c1");
        let (oid, _) = capture(&repo, "x").unwrap();
        let refname = format!("{NAMESPACE}/x-{}", short(oid));

        // la refspec por default de un remote normal (refs/heads/*) NO matchea
        let remote = repo
            .remote("origin", "https://example.invalid/r.git")
            .unwrap();
        let matchea = remote
            .refspecs()
            .any(|rs| rs.src_matches(&refname) || rs.src_matches(NAMESPACE));
        assert!(!matchea, "un push/fetch normal jamas toca {NAMESPACE}");

        // y la poda respeta KEEP
        for i in 0..3 {
            std::fs::write(dir.join("a.txt"), format!("v{i}")).unwrap();
            capture(&repo, &format!("cp{i}")).unwrap();
        }
        assert!(refs_sorted(&repo).len() <= KEEP);

        std::fs::remove_dir_all(dir).ok();
    }
}

#[cfg(test)]
mod tests_anidados {
    use super::*;
    use crate::gitmirror::tests::{commit_file, make_repo};

    /// business-os en vivo (29 jul): un clon git EMBEBIDO dentro del repo
    /// rompia capture con "invalid path; class=Index". Se salta, no se muere.
    #[test]
    fn capture_salta_repos_anidados() {
        let (dir, repo) = make_repo("cp-anidado");
        commit_file(&repo, "a.txt", "uno", "c1");
        // repo embebido (sin registrar como submodule — el caso que truena)
        let inner = dir.join("apps/clon-embebido");
        std::fs::create_dir_all(&inner).unwrap();
        git2::Repository::init(&inner).unwrap();
        std::fs::write(inner.join("suyo.txt"), "del anidado").unwrap();
        std::fs::write(dir.join("mio.txt"), "de este repo").unwrap();

        let (oid, _) = capture(&repo, "con anidado").unwrap();
        let tree = repo.find_commit(oid).unwrap().tree().unwrap();
        assert!(tree.get_name("mio.txt").is_some(), "lo propio SI entra");
        assert!(tree.get_name("apps").is_none(), "el repo anidado NO entra");

        std::fs::remove_dir_all(dir).ok();
    }
}
