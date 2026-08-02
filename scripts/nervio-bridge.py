#!/usr/bin/env python3
"""Puente aferente: eventos de SFTerm → cerebro (Levy en el agent-server).

El canal (gate/events.jsonl) es CRUDO: todo bloque, todo silencio, toda
muerte. Este puente es el criterio: filtra señal de ruido (umbral + cooldown)
y entrega SOLO lo que amerita despertar al cerebro. Filosofia watchdog
silencioso: por default no dice nada; cuando habla, es porque importa.

Uso:
  nervio-bridge.py --dry-run    # una pasada: imprime lo que ENVIARIA
  nervio-bridge.py              # una pasada: envia (cron/launchd friendly)
  nervio-bridge.py --follow     # vigila continuo (cada 5s)
  nervio-bridge.py --status     # heartbeat: ultima corrida, entregas, cursor

Config (env):
  SFTERM_NERVIO_URL    destino HTTP (default http://127.0.0.1:3099/chat)
  SFTERM_NERVIO_TOKEN  bearer opcional
  SFTERM_NERVIO_QUIET_COOLDOWN_MIN  cooldown por (term,tipo), default 10

Reglas de señal v1:
  block_end   exit != 0 (y != 130 Ctrl-C) y duracion >= 2s   → fallo real
  block_end   exit == 0 y duracion >= 10 min                 → tarea larga lista
  needs_attention (quiet)                                    → agente atorado
  bell                                                       → CLI pidio atencion
  shell_died  code != 0                                      → shell murio mal

Auditoria anti-organo-muerto: SIEMPRE deja heartbeat en gate/nervio-state.json
(last_run) aunque no haya nada que decir, y todo lo entregado queda en
gate/nervio-delivered.log. `--status` lo muestra.
"""
import json
import os
import pathlib
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gate import CONFIG_BASE, EVENTS, GATE, _cursor_path, _read_new  # noqa: E402

# Config opcional por archivo (para maquinas satelite como la laptop, donde
# el cerebro NO es localhost): config dir de SFTerm/nervio.env con lineas
# SFTERM_NERVIO_URL=... / SFTERM_NERVIO_TOKEN=... Env real gana sobre archivo.
_ENV_FILE = CONFIG_BASE / "nervio.env"
if _ENV_FILE.exists():
    for _ln in _ENV_FILE.read_text().splitlines():
        _ln = _ln.strip()
        if _ln and not _ln.startswith("#") and "=" in _ln:
            _k, _v = _ln.split("=", 1)
            os.environ.setdefault(_k.strip(), _v.strip().strip('"'))

STATE = GATE / "nervio-state.json"
DELIVERED_LOG = GATE / "nervio-delivered.log"
CURSOR = "nervio"

URL = os.environ.get("SFTERM_NERVIO_URL", "http://127.0.0.1:3099/chat")
TOKEN = os.environ.get("SFTERM_NERVIO_TOKEN", "")
MIN_FAIL_MS = 2_000          # fallos mas rapidos = ruido de tecleo
LONG_OK_MS = 10 * 60_000     # exito que tardo >=10 min = avisar que ya
COOLDOWN_S = int(os.environ.get("SFTERM_NERVIO_QUIET_COOLDOWN_MIN", "10")) * 60


def load_state() -> dict:
    if STATE.exists():
        try:
            return json.loads(STATE.read_text())
        except json.JSONDecodeError:
            pass
    return {"cooldowns": {}, "last_run": 0, "delivered_total": 0}


def save_state(st: dict) -> None:
    STATE.write_text(json.dumps(st, ensure_ascii=False, indent=1))


def fmt_dur(ms) -> str:
    if not isinstance(ms, (int, float)):
        return "?"
    s = ms / 1000
    return f"{s:.1f}s" if s < 90 else f"{s / 60:.1f} min"


def signal_of(e: dict) -> str | None:
    """None = ruido. String = linea humana de la señal."""
    ev, term = e.get("ev"), e.get("term")
    cmd = (e.get("cmd") or "").strip()[:80]
    if ev == "block_end":
        exit_code, dur = e.get("exit"), e.get("duration_ms") or 0
        if exit_code not in (0, None, 130) and dur >= MIN_FAIL_MS:
            return f"t{term} «{cmd}» fallo (exit {exit_code}, {fmt_dur(dur)})"
        if exit_code == 0 and dur >= LONG_OK_MS:
            return f"t{term} «{cmd}» TERMINO bien tras {fmt_dur(dur)}"
        return None
    if ev == "needs_attention":
        if e.get("reason") == "hot":
            return f"t{term} «{e.get('proc') or cmd}» lleva 3+ min quemando CPU ({round(e.get('cpu', 0))}%)"
        return f"t{term} «{cmd}» lleva {fmt_dur(e.get('quiet_ms'))} en silencio (¿espera input?)"
    if ev == "bell":
        return f"t{term} sono la campana (el CLI pide atencion)"
    if ev == "shell_died" and e.get("code") not in (0, None):
        return f"t{term}: el shell murio con code {e.get('code')}"
    return None


def cooled(st: dict, e: dict, now: float) -> bool:
    key = f"{e.get('term')}:{e.get('ev')}"
    last = st["cooldowns"].get(key, 0)
    if now - last < COOLDOWN_S:
        return True
    st["cooldowns"][key] = now
    return False


# ---------- S2: sensor de colision (coordina AVISANDO, jamas mandando) ----------

S2_MIN_AGE_MS = 120_000      # ambos bloques corriendo >2 min = trabajo real
S2_COOLDOWN_S = 30 * 60      # un aviso por cwd cada 30 min


def track_running(st: dict, e: dict) -> None:
    """Mantiene el mapa de bloques CORRIENDO por terminal (en nervio-state)."""
    running = st.setdefault("running", {})
    term = str(e.get("term"))
    ev = e.get("ev")
    if ev == "block_start":
        running[term] = {"cwd": e.get("cwd") or "", "cmd": (e.get("cmd") or "")[:60], "since": e.get("t", 0)}
    elif ev == "block_end":
        running.pop(term, None)
    elif ev in ("term_closed", "shell_died"):
        running.pop(term, None)


def s2_collisions(st: dict, now: float) -> list[str]:
    """Dos+ terminales con bloques corriendo >2min en el MISMO cwd → aviso."""
    now_ms = now * 1000
    by_cwd: dict[str, list[tuple[str, dict]]] = {}
    for term, b in st.get("running", {}).items():
        cwd = b.get("cwd") or ""
        if not cwd or now_ms - b.get("since", 0) < S2_MIN_AGE_MS:
            continue
        by_cwd.setdefault(cwd, []).append((term, b))
    out: list[str] = []
    for cwd, items in by_cwd.items():
        if len(items) < 2:
            continue
        key = f"s2:{cwd}"
        if now - st["cooldowns"].get(key, 0) < S2_COOLDOWN_S:
            continue
        st["cooldowns"][key] = now
        quien = " y ".join(f"t{t} «{b['cmd']}»" for t, b in items[:3])
        out.append(f"posible CHOQUE de agentes en {cwd}: {quien} llevan >2 min trabajando en el mismo repo")
    return out


def deliver(lines: list[str], dry: bool) -> None:
    body = (
        "[nervio-sfterm] Señal del nervio aferente de SFTerm (piso de agentes). "
        "Evalua y avisa a Daniel SOLO si amerita; si es esperado, registra y calla.\n"
        + "\n".join(f"• {ln}" for ln in lines)
    )
    if dry:
        print("── DRY RUN — payload que se enviaria ──")
        print(f"POST {URL}")
        print(json.dumps({"message": body}, ensure_ascii=False, indent=2))
        return
    req = urllib.request.Request(
        URL,
        data=json.dumps({"message": body}).encode(),
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}),
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=180) as r:
        r.read()
        print(f"→ entregado al cerebro (HTTP {r.status})")
    with DELIVERED_LOG.open("a") as f:
        for ln in lines:
            f.write(f"{int(time.time())} {ln}\n")


def pass_once(dry: bool) -> int:
    st = load_state()
    now = time.time()
    cp = _cursor_path(CURSOR)
    offset = int(cp.read_text() or "0") if cp.exists() else 0
    raw, new_offset = _read_new(offset)
    signals: list[str] = []
    for ln in raw:
        try:
            e = json.loads(ln)
        except json.JSONDecodeError:
            continue
        track_running(st, e)
        sig = signal_of(e)
        if sig and not cooled(st, e, now):
            signals.append(sig)
    signals.extend(s2_collisions(st, now))
    if signals:
        deliver(signals, dry)
        if not dry:
            st["delivered_total"] = st.get("delivered_total", 0) + len(signals)
    if dry:
        # un dry-run mira SIN dejar huella: ni cursor ni cooldowns tocados
        st = load_state()
    else:
        cp.write_text(str(new_offset))
    st["last_run"] = int(now)
    save_state(st)
    return len(signals)


if __name__ == "__main__":
    args = set(sys.argv[1:])
    if "--status" in args:
        st = load_state()
        age = int(time.time()) - int(st.get("last_run", 0) or 0)
        print(json.dumps({
            "last_run_hace_s": age if st.get("last_run") else None,
            "delivered_total": st.get("delivered_total", 0),
            "events_file": str(EVENTS),
            "events_bytes": EVENTS.stat().st_size if EVENTS.exists() else 0,
        }, ensure_ascii=False, indent=2))
        sys.exit(0)
    dry = "--dry-run" in args
    if "--follow" in args:
        print(f"nervio-bridge: vigilando {EVENTS} → {URL} (Ctrl-C para salir)")
        try:
            while True:
                n = pass_once(dry)
                if n:
                    print(f"  {n} señal(es) {'(dry)' if dry else 'entregadas'}")
                time.sleep(5)
        except KeyboardInterrupt:
            sys.exit(0)
    n = pass_once(dry)
    if n:
        print(f"{n} señal(es) {'(dry run)' if dry else 'entregadas'}")
