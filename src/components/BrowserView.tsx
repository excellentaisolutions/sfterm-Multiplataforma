import { useEffect, useRef, useState } from "react";
import { useStore } from "../core/store";
import * as ipc from "../core/ipc";
import * as pick from "../core/pick";
import * as findpage from "../core/findpage";
import { loadHist, pushHist } from "../core/bhistory";
import * as autofit from "../core/autofit";
import * as T from "../core/tiling";
import { pathBasename } from "../core/path-utils";

/** Chrome del NAVEGADOR DEL AGENTE (F1). El contenido NO es un iframe: es un
 *  WKWebView NATIVO (browser.rs) que Tiling posiciona DEBAJO de esta barra
 *  (mismo patron imperativo que el term-pool — nada vivo dentro de React).
 *  AI-first: el agente navega por el gate; esta barra es el espejo para que
 *  Daniel tambien pueda (url/omnibox, atras/adelante, historial, ⊹, 📱,
 *  badge de salud) — y las filas extra (dialogos JS, find, descargas) crecen
 *  DEBAJO: Tiling les abre espacio via browserUx.extraH. Los atajos Safari
 *  (⌘L/⌘R/⌘F/⌘[/⌘]/zoom) los captura el hook DENTRO de la pagina y este
 *  chrome los drena por poll — la app nunca ve esas teclas. */

// ---------- ICONOS lucide (29 jul, pedido de Daniel: "no emojis"). Dibujados
// a mano con el lenguaje de lucide (24x24, trazo 2, puntas redondas) siguiendo
// la convencion del repo — sin dependencia nueva: `lucide-react` traeria ~1400
// iconos para usar diez, y este archivo ya declara sus svgProps como los demas.
const svgProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};
const I = ({ d, size = 15 }: { d: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} {...svgProps}>
    {d}
  </svg>
);
const IconBack = () => <I d={<><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>} />;
const IconFwd = () => <I d={<><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>} />;
const IconReload = () => (
  <I d={<><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>} />
);
const IconStop = () => <I d={<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>} />;
/** MousePointer2 de lucide: el picker ⊹ de antes */
const IconPick = () => (
  <I d={<path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.44 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z" />} />
);
const IconPhone = () => (
  <I d={<><rect width="14" height="20" x="5" y="2" rx="2" /><path d="M12 18h.01" /></>} />
);
const IconMonitor = () => (
  <I d={<><rect width="20" height="14" x="2" y="3" rx="2" /><path d="M8 21h8" /><path d="M12 17v4" /></>} />
);
const IconExternal = () => (
  <I d={<><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>} />
);
const IconExpand = () => (
  <I d={<><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></>} />
);
const IconCollapse = () => (
  <I d={<><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="M14 10 21 3" /><path d="M3 21l7-7" /></>} />
);
const IconAlert = () => (
  <I size={13} d={<><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>} />
);
/** Eraser: la sesion limpia (cookies + datos) */
const IconErase = () => (
  <I d={<><path d="m7 21-4.3-4.3a2.4 2.4 0 0 1 0-3.4l9.6-9.6a2.4 2.4 0 0 1 3.4 0l5.6 5.6a2.4 2.4 0 0 1 0 3.4L13 21" /><path d="M22 21H7" /><path d="m5 11 9 9" /></>} />
);

/** expresion unica del poll rapido: drena teclas + cuenta salud de la pagina */
const POLL_JS = `(() => {
  const K = window.__sfKeys || [];
  const k = K.splice(0, K.length);
  const D = window.__sfDebug;
  const bad = ["error", "exception", "rejection"];
  return {
    k,
    e: D ? D.console.filter((c) => bad.includes(c.level)).length : 0,
    f: D ? D.net.filter((n) => n.error || n.ok === false).length : 0,
  };
})()`;

const DETAIL_JS = `(() => {
  const D = window.__sfDebug || { console: [], net: [] };
  const bad = ["error", "exception", "rejection"];
  return {
    errs: D.console.filter((c) => bad.includes(c.level)).slice(-5).map((c) => c.text),
    fails: D.net.filter((n) => n.error || n.ok === false).slice(-5)
      .map((n) => (n.method + " " + n.url + " → " + (n.error || n.status))),
  };
})()`;

export default function BrowserView({ id }: { id: number }) {
  const meta = useStore((s) => s.browserMeta[id]);
  const mobile = useStore((s) => s.browserUx[id]?.mobile ?? false);
  const [urlInput, setUrlInput] = useState("");
  const [picking, setPicking] = useState(false);
  const [histOpen, setHistOpen] = useState(false);
  const [health, setHealth] = useState({ e: 0, f: 0 });
  const [healthOpen, setHealthOpen] = useState(false);
  const [healthDetail, setHealthDetail] = useState<{ errs: string[]; fails: string[] }>({ errs: [], fails: [] });
  const [dialog, setDialog] = useState<ipc.BrowserDialog | null>(null);
  const [dialogText, setDialogText] = useState("");
  const [toast, setToast] = useState<ipc.BrowserDownload | null>(null);
  // % al que el ajuste al panel encogio la pagina (null = cabe tal cual)
  const [fit, setFit] = useState<number | null>(null);
  const [showFind, setShowFind] = useState(false);
  const [findQ, setFindQ] = useState("");
  const [findPos, setFindPos] = useState({ count: 0, index: 0 });
  const editing = useRef(false);
  /** Daniel ya ESCRIBIO en el omnibox: su texto es sagrado hasta que navegue
   *  (Enter), lo suelte (Esc) o la pagina cambie de verdad. Sin esto, el poll
   *  de 1s le "regresaba" la url vieja encima de lo tecleado (bug 30 jul). */
  const dirty = useRef(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const prevUrl = useRef("");
  const wasLoading = useRef(false);
  const dismissed = useRef(0);
  const expandido = useStore((s) => s.soloLeaf != null);
  /** aviso efimero del chrome (captura guardada, sesion limpia) */
  const [aviso, setAviso] = useState<string | null>(null);
  useEffect(() => {
    if (!aviso) return;
    const t = setTimeout(() => setAviso(null), 3200);
    return () => clearTimeout(t);
  }, [aviso]);

  // pestaña nueva en blanco: el teclado va directo al omnibox (como ⌘T en
  // cualquier navegador). Solo al montar, solo sin pagina cargada, y solo si
  // Daniel no esta tecleando en otro lado (un agente abriendo SU navegador
  // por el gate jamas debe robarle el foco — contrato del 29 jul).
  useEffect(() => {
    const ae = document.activeElement;
    const libre = !ae || ae === document.body;
    if (libre && !useStore.getState().browserMeta[id]?.url) urlRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ---- espejo de UX hacia Tiling: cuanto espacio extra ocupa el chrome ----
  useEffect(() => {
    const extraH =
      (dialog ? 34 : 0) + (showFind ? 34 : 0) + (toast ? 30 : 0) + (aviso ? 30 : 0) + (picking ? 34 : 0);
    const cur = useStore.getState();
    const prev = cur.browserUx[id] ?? { mobile: false, extraH: 0 };
    if (prev.extraH === extraH) return;
    cur.set({ browserUx: { ...cur.browserUx, [id]: { ...prev, extraH } } });
  }, [id, dialog, showFind, toast, aviso, picking]);

  // AJUSTE AL PANEL al montar: un navegador que ya trae pagina cargada nunca
  // veria la transicion loading→listo, y se quedaria cortado.
  useEffect(() => {
    autofit.onLoad(id);
    return () => autofit.forget(id);
  }, [id]);

  // ⊹ ELEMENT PICKER: Daniel SEÑALA un elemento y el resultado queda en el
  // buffer — el proximo `browser_pick` del agente lo drena al instante.
  const startPick = () => {
    if (picking) return;
    setPicking(true);
    void (async () => {
      try {
        await pick.armPick(id);
        const res = await pick.pollPick(id, 60_000);
        if (!res.cancelled) {
          pick.stashPick(res);
          setAviso("elemento señalado · quedó listo para el agente");
        }
      } catch {
        /* webview cerrado o pagina sin eval: nada que señalar */
      } finally {
        setPicking(false);
      }
    })();
  };

  // poll 1s: url/titulo/loading/progreso → store + HISTORIAL en cada cambio
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await ipc.browserStateGet(id);
        if (!alive) return;
        const cur = useStore.getState();
        cur.set({
          browserMeta: {
            ...cur.browserMeta,
            [id]: {
              url: s.url,
              title: s.title,
              loading: s.loading,
              canBack: s.can_back,
              canForward: s.can_forward,
            },
          },
        });
        if (s.url && s.url !== prevUrl.current) {
          prevUrl.current = s.url;
          pushHist(s.url, s.title);
          // navegacion REAL: la pagina nueva manda — pero solo si Daniel no
          // esta tecleando en este instante (su texto gana mientras edita)
          if (!editing.current) dirty.current = false;
        } else if (s.url && s.title) {
          pushHist(s.url, s.title); // refresca el titulo del entry vigente
        }
        // AJUSTE AL PANEL: al terminar de cargar, la pagina es otra — se
        // re-mide su ancho minimo y se encoge si no cabe (ver core/autofit).
        if (wasLoading.current && !s.loading) autofit.onLoad(id);
        wasLoading.current = s.loading;
        setFit(autofit.factor(id));
        if (!editing.current && !dirty.current) setUrlInput(s.url);
      } catch {
        /* webview cerrado: el tab esta muriendo */
      }
    };
    void tick();
    const t = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  // progreso fino mientras carga (poll denso solo durante loading)
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (!meta?.loading) {
      setProgress(0);
      return;
    }
    let alive = true;
    const t = setInterval(async () => {
      try {
        const s = await ipc.browserStateGet(id);
        if (alive) setProgress(s.loading ? s.progress : 1);
      } catch {
        /* muriendo */
      }
    }, 200);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, meta?.loading]);

  // poll rapido 500ms: teclas Safari desde la pagina + contadores de salud
  useEffect(() => {
    let alive = true;
    const t = setInterval(async () => {
      try {
        const raw = await ipc.browserEval(id, POLL_JS);
        if (!alive) return;
        const v = JSON.parse(raw) as { k: string[]; e: number; f: number };
        setHealth((h) => (h.e === v.e && h.f === v.f ? h : { e: v.e, f: v.f }));
        for (const k of v.k) handleKey(k);
      } catch {
        /* pagina sin cargar aun */
      }
    }, 500);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // poll 900ms: dialogos JS pendientes + descargas (estado espejo de Rust)
  useEffect(() => {
    let alive = true;
    const t = setInterval(async () => {
      try {
        const [dlgs, dls] = await Promise.all([ipc.browserDialogs(), ipc.browserDownloads()]);
        if (!alive) return;
        const mine = dlgs.find((d) => d.view === id) ?? null;
        setDialog((cur) => {
          if (mine?.id !== cur?.id) setDialogText(mine?.default_text ?? "");
          return mine;
        });
        const last = dls[dls.length - 1] ?? null;
        setToast(last && last.id !== dismissed.current ? last : null);
      } catch {
        /* app ocupada */
      }
    }, 900);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);

  const handleKey = (k: string) => {
    switch (k) {
      case "url":
        urlRef.current?.focus();
        urlRef.current?.select();
        break;
      case "reload":
        void ipc.browserNav(id, "reload");
        break;
      case "back":
        void ipc.browserNav(id, "back");
        break;
      case "forward":
        void ipc.browserNav(id, "forward");
        break;
      case "find":
        setShowFind(true);
        setTimeout(() => findRef.current?.focus(), 60);
        break;
      // ⌘+/− fijan el zoom A MANO (autofit.step parte del factor vigente y
      // calla el ajuste automatico); ⌘0 lo devuelve a automatico. Nada pelea
      // contra quien mira la pantalla.
      case "zin":
        autofit.step(id, 0.1);
        break;
      case "zout":
        autofit.step(id, -0.1);
        break;
      case "zreset":
        void ipc.browserZoom(id, 1);
        autofit.manual(id, 1); // vuelve a automatico y re-ajusta
        break;
    }
  };

  const go = (u?: string) => {
    editing.current = false;
    dirty.current = false;
    setHistOpen(false);
    const dest = (u ?? urlInput).trim();
    if (dest) void ipc.browserGoto(id, dest);
  };

  const closeFind = () => {
    setShowFind(false);
    setFindQ("");
    setFindPos({ count: 0, index: 0 });
    void findpage.clear(id);
  };

  const doFind = async (q: string) => {
    setFindQ(q);
    if (!q) {
      setFindPos({ count: 0, index: 0 });
      void findpage.clear(id);
      return;
    }
    setFindPos(await findpage.search(id, q));
  };

  /** EXPANDIR: el campo del navegador se queda con toda la pantalla. Es el
   *  mismo mecanismo del ala plegada, al reves — se ocultan los demas campos
   *  sin tocar el arbol, asi que contraer devuelve el layout EXACTO. */
  const toggleExpandir = () => {
    const s = useStore.getState();
    const mio = T.leafOfBrowserId(s.root, id);
    s.set({ soloLeaf: s.soloLeaf ? null : (mio ?? null) });
  };

  /** SESION LIMPIA: borra cookies y datos de TODOS los sitios y recarga. */
  const sesionLimpia = async () => {
    try {
      await ipc.browserClearSession();
      await ipc.browserNav(id, "reload");
      setAviso("sesión limpia · esta página ya no te conoce");
    } catch {
      setAviso("no se pudo limpiar la sesión");
    }
  };

  const toggleMobile = () => {
    const cur = useStore.getState();
    const prev = cur.browserUx[id] ?? { mobile: false, extraH: 0 };
    const on = !prev.mobile;
    cur.set({ browserUx: { ...cur.browserUx, [id]: { ...prev, mobile: on } } });
    void (async () => {
      await ipc.browserSetMobile(id, on);
      await ipc.browserNav(id, "reload");
    })();
  };

  const answerDialog = (accept: boolean) => {
    if (!dialog) return;
    void ipc.browserDialogReply(dialog.id, accept, dialog.kind === "prompt" ? dialogText : undefined);
    setDialog(null);
  };

  const hist = histOpen
    ? loadHist()
        .filter((h) => {
          const q = urlInput.trim().toLowerCase();
          if (!q || q === meta?.url?.toLowerCase()) return true;
          return h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q);
        })
        .slice(0, 8)
    : [];

  return (
    <>
      <div className="browser-chrome">
        <button
          className="leaf-action-btn"
          disabled={!meta?.canBack}
          onClick={() => void ipc.browserNav(id, "back")}
          title="Atrás (⌘[ en la página)"
        >
          <IconBack />
        </button>
        <button
          className="leaf-action-btn"
          disabled={!meta?.canForward}
          onClick={() => void ipc.browserNav(id, "forward")}
          title="Adelante (⌘])"
        >
          <IconFwd />
        </button>
        <button
          className="leaf-action-btn"
          onClick={() => void ipc.browserNav(id, meta?.loading ? "stop" : "reload")}
          title={meta?.loading ? "Detener la carga" : "Recargar (⌘R)"}
        >
          {meta?.loading ? <IconStop /> : <IconReload />}
        </button>
        <div className="browser-url-wrap">
          <input
            ref={urlRef}
            className={`browser-url ${meta?.loading ? "loading" : ""}`}
            value={urlInput}
            onFocus={(e) => {
              editing.current = true;
              setHistOpen(true);
              e.currentTarget.select();
            }}
            onBlur={() => {
              editing.current = false;
              // dejar respirar el click en el dropdown antes de cerrarlo
              setTimeout(() => setHistOpen(false), 180);
            }}
            onChange={(e) => {
              dirty.current = true;
              setUrlInput(e.target.value);
              setHistOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") go();
              if (e.key === "Escape") {
                editing.current = false;
                dirty.current = false;
                setHistOpen(false);
                setUrlInput(meta?.url ?? "");
                e.currentTarget.blur();
              }
              e.stopPropagation();
            }}
            placeholder="url o búsqueda — o pídesela al agente"
            spellCheck={false}
          />
          {hist.length > 0 && (
            <div className="browser-hist">
              {hist.map((h) => (
                <button
                  key={h.url}
                  className="browser-hist-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    go(h.url);
                  }}
                  title={h.url}
                >
                  <span className="bh-title">{h.title}</span>
                  <span className="bh-url">{h.url.replace(/^https?:\/\//, "")}</span>
                </button>
              ))}
            </div>
          )}
          {meta?.loading && progress > 0 && (
            <div className="browser-progress" style={{ width: `${Math.max(6, progress * 100)}%` }} />
          )}
        </div>
        {health.e + health.f > 0 && (
          <div className="browser-health-wrap">
            <button
              className={`leaf-action-btn health ${healthOpen ? "open" : ""}`}
              title="Errores de la página — pídeme el detalle en el chat"
              onClick={() => {
                const next = !healthOpen;
                setHealthOpen(next);
                if (next)
                  void ipc
                    .browserEval(id, DETAIL_JS)
                    .then((raw) => setHealthDetail(JSON.parse(raw) as { errs: string[]; fails: string[] }))
                    .catch(() => {});
              }}
            >
              <IconAlert /> {health.e + health.f}
            </button>
            {healthOpen && (
              <div className="browser-health-pop">
                {healthDetail.errs.map((t, i) => (
                  <div key={`e${i}`} className="bh-line err">{t}</div>
                ))}
                {healthDetail.fails.map((t, i) => (
                  <div key={`f${i}`} className="bh-line fail">{t}</div>
                ))}
                {healthDetail.errs.length + healthDetail.fails.length === 0 && (
                  <div className="bh-line">cargando…</div>
                )}
                <div className="bh-line hint">solo espejo — pídeme el detalle en el chat</div>
              </div>
            )}
          </div>
        )}
        {fit != null && (
          <button
            className="leaf-action-btn"
            onClick={() => {
              autofit.pin100(id);
              setFit(null);
            }}
            title={`La página pide más ancho del que tiene el ala: encogida a ${Math.round(
              fit * 100,
            )}% para que quepa entera. Clic para verla al 100% (con corte y scroll); ⌘0 vuelve al ajuste automático.`}
          >
            {Math.round(fit * 100)}%
          </button>
        )}
        <button
          className={`leaf-action-btn ${mobile ? "picking" : ""}`}
          onClick={toggleMobile}
          title={mobile ? "Volver a escritorio" : "Modo iPhone (viewport 390px + UA móvil)"}
        >
          {mobile ? <IconMonitor /> : <IconPhone />}
        </button>
        <button
          className={`leaf-action-btn ${picking ? "picking" : ""}`}
          onClick={startPick}
          title={picking ? "Señala un elemento (Esc cancela)" : "Señalar un elemento para el agente"}
        >
          <IconPick />
        </button>
        {/* la NUEVA PESTAÑA vive como "+" a la derecha de las pestañas del
            campo (Tiling.renderBar), como en cualquier navegador — pedido de
            Daniel 30 jul. La captura murio el mismo dia: la toma el a mano. */}
        {/* SESION LIMPIA: mirar tu propio producto con ojos de extraño */}
        <button
          className="leaf-action-btn"
          onClick={() => void sesionLimpia()}
          title="Sesión limpia: borra cookies y datos de TODOS los sitios y recarga — así ves tu producto como quien llega por primera vez"
        >
          <IconErase />
        </button>
        <button
          className={`leaf-action-btn ${expandido ? "on" : ""}`}
          onClick={toggleExpandir}
          title={expandido ? "Contraer (⌘⇧E)" : "Expandir: el navegador toma toda la pantalla (⌘⇧E)"}
        >
          {expandido ? <IconCollapse /> : <IconExpand />}
        </button>
        <button
          className="leaf-action-btn"
          onClick={() => {
            if (meta?.url) void ipc.openUrl(meta.url);
          }}
          title="Abrir en el navegador del sistema"
        >
          <IconExternal />
        </button>
      </div>
      {aviso && (
        <div className="browser-strip toast done">
          <span className="bs-msg">{aviso}</span>
        </div>
      )}
      {/* MODO SEÑALAR armado: mientras dure, el SIGUIENTE click de la pagina
          se lo queda el picker (no le llega al sitio). Hacerlo visible evita
          el bug fantasma "clickeo y no abre" (30 jul). */}
      {picking && (
        <div className="browser-strip dialog">
          <span className="bs-kind">⊹</span>
          <span className="bs-msg">
            Señalando: tu próximo click marca el elemento para el agente y NO le llega a la página — Esc cancela
          </span>
          <button className="bs-btn" onClick={() => void pick.cancelPick(id).catch(() => {})}>
            Cancelar
          </button>
        </div>
      )}
      {dialog && (
        <div className="browser-strip dialog">
          <span className="bs-kind">{dialog.kind === "alert" ? "⚠︎" : "❓"}</span>
          <span className="bs-msg" title={dialog.message}>
            {dialog.message}
          </span>
          {dialog.kind === "prompt" && (
            <input
              className="bs-input"
              value={dialogText}
              autoFocus
              onChange={(e) => setDialogText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") answerDialog(true);
                if (e.key === "Escape") answerDialog(false);
                e.stopPropagation();
              }}
            />
          )}
          {dialog.kind !== "alert" && (
            <button className="bs-btn" onClick={() => answerDialog(false)}>
              Cancelar
            </button>
          )}
          <button className="bs-btn ok" onClick={() => answerDialog(true)}>
            OK
          </button>
        </div>
      )}
      {showFind && (
        <div className="browser-strip find">
          <input
            ref={findRef}
            className="bs-input grow"
            placeholder="buscar en la página…"
            value={findQ}
            autoFocus
            onChange={(e) => void doFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.shiftKey) void findpage.prev(id).then(setFindPos);
              else if (e.key === "Enter") void findpage.next(id).then(setFindPos);
              if (e.key === "Escape") closeFind();
              e.stopPropagation();
            }}
          />
          <span className="bs-count">
            {findPos.count < 0 ? "sin soporte" : findPos.count ? `${findPos.index}/${findPos.count}` : findQ ? "0" : ""}
          </span>
          <button className="bs-btn" onClick={() => void findpage.prev(id).then(setFindPos)} title="Anterior (⇧Enter)">
            ↑
          </button>
          <button className="bs-btn" onClick={() => void findpage.next(id).then(setFindPos)} title="Siguiente (Enter)">
            ↓
          </button>
          <button className="bs-btn" onClick={closeFind} title="Cerrar (Esc)">
            ✕
          </button>
        </div>
      )}
      {toast && (
        <div className={`browser-strip toast ${toast.state}`}>
          <span className="bs-kind">{toast.state === "running" ? "⇣" : toast.state === "done" ? "✓" : "✕"}</span>
          <span className="bs-msg" title={toast.dest || toast.url}>
            {toast.state === "running" && `descargando ${pathBasename(toast.dest) || toast.url}…`}
            {toast.state === "done" && `${pathBasename(toast.dest)} descargado`}
            {toast.state === "failed" && `falló: ${toast.error ?? "error"}`}
          </span>
          {toast.state === "done" && (
            <button
              className="bs-btn"
              onClick={() => void ipc.shellCapture(`open -R "${toast.dest}"`, "~")}
            >
              Revelar
            </button>
          )}
          <button
            className="bs-btn"
            onClick={() => {
              dismissed.current = toast.id;
              setToast(null);
            }}
          >
            ✕
          </button>
        </div>
      )}
    </>
  );
}
