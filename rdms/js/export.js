/**
 * SDBA RDMS — Export Engine
 * Export results to .xls (stamp into original draw file).
 * Generate start lists (Joyi + SprintTimer formats).
 */
import * as XLSX from 'xlsx';
import { getConfig, getRace, saveRace, getLaneResults, getAllRaces, saveTimesheet, getTimesheet } from './db.js';
import { timeToDisplay, nowISO, isoToTime, showToast } from './utils.js';
import { broadcastChange } from './app.js';
import { backupAfterExport } from './backup.js';
import { writeToBoth, downloadFallback } from './file-access.js';
import { queueRaceSync } from './sync.js';

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

  // Pre-export validation (matches VBA ValidateResults)
  const hasInput = lanes.some(l => l.raw_time || l.remarks);
  if (!hasInput) {
    throw new Error('No results input detected. Cannot export empty results.');
  }

  // Check rank mismatch (Joyi vs computed) — blocks export like VBA
  const mismatches = lanes.filter(l =>
    l.joyi_rank != null && l.computed_position != null && l.joyi_rank !== l.computed_position
  );
  if (mismatches.length > 0) {
    const details = mismatches.map(l => `Lane ${l.lane_number}: position ${l.computed_position} != Joyi rank ${l.joyi_rank}`).join(', ');
    throw new Error(`Rank mismatch detected: ${details}. Resolve before exporting.`);
  }

  // Check each team with a name has time or remark
  const activeLanes = lanes.slice(0, config?.lane_count || 6);
  const missingResults = activeLanes.filter(l =>
    l.team_name && l.team_name !== '---' && l.team_name !== '' && !l.raw_time && !l.remarks
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

  // Sort lanes by position for output
  const sorted = [...lanes].sort((a, b) => {
    if (a.computed_position == null && b.computed_position == null) return a.lane_number - b.lane_number;
    if (a.computed_position == null) return 1;
    if (b.computed_position == null) return -1;
    return a.computed_position - b.computed_position;
  });

  // Build worksheet
  const wsData = [];

  // Header
  wsData.push([`Race ${raceNumber} — ${race.race_title || ''}`]);
  wsData.push([`Event: ${config?.event_long_name_en || ''} (${config?.event_short_ref || ''})`]);
  wsData.push([`Date: ${config?.race_date || ''}`]);
  if (race.start_time) wsData.push([`Start Time: ${isoToTime(race.start_time)}`]);

  // Revision header
  if (newVersion > 1) {
    wsData.push([`Results v${newVersion} (Revised ${isoToTime(nowISO())}) — "${options.revisionNote || ''}"`]);
  }

  wsData.push([]);
  wsData.push(['Lane', 'Time', 'Place', 'Remarks', 'Team Name', 'Code']);

  sorted.forEach(lr => {
    const remarksDisplay = [];
    if (lr.penalty_time) remarksDisplay.push(`TP=${lr.penalty_time}s`);
    if (lr.remarks) remarksDisplay.push(lr.remarks);

    wsData.push([
      lr.lane_number,
      timeToDisplay(lr.raw_time, timeMode),
      lr.remarks && ['DSQ', 'DQ'].includes(lr.remarks) ? lr.remarks : (lr.computed_position ?? ''),
      remarksDisplay.join(', '),
      lr.team_name || '',
      lr.team_code || '',
    ]);
  });

  // Create workbook and trigger download
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `Race${raceNumber}`);

  const filename = `${config?.event_short_ref || 'RDMS'}_Race${String(raceNumber).padStart(2, '0')}_Results.xls`;

  // Write to 12 Output_Results/ (local) + 80 Shared/{ref}_Output_Results/ (shared)
  const ref = config?.event_short_ref || 'RDMS';
  const xlsBlob = new Blob([XLSX.write(wb, { bookType: 'xls', type: 'array' })]);
  const { local, shared } = await writeToBoth(
    '12 Output_Results', filename, xlsBlob,
    `80 Shared/${ref}_Output_Results`
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
  await db.transaction('rw', db.races, db.timesheet, async () => {
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
