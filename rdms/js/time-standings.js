/**
 * SDBA RDMS — Time-based standings (scoring methods #1 & #2)
 *
 * Two new ways to rank teams by TIME (the existing points model lives in
 * race.js and is untouched):
 *
 *   #1 pooledTimeStandings — rank teams by their (exported) time POOLED across
 *      a set of races (e.g. all heats in one round). Each team appears once.
 *
 *   #2 sumTimeStandings    — rank teams by the SUM of their (exported) times
 *      across a set of races/rounds. Each team appears once per round.
 *
 * "Exported time" = what the result sheet shows: the full effective time
 * (raw_time_ms + penalty + batch delta) TRUNCATED to centiseconds (the
 * displayed hundredth). We sum/compare the truncated value (that's what's
 * communicated) and use the full millisecond only as a tiebreaker — per the
 * agreed decision.
 *
 * Tiebreak chain (sum):  total exported  ->  final-race rank  ->  total full ms.
 * If two teams are STILL identical after all three, they're returned in
 * `unresolvedTies` so the caller can soft-block export until an operator
 * intervenes manually.
 *
 * Each input "race" is { race_number, lanes, batchDeltaMs }. We run
 * computeRankings on the lanes first (so effective_time_ms + computed_position
 * are fresh), then read effective_time_ms — exactly the value the export uses.
 */
import { computeRankings } from './race.js';

/** Exported ms for a ranked lane: { full, trunc } or null (no rankable time). */
function laneExportedMs(lr) {
  const e = lr.effective_time_ms;
  if (e == null || !Number.isFinite(e)) return null;
  return { full: e, trunc: Math.floor(e / 10) * 10 };
}

/** Run computeRankings on each race's lanes in place (fresh positions/times). */
function rankAll(racesLanes, timeMode) {
  for (const r of racesLanes) {
    computeRankings(r.lanes, timeMode, r.batchDeltaMs || 0);
  }
}

/**
 * Method #1 — pooled-time ranking across a set of races.
 * @param {Array<{race_number:number, lanes:object[], batchDeltaMs?:number}>} racesLanes
 * @param {string} timeMode
 * @returns {{entries: Array<{team_code,team_name,source_race,source_lane,exported_ms,full_ms,position}>, unresolvedTies: object[]}}
 */
export function pooledTimeStandings(racesLanes, timeMode = 'mss00') {
  rankAll(racesLanes, timeMode);

  const entries = [];
  for (const r of racesLanes) {
    for (const lr of r.lanes) {
      const ms = laneExportedMs(lr);
      if (!ms) continue; // DNS / DSQ / no-time excluded from the pool
      entries.push({
        team_code: lr.team_code || '',
        team_name: lr.team_name || '',
        source_race: r.race_number,
        source_lane: lr.lane_number,
        exported_ms: ms.trunc,
        full_ms: ms.full,
        position: null,
      });
    }
  }

  entries.sort((a, b) => a.exported_ms - b.exported_ms || a.full_ms - b.full_ms);

  const unresolvedTies = [];
  for (let i = 0; i < entries.length; i++) {
    if (i > 0
      && entries[i].exported_ms === entries[i - 1].exported_ms
      && entries[i].full_ms === entries[i - 1].full_ms) {
      entries[i].position = entries[i - 1].position;
      unresolvedTies.push(entries[i]);
    } else {
      entries[i].position = i + 1;
    }
  }
  return { entries, unresolvedTies };
}

/**
 * Method #2 — sum-of-times ranking across a set of races/rounds.
 * @param {Array<{race_number:number, lanes:object[], batchDeltaMs?:number}>} racesLanes
 * @param {string} timeMode
 * @param {number[]} finalRaceNumbers - races that make up the FINAL round; a
 *   team's rank there is the first tiebreaker. Defaults to the highest race
 *   number present.
 * @param {Object<number,(string|number)>} [roundByRace] - race_number → round
 *   id. Sum is one leg PER ROUND, not per race — for SPLIT HEATS (a team races
 *   once per round across different races, e.g. round 1 = races 1-2, round 2 =
 *   races 3-4) a team must complete every ROUND, not every race. Without this
 *   map each race is treated as its own round (back-compat).
 * @returns {{teams: object[], incomplete: object[], unresolvedTies: object[]}}
 */
export function sumTimeStandings(racesLanes, timeMode = 'mss00', finalRaceNumbers = null, roundByRace = null, partial = false) {
  rankAll(racesLanes, timeMode);

  const finalSet = new Set(
    (finalRaceNumbers && finalRaceNumbers.length)
      ? finalRaceNumbers
      : [Math.max(...racesLanes.map(r => r.race_number))],
  );
  const roundOf = (rn) => (roundByRace && roundByRace[rn] != null) ? roundByRace[rn] : rn;
  const expectedRounds = new Set(racesLanes.map(r => roundOf(r.race_number))).size;

  const byTeam = new Map();
  for (const r of racesLanes) {
    const roundId = roundOf(r.race_number);
    for (const lr of r.lanes) {
      const code = lr.team_code || '';
      if (!code) continue;
      let t = byTeam.get(code);
      if (!t) {
        t = {
          team_code: code,
          team_name: lr.team_name || '',
          sum_exported: 0,
          sum_full: 0,
          perRace: {},
          roundsCovered: new Set(),
          final_rank: null,
        };
        byTeam.set(code, t);
      }
      if (lr.team_name) t.team_name = lr.team_name; // keep freshest real name
      const ms = laneExportedMs(lr);
      if (ms) {
        // Count one leg per round (dedup) so a team can't double-count if a
        // round somehow has them in two races; per-race detail still recorded.
        if (!t.roundsCovered.has(roundId)) {
          t.sum_exported += ms.trunc;
          t.sum_full += ms.full;
          t.roundsCovered.add(roundId);
        }
        t.perRace[r.race_number] = { exported_ms: ms.trunc, full_ms: ms.full, position: lr.computed_position };
      } else {
        // Present in the draw but no usable time (DNS/DSQ) — record it so the
        // caller can see the team didn't complete every leg.
        t.perRace[r.race_number] = { exported_ms: null, full_ms: null, position: lr.computed_position ?? null };
      }
      if (finalSet.has(r.race_number) && lr.computed_position != null) {
        t.final_rank = lr.computed_position;
      }
    }
  }

  const all = [...byTeam.values()];
  // For a FINAL sum rank a team must have a time in every round. For a `partial`
  // (so-far) display we rank everyone with any time by their current sum — in
  // split heats every team has the same number of completed legs at any point,
  // so the partial order is meaningful (e.g. after Heats Rnd 1 only).
  const isRanked = (t) => t.sum_exported > 0 && (partial || t.roundsCovered.size >= expectedRounds);
  const ranked = all.filter(isRanked);
  const incomplete = all.filter(t => !isRanked(t));

  ranked.sort((a, b) =>
    a.sum_exported - b.sum_exported
    || ((a.final_rank ?? Infinity) - (b.final_rank ?? Infinity))
    || a.sum_full - b.sum_full,
  );

  const unresolvedTies = [];
  for (let i = 0; i < ranked.length; i++) {
    if (i > 0) {
      const p = ranked[i - 1], c = ranked[i];
      const identical = c.sum_exported === p.sum_exported
        && (c.final_rank ?? Infinity) === (p.final_rank ?? Infinity)
        && c.sum_full === p.sum_full;
      if (identical) {
        c.overall_rank = p.overall_rank;
        unresolvedTies.push(c);
      } else {
        c.overall_rank = i + 1;
      }
    } else {
      ranked[i].overall_rank = 1;
    }
  }

  return { teams: ranked, incomplete, unresolvedTies };
}
