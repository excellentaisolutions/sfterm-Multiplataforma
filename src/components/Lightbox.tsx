import { useEffect, useState, useSyncExternalStore } from "react";
import { lightbox } from "../core/images";
import * as ipc from "../core/ipc";
import { fileManagerLabel } from "../core/path-utils";

/** VISOR DE IMAGEN (26 jul 2026, pedido de Daniel: "poder cerrar las imagenes").
 *
 *  Una imagen que se abre desde el lector NO merece una pestaña del tiling: la
 *  miras dos segundos y la cierras. Por eso es un overlay con salida obvia —
 *  Esc, click fuera, o la ✕ — en vez de un tab que despues hay que ir a cerrar
 *  con ⌘W. Los archivos que NO son imagen siguen abriendo en el visor del
 *  taller, que es donde se leen de verdad.
 *
 *  Esc va en CAPTURA y frena la propagacion: con el lector abierto, su propio
 *  listener de Esc lo cerraria y saltariamos DOS pasos con una sola tecla.
 *  Mismo escalon que ya existe entre el drawer y el lector. */
export default function Lightbox() {
  const shot = useSyncExternalStore(lightbox.subscribe, lightbox.get, lightbox.get);
  const [zoom, setZoom] = useState(1);
  const fileManager = fileManagerLabel();

  useEffect(() => setZoom(1), [shot?.src]);

  useEffect(() => {
    if (!shot) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      lightbox.close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shot]);

  if (!shot) return null;

  return (
    <div className="lightbox-back" onClick={() => lightbox.close()}>
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="lightbox-name">{shot.alt ?? "imagen"}</span>
        {shot.path && (
          <button
            className="lightbox-btn"
            title={`Revelar en ${fileManager}`}
            onClick={() => void ipc.revealInFinder(shot.path!)}
          >
            {fileManager}
          </button>
        )}
        <button className="lightbox-btn" title="Cerrar (Esc)" onClick={() => lightbox.close()}>
          ✕
        </button>
      </div>
      <div
        className="lightbox-stage"
        onClick={(e) => {
          // click en la imagen = zoom; click en el fondo = cerrar (el back)
          e.stopPropagation();
          setZoom((z) => (z >= 3 ? 1 : z * 1.6));
        }}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          setZoom((z) => Math.min(8, Math.max(0.15, z * (e.deltaY < 0 ? 1.12 : 0.89))));
        }}
        title="Click: zoom · ⌘+scroll: zoom fino · Esc: cerrar"
      >
        <img src={shot.src} alt={shot.alt ?? ""} style={{ transform: `scale(${zoom})` }} />
      </div>
    </div>
  );
}
