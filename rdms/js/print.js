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
  // Try to read from connected source folder
  const filenames = [
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
  const eventRef = config?.event_short_ref || '';

  const sorted = [...lanes]
    .filter(l => l.raw_time || l.remarks)
    .sort((a, b) => {
      if (a.computed_position == null && b.computed_position == null) return 0;
      if (a.computed_position == null) return 1;
      if (b.computed_position == null) return -1;
      return a.computed_position - b.computed_position;
    });

  const versionNote = race.export_version > 1
    ? `<p style="color:#c00; font-size:11px; font-style:italic;">Results v${race.export_version} (Revised)</p>`
    : '';

  const body = `
    <div class="print-page">
      <h2 style="margin:0; font-size:16px;">${eventName}</h2>
      <h3 style="margin:4px 0 2px; font-size:14px;">Race ${race.race_number} — ${race.race_title || ''}</h3>
      <p style="font-size:11px; color:#666; margin:0;">
        Start: ${isoToTime(race.start_time)} | Export: ${isoToTime(race.export_time)} | ${eventRef}
      </p>
      ${versionNote}
      <table class="print-table">
        <thead>
          <tr><th>Pos</th><th>Lane</th><th>Team Name</th><th>Code</th><th>Time</th><th>Remarks</th></tr>
        </thead>
        <tbody>
          ${sorted.map(lr => {
            const remarksArr = [];
            if (lr.penalty_time) remarksArr.push(`TP=${lr.penalty_time}s`);
            if (lr.remarks) remarksArr.push(lr.remarks);
            return `<tr>
              <td style="font-weight:700;">${['DSQ','DQ'].includes(lr.remarks) ? lr.remarks : (lr.computed_position ?? '')}</td>
              <td>${lr.lane_input || lr.lane_number || ''}</td>
              <td style="text-align:left;">${lr.team_name || ''}</td>
              <td>${lr.team_code || ''}</td>
              <td>${timeToDisplay(lr.raw_time, timeMode)}</td>
              <td>${remarksArr.join(', ')}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  if (!wrapInDoc) return body;
  return `<!DOCTYPE html><html><head><title>Race ${race.race_number} Result</title>${printStyles()}</head><body>${body}</body></html>`;
}

function buildDrawHtml(race, lanes, config, wrapInDoc = true) {
  const eventName = config?.event_long_name_en || '';

  // Source of truth for "team in boat lane X" is race.draw_lanes (the
  // draw-time snapshot that survives Joyi imports). Fall back to
  // lane_results.team_name for legacy races that don't have the field.
  const rows = [];
  if (Array.isArray(race?.draw_lanes) && race.draw_lanes.length > 0) {
    const sorted = [...race.draw_lanes].sort((a, b) => (a.lane_number || 0) - (b.lane_number || 0));
    for (const dl of sorted) {
      rows.push({
        lane: dl.lane_number,
        name: dl.team_name || '—',
        code: dl.team_code || '',
      });
    }
  } else {
    const sorted = [...lanes].sort((a, b) => a.lane_number - b.lane_number);
    for (const lr of sorted) {
      rows.push({
        lane: lr.lane_number,
        name: lr.team_name || '—',
        code: lr.team_code || '',
      });
    }
  }

  const body = `
    <div class="print-page">
      <h2 style="margin:0; font-size:16px;">${eventName}</h2>
      <h3 style="margin:4px 0 8px; font-size:14px;">Race ${race.race_number} — ${race.race_title || ''}</h3>
      <p style="font-size:11px; color:#666; margin:0 0 8px;">Scheduled: ${race.race_time || '—'}</p>
      <table class="print-table">
        <thead>
          <tr><th>Lane</th><th>Team Name</th><th>Code</th></tr>
        </thead>
        <tbody>
          ${rows.map(r => `<tr>
            <td style="font-weight:700;">${r.lane}</td>
            <td style="text-align:left;">${r.name}</td>
            <td>${r.code}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;

  if (!wrapInDoc) return body;
  return `<!DOCTYPE html><html><head><title>Race ${race.race_number} Draw</title>${printStyles()}</head><body>${body}</body></html>`;
}

function printStyles() {
  return `<style>
    @page { size: landscape; margin: 10mm; }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: Arial, sans-serif; font-size:12px; padding:16px; }
    .print-page { page-break-after:always; height:100vh; display:flex; flex-direction:column; }
    .print-page:last-child { page-break-after:auto; }
    .print-table { width:100%; border-collapse:collapse; margin-top:8px; flex:1; }
    .print-table th, .print-table td { border:1px solid #999; padding:5px 10px; text-align:center; }
    .print-table th { background:#eee; font-size:11px; font-weight:700; }
    .print-table td { font-size:13px; }
    @media print { body { padding:0; } }
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
