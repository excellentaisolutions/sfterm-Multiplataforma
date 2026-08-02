/** Fuzzy matching compartido (⌘P y @menciones): subsecuencia con bonus por
 *  racha y por inicio de palabra (tras / . - _), penalizado por longitud. */
export function fuzzyScore(query: string, target: string): number {
  let qi = 0;
  let score = 0;
  let streak = 0;
  const tl = target.toLowerCase();
  for (let ti = 0; ti < tl.length && qi < query.length; ti++) {
    if (tl[ti] === query[qi]) {
      qi++;
      streak++;
      score += 2 + streak;
      if (ti === 0 || tl[ti - 1] === "/" || tl[ti - 1] === "." || tl[ti - 1] === "-" || tl[ti - 1] === "_") {
        score += 6;
      }
    } else {
      streak = 0;
    }
  }
  if (qi < query.length) return -1;
  return score - target.length * 0.05;
}
