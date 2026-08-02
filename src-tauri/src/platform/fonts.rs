#[cfg(target_os = "macos")]
pub fn installed_families() -> Result<Vec<String>, String> {
    let source = font_kit::source::SystemSource::new();
    source.all_families().map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
pub fn installed_families() -> Result<Vec<String>, String> {
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
        families.extend(
            name.split('&')
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_owned),
        );
    }
    Ok(families)
}
