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
  // If the operator restarted, the timer baseline is restart_time; the
  // canonical "start" still respects the joyi-over-manual preference for
  // the record.
  const start = joyi || manual;
  const source = joyi ? 'joyi' : (manual ? 'manual' : null);
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

    // DSQ/DQ/DNF/DNS get no position
    if (DISQUALIFYING_REMARKS.includes(lr.remarks)) {
      lr.effective_time_ms = null;
      lr.computed_position = null;
      return;
    }

    const rawMs = timeToMs(lr.raw_time, timeMode);
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

  // 2. Each active lane with a team must have time OR remark
  activeLanes.forEach(lr => {
    if (lr.team_name && lr.team_name !== '---' && lr.team_name !== '') {
      if (!lr.raw_time && !lr.remarks) {
        pushGrouped(errorGroups, 'Lane', lr.lane_number, 'has a team but no time and no remark');
      }
    }
  });

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
