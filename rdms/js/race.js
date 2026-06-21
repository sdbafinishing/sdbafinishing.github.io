/**
 * SDBA RDMS — Race Logic
 * Timing, auto-ranking, validation, batch adjustment.
 */
import { timeToMs, msToTime, timeToDisplay, isValidTime, nowISO, nowDisplay } from './utils.js';
import { DISQUALIFYING_REMARKS, TIME_THRESHOLDS } from './constants.js';

/**
 * Resolve the effective race-start ISO timestamp.
 *
 * Joyi-derived start (race.joyi_start_time) is preferred over the operator-
 * clicked race.start_time because it's tied to the actual signal-box trigger
 * via the camera clock; the operator click has human reaction-time error and
 * is sometimes forgotten entirely. The clicked start_time is the fallback.
 *
 * Also honours restart_time when present — same semantics as before: a
 * restart shifts the timer baseline but keeps the original start for the
 * record. Joyi-derived restart isn't a thing, so this just falls through
 * to manual restart_time over either start source.
 *
 * @param {Object} race
 * @returns {{ start: string|null, source: 'joyi'|'manual'|null, restartedFrom: string|null }}
 */
export function getEffectiveStartTime(race) {
  if (!race) return { start: null, source: null, restartedFrom: null };
  const joyi = race.joyi_start_time || null;
  const manual = race.start_time || null;
  const restart = race.restart_time || null;
  // Per-race override: when race.prefer_manual_start is true, the
  // operator-clicked time wins even if joyi has a value. Default is
  // joyi-over-manual (joyi is sub-second accurate when transport
  // preserves mtime; the manual click is whatever the operator's
  // reaction allowed).
  let start, source;
  if (race.prefer_manual_start && manual) {
    start = manual; source = 'manual';
  } else {
    start = joyi || manual;
    source = joyi ? 'joyi' : (manual ? 'manual' : null);
  }
  return { start, source, restartedFrom: restart };
}

/**
 * Compute rankings for all lane results.
 * Mutates the array — sets computed_position on each item.
 * @param {Object[]} laneResults - Array of lane result objects
 * @param {string} timeMode - 'mss00' or 'mmss00'
 * @param {number} batchDeltaMs - Batch adjustment in milliseconds
 * @returns {Object[]} Same array with computed_position set
 */
export function computeRankings(laneResults, timeMode = 'mss00', batchDeltaMs = 0) {
  // Calculate effective time for each lane
  laneResults.forEach(lr => {
    if (!lr.raw_time || !isValidTime(lr.raw_time, timeMode)) {
      lr.effective_time_ms = null;
      lr.computed_position = null;
      return;
    }

    // Treat all-zero time ("00000" / "000000") as no-time. Joyi exports
    // a zero string for DNS / empty rows; without this they'd rank as
    // 1st place (0 ms is faster than any real time). Also covers any
    // grid row the operator left at its default placeholder.
    //
    // Use lr.raw_time_ms when present (full precision from Joyi
    // thousandths) — that's what breaks ties when two boats share the
    // same displayed hundredth. Fall back to timeToMs(raw_time) for
    // operator-typed rows (hundredth-only) and legacy data.
    const rawMs = lr.raw_time_ms != null && Number.isFinite(lr.raw_time_ms)
      ? lr.raw_time_ms
      : timeToMs(lr.raw_time, timeMode);
    if (rawMs === 0 || rawMs == null) {
      lr.effective_time_ms = null;
      lr.computed_position = null;
      return;
    }

    // DSQ/DQ/DNF/DNS get no position
    if (DISQUALIFYING_REMARKS.includes(lr.remarks)) {
      lr.effective_time_ms = null;
      lr.computed_position = null;
      return;
    }

    // Dummy / placeholder team rows ("---") don't represent a real boat
    // and shouldn't be ranked even if some leftover time sits in raw_time.
    const teamName = (lr.team_name || '').trim();
    if (teamName === '---' || teamName === '—') {
      lr.effective_time_ms = null;
      lr.computed_position = null;
      return;
    }

    const penaltyMs = lr.penalty_time ? (parseFloat(lr.penalty_time) * 1000) : 0;
    lr.effective_time_ms = rawMs + penaltyMs + batchDeltaMs;
  });

  // Sort rankable lanes by effective time
  const rankable = laneResults
    .filter(lr => lr.effective_time_ms != null)
    .sort((a, b) => a.effective_time_ms - b.effective_time_ms);

  // Assign positions (ties get same rank — RANK semantics)
  for (let i = 0; i < rankable.length; i++) {
    if (i === 0) {
      rankable[i].computed_position = 1;
    } else if (rankable[i].effective_time_ms === rankable[i - 1].effective_time_ms) {
      rankable[i].computed_position = rankable[i - 1].computed_position;
    } else {
      rankable[i].computed_position = i + 1;
    }
  }

  return laneResults;
}

/**
 * Calculate batch adjustment delta.
 * B37 (P1 backup time) - B21 (first input time) = delta applied to all times.
 * @param {string} p1BackupTime - mss00 of the first boat from backup source
 * @param {string} firstInputTime - mss00 of the first boat from manual input
 * @param {string} timeMode - 'mss00' or 'mmss00'
 * @returns {number} Delta in milliseconds
 */
export function calcBatchDelta(p1BackupTime, firstInputTime, timeMode = 'mss00') {
  if (!p1BackupTime || !firstInputTime) return 0;
  const backupMs = timeToMs(p1BackupTime, timeMode);
  const inputMs = timeToMs(firstInputTime, timeMode);
  if (backupMs == null || inputMs == null) return 0;
  return backupMs - inputMs;
}

/**
 * Validate race results before export.
 * @param {Object} race - Race record
 * @param {Object[]} laneResults - Lane results array
 * @param {Object} config - Event config
 * @returns {{ errors: string[], warnings: string[], isValid: boolean }}
 */
export function validateRace(race, laneResults, config) {
  const errors = [];
  const warnings = [];
  const timeMode = config.time_format_mode || 'mss00';
  const activeLanes = laneResults.slice(0, config.lane_count);

  // Group-buffers: collect per-lane / per-row problems by message tail so we
  // can emit one combined line per kind of problem (e.g.
  //   "Lanes 1, 2, 3: has a team but no time and no remark"
  // instead of six near-identical lines stacking up vertically).
  // Each entry maps a scope tag → Map<message_tail, Set<id>>.
  const errorGroups = { Lane: new Map(), Row: new Map() };
  const warningGroups = { Lane: new Map(), 'Input row': new Map() };
  const pushGrouped = (groups, scope, id, tail) => {
    if (!groups[scope].has(tail)) groups[scope].set(tail, new Set());
    groups[scope].get(tail).add(id);
  };

  // 1. Race has no start time — warn, don't block. We accept either
  // source (Joyi-derived or operator-clicked). Only warn when BOTH are
  // missing — covers the "imported results from Joyi only" path while
  // still flagging genuinely-untimed races.
  if (!race.start_time && !race.joyi_start_time) {
    warnings.push('Race has no start time recorded');
  }

  // 1b. Lane number validation — every row with any data must declare a valid,
  // in-range, unique lane in lane_input. Blank lane was previously silently
  // falling back to row index in the output, producing wrong team mappings.
  const seenLanes = new Set();
  activeLanes.forEach((lr, idx) => {
    const hasData = lr.raw_time || lr.remarks;
    if (!hasData) return;
    const laneStr = (lr.lane_input ?? '').toString().trim();
    if (laneStr === '') {
      pushGrouped(errorGroups, 'Row', idx + 1, 'lane number is required when a time or remark is entered');
      return;
    }
    const lane = parseInt(laneStr, 10);
    if (!Number.isInteger(lane) || lane < 1 || lane > config.lane_count) {
      // Keep the bad lane value in the tail so two rows with different bad
      // inputs ("0" vs "9") stay as separate lines.
      pushGrouped(errorGroups, 'Row', idx + 1, `lane "${laneStr}" is out of range (1–${config.lane_count})`);
      return;
    }
    if (seenLanes.has(lane)) {
      pushGrouped(errorGroups, 'Row', idx + 1, `lane ${lane} is used more than once`);
      return;
    }
    seenLanes.add(lane);
  });

  // 2. Each DRAWN boat must have either a time OR a status (remark).
  //
  // Pre-Joyi this was equivalent to "each row with a team_name needs
  // data" because lane_number = boat lane in the data model. After
  // Joyi import the grid is in finish-order, so lane_number = grid row
  // position, not boat lane, and the old check no longer catches
  // missing boats. Use race.draw_lanes (the boat-lane → team snapshot)
  // as the authoritative list of "who's supposed to race", then look
  // for a grid row whose lane_input refers to that boat.
  const drawnBoats = Array.isArray(race?.draw_lanes) && race.draw_lanes.length > 0
    ? race.draw_lanes.filter(dl => {
        const tn = (dl?.team_name || '').trim();
        return tn && tn !== '---';
      })
    : null;
  if (drawnBoats) {
    for (const dl of drawnBoats) {
      const boatLane = dl.lane_number;
      const matchingRow = activeLanes.find(lr => parseInt(lr.lane_input, 10) === boatLane);
      const hasData = matchingRow && (matchingRow.raw_time || matchingRow.remarks);
      if (!hasData) {
        pushGrouped(errorGroups, 'Lane', boatLane, 'has a team but no time and no status (DSQ/DNS/DNF)');
      }
    }
  } else {
    // Legacy path: no draw_lanes snapshot. Fall back to the old check.
    activeLanes.forEach(lr => {
      if (lr.team_name && lr.team_name !== '---' && lr.team_name !== '') {
        if (!lr.raw_time && !lr.remarks) {
          pushGrouped(errorGroups, 'Lane', lr.lane_number, 'has a team but no time and no status (DSQ/DNS/DNF)');
        }
      }
    });
  }

  // 3. Validate time format
  activeLanes.forEach(lr => {
    if (lr.raw_time && !isValidTime(lr.raw_time, timeMode)) {
      // Bad time value kept in the tail so different malformed strings don't
      // collapse onto each other.
      pushGrouped(errorGroups, 'Lane', lr.lane_number, `invalid time format "${lr.raw_time}"`);
    }
  });

  // 4. Check Joyi rank matches computed rank — each lane has its own
  // (position, joyi_rank) pair, so these stay as individual lines.
  activeLanes.forEach(lr => {
    if (lr.joyi_rank != null && lr.computed_position != null) {
      if (lr.joyi_rank !== lr.computed_position) {
        pushGrouped(warningGroups, 'Lane', lr.lane_number, `position ${lr.computed_position} != Joyi rank ${lr.joyi_rank}`);
      }
    }
  });

  // 5. Input order validation — compare PRE-penalty raw times. A boat that
  // finished earlier but later got a TP shouldn't be flagged as "out of
  // order"; the operator entered them by actual crossing order.
  const withTimes = activeLanes
    .map(lr => ({ lr, rawMs: lr.raw_time ? timeToMs(lr.raw_time, timeMode) : null }))
    .filter(x => x.rawMs != null);
  for (let i = 0; i < withTimes.length - 1; i++) {
    if (withTimes[i].rawMs > withTimes[i + 1].rawMs) {
      pushGrouped(warningGroups, 'Input row', i + 1, `time is slower than row ${i + 2} — check input order`);
    }
  }

  // 5b. Duplicate-time detection — two boats with the SAME raw_time
  // (and not DSQ'd) will collapse to the same place by rank semantics.
  // Soft block: surface as warning so the operator can verify (a
  // genuine photo-finish tie is rare but legal). Export modal will
  // require confirmation.
  const timeBuckets = new Map();
  withTimes.forEach(({ lr, rawMs }) => {
    // Skip DSQ-class rows (those don't get a position regardless).
    if (DISQUALIFYING_REMARKS.includes(lr.remarks)) return;
    if (!timeBuckets.has(rawMs)) timeBuckets.set(rawMs, []);
    timeBuckets.get(rawMs).push(lr.lane_input || lr.lane_number);
  });
  for (const [, lanes] of timeBuckets) {
    if (lanes.length > 1) {
      const lanesStr = lanes.join(', ');
      pushGrouped(warningGroups, 'Lane', lanesStr,
        `same time — will share a place. Verify with photo finish.`);
    }
  }

  // 5c. Tight finish banner data — collect pairs of consecutive
  // finishers whose gap is ≤ 50 ms (5 hundredths). Surface as a soft
  // warning (visual banner is rendered by the race page).
  for (let i = 0; i < withTimes.length - 1; i++) {
    const a = withTimes[i];
    const b = withTimes[i + 1];
    if (DISQUALIFYING_REMARKS.includes(a.lr.remarks) || DISQUALIFYING_REMARKS.includes(b.lr.remarks)) continue;
    const gap = Math.abs(b.rawMs - a.rawMs);
    if (gap > 0 && gap <= 50) {
      const laneA = a.lr.lane_input || a.lr.lane_number;
      const laneB = b.lr.lane_input || b.lr.lane_number;
      pushGrouped(warningGroups, 'Lane', `${laneA} & ${laneB}`,
        `tight finish — ${(gap / 10).toFixed(2)} hundredths apart. Check photo finish.`);
    }
  }

  // 6. Time reasonableness — fast/slow each keep their displayed time in the
  // tail so the lane list always lines up with consistent context.
  activeLanes.forEach(lr => {
    if (lr.effective_time_ms != null) {
      if (lr.effective_time_ms < 30000) {
        pushGrouped(warningGroups, 'Lane', lr.lane_number, `suspiciously fast (${timeToDisplay(lr.raw_time, timeMode)})`);
      }
      if (lr.effective_time_ms > 300000) {
        pushGrouped(warningGroups, 'Lane', lr.lane_number, `suspiciously slow (${timeToDisplay(lr.raw_time, timeMode)})`);
      }
    }
  });

  // 8. Data validation error check (G21 equivalent — allows override via vbYesNo)
  // Check if any input row has a validation failure marker
  const validationErrors = laneResults.filter(l => l.validation === -2);
  if (validationErrors.length > 0) {
    warnings.push('Data validation error detected in input. Review before exporting.');
  }

  // Flush the grouped buffers into the final error/warning string arrays.
  flushGroups(errorGroups, errors);
  flushGroups(warningGroups, warnings);

  return { errors, warnings, isValid: errors.length === 0 };
}

/**
 * Turn a {scope → {tail → Set<id>}} map into "Lanes 1, 2, 3: tail" lines,
 * appending each to the given output array. Singular vs plural label picked
 * from the id-count; ids sorted ascending so the rendering is deterministic.
 */
function flushGroups(groups, out) {
  for (const scope in groups) {
    for (const [tail, ids] of groups[scope]) {
      const sorted = [...ids].sort((a, b) => a - b);
      const label = sorted.length === 1 ? scope : pluralizeScope(scope);
      out.push(`${label} ${sorted.join(', ')}: ${tail}`);
    }
  }
}

function pluralizeScope(scope) {
  if (scope === 'Lane') return 'Lanes';
  if (scope === 'Row') return 'Rows';
  if (scope === 'Input row') return 'Input rows';
  return scope + 's';
}

/**
 * Calculate scoring points for a position.
 * 1st = lane_count + 1, 2nd = lane_count - 1, Nth = lane_count - (N-1)
 * DNS/DNF/DSQ/DQ = 0
 * @param {number} position - Finishing position (1-based)
 * @param {number} laneCount - Total number of lanes
 * @returns {number} Points
 */
/**
 * Sort lane results by position (nulls at end, then by lane number).
 * Returns a new array — does not mutate input.
 */
export function sortLanesByPosition(lanes) {
  return [...lanes].sort((a, b) => {
    if (a.computed_position == null && b.computed_position == null) return a.lane_number - b.lane_number;
    if (a.computed_position == null) return 1;
    if (b.computed_position == null) return -1;
    return a.computed_position - b.computed_position;
  });
}

export function positionToPoints(position, laneCount) {
  if (!position || position < 1) return 0;
  if (position === 1) return laneCount + 1;
  return laneCount - (position - 1);
}

/**
 * Variance warnings — surface "this race looks off" and "this team's
 * time looks off vs their own previous round" so the operator can
 * sanity-check before exporting.
 *
 * Soft block only — these become entries in `warnings` (yellow) or
 * `errors` (red); export modal will require explicit confirmation if
 * thresholds are hit.
 *
 * Thresholds:
 *   - 5 s (5000 ms) → yellow warning
 *   - 7 s (7000 ms) → red error (still NOT a hard block per user spec)
 *
 * Two checks:
 *   A. Race vs cohort — 1st-boat time of THIS race vs mean 1st-boat of
 *      "races sharing the same preceding round". Heats compare against
 *      other heats in the same division. Finals derived from Cup Semi
 *      compare against other Cup-derived finals (NOT Bowl-derived) —
 *      the boundary is the division_progressions DAG.
 *   B. Team vs own previous round — for each team in the current race,
 *      look up their result in the immediately-preceding round of this
 *      division. If delta > threshold, warn that team specifically.
 *
 * @param {Object} ctx
 *   - race: focal race
 *   - lanes: this race's current lane_results (from grid or DB)
 *   - allRaces: all races in DB
 *   - allLaneResultsByRace: Map<race_number, lane_results[]>
 *   - divRounds: all division_rounds rows
 *   - divProgs: all division_progressions rows
 *   - laneCount, timeMode
 * @returns {{ warnings: string[], errors: string[] }} keyed by severity
 */
export function computeVarianceWarnings(ctx) {
  const {
    race, lanes, allRaces, allLaneResultsByRace,
    divRounds, divProgs, laneCount, timeMode,
  } = ctx;
  const out = { warnings: [], errors: [] };
  if (!race?.division_id) return out;

  const SOFT_MS = 5000;
  const HARD_MS = 7000;

  // Helper: race → its division_round (the row that lists this race in
  // race_numbers). Returns null if not found.
  function roundForRace(raceNumber, divisionId) {
    return divRounds.find(r =>
      r.division_id === divisionId &&
      Array.isArray(r.race_numbers) &&
      r.race_numbers.includes(raceNumber),
    ) || null;
  }

  // Helper: ranked 1st-boat time (ms) for a race. Uses raw_time_ms when
  // available, else timeToMs of raw_time. Returns null if no winner.
  function firstBoatMs(raceLanes) {
    const winner = (raceLanes || []).find(lr => lr.computed_position === 1);
    if (!winner) return null;
    if (Number.isFinite(winner.raw_time_ms)) return winner.raw_time_ms;
    return timeToMs(winner.raw_time, timeMode);
  }

  const myRound = roundForRace(race.race_number, race.division_id);
  if (!myRound) return out;

  // ── Check A: race vs cohort 1st-boat time ───────────────────────────
  // Cohort = other races in the SAME division_round (i.e. the rounds
  // configured together by the operator — naturally groups Cup-derived
  // finals separately from Bowl-derived finals as long as the operator
  // listed them in distinct division_rounds rows).
  const cohortRaceNums = (myRound.race_numbers || []).filter(rn => rn !== race.race_number);
  const cohortTimes = [];
  for (const rn of cohortRaceNums) {
    const rLanes = allLaneResultsByRace.get(rn);
    if (!rLanes) continue;
    const ms = firstBoatMs(rLanes);
    if (ms && ms > 0) cohortTimes.push(ms);
  }
  const myFirstMs = firstBoatMs(lanes);
  if (myFirstMs && cohortTimes.length >= 1) {
    const cohortMean = cohortTimes.reduce((a, b) => a + b, 0) / cohortTimes.length;
    const delta = Math.abs(myFirstMs - cohortMean);
    if (delta >= HARD_MS) {
      out.errors.push(
        `1st-boat time ${(myFirstMs / 1000).toFixed(2)}s is ${(delta / 1000).toFixed(1)}s off the cohort mean (${(cohortMean / 1000).toFixed(2)}s across ${cohortTimes.length} race${cohortTimes.length === 1 ? '' : 's'}). Verify the start time / Joyi import.`,
      );
    } else if (delta >= SOFT_MS) {
      out.warnings.push(
        `1st-boat time ${(myFirstMs / 1000).toFixed(2)}s is ${(delta / 1000).toFixed(1)}s off the cohort mean (${(cohortMean / 1000).toFixed(2)}s). Worth a sanity-check.`,
      );
    }
  }

  // ── Check B: team vs own previous-round time ────────────────────────
  // Find rounds that progress INTO mine. For each team in the current
  // race, look them up in those preceding rounds' lane_results and
  // compute the delta vs their current effective time.
  const precedingRoundIds = divProgs
    .filter(p => p.to_round_id === myRound.id)
    .map(p => p.from_round_id);
  if (precedingRoundIds.length > 0 && Array.isArray(race.draw_lanes)) {
    // Build a team_code → previous-time map by scanning all preceding-
    // round races' draw_lanes + lane_results.
    const teamPrevMs = new Map();
    for (const prevRoundId of precedingRoundIds) {
      const prevRound = divRounds.find(r => r.id === prevRoundId);
      if (!prevRound) continue;
      for (const prevRaceNum of (prevRound.race_numbers || [])) {
        const prevRace = allRaces.find(r => r.race_number === prevRaceNum);
        const prevLanes = allLaneResultsByRace.get(prevRaceNum);
        if (!prevRace || !prevLanes) continue;
        const prevDraw = Array.isArray(prevRace.draw_lanes) ? prevRace.draw_lanes : [];
        for (const dl of prevDraw) {
          if (!dl?.team_code) continue;
          // Find this team's row by lane_input matching the boat lane.
          const lr = prevLanes.find(l => parseInt(l.lane_input, 10) === dl.lane_number);
          if (!lr) continue;
          const ms = Number.isFinite(lr.raw_time_ms) ? lr.raw_time_ms : timeToMs(lr.raw_time, timeMode);
          if (ms && ms > 0) {
            // If a team raced multiple preceding races (unusual), keep
            // the most recent — favour later race_number.
            const existing = teamPrevMs.get(dl.team_code);
            if (!existing || prevRaceNum > existing.race_number) {
              teamPrevMs.set(dl.team_code, { ms, race_number: prevRaceNum });
            }
          }
        }
      }
    }
    // Compare each current-race team's time against their previous.
    for (const dl of race.draw_lanes) {
      if (!dl?.team_code) continue;
      const prev = teamPrevMs.get(dl.team_code);
      if (!prev) continue;
      const curLane = lanes.find(l => parseInt(l.lane_input, 10) === dl.lane_number);
      if (!curLane) continue;
      const curMs = Number.isFinite(curLane.raw_time_ms) ? curLane.raw_time_ms : timeToMs(curLane.raw_time, timeMode);
      if (!curMs || curMs === 0) continue;
      const signedDeltaMs = curMs - prev.ms; // + = slower now, - = faster now
      const delta = Math.abs(signedDeltaMs);
      // Signed so the operator sees direction at a glance: +Xs slower, -Xs faster.
      const deltaStr = `${signedDeltaMs >= 0 ? '+' : '-'}${(delta / 1000).toFixed(1)}s`;
      const teamLabel = `${dl.team_name || dl.team_code} (lane ${dl.lane_number})`;
      if (delta >= HARD_MS) {
        out.errors.push(
          `${teamLabel}: ${(curMs / 1000).toFixed(2)}s now vs ${(prev.ms / 1000).toFixed(2)}s in Race ${prev.race_number} — ${deltaStr}. Verify.`,
        );
      } else if (delta >= SOFT_MS) {
        out.warnings.push(
          `${teamLabel}: ${(curMs / 1000).toFixed(2)}s now vs ${(prev.ms / 1000).toFixed(2)}s in Race ${prev.race_number} — ${deltaStr}.`,
        );
      }
    }
  }

  return out;
}

/**
 * Compute the cross-round scoring context for the given race's division.
 *
 * Caller provides:
 *   - race: the focal race
 *   - allRaces, allLaneResultsByRace (Map<raceNumber, lane_results[]>): all loaded races/lanes
 *   - laneCount
 *
 * Returns null if the race isn't scored. Otherwise an object with:
 *   scoringFlag, scoredRaces (sorted R1→RFinal), multiplier (for this round),
 *   teamTotals: Map<team_code, { team_name, team_code,
 *     perRound: { R1?: {pts, wtd, position, raw_time, remarks}, ... },
 *     total_weighted, overall_rank }>
 *
 * Pure function — no DB calls — so it's safe to call from both the
 * race-page and the export pipeline.
 */
export function computeDivisionScoring(race, allRaces, allLaneResultsByRace, laneCount, timeMode = 'mss00') {
  if (!race?.scoring_flag || race.scoring_flag === 'N' || !race.division_id) return null;
  const order = { 'R1': 1, 'R2': 2, 'RFinal': 3 };
  const scoredRaces = allRaces
    .filter(r => r.division_id === race.division_id && r.scoring_flag && r.scoring_flag !== 'N')
    .sort((a, b) => (order[a.scoring_flag] || 99) - (order[b.scoring_flag] || 99));
  if (scoredRaces.length === 0) return null;
  const multipliers = { 'R1': 1.0000001, 'R2': 1.00001, 'RFinal': 1.001 };

  const teamTotals = new Map();
  for (const r of scoredRaces) {
    const lanes = allLaneResultsByRace.get(r.race_number) || [];
    // Rank from raw_time here rather than trusting the stored computed_position:
    // a Joyi re-import (or any import) can leave it null, which would score the
    // whole race 0 points even though it has valid times + places. Derives the
    // same value the export uses.
    computeRankings(lanes, timeMode, r.batch_override_enabled ? (r.batch_delta_ms || 0) : 0);
    const drawLanes = Array.isArray(r.draw_lanes) ? r.draw_lanes : [];
    for (const lr of lanes) {
      if (!lr.team_name || lr.team_name === '---' || lr.team_name === '') continue;
      const boatLane = parseInt(lr.lane_input, 10) || lr.lane_number;
      const drawTeam = drawLanes.find(dl => dl.lane_number === boatLane);
      const displayName = drawTeam?.team_name || lr.team_name;
      const teamCode = drawTeam?.team_code || lr.team_code || lr.team_name;
      const key = teamCode || displayName;
      if (!teamTotals.has(key)) {
        teamTotals.set(key, { team_name: displayName, team_code: teamCode || '', perRound: {}, total_weighted: 0 });
      }
      const pts = positionToPoints(lr.computed_position, laneCount);
      const mult = multipliers[r.scoring_flag] || 1;
      const wtd = pts * mult;
      const entry = teamTotals.get(key);
      entry.perRound[r.scoring_flag] = {
        pts, wtd, position: lr.computed_position, raw_time: lr.raw_time || '', remarks: lr.remarks || '',
      };
      entry.total_weighted += wtd;
    }
  }

  const sortedTeams = [...teamTotals.values()].sort((a, b) => b.total_weighted - a.total_weighted);
  sortedTeams.forEach((t, i) => {
    if (i > 0 && t.total_weighted === sortedTeams[i - 1].total_weighted) {
      t.overall_rank = sortedTeams[i - 1].overall_rank;
    } else {
      t.overall_rank = i + 1;
    }
  });

  return {
    scoringFlag: race.scoring_flag,
    multiplier: multipliers[race.scoring_flag] || 1,
    laneCount,
    scoredRaces,
    teamTotals,
  };
}
