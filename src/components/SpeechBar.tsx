import { useSyncExternalStore } from "react";
import { readerSpeech, type SpeechState } from "../core/reader-speech";

const INACTIVE: SpeechState = { active: false, paused: false, rate: 1, idx: 0, total: 0 };

/** Barra de lectura por voz (progreso por parrafos + controles), compartida
 *  por Reader y ChatView. SIEMPRE montada, se oculta por CSS: montarla a media
 *  lectura re-setea el innerHTML del documento (React 19) y mata los nodos
 *  que el TTS tiene colectados. */
export default function SpeechBar() {
  const speech = useSyncExternalStore(
    (cb) => readerSpeech.subscribe(cb),
    () => readerSpeech.getState(),
    () => INACTIVE,
  );
  const fmtRate = (r: number) => r.toFixed(2).replace(/\.?0+$/, "") + "x";

  return (
    <div className="reader-speechbar" style={{ display: speech.active ? undefined : "none" }}>
      {/* sin rallito de progreso (pedido de Daniel 21 jul): el conteo basta */}
      <div className="reader-progress">
        <span className="reader-prognum">{speech.idx + 1}/{speech.total}</span>
        <span className="reader-proglabel">párrafo</span>
      </div>
      <div className="reader-controls">
        <button className="reader-btn" onClick={() => readerSpeech.cycleRate()} title="Velocidad">
          {fmtRate(speech.rate)}
        </button>
        <button className="reader-btn" onClick={() => readerSpeech.prev()} title="Párrafo anterior (←)">
          ⏮
        </button>
        <button
          className="reader-btn play"
          onClick={() => readerSpeech.pauseResume()}
          title={speech.paused ? "Reanudar (Espacio)" : "Pausar (Espacio)"}
        >
          {speech.paused ? "▶" : "⏸"}
        </button>
        <button className="reader-btn" onClick={() => readerSpeech.next()} title="Párrafo siguiente (→)">
          ⏭
        </button>
        <button className="reader-btn" onClick={() => readerSpeech.stop()} title="Cerrar lectura">
          ✕
        </button>
      </div>
    </div>
  );
}
