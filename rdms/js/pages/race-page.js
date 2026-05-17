/**
 * SDBA RDMS — Race Sheet Page
 * Individual race processing: input grid, timing, validation, export.
 */
import { getRace, saveRace, getLaneResults, saveLaneResult, bulkSaveLaneResults, getConfig, saveTimesheet, getTimesheet, getAllRaces, getAllDivisions } from '../db.js';
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
    // No race specified — show a picker so the Race nav tab is useful on
    // first click, instead of showing an "Invalid race number" dead-end.
    await renderRacePicker(container);
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

  // Resolve the division this race belongs to (for the colour swatch).
  let divisionInfo = null;
  if (raceData.division_id) {
    const divs = await getAllDivisions();
    divisionInfo = divs.find(d => d.id === raceData.division_id) || null;
  }
  const divColour = divisionInfo?.colour_hex || '#9ca3af';
  const divLabel = divisionInfo ? (divisionInfo.div_short_ref || divisionInfo.division_name || '') : '';

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
    <!-- Race Header — odd/even shaded to match the race-list striping. -->
    <div class="card" style="margin-bottom:8px; padding:10px 14px; ${raceNumber % 2 === 1 ? 'background: rgba(250, 204, 21, 0.10);' : ''}">
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <span title="${divLabel}" style="display:inline-block; width:10px; height:32px; border-radius:3px; background:${divColour}; flex-shrink:0;"></span>
          <div>
            <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:0.5px;">Race</div>
            <div style="font-size:22px; font-weight:700; line-height:1.1;">${raceNumber}</div>
            <div style="font-size:13px; color:var(--text-secondary); margin-top:2px;">${raceData.race_title || 'Untitled'}</div>
          </div>
        </div>
        <div style="display:grid; grid-template-columns:repeat(4, auto); gap:14px; text-align:center;">
          <div>
            <div style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase;">Sched</div>
            <div style="font-size:13px; font-weight:500;">${raceData.race_time || '—'}</div>
          </div>
          <div>
            <div style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase;">Start</div>
            <div style="font-size:13px; font-weight:500; color:var(--success);" id="raceStartTime">${renderStartTimeText(raceData)}</div>
          </div>
          <div>
            <div style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase;">Export</div>
            <div style="font-size:13px; font-weight:500;" id="raceExportTime">${renderExportTimeText(raceData)}</div>
          </div>
          <div>
            <div style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase;">Send</div>
            <div style="font-size:13px; font-weight:500;" id="raceSendTime">${renderSendTimeText(raceData)}</div>
          </div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:2px;">
          <div style="display:flex; gap:6px; align-items:center;">
            <span class="badge badge-${raceData.status}" id="raceStatus">${raceData.status?.toUpperCase() || 'PENDING'}</span>
            <span id="raceTimer" style="font-size:18px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--accent);"></span>
          </div>
          <button class="btn btn-ghost" id="stopCounterBtn" onclick="window._stopCounter()" title="Stop the running counter (data is preserved)"
                  style="font-size:11px; padding:1px 8px; ${raceData.status === 'started' && raceData.start_time ? '' : 'display:none;'}">
            <i class="material-icons" style="font-size:14px;">pause</i> Stop
          </button>
        </div>
      </div>
    </div>

    <!-- Navigation — odd/even tint on the prev/next buttons matches the
         race-table striping so the operator can tell parity at a glance. -->
    <div style="display:flex; gap:6px; margin-bottom:6px; flex-wrap:wrap; align-items:center;">
      ${raceNumber > 1 ? `<a href="#/race/${raceNumber - 1}" class="btn btn-outline btn-sm" style="${(raceNumber - 1) % 2 === 1 ? 'background: rgba(250, 204, 21, 0.12);' : ''}"><i class="material-icons" style="font-size:16px;">chevron_left</i> Race ${raceNumber - 1}</a>` : ''}
      <a href="#/race/${raceNumber + 1}" class="btn btn-outline btn-sm" style="${(raceNumber + 1) % 2 === 1 ? 'background: rgba(250, 204, 21, 0.12);' : ''}">Race ${raceNumber + 1} <i class="material-icons" style="font-size:16px;">chevron_right</i></a>
      <span style="border-left:1px solid var(--border); height:20px; margin:0 4px;"></span>
      <button class="btn btn-ghost btn-sm" onclick="window._printDraw()" title="Print draw"><i class="material-icons" style="font-size:16px;">description</i> Print Draw</button>
      <button class="btn btn-ghost btn-sm" onclick="window._openDraw()" title="Open draw file"><i class="material-icons" style="font-size:16px;">folder_open</i> Open Draw</button>
      <div style="flex:1;"></div>
      <button class="btn btn-danger btn-outline btn-sm" onclick="window._cancelRace()" ${raceData.status === 'cancelled' ? 'disabled' : ''}>
        Cancel Race
      </button>
    </div>

    <!-- START / RESTART + FINISH row (70:30) -->
    ${hasPermission('race.start') ? `
    <div style="display:flex; gap:6px; margin-bottom:8px;" id="startStopWrap"></div>
    ` : ''}

    <!-- Results Input Section -->
    <div class="card" style="margin-bottom:8px; padding:10px 14px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
        <div class="section-header" style="margin:0; border:none;">Results Input — must be in finishing order</div>
        ${configData?.shared_joyi_folder || hasPermission('race.import_joyi') ? `
        <label class="btn btn-outline" style="cursor:pointer; font-size:12px; padding:3px 10px;">
          <i class="material-icons" style="font-size:16px;">cloud_download</i> Import Joyi
          <input type="file" accept=".xls,.xlsx" style="display:none;" id="joyiFileInput">
        </label>
        ` : ''}
      </div>
      <div id="inputGridContainer"></div>
    </div>

    <!-- Batch Adjustment — collapsed by default, fallback for the FINISH capture -->
    <details style="margin-bottom:8px; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-sm);">
      <summary style="cursor:pointer; padding:6px 14px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-tertiary); user-select:none;">
        Batch Adjustment (Backup)
      </summary>
      <div style="padding:8px 14px 10px; display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
        <div class="form-group" style="margin:0;">
          <label class="form-label">P1 Time (${timeMode})</label>
          <input class="form-input" id="batchP1Time" type="text" style="width:120px; font-family:monospace;"
                 placeholder="${timeMode === 'mmss00' ? '000000' : '00000'}">
        </div>
        <div>
          <div class="form-label">Difference</div>
          <span id="batchDelta" style="font-family:monospace; font-size:14px;">0.00.00</span>
        </div>
      </div>
    </details>

    <!-- Validation -->
    <div id="validationPanel" style="margin-bottom:8px;"></div>

    <!-- Results Output Section -->
    <div class="card" style="margin-bottom:8px; padding:10px 14px;">
      <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
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

  // Render the START/RESTART + FINISH button row now that handlers are wired.
  if (hasPermission('race.start')) renderStartStopButton();
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
  delete window._stopCounter;
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

/**
 * Render a race picker when the Race nav tab is clicked without a race number.
 * Lists every race grouped by status with quick links, instead of the old
 * "Invalid race number" dead-end.
 */
async function renderRacePicker(container) {
  const allRaces = await getAllRaces();
  const divisions = await getAllDivisions();
  const divMap = Object.fromEntries(divisions.map(d => [d.id, d]));

  if (!allRaces || allRaces.length === 0) {
    container.innerHTML = `<div class="card" style="text-align:center; padding:40px;">
      <i class="material-icons" style="font-size:48px; color:var(--text-tertiary);">event_busy</i>
      <h3 style="margin-top:12px;">No races loaded</h3>
      <p style="color:var(--text-tertiary);">Go to <a href="#/setup">Setup</a> → Import Draws first.</p>
    </div>`;
    return;
  }

  const sorted = [...allRaces].sort((a, b) => a.race_number - b.race_number);
  const statusBadge = (s) => {
    const map = {
      pending: ['badge-pending', 'PENDING'],
      started: ['badge-started', 'STARTED'],
      exported: ['badge-exported', 'EXPORTED'],
      sent: ['badge-sent', 'SENT'],
      cancelled: ['badge-cancelled', 'CANCELLED'],
    };
    const [cls, label] = map[s] || ['badge-pending', (s || 'PENDING').toUpperCase()];
    return `<span class="badge ${cls}">${label}</span>`;
  };

  container.innerHTML = `
    <div class="card" style="padding:16px;">
      <div class="section-header" style="margin-bottom:12px;">Pick a race</div>
      <table class="race-table" style="width:100%;">
        <thead><tr>
          <th style="text-align:left;">#</th>
          <th style="text-align:left;">Title</th>
          <th style="text-align:left;">Division</th>
          <th style="text-align:left;">Sched</th>
          <th style="text-align:left;">Status</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${sorted.map(r => {
            const div = r.division_id ? divMap[r.division_id] : null;
            const divCol = div?.colour_hex || '#9ca3af';
            const divName = div ? (div.div_short_ref || div.division_name || '') : '';
            return `<tr>
              <td><strong>${r.race_number}</strong></td>
              <td>${r.race_title || '—'}</td>
              <td><span class="division-color" style="background:${divCol};"></span>${divName}</td>
              <td style="color:var(--text-tertiary);">${r.race_time || ''}</td>
              <td>${statusBadge(r.status)}</td>
              <td><a href="#/race/${r.race_number}" class="btn btn-outline" style="padding:4px 12px; font-size:12px;">Open</a></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
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

  const laneCount = configData?.lane_count || 6;

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

  // Lane validity per row — blank/out-of-range/duplicate lane_input flips the
  // row to invalid so the per-row colour + Valid? indicator agree with the
  // panel message (panel says "lane out of range" → row also goes red).
  const laneCounts = new Map();
  data.forEach(row => {
    if (!row.raw_time && !row.remarks) return;
    const lane = parseInt(row.lane_input, 10);
    if (Number.isInteger(lane) && lane >= 1 && lane <= laneCount) {
      laneCounts.set(lane, (laneCounts.get(lane) || 0) + 1);
    }
  });
  data.forEach(row => {
    if (!row.raw_time && !row.remarks) return;
    if (row.validation === -2) return; // already invalid for another reason
    const laneStr = (row.lane_input ?? '').toString().trim();
    if (laneStr === '') {
      row.validation = -2; // blank lane while row has data
      return;
    }
    const lane = parseInt(laneStr, 10);
    if (!Number.isInteger(lane) || lane < 1 || lane > laneCount) {
      row.validation = -2; // out of range
      return;
    }
    if ((laneCounts.get(lane) || 0) > 1) {
      row.validation = -2; // duplicate lane across rows
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

  // Apply per-row validity colour so the operator can see at a glance which
  // rows are incomplete or invalid without scanning the panel.
  applyRowValidationStyles(data);

  // Hide the running clock once the operator starts logging results or after
  // a Joyi import populates raw_time — the focus should be on data, not the
  // clock at that point. Show again only when the race restarts (no times yet).
  const timerEl = document.getElementById('raceTimer');
  if (timerEl) {
    const hasResults = data.some(r => r.raw_time);
    timerEl.style.display = hasResults ? 'none' : '';
  }

  // Update output table
  renderOutput(data);

  // Update validation panel
  renderValidation(data);
}

function applyRowValidationStyles(data) {
  const trs = document.querySelectorAll('#inputGridContainer table.excel-grid tbody tr');
  trs.forEach((tr, i) => {
    const row = data[i];
    tr.classList.remove('row-valid', 'row-invalid', 'row-warning');
    if (!row) return;
    if (row.validation === -2) tr.classList.add('row-invalid');
    else if (row.validation === 1) tr.classList.add('row-valid');
    else if (row.raw_time || row.remarks) tr.classList.add('row-warning');
  });
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
  const laneCount = configData?.lane_count || 6;

  // Bottom section is a fixed-lane view of the same data the operator types
  // into the top section. One row per lane 1..laneCount, always in order.
  // Time/place/remarks come from whichever input row references this lane
  // via lane_input; if no row does, the cells stay blank.
  const inputByLane = {};
  data.forEach(r => {
    const lane = parseInt(r.lane_input, 10);
    if (Number.isInteger(lane) && lane >= 1 && lane <= laneCount) {
      // If two rows somehow point at the same lane, validation flags it;
      // here we keep the last-wins so the operator at least sees something.
      inputByLane[lane] = r;
    }
  });

  const rowsHtml = [];
  for (let lane = 1; lane <= laneCount; lane++) {
    const r = inputByLane[lane];
    const draw = drawsByLane[lane] || {};
    const teamName = draw.team_name || '';
    const teamCode = draw.team_code || '';

    if (!r) {
      rowsHtml.push(`<tr>
        <td>${lane}</td>
        <td></td>
        <td></td>
        <td></td>
        <td class="team-name">${teamName}</td>
        <td>${teamCode}</td>
      </tr>`);
      continue;
    }

    const posClass = r.computed_position === 1 ? 'first' : r.computed_position === 2 ? 'second' : r.computed_position === 3 ? 'third' : '';
    const remarksDisplay = [];
    if (r.penalty_time) remarksDisplay.push(`TP=${r.penalty_time}s`);
    if (r.remarks) remarksDisplay.push(r.remarks);

    rowsHtml.push(`<tr>
      <td>${lane}</td>
      <td>${timeToDisplay(r.raw_time, timeMode)}</td>
      <td class="cell-position ${posClass}">${r.remarks && ['DSQ', 'DQ'].includes(r.remarks) ? r.remarks : (r.computed_position ?? '')}</td>
      <td>${remarksDisplay.join(', ')}</td>
      <td class="team-name">${teamName}</td>
      <td>${teamCode}</td>
    </tr>`);
  }

  container.innerHTML = `
    <table class="output-table">
      <thead><tr>
        <th>Lane</th><th>Time</th><th>Place</th><th>Remarks</th><th>Team Name</th><th>Code</th>
      </tr></thead>
      <tbody>${rowsHtml.join('')}</tbody>
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
  const baseline = raceData.restart_time || raceData.start_time;
  if (!timerEl || !baseline) return;

  function update() {
    const elapsed = Date.now() - new Date(baseline).getTime();
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

/**
 * Render the primary action row: START or RESTART on the left (~70%) + a
 * FINISH-capture button on the right (~30%). After the race has been started
 * once, the left button permanently becomes RESTART. FINISH stays enabled as
 * long as there's a start time; clicking it again will prompt to override.
 */
function renderStartStopButton() {
  const wrap = document.getElementById('startStopWrap');
  if (!wrap) return;
  const cancelled = raceData.status === 'cancelled';
  const everStarted = !!raceData.start_time;
  const startLabel = everStarted ? 'RESTART RACE' : 'START RACE';
  const startIcon = everStarted ? 'replay' : 'play_arrow';
  const startCls = everStarted ? 'btn-primary' : 'btn-success';
  const finishDisabled = (!everStarted || cancelled) ? 'disabled' : '';

  wrap.innerHTML = `
    <button class="btn ${startCls}" style="flex:7;" onclick="window._startRace()" id="startBtn" ${cancelled ? 'disabled' : ''}>
      <i class="material-icons">${startIcon}</i> ${startLabel}
    </button>
    <button class="btn btn-outline" style="flex:3;" onclick="window._finishBackup()" id="finishBtn" ${finishDisabled}
            title="Capture first-boat finish timestamp at click moment">
      <i class="material-icons">flag</i> FINISH
    </button>
  `;
}

/**
 * Header "Start" cell content. If a restart_time exists, show the original
 * struck through next to the active restart_time so the operator can see
 * both.
 */
function renderStartTimeText(race) {
  if (!race.start_time && !race.restart_time) return '—';
  if (race.restart_time && race.start_time) {
    return `<s style="color:var(--text-tertiary); font-weight:400;">${isoToTime(race.start_time)}</s> → ${isoToTime(race.restart_time)}`;
  }
  return isoToTime(race.start_time || race.restart_time);
}

/**
 * Header "Export" cell — if there's been more than one export, show the
 * previous one struck through next to the latest.
 */
function renderExportTimeText(race) {
  if (!race.export_time) return '—';
  const history = race.export_history || [];
  if (history.length >= 2) {
    const prev = history[history.length - 2]?.timestamp;
    if (prev) {
      return `<s style="color:var(--text-tertiary); font-weight:400;">${isoToTime(prev)}</s> → ${isoToTime(race.export_time)}`;
    }
  }
  return isoToTime(race.export_time);
}

/**
 * Header "Send" cell — if there's been a re-send, show the previous send
 * struck through next to the latest.
 */
function renderSendTimeText(race) {
  if (!race.send_time) return '—';
  if (race.prev_send_time) {
    return `<s style="color:var(--text-tertiary); font-weight:400;">${isoToTime(race.prev_send_time)}</s> → ${isoToTime(race.send_time)}`;
  }
  return isoToTime(race.send_time);
}

function attachHandlers() {
  window._startRace = async () => {
    const now = nowISO();
    const isRestart = !!raceData.start_time;
    if (isRestart) {
      if (!confirm(`Restart Race ${raceNumber}? The original start time stays for the record; the timer resets to 0.`)) return;
      raceData.restart_time = now;
    } else {
      raceData.start_time = now;
      raceData.restart_time = null;
    }
    raceData.status = 'started';
    await saveRace(raceData);
    await saveTimesheet({
      race_number: raceNumber,
      start_time: raceData.start_time,
      restart_time: raceData.restart_time,
    });
    broadcastChange('race-updated', { race_number: raceNumber });

    document.getElementById('raceStartTime').innerHTML = renderStartTimeText(raceData);
    document.getElementById('raceStatus').textContent = 'STARTED';
    document.getElementById('raceStatus').className = 'badge badge-started';
    renderStartStopButton();
    // Show the small Stop button next to the timer.
    const stopBtn = document.getElementById('stopCounterBtn');
    if (stopBtn) stopBtn.style.display = '';
    startTimer();
    showToast(isRestart ? `Race ${raceNumber} restarted` : `Race ${raceNumber} started!`, isRestart ? 'info' : 'success');

    // Clear "Race has no start time" validation error.
    recalculate();

    // Force-signal this race as "next" on the mobile app, in case the prior
    // race's export flow missed it.
    signalNextRace(raceNumber).catch(() => {});
  };

  // STOP just halts the running counter. No data change — the start_time
  // (and restart_time if any) stays so it can still be exported. Press
  // RESTART to start counting again with a new restart_time.
  window._stopCounter = () => {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    const stopBtn = document.getElementById('stopCounterBtn');
    if (stopBtn) stopBtn.style.display = 'none';
    showToast('Counter stopped. Press RESTART to begin again.', 'info', 4000);
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

  window._finishBackup = async () => {
    // CAPTURE FIRST — at the click moment. We never let the confirm dialog
    // move the recorded timestamp; ms precision must reflect when the
    // operator's finger hit the button, not when they dismissed the prompt.
    const captureISO = nowISO();

    if (!raceData.start_time) {
      showToast('Cannot capture finish: race has no start time', 'warning');
      return;
    }

    if (raceData.p1_finish_time) {
      const captureMs = String(new Date(captureISO).getMilliseconds()).padStart(3, '0');
      const ok = confirm(
        `First-boat finish already captured at ${isoToTime(raceData.p1_finish_time)}.\n\n` +
        `Override with the moment you just clicked (${isoToTime(captureISO)}.${captureMs})?`
      );
      if (!ok) return;
    }

    const baseline = raceData.restart_time || raceData.start_time;
    const elapsedMs = new Date(captureISO).getTime() - new Date(baseline).getTime();
    raceData.p1_finish_time = captureISO;
    raceData.p1_finish_elapsed_ms = elapsedMs;
    await saveRace(raceData);
    await saveTimesheet({
      race_number: raceNumber,
      start_time: raceData.start_time,
      p1_finish_time: captureISO,
      p1_finish_elapsed_ms: elapsedMs,
    });

    const timeMode = configData?.time_format_mode || 'mss00';
    const p1Input = document.getElementById('batchP1Time');
    if (p1Input) p1Input.value = msToTime(elapsedMs, timeMode);

    // Update batch-delta display if a row has a manual time entered.
    const data = grid.getData();
    const firstTime = data.find(r => r.raw_time)?.raw_time;
    if (firstTime && p1Input) {
      batchDeltaMs = calcBatchDelta(p1Input.value, firstTime, timeMode);
      const deltaEl = document.getElementById('batchDelta');
      if (deltaEl) {
        const deltaDisplay = timeToDisplay(msToTime(Math.abs(batchDeltaMs), timeMode), timeMode);
        deltaEl.textContent = (batchDeltaMs >= 0 ? '+' : '-') + deltaDisplay;
      }
    }

    const ms = String(new Date(captureISO).getMilliseconds()).padStart(3, '0');
    showToast(`First-boat finish captured at ${isoToTime(captureISO)}.${ms}`, 'success', 4000);
    recalculate();
  };

  window._exportAndSend = async () => {
    await showExportModal(raceNumber, async () => {
      await sendToWhatsApp(raceNumber);
      raceData = await getRace(raceNumber);
      // Track previous send time so the header can render it struck through.
      if (raceData.send_time) raceData.prev_send_time = raceData.send_time;
      raceData.send_time = nowISO();
      raceData.status = 'sent';
      await saveRace(raceData);
      const ts = await getTimesheet(raceNumber) || { race_number: raceNumber };
      if (!ts.send_time) { ts.send_time = raceData.send_time; } else { ts.re_send_time = raceData.send_time; }
      await saveTimesheet(ts);
      document.getElementById('raceSendTime').innerHTML = renderSendTimeText(raceData);
      document.getElementById('raceStatus').textContent = 'SENT';
      document.getElementById('raceStatus').className = 'badge badge-sent';
      broadcastChange('race-updated', { race_number: raceNumber });
      await promptNextRaceSignal(raceNumber);
      await checkPreviousRaces(raceNumber);
    });
    // Refresh export display via the helper (handles strikethrough for re-export).
    raceData = await getRace(raceNumber);
    if (raceData.export_time) {
      document.getElementById('raceExportTime').innerHTML = renderExportTimeText(raceData);
    }
  };

  window._exportOnly = () => {
    showExportModal(raceNumber, async () => {
      raceData = await getRace(raceNumber);
      document.getElementById('raceExportTime').innerHTML = renderExportTimeText(raceData);
      document.getElementById('raceStatus').textContent = 'EXPORTED';
      document.getElementById('raceStatus').className = 'badge badge-exported';
      showToast('Export complete. Send results to the scoring team when ready.', 'success', 5000);
      await promptNextRaceSignal(raceNumber);
      await checkPreviousRaces(raceNumber);
    });
  };

  window._sendOnly = async () => {
    raceData = await getRace(raceNumber);
    if (!raceData.export_time) {
      if (!confirm('Results not yet exported for this race. Export first before sending?')) return;
      showExportModal(raceNumber);
      return;
    }
    await sendToWhatsApp(raceNumber);
    raceData = await getRace(raceNumber);
    if (raceData.send_time) raceData.prev_send_time = raceData.send_time;
    raceData.send_time = nowISO();
    raceData.status = 'sent';
    await saveRace(raceData);
    const ts = await getTimesheet(raceNumber) || { race_number: raceNumber };
    if (!ts.send_time) { ts.send_time = raceData.send_time; } else { ts.re_send_time = raceData.send_time; }
    await saveTimesheet(ts);
    document.getElementById('raceSendTime').innerHTML = renderSendTimeText(raceData);
    document.getElementById('raceStatus').textContent = 'SENT';
    document.getElementById('raceStatus').className = 'badge badge-sent';
    broadcastChange('race-updated', { race_number: raceNumber });
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
