import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useStore } from "../core/store";
import * as ipc from "../core/ipc";
import * as actions from "../core/actions";
import type { Theme } from "../core/types";
import {
  KEYBIND_GROUPS,
  fixedGestures,
  ACTION_LABEL,
  formatCombo,
  normalizeCombo,
  captureCombo,
  isSoftBlocked,
  setCapturingKeys,
  nativeShortcutText,
  type KeybindAction,
} from "../core/keybinds";
import type { ShortcutPlatform } from "../core/keys";

/** Panel de configuración 80/20 (⚙ del header / ⌘,). Vista delgada que ESCRIBE
 *  en config.toml (preservando comentarios); el hot-reload aplica el cambio.
 *  La UI es espejo: la fuente de verdad sigue siendo el archivo. */
export default function Settings() {
  const open = useStore((s) => s.ui.settings);
  const config = useStore((s) => s.config);
  const [fonts, setFonts] = useState<{ all: string[]; mono: string[] }>({ all: [], mono: [] });
  const [tab, setTab] = useState<"general" | "atajos" | "actualizaciones">("general");

  useEffect(() => {
    if (open) void ipc.fontsList().then(setFonts);
  }, [open]);

  if (!open || !config) return null;
  const close = () => useStore.getState().setUI({ settings: false });
  const a = config.appearance;
  const themes = Object.entries(config.themes ?? {});

  const set = (key: string, value: unknown) => void ipc.configSet([[`appearance.${key}`, value]]);

  const withCurrent = (list: string[], current: string) =>
    list.includes(current) ? list : [current, ...list];

  // fuentes UI sugeridas primero (las que Daniel pidio), luego el resto
  const uiFonts = (() => {
    const preferred = ["Inter", "Montserrat", "SF Pro", "Helvetica Neue"];
    const avail = fonts.all;
    const first = preferred.filter((f) => avail.includes(f) || f === a.ui_font);
    const rest = avail.filter((f) => !first.includes(f));
    return withCurrent([...first, ...rest], a.ui_font);
  })();

  return (
    <div className="overlay-back" onClick={close}>
      <div className="overlay-card settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h3>Configuración</h3>
          <button className="icon-btn" onClick={close} title="Cerrar (esc)">✕</button>
        </div>

        <div className="settings-tabs">
          <button className={`settings-tab ${tab === "general" ? "on" : ""}`} onClick={() => setTab("general")}>
            General
          </button>
          <button className={`settings-tab ${tab === "atajos" ? "on" : ""}`} onClick={() => setTab("atajos")}>
            Atajos
          </button>
          <button className={`settings-tab ${tab === "actualizaciones" ? "on" : ""}`} onClick={() => setTab("actualizaciones")}>
            Actualizaciones
          </button>
        </div>

        {tab === "general" && (
          <>
            <div className="settings-section">Paleta</div>
            <div className="theme-grid">
              {themes.map(([name, t]) => (
                <ThemeCard
                  key={name}
                  name={name}
                  theme={t}
                  active={a.theme === name}
                  onPick={() => set("theme", name)}
                />
              ))}
            </div>

            <div className="settings-section">Tipografía</div>
            <div className="appearance-row">
              <label>Terminal</label>
              <select value={a.terminal_font} onChange={(e) => set("terminal_font", e.target.value)}>
                {withCurrent(fonts.mono, a.terminal_font).map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="appearance-row">
              <label></label>
              <span className="note">solo monospace — el grid del PTY exige ancho fijo</span>
            </div>
            <div className="appearance-row">
              <label>Tamaño terminal</label>
              <input
                type="number" min={8} max={32} step={1} value={a.terminal_font_size}
                onChange={(e) => set("terminal_font_size", Number(e.target.value))}
              />
              <span className="note">{nativeShortcutText("⌘+ / ⌘− / ⌘0 en vivo")}</span>
            </div>
            <div className="appearance-row">
              <label>UI</label>
              <select value={a.ui_font} onChange={(e) => set("ui_font", e.target.value)}>
                {uiFonts.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="appearance-row">
              <label>Tamaño UI</label>
              <input
                type="number" min={10} max={20} step={0.5} value={a.ui_font_size}
                onChange={(e) => set("ui_font_size", Number(e.target.value))}
              />
            </div>
            <div className="appearance-row">
              <label>Padding terminal</label>
              <input
                type="number" min={0} max={40} step={1} value={a.terminal_padding}
                onChange={(e) => set("terminal_padding", Number(e.target.value))}
              />
            </div>

            <div className="appearance-foot">
              <span>Todo vive en</span>
              <code
                title="Abrir en el visor"
                onClick={async () => { close(); actions.openFileTab(await ipc.configPath()); }}
              >
                Abrir config.toml
              </code>
              <span>— también puedes pedírselo a tu agente.</span>
            </div>
          </>
        )}

        {tab === "atajos" && <AtajosTab keys={config.keys} />}
        {tab === "actualizaciones" && <ActualizacionesTab />}
      </div>
    </div>
  );
}

function ActualizacionesTab() {
  const [current, setCurrent] = useState("...");
  const [pending, setPending] = useState<ipc.UpdateMetadata | null>(null);
  const [status, setStatus] = useState("Listo para comprobar el canal estable.");
  const [busy, setBusy] = useState(false);
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    void getVersion().then(setCurrent).catch(() => setCurrent("desconocida"));
  }, []);

  const check = async () => {
    setBusy(true);
    setPending(null);
    setStatus("Comprobando firma y versión...");
    try {
      const update = await ipc.updateCheck();
      setPending(update);
      setStatus(update ? `Versión ${update.version} disponible.` : "SFTerm está actualizado.");
    } catch (error) {
      setStatus(`No se pudo consultar el canal: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    setBusy(true);
    setDownloaded(0);
    setTotal(null);
    setStatus("Descargando actualización firmada...");
    try {
      await ipc.updateInstall((event) => {
        if (event.event === "Started") setTotal(event.data.contentLength);
        if (event.event === "Progress") setDownloaded((value) => value + event.data.chunkLength);
        if (event.event === "Finished") setStatus("Descarga verificada; iniciando instalador...");
      });
      setStatus("Actualización instalada. SFTerm se cerrará para completar el cambio.");
    } catch (error) {
      setStatus(`La actualización no se instaló: ${String(error)}`);
      setBusy(false);
    }
  };

  const progress = total && total > 0 ? Math.min(100, Math.round(downloaded * 100 / total)) : null;

  return (
    <div className="updates-tab">
      <div className="settings-section">Canal estable</div>
      <div className="appearance-row">
        <label>Versión instalada</label>
        <code>{current}</code>
      </div>
      {pending && (
        <div className="appearance-row">
          <label>Versión disponible</label>
          <strong>{pending.version}</strong>
        </div>
      )}
      <div className="appearance-row">
        <label>Estado</label>
        <span className="note">{status}</span>
      </div>
      {progress !== null && (
        <div className="appearance-row">
          <label>Descarga</label>
          <progress value={progress} max={100}>{progress}%</progress>
          <span className="note">{progress}%</span>
        </div>
      )}
      <div className="appearance-row">
        <label></label>
        <button disabled={busy} onClick={() => void check()}>Comprobar ahora</button>
        {pending && <button disabled={busy} onClick={() => void install()}>Instalar y reiniciar</button>}
      </div>
      <div className="appearance-foot">
        Cada paquete se valida con la clave pública integrada antes de ejecutarse. Las terminales del daemon permanecen vivas durante el cambio.
      </div>
    </div>
  );
}

function ThemeCard(props: { name: string; theme: Theme; active: boolean; onPick: () => void }) {
  const { name, theme: t, active, onPick } = props;
  return (
    <div
      className={`theme-card ${active ? "active" : ""}`}
      style={{ background: t.bg, borderColor: active ? t.accent : t.border }}
      onClick={onPick}
      title={name}
    >
      <div className="tc-row">
        <span className="tc-dot" style={{ background: t.accent }} />
        <span className="tc-name" style={{ color: t.fg }}>{name}</span>
      </div>
      <div className="tc-line" style={{ background: t.fg_dim }} />
      <div className="tc-line short" style={{ background: t.border }} />
    </div>
  );
}

/** Pestaña "Atajos": censo completo (core/keybinds.ts) con edicion manual.
 *  Cada fila escribe con configSet("keys.<accion>", combo) — mismo patron
 *  sin-boton-guardar del resto de Settings; el hot-reload trae el valor
 *  nuevo de vuelta via config.keys y esta pestaña simplemente re-renderiza. */
function AtajosTab(props: { keys: Record<string, string> }) {
  const { keys } = props;
  const platform = (useStore((s) => s.capabilities?.os) ?? "macos") as ShortcutPlatform;
  // accion en modo captura (esperando el proximo keydown). null = nada escuchando.
  const [listening, setListening] = useState<string | null>(null);

  const bindingOf = (item: KeybindAction): string => {
    const raw = keys?.[item.action];
    return raw !== undefined ? raw : item.def;
  };

  // resuelto una sola vez por render: lo usan las filas para detectar duplicados
  const resolved: Record<string, string> = {};
  for (const g of KEYBIND_GROUPS) for (const item of g.items) resolved[item.action] = bindingOf(item);

  const collisionsOf = (action: string, combo: string): string[] => {
    if (!combo.trim()) return [];
    const norm = normalizeCombo(combo, platform);
    return Object.entries(resolved)
      .filter(([a, c]) => a !== action && c.trim() && normalizeCombo(c, platform) === norm)
      .map(([a]) => ACTION_LABEL[a] ?? a);
  };

  const save = (action: string, combo: string) => {
    void ipc.configSet([[`keys.${action}`, combo]]);
    setListening(null);
  };

  // escucha el proximo keydown mientras `listening` tenga una accion; Esc cancela
  // sin guardar. capture:true + stopPropagation para no chocar con el Esc global
  // del overlay (que cerraria todo el panel de Configuracion a medio remapeo).
  useEffect(() => {
    if (!listening) return;
    // flag global: el keymap de App NO despacha mientras capturamos (⌘W
    // cerraria un panel a media captura — stopPropagation no lo frena
    // porque los listeners del mismo target corren todos)
    setCapturingKeys(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setListening(null);
        return;
      }
      const combo = captureCombo(e, platform);
      if (combo) save(listening, combo);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      setCapturingKeys(false);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [listening, platform]);

  return (
    <div className="atajos-tab">
      {KEYBIND_GROUPS.map((g) => (
        <div key={g.title}>
          <div className="settings-section">{g.title}</div>
          {g.items.map((item) => {
            const combo = resolved[item.action];
            const isListening = listening === item.action;
            const collisions = isListening ? [] : collisionsOf(item.action, combo);
            const blocked = !isListening && isSoftBlocked(combo, platform);
            return (
              <div key={item.action} className={`keybind-row ${collisions.length ? "clash" : ""}`}>
                <span className="keybind-label">{item.label}</span>
                {collisions.length > 0 && (
                  <span className="keybind-warn clash">⚠ choca con "{collisions.join(", ")}"</span>
                )}
                {blocked && <span className="keybind-warn">⚠ este combo choca con la terminal</span>}
                <kbd className={`keybind-kbd ${isListening ? "listening" : ""}`}>
                  {isListening ? "pulsa el combo… Esc cancela" : formatCombo(combo, platform)}
                </kbd>
                <div className="keybind-actions">
                  <button
                    className="icon-btn keybind-btn"
                    title="Editar"
                    onClick={() => setListening(item.action)}
                  >
                    ✎
                  </button>
                  {combo !== item.def && (
                    <button
                      className="icon-btn keybind-btn"
                      title="Restaurar default"
                      onClick={() => save(item.action, item.def)}
                    >
                      ↺
                    </button>
                  )}
                  <button
                    className="icon-btn keybind-btn"
                    title="Desasignar"
                    onClick={() => save(item.action, "")}
                  >
                    ✕
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}

      <div className="settings-section">Gestos fijos</div>
      {fixedGestures(platform).map(([k, label]) => (
        <div key={k} className="keybind-row fixed">
          <span className="keybind-label">{label}</span>
          <kbd className="keybind-kbd readonly">{k}</kbd>
        </div>
      ))}
    </div>
  );
}
