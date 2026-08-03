#!/usr/bin/env python3
"""Cliente de la puerta de agentes de SFTerm.

La app atiende comandos desde su state dir local (AppData/Local en Windows).
Pensado para Levy / Claude Code / crons: operar SFTerm sin tocar la UI.

Uso:
  gate.py ping
  gate.py list
  gate.py spawn  '{"cwd": "~/Developer/business-os", "command": "claude"}'
  gate.py send   '{"id": 3, "text": "corre los tests", "ready": true}'
  gate.py read   '{"id": 3, "lines": 60}'
  gate.py blocks '{"id": 3, "n": 10}'
  gate.py block_last '{"id": 3}'
  gate.py show   '{"id": 3}'
  gate.py close  '{"id": 3}'
  gate.py snap   '{"path": "/tmp/sfterm.png"}'
  gate.py events '{"n": 20}'
  gate.py events '{"cursor": "levy"}'
  gate.py events '{"follow": true}'

Ops (ida — la app responde):
  ping       → la app responde (¿esta abierta?)
  list       → conversaciones: id, title, cwd, proc, visible, focused
  spawn      → abre terminal ({show: false} = fuera de la vista;
               {worktree: true} = crea git worktree rama agente/<ts> y
               spawnea AHI — agentes en paralelo sin chocar) → {id, worktree?}
  send       → texto a una terminal ({submit: false} = sin enter;
               {ready: true} = espera a que el proceso arranque, p.ej. claude)
  read       → ultimas N lineas del buffer (lo que un humano ve)
  blocks     → bloques OSC 133: lista de comandos con exit code y duracion
  block_last → ultimo bloque (o block_id) CON su output — estructura, no scrape
  show       → trae una conversacion a la vista
  close      → MATA la conversacion (proceso incluido)
  truth      → {id} VERDAD DEL PISO: el sid de claude que ESA terminal corre
               de verdad (nacimiento del jsonl o --resume en argv). null =
               sin claude vivo o sin match
  snap       → screenshot PNG de la ventana
  (chat_send/chat_last MURIERON con el chat nativo — purga 21 jul. Para
   conversar con un agente: spawn + send {ready: true} + read/block_last.)

HISTORIAL de conversaciones (la vitrina del rail, 30 jul 2026):
  conv_list   → {n?, q?, fresh?} el historial del DISCO (todas las sesiones
                reales de ~/.claude y ~/.claude-bro; maquinaria de crons y
                cascarones ya filtrados) → [{sid, title, cwd, path,
                config_dir, mtime_ms}]. q busca en titulo+proyecto.
  conv_open   → {sid} DIRECTOR: pinta esa conversacion en el LECTOR de Daniel
                (espejo solo-lectura + barra de continuar). sid acepta prefijo.
  conv_resume → {sid, text?} CONTINUAR: terminal nueva con --resume en su cwd
                y su cuenta; text viaja cuando el agente despierta → {term}
  conv_prefs  → {group_by?: date|project|none, sort_by?: recency|title,
                project?: "<nombre>"|null} filtros de la vitrina (persisten);
                sin args = leerlos → prefs actuales

Verbos de DIRECTOR (Levy pinta la pantalla de Daniel):
  show_file  → {path} abre un archivo en el visor (solo-lectura)
  show_diff  → {path?} ese archivo en modo diff; sin path = TODOS los
               cambios del repo como tabs diff (revision conversacional)
  preview    → {url} overlay iframe del dev server; {close: true} lo cierra;
               sin args busca localhost:PUERTO en la terminal enfocada
  search     → {q, n?} busqueda por CONTENIDO en el proyecto (como ⌘⇧F)

NAVEGADOR DEL AGENTE (ojos y manos sobre la web, dentro de la app):
  Un webview NATIVO (WKWebView en macOS, WebView2 en Windows) como panel del
  tiling (no iframe: github y cia cargan
  normal). VALVULA DE UNA VIA: la pagina jamas gana un canal hacia la app
  (cero IPC); Daniel y el agente SI tienen el puente entero (file://,
  descargas, historial, cuerpos de red). UA nativo de cada plataforma.
  UNO solo: lo que el agente navega es exactamente lo que Daniel contempla.
  El lazo: browser_open → browser_read/browser_snap → browser_click/type → …
  browser_open   → {url?} abre (o enfoca) el navegador; con url navega y
                   ESPERA la carga → {id, url, title, loading, ...}
  browser_goto   → {url} navega (abre el navegador si no existe) y espera.
                   OMNIBOX: dominio pelado → https; texto sin pinta de host →
                   busqueda web; file:///... o /ruta/absoluta → archivo local
                   (acceso de lectura SOLO al folder del archivo)
  browser_nav    → {action: back|forward|reload|stop}
  browser_state  → url/titulo/loading/progress(0-1)/can_back/can_forward
  browser_read   → LA PAGINA COMO DATOS: {url, title, text, links[], inputs[]}
                   ({chars: N} sube el techo del texto, default 18000)
  browser_click  → SEÑALA el elemento de una de 5 formas: {text} visible ·
                   {selector} css · {role, name} SEMANTICO (button/link/textbox/
                   checkbox/tab/heading/combobox/file; `name` = aria-label o
                   texto) · {placeholder} · {label}. El semantico sobrevive
                   rediseños que rompen cualquier selector.
                   ANTES de tocar espera a que este VISIBLE, QUIETO, HABILITADO
                   y ALCANZABLE (que el clic no se lo coma un banner encima), y
                   reintenta hasta {timeout_ms?} (6s). Si no lo logra FALLA
                   diciendo por que: "esta tapado por <div.cookie>", "esta
                   deshabilitado", "no existe en la pagina"
  browser_type   → {text, + cualquier forma de señalar, submit?} escribe en un
                   campo (React-safe). Sin señal busca el primer campo de texto
  browser_upload → {paths[], + como señalar el campo?} SUBE ARCHIVOS sin
                   dialogo nativo: el adaptador construye la selección dentro
                   del panel. Es el setInputFiles de Playwright
  browser_pdf    → {path?} PDF de la pagina completa, paginado por el motor de
                   impresion de WebKit (no es una foto: es texto seleccionable)
  browser_scroll → {dy} px (negativo = arriba)
  browser_eval   → {js} EXPRESION arbitraria en la pagina (el verbo de poder)
  browser_snap   → {path?} PNG SOLO del panel del navegador (default
                   /tmp/sfterm-browser-snap.png) — la mitad "ver" del lazo
  browser_fullsnap → {path?} PNG de la PAGINA COMPLETA (estira el frame al
                   scrollHeight, techo 16000px, y lo restaura) → {path, height}
  browser_pick   → ELEMENT PICKER: Daniel SEÑALA un elemento y llega como
                   datos {selector, tag, text, href, html, rect}. Si el ya
                   señalo con el boton ⊹ del chrome, el buffer se drena al
                   instante; si no, arma el modo pick y espera su click
                   ({timeout_ms?} default 45000). Esc o navegar = cancelado
  browser_console→ {n?} CONSOLA de la pagina: console.* + excepciones +
                   rejections, capturados por hook en documentStart de cada
                   navegación (script document-start) → {entries: [{t, level, text}]}
  browser_net    → {n?} RED de la pagina: fetch/XHR con metodo, url, status,
                   ok y duracion → {requests: [...]}. {bodies: true} incluye
                   el CUERPO de las respuestas json/text (cap 2KB c/u) — para
                   debuggear APIs viendo el error exacto, no solo el 500
  browser_wait   → ESPERAR, de lo flojo a lo exigente: {text} texto visible ·
                   {selector} css · {fn} una EXPRESION JS que se vuelva cierta ·
                   {idle} la RED en reposo (que exista el div no significa que
                   ya tenga datos) · {role,name} que sea ACCIONABLE de verdad,
                   no solo que exista. {timeout_ms?} default 10s
  browser_find   → {text} busca y resalta en la pagina (CSS Highlight, sin
                   tocar el DOM); {dir: next|prev} avanza; {clear: true}
                   limpia → {count, index}. El ⌘F de Daniel usa lo mismo
  browser_download → {url, path?} descarga directa (default ~/Downloads,
                   nombre deduplicado). Los links de descarga de la pagina
                   tambien caen solos a ~/Downloads (delegate nativo)
  browser_downloads → estado de las descargas: {downloads: [{url, dest,
                   state: running|done|failed, error}]}
  browser_dialog → alert/confirm/prompt de la pagina, pintados IN-APP. Sin
                   args: {dialogs} pendientes. {accept, text?, id?} responde
                   (el JS de la pagina esta bloqueado esperando — fiel)
  browser_history→ {n?, q?} historial navegado (url + titulo, cap 200)
  browser_zoom   → {factor?} 0.4-3 del contenido (default 1 = reset)
  browser_mobile → {on?} MODO iPHONE: viewport ~390px + UA movil + reload
                   (default toggle) — probar responsive sin agarrar telefono
  browser_expand → {on?} el navegador toma TODA la pantalla (o vuelve). El
                   arbol no se toca: contraer devuelve el layout exacto (⌘⇧E)
  browser_clear_session → borra cookies y datos de TODOS los sitios y recarga.
                   El uso real: ver el producto de Daniel como lo ve alguien
                   que llega por PRIMERA vez (con la sesion guardada, su propia
                   landing abre logueada y nunca ve su onboarding)
  browser_close  → cierra navegador y pestaña
  Atajos de Daniel DENTRO de la pagina (los captura el hook, la app no los
  ve): Cmd en macOS o Ctrl en Windows + L barra/url · R recargar · F buscar ·
  [/ ] atrás/adelante · +/−/0 zoom del contenido.

SOURCE CONTROL espejo (28 jul 2026 — el repo como datos, todo LECTURA;
  root default = el arbol activo, {root} lo cambia):
  root           → {path?} sin args: el root actual del sidebar y su vista;
                   con path: CAMBIA de repo (re-apunta arbol + source
                   control + watcher). El multi-repo conversacional
  git_state      → rama, upstream, ⇡ahead (sin push) / ⇣behind, dirty,
                   has_remote. {fetch: true} refresca la nube antes
                   (git fetch, SOLO fetch, tolerante a offline)
  git_log        → {n?, skip?} historial con marca in_cloud por commit
                   (false = SOLO LOCAL, el upstream no lo tiene)
  show_commit    → {hash} DIRECTOR: pinta el detalle del commit (.patch) en
                   el visor de Daniel → {shown: path}

CHECKPOINTS de agente (la red de deshacer — refs git OCULTOS en
  refs/sfterm/checkpoints/*, jamas se pushean, capturar NO toca el index
  ni el working tree del usuario; el RESTORE solo existe aqui, jamas boton):
  checkpoint_save    → {label?} foto del repo → {id, label, time, files}
  checkpoint_list    → {n?} fotos recientes (files = archivos que difieren
                       del HEAD actual)
  checkpoint_diff    → {id} que cambio DESDE la foto → {patch};
                       {show: true} ademas lo pinta en el visor
  checkpoint_restore → {id} regresa el working tree a la foto. Antes
                       auto-captura "pre-restore": el restore es deshacible.
                       PEDIR CONFIRMACION a Daniel antes de usarlo

Canal aferente (vuelta — la app habla sola; se lee DIRECTO del archivo,
funciona aun con la app cerrada porque es historia en disco):
  events {"n": N}          → ultimos N eventos de gate/events.jsonl
  events {"cursor": "x"}   → solo eventos NUEVOS desde la ultima lectura del
                             cursor "x" (offset persistido en gate/cursors/)
  events {"follow": true}  → tail -f del canal (Ctrl-C para salir)
  Eventos: block_start, block_end (exit, duration_ms), needs_attention
  (reason=quiet|hot), bell, term_spawned, term_closed, shell_died.

Multi-maquina (un cerebro, varios pisos):
  gate.py --ssh <host> <op> '<json>'
  Corre el MISMO verbo contra el SFTerm de otra maquina via SSH (el repo debe
  vivir alla en ~/Developer/software/sfterm). Ej:
  gate.py --ssh macbook list · gate.py --ssh macbook events '{"n": 10}'
"""
# future import: las anotaciones (dict | None) se vuelven lazy y el python 3.9
# de macOS puede PARSEAR el archivo para llegar al guard de abajo con un error
# util en vez de un TypeError criptico (hallazgo del Levy del MacBook, 16 jul)
from __future__ import annotations

import json
import os
import pathlib
import sys
import time
import uuid

if sys.version_info < (3, 10):
    sys.exit("gate.py necesita python 3.10+ (macOS trae 3.9): usa /opt/homebrew/bin/python3")

# SFTERM_CONFIG_DIR (banco de pruebas): mismo override que la app — un gate
# redirigido habla con la instancia AISLADA, jamas con la que tiene las
# conversaciones reales de Daniel.
_cfg = os.environ.get("SFTERM_CONFIG_DIR", "").strip()
if _cfg:
    CONFIG_BASE = STATE_BASE = pathlib.Path(os.path.expanduser(_cfg))
elif os.name == "nt":
    CONFIG_BASE = pathlib.Path(os.environ.get("APPDATA", pathlib.Path.home() / "AppData" / "Roaming")) / "SFTerm"
    STATE_BASE = pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home() / "AppData" / "Local")) / "SFTerm"
else:
    CONFIG_BASE = STATE_BASE = pathlib.Path.home() / ".config" / "sfterm"
_base = STATE_BASE
GATE = _base / "gate"
EVENTS = GATE / "events.jsonl"


def call(op: str, args: dict | None = None, timeout: float = 25.0) -> dict:
    GATE.mkdir(parents=True, exist_ok=True)
    rid = uuid.uuid4().hex[:12]
    cmd = GATE / f"cmd-{rid}.json"
    res = GATE / f"res-{rid}.json"
    tmp = GATE / f".cmd-{rid}.tmp"
    payload = {"op": op, **(args or {})}
    # ── REMITENTE ──────────────────────────────────────────────────────────
    # QUIEN manda el comando. SFTerm le inyecta SFTERM_TERM_ID a cada terminal
    # que abre (pty.rs), asi que un agente corriendo adentro se identifica solo,
    # sin saber que existe este campo y sin escribir una linea distinta.
    #
    # Es lo que permite recursos POR CONVERSACION: sin remitente, la app tiene
    # que resolver "el navegador" como "el primero del arbol", y cinco agentes
    # terminan actuando sobre la misma ventana web — o peor, sobre la de otro.
    #
    # El que llama SIEMPRE puede ganar: pasar "__term" en el JSON pisa la env
    # (util desde un cron o desde fuera de SFTerm, donde no hay terminal — ahi
    # simplemente no viaja remitente y la app cae al comportamiento compartido).
    if "__term" not in payload:
        env_term = os.environ.get("SFTERM_TERM_ID", "").strip()
        if env_term.isdigit():
            payload["__term"] = int(env_term)
    # escritura atomica: que la app nunca lea un JSON a medias
    tmp.write_text(json.dumps(payload, ensure_ascii=False))
    os.rename(tmp, cmd)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if res.exists():
            try:
                out = json.loads(res.read_text())
            finally:
                res.unlink(missing_ok=True)
            return out
        time.sleep(0.2)
    cmd.unlink(missing_ok=True)
    raise SystemExit("timeout: ¿SFTerm esta abierta?")


# ---------- canal aferente (lectura directa, sin round-trip) ----------

def _cursor_path(name: str) -> pathlib.Path:
    safe = "".join(c for c in name if c.isalnum() or c in "-_") or "default"
    d = GATE / "cursors"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{safe}.offset"


def _read_new(offset: int) -> tuple[list[str], int]:
    """Lineas completas desde offset. Devuelve (lineas, nuevo_offset)."""
    if not EVENTS.exists():
        return [], 0
    size = EVENTS.stat().st_size
    if offset > size:
        offset = 0  # el archivo roto (events.jsonl -> .1): empezar de cero
    with EVENTS.open("rb") as f:
        f.seek(offset)
        chunk = f.read()
    # solo lineas terminadas: una linea a medias se lee en la proxima pasada
    end = chunk.rfind(b"\n")
    if end < 0:
        return [], offset
    lines = chunk[: end + 1].decode("utf-8", "replace").splitlines()
    return [ln for ln in lines if ln.strip()], offset + end + 1


def events_cmd(args: dict) -> None:
    if args.get("follow"):
        offset = EVENTS.stat().st_size if EVENTS.exists() else 0
        try:
            while True:
                lines, offset = _read_new(offset)
                for ln in lines:
                    print(ln, flush=True)
                time.sleep(0.5)
        except KeyboardInterrupt:
            return
    if "cursor" in args:
        cp = _cursor_path(str(args["cursor"]))
        offset = int(cp.read_text() or "0") if cp.exists() else 0
        lines, new_offset = _read_new(offset)
        for ln in lines:
            print(ln)
        cp.write_text(str(new_offset))
        return
    n = int(args.get("n", 20))
    if not EVENTS.exists():
        return
    all_lines = [ln for ln in EVENTS.read_text().splitlines() if ln.strip()]
    for ln in all_lines[-n:]:
        print(ln)


if __name__ == "__main__":
    argv = sys.argv[1:]

    # --ssh <host>: mismo verbo contra el SFTerm de OTRA maquina (un cerebro,
    # varios pisos). Requiere ssh sin password (llave) y el repo alla.
    if argv and argv[0] == "--ssh":
        if len(argv) < 3:
            print(__doc__)
            sys.exit(1)
        host, op = argv[1], argv[2]
        raw = argv[3] if len(argv) > 3 else "{}"
        import shlex
        import subprocess
        remote = (
            "python3 ~/Developer/software/sfterm/scripts/gate.py "
            f"{shlex.quote(op)} {shlex.quote(raw)}"
        )
        r = subprocess.run(["ssh", "-o", "ConnectTimeout=6", host, remote])
        sys.exit(r.returncode)

    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)
    op = argv[0]
    args = json.loads(argv[1]) if len(argv) > 1 else {}
    if op == "events":
        events_cmd(args)
        sys.exit(0)
    out = call(op, args)
    print(json.dumps(out, ensure_ascii=False, indent=2))
    sys.exit(0 if out.get("ok") else 1)
