/**
 * SDBA RDMS — TimeSheet Page
 * Timing log for all races: start, restart, export, send times + intervals.
 */
import { getAllTimesheets, getAllRaces, getAllDivisions } from '../db.js';
import { isoToTime } from '../utils.js';

export async function mountTimesheetPage(container) {
  const timesheets = await getAllTimesheets();
  const races = await getAllRaces();
  const divisions = await getAllDivisions();
  const divMap = Object.fromEntries(divisions.map(d => [d.id, d]));
  const raceMap = Object.fromEntries(races.map(r => [r.race_number, r]));

  // Merge timesheet + race data, sorted by race number
  const rows = races
    .filter(r => r.status !== 'pending' || timesheets.find(t => t.race_number === r.race_number))
    .sort((a, b) => a.race_number - b.race_number)
    .map(r => {
      const ts = timesheets.find(t => t.race_number === r.race_number) || {};
      return { ...r, ...ts };
    });

  // Calculate intervals
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].start_time && rows[i - 1].start_time) {
      const diff = new Date(rows[i].start_time).getTime() - new Date(rows[i - 1].start_time).getTime();
      rows[i]._interval = diff > 0 ? diff : null;
    }
  }

  // Summary stats
  const intervals = rows.map(r => r._interval).filter(Boolean);
  const avgInterval = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
  const minInterval = intervals.length > 0 ? Math.min(...intervals) : 0;
  const maxInterval = intervals.length > 0 ? Math.max(...intervals) : 0;

  function fmtInterval(ms) {
    if (!ms) return '—';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${String(sec).padStart(2, '0')}`;
  }

  container.innerHTML = `
    <h4 style="font-size:18px; font-weight:600; margin-bottom:16px;">TimeSheet</h4>

    <!-- Summary -->
    <div class="summary-cards" style="margin-bottom:16px;">
      <div class="summary-card">
        <div class="summary-card-value">${rows.length}</div>
        <div class="summary-card-label">Races Logged</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-value">${fmtInterval(avgInterval)}</div>
        <div class="summary-card-label">Avg Interval</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-value">${fmtInterval(minInterval)}</div>
        <div class="summary-card-label">Fastest</div>
      </div>
      <div class="summary-card">
        <div class="summary-card-value">${fmtInterval(maxInterval)}</div>
        <div class="summary-card-label">Longest Gap</div>
      </div>
    </div>

    <!-- Table -->
    <div class="card" style="padding:0; overflow:auto;">
      <table class="race-table">
        <thead>
          <tr>
            <th>Race</th>
            <th>Division</th>
            <th>Start</th>
            <th>Restart</th>
            <th>Export</th>
            <th>Re-Exp</th>
            <th>Send</th>
            <th>Re-Send</th>
            <th>Interval</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const div = r.division_id ? divMap[r.division_id] : null;
            const divColor = div?.colour_hex || '#9ca3af';
            const divName = div?.division_name || '';
            return `<tr>
              <td><strong>${r.race_number}</strong></td>
              <td><span class="division-color" style="background:${divColor};"></span>${divName}</td>
              <td>${isoToTime(r.start_time)}</td>
              <td>${isoToTime(r.restart_time)}</td>
              <td>${isoToTime(r.export_time)}</td>
              <td>${isoToTime(r.re_export_time)}</td>
              <td>${isoToTime(r.send_time)}</td>
              <td>${isoToTime(r.re_send_time)}</td>
              <td style="font-variant-numeric:tabular-nums;">${fmtInterval(r._interval)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

export function unmountTimesheetPage() {}
