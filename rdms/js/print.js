/**
 * SDBA RDMS — Print Module
 * Generate printable HTML for race results and draws.
 * Supports: print single race, print multiple races (set), print draw.
 *
 * Opens a new window with formatted HTML and triggers window.print().
 */
import { getRace, getLaneResults, getConfig, getAllRaces } from './db.js';
import { timeToDisplay, isoToTime } from './utils.js';
import { readFromSourceSubfolder } from './file-access.js';

/**
 * Print a race result in a new window.
 * @param {number} raceNumber
 */
export async function printResult(raceNumber) {
  const config = await getConfig();
  const race = await getRace(raceNumber);
  const lanes = await getLaneResults(raceNumber);
  if (!race) return;

  const html = buildResultHtml(race, lanes, config);
  openPrintWindow(html, `Race ${raceNumber} Result`);
}

/**
 * Print a race draw (from the original .xls if available, otherwise from DB data).
 * @param {number} raceNumber
 */
export async function printDraw(raceNumber) {
  const config = await getConfig();
  const race = await getRace(raceNumber);
  const lanes = await getLaneResults(raceNumber);
  if (!race) return;

  const html = buildDrawHtml(race, lanes, config);
  openPrintWindow(html, `Race ${raceNumber} Draw`);
}

/**
 * Print results for multiple races (set print).
 * All races rendered in one page with page breaks between them.
 * @param {number[]} raceNumbers - Array of race numbers to print
 */
export async function printResultSet(raceNumbers) {
  const config = await getConfig();
  let pages = [];

  for (const rn of raceNumbers) {
    const race = await getRace(rn);
    if (!race || race.status === 'cancelled') continue;
    const lanes = await getLaneResults(rn);
    pages.push(buildResultHtml(race, lanes, config, false));
  }

  if (pages.length === 0) return;

  const fullHtml = `
    <!DOCTYPE html>
    <html><head>
      <title>Results — Races ${raceNumbers.join(', ')}</title>
      ${printStyles()}
    </head><body>
      ${pages.join('<div style="page-break-after:always;"></div>')}
    </body></html>
  `;
  openPrintWindow(fullHtml, `Results Set`);
}

/**
 * Print draws for multiple races.
 * @param {number[]} raceNumbers
 */
export async function printDrawSet(raceNumbers) {
  const config = await getConfig();
  let pages = [];

  for (const rn of raceNumbers) {
    const race = await getRace(rn);
    if (!race || race.status === 'cancelled') continue;
    const lanes = await getLaneResults(rn);
    pages.push(buildDrawHtml(race, lanes, config, false));
  }

  if (pages.length === 0) return;

  const fullHtml = `
    <!DOCTYPE html>
    <html><head>
      <title>Draws — Races ${raceNumbers.join(', ')}</title>
      ${printStyles()}
    </head><body>
      ${pages.join('<div style="page-break-after:always;"></div>')}
    </body></html>
  `;
  openPrintWindow(fullHtml, `Draw Set`);
}

/**
 * Open a file from source folder in a new tab.
 * @param {string} subfolder - e.g. "01 Input_Draw" or "12 Output_Results"
 * @param {number} raceNumber
 */
export async function openFileFromFolder(subfolder, raceNumber) {
  // Try to read from connected source folder. Results are now exported as
  // .xlsx (see export.js) — try that first, then fall back to .xls for draws
  // (RMS source files) and results exported before the rename.
  const filenames = [
    `Second Round - ${raceNumber}.xlsx`,
    `${raceNumber}.xlsx`,
    `Second Round - ${raceNumber}.xls`,
    `${raceNumber}.xls`,
  ];

  for (const fn of filenames) {
    const file = await readFromSourceSubfolder(subfolder, fn);
    if (file) {
      // Open file in a new tab
      const url = URL.createObjectURL(file);
      window.open(url, '_blank');
      return;
    }
  }

  // File not found — show explicit error (matches VBA vbCritical behavior)
  const { showToast } = await import('./utils.js');
  showToast(`File not found for Race ${raceNumber} in ${subfolder}/. Check that the file exists and the source folder is connected.`, 'error', 5000);
}

// ──── HTML Builders ────

function buildResultHtml(race, lanes, config, wrapInDoc = true) {
  const timeMode = config?.time_format_mode || 'mss00';
  const eventName = config?.event_long_name_en || '';
  const eventNameTc = config?.event_official_name_tc || '';

  // Reconstruct the exported sheet's visual layout: header band, lane
  // rows ordered by BOAT (not finish position) with Time / Place /
  // Score / Total Score / Total Place / Remarks columns, then the
  // progression footnote at the bottom. Matches the bundled xlsx
  // template's column convention so the printed page looks like the
  // exported .xls.
  const drawLanesByLane = {};
  if (Array.isArray(race.draw_lanes)) {
    race.draw_lanes.forEach(dl => { if (dl?.lane_number) drawLanesByLane[dl.lane_number] = dl; });
  }
  const inputByLane = {};
  lanes.forEach(l => {
    const lane = parseInt(l.lane_input, 10);
    if (Number.isInteger(lane) && lane >= 1) inputByLane[lane] = l;
  });

  const laneCount = config?.lane_count || 6;
  const MARKER_SET = new Set(['DSQ', 'DQ', 'DNS', 'DNF']);
  const rows = [];
  for (let lane = 1; lane <= laneCount; lane++) {
    const draw = drawLanesByLane[lane] || {};
    const teamName = draw.team_name || '';
    const teamCode = draw.team_code || '';
    const r = inputByLane[lane];
    if (!r) {
      rows.push({ lane, teamName, teamCode, timeText: '', place: '', remarks: '' });
      continue;
    }
    const rawRemark = (r.remarks || '').trim();
    const isMarker = MARKER_SET.has(rawRemark.toUpperCase());
    const timeText = isMarker ? rawRemark.toUpperCase() : timeToDisplay(r.raw_time, timeMode);
    const place = isMarker ? '' : (r.computed_position ?? '');
    const remarkPieces = [];
    if (r.penalty_time && String(r.penalty_time).trim() !== '0') remarkPieces.push(`TP=${r.penalty_time}s`);
    if (!isMarker && rawRemark) remarkPieces.push(rawRemark);
    rows.push({ lane, teamName, teamCode, timeText, place, remarks: remarkPieces.join(' ') });
  }

  const versionNote = race.export_version > 1
    ? `<div style="color:#c00; font-size:11px; font-style:italic; margin-top:4px;">Results v${race.export_version} (Revised)</div>`
    : '';

  const footnote = (race.progression_text || '').trim();

  const body = `
    <div class="print-page">
      <div class="print-header">
        <div class="print-title">Race No. ${race.race_number} — ${race.race_title_raw || race.race_title || ''}</div>
        <div class="print-meta">
          ${eventName}${eventNameTc ? ' / ' + eventNameTc : ''}
          ${race.race_time ? ' · Sched ' + race.race_time : ''}
          ${race.start_time ? ' · Start ' + isoToTime(race.start_time) : ''}
        </div>
        ${versionNote}
      </div>
      <table class="print-table">
        <thead>
          <tr>
            <th style="width:6%;">BOAT<br>船號</th>
            <th style="width:34%;">Team Name<br>隊伍名稱</th>
            <th style="width:8%;">Code<br>編號</th>
            <th style="width:12%;">Time<br>時間</th>
            <th style="width:6%;">Place<br>名次</th>
            <th style="width:34%;">Remarks<br>備註</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td style="font-weight:700;">${r.lane}</td>
            <td style="text-align:left; font-size:12px;">${escapeHtml(r.teamName)}</td>
            <td>${escapeHtml(r.teamCode)}</td>
            <td>${escapeHtml(r.timeText)}</td>
            <td style="font-weight:700;">${r.place}</td>
            <td style="text-align:left; font-size:11px;">${escapeHtml(r.remarks)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${footnote ? `<div class="print-footnote">${escapeHtml(footnote).replace(/\n/g, '<br>')}</div>` : ''}
      <div class="print-sig">
        <div>Chief Judge Signature 裁判簽署 : ____________________</div>
        <div>Signature Time 簽署時間 : ____________________</div>
      </div>
    </div>
  `;

  if (!wrapInDoc) return body;
  return `<!DOCTYPE html><html><head><title>Race ${race.race_number} Result</title>${printStyles()}</head><body>${body}</body></html>`;
}

function buildDrawHtml(race, lanes, config, wrapInDoc = true) {
  const eventName = config?.event_long_name_en || '';
  const eventNameTc = config?.event_official_name_tc || '';
  const laneCount = config?.lane_count || 6;

  // Reconstruct the bundled xlsx template's draw layout: header band,
  // lane rows in boat order with empty Time / Place / Remarks columns
  // (operator fills them in during the race), progression footnote at
  // the bottom, signature row. Source of truth for team data is
  // race.draw_lanes (joyi-safe).
  const drawLanesByLane = {};
  if (Array.isArray(race.draw_lanes)) {
    race.draw_lanes.forEach(dl => { if (dl?.lane_number) drawLanesByLane[dl.lane_number] = dl; });
  }
  // Legacy fallback when draw_lanes isn't set yet.
  if (Object.keys(drawLanesByLane).length === 0) {
    (lanes || []).forEach(lr => {
      if (lr?.lane_number) drawLanesByLane[lr.lane_number] = { lane_number: lr.lane_number, team_name: lr.team_name, team_code: lr.team_code };
    });
  }

  const rows = [];
  for (let lane = 1; lane <= laneCount; lane++) {
    const dl = drawLanesByLane[lane] || {};
    rows.push({ lane, name: dl.team_name || '', code: dl.team_code || '' });
  }

  const footnote = (race.progression_text || '').trim();

  const body = `
    <div class="print-page">
      <div class="print-header">
        <div class="print-title">Race No. ${race.race_number} — ${race.race_title_raw || race.race_title || ''}</div>
        <div class="print-meta">
          ${eventName}${eventNameTc ? ' / ' + eventNameTc : ''}
          ${race.race_time ? ' · Sched ' + race.race_time : ''}
        </div>
      </div>
      <table class="print-table">
        <thead>
          <tr>
            <th style="width:6%;">BOAT<br>船號</th>
            <th style="width:40%;">Team Name<br>隊伍名稱</th>
            <th style="width:8%;">Code<br>編號</th>
            <th style="width:12%;">Time<br>時間</th>
            <th style="width:6%;">Place<br>名次</th>
            <th style="width:28%;">Remarks<br>備註</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td style="font-weight:700;">${r.lane}</td>
            <td style="text-align:left; font-size:12px;">${escapeHtml(r.name)}</td>
            <td>${escapeHtml(r.code)}</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
            <td>&nbsp;</td>
          </tr>`).join('')}
        </tbody>
      </table>
      ${footnote ? `<div class="print-footnote">${escapeHtml(footnote).replace(/\n/g, '<br>')}</div>` : ''}
      <div class="print-sig">
        <div>Chief Judge Signature 裁判簽署 : ____________________</div>
        <div>Signature Time 簽署時間 : ____________________</div>
      </div>
    </div>
  `;

  if (!wrapInDoc) return body;
  return `<!DOCTYPE html><html><head><title>Race ${race.race_number} Draw</title>${printStyles()}</head><body>${body}</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function printStyles() {
  // One race per A4 landscape page — sized so a 7-lane sheet plus the
  // progression footnote + signature row fits without truncation.
  // Table cells stretch via flex so the layout fills the page top to
  // bottom rather than clustering at the top.
  return `<style>
    @page { size: A4 landscape; margin: 12mm; }
    * { margin:0; padding:0; box-sizing:border-box; }
    html, body { font-family: Arial, "PingFang TC", "Heiti TC", sans-serif; font-size:13px; color:#000; }
    body { padding:0; }
    .print-page {
      page-break-after: always;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    .print-page:last-child { page-break-after: auto; }
    .print-header { border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 6px; }
    .print-title { font-size: 18px; font-weight: 700; }
    .print-meta { font-size: 12px; color: #444; margin-top: 4px; }
    .print-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      margin-top: 6px;
      flex: 1;
    }
    .print-table th, .print-table td {
      border: 1px solid #000;
      padding: 8px 10px;
      text-align: center;
      vertical-align: middle;
    }
    .print-table th { background:#eaeaea; font-size:11px; font-weight:700; line-height:1.2; }
    .print-table td { font-size:14px; }
    .print-table tbody tr { height: 36px; }
    .print-footnote {
      margin-top: 10px;
      padding: 8px 10px;
      border: 1px solid #888;
      font-size: 11px;
      white-space: pre-wrap;
      flex: 0 0 auto;
    }
    .print-sig {
      margin-top: 14px;
      display: flex;
      justify-content: space-between;
      font-size: 12px;
    }
    @media print { body { padding:0; } .print-page { min-height: 0; } }
  </style>`;
}

function openPrintWindow(html, title) {
  const w = window.open('', '_blank');
  if (!w) {
    // Popup blocked
    const { showToast } = import('./utils.js');
    showToast('Popup blocked — allow popups for this site to print.', 'error');
    return;
  }
  w.document.write(html);
  w.document.close();
  w.focus();
  // Auto-trigger print after short delay for rendering
  setTimeout(() => w.print(), 300);
}
