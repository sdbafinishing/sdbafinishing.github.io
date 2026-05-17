/**
 * SDBA RDMS — Race Sheet Page
 * Individual race processing: input grid, timing, validation, export.
 */
import { getRace, saveRace, getLaneResults, saveLaneResult, bulkSaveLaneResults, getConfig, saveTimesheet, getTimesheet } from '../db.js';
import { ExcelGrid } from '../grid.js';
import { computeRankings, calcBatchDelta, validateRace } from '../race.js';
import { timeToMs, msToTime, timeToDisplay, isValidTime, nowISO, nowDisplay, isoToTime, showToast } from '../utils.js';
import { broadcastChange } from '../app.js';
import { showExportModal } from '../export.js';
import { sendToWhatsApp } from '../whatsapp.js';
import { promptNextRaceSignal, signalNextRace } from '../next-race-signal.js';
import { parseJoyiFile, importJoyiToDb } from '../import.js';
import { printResult, printDraw, openFileFromFolder } from '../print.js';
import { hasPermission } from '../rbac.js';

let grid = null;
let raceNumber = null;
let raceData = null;
let configData = null;
let timerInterval = null;
let batchDeltaMs = 0;
let saveDebounceTimer = null;
let batchDebounceTimer = null;
let joyiChangeHandler = null;
let p1InputHandler = null;
// Immutable per-mount snapshot of the original draws (lane_number → team info).
// Used so the output table's team column follows the user-entered lane_input,
// not the row index. See "lane input bug" in the audit.
let drawsByLane = {};

export async function mountRacePage(container, params) {
  // Defensive: clean up any previous mount that wasn't properly unmounted
  unmountRacePage();

  raceNumber = parseInt(params[0], 10);
  if (!raceNumber || raceNumber < 1) {
    container.innerHTML = '<div class="card"><p>Invalid race number.</p></div>';
    return;
  }

  configData = await getConfig();
  raceData = await getRace(raceNumber);

  if (!raceData) {
    container.innerHTML = `<div class="card"><p>Race ${raceNumber} not found. Import draws first.</p></div>`;
    return;
  }

  const laneCount = configData?.lane_count || 6;
  const timeMode = configData?.time_format_mode || 'mss00';
  const laneResults = await getLaneResults(raceNumber);

  // Snapshot draws keyed by the actual boat lane. Output uses this so changing
  // lane_input remaps the team correctly (previously the row index won).
  drawsByLane = {};
  laneResults.forEach(lr => {
    if (lr.lane_number) {
      drawsByLane[lr.lane_number] = {
        team_code: lr.team_code || '',
        team_name: lr.team_name || '',
        joyi_rank: lr.joyi_rank ?? null,
      };
    }
  });

  container.innerHTML = `
    <!-- Race Header -->
    <div class="card" style="margin-bottom:12px;">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; flex-wrap:wrap; gap:12px;">
        <div>
          <div style="font-size:12px; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:0.5px;">Race</div>
          <div style="font-size:32px; font-weight:700; line-height:1;">${raceNumber}</div>
          <div style="font-size:14px; color:var(--text-secondary); margin-top:4px;">${raceData.race_title || 'Untitled'}</div>
        </div>
        <div style="display:grid; grid-template-columns:repeat(4, auto); gap:16px; text-align:center;">
          <div>
            <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase;">Sched</div>
            <div style="font-size:14px; font-weight:500;">${raceData.race_time || '—'}</div>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase;">Start</div>
            <div style="font-size:14px; font-weight:500; color:var(--success);" id="raceStartTime">${raceData.start_time ? isoToTime(raceData.start_time) : '—'}</div>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase;">Export</div>
            <div style="font-size:14px; font-weight:500;" id="raceExportTime">${raceData.export_time ? isoToTime(raceData.export_time) : '—'}</div>
          </div>
          <div>
            <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase;">Send</div>
            <div style="font-size:14px; font-weight:500;" id="raceSendTime">${raceData.send_time ? isoToTime(raceData.send_time) : '—'}</div>
          </div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <span class="badge badge-${raceData.status}" id="raceStatus">${raceData.status?.toUpperCase() || 'PENDING'}</span>
          <span id="raceTimer" style="font-size:20px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--accent);"></span>
        </div>
      </div>
    </div>

    <!-- Navigation -->
    <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap;">
      ${raceNumber > 1 ? `<a href="#/race/${raceNumber - 1}" class="btn btn-outline"><i class="material-icons">chevron_left</i> Race ${raceNumber - 1}</a>` : ''}
      <a href="#/race/${raceNumber + 1}" class="btn btn-outline">Race ${raceNumber + 1} <i class="material-icons">chevron_right</i></a>
      <div style="flex:1;"></div>
      <button class="btn btn-danger btn-outline" onclick="window._cancelRace()" ${raceData.status === 'cancelled' ? 'disabled' : ''}>
        Cancel Race
      </button>
    </div>

    <!-- START Button -->
    ${hasPermission('race.start') ? `
    <div style="margin-bottom:16px;">
      <button class="btn btn-success btn-lg" style="width:100%;" onclick="window._startRace()" id="startBtn"
              ${raceData.status !== 'pending' && raceData.status !== 'started' ? 'disabled' : ''}>
        <i class="material-icons">play_arrow</i>
        ${raceData.start_time ? 'RESTART RACE' : 'START RACE'}
      </button>
    </div>
    ` : ''}

    <!-- Results Input Section -->
    <div class="card" style="margin-bottom:12px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <div class="section-header" style="margin:0; border:none;">Results Input — must be in finishing order</div>
        ${configData?.shared_joyi_folder || hasPermission('race.import_joyi') ? `
        <label class="btn btn-outline" style="cursor:pointer; font-size:12px; padding:4px 12px;">
          <i class="material-icons" style="font-size:16px;">cloud_download</i> Import Joyi
          <input type="file" accept=".xls,.xlsx" style="display:none;" id="joyiFileInput">
        </label>
        ` : ''}
      </div>
      <div id="inputGridContainer"></div>
    </div>

    <!-- Batch Adjustment -->
    <div class="card" style="margin-bottom:12px;">
      <div class="section-header">Batch Adjustment (Backup)</div>
      <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
        <div class="form-group" style="margin:0;">
          <label class="form-label">P1 Time (${timeMode})</label>
          <input class="form-input" id="batchP1Time" type="text" style="width:120px; font-family:monospace;"
                 placeholder="${timeMode === 'mmss00' ? '000000' : '00000'}">
        </div>
        <div>
          <div class="form-label">Difference</div>
          <span id="batchDelta" style="font-family:monospace; font-size:14px;">0.00.00</span>
        </div>
        <button class="btn btn-outline" onclick="window._finishBackup()">
          <i class="material-icons">timer</i> Finish (1st Boat) BACKUP ONLY
        </button>
      </div>
    </div>

    <!-- Validation -->
    <div id="validationPanel" style="margin-bottom:12px;"></div>

    <!-- Results Output Section -->
    <div class="card" style="margin-bottom:12px;">
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
        <div class="section-header" style="margin:0; border:none;">Results Output</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${hasPermission('race.export') ? `
          ${configData?.whatsapp_group
            ? `<button class="btn btn-primary" onclick="window._exportAndSend()"><i class="material-icons">send</i> Export & Send</button>`
            : ''}
          <button class="btn ${configData?.whatsapp_group ? 'btn-outline' : 'btn-primary'}" onclick="window._exportOnly()"><i class="material-icons">save</i> Export Only</button>
          ` : ''}
          ${hasPermission('race.send') && configData?.whatsapp_group ? `
          <button class="btn btn-outline" onclick="window._sendOnly()"><i class="material-icons">chat</i> Send Only</button>
          ` : ''}
          <span style="border-left:1px solid var(--border); margin:0 2px;"></span>
          <button class="btn btn-ghost" onclick="window._printResult()" title="Print result"><i class="material-icons">print</i></button>
          <button class="btn btn-ghost" onclick="window._printDraw()" title="Print draw"><i class="material-icons">description</i></button>
          <button class="btn btn-ghost" onclick="window._openDraw()" title="Open draw file"><i class="material-icons">folder_open</i></button>
          <button class="btn btn-ghost" onclick="window._openResult()" title="Open result file"><i class="material-icons">open_in_new</i></button>
        </div>
      </div>
      <div id="outputTableContainer"></div>
    </div>
  `;

  // Build input grid
  const gridData = buildGridData(laneResults, laneCount);
  const canEdit = hasPermission('race.input');
  const gridColumns = buildGridColumns(timeMode, canEdit);

  grid = new ExcelGrid(document.getElementById('inputGridContainer'), {
    rowCount: laneCount,
    columns: gridColumns,
    data: gridData,
    onChange: onCellChange,
  });

  // Initial ranking
  recalculate();

  // Start timer if race is started
  if (raceData.start_time) {
    startTimer();
  }

  // Attach handlers
  attachHandlers();
}

export function unmountRacePage() {
  // Clear all timers
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  clearTimeout(saveDebounceTimer); saveDebounceTimer = null;
  clearTimeout(batchDebounceTimer); batchDebounceTimer = null;

  // Destroy grid
  if (grid) { grid.destroy(); grid = null; }

  // Remove event listeners that were added in attachHandlers
  const joyiInput = document.getElementById('joyiFileInput');
  if (joyiInput && joyiChangeHandler) {
    joyiInput.removeEventListener('change', joyiChangeHandler);
  }
  joyiChangeHandler = null;

  const p1Input = document.getElementById('batchP1Time');
  if (p1Input && p1InputHandler) {
    p1Input.removeEventListener('input', p1InputHandler);
  }
  p1InputHandler = null;

  // Clear state
  raceNumber = null;
  raceData = null;
  batchDeltaMs = 0;
  drawsByLane = {};

  // Clean up window handlers
  delete window._startRace;
  delete window._cancelRace;
  delete window._finishBackup;
  delete window._exportAndSend;
  delete window._exportOnly;
  delete window._sendOnly;
  delete window._printResult;
  delete window._printDraw;
  delete window._openDraw;
  delete window._openResult;
}

function buildGridColumns(timeMode, canEdit = true) {
  const timeLen = timeMode === 'mmss00' ? 6 : 5;
  return [
    { key: 'lane_input', label: 'Lane', editable: canEdit, type: 'input', width: 50, maxLength: 2, placeholder: '#' },
    { key: 'raw_time', label: `Time (${timeMode})`, editable: canEdit, type: 'input', width: 90, maxLength: timeLen, placeholder: '0'.repeat(timeLen) },
    { key: 'penalty_time', label: 'TP (s)', editable: canEdit, type: 'input', width: 60, placeholder: '' },
    { key: 'display_time', label: 'Format', editable: false, type: 'computed', width: 80, format: (v) => v || '' },
    { key: 'computed_position', label: 'Place', editable: false, type: 'computed', width: 50, format: (v) => v ?? '' },
    { key: 'remarks', label: 'Remarks', editable: canEdit, type: 'input', width: 100, maxLength: 40,
      placeholder: '',
      suggestions: ['DNF', 'DSQ', 'DNS', 'DQ'],
    },
    { key: 'validation', label: 'Valid?', editable: false, type: 'computed', width: 50,
      format: (v) => {
        if (v === 1) return '\u25CF'; // green dot (styled via CSS)
        if (v === -2) return '\u2716'; // red X
        return '';
      }
    },
  ];
}

function buildGridData(laneResults, laneCount) {
  const data = [];
  for (let i = 0; i < laneCount; i++) {
    const lr = laneResults.find(r => r.lane_number === i + 1) || {};
    data.push({
      lane_input: lr.lane_input || '',
      raw_time: lr.raw_time || '',
      penalty_time: lr.penalty_time || '',
      display_time: '',
      computed_position: null,
      remarks: lr.remarks || '',
      validation: null,
      // Preserve DB fields
      lane_number: i + 1,
      race_number: raceNumber,
      team_code: lr.team_code || '',
      team_name: lr.team_name || '',
      joyi_rank: lr.joyi_rank || null,
    });
  }
  return data;
}

function onCellChange(rowIndex, colKey, newValue, rowData) {
  const timeMode = configData?.time_format_mode || 'mss00';

  // Update display time
  if (colKey === 'raw_time') {
    rowData.display_time = timeToDisplay(newValue, timeMode);
  }

  // Recalculate rankings
  recalculate();

  // Debounced save to IndexedDB
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => persistCurrentRow(rowIndex), 200);
}

function recalculate() {
  if (!grid) return;
  const data = grid.getData();
  const timeMode = configData?.time_format_mode || 'mss00';

  // Update display times
  data.forEach(row => {
    row.display_time = timeToDisplay(row.raw_time, timeMode);
  });

  // Compute rankings
  computeRankings(data, timeMode, batchDeltaMs);

  // Validation checks (G21/H22 equivalents)
  data.forEach((row, i) => {
    if (!row.raw_time && !row.remarks) {
      row.validation = null; // empty row
    } else if (row.raw_time && row.effective_time_ms != null) {
      row.validation = 1; // ok
      // Check time format
      if (row.raw_time && !isValidTime(row.raw_time, timeMode)) {
        row.validation = -2;
      }
    } else if (row.remarks) {
      row.validation = 1; // has remark, ok
    } else {
      row.validation = -2; // has time but invalid
    }
  });

  // Check input order (times should be ascending for finishing order input)
  const withTimes = data.filter(r => r.effective_time_ms != null);
  for (let i = 0; i < withTimes.length - 1; i++) {
    if (withTimes[i].effective_time_ms > withTimes[i + 1].effective_time_ms) {
      // Not in order — mark second one
      const idx = data.indexOf(withTimes[i + 1]);
      data[idx].validation = -2;
    }
  }

  // Refresh grid display
  grid.refreshAll();

  // Update output table
  renderOutput(data);

  // Update validation panel
  renderValidation(data);
}

// Use isValidTime from utils.js (imported at top) — no duplicate needed

async function persistCurrentRow(rowIndex) {
  const data = grid.getData();
  const row = data[rowIndex];
  await saveLaneResult({
    race_number: raceNumber,
    lane_number: row.lane_number,
    lane_input: row.lane_input,
    raw_time: row.raw_time,
    penalty_time: row.penalty_time,
    remarks: row.remarks,
    computed_position: row.computed_position,
    effective_time_ms: row.effective_time_ms,
    team_code: row.team_code,
    team_name: row.team_name,
    joyi_rank: row.joyi_rank,
  });
}

function renderOutput(data) {
  const container = document.getElementById('outputTableContainer');
  if (!container) return;
  const timeMode = configData?.time_format_mode || 'mss00';

  // Sort by position for output (nulls at end)
  const sorted = [...data].sort((a, b) => {
    if (a.computed_position == null && b.computed_position == null) return 0;
    if (a.computed_position == null) return 1;
    if (b.computed_position == null) return -1;
    return a.computed_position - b.computed_position;
  });

  const rows = sorted.map(r => {
    const posClass = r.computed_position === 1 ? 'first' : r.computed_position === 2 ? 'second' : r.computed_position === 3 ? 'third' : '';
    const remarksDisplay = [];
    if (r.penalty_time) remarksDisplay.push(`TP=${r.penalty_time}s`);
    if (r.remarks) remarksDisplay.push(r.remarks);

    // Resolve the actual lane the user typed, and look up the team from the
    // immutable draws snapshot. Do NOT fall back to row index — a blank
    // lane_input means the operator left it blank, and that should be visible.
    const laneVal = parseInt(r.lane_input, 10);
    const laneDisplay = laneVal >= 1 && laneVal <= (configData?.lane_count || 6) ? laneVal : '';
    const draw = laneVal ? drawsByLane[laneVal] : null;
    const teamName = draw?.team_name || '';
    const teamCode = draw?.team_code || '';

    return `<tr>
      <td>${laneDisplay}</td>
      <td>${timeToDisplay(r.raw_time, timeMode)}</td>
      <td class="cell-position ${posClass}">${r.remarks && ['DSQ', 'DQ'].includes(r.remarks) ? r.remarks : (r.computed_position ?? '')}</td>
      <td>${remarksDisplay.join(', ')}</td>
      <td class="team-name">${teamName}</td>
      <td>${teamCode}</td>
    </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="output-table">
      <thead><tr>
        <th>Lane</th><th>Time</th><th>Place</th><th>Remarks</th><th>Team Name</th><th>Code</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderValidation(data) {
  const panel = document.getElementById('validationPanel');
  if (!panel) return;

  const result = validateRace(raceData, data, configData || { lane_count: 6, time_format_mode: 'mss00' });

  if (result.errors.length === 0 && result.warnings.length === 0) {
    const hasData = data.some(r => r.raw_time || r.remarks);
    if (!hasData) {
      panel.innerHTML = '';
      return;
    }
    panel.innerHTML = `<div style="padding:8px 14px; border-radius:var(--radius-sm); background:var(--success-bg); color:var(--success-text); font-size:13px;">
      <i class="material-icons" style="font-size:16px; vertical-align:middle; margin-right:6px;">check_circle</i>
      All checks passed
    </div>`;
    return;
  }

  panel.innerHTML = [
    ...result.errors.map(e => `<div style="padding:6px 14px; margin-bottom:4px; border-radius:var(--radius-sm); border-left:3px solid var(--danger); background:var(--danger-bg); color:var(--danger-text); font-size:13px;">
      <i class="material-icons" style="font-size:14px; vertical-align:middle; margin-right:4px;">error</i> ${e}
    </div>`),
    ...result.warnings.map(w => `<div style="padding:6px 14px; margin-bottom:4px; border-radius:var(--radius-sm); border-left:3px solid var(--warning); background:var(--warning-bg); color:var(--warning-text); font-size:13px;">
      <i class="material-icons" style="font-size:14px; vertical-align:middle; margin-right:4px;">warning</i> ${w}
    </div>`),
  ].join('');
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  const timerEl = document.getElementById('raceTimer');
  if (!timerEl || !raceData.start_time) return;

  function update() {
    const elapsed = Date.now() - new Date(raceData.start_time).getTime();
    const totalSec = Math.floor(elapsed / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const cs = Math.floor((elapsed % 1000) / 10);
    timerEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  update();
  timerInterval = setInterval(update, 100);
}

/**
 * Check previous races for missing exports/sends (VBA pattern).
 * Shows warnings for any earlier race that hasn't been exported or sent.
 */
async function checkPreviousRaces(currentRaceNum) {
  const { getAllRaces } = await import('../db.js');
  const allRaces = await getAllRaces();

  const missingExports = [];
  const missingSends = [];

  for (const r of allRaces) {
    if (r.race_number >= currentRaceNum) continue;
    if (r.status === 'cancelled') continue;
    if (r.status === 'pending') continue;

    if (!r.export_time) missingExports.push(r.race_number);
    if (!r.send_time) missingSends.push(r.race_number);
  }

  if (missingExports.length > 0) {
    showToast(`Reminder: Race(s) ${missingExports.join(', ')} NOT exported`, 'warning', 6000);
  }
  if (missingSends.length > 0) {
    showToast(`Reminder: Race(s) ${missingSends.join(', ')} NOT sent`, 'warning', 6000);
  }
}

function attachHandlers() {
  window._startRace = async () => {
    const now = nowISO();
    if (raceData.start_time) {
      raceData.restart_time = now;
      showToast(`Race ${raceNumber} restarted`, 'info');
    } else {
      raceData.start_time = now;
      raceData.status = 'started';
      showToast(`Race ${raceNumber} started!`, 'success');
    }
    await saveRace(raceData);
    await saveTimesheet({ race_number: raceNumber, start_time: raceData.start_time, restart_time: raceData.restart_time });
    broadcastChange('race-updated', { race_number: raceNumber });

    document.getElementById('raceStartTime').textContent = isoToTime(raceData.start_time);
    document.getElementById('raceStatus').textContent = 'STARTED';
    document.getElementById('raceStatus').className = 'badge badge-started';
    document.getElementById('startBtn').innerHTML = '<i class="material-icons">replay</i> RESTART RACE';
    startTimer();

    // Refresh validation panel so "Race has no start time" clears.
    recalculate();

    // Force-signal this race as "next" on the mobile app, in case it was
    // missed by the export flow of the prior race.
    signalNextRace(raceNumber).catch(() => {});
  };

  window._cancelRace = async () => {
    if (!confirm(`Cancel Race ${raceNumber}? This can be reversed by changing status back in DB Admin.`)) return;
    raceData.status = 'cancelled';
    await saveRace(raceData);
    broadcastChange('race-updated', { race_number: raceNumber });
    document.getElementById('raceStatus').textContent = 'CANCELLED';
    document.getElementById('raceStatus').className = 'badge badge-cancelled';
    showToast(`Race ${raceNumber} cancelled. To reverse, go to DB Admin → races → change status back to "pending".`, 'warning', 8000);
  };

  window._finishBackup = () => {
    const p1Input = document.getElementById('batchP1Time');
    const timeMode = configData?.time_format_mode || 'mss00';
    const data = grid.getData();
    const firstTime = data.find(r => r.raw_time)?.raw_time;

    if (p1Input.value) {
      batchDeltaMs = calcBatchDelta(p1Input.value, firstTime, timeMode);
    } else {
      // Record finish timestamp for first boat
      p1Input.value = ''; // user inputs P1 time manually
    }

    const deltaDisplay = timeToDisplay(msToTime(Math.abs(batchDeltaMs), timeMode), timeMode);
    document.getElementById('batchDelta').textContent = (batchDeltaMs >= 0 ? '+' : '-') + deltaDisplay;
    recalculate();
  };

  window._exportAndSend = async () => {
    await showExportModal(raceNumber, async () => {
      await sendToWhatsApp(raceNumber);
      // Update send time
      raceData = await getRace(raceNumber);
      raceData.send_time = nowISO();
      raceData.status = 'sent';
      await saveRace(raceData);
      const ts = await getTimesheet(raceNumber) || { race_number: raceNumber };
      if (!ts.send_time) { ts.send_time = raceData.send_time; } else { ts.re_send_time = raceData.send_time; }
      await saveTimesheet(ts);
      document.getElementById('raceSendTime').textContent = isoToTime(raceData.send_time);
      document.getElementById('raceStatus').textContent = 'SENT';
      document.getElementById('raceStatus').className = 'badge badge-sent';
      broadcastChange('race-updated', { race_number: raceNumber });
      // Prompt next race signal (skips if already signaled by another tab)
      await promptNextRaceSignal(raceNumber);
      // Check previous races for missing exports/sends
      await checkPreviousRaces(raceNumber);
    });
    // Update export display
    raceData = await getRace(raceNumber);
    if (raceData.export_time) {
      document.getElementById('raceExportTime').textContent = isoToTime(raceData.export_time);
    }
  };

  window._exportOnly = () => {
    showExportModal(raceNumber, async () => {
      raceData = await getRace(raceNumber);
      document.getElementById('raceExportTime').textContent = isoToTime(raceData.export_time);
      document.getElementById('raceStatus').textContent = 'EXPORTED';
      document.getElementById('raceStatus').className = 'badge badge-exported';
      // Reminder: send results to scoring team (VBA: "Please send Results to Scoring Team when ready!")
      showToast('Export complete. Send results to the scoring team when ready.', 'success', 5000);
      // Prompt next race signal
      await promptNextRaceSignal(raceNumber);
      await checkPreviousRaces(raceNumber);
    });
  };

  window._sendOnly = async () => {
    // Check if results exported first (VBA: "Results not yet exported. System will now export Results before sending.")
    raceData = await getRace(raceNumber);
    if (!raceData.export_time) {
      if (!confirm('Results not yet exported for this race. Export first before sending?')) return;
      showExportModal(raceNumber);
      return;
    }
    await sendToWhatsApp(raceNumber);
    raceData = await getRace(raceNumber);
    raceData.send_time = nowISO();
    raceData.status = 'sent';
    await saveRace(raceData);
    const ts = await getTimesheet(raceNumber) || { race_number: raceNumber };
    if (!ts.send_time) { ts.send_time = raceData.send_time; } else { ts.re_send_time = raceData.send_time; }
    await saveTimesheet(ts);
    document.getElementById('raceSendTime').textContent = isoToTime(raceData.send_time);
    document.getElementById('raceStatus').textContent = 'SENT';
    document.getElementById('raceStatus').className = 'badge badge-sent';
    broadcastChange('race-updated', { race_number: raceNumber });
    // Prompt next race signal
    await promptNextRaceSignal(raceNumber);
    await checkPreviousRaces(raceNumber);
  };

  // Print / Open handlers
  window._printResult = () => printResult(raceNumber);
  window._printDraw = () => printDraw(raceNumber);
  window._openDraw = () => openFileFromFolder('01 Input_Draw', raceNumber);
  window._openResult = async () => {
    const r = await getRace(raceNumber);
    if (!r?.export_time) {
      showToast('Results not yet exported for this race.', 'error');
      return;
    }
    openFileFromFolder('12 Output_Results', raceNumber);
  };

  // Joyi import — store handler ref for cleanup in unmount
  const joyiInput = document.getElementById('joyiFileInput');
  if (joyiInput) {
    joyiChangeHandler = async () => {
      const file = joyiInput.files[0];
      if (!file) return;
      try {
        const parsed = await parseJoyiFile(file);
        if (parsed.raceNumber !== raceNumber) {
          if (!confirm(`This Joyi file is for Race ${parsed.raceNumber}, but you're on Race ${raceNumber}. Import anyway?`)) return;
        }
        await importJoyiToDb({ ...parsed, raceNumber });
        const freshLanes = await getLaneResults(raceNumber);
        const newGridData = buildGridData(freshLanes, configData?.lane_count || 6);
        for (let i = 0; i < newGridData.length; i++) {
          grid.setRowData(i, newGridData[i]);
        }
        raceData = await getRace(raceNumber);
        recalculate();
        showToast(`Joyi results imported for Race ${raceNumber} (${parsed.results.length} lanes)`, 'success');
        broadcastChange('race-updated', { race_number: raceNumber });
      } catch (err) {
        showToast(`Joyi import failed: ${err.message}`, 'error');
      }
      joyiInput.value = '';
    };
    joyiInput.addEventListener('change', joyiChangeHandler);
  }

  // Batch adjustment — store handler ref for cleanup in unmount
  const p1Input = document.getElementById('batchP1Time');
  if (p1Input) {
    p1InputHandler = () => {
      const timeMode = configData?.time_format_mode || 'mss00';
      const data = grid?.getData();
      if (!data) return;
      const firstTime = data.find(r => r.raw_time)?.raw_time;
      if (p1Input.value && firstTime) {
        batchDeltaMs = calcBatchDelta(p1Input.value, firstTime, timeMode);
        const deltaDisplay = timeToDisplay(msToTime(Math.abs(batchDeltaMs), timeMode), timeMode);
        document.getElementById('batchDelta').textContent = (batchDeltaMs >= 0 ? '+' : '-') + deltaDisplay;
        clearTimeout(batchDebounceTimer);
        batchDebounceTimer = setTimeout(recalculate, 200);
      }
    };
    p1Input.addEventListener('input', p1InputHandler);
  }
}
