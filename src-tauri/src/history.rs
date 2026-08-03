//! Historial multi-proveedor y lectura acotada de transcripts.
//!
//! Este modulo no ejecuta CLIs ni necesita credenciales: solo indexa los
//! artefactos locales de Codex y Kimi Code y devuelve una cola JSONL segura.
//! Claude conserva su indexador especializado en `hist.rs`.

use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug)]
pub struct ProviderSessionCard {
    pub sid: String,
    pub path: String,
    pub config_dir: Option<String>,
    pub cwd: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Serialize)]
pub struct TranscriptTail {
    pub content: String,
    pub truncated: bool,
}

fn home_root(env_name: &str, fallback: &str) -> PathBuf {
    std::env::var_os(env_name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_default().join(fallback))
}

fn mtime_ms(md: &std::fs::Metadata) -> u64 {
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cutoff_ms(days: f64) -> u64 {
    if days <= 0.0 {
        return 0;
    }
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
        .saturating_sub((days * 86_400_000.0) as u64)
}

fn read_prefix(path: &Path, cap: usize) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::with_capacity(cap);
    file.by_ref()
        .take(cap as u64)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn read_suffix(path: &Path, cap: usize) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(cap as u64);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    if start > 0 {
        if let Some(nl) = bytes.iter().position(|b| *b == b'\n') {
            bytes.drain(..=nl);
        }
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn short_title(raw: &str) -> Option<String> {
    let line = raw.lines().map(str::trim).find(|line| !line.is_empty())?;
    let mut out: String = line.chars().take(100).collect();
    if line.chars().count() > 100 {
        out.push('…');
    }
    Some(out)
}

fn walk_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            walk_jsonl(&path, out);
        } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "jsonl") {
            out.push(path);
        }
    }
}

fn codex_card(
    path: &Path,
    mtime_ms: u64,
    size: u64,
    config_dir: Option<String>,
) -> Option<ProviderSessionCard> {
    let head = read_prefix(path, 512 * 1024)?;
    let tail = read_suffix(path, 512 * 1024).unwrap_or_default();
    let mut sid = None;
    let mut cwd = None;
    let mut title = None;
    let mut model = None;

    for line in head.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let kind = v.get("type").and_then(Value::as_str);
        let payload = v.get("payload").unwrap_or(&Value::Null);
        if kind == Some("session_meta") {
            sid = payload
                .get("session_id")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
                .map(str::to_owned);
            cwd = payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(cwd);
        } else if kind == Some("turn_context") {
            model = payload
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(model);
            cwd = payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(cwd);
        } else if kind == Some("event_msg")
            && payload.get("type").and_then(Value::as_str) == Some("user_message")
            && title.is_none()
        {
            title = payload
                .get("message")
                .and_then(Value::as_str)
                .and_then(short_title);
        }
        if sid.is_some() && cwd.is_some() && title.is_some() {
            break;
        }
    }
    for line in tail.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(Value::as_str) == Some("turn_context") {
            if let Some(value) = v
                .get("payload")
                .and_then(|p| p.get("model"))
                .and_then(Value::as_str)
            {
                model = Some(value.to_owned());
            }
        }
    }
    let sid = sid.or_else(|| path.file_stem().map(|s| s.to_string_lossy().to_string()))?;
    Some(ProviderSessionCard {
        sid,
        path: path.to_string_lossy().to_string(),
        config_dir,
        cwd: cwd.unwrap_or_default(),
        title,
        model,
        mtime_ms,
        size,
    })
}

pub fn index_codex(root: &Path, days: f64, limit: usize) -> Vec<ProviderSessionCard> {
    let mut paths = Vec::new();
    walk_jsonl(&root.join("sessions"), &mut paths);
    let cut = cutoff_ms(days);
    let mut files: Vec<_> = paths
        .into_iter()
        .filter_map(|path| {
            let md = std::fs::metadata(&path).ok()?;
            let modified = mtime_ms(&md);
            (modified >= cut && md.len() > 0).then_some((modified, md.len(), path))
        })
        .collect();
    files.sort_by_key(|(modified, _, _)| std::cmp::Reverse(*modified));
    let default = dirs::home_dir().unwrap_or_default().join(".codex");
    let config_dir = (root != default).then(|| root.to_string_lossy().to_string());
    files
        .into_iter()
        .filter_map(|(modified, size, path)| codex_card(&path, modified, size, config_dir.clone()))
        .take(limit)
        .collect()
}

fn kimi_model(path: &Path) -> Option<String> {
    let tail = read_suffix(path, 512 * 1024)?;
    let mut found = None;
    for line in tail.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(Value::as_str) == Some("llm.request") {
            found = v
                .get("modelAlias")
                .or_else(|| v.get("model"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(found);
        } else if v.get("type").and_then(Value::as_str) == Some("usage.record") {
            found = v
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or(found);
        }
    }
    found
}

pub fn index_kimi(root: &Path, days: f64, limit: usize) -> Vec<ProviderSessionCard> {
    let index_path = root.join("session_index.jsonl");
    let Ok(raw) = std::fs::read_to_string(index_path) else {
        return Vec::new();
    };
    let sessions_root = root.join("sessions");
    let mut entries: HashMap<String, (PathBuf, String)> = HashMap::new();
    for line in raw.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(sid) = v.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        if v.get("deleted").and_then(Value::as_bool) == Some(true) {
            entries.remove(sid);
            continue;
        }
        let Some(dir) = v.get("sessionDir").and_then(Value::as_str) else {
            continue;
        };
        let cwd = v.get("workDir").and_then(Value::as_str).unwrap_or_default();
        entries.insert(sid.to_owned(), (PathBuf::from(dir), cwd.to_owned()));
    }
    let Ok(canonical_root) = std::fs::canonicalize(&sessions_root) else {
        return Vec::new();
    };
    let cut = cutoff_ms(days);
    let mut cards = Vec::new();
    for (sid, (dir, indexed_cwd)) in entries {
        if dir.file_name().and_then(|s| s.to_str()) != Some(sid.as_str()) {
            continue;
        }
        let Ok(actual) = std::fs::canonicalize(&dir) else {
            continue;
        };
        if !actual.starts_with(&canonical_root) {
            continue;
        }
        let path = dir.join("agents").join("main").join("wire.jsonl");
        let Ok(md) = std::fs::metadata(&path) else {
            continue;
        };
        let modified = mtime_ms(&md);
        if modified < cut {
            continue;
        }
        let state = std::fs::read_to_string(dir.join("state.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .unwrap_or(Value::Null);
        let title = state
            .get("title")
            .or_else(|| state.get("lastPrompt"))
            .and_then(Value::as_str)
            .and_then(short_title);
        let cwd = state
            .get("workDir")
            .or_else(|| state.get("custom").and_then(|c| c.get("cwd")))
            .and_then(Value::as_str)
            .unwrap_or(&indexed_cwd)
            .to_owned();
        cards.push(ProviderSessionCard {
            sid,
            path: path.to_string_lossy().to_string(),
            config_dir: Some(root.to_string_lossy().to_string()),
            cwd,
            title,
            model: kimi_model(&path),
            mtime_ms: modified,
            size: md.len(),
        });
    }
    cards.sort_by_key(|card| std::cmp::Reverse(card.mtime_ms));
    cards.truncate(limit);
    cards
}

#[tauri::command]
pub fn codex_sessions_index(days: Option<f64>, limit: Option<usize>) -> Vec<ProviderSessionCard> {
    index_codex(
        &home_root("CODEX_HOME", ".codex"),
        days.unwrap_or(90.0),
        limit.unwrap_or(250),
    )
}

#[tauri::command]
pub fn kimi_sessions_index(days: Option<f64>, limit: Option<usize>) -> Vec<ProviderSessionCard> {
    index_kimi(
        &home_root("KIMI_CODE_HOME", ".kimi-code"),
        days.unwrap_or(90.0),
        limit.unwrap_or(250),
    )
}

fn strip_large_data(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if map
                .get("data")
                .and_then(Value::as_str)
                .is_some_and(|s| s.len() >= 200)
            {
                map.insert("data".to_owned(), Value::String(String::new()));
            }
            for child in map.values_mut() {
                strip_large_data(child);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(strip_large_data),
        _ => {}
    }
}

pub fn read_transcript_tail(path: &Path, max_bytes: usize) -> Result<TranscriptTail, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("no se pudo abrir el transcript: {e}"))?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(max_bytes as u64);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let truncated = start > 0;
    if truncated {
        if let Some(nl) = bytes.iter().position(|b| *b == b'\n') {
            bytes.drain(..=nl);
        }
    }
    let raw = String::from_utf8_lossy(&bytes);
    let mut lines = Vec::new();
    for line in raw.lines() {
        if let Ok(mut value) = serde_json::from_str::<Value>(line) {
            strip_large_data(&mut value);
            lines.push(serde_json::to_string(&value).map_err(|e| e.to_string())?);
        } else {
            lines.push(line.to_owned());
        }
    }
    Ok(TranscriptTail {
        content: lines.join("\n"),
        truncated,
    })
}

#[tauri::command]
pub async fn transcript_tail(
    path: String,
    max_bytes: Option<usize>,
) -> Result<TranscriptTail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_transcript_tail(
            Path::new(&path),
            max_bytes
                .unwrap_or(4_000_000)
                .clamp(64 * 1024, 16 * 1024 * 1024),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("winterm-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn tail_es_multiplataforma_y_elimina_base64() {
        let path = std::env::temp_dir().join(format!("winterm-tail-{}.jsonl", std::process::id()));
        let image = "a".repeat(500);
        std::fs::write(&path, format!("{{\"type\":\"user\",\"data\":\"{image}\"}}\n{{\"type\":\"assistant\",\"text\":\"ok\"}}\n")).unwrap();
        let tail = read_transcript_tail(&path, 64 * 1024).unwrap();
        assert!(!tail.truncated);
        assert!(!tail.content.contains(&image));
        assert!(tail.content.contains("\"data\":\"\""));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn indexa_codex_con_identidad_modelo_y_cwd() {
        let root = temp_root("codex");
        let dir = root.join("sessions").join("2026").join("08").join("03");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout-test.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"thread-test\",\"cwd\":\"/work\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"crear una prueba\"}}\n",
                "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-test\"}}\n"
            ),
        )
        .unwrap();
        let cards = index_codex(&root, 0.0, 10);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].sid, "thread-test");
        assert_eq!(cards[0].cwd, "/work");
        assert_eq!(cards[0].title.as_deref(), Some("crear una prueba"));
        assert_eq!(cards[0].model.as_deref(), Some("gpt-test"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn indexa_kimi_desde_su_indice_oficial() {
        let root = temp_root("kimi");
        let session = root.join("sessions").join("wd-test").join("session-test");
        let agent = session.join("agents").join("main");
        std::fs::create_dir_all(&agent).unwrap();
        std::fs::write(
            root.join("session_index.jsonl"),
            format!(
                "{{\"sessionId\":\"session-test\",\"sessionDir\":{},\"workDir\":\"/work\"}}\n",
                serde_json::to_string(&session.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        std::fs::write(
            session.join("state.json"),
            "{\"title\":\"sesion Kimi\",\"workDir\":\"/work\"}",
        )
        .unwrap();
        std::fs::write(
            agent.join("wire.jsonl"),
            "{\"type\":\"llm.request\",\"model\":\"provider/model\",\"modelAlias\":\"k3\"}\n",
        )
        .unwrap();
        let cards = index_kimi(&root, 0.0, 10);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].sid, "session-test");
        assert_eq!(cards[0].title.as_deref(), Some("sesion Kimi"));
        assert_eq!(cards[0].model.as_deref(), Some("k3"));
        let _ = std::fs::remove_dir_all(root);
    }
}
