/** Layout de CARRILES del grafo de commits (29 jul 2026) — el algoritmo
 *  clasico de gitgraph, puro y sin DOM: cada fila sabe en que carril va su
 *  punto, que carriles fluyen derecho, cuales se UNEN al punto (merge visto
 *  desde arriba) y cuales NACEN de el (padres extra). El SVG lo pinta
 *  SourceControl.tsx; esto solo decide la topologia.
 *
 *  Invariante del algoritmo: `lanes[i]` = hash que ese carril ESPERA ver mas
 *  abajo. El primer padre hereda el carril del commit; padres extra reusan el
 *  carril que ya los esperaba o abren uno nuevo. Carriles duplicados que
 *  esperaban el mismo commit se cierran uniendose al punto. */

export interface GraphRow {
  /** carril del punto de esta fila */
  lane: number;
  /** carriles vivos ENTRANDO a la fila (hash esperado o null) */
  before: (string | null)[];
  /** carriles vivos SALIENDO de la fila */
  after: (string | null)[];
  /** carriles que se UNEN al punto (venian esperando este commit) */
  joins: number[];
  /** carriles que NACEN del punto (2o+ padre: merges vistos hacia abajo) */
  forks: number[];
}

export function layoutGraph(commits: { full: string; parents: string[] }[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const rows: GraphRow[] = [];
  for (const c of commits) {
    const before = [...lanes];
    const mine: number[] = [];
    lanes.forEach((h, i) => {
      if (h === c.full) mine.push(i);
    });
    let lane: number;
    if (mine.length) {
      lane = mine[0];
    } else {
      const free = lanes.indexOf(null);
      lane = free !== -1 ? free : lanes.length;
    }
    const joins = mine.slice(1);
    for (const j of joins) lanes[j] = null;

    lanes[lane] = c.parents[0] ?? null;
    const forks: number[] = [];
    for (const p of c.parents.slice(1)) {
      const existing = lanes.findIndex((h, i) => h === p && i !== lane);
      if (existing !== -1) {
        forks.push(existing);
        continue;
      }
      const free = lanes.indexOf(null);
      const fl = free !== -1 ? free : lanes.length;
      lanes[fl] = p;
      forks.push(fl);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ lane, before, after: [...lanes], joins, forks });
  }
  return rows;
}

/** ancho maximo de carriles usado (para dimensionar la columna del rail) */
export function maxLanes(rows: GraphRow[]): number {
  let m = 1;
  for (const r of rows) {
    m = Math.max(m, r.before.length, r.after.length, r.lane + 1);
  }
  return m;
}
