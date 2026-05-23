/**
 * SDBA RDMS — Export Engine
 * Export results to .xls (stamp into original draw file).
 * Generate start lists (Joyi + SprintTimer formats).
 */
import { getConfig, getRace, saveRace, getLaneResults, bulkSaveLaneResults, getAllRaces, saveTimesheet, getTimesheet } from './db.js';
import { computeRankings } from './race.js';
import { timeToDisplay, nowISO, isoToTime, showToast } from './utils.js';
import { broadcastChange } from './app.js';
import { backupAfterExport } from './backup.js';
import { writeToBoth, downloadFallback } from './file-access.js';
import { queueRaceSync } from './sync.js';
import { patchXlsxCells } from './xlsx-patcher.js';
import raceTemplateUrl from '../templates/race-template.xlsx?url';

// Single bundled xlsx template used for ALL race exports (results + next
// round draws). The xlsx patcher edits cell XML in place, preserving all
// visual formatting (borders, fonts, fills, alignment, merges) bit-for-
// bit. Output is xlsx-content under .xls filename — downstream tools
// sniff content, so the extension lie is invisible.
let _cachedTemplateBytes = null;
async function loadRaceTemplate() {
  if (_cachedTemplateBytes) return _cachedTemplateBytes;
  const res = await fetch(raceTemplateUrl);
  if (!res.ok) throw new Error(`Failed to load race template: ${res.status}`);
  _cachedTemplateBytes = await res.arrayBuffer();
  return _cachedTemplateBytes;
}

/**
 * Format an mss00 raw time string into the dot-separated form used in
 * the source draw files (and printed result sheets):
 *   "10235"  → "1.02.35"
 *   "05591"  → "0.55.91"
 *   "012345" → "1.23.45" (mmss00 mode)
 * Empty / invalid input returns ''.
 */
function timeToDotFormat(raw, timeMode) {
  if (!raw) return '';
  const s = String(raw).replace(/\D/g, '');
  if (!s) return '';
  // mss00 = 5 digits = m ss hh ; mmss00 = 6 digits = mm ss hh
  const isMmss = timeMode === 'mmss00';
  const expected = isMmss ? 6 : 5;
  const padded = s.padStart(expected, '0');
  const minLen = isMmss ? 2 : 1;
  const minStr = padded.slice(0, minLen);
  const secStr = padded.slice(minLen, minLen + 2);
  const hunStr = padded.slice(minLen + 2, minLen + 4);
  return `${parseInt(minStr, 10)}.${secStr}.${hunStr}`;
}

/**
 * Export results for a race.
 * Generates an .xls file with results data and triggers download.
 * For Phase 1: generates a standalone results file.
 * TODO Phase 2: read original draw .xls and stamp results into it.
 *
 * @param {number} raceNumber
 * @param {Object} options - { isRevision: boolean, revisionNote: string }
 * @returns {Object} { success, version }
 */
export async function exportResults(raceNumber, options = {}) {
  const config = await getConfig();
  const race = await getRace(raceNumber);
  const lanes = await getLaneResults(raceNumber);
  const timeMode = config?.time_format_mode || 'mss00';

  if (!race) throw new Error(`Race ${raceNumber} not found`);

  const laneCount = config?.lane_count || 6;

  // Re-run rankings from raw_time across every lane in the DB before
  // exporting. Two real bugs make a fresh recompute necessary:
  //   1. persistCurrentRow on the race page only writes the focused row
  //      back, so when a later entry demotes an earlier row's position,
  //      the earlier row's DB computed_position goes stale (showed up
  //      as duplicated places in the export, e.g. two rows ranked 1).
  //   2. Joyi import writes lane_input + raw_time but doesn't compute
  //      positions; the grid's recalculate runs in memory but never
  //      persists back, so the DB has null computed_position for every
  //      Joyi-imported lane (places came out blank in the export).
  // computeRankings mutates the array in place, so the same `lanes`
  // reference flows into the rest of the export.
  computeRankings(lanes, timeMode, 0);
  // Write the refreshed positions back so the dashboard / scoring page
  // / next-round-draw resolution all see consistent values.
  await bulkSaveLaneResults(lanes);

  // Snapshot draws keyed by the actual boat lane. Source of truth for
  // team name/code at export time, no matter which grid row the operator
  // typed the results into.
  const drawsByLane = {};
  lanes.forEach(lr => {
    if (lr.lane_number) {
      drawsByLane[lr.lane_number] = { team_code: lr.team_code || '', team_name: lr.team_name || '' };
    }
  });

  // Pre-export validation (matches VBA ValidateResults)
  const hasInput = lanes.some(l => l.raw_time || l.remarks);
  if (!hasInput) {
    throw new Error('No results input detected. Cannot export empty results.');
  }

  // Lane_input validation — every result row needs a valid, unique, in-range lane.
  // Without this, blank lane_input silently fell back to row index in the output
  // and produced wrong team mappings.
  const laneErrors = [];
  const seenLanes = new Set();
  const resultRows = lanes.filter(l => l.raw_time || l.remarks);
  resultRows.forEach((lr, idx) => {
    const laneStr = (lr.lane_input ?? '').toString().trim();
    if (laneStr === '') {
      laneErrors.push(`Row ${idx + 1}: lane number is required`);
      return;
    }
    const lane = parseInt(laneStr, 10);
    if (!Number.isInteger(lane) || lane < 1 || lane > laneCount) {
      laneErrors.push(`Row ${idx + 1}: lane "${laneStr}" out of range (1–${laneCount})`);
      return;
    }
    if (seenLanes.has(lane)) {
      laneErrors.push(`Row ${idx + 1}: lane ${lane} used more than once`);
      return;
    }
    seenLanes.add(lane);
  });
  if (laneErrors.length > 0) {
    throw new Error(`Cannot export: ${laneErrors.join('; ')}.`);
  }

  // Rank mismatch check uses lane_input lookup for correct team mapping.
  const mismatches = lanes.filter(l =>
    l.joyi_rank != null && l.computed_position != null && l.joyi_rank !== l.computed_position
  );
  if (mismatches.length > 0) {
    const details = mismatches.map(l => {
      const laneNum = parseInt(l.lane_input, 10) || l.lane_number;
      return `Lane ${laneNum}: position ${l.computed_position} != Joyi rank ${l.joyi_rank}`;
    }).join(', ');
    throw new Error(`Rank mismatch detected: ${details}. Resolve before exporting.`);
  }

  // Every drawn team (lane 1..N with a team_name) must be referenced by some
  // result row's lane_input. If a team's lane isn't in the entered results,
  // the operator forgot to log that boat.
  const referencedLanes = new Set(
    resultRows.map(l => parseInt(l.lane_input, 10)).filter(Number.isInteger)
  );
  const activeLanes = lanes.slice(0, laneCount);
  const missingResults = activeLanes.filter(l =>
    l.team_name && l.team_name !== '---' && l.team_name !== '' &&
    !referencedLanes.has(l.lane_number)
  );
  if (missingResults.length > 0) {
    const details = missingResults.map(l => `Lane ${l.lane_number} (${l.team_name})`).join(', ');
    throw new Error(`Missing results: ${details}. Each team must have time and/or remarks.`);
  }

  // Version management
  const prevVersion = race.export_version || 0;
  let newVersion;

  if (prevVersion === 0) {
    // First export
    newVersion = 1;
  } else if (options.isRevision) {
    newVersion = prevVersion + 1;
  } else {
    newVersion = prevVersion; // re-export, same version
  }

  // Build (lane_number → result row) map for cell-stamping below.
  const inputByLane = {};
  resultRows.forEach(r => {
    const lane = parseInt(r.lane_input, 10);
    if (Number.isInteger(lane) && lane >= 1 && lane <= laneCount) {
      inputByLane[lane] = r;
    }
  });

  const ref = config?.event_short_ref || 'RDMS';
  // Output filename mirrors the draw naming convention. Round 1+ races
  // use `{N}.xls`; second-round files used "Second Round - {N}.xls" in
  // the legacy flow — we keep the same names here so downstream pairing
  // by filename keeps working.
  const filename = `${raceNumber}.xls`;

  // Build the cell-update list. The bundled template has these fixed
  // positions (1-indexed rows; same layout used for every race):
  //   A1  race title
  //   D1  race start time
  //   A4..A10  boat numbers 1..7 (left as-is from the template)
  //   B4..B10  team names
  //   C4..C10  team codes
  //   D4..D10  Time  (m.ss.00)
  //   E4..E10  Place (number) — DSQ/DNS/DNF stays blank here
  //   I4..I10  Remarks (DSQ/DQ/DNS/DNF marker OR free-text)
  //   A11      progression footnote + revision marker (appended)
  // Cols F/G/H (Score / Total Score / Total Place) are cumulative-
  // series fields, not per-race, so they stay blank.
  const MARKER_SET = new Set(['DSQ', 'DQ', 'DNS', 'DNF']);
  const TEMPLATE_LANE_COUNT = 7; // rows 4..10
  const mods = [];

  // Header: race title (raw, exactly as it appeared in the imported
  // draw's A1) + start time. Fall back to the sanitised title if the
  // raw form is missing (e.g. races created before this field existed).
  mods.push({ addr: 'A1', value: race.race_title_raw || race.race_title || `Race ${raceNumber}` });
  mods.push({ addr: 'D1', value: race.race_time || '' });

  // Lane rows
  const lanesByLane = {};
  lanes.forEach(l => { if (l.lane_number) lanesByLane[l.lane_number] = l; });

  for (let lane = 1; lane <= TEMPLATE_LANE_COUNT; lane++) {
    const rowNum = 3 + lane; // lane 1 → row 4
    const drawLane = lanesByLane[lane];
    const lr = inputByLane[lane];

    // Team name (col B) and team code (col C) come from the drawn
    // lane (drawsByLane), not the result row — the result row's
    // team_name/code are only relevant when the operator overrode
    // them, which is unusual.
    mods.push({ addr: `B${rowNum}`, value: drawLane?.team_name || '' });
    mods.push({ addr: `C${rowNum}`, value: drawLane?.team_code || '' });

    if (!lr) {
      // No result entered — blank Time/Place/Remarks
      mods.push({ addr: `D${rowNum}`, value: '' });
      mods.push({ addr: `E${rowNum}`, value: '' });
      mods.push({ addr: `I${rowNum}`, value: '' });
      continue;
    }
    const rawRemark = (lr.remarks ?? '').toString().trim();
    const isMarker = MARKER_SET.has(rawRemark.toUpperCase());

    const timeStr = isMarker ? '' : timeToDotFormat(lr.raw_time, timeMode);
    mods.push({ addr: `D${rowNum}`, value: timeStr });

    // The template's E-column cells use numFmtId="49" (text format @).
    // Writing a numeric value into a text-formatted cell renders blank
    // in some downstream tools (the VBA reader was showing nothing).
    // Write Place as a string so the cell's intended formatting holds.
    const placeVal = isMarker ? '' : (lr.computed_position ?? '');
    mods.push({
      addr: `E${rowNum}`,
      value: (placeVal === '' || placeVal == null) ? '' : String(placeVal),
    });

    const remarkOut = isMarker ? rawRemark.toUpperCase() : rawRemark;
    mods.push({ addr: `I${rowNum}`, value: remarkOut || '' });
  }

  // Footnote (A11). Always rewrite with the race's progression text so
  // the bundled template's race-1 default doesn't leak into other
  // races. When this is a revision, append the revision marker on a
  // new line. The patcher's append:true path is reserved for cases
  // where the bundled template's footnote IS the base — here we always
  // override.
  const progressionBase = (race.progression_text || '').trim();
  let footnoteValue = progressionBase;
  if (newVersion > 1) {
    const revStamp = `Results v${newVersion} (revised ${isoToTime(nowISO())})${options.revisionNote ? ' — ' + options.revisionNote : ''}`;
    footnoteValue = footnoteValue ? `${footnoteValue}\n${revStamp}` : revStamp;
  }
  mods.push({ addr: 'A11', value: footnoteValue });

  // Patch the bundled xlsx template and emit under .xls filename.
  const templateBytes = await loadRaceTemplate();
  const patched = patchXlsxCells(templateBytes, mods);
  const xlsBlob = new Blob([patched]);
  const { local, shared } = await writeToBoth(
    '12 Output_Results', filename, xlsBlob,
    `80 Shared/${ref}_Output_Results`,
  );

  if (!local) {
    downloadFallback(filename, xlsBlob);
  }

  if (local && shared) {
    showToast(`Results saved to local + shared`, 'info', 2000);
  } else if (local) {
    showToast(`Results saved locally`, 'info', 2000);
  }

  // Update race + timesheet in a single transaction (atomic)
  const now = nowISO();
  race.export_time = now;
  race.export_version = newVersion;
  race.status = race.status === 'sent' ? 'sent' : 'exported';

  if (!race.export_history) race.export_history = [];
  race.export_history.push({
    version: newVersion,
    timestamp: now,
    is_revision: options.isRevision || false,
    revision_note: options.revisionNote || '',
  });

  const { db } = await import('./db.js');
  // db.config must be in the transaction scope because saveRace and
  // saveTimesheet both call assertNotLocked() which reads from it.
  // Without this, the transaction throws "object store not found"
  // since Dexie restricts table access to the declared scope.
  await db.transaction('rw', db.races, db.timesheet, db.config, async () => {
    await saveRace(race);
    const ts = await getTimesheet(raceNumber) || { race_number: raceNumber };
    if (!ts.export_time) { ts.export_time = now; } else { ts.re_export_time = now; }
    await saveTimesheet(ts);
  });

  broadcastChange('race-updated', { race_number: raceNumber });

  // Auto-backup after every export
  await backupAfterExport(raceNumber);

  // Queue for Supabase sync
  await queueRaceSync(raceNumber);

  // Round-completion check (fire-and-forget). If the round this race
  // belongs to is now fully exported AND auto-prompt is enabled in config,
  // the operator gets a modal offering to generate next-round draws.
  // Failures here never block export; the module logs internally.
  import('./round-completion.js')
    .then(m => m.checkRoundCompletionAfterExport(raceNumber))
    .catch(err => console.warn('round-completion check failed', err));

  return { success: true, version: newVersion, filename };
}

/**
 * Show the export modal (re-export vs revision).
 * @param {number} raceNumber
 * @param {function} onComplete - Called after export completes
 */
export async function showExportModal(raceNumber, onComplete) {
  const race = await getRace(raceNumber);
  const hasExported = race && race.export_version > 0;

  if (!hasExported) {
    // First export — no modal needed
    try {
      const result = await exportResults(raceNumber);
      showToast(`Race ${raceNumber} exported (v${result.version})`, 'success');
      if (onComplete) onComplete();
    } catch (err) {
      showToast(`Export failed: ${err.message}`, 'error');
    }
    return;
  }

  // Show re-export vs revision modal
  // Remove any existing orphaned modal first
  const existingModal = document.getElementById('exportModal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.id = 'exportModal';
  modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9998; display:flex; align-items:center; justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:24px; max-width:400px; width:90%; box-shadow:var(--shadow-lg);">
      <h5 style="font-size:16px; font-weight:600; margin-bottom:16px;">Race ${raceNumber} — Already Exported (v${race.export_version})</h5>
      <div style="margin-bottom:16px;">
        <label style="display:flex; align-items:center; gap:8px; margin-bottom:8px; cursor:pointer;">
          <input type="radio" name="exportType" value="reexport" checked>
          <span>Re-export (same version, no changes)</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="exportType" value="revision">
          <span>Revision (results were corrected)</span>
        </label>
      </div>
      <div id="revisionNoteGroup" style="display:none; margin-bottom:16px;">
        <label class="form-label">Revision note</label>
        <input class="form-input" id="revisionNote" type="text" placeholder="e.g. Lane 3 time corrected">
      </div>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button class="btn btn-ghost" id="exportCancel">Cancel</button>
        <button class="btn btn-primary" id="exportConfirm">Export</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Toggle revision note visibility
  modal.querySelectorAll('input[name="exportType"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.getElementById('revisionNoteGroup').style.display =
        radio.value === 'revision' && radio.checked ? 'block' : 'none';
    });
  });

  modal.querySelector('#exportCancel').addEventListener('click', () => modal.remove());
  modal.querySelector('#exportConfirm').addEventListener('click', async () => {
    const isRevision = modal.querySelector('input[name="exportType"]:checked').value === 'revision';
    const revisionNote = document.getElementById('revisionNote')?.value || '';
    modal.remove();

    try {
      const result = await exportResults(raceNumber, { isRevision, revisionNote });
      showToast(`Race ${raceNumber} exported (v${result.version})`, 'success');
      if (onComplete) onComplete();
    } catch (err) {
      showToast(`Export failed: ${err.message}`, 'error');
    }
  });
}
