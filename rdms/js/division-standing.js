/**
 * SDBA RDMS — Canonical division standing (selectable scoring method)
 *
 * One entry point that returns a normalized standing regardless of the
 * division's configured method, so the export sheet, the scoring tab and the
 * race-page preview all agree:
 *
 *   'points'        → existing weighted-points model (delegated to
 *                     computeDivisionScoring — points divisions are unchanged).
 *   'time_sum'      → sum of exported times across all scored races (method #2).
 *   'time_combined' → combined-time rank of the FINAL round (method #1).
 *
 * Returns:
 * {
 *   method,
 *   complete,        // true once the totals are final (all required races
 *                    //   exported/sent) — before that the sheet shows "TBC".
 *   unresolvedTie,   // an unbroken tie the engine couldn't settle → manual fix
 *   finalRaceNums,   // races that make up the final round
 *   teamTotals: Map<key, {
 *     team_name, team_code, perRound,
 *     total_points,    // points method (else null)
 *     total_time_ms,   // time methods (else null)
 *     total_display,   // string for the sheet's "Total Score" cell ('' = blank)
 *     total_place,     // overall / combined rank
 *   }>
 * }
 */
import { computeDivisionScoring } from './race.js';
import { pooledTimeStandings, sumTimeStandings } from './time-standings.js';

const DONE = new Set(['exported', 'sent', 'cancelled']);

/** Format a total time (sum may exceed one digit of minutes): M:SS.cc. */
export function formatTotalTime(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const cs = Math.floor(ms / 10);
  const totalSec = Math.floor(cs / 100);
  const cc = cs % 100;
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec % 60;
  return `${mm}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
}

/**
 * Team names/codes on lane_results can be clobbered by a Joyi import; the draw
 * snapshot (race.draw_lanes) is authoritative. Return a shallow-cloned lane
 * list with team identity corrected from draw_lanes (by boat lane), mirroring
 * what the points model already does.
 */
function correctedLanesFor(race, lanesByRace) {
  const lanes = (lanesByRace.get(race.race_number) || []).map(lr => ({ ...lr }));
  const draw = Array.isArray(race.draw_lanes) ? race.draw_lanes : [];
  if (!draw.length) return lanes;
  for (const lr of lanes) {
    const boat = parseInt(lr.lane_input, 10) || lr.lane_number;
    const dt = draw.find(d => d.lane_number === boat);
    if (dt) {
      lr.team_name = dt.team_name || lr.team_name;
      lr.team_code = dt.team_code || lr.team_code || lr.team_name;
    }
  }
  return lanes;
}

export function computeDivisionStanding(division, rounds, scoredRaces, lanesByRace, laneCount, timeMode = 'mss00') {
  if (!scoredRaces || scoredRaces.length === 0) return null;
  const method = division?.standings_method || 'points';

  // Final round = highest round_number that still contains scored races.
  const scoredNums = new Set(scoredRaces.map(r => r.race_number));
  const roundsWithScored = (rounds || []).filter(rd => (rd.race_numbers || []).some(n => scoredNums.has(n)));
  const finalRound = roundsWithScored.slice().sort((a, b) => (b.round_number || 0) - (a.round_number || 0))[0] || null;
  const finalRaceNums = finalRound
    ? (finalRound.race_numbers || []).filter(n => scoredNums.has(n))
    : scoredRaces.map(r => r.race_number);

  // ── Points (default) — delegate to the untouched weighted-points model ──
  if (method === 'points') {
    const ps = computeDivisionScoring(scoredRaces[0], scoredRaces, lanesByRace, laneCount, timeMode);
    if (!ps) return null;
    const complete = scoredRaces.some(r => r.scoring_flag === 'RFinal' && DONE.has(r.status));
    const teamTotals = new Map();
    for (const [k, t] of ps.teamTotals) {
      teamTotals.set(k, {
        team_name: t.team_name,
        team_code: t.team_code,
        perRound: t.perRound,
        total_points: Math.round(t.total_weighted),
        total_time_ms: null,
        total_display: String(Math.round(t.total_weighted)),
        total_place: t.overall_rank,
      });
    }
    return { method, complete, unresolvedTie: false, finalRaceNums, teamTotals };
  }

  // ── Time methods ──
  const racesLanes = scoredRaces.map(r => ({
    race_number: r.race_number,
    lanes: correctedLanesFor(r, lanesByRace),
    batchDeltaMs: r.batch_override_enabled ? (r.batch_delta_ms || 0) : 0,
  }));

  const teamTotals = new Map();
  let unresolvedTie = false;
  let complete;

  if (method === 'time_combined') {
    const finalLanes = racesLanes.filter(rl => finalRaceNums.includes(rl.race_number));
    const { entries, unresolvedTies } = pooledTimeStandings(finalLanes, timeMode);
    unresolvedTie = unresolvedTies.length > 0;
    for (const e of entries) {
      teamTotals.set(e.team_code || e.team_name, {
        team_name: e.team_name,
        team_code: e.team_code,
        perRound: { [e.source_race]: { position: e.position, time_ms: e.exported_ms } },
        total_points: null,
        total_time_ms: e.exported_ms,
        total_display: '', // combined-time final: Total Score column is blank
        total_place: e.position,
      });
    }
    complete = scoredRaces.filter(r => finalRaceNums.includes(r.race_number)).every(r => DONE.has(r.status));
  } else { // time_sum
    const { teams, unresolvedTies } = sumTimeStandings(racesLanes, timeMode, finalRaceNums);
    unresolvedTie = unresolvedTies.length > 0;
    for (const t of teams) {
      teamTotals.set(t.team_code || t.team_name, {
        team_name: t.team_name,
        team_code: t.team_code,
        perRound: t.perRace,
        total_points: null,
        total_time_ms: t.sum_exported,
        total_display: formatTotalTime(t.sum_exported),
        total_place: t.overall_rank,
      });
    }
    complete = scoredRaces.every(r => DONE.has(r.status));
  }

  return { method, complete, unresolvedTie, finalRaceNums, teamTotals };
}
