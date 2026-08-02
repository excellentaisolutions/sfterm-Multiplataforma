/** Puerta de agentes (lado JS): ejecuta las ops que llegan por
 *  ~/.config/sfterm/gate/ (ver src-tauri/src/gate.rs y scripts/gate.py).
 *  Es la via para que Levy (u otro agente local) OPERE la app: listar
 *  terminales, abrir terminales, mandar prompts, leer output, screenshot.
 *  AI-first: la UI es el espejo; la operacion entra por aqui.
 *  (chat_send/chat_last murieron con el chat nativo — purga 21 jul: los
 *  verbos de terminal spawn/send/read/blocks cubren la conversacion.) */
import { manager } from "./term";
import { useStore, panelTitle } from "./store";
import * as T from "./tiling";
import * as actions from "./actions";
import * as ipc from "./ipc";
import * as pick from "./pick";
import * as findpage from "./findpage";
import * as bhistory from "./bhistory";
import * as H from "./hist";

import * as locator from "./locator";
import * as autofit from "./autofit";

/** ¿el agente dijo A QUE elemento le habla? (si no, cada verbo pone su default) */
function tieneTarget(a: Record<string, unknown>): boolean {
  return !!(a.selector || a.text || a.role || a.placeholder || a.label);
}

/** Los cinco modos de señalar un elemento, en un solo objeto. */
function targetDe(a: Record<string, unknown>): locator.Target {
  return {
    selector: a.selector ? String(a.selector) : undefined,
    text: a.text ? String(a.text) : undefined,
    role: a.role ? String(a.role) : undefined,
    name: a.name ? String(a.name) : undefined,
    placeholder: a.placeholder ? String(a.placeholder) : undefined,
    label: a.label ? String(a.label) : undefined,
  };
}

const st = () => useStore.getState();

// ---- helpers del navegador (F1) ----

/** EL REMITENTE. `gate.py` estampa `__term` con el SFTERM_TERM_ID que la app
 *  le inyecto a esa terminal (pty.rs), asi que un agente se identifica solo.
 *  null = el comando vino de fuera de SFTerm (un cron, un script suelto).
 *
 *  ⚠️ SE VALIDA contra las conversaciones VIVAS de ESTA app (cazado en E2E el
 *  29 jul): un agente que corre en OTRA instancia de SFTerm estampa un id que
 *  aqui no existe. Honrarlo pariria un navegador de dueño FANTASMA — invisible
 *  para todos (el ala solo se pinta en la conversacion de su dueño) y a la vez
 *  inalcanzable por el gate. Un id que no es de aqui se trata como "de fuera". */
function caller(a: Record<string, unknown>): number | null {
  const v = a.__term;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return st().panels[v] ? v : null;
}

/** El navegador DE QUIEN PREGUNTA. Cada conversacion tiene el suyo, para hacer
 *  y deshacer sin pisar a los demas.
 *
 *  ⚠️ El error importa tanto como el acierto: si el agente no tiene navegador
 *  propio, esto FALLA en vez de prestarle el de otro. Devolver el ajeno seria
 *  el peor modo de fallar de todo este diseño — el agente creeria estar
 *  operando su pagina mientras hace clic en la de otra conversacion, y nadie
 *  se enteraria hasta que el daño ya esta hecho.
 *
 *  Sin remitente (cron, script fuera de SFTerm) se conserva el comportamiento
 *  compartido de v1: ahi no hay conversacion a la que pertenecer. */
function requireBrowser(a: Record<string, unknown>): number {
  const who = caller(a);
  const id = who != null ? actions.browserIdFor(who) : actions.browserId();
  if (id == null) {
    throw new Error(
      who != null
        ? `esta conversacion no tiene navegador (usa browser_open; el de otra terminal NO se presta)`
        : "no hay navegador abierto (usa browser_open)",
    );
  }
  return id;
}

/** Evalua una EXPRESION en la pagina y devuelve su valor ya parseado.
 *  browser.rs envuelve en JSON.stringify; los errores JS viajan como
 *  "JSERROR: ..." y aqui se vuelven errores del gate. */
async function evalInBrowser(id: number, expr: string): Promise<unknown> {
  const raw = await ipc.browserEval(id, expr);
  if (raw.startsWith("JSERROR:")) throw new Error(raw);
  if (raw === "undefined") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Espera a que el WKWebView termine de cargar (con techo). El respiro
 *  inicial existe porque isLoading tarda un tick en prenderse tras goto. */
async function waitLoaded(id: number, ms = 12000): Promise<ipc.BrowserState | null> {
  await new Promise((r) => setTimeout(r, 350));
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await ipc.browserStateGet(id).catch(() => null);
    if (s && !s.loading) return s;
    await new Promise((r) => setTimeout(r, 300));
  }
  return await ipc.browserStateGet(id).catch(() => null);
}

/** Card del historial por sid — acepta PREFIJO (los humanos y los agentes
 *  citan los primeros 8 chars). Ambiguo o inexistente = error honesto. */
async function histCardBySid(sid: string): Promise<H.ConvCard> {
  if (!sid) throw new Error("sid requerido");
  const cards = await H.loadHistory();
  const exact = cards.find((c) => c.sid === sid);
  if (exact) return exact;
  const pref = cards.filter((c) => c.sid.startsWith(sid));
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) throw new Error(`sid '${sid}' ambiguo (${pref.length} sesiones)`);
  throw new Error(`sesion '${sid}' no esta en el historial`);

/** DESPUES DE UN CLIC. Un clic PUEDE navegar, pero la mayoria no lo hace, y
 *  cobrarle a todos el peaje de esperar una carga que no existe hacia que cada
 *  accion se sintiera lenta. Aqui se asoma 250ms a ver si arranco una
 *  navegacion: si arranco, se espera completa; si no, se vuelve de inmediato. */
async function trasClic(id: number): Promise<Partial<ipc.BrowserState>> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 50));
    const s = await ipc.browserStateGet(id).catch(() => null);
    if (s?.loading) return (await waitLoaded(id)) ?? {};
  }
  return (await ipc.browserStateGet(id).catch(() => null)) ?? {};
}

async function expandTilde(p: string): Promise<string> {
  if (p === "~") return await ipc.fsHomeDir();
  if (p.startsWith("~/")) return (await ipc.fsHomeDir()) + p.slice(1);
  return p;
}

async function dispatch(op: string, a: Record<string, unknown>): Promise<unknown> {
  switch (op) {
    case "ping":
      return { app: "sfterm", ok: true };

    // conversaciones vivas: id, titulo, cwd, proceso, visible/enfocada
    case "list": {
      const s = st();
      return Object.values(s.panels).map((p) => ({
        id: p.id,
        title: panelTitle(p),
        cwd: p.cwd,
        proc: p.fgName,
        visible: !!T.leafOfTerm(s.root, p.id),
        focused: s.focused === p.id,
      }));
    }

    // ---- HISTORIAL de conversaciones (la vitrina, 30 jul 2026) ----
    // AI-first: todo lo que Daniel puede clickear en el rail, pedible hablando.

    // el historial del disco (maquinaria/cascarones ya filtrados por Rust):
    // {n?, q?, fresh?} → [{sid, title, cwd, path, config_dir, mtime_ms}]
    case "conv_list": {
      const cards = await H.loadHistory(!!a.fresh);
      const q = String(a.q ?? "");
      const n = Number(a.n ?? 30);
      return cards
        .filter((c) => H.matches(c, q))
        .slice(0, n)
        .map((c) => ({
          sid: c.sid,
          title: c.title,
          cwd: c.cwd,
          path: c.path,
          config_dir: c.configDir,
          mtime_ms: c.mtimeMs,
          provider: c.provider,
        }));
    }

    // VERBO DE DIRECTOR: pinta la conversacion en el LECTOR de Daniel (espejo
    // solo-lectura + barra de continuar). {sid} acepta prefijo (8+ chars).
    case "conv_open": {
      const card = await histCardBySid(String(a.sid ?? ""));
      actions.openHistMirror(card);
      return { ok: true, sid: card.sid, title: card.title };
    }

    // CONTINUAR: terminal nueva con el resume del proveedor (gesto explicito,
    // jamas automatico). {sid, text?} — text viaja cuando el agente despierta.
    case "conv_resume": {
      const card = await histCardBySid(String(a.sid ?? ""));
      const id = await actions.continueHist(card, a.text ? String(a.text) : undefined);
      return { ok: true, term: id, sid: card.sid };
    }

    // FILTROS de la vitrina por conversacion: {group_by?: date|project|none,
    // sort_by?: recency|title, project?: string|null}. Sin args = leerlos.
    case "conv_prefs": {
      const cur = H.histPrefs();
      const next: H.HistPrefs = {
        groupBy:
          a.group_by === "project" || a.group_by === "none" || a.group_by === "date"
            ? a.group_by
            : cur.groupBy,
        sortBy: a.sort_by === "title" || a.sort_by === "recency" ? a.sort_by : cur.sortBy,
        project:
          a.project === null ? null : typeof a.project === "string" && a.project ? a.project : cur.project,
      };
      if (a.group_by !== undefined || a.sort_by !== undefined || a.project !== undefined) {
        H.saveHistPrefs(next);
        window.dispatchEvent(new CustomEvent("sfterm:hist-prefs"));
      }
      return next;
    }

    // abre una terminal (show=false la deja viva pero fuera de la vista).
    // worktree=true: crea un git worktree (rama agente/<ts>) y spawnea AHI —
    // dos agentes, dos copias, cero colision (el S2 resuelto, no solo avisado)
    case "spawn": {
      let cwd = a.cwd ? await expandTilde(String(a.cwd)) : undefined;
      let wt: { branch: string; cwd: string } | undefined;
      if (a.worktree) {
        const base = cwd ?? st().treeRoot;
        const ts = new Date()
          .toISOString()
          .replace(/[-:TZ.]/g, "")
          .slice(2, 12);
        const branch = `agente/${ts}`;
        const out = await ipc.shellCapture(
          `{ root=$(git rev-parse --show-toplevel) && name=$(basename "$root") && dest="$(dirname "$root")/$name-wt-${ts}" && git worktree add -b "${branch}" "$dest" && echo "OK:$dest"; } 2>&1`,
          base,
        );
        const okLine = out.split("\n").find((l) => l.startsWith("OK:"));
        if (!okLine) throw new Error(`worktree fallo: ${out.slice(0, 300)}`);
        cwd = okLine.slice(3).trim();
        wt = { branch, cwd };
      }
      // spawn visible con el chat (home) encima: revelar el taller para que
      // la terminal que Levy abre se VEA (pintar la pantalla de verdad)
      if (a.show !== false && st().ui.chat) actions.showChat(false);
      const id = await actions.gateSpawn({
        cwd,
        command: a.command ? String(a.command) : undefined,
        show: a.show !== false,
      });
      return wt ? { id, worktree: wt } : { id };
    }

    // ---- verbos de DIRECTOR: Levy pinta la pantalla de Daniel ----

    // abre un archivo en el visor (solo-lectura); line = salta a esa linea
    case "show_file": {
      const path = await expandTilde(String(a.path ?? ""));
      if (!path) throw new Error("path requerido");
      if (a.line != null) actions.openViewerAt(path, Number(a.line));
      else actions.openFileTab(path, "auto");
      return { shown: path };
    }

    // path dado → ese archivo en modo diff; sin path → TODOS los cambios
    // del repo como tabs diff (la revision conversacional)
    case "show_diff": {
      if (a.path) {
        const path = await expandTilde(String(a.path));
        actions.openFileTab(path, "diff");
        return { shown: [path] };
      }
      const opened = await actions.openChanges();
      return { shown: opened };
    }

    // overlay de preview: {url} lo abre, {close:true} lo cierra,
    // sin args busca la URL del dev server en la terminal enfocada
    case "preview": {
      if (a.close) {
        useStore.getState().setUI({ preview: null });
        return { closed: true };
      }
      if (a.url) {
        useStore.getState().setUI({ preview: String(a.url) });
        return { url: String(a.url) };
      }
      const url = await actions.openDevPreview(a.id != null ? Number(a.id) : undefined);
      if (!url) throw new Error("no encontre URL de dev server en la terminal");
      return { url };
    }

    // ---- NAVEGADOR DEL AGENTE (F1): ojos y manos sobre la web ----
    // WKWebView top-level SIN IPC de Tauri (browser.rs). El lazo del agente:
    // goto → read/snap → click/type → read.
    //
    // UNO POR CONVERSACION (29 jul): cada agente tiene el suyo para hacer y
    // deshacer sin pisar a los demas. El remitente (`__term`, estampado por
    // gate.py con el SFTERM_TERM_ID que pty.rs inyecto) es lo que hace posible
    // resolver "el navegador de quien pregunta" en vez de "el primero del
    // arbol". Un comando sin remitente (cron, script de fuera) conserva el
    // comportamiento compartido de v1.

    // abre (o enfoca) el navegador; {url} navega y ESPERA la carga
    case "browser_open": {
      // focus:false — el gate JAMAS mueve la pantalla de Daniel. Si el agente
      // quiere que MIRE algo, que lo pida; no se lo impone abriendo su ala.
      const id = await actions.openBrowser(
        a.url ? String(a.url) : undefined,
        caller(a) ?? undefined,
        false,
        { focus: false },
      );
      const state = a.url ? await waitLoaded(id) : await ipc.browserStateGet(id).catch(() => null);
      return { id, ...(state ?? {}) };
    }

    // navega la pestaña ya abierta (la abre si no existe) y espera la carga
    case "browser_goto": {
      if (!a.url) throw new Error("url requerida");
      const who = caller(a);
      const id =
        (who != null ? actions.browserIdFor(who) : actions.browserId()) ??
        (await actions.openBrowser(undefined, who ?? undefined, false, { focus: false }));
      await ipc.browserGoto(id, String(a.url));
      return await waitLoaded(id);
    }

    // back | forward | reload | stop
    case "browser_nav": {
      const id = requireBrowser(a);
      await ipc.browserNav(id, String(a.action ?? "reload") as "back");
      return await waitLoaded(id);
    }

    // url/titulo/loading/canGoBack — el pulso del navegador
    case "browser_state": {
      return await ipc.browserStateGet(requireBrowser(a));
    }

    // LA PAGINA COMO DATOS: texto legible + links + campos interactivos.
    // Complemento de browser_snap (pixeles): esto es la mitad "leer" del lazo.
    case "browser_read": {
      const id = requireBrowser(a);
      const max = Math.min(Number(a.chars ?? 18000), 60000);
      return await evalInBrowser(
        id,
        `(() => {
          const text = document.body ? document.body.innerText.slice(0, ${max}) : "";
          const links = [...document.querySelectorAll("a[href]")].slice(0, 200)
            .map(a => ({ text: (a.innerText || "").trim().slice(0, 80), href: a.href }))
            .filter(l => l.text);
          const inputs = [...document.querySelectorAll("input,textarea,select,button")].slice(0, 100)
            .map(el => ({ tag: el.tagName.toLowerCase(), type: el.type || "",
              name: el.name || el.id || "", placeholder: el.placeholder || "",
              text: (el.innerText || el.value || "").trim().slice(0, 60) }));
          return { url: location.href, title: document.title, text, links, inputs };
        })()`,
      );
    }

    // click por {selector} css o {text} visible (exacto primero, luego contiene)
    // CLICK con actionability (29 jul): espera a que el elemento este visible,
    // quieto, habilitado y ALCANZABLE antes de tocarlo, y si no lo logra dice
    // POR QUE ("tapado por <div.cookie-banner>"). Acepta {selector} css,
    // {text} visible, o {role, name} semantico — este ultimo sobrevive
    // rediseños que rompen cualquier selector.
    case "browser_click": {
      const id = requireBrowser(a);
      const res = await locator.actuar(
        id,
        targetDe(a),
        "el.click();",
        Number(a.timeout_ms ?? 6000),
      );
      if (!res.ok) throw new Error(`no pude clickear: ${res.reason}`);
      return { clicked: true, ...res, ...(await trasClic(id)) };
    }

    // escribe en un campo: {selector?} (default: el enfocado o el primero),
    // {text}, {submit: true} manda el form
    // ESCRIBIR con actionability. Sin target explicito busca el primer campo
    // de texto (rol textbox). React-safe: setter nativo + eventos.
    case "browser_type": {
      const id = requireBrowser(a);
      const txt = JSON.stringify(String(a.text ?? ""));
      const submit = a.submit ? "true" : "false";
      const target = tieneTarget(a) ? targetDe(a) : { role: "textbox" };
      const res = await locator.actuar(
        id,
        target,
        `el.focus();
         const proto = Object.getPrototypeOf(el);
         const setter = Object.getOwnPropertyDescriptor(proto, "value") && Object.getOwnPropertyDescriptor(proto, "value").set;
         if (setter) setter.call(el, ${txt}); else el.value = ${txt};
         el.dispatchEvent(new Event("input", { bubbles: true }));
         el.dispatchEvent(new Event("change", { bubbles: true }));
         if (${submit}) {
           if (el.form && el.form.requestSubmit) el.form.requestSubmit();
           else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
         }`,
        Number(a.timeout_ms ?? 6000),
      );
      if (!res.ok) throw new Error(`no pude escribir: ${res.reason}`);
      if (a.submit) return { typed: true, ...res, ...((await waitLoaded(id)) ?? {}) };
      return { typed: true, ...res };
    }

    // SUBIR ARCHIVOS sin dialogo nativo (29 jul): se arman las rutas en Rust y
    // el clic al <input type=file> dispara el panel, que el delegate contesta
    // con ellas SIN mostrar nada. Es el setInputFiles de Playwright, y era la
    // ultima cosa que ellos podian y nosotros no.
    case "browser_upload": {
      const id = requireBrowser(a);
      const lista = Array.isArray(a.paths) ? a.paths : a.path ? [a.path] : [];
      if (!lista.length) throw new Error("paths requerido");
      const rutas: string[] = [];
      for (const p of lista) rutas.push(await expandTilde(String(p)));
      await ipc.browserSetFiles(id, rutas);
      const target = tieneTarget(a) ? targetDe(a) : { role: "file" };
      const res = await locator.actuar(id, target, "el.click();", Number(a.timeout_ms ?? 6000));
      if (!res.ok) {
        await ipc.browserSetFiles(id, []); // desarmar: nadie hereda mis archivos
        throw new Error(`no encontre el campo de archivos: ${res.reason}`);
      }
      await new Promise((r) => setTimeout(r, 400));
      const n = await evalInBrowser(
        id,
        `(() => { const i = document.querySelector("input[type=file]"); return i && i.files ? i.files.length : 0 })()`,
      );
      return { uploaded: rutas, archivos_en_el_campo: n, ...res };
    }

    // SESION LIMPIA: borra cookies y datos de TODOS los sitios. El uso real es
    // ver el producto de Daniel como lo ve un extraño — con la sesion guardada
    // su propia landing abre logueada y nunca ve su onboarding ni su muro de
    // pago. {reload:false} para limpiar sin recargar.
    case "browser_clear_session": {
      await ipc.browserClearSession();
      if (a.reload !== false) {
        const id = actions.browserId();
        if (id != null) await ipc.browserNav(id, "reload");
      }
      return { cleared: true };
    }

    // EXPANDIR el campo del navegador a toda la pantalla (o volver). El arbol
    // no se toca: contraer devuelve el layout exacto.
    case "browser_expand": {
      const id = requireBrowser(a);
      const s = st();
      const mio = T.leafOfBrowserId(s.root, id);
      const on = a.on !== undefined ? Boolean(a.on) : s.soloLeaf == null;
      s.set({ soloLeaf: on ? (mio ?? null) : null });
      return { expanded: on };
    }

    // PDF de la pagina completa (createPDFWithConfiguration de WebKit)
    case "browser_pdf": {
      const id = requireBrowser(a);
      const path = await expandTilde(String(a.path ?? "/tmp/sfterm-browser.pdf"));
      await ipc.browserPdf(id, path);
      return { path };
    }

    // scroll vertical {dy} px (negativo = arriba)
    case "browser_scroll": {
      const id = requireBrowser(a);
      const dy = Number(a.dy ?? 600);
      return await evalInBrowser(
        id,
        `(() => { window.scrollBy(0, ${dy}); return { y: window.scrollY, max: document.body ? document.body.scrollHeight : 0 }; })()`,
      );
    }

    // EXPRESION JS arbitraria en la pagina (el verbo de poder del agente)
    case "browser_eval": {
      if (!a.js) throw new Error("js requerido");
      return await evalInBrowser(requireBrowser(a), String(a.js));
    }

    // PNG SOLO del panel del navegador — la mitad "ver" del lazo
    // {w,h} = MEDIDA EXACTA en px CSS. Es lo que vuelve reproducible una
    // lamina: sin ella el ancho es el del panel, o sea el layout que Daniel
    // tuviera puesto ese dia. Un render que depende del tamaño de tu ventana
    // no es un render, es una casualidad.
    case "browser_snap": {
      const path = String(a.path ?? "/tmp/sfterm-browser-snap.png");
      const w = a.w != null ? Number(a.w) : undefined;
      const h = a.h != null ? Number(a.h) : undefined;
      if ((w == null) !== (h == null)) {
        throw new Error("w y h van JUNTOS: una medida a medias saldria deformada");
      }
      await ipc.browserSnap(requireBrowser(a), path, w, h);
      return { path, ...(w != null ? { w, h } : {}) };
    }

    case "browser_close": {
      const id = actions.browserId();
      if (id == null) return { closed: false };
      const hit = T.leafOfBrowser(st().root);
      if (hit) actions.closeTab(hit.leaf.id, hit.index);
      else await ipc.browserClose(id);
      return { closed: true };
    }

    // CONSOLA de la pagina: lo que el hook de documentStart capturo
    // (console.* + excepciones + rejections). {n?} ultimas entradas.
    case "browser_console": {
      const id = requireBrowser(a);
      const n = Math.min(Number(a.n ?? 50), 300);
      const res = await evalInBrowser(
        id,
        `window.__sfDebug ? { entries: window.__sfDebug.console.slice(-${n}) } : null`,
      );
      return res ?? { entries: [], note: "pagina cargada sin hook (recarga con browser_nav reload)" };
    }

    // RED de la pagina: fetch/XHR con status y duracion. {n?} ultimas.
    // {bodies: true} incluye el CUERPO de las respuestas json/text (cap 2KB
    // c/u, lo captura el hook) — debugging de APIs viendo el error exacto.
    case "browser_net": {
      const id = requireBrowser(a);
      const n = Math.min(Number(a.n ?? 50), 150);
      const strip = a.bodies ? "e" : "(({ body, ...r }) => r)(e)";
      const res = await evalInBrowser(
        id,
        `window.__sfDebug ? { requests: window.__sfDebug.net.slice(-${n}).map((e) => ${strip}) } : null`,
      );
      return res ?? { requests: [], note: "pagina cargada sin hook (recarga con browser_nav reload)" };
    }

    // ESPERAR. Cuatro formas, de la mas floja a la mas exigente:
    //   {text}      texto visible en la pagina
    //   {selector}  que exista ese css
    //   {fn}        una EXPRESION JS que se vuelva verdadera (la general)
    //   {idle}      la RED en reposo: sin fetch/XHR nuevos por 600ms (lo que
    //               de verdad quieres antes de leer una SPA — que exista el
    //               div no significa que ya tenga datos dentro)
    //   {role,name} o cualquier target: espera a que sea ACCIONABLE de verdad
    //               (visible + quieto + habilitado + destapado), no solo que
    //               exista — que es la diferencia entre esperar y creer
    case "browser_wait": {
      const id = requireBrowser(a);
      const timeout = Math.min(Number(a.timeout_ms ?? 10000), 60000);
      const t0 = Date.now();

      if (a.idle) {
        let quieto = 0;
        let ultimo = -1;
        while (Date.now() - t0 < timeout) {
          const n = Number(
            await evalInBrowser(id, "(window.__sfDebug ? window.__sfDebug.net.length : 0)").catch(
              () => 0,
            ),
          );
          quieto = n === ultimo ? quieto + 1 : 0;
          ultimo = n;
          if (quieto >= 3) return { idle: true, requests: n, ms: Date.now() - t0 };
          await new Promise((r) => setTimeout(r, 200));
        }
        return { idle: false, ms: Date.now() - t0, timeout: true };
      }

      if (a.role || a.placeholder || a.label) {
        const res = await locator.chequear(id, targetDe(a), timeout);
        return { found: res.ok, reason: res.reason, tag: res.tag, ms: Date.now() - t0 };
      }

      const cond = a.fn
        ? `!!(${String(a.fn)})`
        : a.selector
          ? `!!document.querySelector(${JSON.stringify(String(a.selector))})`
          : a.text
            ? `(document.body ? document.body.innerText.includes(${JSON.stringify(String(a.text))}) : false)`
            : null;
      if (!cond) throw new Error("selector, text, fn, idle o role requerido");
      while (Date.now() - t0 < timeout) {
        if ((await evalInBrowser(id, cond).catch(() => false)) === true) {
          return { found: true, ms: Date.now() - t0 };
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      return { found: false, ms: Date.now() - t0, timeout: true };
    }

    // ELEMENT PICKER (28 jul): Daniel SEÑALA un elemento y me llega como
    // datos. Si el ya señalo con el boton ⊹ del chrome, el buffer se drena al
    // instante; si no, se arma el modo pick y se espera su click (Esc cancela,
    // navegar cancela). timeout_ms default 45s.
    case "browser_pick": {
      const manual = pick.takeLastPick();
      if (manual) return manual;
      const id = requireBrowser(a);
      await pick.armPick(id);
      const timeout = Math.min(Number(a.timeout_ms ?? 45000), 180000);
      return await pick.pollPick(id, timeout);
    }

    // BUSCAR EN LA PAGINA (CSS Custom Highlight, sin tocar el DOM):
    // {text} busca y resalta todo; {dir: "next"|"prev"} avanza; {clear: true}
    // limpia. Devuelve {count, index}.
    case "browser_find": {
      const id = requireBrowser(a);
      if (a.clear) {
        await findpage.clear(id);
        return { cleared: true };
      }
      if (a.dir === "next") return await findpage.next(id);
      if (a.dir === "prev") return await findpage.prev(id);
      if (!a.text) throw new Error("text, dir o clear requerido");
      return await findpage.search(id, String(a.text));
    }

    // PNG de la PAGINA COMPLETA (no solo el viewport): mide scrollHeight,
    // estira el frame nativo, snapshotea y lo restaura. Techo 16000px.
    case "browser_fullsnap": {
      const id = requireBrowser(a);
      const path = String(a.path ?? "/tmp/sfterm-browser-fullsnap.png");
      const h = Number(
        await evalInBrowser(
          id,
          "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)",
        ),
      );
      await ipc.browserFullsnap(id, path, Number.isFinite(h) && h > 0 ? h : 2000);
      return { path, height: h };
    }

    // DESCARGA directa por url ({path?} destino exacto; default ~/Downloads
    // con nombre sugerido). El estado se sigue con browser_downloads.
    case "browser_download": {
      const id = requireBrowser(a);
      if (!a.url) throw new Error("url requerida");
      const path = a.path ? await expandTilde(String(a.path)) : undefined;
      await ipc.browserDownload(id, String(a.url), path);
      return { started: true };
    }

    // estado de TODAS las descargas de la sesion (running/done/failed + dest)
    case "browser_downloads": {
      return { downloads: await ipc.browserDownloads() };
    }

    // DIALOGOS JS de la pagina (alert/confirm/prompt). Sin args: lista los
    // pendientes. {accept, text?, id?}: responde (id default = el primero).
    // El JS de la pagina esta BLOQUEADO esperando — semantica fiel de alert.
    case "browser_dialog": {
      const pending = await ipc.browserDialogs();
      if (a.accept === undefined) return { dialogs: pending };
      const target = a.id != null ? pending.find((d) => d.id === Number(a.id)) : pending[0];
      if (!target) throw new Error("no hay dialogo pendiente");
      await ipc.browserDialogReply(
        target.id,
        Boolean(a.accept),
        a.text != null ? String(a.text) : undefined,
      );
      return { answered: target.id, kind: target.kind };
    }

    // HISTORIAL del navegador: {n?} ultimas, {q?} filtro por url/titulo
    case "browser_history": {
      const n = Math.min(Number(a.n ?? 20), 200);
      return { history: bhistory.searchHist(a.q ? String(a.q) : "", n) };
    }

    // zoom del contenido: {factor?} 0.4-3 (default 1 = reset)
    // factor 1 ademas DEVUELVE el navegador al ajuste automatico al panel;
    // cualquier otro valor lo congela en lo que el agente pidio (core/autofit).
    case "browser_zoom": {
      const id = requireBrowser(a);
      const factor = Number(a.factor ?? 1);
      await ipc.browserZoom(id, factor);
      autofit.manual(id, factor);
      return { factor, autofit: Math.abs(factor - 1) < 0.001 };
    }

    // MODO iPHONE: {on?} (default toggle) — viewport ~390px + UA movil + reload
    case "browser_mobile": {
      const id = requireBrowser(a);
      const s = st();
      const prev = s.browserUx[id] ?? { mobile: false, extraH: 0 };
      const on = a.on !== undefined ? Boolean(a.on) : !prev.mobile;
      s.set({ browserUx: { ...s.browserUx, [id]: { ...prev, mobile: on } } });
      await ipc.browserSetMobile(id, on);
      await ipc.browserNav(id, "reload");
      return { mobile: on };
    }

    // ROOT del sidebar (29 jul, multi-repo): sin args devuelve el actual;
    // {path} cambia de repo (re-apunta arbol + source control + watcher).
    // El camino conversacional del picker: "abreme el repo de sflow".
    case "root": {
      if (a.path) {
        const p = await expandTilde(String(a.path));
        await actions.setTreeRoot(p);
      }
      const s = st();
      return { root: s.treeRoot, view: s.sideView };
    }

    // ---- SOURCE CONTROL espejo (28 jul): el repo como datos, todo LECTURA ----

    // rama, upstream, ⇡ahead/⇣behind, dirty. {fetch:true} refresca la nube
    // antes (git fetch — SOLO fetch, tolerante a offline). {root} opcional.
    case "git_state": {
      const root = a.root ? await expandTilde(String(a.root)) : st().treeRoot;
      if (a.fetch) {
        await ipc
          .shellCapture("git fetch --quiet 2>&1 | head -3; true", root)
          .catch(() => "");
      }
      const state = await ipc.gitState(root);
      void actions.refreshScm();
      return state;
    }

    // historial con la marca nube-vs-solo-local: {n?, skip?, root?}
    case "git_log": {
      const root = a.root ? await expandTilde(String(a.root)) : st().treeRoot;
      return await ipc.gitLog(root, Number(a.skip ?? 0), Number(a.n ?? 30));
    }

    // VERBO DE DIRECTOR: pinta el detalle de un commit en el visor de Daniel
    // (y devuelve la ruta del .patch por si quiero leerlo yo)
    case "show_commit": {
      if (!a.hash) throw new Error("hash requerido");
      const root = a.root ? await expandTilde(String(a.root)) : st().treeRoot;
      const path = await ipc.gitCommitFile(root, String(a.hash));
      actions.openFileTab(path, "auto");
      return { shown: path };
    }

    // ---- CHECKPOINTS de agente: la red de deshacer (refs ocultos) ----
    // El RESTORE vive SOLO aqui (conversacional) — jamas hay boton en la UI.

    case "checkpoint_save": {
      const root = a.root ? await expandTilde(String(a.root)) : st().treeRoot;
      const info = await ipc.checkpointSave(root, a.label ? String(a.label) : undefined);
      void actions.refreshScm();
      return info;
    }

    case "checkpoint_list": {
      const root = a.root ? await expandTilde(String(a.root)) : st().treeRoot;
      return await ipc.checkpointList(root, a.n ? Number(a.n) : undefined);
    }

    // que cambio DESDE la foto. {show:true} ademas lo pinta en el visor
    case "checkpoint_diff": {
      if (!a.id) throw new Error("id requerido");
      const root = a.root ? await expandTilde(String(a.root)) : st().treeRoot;
      if (a.show) {
        const path = await ipc.checkpointDiffFile(root, String(a.id));
        actions.openFileTab(path, "auto");
        return { shown: path };
      }
      return { patch: await ipc.checkpointDiff(root, String(a.id)) };
    }

    // regresa el working tree a la foto. Antes de tocar nada se auto-captura
    // "pre-restore": el propio restore es deshacible. Solo-conversacional.
    case "checkpoint_restore": {
      if (!a.id) throw new Error("id requerido");
      const root = a.root ? await expandTilde(String(a.root)) : st().treeRoot;
      const info = await ipc.checkpointRestore(root, String(a.id));
      void actions.refreshGit();
      return info;
    }

    // busqueda por contenido (misma que ⌘⇧F)
    case "search": {
      const q = String(a.q ?? "");
      if (q.trim().length < 2) throw new Error("q muy corta");
      return await ipc.fsSearch(st().treeRoot, q, a.n ? Number(a.n) : 50);
    }

    // manda texto a una terminal. submit=false para no dar enter.
    // ready=true espera a que el proceso arranque (para agentes recien abiertos)
    case "send": {
      const id = Number(a.id);
      if (!manager.get(id)) throw new Error(`no existe la terminal ${id}`);
      const text = String(a.text ?? "");
      if (a.ready) {
        await actions.sendWhenReady(id, text);
      } else {
        if (text.includes("\n")) manager.paste(id, text);
        else await ipc.ptyWrite(id, text);
        if (a.submit !== false) {
          setTimeout(() => void ipc.ptyWrite(id, "\r"), 120);
        }
      }
      return { sent: true };
    }

    // ultimas N lineas CON CONTENIDO (lo que un humano ve). En modo "own"
    // lee del engine de Rust; en xterm, del buffer local.
    case "read": {
      const id = Number(a.id);
      if (!manager.get(id)) throw new Error(`no existe la terminal ${id}`);
      const n = Math.min(Number(a.lines ?? 80), 1000);
      return { text: await manager.readTail(id, n) };
    }

    // bloques semanticos (motor propio, OSC 133): lista de comandos con
    // exit code y duracion — estructura, no scrape de pantalla
    case "blocks": {
      const id = Number(a.id);
      if (!manager.get(id)) throw new Error(`no existe la terminal ${id}`);
      return await ipc.engineBlocks(id, a.n ? Number(a.n) : undefined);
    }

    // ultimo bloque (o block_id explicito) CON su output completo
    case "block_last": {
      const id = Number(a.id);
      if (!manager.get(id)) throw new Error(`no existe la terminal ${id}`);
      return await ipc.engineBlockText(
        id,
        a.block_id != null ? Number(a.block_id) : undefined,
        a.lines ? Number(a.lines) : undefined,
      );
    }

    // verdad del piso de una terminal: el sid que su PTY corre DE VERDAD
    // (term_session: fg → claude → jsonl por nacimiento o --resume en argv).
    // null = sin claude vivo o sin match. Debug + skill sfterm-gate.
    case "truth": {
      const id = Number(a.id);
      if (!manager.get(id)) throw new Error(`no existe la terminal ${id}`);
      // sid + path real del jsonl + config_dir (bro-aware desde 21 jul pm)
      const info = await ipc.termSession(id);
      return info ?? { sid: null };
    }

    case "show":
      actions.showTerm(Number(a.id));
      return { shown: true };

    case "close":
      actions.closePanel(Number(a.id));
      return { closed: true };

    // screenshot de la ventana (PNG, sin TCC)
    case "snap": {
      const path = String(a.path ?? "/tmp/sfterm-gate-snap.png");
      await ipc.snapWindow(path);
      return { path };
    }

    default:
      throw new Error(`op desconocida: ${op}`);
  }
}

export function startGate() {
  // el guard protege SOLO el poll/claim, no el dispatch: un send{ready:true}
  // puede tardar 60s (sendWhenReady) y con el busy viejo secuestraba TODO el
  // gate — list/ping muertos, gate.py en timeout (bug real 17 jul)
  let polling = false;
  setInterval(() => {
    if (polling) return;
    polling = true;
    void (async () => {
      try {
        const cmd = await ipc.gatePoll();
        if (!cmd) return;
        const id = String(cmd.__id ?? "");
        const op = String(cmd.op ?? "");
        // dispatch concurrente: cada comando corre solo y responde solo
        void (async () => {
          let res: unknown;
          try {
            res = { ok: true, data: await dispatch(op, cmd) };
          } catch (e) {
            res = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
          if (id) await ipc.gateResult(id, JSON.stringify(res)).catch(() => {});
        })();
      } catch {
        /* backend sin gate: silencio */
      } finally {
        polling = false;
      }
    })();
  }, 600);
}
