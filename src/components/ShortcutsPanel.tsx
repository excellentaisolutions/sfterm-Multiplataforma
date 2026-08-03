import { useEffect } from "react";
import { useStore } from "../core/store";
import { KEYBIND_GROUPS, fixedGestures, formatCombo, type KeybindAction } from "../core/keybinds";
import type { ShortcutPlatform } from "../core/keys";

/** Panel de atajos (⌘/) — el mapa completo del teclado, estilo VSCode.
 *  Solo lectura: para remapear esta el tab "Atajos" de Settings (⌘,).
 *  Fuente de verdad: config.toml [keys] (lo que el usuario remapeo manda);
 *  el censo de acciones + defaults vive en core/keybinds.ts (unica fuente,
 *  compartida con Settings para que nunca se desincronicen). */

export default function ShortcutsPanel() {
  const open = useStore((s) => s.ui.shortcuts);
  const keys = useStore((s) => s.config?.keys);
  const platform = (useStore((s) => s.capabilities?.os) ?? "macos") as ShortcutPlatform;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        useStore.getState().setUI({ shortcuts: false });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  const close = () => useStore.getState().setUI({ shortcuts: false });
  // undefined en config -> cae al default; "" explicito (desasignado desde
  // Settings) -> se oculta la fila, igual que antes.
  const bindingOf = (item: KeybindAction): string | null => {
    const raw = (keys as Record<string, string> | undefined)?.[item.action];
    const val = raw !== undefined ? raw : item.def;
    return val && val.trim() ? val : null;
  };

  return (
    <div className="overlay-back" onClick={close}>
      <div className="panel settings-card shortcuts-card" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-head">
          <b>Atajos de teclado</b>
          <span className="shortcuts-note">
            se remapean en Configuración → Atajos ({formatCombo("primary+,", platform)})
          </span>
          <button className="reader-btn" onClick={close} title="Cerrar (Esc)">✕</button>
        </div>
        <div className="shortcuts-cols">
          {KEYBIND_GROUPS.map((g) => {
            const rows = g.items
              .map((item) => ({ action: item.action, label: item.label, key: bindingOf(item) }))
              .filter((r) => r.key);
            if (!rows.length) return null;
            return (
              <section key={g.title} className="shortcuts-group">
                <h4>{g.title}</h4>
                {rows.map((r) => (
                  <div key={r.action} className="shortcuts-row">
                    <span className="shortcuts-label">{r.label}</span>
                    <kbd>{formatCombo(r.key!, platform)}</kbd>
                  </div>
                ))}
              </section>
            );
          })}
          <section className="shortcuts-group">
            <h4>Gestos</h4>
            {fixedGestures(platform).map(([k, label]) => (
              <div key={k} className="shortcuts-row">
                <span className="shortcuts-label">{label}</span>
                <kbd>{k}</kbd>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}
