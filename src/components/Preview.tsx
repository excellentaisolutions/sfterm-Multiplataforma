import { useEffect } from "react";
import { useStore } from "../core/store";
import * as ipc from "../core/ipc";

/** Preview del dev server: overlay con iframe (patron Reader/Chat, no toca el
 *  tiling ni la sesion). La UI solo MUESTRA: correr/parar el server es
 *  conversacion con el agente. Caveat: apps con X-Frame-Options no cargan en
 *  iframe → boton "abrir en navegador" siempre visible. */
export default function Preview() {
  const url = useStore((s) => s.ui.preview);

  useEffect(() => {
    if (!url) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        useStore.getState().setUI({ preview: null });
      }
    };
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, [url]);

  if (!url) return null;
  const close = () => useStore.getState().setUI({ preview: null });

  return (
    <div className="overlay-back" onClick={close}>
      <div className="preview-card" onClick={(e) => e.stopPropagation()}>
        <div className="preview-bar">
          <span className="preview-url" title={url}>{url}</span>
          <button className="tab" onClick={() => void ipc.openUrl(url)} title="Abrir en el navegador">
            navegador ↗
          </button>
          <button className="tab" onClick={close} title="Cerrar (Esc)">
            ✕
          </button>
        </div>
        <iframe className="preview-frame" src={url} title="dev preview" />
      </div>
    </div>
  );
}
