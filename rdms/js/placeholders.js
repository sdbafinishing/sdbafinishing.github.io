/**
 * SDBA RDMS — Draw placeholder grammar (shared)
 *
 * A draw template can seed a future race's lane with a placeholder that
 * references prior results. Three forms (all case-insensitive):
 *
 *   R{n}P{p}          — position p in race n (single race; the original/default).
 *                       e.g. R16P3 = "3rd in race 16". UNSCORED + points races
 *                       use this — it's the default and stays unchanged.
 *   R{list}P{p}       — position p by COMBINED (pooled) exported time across the
 *                       listed races (scoring method #1, "rank by time across
 *                       multiple races in the same round").
 *                       e.g. R1-3,5P2 = "2nd fastest across races 1,2,3,5".
 *   SUMR{list}P{p}    — position p by SUM of each team's exported times across
 *                       the listed races (scoring method #2, "rank by sum of
 *                       times across multiple rounds").
 *                       e.g. SUMR1-3,5P2 = "2nd by total time over races 1,2,3,5".
 *
 * {list} accepts the same comma/dash ranges as division-config race lists,
 * e.g. "1-3,5" -> [1,2,3,5].
 *
 * A single-race list (R5P2) is reported as kind 'single' so the resolver keeps
 * the exact legacy behaviour (look up computed_position in that one race).
 */

// SUM must be tested before the plain pooled form (both could otherwise be
// mistaken for a leading-letter match). Lists allow digits, commas, dashes.
const SUM_RE = /^SUMR([\d,\-]+)P(\d+)$/i;
const POOL_RE = /^R([\d,\-]+)P(\d+)$/i;

/** Parse "1-3,5" -> [1,2,3,5]. Returns [] if any token is malformed. */
export function parseRaceList(input) {
  const out = new Set();
  for (const part of String(input || '').split(',')) {
    const tok = part.trim();
    if (!tok) continue;
    const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      const lo = Math.min(a, b), hi = Math.max(a, b);
      for (let n = lo; n <= hi; n++) out.add(n);
    } else if (/^\d+$/.test(tok)) {
      out.add(parseInt(tok, 10));
    } else {
      return []; // malformed token -> not a valid list
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Parse a cell value into a placeholder descriptor, or null if it isn't one.
 * @param {string} cell
 * @returns {null | {kind: 'single'|'pooled'|'sum', races: number[], position: number, raw: string}}
 */
export function parsePlaceholder(cell) {
  const s = String(cell || '').trim();
  if (!s) return null;

  let m = s.match(SUM_RE);
  if (m) {
    const races = parseRaceList(m[1]);
    if (!races.length) return null;
    return { kind: 'sum', races, position: parseInt(m[2], 10), raw: s };
  }

  m = s.match(POOL_RE);
  if (m) {
    const races = parseRaceList(m[1]);
    if (!races.length) return null;
    return {
      kind: races.length === 1 ? 'single' : 'pooled',
      races,
      position: parseInt(m[2], 10),
      raw: s,
    };
  }

  return null;
}

/** Convenience: is this cell value any kind of placeholder? */
export function isPlaceholder(cell) {
  return parsePlaceholder(cell) !== null;
}
