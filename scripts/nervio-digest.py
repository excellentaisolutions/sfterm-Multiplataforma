#!/usr/bin/env python3
"""Digest del piso: resumen COMPACTO de las ultimas 24h del canal aferente.

Pensado para el morning briefing (S3 reportando al S5): una mirada de 3 lineas
a lo que el piso de agentes hizo mientras Daniel no miraba. Regla de silencio:
si el piso no trabajo, NO imprime nada (el briefing omite la seccion; el
silencio no se infla).

Uso:
  nervio-digest.py            # ultimas 24h
  nervio-digest.py --hours 12
"""
import json
import sys
import time

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from gate import EVENTS  # noqa: E402

ROTATED = EVENTS.with_suffix(".jsonl.1")


def load_events(since_ms: float) -> list[dict]:
    out: list[dict] = []
    for p in (ROTATED, EVENTS):
        if not p.exists():
            continue
        for ln in p.read_text().splitlines():
            try:
                e = json.loads(ln)
            except json.JSONDecodeError:
                continue
            if e.get("t", 0) >= since_ms:
                out.append(e)
    return out


def fmt_dur(ms) -> str:
    if not isinstance(ms, (int, float)):
        return "?"
    s = ms / 1000
    return f"{s:.0f}s" if s < 90 else f"{s / 60:.0f}min"


def digest(events: list[dict]) -> str:
    ends = [e for e in events if e.get("ev") == "block_end"]
    fails = [e for e in ends if e.get("exit") not in (0, None, 130)]
    longs = [e for e in ends if e.get("exit") == 0 and (e.get("duration_ms") or 0) >= 600_000]
    attn = [e for e in events if e.get("ev") in ("needs_attention", "bell")]
    died = [e for e in events if e.get("ev") == "shell_died" and e.get("code") not in (0, None)]
    terms = {e.get("term") for e in ends} | {e.get("term") for e in attn}
    if not ends and not attn and not died:
        return ""  # piso quieto: silencio

    # cwd mas activo
    by_cwd: dict[str, int] = {}
    for e in ends:
        cwd = e.get("cwd") or "?"
        by_cwd[cwd] = by_cwd.get(cwd, 0) + 1
    top_cwd = max(by_cwd.items(), key=lambda kv: kv[1]) if by_cwd else None

    lines = [
        f"🏭 PISO SFTerm (24h): {len(ends)} bloques en {len(terms)} terminal(es)"
        + (f" · {len(fails)} fallaron" if fails else "")
        + (f" · {len(attn)} pidieron atención" if attn else "")
        + (f" · {len(died)} shell(s) murieron mal" if died else "")
    ]
    if fails:
        det = " · ".join(
            f"t{e.get('term')} «{(e.get('cmd') or '')[:40]}» exit {e.get('exit')}" for e in fails[:3]
        )
        extra = f" (+{len(fails) - 3} más)" if len(fails) > 3 else ""
        lines.append(f"   Fallos: {det}{extra}")
    if longs:
        det = " · ".join(
            f"t{e.get('term')} «{(e.get('cmd') or '')[:40]}» ({fmt_dur(e.get('duration_ms'))})" for e in longs[:2]
        )
        lines.append(f"   Tareas largas OK: {det}")
    if top_cwd and top_cwd[1] > 1:
        lines.append(f"   Más activo: {top_cwd[0]} ({top_cwd[1]} bloques)")
    return "\n".join(lines[:4])


if __name__ == "__main__":
    hours = 24.0
    if "--hours" in sys.argv:
        hours = float(sys.argv[sys.argv.index("--hours") + 1])
    since = (time.time() - hours * 3600) * 1000
    out = digest(load_events(since))
    if out:
        print(out)
