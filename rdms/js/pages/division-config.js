/**
 * SDBA RDMS — Division Config UI
 * Configure divisions: name, code prefix, short ref, colour, rounds, progressions.
 * Rendered as a tab within the Setup page.
 */
import { getAllDivisions, saveDivision, deleteDivision, getDivisionRounds, saveDivisionRound,
         getDivisionProgressions, saveDivisionProgression, db } from '../db.js';
import { showToast, rowsToCsvBlob, csvToRows } from '../utils.js';
import { broadcastChange } from '../app.js';
import { autoPopulateDivisions, saveProposedDivisions } from '../auto-populate.js';
import { runFlowchartAudit } from '../flowchart-audit.js';
import { downloadFallback } from '../file-access.js';

/**
 * Parse a race-number range string into a sorted unique integer array.
 * Accepts:  "1-3, 4, 6-9"  →  [1, 2, 3, 4, 6, 7, 8, 9]
 *           "5"            →  [5]
 *           "1,2,3"        →  [1, 2, 3]
 *           ""             →  []
 * Reversed ranges (5-3) are normalised. Non-numeric tokens are ignored.
 */
function parseRaceRanges(input) {
  if (!input) return [];
  const out = new Set();
  for (const part of String(input).split(',')) {
    const tok = part.trim();
    if (!tok) continue;
    const m = tok.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = parseInt(m[1], 10);
      const b = parseInt(m[2], 10);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        for (let n = lo; n <= hi; n++) out.add(n);
      }
    } else if (/^\d+$/.test(tok)) {
      out.add(parseInt(tok, 10));
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Inverse of parseRaceRanges — collapse a sorted (or unsorted) integer
 * array into the canonical compact range form for display.
 *   [1, 2, 3, 4, 6, 7, 8, 9]  →  "1-3, 4, 6-9"
 *
 * Internally re-sorts + dedupes so it's safe to call on any input.
 */
function formatRaceRanges(nums) {
  if (!Array.isArray(nums) || nums.length === 0) return '';
  const sorted = [...new Set(nums.filter(n => Number.isFinite(n)))].sort((a, b) => a - b);
  const parts = [];
  let runStart = sorted[0];
  let runEnd   = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === runEnd + 1) {
      runEnd = cur;
    } else {
      // Flush the run we just closed.
      if (runEnd === runStart)       parts.push(`${runStart}`);
      else if (runEnd === runStart + 1) parts.push(`${runStart}, ${runEnd}`);
      else                            parts.push(`${runStart}-${runEnd}`);
      runStart = cur;
      runEnd   = cur;
    }
  }
  return parts.join(', ');
}

/**
 * Compute scoring flags for each round based on 1:1 progression chains.
 *
 * A progression edge (A → B) is "1:1" iff A has exactly one outgoing
 * progression AND B has exactly one incoming progression. Rounds linked
 * by 1:1 edges form chains. Within each chain, scoring positions are
 * assigned by chain position:
 *   length 1  → no chain, all N (no scoring without a progression edge)
 *   length 2  → R1, RFinal
 *   length 3  → R1, R2, RFinal
 *   length 4+ → R1, R2, N, …, N, RFinal
 * Any round not on a 1:1 chain → 'N'.
 *
 * @param {Array<number>} roundIds  every round in the division
 * @param {Array<{from_round_id:number, to_round_id:number}>} edges
 * @returns {Map<number, 'N'|'R1'|'R2'|'RFinal'>}
 */
function computeChainScoringFlags(roundIds, edges) {
  const flag = new Map();
  for (const id of roundIds) flag.set(id, 'N');

  // Degree counts
  const outDeg = new Map();
  const inDeg = new Map();
  for (const id of roundIds) { outDeg.set(id, 0); inDeg.set(id, 0); }
  for (const e of edges) {
    outDeg.set(e.from_round_id, (outDeg.get(e.from_round_id) || 0) + 1);
    inDeg.set(e.to_round_id, (inDeg.get(e.to_round_id) || 0) + 1);
  }

  // Keep only "1:1" edges
  const oneToOne = edges.filter(e =>
    outDeg.get(e.from_round_id) === 1 && inDeg.get(e.to_round_id) === 1,
  );
  if (oneToOne.length === 0) return flag;

  // Build next-pointer (each from has at most one 1:1 successor) and a
  // set of rounds that ARE the target of some 1:1 edge (so chain starts
  // are rounds with a 1:1 outgoing edge but no 1:1 incoming edge).
  const nextOf = new Map();
  const hasIncoming = new Set();
  for (const e of oneToOne) {
    nextOf.set(e.from_round_id, e.to_round_id);
    hasIncoming.add(e.to_round_id);
  }

  const visited = new Set();
  for (const e of oneToOne) {
    const start = e.from_round_id;
    if (hasIncoming.has(start)) continue; // not a chain head
    if (visited.has(start)) continue;

    // Walk the chain from `start` following `nextOf`.
    const chain = [start];
    let cur = nextOf.get(start);
    while (cur != null && !visited.has(cur)) {
      chain.push(cur);
      visited.add(cur);
      cur = nextOf.get(cur);
    }
    visited.add(start);

    // Assign flags by chain position
    const n = chain.length;
    if (n < 2) continue; // a single round isn't a scored chain
    flag.set(chain[0], 'R1');
    flag.set(chain[n - 1], 'RFinal');
    if (n === 3) {
      flag.set(chain[1], 'R2');
    } else if (n >= 4) {
      flag.set(chain[1], 'R2');
      // chain[2..n-2] stay at default 'N'
    }
  }
  return flag;
}

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
        <button class="btn btn-outline" onclick="window._divCsvExport()" title="Download a CSV of all divisions — edit in Excel/Numbers, then re-import.">
          <i class="material-icons">file_download</i> Export CSV
        </button>
        <label class="btn btn-outline" style="cursor:pointer;" title="Upload an edited CSV. Mandatory: division_name. Optional: div_main_name_en, div_main_name_tc, div_code_prefix, colour_hex (with or without leading #).">
          <i class="material-icons">file_upload</i> Import CSV
          <input type="file" id="divCsvInput" accept=".csv" style="display:none;">
        </label>
        <button class="btn btn-primary" onclick="window._divAddNew()">
          <i class="material-icons">add</i> Add Division
        </button>
      </div>

      <!-- Compact audit summary (full panel lives on the Flowchart page).
           Updates whenever the tab re-renders. -->
      <div id="divAuditSummary" style="margin-bottom:12px;"></div>

      <div id="divisionsList">
        ${divisions.length === 0
          ? '<div class="card" style="text-align:center; padding:32px; color:var(--text-tertiary);">No divisions configured. Click "Add Division" to start.</div>'
          : ''
        }
      </div>
    </div>
  `;

  // Run the audit once and surface a compact summary. Errors fail silently —
  // the audit is informational, never block the Divisions tab from loading.
  runFlowchartAudit().then(audit => {
    const el = document.getElementById('divAuditSummary');
    if (!el) return;
    el.innerHTML = renderDivAuditSummary(audit);
  }).catch(() => {});

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

  // CSV template export — one row per existing division. When there are no
  // divisions yet, emit a single example row so the operator has something
  // to overwrite before re-importing. Round/progression structure is NOT
  // part of the CSV (those need the full modal); CSV covers the flat
  // identity fields only.
  window._divCsvExport = async () => {
    const all = await getAllDivisions();
    const headers = ['division_name', 'div_main_name_en', 'div_main_name_tc', 'div_code_prefix', 'colour_hex'];
    const rows = all.length > 0
      ? all.map(d => headers.map(h => d[h] || ''))
      : [['Corp Mixed 200m', 'Corporate Mixed 200m', '公司男女子混合 200米', 'CM', '#3b82f6']];
    const blob = rowsToCsvBlob([headers, ...rows]);
    downloadFallback(`divisions_${new Date().toISOString().slice(0,10)}.csv`, blob);
    showToast(`Exported ${all.length} division${all.length === 1 ? '' : 's'} as CSV`, 'success', 3000);
  };

  // CSV template import — additive (won't delete existing). Rows with an
  // existing division_name are updated in place; new names create new rows.
  // The required identity fields (rounds, progressions) come from the modal
  // editor — CSV is for the basics only.
  const divCsvInput = document.getElementById('divCsvInput');
  if (divCsvInput) {
    divCsvInput.addEventListener('change', async () => {
      const file = divCsvInput.files[0];
      divCsvInput.value = '';
      if (!file) return;
      try {
        const rows = await csvToRows(file);
        if (rows.length < 2) {
          showToast('CSV has no data rows', 'warning');
          return;
        }
        const header = rows[0].map(h => String(h).trim());
        const nameIdx = header.indexOf('division_name');
        if (nameIdx < 0) {
          showToast('CSV missing required column "division_name"', 'error', 5000);
          return;
        }

        const existing = await getAllDivisions();
        const byName = new Map(existing.map(d => [d.division_name, d]));
        let updated = 0, added = 0, skipped = 0;

        for (let i = 1; i < rows.length; i++) {
          const r = rows[i];
          // Build a header→value map for this row so we accept reordered CSVs.
          const obj = {};
          header.forEach((h, j) => { obj[h] = (r[j] ?? '').toString().trim(); });
          const name = obj.division_name;
          if (!name) { skipped++; continue; }

          const target = byName.get(name) || {};
          target.division_name = name;
          if (obj.div_main_name_en != null) target.div_main_name_en = obj.div_main_name_en;
          if (obj.div_main_name_tc != null) target.div_main_name_tc = obj.div_main_name_tc;
          if (obj.div_code_prefix != null) target.div_code_prefix = obj.div_code_prefix;
          // Tolerate colour_hex with or without leading '#'. Spreadsheet
          // apps strip the '#' on export sometimes ("3b82f6" instead of
          // "#3b82f6"), and operators copy-paste raw hex from other
          // places. Accept both, validate 6 hex digits, prepend '#' on
          // write.
          if (obj.colour_hex) {
            const raw = obj.colour_hex.trim().replace(/^#/, '');
            if (/^[0-9A-Fa-f]{6}$/.test(raw)) {
              target.colour_hex = `#${raw}`;
            }
          }

          await saveDivision(target);
          if (target.id != null) updated++; else added++;
        }

        broadcastChange('config-updated');
        showToast(`CSV import: ${added} added, ${updated} updated${skipped ? `, ${skipped} skipped (no name)` : ''}`, 'success', 5000);
        renderDivisionsTab(container);
      } catch (err) {
        showToast(`CSV import failed: ${err.message}`, 'error', 6000);
        console.error(err);
      }
    });
  }
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
      <span style="font-size:12px; color:var(--text-tertiary); font-family:monospace;">${div.div_code_prefix || ''}</span>
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
  if (!div) div = { division_name: '', div_code_prefix: '', colour_hex: '#3b82f6' };

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
        <label class="form-label">Division Name <span style="color:var(--danger); font-weight:400;">*</span></label>
        <input class="form-input" id="divName" type="text" placeholder="e.g. Corp Mixed 200m" value="${div.division_name || ''}">
        <small style="color:var(--text-tertiary); font-size:11px;">Short label used everywhere in the UI. Required.</small>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div class="form-group">
          <label class="form-label">Division Name (English long)</label>
          <input class="form-input" id="divMainNameEn" type="text"
                 placeholder="e.g. Corporate Mixed 200m"
                 value="${div.div_main_name_en || ''}">
          <small style="color:var(--text-tertiary); font-size:11px;">Optional. Used in photo-finish exports.</small>
        </div>
        <div class="form-group">
          <label class="form-label">Division Name (中文)</label>
          <input class="form-input" id="divMainNameTc" type="text"
                 placeholder="e.g. 公司男女子混合 200米"
                 value="${div.div_main_name_tc || ''}">
          <small style="color:var(--text-tertiary); font-size:11px;">Optional Traditional Chinese long name.</small>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:1fr auto; gap:12px;">
        <div class="form-group">
          <label class="form-label">Code Prefix</label>
          <input class="form-input" id="divCodePrefix" type="text" placeholder="e.g. CM" value="${div.div_code_prefix || ''}">
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
        Define each tier of the bracket as one row. Multiple tiers can share
        the same Round # (parallel brackets — e.g. Cup Semi + Plate Semi both
        run on the same day). Race numbers accept ranges and lists:
        <code>1-3, 5, 7-9</code>.
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
          ? '<p style="font-size:12px; color:var(--text-tertiary);">(populating…)</p>'
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

  // Stable monotonic counters for data-idx (NOT the user-facing round
  // number). data-idx survives deletes — it's only used to wire each
  // round row to the progression dropdowns. The user-facing round_number
  // default for "Add Round" is computed from current visible rows below
  // so add→delete→add doesn't leave gaps.
  //
  // CRITICAL: for a new division the modal HTML emits one initial round
  // row with data-idx="0" (the Heat placeholder). The counter must
  // start PAST it, otherwise the first "Add Round" click creates a
  // second row with data-idx="0" and save's `savedRoundIds["0"]` map
  // gets overwritten — silently corrupting every progression whose
  // From / To pointed at data-idx 0.
  const initialRoundCount = existingRounds.length || 1;
  let nextRoundIdx = initialRoundCount;
  let nextProgIdx  = existingProgs.length;

  // The progression rows reference rounds by data-idx (preserves the
  // link across edits to round_number + tier_name). When we render the
  // existing progressions for an event, we need to map each prog's
  // from/to round_id (a DB id) onto the row's data-idx. Build that map
  // here, mirroring the order existingRounds is rendered in (sorted by
  // round_number).
  const sortedExistingRounds = [...existingRounds].sort(
    (a, b) => (a.round_number || 0) - (b.round_number || 0));
  const dbIdToIdx = new Map();
  sortedExistingRounds.forEach((r, i) => dbIdToIdx.set(r.id, i));
  // Stash on closure so renderProgRow can pluck the idx for each prog.
  const progsWithIdx = existingProgs.map(p => ({
    ...p,
    _fromIdx: dbIdToIdx.has(p.from_round_id) ? dbIdToIdx.get(p.from_round_id) : '',
    _toIdx:   dbIdToIdx.has(p.to_round_id)   ? dbIdToIdx.get(p.to_round_id)   : '',
  }));
  // Build the rounds list with explicit rowIdx (== the round row's
  // data-idx). On initial render the round rows are emitted in
  // sortedExistingRounds order with `renderRoundRow(r, i)`, so the row's
  // data-idx is exactly the loop index here. We attach rowIdx explicitly
  // so callers downstream (refreshProgDropdowns, _divAddProg) can use
  // the same shape without needing to know that invariant.
  const sortedRoundsWithRowIdx = sortedExistingRounds.map((r, i) => ({
    rowIdx: i,
    round_number: r.round_number,
    tier_name: r.tier_name,
  }));

  // Now render any pre-existing progressions with the correctly-keyed
  // dropdown options. The placeholder added above is replaced here.
  const progsListEl = document.getElementById('divProgsList');
  if (progsListEl && progsWithIdx.length > 0) {
    progsListEl.innerHTML = progsWithIdx
      .map((p, i) => renderProgRow(p, i, sortedRoundsWithRowIdx))
      .join('');

    // Belt-and-braces: explicitly set each select's .value AND a
    // `data-rowidx` attribute from the matching prog's _fromIdx /
    // _toIdx. The data attribute is the SAVE-TIME SOURCE OF TRUTH —
    // we read from it at save, not from select.value, because
    // select.value has proven flaky across the round-edit / refresh
    // flow (selection can revert silently). See the save logic below
    // for the matching read.
    const renderedRows = progsListEl.querySelectorAll('.div-prog-row');
    renderedRows.forEach((row, i) => {
      const p = progsWithIdx[i];
      if (!p) return;
      const fromSel = row.querySelector('.prog-from');
      const toSel   = row.querySelector('.prog-to');
      if (fromSel) {
        const v = p._fromIdx !== '' && p._fromIdx != null ? String(p._fromIdx) : '';
        fromSel.value = v;
        fromSel.dataset.rowidx = v;
      }
      if (toSel) {
        const v = p._toIdx !== '' && p._toIdx != null ? String(p._toIdx) : '';
        toSel.value = v;
        toSel.dataset.rowidx = v;
      }
    });
  }

  // Capture every dropdown change into the select's data-rowidx so
  // save reads what the operator actually picked, regardless of any
  // subsequent refresh that might clobber select.value. Delegated
  // listener attached to the prog list so it picks up newly-added
  // prog rows too.
  document.getElementById('divProgsList')?.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || (t.tagName !== 'SELECT')) return;
    if (!t.classList.contains('prog-from') && !t.classList.contains('prog-to')) return;
    t.dataset.rowidx = t.value;
  });

  // Walk the currently-visible round rows and return [{ idx, num, tier }]
  // for use by the progression dropdown rebuilder.
  function readVisibleRounds() {
    const rows = document.querySelectorAll('.div-round-row');
    return [...rows].map(r => ({
      idx:  parseInt(r.dataset.idx, 10),
      num:  parseInt(r.querySelector('.round-num')?.value, 10) || null,
      tier: r.querySelector('.round-tier')?.value?.trim() || '',
    }));
  }

  // Rebuild every progression row's From/To <select> options from current
  // round state, preserving the currently-selected value if the source
  // round still exists. Called whenever rounds are added / removed /
  // renumbered / re-tiered.
  function refreshProgDropdowns() {
    const rounds = readVisibleRounds();
    const opts = rounds.map(r => {
      const label = `R${r.num ?? '?'}${r.tier ? ' — ' + r.tier : ''}`;
      return `<option value="${r.idx}">${escapeHtml(label)}</option>`;
    }).join('');
    const blank = `<option value="">— pick a round —</option>`;
    document.querySelectorAll('.div-prog-row').forEach(progRow => {
      ['.prog-from', '.prog-to'].forEach(sel => {
        const select = progRow.querySelector(sel);
        if (!select) return;
        // Pull the authoritative choice from data-rowidx (set by the
        // initial render + the change listener). Fall back to
        // select.value only if data-rowidx is missing entirely — e.g.
        // a row added before the listener was attached.
        const current = (select.dataset.rowidx ?? '') !== ''
          ? select.dataset.rowidx
          : select.value;
        select.innerHTML = blank + opts;
        // Restore selection if the round still exists.
        if (rounds.some(r => String(r.idx) === current)) {
          select.value = current;
          select.dataset.rowidx = current;
        } else {
          // Source round was deleted — clear so save sees the gap.
          select.value = '';
          select.dataset.rowidx = '';
        }
      });
    });
  }

  window._divAddRound = () => {
    const visible = readVisibleRounds();
    // Default round_number = max visible + 1 so add→delete→add stays at
    // the same number instead of climbing forever.
    const maxNum = visible.reduce((m, r) => Math.max(m, r.num || 0), 0);
    const list = document.getElementById('divRoundsList');
    const div = document.createElement('div');
    div.innerHTML = renderRoundRow(
      { round_number: maxNum + 1, tier_name: '', race_numbers: [] },
      nextRoundIdx);
    list.appendChild(div.firstElementChild);
    nextRoundIdx++;
    refreshProgDropdowns();
  };

  window._divAddProg = () => {
    const list = document.getElementById('divProgsList');
    // Clear "no progressions" placeholder message.
    if (list.querySelector('p')) list.innerHTML = '';
    const div = document.createElement('div');
    div.innerHTML = renderProgRow(
      { _fromIdx: '', _toIdx: '', position_range: '' },
      nextProgIdx, readVisibleRounds().map(r => ({
        // Pass rowIdx — buildRoundOptions uses this as the option value
        // so save-time lookup against savedRoundIds works.
        rowIdx: r.idx, round_number: r.num, tier_name: r.tier,
      })));
    list.appendChild(div.firstElementChild);
    nextProgIdx++;
  };

  window._divRemoveRound = (idx) => {
    const row = document.querySelector(`.div-round-row[data-idx="${idx}"]`);
    if (row) row.remove();
    refreshProgDropdowns();
  };

  window._divRemoveProg = (idx) => {
    const row = document.querySelector(`.div-prog-row[data-idx="${idx}"]`);
    if (row) row.remove();
  };

  // Live-update progression dropdown labels when the operator edits a
  // round's number or tier name. Delegated listener so it works for both
  // existing rows and any added later.
  document.getElementById('divRoundsList')?.addEventListener('input', (e) => {
    if (e.target?.classList?.contains('round-num') ||
        e.target?.classList?.contains('round-tier')) {
      refreshProgDropdowns();
    }
  });

  // Initial population of any pre-existing progression rows (the
  // server-side renderProgRow above ran before _fromIdx/_toIdx were
  // computed, so dropdowns may still be empty).
  refreshProgDropdowns();

  modal.querySelector('#divSaveBtn').addEventListener('click', async () => {
    const name = document.getElementById('divName').value.trim();
    if (!name) { showToast('Division name is required', 'error'); return; }

    // Pre-validate progression rows BEFORE we touch the DB. Rule: a
    // progression row is either fully empty (operator hasn't filled it
    // yet — silently skipped) or fully populated (saved). Any partial
    // row (1 or 2 of {From, To, position_range} filled) is an error;
    // we bail without writing anything to keep the DB consistent.
    const progRowsForValidation = document.querySelectorAll('.div-prog-row');
    const progErrors = [];
    progRowsForValidation.forEach((row, i) => {
      const fromEl = row.querySelector('.prog-from');
      const toEl   = row.querySelector('.prog-to');
      const posEl  = row.querySelector('.prog-pos');
      const fromV = ((fromEl?.dataset.rowidx ?? '') !== ''
        ? fromEl.dataset.rowidx
        : (fromEl?.value || '')).toString().trim();
      const toV = ((toEl?.dataset.rowidx ?? '') !== ''
        ? toEl.dataset.rowidx
        : (toEl?.value || '')).toString().trim();
      const posV = (posEl?.value || '').toString().trim();
      const filled = [fromV, toV, posV].filter(v => v !== '').length;
      if (filled > 0 && filled < 3) {
        const missing = [];
        if (!fromV) missing.push('From');
        if (!toV) missing.push('To');
        if (!posV) missing.push('position range');
        progErrors.push(`Progression row ${i + 1}: missing ${missing.join(', ')}`);
      }
    });
    if (progErrors.length > 0) {
      showToast(progErrors.join(' · '), 'error', 6000);
      return;
    }

    // Save division
    const divData = {
      division_name: name,
      div_main_name_en: document.getElementById('divMainNameEn').value.trim(),
      div_main_name_tc: document.getElementById('divMainNameTc').value.trim(),
      div_code_prefix: document.getElementById('divCodePrefix').value.trim(),
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
      // Range-aware parser so "1-3, 5, 7-9" expands to [1,2,3,5,7,8,9].
      const raceNumbers = parseRaceRanges(racesStr);

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

    // Save progressions. Read from the select's data-rowidx attribute
    // (the authoritative store), falling back to select.value if the
    // attribute is missing (e.g. a row added before the listener was
    // attached). This guards against select.value being clobbered by
    // any refresh-triggered innerHTML replacement.
    //
    // We also collect saved edges into `savedEdges` so the scoring-flag
    // logic below can compute the 1:1 progression chain without an
    // extra DB round-trip.
    const savedEdges = []; // [{ from_round_id, to_round_id }]
    const progRows = document.querySelectorAll('.div-prog-row');
    for (const row of progRows) {
      const fromEl = row.querySelector('.prog-from');
      const toEl   = row.querySelector('.prog-to');
      const fromIdx = (fromEl?.dataset.rowidx ?? '') !== ''
        ? fromEl.dataset.rowidx
        : (fromEl?.value || '');
      const toIdx = (toEl?.dataset.rowidx ?? '') !== ''
        ? toEl.dataset.rowidx
        : (toEl?.value || '');
      const posRange = (row.querySelector('.prog-pos')?.value || '').trim();

      const fromRoundId = savedRoundIds[fromIdx];
      const toRoundId = savedRoundIds[toIdx];

      // Skip wholly-empty rows (pre-validated above as "all-or-nothing",
      // so reaching here with anything missing should be impossible
      // unless a referenced round was somehow not saved).
      if (fromRoundId && toRoundId && posRange) {
        const isScored = posRange.toLowerCase() === 'all';
        await saveDivisionProgression({
          division_id: divId,
          from_round_id: fromRoundId,
          to_round_id: toRoundId,
          position_range: posRange,
          is_scored: isScored,
        });
        savedEdges.push({ from_round_id: fromRoundId, to_round_id: toRoundId });
      }
    }

    // Auto-assign division_id AND scoring_flag on every race in this
    // division. Computing the flag requires building the round-level
    // progression DAG from `savedEdges` and detecting "1:1 chains" —
    // sequences of rounds where each step's from-round has exactly one
    // outgoing progression AND each step's to-round has exactly one
    // incoming progression. Only rounds on such a chain are scored.
    //
    // Examples:
    //   Heat → Cup Semi (top 4) + Plate Semi (rest) → Cup Final + Plate Final
    //     Heat has 2 outgoing → off-chain → all Heat races = N
    //     Cup Semi → Cup Final: each end is 1:1 → chain [Semi, Final]
    //                                          → Semi = R1, Final = RFinal
    //     Plate Semi → Plate Final: separate 1:1 chain → R1 / RFinal
    //
    //   Simple Heat → Semi → Final (each "all"):
    //     All three are 1:1 → chain [Heat, Semi, Final]
    //     → Heat = R1, Semi = R2, Final = RFinal
    //
    // Anything not on a 1:1 chain is left at N. Manual edits on the
    // Schedule page win over this auto-fill (the schedule save compares
    // per-row and only writes changed fields).
    const raceToRoundId = new Map(); // race_number → round_id
    for (const row of roundRows) {
      const roundIdx = row.dataset.idx;
      const roundId = savedRoundIds[roundIdx];
      if (!roundId) continue;
      const racesStr = row.querySelector('.round-races')?.value?.trim() || '';
      for (const n of parseRaceRanges(racesStr)) {
        raceToRoundId.set(n, roundId);
      }
    }
    const roundToFlag = computeChainScoringFlags(
      Object.values(savedRoundIds).filter(Boolean),
      savedEdges,
    );
    let assignedCount = 0;
    if (raceToRoundId.size > 0) {
      const { getRace, saveRace } = await import('../db.js');
      for (const [raceNum, roundId] of raceToRoundId) {
        const race = await getRace(raceNum);
        if (!race) continue; // race not loaded yet — skip; will resolve on next save
        const newFlag = roundToFlag.get(roundId) || 'N';
        let changed = false;
        if (race.division_id !== divId) { race.division_id = divId; changed = true; }
        if (race.scoring_flag !== newFlag) { race.scoring_flag = newFlag; changed = true; }
        if (changed) {
          await saveRace(race);
          assignedCount++;
        }
      }
    }

    modal.remove();
    broadcastChange('config-updated');
    const assignMsg = assignedCount > 0
      ? ` · ${assignedCount} race${assignedCount === 1 ? '' : 's'} assigned`
      : '';
    showToast(`Division "${name}" ${isNew ? 'added' : 'updated'}${assignMsg}`, 'success');

    // Re-run the flowchart audit immediately — operators kept landing
    // on the Flowchart page mid-event to discover conflicts that this
    // save introduced (or didn't fix). Surface them right here so the
    // edit-save loop is tight.
    const auditAfter = await runFlowchartAudit();
    const conflicts = (auditAfter?.conflicts || []).length;
    const missing = (auditAfter?.missing || []).length;
    if (conflicts > 0 || missing > 0) {
      showAuditReviewModal(auditAfter);
    }

    const tabContent = document.getElementById('setupTabContent');
    if (tabContent) renderDivisionsTab(tabContent);
  });
}

// Pop a quick review modal after division save when the audit found
// conflicts or missing pieces. Non-blocking — just a heads-up so the
// operator decides whether to keep the save or jump to fix it now.
function showAuditReviewModal(audit) {
  const existing = document.getElementById('divAuditReviewModal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'divAuditReviewModal';
  modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
  const conflictItems = (audit.conflicts || []).slice(0, 6).map(c => `<li>${c.message || c.type || 'conflict'}</li>`).join('');
  const missingItems = (audit.missing || []).slice(0, 6).map(m => `<li>${m.message || m.type || 'missing'}</li>`).join('');
  const more = ((audit.conflicts?.length || 0) + (audit.missing?.length || 0)) > 12
    ? `<p style="font-size:12px; color:var(--text-tertiary); margin:6px 0 0;">… + more on Flowchart page</p>` : '';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:22px 26px; max-width:540px; width:100%; box-shadow:var(--shadow-lg);">
      <h5 style="font-size:16px; font-weight:600; margin:0 0 10px;">
        <i class="material-icons" style="vertical-align:middle; color:var(--warning);">warning</i>
        Division saved — but audit found issues
      </h5>
      ${conflictItems ? `<div style="font-size:13px; margin-bottom:10px;">
        <strong style="color:var(--danger);">Conflicts</strong>
        <ul style="margin:4px 0 0; padding-left:20px;">${conflictItems}</ul>
      </div>` : ''}
      ${missingItems ? `<div style="font-size:13px; margin-bottom:10px;">
        <strong style="color:var(--warning);">Missing</strong>
        <ul style="margin:4px 0 0; padding-left:20px;">${missingItems}</ul>
      </div>` : ''}
      ${more}
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:14px;">
        <button class="btn btn-ghost" id="auditReviewDismiss">Dismiss</button>
        <a href="#/flowchart" class="btn btn-primary" id="auditReviewOpen">
          <i class="material-icons" style="font-size:16px;">account_tree</i> Open Flowchart
        </a>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#auditReviewDismiss').addEventListener('click', () => modal.remove());
  modal.querySelector('#auditReviewOpen').addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
}

function renderRoundRow(round, idx) {
  const races = formatRaceRanges(round.race_numbers || []);
  return `
    <div class="div-round-row" data-idx="${idx}" style="display:grid; grid-template-columns:60px 1fr 2fr 30px; gap:8px; align-items:center; margin-bottom:6px;">
      <input class="form-input round-num" type="number" min="1" max="9" value="${round.round_number || ''}"
             placeholder="#" style="text-align:center; font-size:13px; padding:4px;">
      <input class="form-input round-tier" type="text" value="${round.tier_name || ''}"
             placeholder="e.g. Heats, Cup Semi, Gold Cup Final" style="font-size:13px; padding:4px 8px;">
      <input class="form-input round-races" type="text" value="${races}"
             placeholder="Race numbers: 1-3, 5, 7-9" style="font-size:13px; padding:4px 8px; font-family:monospace;">
      <button class="btn-icon" onclick="window._divRemoveRound(${idx})" title="Remove" style="color:var(--danger); padding:2px;">
        <i class="material-icons" style="font-size:16px;">close</i>
      </button>
    </div>
  `;
}

function renderProgRow(prog, idx, rounds) {
  // CRITICAL: each <select> carries a `data-rowidx` attribute that is
  // the authoritative chosen round (the round row's data-idx). Save
  // reads from this data attribute, NOT from select.value, because
  // select.value has proven unreliable across browser flows (innerHTML
  // replacement, the `selected` attribute not always sticking, etc.).
  // We also wire a change listener at mount-time that keeps the data
  // attribute in sync with whatever the user picks.
  //
  // Label is "R{num} — {tier}" so parallel tiers at the same depth
  // (e.g. R2 — Cup Semi vs R2 — Plate Semi) stay distinguishable.
  const fromSel = (prog._fromIdx ?? '') === '' ? '' : String(prog._fromIdx);
  const toSel   = (prog._toIdx   ?? '') === '' ? '' : String(prog._toIdx);
  const blank   = `<option value="">— pick a round —</option>`;
  return `
    <div class="div-prog-row" data-idx="${idx}" style="display:grid; grid-template-columns:1fr 20px 1fr 80px 30px; gap:6px; align-items:center; margin-bottom:6px;">
      <select class="form-select prog-from" data-rowidx="${fromSel}" style="font-size:12px; padding:4px 6px;">
        ${blank}${buildRoundOptions(rounds, fromSel)}
      </select>
      <span style="text-align:center; color:var(--text-tertiary);">→</span>
      <select class="form-select prog-to" data-rowidx="${toSel}" style="font-size:12px; padding:4px 6px;">
        ${blank}${buildRoundOptions(rounds, toSel)}
      </select>
      <input class="form-input prog-pos" type="text" value="${prog.position_range || ''}"
             placeholder="e.g. 1-3, rest, all, 5" style="font-size:12px; padding:4px 6px; text-align:center; font-family:monospace;">
      <button class="btn-icon" onclick="window._divRemoveProg(${idx})" title="Remove" style="color:var(--danger); padding:2px;">
        <i class="material-icons" style="font-size:16px;">close</i>
      </button>
    </div>
  `;
}

/**
 * Shared option-list builder for the progression From/To <select>s.
 * Expects each round object to carry an explicit `rowIdx` (= the round
 * row's data-idx attribute). The option's value attribute uses rowIdx,
 * which is what the save logic looks up against `savedRoundIds`.
 */
function buildRoundOptions(rounds, selectedVal) {
  return (rounds || []).map(r => {
    const num = r.round_number ?? '?';
    const tier = r.tier_name || '';
    const label = `R${num}${tier ? ' — ' + tier : ''}`;
    const sel = String(r.rowIdx) === String(selectedVal) ? ' selected' : '';
    return `<option value="${r.rowIdx}"${sel}>${escapeHtml(label)}</option>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

/**
 * Compact audit pill rendered above the divisions list. Clicks through to
 * the Flowchart page where the full audit panel lives — we deliberately
 * don't duplicate the long finding list here to keep the Divisions tab
 * scannable.
 */
function renderDivAuditSummary(audit) {
  const c = audit.conflicts?.length || 0;
  const m = audit.missing?.length || 0;
  // No divisions yet — the empty-state under #divisionsList already
  // tells the operator "click Add Division to start". Suppress the
  // audit pill entirely so we don't double-message that situation.
  if ((audit.stats?.divisions || 0) === 0) {
    return '';
  }
  if (c === 0 && m === 0) {
    return `
      <div style="font-size:12px; color:var(--success); display:flex; align-items:center; gap:6px;">
        <i class="material-icons" style="font-size:16px;">check_circle</i>
        Audit clean — ${audit.stats.divisions} divisions, ${audit.stats.rounds} rounds,
        ${audit.stats.progressions} progressions.
      </div>`;
  }
  const colour = c > 0 ? 'var(--danger)' : 'var(--warning)';
  const icon   = c > 0 ? 'error' : 'warning';
  return `
    <a href="#/flowchart" style="text-decoration:none;">
      <div style="display:flex; align-items:center; gap:8px; padding:8px 12px;
                  border:1px solid ${colour}; border-radius:var(--radius-sm);
                  background:var(--bg-elev); font-size:12px;">
        <i class="material-icons" style="font-size:16px; color:${colour};">${icon}</i>
        <span style="color:var(--text-primary);">
          ${c > 0 ? `<strong style="color:${colour};">${c} conflict${c === 1 ? '' : 's'}</strong>` : ''}
          ${c > 0 && m > 0 ? ' · ' : ''}
          ${m > 0 ? `<strong style="color:var(--warning);">${m} missing</strong>` : ''}
          detected — open the Flowchart page for details and fixes.
        </span>
        <i class="material-icons" style="font-size:16px; color:var(--text-tertiary); margin-left:auto;">arrow_forward</i>
      </div>
    </a>`;
}
