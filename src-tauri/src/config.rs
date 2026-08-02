use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub struct ConfigState {
    pub watcher: Mutex<Option<RecommendedWatcher>>,
}

/// Configuración editable por el usuario. En Windows vive en AppData/Roaming;
/// el estado ligado a la máquina se separa en `state_dir` (AppData/Local).
///
/// `SFTERM_CONFIG_DIR` la redirige COMPLETA. Existe por el banco de pruebas:
/// una instancia aislada (dev o E2E) necesita su propio gate y su propio daemon
/// sin rozar los de la instancia que tiene las conversaciones reales abiertas.
/// La logica vive en `config_dir_from` (pura) para poder testearla sin pelearse
/// con el env global del proceso de tests.
pub fn config_dir() -> PathBuf {
    config_dir_from(std::env::var("SFTERM_CONFIG_DIR").ok().as_deref())
}

fn override_dir(override_value: Option<&str>) -> Option<PathBuf> {
    let value = override_value?.trim();
    (!value.is_empty()).then(|| PathBuf::from(crate::pty::expand_tilde(value)))
}

pub fn config_dir_from(override_dir: Option<&str>) -> PathBuf {
    if let Some(path) = self::override_dir(override_dir) {
        return path;
    }
    #[cfg(target_os = "windows")]
    {
        dirs::config_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_default()
            .join("SFTerm")
    }
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir()
            .unwrap_or_default()
            .join(".config")
            .join("sfterm")
    }
}

/// Estado persistente pero específico de esta máquina: sesión, adjuntos,
/// gate, logs y runtime. El override de pruebas conserva una sola raíz.
pub fn state_dir() -> PathBuf {
    if let Some(path) = override_dir(std::env::var("SFTERM_CONFIG_DIR").ok().as_deref()) {
        return path;
    }
    #[cfg(target_os = "windows")]
    {
        dirs::data_local_dir()
            .or_else(dirs::config_dir)
            .or_else(dirs::home_dir)
            .unwrap_or_default()
            .join("SFTerm")
    }
    #[cfg(target_os = "macos")]
    {
        config_dir()
    }
}

/// Artefactos regenerables: perfiles inyectados y documentos de preview.
pub fn cache_dir() -> PathBuf {
    if override_dir(std::env::var("SFTERM_CONFIG_DIR").ok().as_deref()).is_some() {
        return state_dir();
    }
    #[cfg(target_os = "windows")]
    {
        state_dir().join("cache")
    }
    #[cfg(target_os = "macos")]
    {
        config_dir()
    }
}

pub fn config_file() -> PathBuf {
    config_dir().join("config.toml")
}

/// Migra la disposición Windows provisional (`~/.config/sfterm`) sin
/// sobrescribir destinos. `rename` evita duplicar; si cruza volúmenes se copia,
/// se verifica el tamaño y solo entonces se elimina el origen.
#[cfg(target_os = "windows")]
pub fn migrate_legacy_layout() -> Result<(), String> {
    if override_dir(std::env::var("SFTERM_CONFIG_DIR").ok().as_deref()).is_some() {
        return Ok(());
    }
    let legacy = dirs::home_dir()
        .unwrap_or_default()
        .join(".config")
        .join("sfterm");
    migrate_legacy_layout_from(&legacy, &config_dir(), &state_dir(), &cache_dir())
        .map_err(|error| format!("migración de {legacy:?}: {error}"))
}

#[cfg(target_os = "macos")]
pub fn migrate_legacy_layout() -> Result<(), String> {
    Ok(())
}

fn migrate_legacy_layout_from(
    legacy: &std::path::Path,
    config: &std::path::Path,
    state: &std::path::Path,
    cache: &std::path::Path,
) -> std::io::Result<()> {
    if !legacy.is_dir() || legacy == config || legacy == state {
        return Ok(());
    }
    for entry in std::fs::read_dir(legacy)? {
        let entry = entry?;
        let name = entry.file_name();
        let target_root = match name.to_string_lossy().as_ref() {
            "config.toml" | "nervio.env" => config,
            "shell" | "commits" => cache,
            _ => state,
        };
        move_without_overwrite(&entry.path(), &target_root.join(&name))?;
    }
    let _ = std::fs::remove_dir(legacy);
    Ok(())
}

fn move_without_overwrite(
    source: &std::path::Path,
    target: &std::path::Path,
) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(source)?;
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::other(format!(
            "no se migra el enlace simbólico {}",
            source.display()
        )));
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(target)?;
        for child in std::fs::read_dir(source)? {
            let child = child?;
            move_without_overwrite(&child.path(), &target.join(child.file_name()))?;
        }
        let _ = std::fs::remove_dir(source);
        return Ok(());
    }
    if target.exists() {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::rename(source, target).is_ok() {
        return Ok(());
    }
    let mut input = std::fs::File::open(source)?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    let copied = match std::io::copy(&mut input, &mut output) {
        Ok(copied) => copied,
        Err(error) => {
            drop(output);
            let _ = std::fs::remove_file(target);
            return Err(error);
        }
    };
    if let Err(error) = output.sync_all() {
        drop(output);
        let _ = std::fs::remove_file(target);
        return Err(error);
    }
    drop(output);
    let target_len = match std::fs::metadata(target) {
        Ok(target_metadata) => target_metadata.len(),
        Err(error) => {
            let _ = std::fs::remove_file(target);
            return Err(error);
        }
    };
    if copied != metadata.len() || target_len != metadata.len() {
        let _ = std::fs::remove_file(target);
        return Err(std::io::Error::other("copia de migración incompleta"));
    }
    std::fs::remove_file(source)
}

#[cfg(test)]
mod config_dir_tests {
    use super::config_dir_from;

    /// La redireccion es TODO-o-nada y sin sorpresas: vacia/espacios = default,
    /// ~ se expande (un banco lanzado a mano con "~/bench" no debe crear un
    /// directorio literal llamado "~").
    #[test]
    fn redireccion_del_config_dir() {
        let home = dirs::home_dir().unwrap();
        #[cfg(target_os = "windows")]
        let expected = dirs::config_dir().unwrap().join("SFTerm");
        #[cfg(target_os = "macos")]
        let expected = home.join(".config").join("sfterm");
        assert_eq!(config_dir_from(None), expected);
        assert_eq!(config_dir_from(Some("")), expected);
        assert_eq!(config_dir_from(Some("   ")), expected);
        assert_eq!(
            config_dir_from(Some("/tmp/sfterm-bench")),
            std::path::PathBuf::from("/tmp/sfterm-bench")
        );
        assert_eq!(
            config_dir_from(Some("~/bench-sfterm")),
            home.join("bench-sfterm")
        );
    }

    #[test]
    fn migracion_no_sobrescribe_y_separa_estado_de_cache() {
        let root = std::env::temp_dir().join(format!("sfterm-layout-{}", std::process::id()));
        let legacy = root.join("legacy");
        let config = root.join("roaming");
        let state = root.join("local");
        let cache = state.join("cache");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(legacy.join("gate")).unwrap();
        std::fs::create_dir_all(legacy.join("shell")).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        std::fs::write(legacy.join("config.toml"), "legacy").unwrap();
        std::fs::write(config.join("config.toml"), "nuevo").unwrap();
        std::fs::write(legacy.join("session.json"), "{}").unwrap();
        std::fs::write(legacy.join("gate").join("events.jsonl"), "evento").unwrap();
        std::fs::write(legacy.join("shell").join("profile.ps1"), "perfil").unwrap();

        super::migrate_legacy_layout_from(&legacy, &config, &state, &cache).unwrap();
        assert_eq!(
            std::fs::read_to_string(config.join("config.toml")).unwrap(),
            "nuevo"
        );
        assert_eq!(
            std::fs::read_to_string(legacy.join("config.toml")).unwrap(),
            "legacy"
        );
        assert!(state.join("session.json").is_file());
        assert!(state.join("gate").join("events.jsonl").is_file());
        assert!(cache.join("shell").join("profile.ps1").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }
}

const DEFAULT_CONFIG: &str = r##"# ============================================================
# SFTerm — config (FUENTE DE VERDAD)
# Editable por humanos y por agentes. Hot-reload al guardar.
# Docs del schema: CLAUDE.md en el repo de SFTerm.
# ============================================================

[general]
# Version del schema (migraciones automaticas; no tocar)
config_version = 7
# Interfaz de la app (se RECUERDA la ultima; switch en Configuracion → General):
#   "warp"  SOLO TERMINALES tipo Warp, agnostica de proveedor (claude, codex,
#           aider, cualquier CLI). El chat existe solo como LECTOR (espejo) de
#           la conversacion de una terminal: ⌃Tab / ⌘L la abre, Esc vuelve.
#   "full"  la interfaz completa chat+taller de Claude Code (todo lo construido)
app_mode = "warp"
# Preset que se monta al abrir la app en frio (sin sesion previa)
default_preset = "business-os"
# Comando de agente para "nueva conversacion" (Cmd+Opt+J y panes de presets con "agent")
agent_command = "claude --dangerously-skip-permissions"
# Restaurar la sesion anterior al abrir; el preset solo aplica en arranque frio
restore_session = true
# Daemon de PTYs (sfterm-ptyd): las conversaciones viven FUERA de la app y
# sobreviven a rebuilds/cierres — reabrir re-engancha donde estabas. false =
# modo clasico (los PTYs mueren con la app). Escape rapido: SFTERM_NO_DAEMON=1
daemon = true
# Superficie al abrir la app: "terminals" (el taller, default — decision de
# Daniel 20 jul: terminal-first, la TUI de claude es la cabina) o "chat".
# cmd+L alterna en vivo.
home = "terminals"
# Scrollback por terminal (lineas)
scrollback = 8000
# Shell integration (zsh/PowerShell): bloques comando+output (OSC 133), cwd en vivo (OSC 7).
# Alimenta los badges de bloques, el gate semantico y el re-run
shell_integration = true
# CLIs agenticos que el LECTOR (⌃Tab / ⌘L) reconoce. Se matchea en minusculas
# contra el nombre del proceso Y el titulo OSC: kimi corre bajo python, asi que
# su NOMBRE no sirve de candado pero su TITULO ("Kimi Code") si. Un shell pelado
# nunca abre el lector, diga lo que diga su titulo.
# Claude Code se espeja con su transcript (mensajes, tools, modelo, contexto);
# cualquier otro de esta lista se espeja con la PANTALLA de su terminal.
agent_procs = ["claude", "kimi", "codex", "aider", "gemini", "opencode", "cursor-agent", "goose"]

[appearance]
theme = "arbrain"
# Fuente de la UI (arbol, titulos, barra): cualquier fuente instalada
ui_font = "Inter"
ui_font_size = 13
# Fuente de la TERMINAL: SOLO monospace (el grid del PTY exige ancho fijo)
terminal_font = "SF Mono"
# Tamaño BASE de la fuente de terminal (= al de la UI; el zoom de app agranda todo)
terminal_font_size = 13
# Padding interno de cada terminal (px)
terminal_padding = 10
# Opacidad de la ventana (0.85 - 1.0)
opacity = 1.0
# Zoom de la APP completa estilo VSCode (UI + terminales). En vivo: cmd+= (o +),
# cmd+- y cmd+0 para reset. 1.0 = 100%, rango 0.6 - 2.0
zoom = 1.0
# Renderer de la terminal:
#   "dom"   xterm.js (default, estable)
#   "own"   MOTOR PROPIO: parser en Rust + canvas. Bloques comando+output con
#           exit/duracion + re-run ↻, scrollback fuera del webview
#   "webgl" xterm.js GPU — ROTO en WKWebView macOS 26.5 (xterm.js #5816)
# Aplica a terminales NUEVAS (las vivas conservan su renderer)
renderer = "dom"

# ---- Temas. Puedes agregar los tuyos: [themes.mitema] con las mismas llaves ----
# arbrain (DEFAULT): la paleta del dashboard Arbrain de Daniel — dark zinc
# profundo + morado de marca #8C27F1 (ink legible #A968F7) + oro #ff9101
[themes.arbrain]
bg = "#09090b"
bg_panel = "#131318"
bg_rail = "#0d0d10"
bg_status = "#08080a"
fg = "#f7f8f8"
fg_dim = "#a1a1aa"
accent = "#A968F7"
border = "#2a2a30"
cursor = "#A968F7"
selection = "#8C27F14d"
green = "#4ade80"
red = "#ff6b6b"
yellow = "#ffac3d"
ansi = [
  "#1a1a1f", "#ff6b6b", "#4ade80", "#ffac3d",
  "#82aaff", "#A968F7", "#7dd3fc", "#e4e4e7",
  "#52525b", "#ff8787", "#6ee7a0", "#ffc46b",
  "#a3c0ff", "#c39bfa", "#a5e3ff", "#ffffff",
]

[themes.titanium]
bg = "#0c0d10"
bg_panel = "#111318"
bg_rail = "#0e1013"
bg_status = "#0a0b0e"
fg = "#d7d9de"
fg_dim = "#8b8f98"
accent = "#ff9101"
border = "#22252c"
cursor = "#ff9101"
selection = "#33384455"
green = "#4ec96a"
red = "#ff5c57"
yellow = "#f3f99d"
# 16 colores ANSI de la terminal
ansi = [
  "#20232a", "#ff5c57", "#5af78e", "#f3f99d",
  "#57c7ff", "#ff6ac1", "#9aedfe", "#e5e5e5",
  "#6a6f7a", "#ff5c57", "#5af78e", "#f3f99d",
  "#57c7ff", "#ff6ac1", "#9aedfe", "#ffffff",
]

[themes.graphite]
bg = "#111214"
bg_panel = "#17181c"
bg_rail = "#131418"
bg_status = "#0e0f11"
fg = "#d4d6db"
fg_dim = "#8a8f99"
accent = "#4f9cf9"
border = "#26282e"
cursor = "#4f9cf9"
selection = "#2b3a5266"
green = "#3fb950"
red = "#f85149"
yellow = "#d29922"
ansi = [
  "#21232a", "#f85149", "#3fb950", "#d29922",
  "#58a6ff", "#bc8cff", "#39c5cf", "#e6e8ec",
  "#6e7681", "#ff7b72", "#56d364", "#e3b341",
  "#79c0ff", "#d2a8ff", "#56d4dd", "#ffffff",
]

[themes.midnight]
bg = "#0a0e1a"
bg_panel = "#0f1526"
bg_rail = "#0c111e"
bg_status = "#080b14"
fg = "#c8d3f5"
fg_dim = "#7a88b8"
accent = "#82aaff"
border = "#1e2745"
cursor = "#82aaff"
selection = "#2f3b6455"
green = "#c3e88d"
red = "#ff757f"
yellow = "#ffc777"
ansi = [
  "#1b1d2b", "#ff757f", "#c3e88d", "#ffc777",
  "#82aaff", "#c099ff", "#86e1fc", "#c8d3f5",
  "#444a73", "#ff8d94", "#c7fb6d", "#ffd8ab",
  "#9ab8ff", "#caabff", "#b2ebff", "#ffffff",
]

# paper: la paleta CLARA de Daniel — cream de papel + los MISMOS colores de
# marca que arbrain (morado #8C27F1 de acento, ambar #ff9101 rebajado a tonos
# legibles sobre claro). NO usar naranja generico: la marca es morado+ambar.
[themes.paper]
bg = "#f4f2ec"
bg_panel = "#fbfaf6"
bg_rail = "#efede6"
bg_status = "#e9e6de"
fg = "#2a2c31"
fg_dim = "#7a7d85"
accent = "#8C27F1"
border = "#d8d4c8"
cursor = "#8C27F1"
selection = "#8C27F126"
green = "#2e8b46"
red = "#c73c37"
yellow = "#c47a00"
ansi = [
  "#2a2c31", "#c73c37", "#2e8b46", "#c47a00",
  "#1a6fb5", "#8C27F1", "#12808a", "#e8e6e0",
  "#5c5f66", "#c73c37", "#2e8b46", "#d98a00",
  "#1a6fb5", "#9d3cf5", "#12808a", "#1a1b1e",
]

# ---- Atajos (remapeables). Formato: cmd/alt/shift/ctrl + tecla ----
[keys]
new_terminal = "cmd+j"            # terminal RAPIDA: drawer inferior estilo VSCode (cualquier superficie)
new_conversation = "cmd+alt+j"
chat = "cmd+l"                    # chat <-> taller (superficie)
new_chat = "cmd+n"                # conversacion nueva con agente (chat)
taller = "ctrl+tab"               # cambiar de vista: chat <-> terminal de la conversacion (una mano)
search_project = "cmd+shift+f"    # busqueda por contenido en el proyecto
shortcuts = "cmd+alt+s"           # panel de atajos (S de shortcuts; "/" es shift+7 en latam)
close_panel = "cmd+w"           # QUITA la pestaña de la vista; la conversacion sigue viva en el rail. Matarla de verdad = la ✕ del rail (29 jul: la pestaña dejo de matar)
toggle_tree = "cmd+b"
toggle_rail = "cmd+alt+b"
focus_left = "cmd+alt+arrowleft"
focus_right = "cmd+alt+arrowright"
focus_up = "cmd+alt+arrowup"
focus_down = "cmd+alt+arrowdown"
dock_panel = "cmd+d"
restore_last = "cmd+shift+d"
zoom_in = "cmd+="                 # cmd + "+"/"=" tambien funciona en cualquier layout
zoom_out = "cmd+-"
zoom_reset = "cmd+0"
select_all = "cmd+a"              # seleccionar todo el buffer de la terminal enfocada
composer = "cmd+i"                # composer: input de texto real hacia la terminal enfocada
search = "cmd+alt+f"             # buscar dentro de la terminal (se movio: ⌘F = fijar)
next_terminal = "alt+tab"         # siguiente TERMINAL, en el orden del rail (el manual incluido)
next_tab = "shift+tab"            # siguiente PESTAÑA del campo enfocado.
                                  # ⚠️ ⇧Tab tambien es del TUI de claude (ahi cicla los modos de
                                  # permiso), por eso solo se intercepta cuando el campo tiene 2+
                                  # pestañas: con una sola, la tecla se le deja al agente.
file_finder = "cmd+p"
palette = "cmd+k"
settings = "cmd+,"
reload_app = "cmd+r"              # relanzar la app (proceso nuevo → toma el build recien instalado)
toggle_markdown = "cmd+shift+m"
toggle_theme = "cmd+shift+t"       # alterna paleta papel ⇄ arbrain (claro ⇄ oscuro)
expand_leaf = "cmd+shift+e"        # el campo enfocado se queda con TODA la pantalla; otra vez, vuelve exacto

# ---- Presets agenticos: comandos auto-lanzados al abrir en frio ----
# panes: un campo por comando. "" = shell libre. "agent" = general.agent_command
# 1 pane = pantalla completa; 2-3 = lado a lado; 4+ = dos filas
# kickoff (opcional): comando de shell (cwd = root) cuyo stdout se manda como
# PRIMER prompt al primer pane "agent" cuando este listo. Ej:
#   kickoff = "cat .claude/now.md"   → el agente abre ya sabiendo que toca hoy
[[presets]]
name = "business-os"
root = "~/Developer/business-os"
panes = ["agent"]

[[presets]]
name = "software"
root = "~/Developer/software"
panes = ["agent"]
"##;

/// Lee el config como JSON (crea el default si no existe; migra/backfillea si hace falta).
#[tauri::command]
pub fn config_get() -> Result<serde_json::Value, String> {
    let path = config_file();
    if !path.exists() {
        std::fs::create_dir_all(config_dir()).map_err(|e| e.to_string())?;
        std::fs::write(&path, DEFAULT_CONFIG).map_err(|e| e.to_string())?;
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let migrated = migrate_config(&raw);
    let effective = if let Some(new_raw) = migrated {
        std::fs::write(&path, &new_raw).map_err(|e| e.to_string())?;
        new_raw
    } else {
        raw
    };
    toml::from_str::<serde_json::Value>(&effective)
        .map_err(|e| format!("config.toml invalido: {e}"))
}

/// Migracion v1->v2 + backfill de llaves faltantes (las del usuario GANAN).
/// Devuelve Some(nuevo_toml) solo si hubo cambios.
fn migrate_config(raw: &str) -> Option<String> {
    let mut doc: toml_edit::DocumentMut = raw.parse().ok()?;
    let default: toml_edit::DocumentMut = DEFAULT_CONFIG.parse().ok()?;
    let mut changed = false;

    let version = doc
        .get("general")
        .and_then(|g| g.get("config_version"))
        .and_then(|v| v.as_integer())
        .unwrap_or(1);

    if version < 2 {
        // v1 -> v2: solo se tocan valores que siguen siendo el DEFAULT de v1
        // (si el usuario los personalizo, se respetan).
        if let Some(a) = doc.get_mut("appearance").and_then(|i| i.as_table_mut()) {
            if a.get("terminal_font_size").and_then(|v| v.as_integer()) == Some(13) {
                a["terminal_font_size"] = toml_edit::value(15);
                changed = true;
            }
        }
        // presets identicos al default v1 -> default v2 (una terminal fullscreen)
        if let Some(presets) = doc
            .get_mut("presets")
            .and_then(|i| i.as_array_of_tables_mut())
        {
            for p in presets.iter_mut() {
                let name = p.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let panes: Vec<String> = p
                    .get("panes")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                let is_v1_default = (name == "business-os"
                    && panes == ["agent", "agent", "agent", ""])
                    || (name == "software" && panes == ["agent", ""]);
                if is_v1_default {
                    let mut arr = toml_edit::Array::new();
                    arr.push("agent");
                    p["panes"] = toml_edit::value(arr);
                    p.remove("layout");
                    changed = true;
                }
            }
        }
        // bindings muertos del grid fijo
        if let Some(keys) = doc.get_mut("keys").and_then(|i| i.as_table_mut()) {
            for k in ["split_1", "split_2", "split_3", "split_4", "split_6"] {
                if keys.remove(k).is_some() {
                    changed = true;
                }
            }
            // el atajo de settings se llamaba "appearance"
            if let Some(v) = keys.remove("appearance") {
                keys.insert("settings", v);
                changed = true;
            }
        }
        if let Some(g) = doc.get_mut("general").and_then(|i| i.as_table_mut()) {
            g["config_version"] = toml_edit::value(2);
            changed = true;
        }
    }

    if version < 3 {
        // v2 -> v3: la terminal usa el MISMO tamaño que la UI (13). Agrandar
        // es trabajo del zoom de app (cmd+/-). Solo si seguia en el default v2.
        if let Some(a) = doc.get_mut("appearance").and_then(|i| i.as_table_mut()) {
            if a.get("terminal_font_size").and_then(|v| v.as_integer()) == Some(15) {
                a["terminal_font_size"] = toml_edit::value(13);
                changed = true;
            }
        }
        if let Some(g) = doc.get_mut("general").and_then(|i| i.as_table_mut()) {
            g["config_version"] = toml_edit::value(3);
            changed = true;
        }
    }

    if version < 4 {
        // v3 -> v4: murieron cycle_next/cycle_prev (⌥Tab, pedido de Daniel
        // 20 jul) y search se movio a ⌘⌥F (⌘F = fijar; colisionaban y
        // "buscar en la terminal" estaba muerto por teclado). merge_missing
        // jamas borra ni corrige llaves existentes — por eso la migracion.
        if let Some(keys) = doc.get_mut("keys").and_then(|i| i.as_table_mut()) {
            for k in ["cycle_next", "cycle_prev"] {
                if keys.remove(k).is_some() {
                    changed = true;
                }
            }
            if keys.get("search").and_then(|v| v.as_str()) == Some("cmd+f") {
                keys["search"] = toml_edit::value("cmd+alt+f");
                changed = true;
            }
        }
        if let Some(g) = doc.get_mut("general").and_then(|i| i.as_table_mut()) {
            g["config_version"] = toml_edit::value(4);
            changed = true;
        }
    }

    if version < 5 {
        // v4 -> v5: ciclar fijadas paso de ⇧Tab (solo-chat) a ⌥Tab en AMBAS
        // superficies (pedido de Daniel 20 jul pm) — ⇧Tab vuelve integro a
        // la TUI de claude (permission modes).
        if let Some(keys) = doc.get_mut("keys").and_then(|i| i.as_table_mut()) {
            if keys.get("cycle_pinned").and_then(|v| v.as_str()) == Some("shift+tab") {
                keys["cycle_pinned"] = toml_edit::value("alt+tab");
                changed = true;
            }
        }
        if let Some(g) = doc.get_mut("general").and_then(|i| i.as_table_mut()) {
            g["config_version"] = toml_edit::value(5);
            changed = true;
        }
    }

    if version < 6 {
        // v5 -> v6: nace el MODO WARP (20 jul pm, decision de Daniel): la app
        // arranca como multiplexor de terminales agnostico de proveedor y la
        // interfaz completa de Claude Code queda detras del switch en
        // Configuracion. app_mode se RECUERDA (cada cambio se persiste).
        // merge_missing agrega la llave; aqui solo se sube la version.
        if let Some(g) = doc.get_mut("general").and_then(|i| i.as_table_mut()) {
            g["config_version"] = toml_edit::value(6);
            changed = true;
        }
    }

    if version < 7 {
        // v6 -> v7 (29 jul, pedido de Daniel): ⌥Tab deja de abrir el VISTAZO y
        // pasa a ciclar TERMINALES; ⇧Tab cicla PESTAÑAS. Aqui solo se BORRAN
        // las llaves muertas — `next_terminal`/`next_tab` los siembra
        // merge_missing desde el DEFAULT_CONFIG, que es su unica fuente.
        //
        // ⚠️ Borrarlas no es cosmetica: mientras `cycle_pinned = "alt+tab"`
        // siga escrito, el config le esta MINTIENDO a Daniel sobre lo que hace
        // esa tecla, y el config.toml es la fuente de verdad AI-first (la UI es
        // espejo). `pin_conversation` ya estaba muerta desde la purga del chat.
        if let Some(keys) = doc.get_mut("keys").and_then(|i| i.as_table_mut()) {
            for k in ["cycle_pinned", "pin_conversation"] {
                if keys.remove(k).is_some() {
                    changed = true;
                }
            }
        }
        if let Some(g) = doc.get_mut("general").and_then(|i| i.as_table_mut()) {
            g["config_version"] = toml_edit::value(7);
            changed = true;
        }
    }

    // backfill: llaves del default ausentes en el config del usuario
    // (temas nuevos, atajos nuevos, flags nuevos). Arrays (presets) NO se tocan.
    if merge_missing(doc.as_table_mut(), default.as_table()) {
        changed = true;
    }

    changed.then(|| doc.to_string())
}

fn merge_missing(user: &mut toml_edit::Table, def: &toml_edit::Table) -> bool {
    let mut changed = false;
    for (key, def_item) in def.iter() {
        match user.get_mut(key) {
            None => {
                // arrays-of-tables (presets) son data del usuario: no backfillear
                if !def_item.is_array_of_tables() {
                    user.insert(key, def_item.clone());
                    changed = true;
                }
            }
            Some(user_item) => {
                if let (Some(ut), Some(dt)) = (user_item.as_table_mut(), def_item.as_table()) {
                    if merge_missing(ut, dt) {
                        changed = true;
                    }
                }
            }
        }
    }
    changed
}

#[tauri::command]
pub fn config_path() -> String {
    config_file().to_string_lossy().to_string()
}

/// Escribe llaves puntuales (ej. "appearance.theme" = "titanium") PRESERVANDO
/// comentarios y formato del archivo (toml_edit). Es lo que usa el panel de apariencia.
#[tauri::command]
pub fn config_set(entries: Vec<(String, serde_json::Value)>) -> Result<(), String> {
    let path = config_file();
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut doc: toml_edit::DocumentMut = raw
        .parse()
        .map_err(|e: toml_edit::TomlError| e.to_string())?;
    for (dotted, val) in entries {
        let parts: Vec<&str> = dotted.split('.').collect();
        let item = json_to_toml_item(&val)?;
        match parts.as_slice() {
            [k] => {
                doc[k] = item;
            }
            [t, k] => {
                if doc.get(*t).is_none() {
                    doc[*t] = toml_edit::table();
                }
                doc[*t][*k] = item;
            }
            [t, u, k] => {
                if doc.get(*t).is_none() {
                    doc[*t] = toml_edit::table();
                }
                if doc[*t].get(*u).is_none() {
                    doc[*t][*u] = toml_edit::table();
                }
                doc[*t][*u][*k] = item;
            }
            _ => return Err(format!("path demasiado profundo: {dotted}")),
        }
    }
    std::fs::write(&path, doc.to_string()).map_err(|e| e.to_string())
}

fn json_to_toml_item(v: &serde_json::Value) -> Result<toml_edit::Item, String> {
    use toml_edit::value;
    Ok(match v {
        serde_json::Value::String(s) => value(s.clone()),
        serde_json::Value::Bool(b) => value(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                value(i)
            } else {
                value(n.as_f64().ok_or("numero invalido")?)
            }
        }
        _ => return Err("solo string/bool/number en config_set".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const V1_USER_CONFIG: &str = r##"
[general]
default_preset = "business-os"
agent_command = "claude --dangerously-skip-permissions"
restore_session = true
scrollback = 8000

[appearance]
theme = "titanium"
ui_font = "Inter"
ui_font_size = 13
terminal_font = "SF Mono"
terminal_font_size = 13
terminal_padding = 10
opacity = 1.0
renderer = "dom"

[themes.titanium]
bg = "#0c0d10"
bg_panel = "#111318"
bg_rail = "#0e1013"
bg_status = "#0a0b0e"
fg = "#d7d9de"
fg_dim = "#8b8f98"
accent = "#ff9101"
border = "#22252c"
cursor = "#ff9101"
selection = "#33384455"
green = "#4ec96a"
red = "#ff5c57"
yellow = "#f3f99d"
ansi = ["#20232a", "#ff5c57", "#5af78e", "#f3f99d", "#57c7ff", "#ff6ac1", "#9aedfe", "#e5e5e5", "#6a6f7a", "#ff5c57", "#5af78e", "#f3f99d", "#57c7ff", "#ff6ac1", "#9aedfe", "#ffffff"]

[keys]
new_terminal = "cmd+j"
split_1 = "cmd+1"
split_4 = "cmd+4"
appearance = "cmd+,"

[[presets]]
name = "business-os"
root = "~/Developer/business-os"
layout = 4
panes = ["agent", "agent", "agent", ""]

[[presets]]
name = "software"
root = "~/Developer/software"
layout = 2
panes = ["agent", ""]
"##;

    #[test]
    fn migra_v1_a_v2() {
        let out = migrate_config(V1_USER_CONFIG).expect("debe migrar");
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        // font default: v1 (13) -> v2 (15) -> v3 (13, mismo que la UI)
        assert_eq!(
            doc["appearance"]["terminal_font_size"].as_integer(),
            Some(13)
        );
        // preset default v1 -> una sola terminal agente
        let presets = doc["presets"].as_array_of_tables().unwrap();
        let first = presets.iter().next().unwrap();
        let panes: Vec<&str> = first["panes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(panes, vec!["agent"]);
        assert!(first.get("layout").is_none());
        // keys: split_* fuera, appearance -> settings, zoom backfilleado
        let keys = doc["keys"].as_table().unwrap();
        assert!(keys.get("split_1").is_none());
        assert!(keys.get("appearance").is_none());
        assert_eq!(keys["settings"].as_str(), Some("cmd+,"));
        assert_eq!(keys["zoom_in"].as_str(), Some("cmd+="));
        // temas nuevos backfilleados sin pisar el del usuario
        assert!(doc["themes"].get("graphite").is_some());
        assert!(doc["themes"].get("midnight").is_some());
        assert!(doc["themes"].get("arbrain").is_some());
        assert_eq!(
            doc["themes"]["titanium"]["accent"].as_str(),
            Some("#ff9101")
        );
        // el theme elegido por el usuario NO se pisa por el nuevo default
        assert_eq!(doc["appearance"]["theme"].as_str(), Some("titanium"));
        assert_eq!(doc["general"]["config_version"].as_integer(), Some(7));
        // v4: ⌥Tab muerto y ⌘F liberado para fijar (search → ⌘⌥F)
        assert!(keys.get("cycle_next").is_none());
        assert!(keys.get("cycle_prev").is_none());
        // v6: nace el modo warp (backfilleado por merge_missing)
        assert_eq!(doc["general"]["app_mode"].as_str(), Some("warp"));
        // v7: el vistazo murio y ⌥Tab pasa a ciclar terminales; ⇧Tab, pestañas.
        // (v5 habia movido `cycle_pinned` a alt+tab; v7 borra la llave entera)
        assert!(keys.get("cycle_pinned").is_none());
        assert_eq!(keys["next_terminal"].as_str(), Some("alt+tab"));
        assert_eq!(keys["next_tab"].as_str(), Some("shift+tab"));
    }

    #[test]
    fn migracion_idempotente() {
        let out = migrate_config(V1_USER_CONFIG).expect("primera pasada migra");
        assert!(
            migrate_config(&out).is_none(),
            "segunda pasada no cambia nada"
        );
    }

    #[test]
    fn migracion_v5_cycle_pinned() {
        // ⚠️ Este test cambio de sentido el 29 jul: `cycle_pinned` (el vistazo)
        // MURIO, asi que un config de v4 ya no termina con esa llave reescrita
        // sino SIN ella — el tramo v5 la movia a alt+tab y el v7 la borra. Se
        // conserva el caso porque lo que prueba sigue vivo: que un config
        // viejo atraviesa TODA la cadena de migraciones de una pasada.
        let v4 = r#"
[general]
config_version = 4

[keys]
cycle_pinned = "shift+tab"
"#;
        let out = migrate_config(v4).expect("migra v4 -> v7");
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert!(
            doc["keys"].get("cycle_pinned").is_none(),
            "el vistazo murio: la llave no puede sobrevivir a la cadena"
        );
        assert_eq!(doc["general"]["config_version"].as_integer(), Some(7));
        // y hereda los ciclados nuevos por backfill del DEFAULT_CONFIG
        assert_eq!(doc["keys"]["next_terminal"].as_str(), Some("alt+tab"));
        assert_eq!(doc["keys"]["next_tab"].as_str(), Some("shift+tab"));
    }

    #[test]
    fn migracion_v7_mueren_las_llaves_del_vistazo() {
        // El config VIVO de Daniel (v6) trae las dos llaves muertas: el vistazo
        // y la estrella de fijar, que murio con el chat nativo. Las dos se van
        // y entran los ciclados. Mientras `cycle_pinned = "alt+tab"` siga
        // escrito, el config le MIENTE sobre lo que hace esa tecla — y el
        // config.toml es la fuente de verdad AI-first, no un cache.
        let v6 = r#"
[general]
config_version = 6

[keys]
cycle_pinned = "alt+tab"
pin_conversation = "cmd+f"
composer = "cmd+i"
"#;
        let out = migrate_config(v6).expect("migra v6 -> v7");
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert!(doc["keys"].get("cycle_pinned").is_none());
        assert!(doc["keys"].get("pin_conversation").is_none());
        assert_eq!(doc["keys"]["next_terminal"].as_str(), Some("alt+tab"));
        assert_eq!(doc["keys"]["next_tab"].as_str(), Some("shift+tab"));
        assert_eq!(doc["general"]["config_version"].as_integer(), Some(7));
        // lo que Daniel remapeo a mano NO se toca
        assert_eq!(doc["keys"]["composer"].as_str(), Some("cmd+i"));
    }

    #[test]
    fn migracion_v7_respeta_un_remapeo_del_usuario() {
        // si ya se habia remapeado el ciclado, el backfill no lo pisa
        let v6 = r#"
[general]
config_version = 6

[keys]
next_terminal = "cmd+alt+n"
"#;
        let out = migrate_config(v6).expect("sube version");
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["keys"]["next_terminal"].as_str(), Some("cmd+alt+n"));
    }

    #[test]
    fn migracion_v6_app_mode() {
        // v5 sin app_mode: el backfill lo agrega como "warp" y la version sube
        let v5 = "[general]\nconfig_version = 5\n";
        let out = migrate_config(v5).expect("migra v5 -> v6");
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["general"]["app_mode"].as_str(), Some("warp"));
        assert_eq!(doc["general"]["config_version"].as_integer(), Some(7));
        // usuario que ya eligio la interfaz completa: se respeta
        let full = "[general]\nconfig_version = 5\napp_mode = \"full\"\n";
        let out2 = migrate_config(full).expect("sube version");
        let doc2: toml_edit::DocumentMut = out2.parse().unwrap();
        assert_eq!(doc2["general"]["app_mode"].as_str(), Some("full"));
    }

    #[test]
    fn respeta_valores_personalizados() {
        let custom = V1_USER_CONFIG
            .replace("terminal_font_size = 13", "terminal_font_size = 18")
            .replace(
                "panes = [\"agent\", \"agent\", \"agent\", \"\"]",
                "panes = [\"agent\", \"vim\"]",
            );
        let out = migrate_config(&custom).expect("migra igual");
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(
            doc["appearance"]["terminal_font_size"].as_integer(),
            Some(18),
            "el tamaño custom del usuario se respeta"
        );
        let presets = doc["presets"].as_array_of_tables().unwrap();
        let first = presets.iter().next().unwrap();
        let panes: Vec<&str> = first["panes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(panes, vec!["agent", "vim"], "preset custom intacto");
    }

    #[test]
    fn default_config_ya_es_v3() {
        assert!(
            migrate_config(DEFAULT_CONFIG).is_none(),
            "el default no debe necesitar migracion"
        );
    }
}

/// Watcher de hot-reload: al cambiar config.toml emite config://changed con el JSON nuevo.
pub fn start_config_watcher(app: AppHandle) {
    let state = app.state::<ConfigState>();
    let app2 = app.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                let hits = event
                    .paths
                    .iter()
                    .any(|p| p.file_name().map(|f| f == "config.toml").unwrap_or(false));
                if hits {
                    // pequeño debounce: los editores escriben en rafagas
                    std::thread::sleep(std::time::Duration::from_millis(120));
                    if let Ok(cfg) = config_get() {
                        let _ = app2.emit("config://changed", cfg);
                    }
                }
            }
        })
        .ok();
    if let Some(w) = watcher.as_mut() {
        let _ = std::fs::create_dir_all(config_dir());
        let _ = w.watch(&config_dir(), RecursiveMode::NonRecursive);
    }
    *state.watcher.lock().unwrap() = watcher;
}
