/** SOURCE CONTROL espejo (28 jul 2026) — la zona superior del sidebar derecho.
 *
 *  Responde de un vistazo: ¿que cambie? ¿que esta commiteado pero SIN push
 *  (solo en este disco)? ¿que hay en la nube que no tengo?  Constitucion
 *  AI-first: el panel MUESTRA; commit/push/restore se piden conversando.
 *  Gestos permitidos: colapsar (vista), refresh manual (fetch read-only) y
 *  clicks de LECTURA (archivo → diff, commit → detalle, checkpoint → diff).
 */
import { useMemo, useState } from "react";
import { useStore } from "../core/store";
import * as actions from "../core/actions";
import { layoutGraph, type GraphRow } from "../core/gitgraph";
import { iconForFile } from "../core/icons";
import type { GitCommitInfo } from "../core/types";

/** tiempo relativo compacto ("ahora", "5m", "3h", "2d") */
function rel(epochSecs: number): string {
  const d = Math.max(0, Date.now() / 1000 - epochSecs);
  if (d < 60) return "ahora";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  return `${Math.floor(d / 86400)}d`;
}

const CODE_COLOR: Record<string, string> = {
  M: "var(--yellow, #d7ba7d)",
  U: "var(--green, #6a9955)",
  A: "var(--green, #6a9955)",
  D: "var(--red, #f14c4c)",
  R: "var(--yellow, #d7ba7d)",
  C: "var(--red, #f14c4c)",
};

/** COLOR POR CARRIL (29 jul 2026, pedido de Daniel: "que no sea solo gris
 *  aburrido"). El color no decora: es lo que deja SEGUIR una rama con el ojo
 *  cuando dos lineas se cruzan — en gris, un merge de tres carriles es un
 *  nudo, y ese es justo el momento en que quieres leer el grafo.
 *
 *  Hex literal y NO variables del tema a proposito: la paleta tiene que decir
 *  lo mismo en `arbrain` (zinc oscuro) y en `paper` (claro), y los vars de
 *  tema cambian con el fondo. Estos ocho son de luminosidad media, asi que
 *  contrastan contra los dos. El primero es el morado de la marca porque el
 *  carril 0 es el tronco (main casi siempre) y merece el color de la casa. */
const LANE_COLORS = [
  "#A968F7", // morado marca — el tronco
  "#4EC9B0", // verde azulado
  "#E2A03F", // ambar (oro de marca, bajado para que no vibre)
  "#5B9BD5", // azul
  "#E06C9F", // rosa
  "#7BC96F", // verde
  "#C586C0", // malva
  "#D98B6A", // terracota
];
const laneColor = (i: number) => LANE_COLORS[((i % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];

/** El RAIL del grafo de una fila (estilo VS Code Graph, minimalista):
 *  verticales de los carriles que fluyen, curvas para joins (arriba) y forks
 *  (abajo), y el punto del commit — RELLENO si es SOLO LOCAL, hueco si ya
 *  esta en la nube. Ambos en el color de SU carril: el relleno sigue siendo
 *  la marca de "sin push", asi que colorear no le quita el significado. */
const LANE_W = 10;
const ROW_H = 22;
function Rail({ g, c, hasUpstream }: { g: GraphRow; c: GitCommitInfo; hasUpstream: boolean }) {
  const x = (i: number) => 5 + i * LANE_W;
  const cy = ROW_H / 2;
  const cx = x(g.lane);
  // cada trazo viaja con SU carril: es lo que permite seguir una rama con el
  // ojo a traves de un cruce. Una curva de merge se pinta del color del carril
  // que ENTRA (no del punto), que es la rama cuya historia estas siguiendo.
  const paths: { d: string; lane: number }[] = [];
  // mitad superior: carriles que ENTRAN (derecho, o curvando hacia el punto)
  g.before.forEach((h, i) => {
    if (h == null) return;
    if (i === g.lane || g.joins.includes(i)) {
      paths.push({ d: `M ${x(i)} 0 C ${x(i)} ${cy * 0.7}, ${cx} ${cy * 0.45}, ${cx} ${cy}`, lane: i });
    } else {
      paths.push({ d: `M ${x(i)} 0 L ${x(i)} ${cy}`, lane: i });
    }
  });
  // mitad inferior: carriles que SALEN (derecho, o naciendo del punto)
  g.after.forEach((h, i) => {
    if (h == null) return;
    if (i === g.lane || g.forks.includes(i)) {
      paths.push({
        d: `M ${cx} ${cy} C ${cx} ${cy * 1.55}, ${x(i)} ${ROW_H - cy * 0.3}, ${x(i)} ${ROW_H}`,
        lane: i,
      });
    } else if (g.before[i] != null) {
      paths.push({ d: `M ${x(i)} ${cy} L ${x(i)} ${ROW_H}`, lane: i });
    }
  });
  const local = hasUpstream && !c.in_cloud;
  const col = laneColor(g.lane);
  const w = 10 + Math.max(g.before.length, g.after.length, g.lane + 1) * LANE_W;
  return (
    <svg className="scm-rail" width={w} height={ROW_H}>
      {paths.map((p, i) => (
        <path key={i} d={p.d} stroke={laneColor(p.lane)} strokeWidth="1.5" fill="none" opacity="0.85" />
      ))}
      <circle
        cx={cx}
        cy={cy}
        r={c.parents.length > 1 ? 3 : 3.5}
        fill={local ? col : "var(--panel)"}
        stroke={col}
        strokeWidth="1.4"
      />
    </svg>
  );
}

export default function SourceControl() {
  const scm = useStore((s) => s.scm);
  const git = useStore((s) => s.git);
  const treeRoot = useStore((s) => s.treeRoot);
  const [busy, setBusy] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);
  // ANTES del early return (reglas de hooks): el layout del grafo
  const graph = useMemo(() => layoutGraph(scm?.log ?? []), [scm?.log]);

  // vista completa del sidebar (switcher 29 jul): sin repo git, decirlo
  if (!scm?.sync?.is_repo) {
    return (
      <div className="scm scm--view">
        <div className="scm-empty">este folder no es un repo git</div>
      </div>
    );
  }
  const { sync } = scm;

  const files = Object.entries(git?.files ?? {}).sort(
    (a, b) => a[0].localeCompare(b[0]),
  );
  const shownFiles = showAllFiles ? files : files.slice(0, 12);

  const refresh = () => {
    if (busy) return;
    setBusy(true);
    void actions.scmFetch().finally(() => setBusy(false));
  };

  return (
    <div className="scm scm--view">
      <div className="side-head scm-head">
        <span>Source Control</span>
        <span className="spacer" />
        <button
          className={`icon-btn scm-refresh ${busy ? "busy" : ""}`}
          title="Refrescar (git fetch, solo lectura)"
          onClick={refresh}
        >
          ⟳
        </button>
      </div>

      <div className="scm-body">
          {/* ── estado de sincronia: la joya ── */}
          <div className="scm-sync" title={sync.upstream ? `${sync.branch} → ${sync.upstream}` : sync.branch}>
            <span className="scm-branch">{sync.branch}</span>
            {sync.upstream ? (
              <>
                <span className="scm-dim">→ {sync.upstream.replace(/^origin\//, "o/")}</span>
                <span className="spacer" />
                {sync.ahead > 0 && (
                  <span className="scm-ahead" title={`${sync.ahead} commits SOLO en este disco (sin push)`}>
                    ⇡{sync.ahead}
                  </span>
                )}
                {sync.behind > 0 && (
                  <span className="scm-behind" title={`${sync.behind} commits en la nube que no tienes`}>
                    ⇣{sync.behind}
                  </span>
                )}
                {sync.ahead === 0 && sync.behind === 0 && (
                  <span className="scm-insync" title="en paz con la nube">✓</span>
                )}
              </>
            ) : (
              <>
                <span className="spacer" />
                <span className="scm-noremote" title="este repo no tiene remote: todo vive SOLO en este disco">
                  {sync.has_remote ? "sin upstream" : "sin remote"}
                </span>
              </>
            )}
          </div>

          {/* ── cambios del working tree ── */}
          {files.length > 0 && (
            <div className="scm-sect">
              <div className="scm-sect-head">
                cambios <span className="scm-count">{files.length}</span>
              </div>
              {shownFiles.map(([relPath, code]) => (
                <div
                  key={relPath}
                  className="scm-row"
                  title={`${relPath} — click: ver diff`}
                  onClick={() => actions.openFileTab(`${treeRoot}/${relPath}`, "diff")}
                >
                  {/* ICONO DE TIPO al inicio y CODIGO al final, como VS Code
                      (29 jul, pedido de Daniel). El icono es el MISMO
                      `iconForFile` del arbol y del ⌘P: un solo mapa de tipos
                      en toda la app, asi un .md se ve igual lo mires donde lo
                      mires. El codigo se fue a la derecha porque ahi ya no
                      compite con el icono por el arranque de la fila — que es
                      donde el ojo barre para encontrar un archivo. */}
                  <img
                    className="ficon"
                    src={iconForFile(relPath.split("/").pop() ?? relPath)}
                    alt=""
                    draggable={false}
                  />
                  <span className="scm-file">{relPath.split("/").pop()}</span>
                  <span className="scm-dir">
                    {relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : ""}
                  </span>
                  <span className="scm-code" style={{ color: CODE_COLOR[code] ?? "var(--dim)" }}>
                    {code}
                  </span>
                </div>
              ))}
              {files.length > 12 && !showAllFiles && (
                <div className="scm-row scm-more" onClick={() => setShowAllFiles(true)}>
                  … {files.length - 12} más
                </div>
              )}
            </div>
          )}

          {/* ── el GRAFO: topologia de ramas + chips de refs + nube-vs-local ── */}
          <div className="scm-sect">
            <div className="scm-sect-head">commits</div>
            <div className="scm-log">
              {scm.log.map((c, i) => (
                <div
                  key={c.full}
                  className="scm-row"
                  title={`${c.hash} · ${c.author} · ${
                    scm.hasUpstream ? (c.in_cloud ? "en la nube" : "SOLO LOCAL (sin push)") : "local"
                  }\nclick: ver el commit`}
                  onClick={() => void actions.openCommitDetail(c.hash)}
                >
                  {graph[i] && <Rail g={graph[i]} c={c} hasUpstream={scm.hasUpstream} />}
                  {c.refs.map((r) => (
                    <span
                      key={r.name}
                      className={`scm-chip ${r.remote ? "remote" : "local"} ${r.head ? "head" : ""}`}
                      title={r.remote ? `la nube: ${r.name}` : `rama local: ${r.name}${r.head ? " (HEAD)" : ""}`}
                    >
                      {r.remote ? "☁ " : ""}
                      {r.name}
                    </span>
                  ))}
                  <span className="scm-msg">{c.msg}</span>
                  <span className="scm-when">{rel(c.time)}</span>
                </div>
              ))}
              {scm.log.length >= 50 && (
                <div className="scm-row scm-more" onClick={() => void actions.scmLoadMore()}>
                  … cargar más
                </div>
              )}
            </div>
          </div>

          {/* ── checkpoints: las fotos invisibles (restore = conversacional) ── */}
          {scm.checkpoints.length > 0 && (
            <div className="scm-sect">
              <div className="scm-sect-head">
                checkpoints <span className="scm-count">{scm.checkpoints.length}</span>
              </div>
              {scm.checkpoints.slice(0, 6).map((cp) => (
                <div
                  key={cp.id}
                  className="scm-row"
                  title={`${cp.id} · ${cp.files} archivos difieren del HEAD\nclick: ver que cambio desde la foto — restaurar se pide conversando`}
                  onClick={() => void actions.openCheckpointDiff(cp.id)}
                >
                  <span className="scm-dot cp">◈</span>
                  <span className="scm-msg">{cp.label}</span>
                  <span className="scm-when">{rel(cp.time)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
    </div>
  );
}
