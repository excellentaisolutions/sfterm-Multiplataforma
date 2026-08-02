use serde::Serialize;

#[derive(Serialize)]
pub struct FontLists {
    pub all: Vec<String>,
    pub mono: Vec<String>,
}

const MONO_PATTERNS: &[&str] = &[
    "mono", "menlo", "monaco", "courier", "consol", "code", "hack", "jetbrains",
    "cascadia", "fira", "inconsolata", "iosevka", "andale", "term", "victor",
    "geist mono", "berkeley", "commit", "spleen", "hasklig", "agave",
];

/// Enumera familias instaladas. `mono` = subconjunto que matchea patrones
/// conocidos de fuentes monospace (curado, no probabilistico).
#[tauri::command]
pub async fn fonts_list() -> Result<FontLists, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = font_kit::source::SystemSource::new();
        let mut all = source.all_families().map_err(|e| e.to_string())?;
        all.sort();
        all.dedup();
        let mono: Vec<String> = all
            .iter()
            .filter(|f| {
                let lf = f.to_lowercase();
                MONO_PATTERNS.iter().any(|p| lf.contains(p))
            })
            .cloned()
            .collect();
        Ok(FontLists { all, mono })
    })
    .await
    .map_err(|e| e.to_string())?
}
