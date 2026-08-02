use serde::Serialize;

#[derive(Serialize)]
pub struct FontLists {
    pub all: Vec<String>,
    pub mono: Vec<String>,
}

const MONO_PATTERNS: &[&str] = &[
    "mono",
    "menlo",
    "monaco",
    "courier",
    "consol",
    "code",
    "hack",
    "jetbrains",
    "cascadia",
    "fira",
    "inconsolata",
    "iosevka",
    "andale",
    "term",
    "victor",
    "geist mono",
    "berkeley",
    "commit",
    "spleen",
    "hasklig",
    "agave",
];

/// Enumera familias instaladas. `mono` = subconjunto que matchea patrones
/// conocidos de fuentes monospace (curado, no probabilistico).
#[tauri::command]
pub async fn fonts_list() -> Result<FontLists, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        let mut all = {
            let source = font_kit::source::SystemSource::new();
            source.all_families().map_err(|e| e.to_string())?
        };
        #[cfg(target_os = "windows")]
        let mut all = windows_font_families()?;
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

#[cfg(target_os = "windows")]
fn windows_font_families() -> Result<Vec<String>, String> {
    let output = std::process::Command::new("reg.exe")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let mut families = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some((name, _)) = line.split_once("REG_") else {
            continue;
        };
        let name = name
            .trim()
            .trim_end_matches("(TrueType)")
            .trim_end_matches("(OpenType)")
            .trim();
        for family in name
            .split('&')
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            families.push(family.to_string());
        }
    }
    Ok(families)
}
