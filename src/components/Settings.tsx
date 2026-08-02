import { useEffect, useState } from "react";
import { useStore } from "../core/store";
import * as ipc from "../core/ipc";
import * as actions from "../core/actions";
import type { Theme } from "../core/types";
import {
  KEYBIND_GROUPS,
  FIXED_GESTURES,
  ACTION_LABEL,
  formatCombo,
  normalizeCombo,
  captureCombo,
  isSoftBlocked,
  setCapturingKeys,
  type KeybindAction,
} from "../core/keybinds";

/** Panel de configuración 80/20 (⚙ del header / ⌘,). Vista delgada que ESCRIBE
 *  en config.toml (preservando comentarios); el hot-reload aplica el cambio.
 *  La UI es espejo: la fuente de verdad sigue siendo el archivo. */
export default function Settings() {
  const open = useStore((s) => s.ui.settings);
  const config = useStore((s) => s.config);
  const [fonts, setFonts] = useState<{ all: string[]; mono: string[] }>({ all: [], mono: [] });
  const [tab, setTab] = useState<"general" | "atajos">("general");

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
              <span className="note">⌘+ / ⌘− / ⌘0 en vivo</span>
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
                ~/.config/sfterm/config.toml
              </code>
              <span>— también puedes pedírselo a tu agente.</span>
            </div>
          </>
        )}

        {tab === "atajos" && <AtajosTab keys={config.keys} />}
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
    const norm = normalizeCombo(combo);
    return Object.entries(resolved)
      .filter(([a, c]) => a !== action && c.trim() && normalizeCombo(c) === norm)
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
      const combo = captureCombo(e);
      if (combo) save(listening, combo);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      setCapturingKeys(false);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [listening]);

  return (
    <div className="atajos-tab">
      {KEYBIND_GROUPS.map((g) => (
        <div key={g.title}>
          <div className="settings-section">{g.title}</div>
          {g.items.map((item) => {
            const combo = resolved[item.action];
            const isListening = listening === item.action;
            const collisions = isListening ? [] : collisionsOf(item.action, combo);
            const blocked = !isListening && isSoftBlocked(combo);
            return (
              <div key={item.action} className={`keybind-row ${collisions.length ? "clash" : ""}`}>
                <span className="keybind-label">{item.label}</span>
                {collisions.length > 0 && (
                  <span className="keybind-warn clash">⚠ choca con "{collisions.join(", ")}"</span>
                )}
                {blocked && <span className="keybind-warn">⚠ este combo choca con la terminal</span>}
                <kbd className={`keybind-kbd ${isListening ? "listening" : ""}`}>
                  {isListening ? "pulsa el combo… Esc cancela" : formatCombo(combo)}
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
      {FIXED_GESTURES.map(([k, label]) => (
        <div key={k} className="keybind-row fixed">
          <span className="keybind-label">{label}</span>
          <kbd className="keybind-kbd readonly">{k}</kbd>
        </div>
      ))}
    </div>
  );
}
