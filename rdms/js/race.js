/**
 * SDBA RDMS — Race Logic
 * Timing, auto-ranking, validation, batch adjustment.
 */
import { timeToMs, msToTime, timeToDisplay, isValidTime, nowISO, nowDisplay } from './utils.js';
import { DISQUALIFYING_REMARKS, TIME_THRESHOLDS } from './constants.js';

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

  // 1. Race has no start time — warn, don't block. The operator might legitimately
  // export a race they didn't time (e.g. results imported from Joyi only).
  if (!race.start_time) {
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
      errors.push(`Row ${idx + 1}: lane number is required when a time or remark is entered`);
      return;
    }
    const lane = parseInt(laneStr, 10);
    if (!Number.isInteger(lane) || lane < 1 || lane > config.lane_count) {
      errors.push(`Row ${idx + 1}: lane "${laneStr}" is out of range (1–${config.lane_count})`);
      return;
    }
    if (seenLanes.has(lane)) {
      errors.push(`Row ${idx + 1}: lane ${lane} is used more than once`);
      return;
    }
    seenLanes.add(lane);
  });

  // 2. Each active lane with a team must have time OR remark
  activeLanes.forEach(lr => {
    if (lr.team_name && lr.team_name !== '---' && lr.team_name !== '') {
      if (!lr.raw_time && !lr.remarks) {
        errors.push(`Lane ${lr.lane_number}: has a team but no time and no remark`);
      }
    }
  });

  // 3. Validate time format
  activeLanes.forEach(lr => {
    if (lr.raw_time && !isValidTime(lr.raw_time, timeMode)) {
      errors.push(`Lane ${lr.lane_number}: invalid time format "${lr.raw_time}"`);
    }
  });

  // 4. Check Joyi rank matches computed rank
  activeLanes.forEach(lr => {
    if (lr.joyi_rank != null && lr.computed_position != null) {
      if (lr.joyi_rank !== lr.computed_position) {
        warnings.push(`Lane ${lr.lane_number}: position ${lr.computed_position} != Joyi rank ${lr.joyi_rank}`);
      }
    }
  });

  // 5. Input order validation (G21 equivalent — times should be ascending)
  const withTimes = activeLanes.filter(lr => lr.effective_time_ms != null);
  for (let i = 0; i < withTimes.length - 1; i++) {
    if (withTimes[i].effective_time_ms > withTimes[i + 1].effective_time_ms) {
      warnings.push(`Input row ${i + 1}: time is slower than row ${i + 2} — check input order`);
    }
  }

  // 6. Time reasonableness
  activeLanes.forEach(lr => {
    if (lr.effective_time_ms != null) {
      if (lr.effective_time_ms < 30000) {
        warnings.push(`Lane ${lr.lane_number}: suspiciously fast (${timeToDisplay(lr.raw_time, timeMode)})`);
      }
      if (lr.effective_time_ms > 300000) {
        warnings.push(`Lane ${lr.lane_number}: suspiciously slow (${timeToDisplay(lr.raw_time, timeMode)})`);
      }
    }
  });

  // 8. Data validation error check (G21 equivalent — allows override via vbYesNo)
  // Check if any input row has a validation failure marker
  const validationErrors = laneResults.filter(l => l.validation === -2);
  if (validationErrors.length > 0) {
    warnings.push('Data validation error detected in input. Review before exporting.');
  }

  return { errors, warnings, isValid: errors.length === 0 };
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
