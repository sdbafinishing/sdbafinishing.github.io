/**
 * SDBA RDMS — Race Schedule Tab (within Setup)
 * Shows all races with editable titles, times, divisions, scoring flags.
 * Auto-populated from draw imports.
 */
import { getAllRaces, saveRace, getAllDivisions } from '../db.js';
import { showToast } from '../utils.js';
import { broadcastChange } from '../app.js';

export async function renderScheduleTab(container) {
  const races = await getAllRaces();
  const divisions = await getAllDivisions();
  const sorted = [...races].sort((a, b) => a.race_number - b.race_number);

  container.innerHTML = `
    <div style="margin-top:16px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
        <p style="font-size:13px; color:var(--text-secondary);">
          ${sorted.length} races loaded. Edit titles, times, divisions, and scoring flags inline.
        </p>
        <button class="btn btn-outline" onclick="window._schedSaveAll()">
          <i class="material-icons">save</i> Save All Changes
        </button>
      </div>

      ${sorted.length === 0
        ? '<div class="card" style="text-align:center; padding:32px; color:var(--text-tertiary);">No races loaded. Import draws or generate blank races first.</div>'
        : `<div class="card" style="padding:0; overflow:auto; max-height:60vh;">
            <table class="race-table" id="scheduleTable">
              <thead>
                <tr>
                  <th style="width:50px;">Race</th>
                  <th style="min-width:200px;">Title</th>
                  <th style="width:70px;">Time</th>
                  <th style="width:140px;">Division</th>
                  <th style="width:90px;">Scored</th>
                  <th style="width:60px;">Status</th>
                </tr>
              </thead>
              <tbody>
                ${sorted.map(r => `
                  <tr data-race="${r.race_number}" class="race-row-${r.race_number % 2 === 1 ? 'odd' : 'even'}">
                    <td><strong>${r.race_number}</strong></td>
                    <td><input class="form-input sched-title" data-race="${r.race_number}"
                               value="${(r.race_title || '').replace(/"/g, '&quot;')}"
                               style="font-size:13px; padding:4px 8px; border:1px solid var(--border-subtle);"></td>
                    <td><input class="form-input sched-time" data-race="${r.race_number}"
                               value="${r.race_time || ''}" placeholder="HH:MM"
                               style="font-size:13px; padding:4px 6px; width:65px; text-align:center; border:1px solid var(--border-subtle);"></td>
                    <td><select class="form-select sched-div" data-race="${r.race_number}"
                                style="font-size:12px; padding:2px 4px; border:1px solid var(--border-subtle);">
                          <option value="">— None —</option>
                          ${divisions.map(d =>
                            `<option value="${d.id}" ${r.division_id === d.id ? 'selected' : ''}
                                     style="color:${d.colour_hex || '#333'};">
                              ${d.division_name}
                            </option>`
                          ).join('')}
                        </select></td>
                    <td><select class="form-select sched-scored" data-race="${r.race_number}"
                                style="font-size:12px; padding:2px 4px; border:1px solid var(--border-subtle);">
                          <option value="N" ${r.scoring_flag === 'N' || !r.scoring_flag ? 'selected' : ''}>N</option>
                          <option value="R1" ${r.scoring_flag === 'R1' ? 'selected' : ''}>R1</option>
                          <option value="R2" ${r.scoring_flag === 'R2' ? 'selected' : ''}>R2</option>
                          <option value="RFinal" ${r.scoring_flag === 'RFinal' ? 'selected' : ''}>RFinal</option>
                        </select></td>
                    <td style="text-align:center;">
                      <span class="badge badge-${r.status || 'pending'}" style="font-size:10px;">${(r.status || 'pending').toUpperCase()}</span>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>`
      }
    </div>
  `;

  window._schedSaveAll = async () => {
    const rows = document.querySelectorAll('#scheduleTable tbody tr');
    const toSave = [];

    for (const row of rows) {
      const raceNum = parseInt(row.dataset.race, 10);
      const title = row.querySelector('.sched-title')?.value?.trim();
      const time = row.querySelector('.sched-time')?.value?.trim();
      const divId = row.querySelector('.sched-div')?.value;
      const scored = row.querySelector('.sched-scored')?.value;

      const race = races.find(r => r.race_number === raceNum);
      if (!race) continue;

      let changed = false;
      if (race.race_title !== title) { race.race_title = title; changed = true; }
      if (race.race_time !== time) { race.race_time = time; changed = true; }
      const newDivId = divId ? parseInt(divId, 10) : null;
      if (race.division_id !== newDivId) { race.division_id = newDivId; changed = true; }
      if (race.scoring_flag !== scored) { race.scoring_flag = scored; changed = true; }

      if (changed) toSave.push(race);
    }

    if (toSave.length > 0) {
      const { bulkSaveRaces } = await import('../db.js');
      await bulkSaveRaces(toSave);
    }

    broadcastChange('race-updated');
    showToast(`Saved ${toSave.length} race${toSave.length !== 1 ? 's' : ''} updated`, 'success');
  };
}

export function cleanupScheduleHandlers() {
  delete window._schedSaveAll;
}
