/**
 * SDBA RDMS — Division Config UI
 * Configure divisions: name, code prefix, short ref, colour, rounds, progressions.
 * Rendered as a tab within the Setup page.
 */
import { getAllDivisions, saveDivision, deleteDivision, getDivisionRounds, saveDivisionRound,
         getDivisionProgressions, saveDivisionProgression, db } from '../db.js';
import { showToast } from '../utils.js';
import { broadcastChange } from '../app.js';
import { autoPopulateDivisions, saveProposedDivisions } from '../auto-populate.js';

/**
 * Render the divisions tab content.
 * @param {HTMLElement} container
 */
export async function renderDivisionsTab(container) {
  const divisions = await getAllDivisions();

  container.innerHTML = `
    <div style="margin-top:16px;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; gap:12px; flex-wrap:wrap;">
        <p style="font-size:13px; color:var(--text-secondary); flex:1;">
          Define divisions with code prefix, colour, and round/progression structure.
        </p>
        <button class="btn btn-outline" onclick="window._divAutoPopulate()">
          <i class="material-icons">auto_fix_high</i> Auto-Populate from Draws
        </button>
        <button class="btn btn-primary" onclick="window._divAddNew()">
          <i class="material-icons">add</i> Add Division
        </button>
      </div>

      <div id="divisionsList">
        ${divisions.length === 0
          ? '<div class="card" style="text-align:center; padding:32px; color:var(--text-tertiary);">No divisions configured. Click "Add Division" to start.</div>'
          : ''
        }
      </div>
    </div>
  `;

  // Render each division card
  if (divisions.length > 0) {
    const listEl = document.getElementById('divisionsList');
    for (const div of divisions) {
      const rounds = await getDivisionRounds(div.id);
      const progs = await getDivisionProgressions(div.id);
      listEl.appendChild(renderDivisionCard(div, rounds, progs));
    }
  }

  // Handlers
  window._divAddNew = () => showDivisionModal(null);
  window._divAutoPopulate = async () => {
    const proposals = await autoPopulateDivisions();
    if (proposals.length === 0) return;

    const summary = proposals.map(p =>
      `  ${p.division_name} (${p.race_count} races, ${p.rounds.length} rounds)`
    ).join('\n');

    if (!confirm(`Auto-detected ${proposals.length} division(s):\n\n${summary}\n\nSave these? You can edit them afterwards.`)) return;

    const saved = await saveProposedDivisions(proposals);
    broadcastChange('config-updated');
    showToast(`${saved} divisions auto-populated. Review and edit as needed.`, 'success');
    renderDivisionsTab(container);
  };
  window._divEdit = (id) => showDivisionModal(id);
  window._divDelete = async (id) => {
    if (!confirm('Delete this division and all its rounds/progressions?')) return;
    await deleteDivision(id);
    broadcastChange('config-updated');
    showToast('Division deleted', 'info');
    renderDivisionsTab(container);
  };
}

function renderDivisionCard(div, rounds, progs) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.marginBottom = '12px';

  const roundsByNum = {};
  rounds.forEach(r => {
    if (!roundsByNum[r.round_number]) roundsByNum[r.round_number] = [];
    roundsByNum[r.round_number].push(r);
  });

  const scoredProgs = progs.filter(p => p.is_scored);

  card.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
      <span style="display:inline-block; width:16px; height:16px; border-radius:3px; background:${div.colour_hex || '#9ca3af'};"></span>
      <strong style="font-size:15px;">${div.division_name || 'Untitled'}</strong>
      <span style="font-size:12px; color:var(--text-tertiary); font-family:monospace;">${div.div_code_prefix || ''}${div.div_short_ref ? ' / ' + div.div_short_ref : ''}</span>
      <div style="margin-left:auto; display:flex; gap:6px;">
        <button class="btn btn-ghost" style="padding:4px 8px; font-size:12px;" onclick="window._divEdit(${div.id})">
          <i class="material-icons" style="font-size:16px;">edit</i> Edit
        </button>
        <button class="btn btn-ghost" style="padding:4px 8px; font-size:12px; color:var(--danger);" onclick="window._divDelete(${div.id})">
          <i class="material-icons" style="font-size:16px;">delete</i>
        </button>
      </div>
    </div>

    ${Object.keys(roundsByNum).length > 0 ? `
      <div style="font-size:13px; color:var(--text-secondary);">
        ${Object.entries(roundsByNum).sort(([a],[b]) => a - b).map(([num, tiers]) =>
          tiers.map(t =>
            `<div style="margin-bottom:4px;">
              <span style="font-weight:500;">Round ${num}</span>
              <span style="color:var(--text-tertiary);">"${t.tier_name || ''}"</span>:
              Races <span style="font-family:monospace;">${(t.race_numbers || []).join(', ') || '—'}</span>
            </div>`
          ).join('')
        ).join('')}
      </div>
    ` : '<div style="font-size:13px; color:var(--text-tertiary);">No rounds configured.</div>'}

    ${progs.length > 0 ? `
      <div style="margin-top:8px; font-size:12px; color:var(--text-tertiary);">
        <strong>Progressions:</strong>
        ${progs.map(p => {
          const fromRound = rounds.find(r => r.id === p.from_round_id);
          const toRound = rounds.find(r => r.id === p.to_round_id);
          return `<div style="margin-left:12px;">
            ${fromRound?.tier_name || '?'} pos ${p.position_range} → ${toRound?.tier_name || '?'}
            ${p.is_scored ? '<span style="color:var(--success); font-weight:500;"> ★ SCORED</span>' : ''}
          </div>`;
        }).join('')}
      </div>
    ` : ''}
  `;

  return card;
}

async function showDivisionModal(editId) {
  let div = editId ? (await getAllDivisions()).find(d => d.id === editId) : null;
  const isNew = !div;
  if (!div) div = { division_name: '', div_code_prefix: '', div_short_ref: '', colour_hex: '#3b82f6' };

  // Load existing rounds for this division
  const existingRounds = editId ? await getDivisionRounds(editId) : [];
  const existingProgs = editId ? await getDivisionProgressions(editId) : [];

  const modal = document.createElement('div');
  modal.id = 'divisionModal';
  modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9998; display:flex; align-items:center; justify-content:center; overflow-y:auto; padding:20px;';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:24px; max-width:640px; width:95%; box-shadow:var(--shadow-lg); margin:auto;">
      <h5 style="font-size:16px; font-weight:600; margin-bottom:16px;">${isNew ? 'Add' : 'Edit'} Division</h5>

      <!-- Basic Info -->
      <div class="form-group">
        <label class="form-label">Division Name</label>
        <input class="form-input" id="divName" type="text" placeholder="e.g. Corp Mixed 200m" value="${div.division_name || ''}">
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr auto; gap:12px;">
        <div class="form-group">
          <label class="form-label">Code Prefix</label>
          <input class="form-input" id="divCodePrefix" type="text" placeholder="e.g. CM" value="${div.div_code_prefix || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Short Ref</label>
          <input class="form-input" id="divShortRef" type="text" placeholder="e.g. CM2" value="${div.div_short_ref || ''}">
        </div>
        <div class="form-group">
          <label class="form-label">Colour</label>
          <div style="display:flex; align-items:center; gap:4px;">
            <input type="color" id="divColourPicker" value="${div.colour_hex || '#3b82f6'}"
                   style="width:36px; height:36px; border:1px solid var(--border); border-radius:var(--radius-sm); cursor:pointer; padding:2px;"
                   oninput="document.getElementById('divColourHex').value=this.value">
            <input class="form-input" id="divColourHex" type="text" maxlength="7"
                   value="${div.colour_hex || '#3b82f6'}"
                   style="width:80px; font-family:monospace; font-size:12px;"
                   oninput="if(/^#[0-9A-Fa-f]{6}$/.test(this.value))document.getElementById('divColourPicker').value=this.value">
          </div>
        </div>
      </div>

      <!-- Rounds -->
      <div class="section-header" style="margin-top:16px;">Rounds</div>
      <p style="font-size:12px; color:var(--text-tertiary); margin-bottom:8px;">
        Define rounds and their races. Race numbers are comma-separated.
      </p>
      <div id="divRoundsList">
        ${existingRounds.length > 0
          ? existingRounds
              .sort((a, b) => a.round_number - b.round_number)
              .map((r, i) => renderRoundRow(r, i))
              .join('')
          : renderRoundRow({ round_number: 1, tier_name: 'Heat', race_numbers: [] }, 0)
        }
      </div>
      <button class="btn btn-ghost" style="font-size:12px; margin-top:6px;" onclick="window._divAddRound()">
        <i class="material-icons" style="font-size:14px;">add</i> Add Round
      </button>

      <!-- Progressions -->
      <div class="section-header" style="margin-top:16px;">Progressions</div>
      <p style="font-size:12px; color:var(--text-tertiary); margin-bottom:8px;">
        Define how teams advance between rounds. "all" = scored series (1:1 mapping).
      </p>
      <div id="divProgsList">
        ${existingProgs.length > 0
          ? existingProgs.map((p, i) => renderProgRow(p, i, existingRounds)).join('')
          : '<p style="font-size:12px; color:var(--text-tertiary);">No progressions. Add rounds first, then define how teams advance.</p>'
        }
      </div>
      <button class="btn btn-ghost" style="font-size:12px; margin-top:6px;" onclick="window._divAddProg()">
        <i class="material-icons" style="font-size:14px;">add</i> Add Progression
      </button>

      <!-- Actions -->
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:20px; border-top:1px solid var(--border); padding-top:16px;">
        <button class="btn btn-ghost" onclick="document.getElementById('divisionModal').remove()">Cancel</button>
        <button class="btn btn-primary" id="divSaveBtn">${isNew ? 'Add' : 'Save'} Division</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  let roundCounter = existingRounds.length || 1;
  let progCounter = existingProgs.length || 0;

  window._divAddRound = () => {
    roundCounter++;
    const list = document.getElementById('divRoundsList');
    const div = document.createElement('div');
    div.innerHTML = renderRoundRow({ round_number: roundCounter, tier_name: '', race_numbers: [] }, roundCounter - 1);
    list.appendChild(div.firstElementChild);
  };

  window._divAddProg = () => {
    progCounter++;
    const list = document.getElementById('divProgsList');
    // Clear "no progressions" message
    if (list.querySelector('p')) list.innerHTML = '';
    const div = document.createElement('div');
    div.innerHTML = renderProgRow({ from_round_id: '', to_round_id: '', position_range: '1-3' }, progCounter - 1, []);
    list.appendChild(div.firstElementChild);
  };

  window._divRemoveRound = (idx) => {
    const row = document.querySelector(`.div-round-row[data-idx="${idx}"]`);
    if (row) row.remove();
  };

  window._divRemoveProg = (idx) => {
    const row = document.querySelector(`.div-prog-row[data-idx="${idx}"]`);
    if (row) row.remove();
  };

  modal.querySelector('#divSaveBtn').addEventListener('click', async () => {
    const name = document.getElementById('divName').value.trim();
    if (!name) { showToast('Division name is required', 'error'); return; }

    // Save division
    const divData = {
      division_name: name,
      div_code_prefix: document.getElementById('divCodePrefix').value.trim(),
      div_short_ref: document.getElementById('divShortRef').value.trim(),
      colour_hex: document.getElementById('divColourHex').value.trim() || '#3b82f6',
    };
    if (editId) divData.id = editId;
    const savedId = await saveDivision(divData);
    const divId = editId || savedId;

    // Clear and re-save rounds
    if (editId) {
      const oldRounds = await getDivisionRounds(editId);
      for (const r of oldRounds) await db.division_rounds.delete(r.id);
      const oldProgs = await getDivisionProgressions(editId);
      for (const p of oldProgs) await db.division_progressions.delete(p.id);
    }

    // Save rounds
    const roundRows = document.querySelectorAll('.div-round-row');
    const savedRoundIds = {};
    for (const row of roundRows) {
      const idx = row.dataset.idx;
      const roundNum = parseInt(row.querySelector('.round-num')?.value, 10);
      const tierName = row.querySelector('.round-tier')?.value?.trim() || '';
      const racesStr = row.querySelector('.round-races')?.value?.trim() || '';
      const raceNumbers = racesStr.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));

      if (roundNum && roundNum > 0) {
        const id = await saveDivisionRound({
          division_id: divId,
          round_number: roundNum,
          tier_name: tierName,
          race_numbers: raceNumbers,
        });
        savedRoundIds[idx] = id;
      }
    }

    // Save progressions
    const progRows = document.querySelectorAll('.div-prog-row');
    for (const row of progRows) {
      const fromIdx = row.querySelector('.prog-from')?.value;
      const toIdx = row.querySelector('.prog-to')?.value;
      const posRange = row.querySelector('.prog-pos')?.value?.trim() || '1-3';

      const fromRoundId = savedRoundIds[fromIdx];
      const toRoundId = savedRoundIds[toIdx];

      if (fromRoundId && toRoundId) {
        const isScored = posRange.toLowerCase() === 'all';
        await saveDivisionProgression({
          division_id: divId,
          from_round_id: fromRoundId,
          to_round_id: toRoundId,
          position_range: posRange,
          is_scored: isScored,
        });
      }
    }

    modal.remove();
    broadcastChange('config-updated');
    showToast(`Division "${name}" ${isNew ? 'added' : 'updated'}`, 'success');

    const tabContent = document.getElementById('setupTabContent');
    if (tabContent) renderDivisionsTab(tabContent);
  });
}

function renderRoundRow(round, idx) {
  const races = (round.race_numbers || []).join(', ');
  return `
    <div class="div-round-row" data-idx="${idx}" style="display:grid; grid-template-columns:60px 1fr 2fr 30px; gap:8px; align-items:center; margin-bottom:6px;">
      <input class="form-input round-num" type="number" min="1" max="9" value="${round.round_number || ''}"
             placeholder="#" style="text-align:center; font-size:13px; padding:4px;">
      <input class="form-input round-tier" type="text" value="${round.tier_name || ''}"
             placeholder="e.g. Heat, Semi Gold, Final" style="font-size:13px; padding:4px 8px;">
      <input class="form-input round-races" type="text" value="${races}"
             placeholder="Race numbers: 1, 2, 3, 4" style="font-size:13px; padding:4px 8px; font-family:monospace;">
      <button class="btn-icon" onclick="window._divRemoveRound(${idx})" title="Remove" style="color:var(--danger); padding:2px;">
        <i class="material-icons" style="font-size:16px;">close</i>
      </button>
    </div>
  `;
}

function renderProgRow(prog, idx, rounds) {
  return `
    <div class="div-prog-row" data-idx="${idx}" style="display:grid; grid-template-columns:1fr 20px 1fr 80px 30px; gap:6px; align-items:center; margin-bottom:6px;">
      <input class="form-input prog-from" type="text" value="${prog.from_round_id || ''}"
             placeholder="From round #" style="font-size:12px; padding:4px 6px; text-align:center;">
      <span style="text-align:center; color:var(--text-tertiary);">→</span>
      <input class="form-input prog-to" type="text" value="${prog.to_round_id || ''}"
             placeholder="To round #" style="font-size:12px; padding:4px 6px; text-align:center;">
      <input class="form-input prog-pos" type="text" value="${prog.position_range || '1-3'}"
             placeholder="1-3 or all" style="font-size:12px; padding:4px 6px; text-align:center; font-family:monospace;">
      <button class="btn-icon" onclick="window._divRemoveProg(${idx})" title="Remove" style="color:var(--danger); padding:2px;">
        <i class="material-icons" style="font-size:16px;">close</i>
      </button>
    </div>
  `;
}

export function cleanupDivisionHandlers() {
  delete window._divAddNew;
  delete window._divEdit;
  delete window._divDelete;
  delete window._divAddRound;
  delete window._divAddProg;
  delete window._divRemoveRound;
  delete window._divRemoveProg;
  delete window._divAutoPopulate;
}
