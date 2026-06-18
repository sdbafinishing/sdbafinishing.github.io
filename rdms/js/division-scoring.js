/**
 * SDBA RDMS — Division scoring helpers (shared, DB-driven)
 *
 * Extracted from pages/division-config.js so both the divisions editor AND
 * the draw-import path can derive race scoring flags + division assignment
 * from the same logic without the import path pulling in the page module.
 */
import { db, getRace, saveRace, getAllDivisions } from './db.js';

/**
 * Derive each round's scoring flag from the division's progression graph.
 *
 * A progression edge (A → B) is "1:1" iff A has exactly one outgoing
 * progression AND B has exactly one incoming progression. Rounds linked by
 * 1:1 edges form chains. Within each chain, scoring positions are assigned by
 * chain position:
 *   length 1  → no chain, all N (no scoring without a progression edge)
 *   length 2  → R1, RFinal
 *   length 3  → R1, R2, RFinal
 *   length 4+ → R1, R2, N, …, N, RFinal
 * Any round not on a 1:1 chain → 'N'.
 *
 * @param {Array<number>} roundIds  every round in the division
 * @param {Array<{from_round_id:number, to_round_id:number}>} edges
 * @returns {Map<number, 'N'|'R1'|'R2'|'RFinal'>}
 */
export function computeChainScoringFlags(roundIds, edges) {
  const flag = new Map();
  for (const id of roundIds) flag.set(id, 'N');

  // Degree counts
  const outDeg = new Map();
  const inDeg = new Map();
  for (const id of roundIds) { outDeg.set(id, 0); inDeg.set(id, 0); }
  for (const e of edges) {
    outDeg.set(e.from_round_id, (outDeg.get(e.from_round_id) || 0) + 1);
    inDeg.set(e.to_round_id, (inDeg.get(e.to_round_id) || 0) + 1);
  }

  // Keep only "1:1" edges
  const oneToOne = edges.filter(e =>
    outDeg.get(e.from_round_id) === 1 && inDeg.get(e.to_round_id) === 1,
  );
  if (oneToOne.length === 0) return flag;

  // Build next-pointer (each from has at most one 1:1 successor) and a set of
  // rounds that ARE the target of some 1:1 edge (so chain starts are rounds
  // with a 1:1 outgoing edge but no 1:1 incoming edge).
  const nextOf = new Map();
  const hasIncoming = new Set();
  for (const e of oneToOne) {
    nextOf.set(e.from_round_id, e.to_round_id);
    hasIncoming.add(e.to_round_id);
  }

  const visited = new Set();
  for (const e of oneToOne) {
    const start = e.from_round_id;
    if (hasIncoming.has(start)) continue; // not a chain head
    if (visited.has(start)) continue;

    // Walk the chain from `start` following `nextOf`.
    const chain = [start];
    let cur = nextOf.get(start);
    while (cur != null && !visited.has(cur)) {
      chain.push(cur);
      visited.add(cur);
      cur = nextOf.get(cur);
    }
    visited.add(start);

    // Assign flags by chain position
    const n = chain.length;
    if (n < 2) continue; // a single round isn't a scored chain
    flag.set(chain[0], 'R1');
    flag.set(chain[n - 1], 'RFinal');
    if (n === 3) {
      flag.set(chain[1], 'R2');
    } else if (n >= 4) {
      flag.set(chain[1], 'R2');
      // chain[2..n-2] stay at default 'N'
    }
  }
  return flag;
}

/**
 * Build race_number → { division_id, scoring_flag } from the SAVED division
 * config in the DB (divisions + division_rounds + division_progressions).
 */
async function buildAssignmentMap() {
  const divisions = await getAllDivisions();
  const assign = new Map();
  if (!divisions.length) return assign;

  const allRounds = await db.division_rounds.toArray();
  const allEdges = await db.division_progressions.toArray();

  for (const div of divisions) {
    const rounds = allRounds.filter(r => r.division_id === div.id);
    if (!rounds.length) continue;
    const edges = allEdges.filter(e => e.division_id === div.id);
    const roundToFlag = computeChainScoringFlags(rounds.map(r => r.id), edges);
    for (const round of rounds) {
      const flag = roundToFlag.get(round.id) || 'N';
      for (const rn of (round.race_numbers || [])) {
        assign.set(rn, { division_id: div.id, scoring_flag: flag });
      }
    }
  }
  return assign;
}

/**
 * Re-apply division_id + scoring_flag to races from the saved division config.
 *
 * The divisions editor skips races that don't exist yet ("resolve on next
 * save"), so when divisions are configured BEFORE draws are imported, the
 * imported races land with no division / scoring. Calling this after a draw
 * import fixes that without the operator re-saving each division by hand.
 *
 * @param {object} [opts]
 * @param {number} [opts.onlyRace]        limit to a single race (import path)
 * @param {boolean} [opts.onlyIfUnassigned=false]  only touch races that have
 *        no division_id yet — preserves division-save results + manual
 *        Schedule-tab overrides on already-assigned races.
 * @returns {Promise<number>} number of races whose assignment changed.
 */
export async function reapplyDivisionAssignments({ onlyRace = null, onlyIfUnassigned = false } = {}) {
  const assign = await buildAssignmentMap();
  if (assign.size === 0) return 0;

  const targets = onlyRace != null ? [onlyRace] : [...assign.keys()];
  let changed = 0;
  for (const rn of targets) {
    const a = assign.get(rn);
    if (!a) continue;
    const race = await getRace(rn);
    if (!race) continue;
    if (onlyIfUnassigned && race.division_id != null) continue;
    let dirty = false;
    if (race.division_id !== a.division_id) { race.division_id = a.division_id; dirty = true; }
    if (race.scoring_flag !== a.scoring_flag) { race.scoring_flag = a.scoring_flag; dirty = true; }
    if (dirty) { await saveRace(race); changed++; }
  }
  return changed;
}
