/**
 * SDBA RDMS — Import Page
 * Drag-and-drop draw files + Joyi results. Auto-detect race numbers.
 */
import { importMultipleDrawFiles, parseDrawFile, parseJoyiFile, importJoyiToDb } from '../import.js';
import { getRace } from '../db.js';
import { extractRaceNumber } from '../utils.js';
import { generateJoyiStartList, generateSprintTimerStartList } from '../startlist.js';
import { backupAfterSetup } from '../backup.js';
import { showToast } from '../utils.js';
import { broadcastChange } from '../app.js';
import { listSourceSubfolder, isSourceConnected, requestSourceFolder } from '../file-access.js';
import { startJoyiWatch, stopJoyiWatch, getJoyiWatchStatus, isJoyiWatchEnabled } from '../joyi-watch.js';
import { startDrawWatch, stopDrawWatch, getDrawWatchStatus, isDrawWatchEnabled } from '../draw-watch.js';
import { summariseDivisions } from '../round-completion.js';
import { generateNextRoundDraws } from '../draw-gen.js';

export async function mountImportPage(container) {
  container.innerHTML = `
    <h4 style="font-size:18px; font-weight:600; margin-bottom:16px;">Im/Export</h4>

    <div class="tabs">
      <button class="tab active" data-tab="draws" onclick="window._importTab('draws')">Import Draws</button>
      <button class="tab" data-tab="joyi" onclick="window._importTab('joyi')">Import Joyi Results</button>
      <button class="tab" data-tab="startlists" onclick="window._importTab('startlists')">Generate Start Lists</button>
      <button class="tab" data-tab="nextround" onclick="window._importTab('nextround')">Generate Next Round Draws</button>
    </div>

    <div id="importTabContent"></div>
  `;

  window._importTab = (tab) => {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    renderImportTab(tab);
  };

  renderImportTab('draws');
}

export function unmountImportPage() {
  delete window._importTab;
  delete window._importFromSourceFolder;
  delete window._genJoyiStartList;
  delete window._genSprintTimerStartList;
}

function renderImportTab(tab) {
  const content = document.getElementById('importTabContent');
  if (!content) return;

  if (tab === 'draws') {
    renderDrawImport(content);
  } else if (tab === 'joyi') {
    renderJoyiImport(content);
  } else if (tab === 'nextround') {
    renderNextRoundDrawsTab(content);
  } else if (tab === 'startlists') {
    content.innerHTML = `
      <div class="card" style="margin-top:16px;">
        <div class="section-header">Generate Start Lists</div>
        <p style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">
          Generate start list files from imported draw data. Downloads to your browser —
          copy to both the local <strong>10 Output_Start Lists/</strong> folder and the Google Drive share folder.
        </p>
        <div style="display:flex; gap:12px; flex-wrap:wrap;">
          <button class="btn btn-primary" onclick="window._genJoyiStartList()">
            <i class="material-icons">description</i> Generate Joyi Start List (.xls)
          </button>
          <button class="btn btn-outline" onclick="window._genSprintTimerStartList()">
            <i class="material-icons">description</i> Generate SprintTimer Start List (.csv)
          </button>
        </div>
        <div id="startListLog" style="margin-top:16px;"></div>
      </div>
    `;

    window._genJoyiStartList = async () => {
      try {
        await generateJoyiStartList();
        showToast('Copy the Joyi Start List to the Joyi camera system.', 'warning', 6000);
      } catch (err) {
        showToast('Start list error: ' + err.message, 'error');
      }
    };
    window._genSprintTimerStartList = async () => {
      try {
        await generateSprintTimerStartList();
        showToast('Copy the SprintTimer Start List to the SprintTimer system.', 'warning', 6000);
      } catch (err) {
        showToast('Start list error: ' + err.message, 'error');
      }
    };
  }
}

function renderDrawImport(container) {
  const watchStatus = getDrawWatchStatus();
  container.innerHTML = `
    <div class="card" style="margin-top:16px;">
      <div class="section-header">Auto-Watch Draw Folder</div>
      <p style="font-size:13px; color:var(--text-secondary); margin-bottom:12px;">
        Polls <code>01 Input_Draw/</code> every few seconds for new or modified
        <code>.xls</code> files and auto-imports them. Prefers Google Drive when a
        token is present (no local-sync lag); otherwise watches the connected
        source folder. Use this when RMS pushes mid-event draw updates via Drive
        sync.
      </p>
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        <button class="btn ${watchStatus.enabled ? 'btn-danger' : 'btn-primary'}" id="drawWatchToggle">
          <i class="material-icons">${watchStatus.enabled ? 'pause_circle' : 'play_circle'}</i>
          ${watchStatus.enabled ? 'Stop watching' : 'Start watching'}
        </button>
        <div id="drawWatchStatus" style="font-size:12px; color:var(--text-tertiary);"></div>
      </div>
    </div>

    <div class="card" style="margin-top:16px;">
      <div class="section-header">Import Draw Files</div>
      <p style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">
        Drop .xls draw files here. Race numbers are auto-detected from filenames
        (e.g. <code>1.xls</code>, <code>Second Round - 25.xls</code>).
      </p>

      <div style="display:flex; gap:12px; margin-bottom:16px; flex-wrap:wrap; align-items:center;">
        <button class="btn btn-primary" onclick="window._importFromSourceFolder()">
          <i class="material-icons">folder</i> Import all from <code style="background:rgba(0,0,0,0.2); padding:1px 5px; border-radius:3px;">01 Input_Draw/</code>
        </button>
        <small style="font-size:11px; color:var(--text-tertiary);">
          Reads every <code>.xls</code> in the event's <code>01 Input_Draw/</code> subfolder
          (under the connected source folder).
          Click to pick the <strong>root event folder</strong> on first use — RDMS finds
          <code>01 Input_Draw/</code> inside it automatically.
        </small>
      </div>

      <div id="drawDropZone" class="drop-zone">
        <i class="material-icons" style="font-size:40px; color:var(--text-tertiary);">upload_file</i>
        <p>Or drag & drop .xls files here</p>
        <p style="font-size:12px; color:var(--text-tertiary);">or</p>
        <label class="btn btn-outline" style="cursor:pointer;">
          <i class="material-icons">folder_open</i> Browse Files
          <input type="file" id="drawFileInput" multiple accept=".xls,.xlsx" style="display:none;">
        </label>
      </div>

      <div id="drawImportLog" style="margin-top:16px;"></div>
    </div>
  `;

  // Wire the Auto-Watch toggle + status line. Status text auto-updates
  // after every tick via the callback we pass into startDrawWatch.
  const refreshDrawWatchStatus = (st) => {
    const el = document.getElementById('drawWatchStatus');
    if (!el) return;
    if (!st.enabled) { el.textContent = 'Not running.'; return; }
    const lastTxt = st.lastScanAt ? new Date(st.lastScanAt).toLocaleTimeString() : '—';
    const errTxt  = st.lastError ? ` · last error: ${st.lastError}` : '';
    const backendTxt = st.backend === 'drive' ? 'Drive' : 'local folder';
    el.textContent = `Watching ${backendTxt} ${st.folderPath || '?'} · ${st.knownFiles} files known · last scan ${lastTxt} · imported ${st.importedSinceStart} since start${errTxt}`;
  };
  refreshDrawWatchStatus(getDrawWatchStatus());
  document.getElementById('drawWatchToggle').addEventListener('click', async () => {
    const st = getDrawWatchStatus();
    if (st.enabled) {
      stopDrawWatch();
    } else {
      await startDrawWatch(refreshDrawWatchStatus);
    }
    renderDrawImport(container); // re-render to swap button label
  });

  setupDropZone('drawDropZone', 'drawFileInput', handleDrawFiles);

  window._importFromSourceFolder = async () => {
    if (!isSourceConnected()) {
      await requestSourceFolder();
      if (!isSourceConnected()) {
        showToast('Source folder not connected. Click the folder icon in the navbar first.', 'warning');
        return;
      }
    }

    const fileHandles = await listSourceSubfolder('01 Input_Draw');
    if (fileHandles.length === 0) {
      showToast('No files found in 01 Input_Draw/', 'warning');
      return;
    }

    // Convert file handles to File objects
    const files = [];
    for (const fh of fileHandles) {
      const name = fh.name.toLowerCase();
      if (name.endsWith('.xls') || name.endsWith('.xlsx')) {
        const file = await fh.getFile();
        files.push(file);
      }
    }

    if (files.length === 0) {
      showToast('No .xls files found in 01 Input_Draw/', 'warning');
      return;
    }

    showToast(`Found ${files.length} draw files. Importing...`, 'info', 2000);
    await handleDrawFiles(files);
  };
}

function renderJoyiImport(container) {
  const watchStatus = getJoyiWatchStatus();
  container.innerHTML = `
    <div class="card" style="margin-top:16px;">
      <div class="section-header">Auto-Import Joyi Results</div>
      <p style="font-size:13px; color:var(--text-secondary); margin-bottom:12px;">
        Watch the <code>{event_ref}_Joyi/</code> folder for new or updated
        <code>.xls</code> / <code>.jyd</code> result files and auto-import them.
        Prefers <strong>Google Drive</strong> when a Drive token is present
        (faster — no local sync delay); otherwise watches the connected source
        folder (folder icon in navbar). Status line below shows which backend
        is active.
      </p>
      <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
        <button class="btn ${watchStatus.enabled ? 'btn-danger' : 'btn-primary'}" id="joyiWatchToggle">
          <i class="material-icons">${watchStatus.enabled ? 'pause_circle' : 'play_circle'}</i>
          ${watchStatus.enabled ? 'Stop watching' : 'Start watching'}
        </button>
        <div id="joyiWatchStatus" style="font-size:12px; color:var(--text-tertiary);"></div>
      </div>
    </div>

    <div class="card" style="margin-top:16px;">
      <div class="section-header">Manual Import Joyi Results</div>
      <p style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">
        Drop Joyi .xls result files here. Race number is detected from filename
        (e.g. <code>2026TN.9.xls</code> → Race 9).
      </p>

      <div id="joyiDropZone" class="drop-zone">
        <i class="material-icons" style="font-size:40px; color:var(--text-tertiary);">cloud_download</i>
        <p>Drag & drop Joyi .xls files here</p>
        <p style="font-size:12px; color:var(--text-tertiary);">or</p>
        <label class="btn btn-outline" style="cursor:pointer;">
          <i class="material-icons">folder_open</i> Browse Files
          <input type="file" id="joyiFileInput" multiple accept=".xls,.xlsx" style="display:none;">
        </label>
      </div>

      <div id="joyiImportLog" style="margin-top:16px;"></div>
    </div>
  `;

  setupDropZone('joyiDropZone', 'joyiFileInput', handleJoyiFiles);

  const refreshStatus = (st) => {
    const el = document.getElementById('joyiWatchStatus');
    if (!el) return;
    if (!st.enabled) {
      el.textContent = 'Not running.';
      return;
    }
    const lastTxt = st.lastScanAt ? new Date(st.lastScanAt).toLocaleTimeString() : '—';
    const errTxt = st.lastError ? ` · last error: ${st.lastError}` : '';
    const backendTxt = st.backend === 'drive' ? 'Drive' : 'local folder';
    el.textContent = `Watching ${backendTxt} ${st.folderPath || '?'} · ${st.knownFiles} files known · last scan ${lastTxt} · imported ${st.importedSinceStart} since start${errTxt}`;
  };
  refreshStatus(getJoyiWatchStatus());

  document.getElementById('joyiWatchToggle').addEventListener('click', async () => {
    const st = getJoyiWatchStatus();
    if (st.enabled) {
      stopJoyiWatch();
    } else {
      await startJoyiWatch(refreshStatus);
    }
    // Re-render to swap button state.
    renderJoyiImport(container);
  });
}

function setupDropZone(zoneId, inputId, handler) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  if (!zone || !input) return;

  // Drag events
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => {
    zone.classList.remove('drag-over');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handler(e.dataTransfer.files);
  });

  // File input
  input.addEventListener('change', () => {
    handler(input.files);
    input.value = ''; // reset for re-import
  });
}

async function handleDrawFiles(files) {
  const logEl = document.getElementById('drawImportLog');
  if (!logEl) return;

  // Check if any files would overwrite existing race data
  const fileArray = Array.from(files);
  const existingRaces = [];
  for (const file of fileArray) {
    const raceNum = extractRaceNumber(file.name);
    if (raceNum) {
      const race = await getRace(raceNum);
      if (race && (race.start_time || race.export_time)) {
        existingRaces.push({ raceNum, title: race.race_title || '', hasResults: !!race.start_time });
      }
    }
  }

  // Show confirmation if re-importing races with results
  if (existingRaces.length > 0) {
    const raceList = existingRaces.map(r =>
      `Race ${r.raceNum} — ${r.title}${r.hasResults ? ' (HAS RESULTS)' : ''}`
    ).join('\n');

    if (!confirm(
      `The following race(s) already have data and their draws will be updated:\n\n${raceList}\n\n` +
      `Team assignments will be overwritten. Race times and results are preserved.\n\nConfirm?`
    )) {
      logEl.innerHTML = '<p style="color:var(--text-tertiary);">Import cancelled.</p>';
      return;
    }
  }

  logEl.innerHTML = '<p style="color:var(--text-secondary);">Importing...</p>';

  const results = await importMultipleDrawFiles(fileArray);

  logEl.innerHTML = results.map(r => {
    if (r.success) {
      return `<div style="padding:6px 12px; margin-bottom:4px; border-radius:var(--radius-sm); background:var(--success-bg); color:var(--success-text); font-size:13px;">
        <i class="material-icons" style="font-size:14px; vertical-align:middle; margin-right:4px;">check_circle</i>
        <strong>${r.filename}</strong> → Race ${r.raceNumber} — ${r.title} — ${r.teamsLoaded ? 'teams loaded' : 'placeholders only'}
      </div>`;
    } else {
      return `<div style="padding:6px 12px; margin-bottom:4px; border-radius:var(--radius-sm); background:var(--danger-bg); color:var(--danger-text); font-size:13px;">
        <i class="material-icons" style="font-size:14px; vertical-align:middle; margin-right:4px;">error</i>
        <strong>${r.filename}</strong> — ${r.error}
      </div>`;
    }
  }).join('');

  const successCount = results.filter(r => r.success).length;
  showToast(`Imported ${successCount} of ${results.length} draw files`, successCount === results.length ? 'success' : 'warning');
  broadcastChange('draw-imported');

  // Auto-backup after initial draw import
  if (successCount > 0) {
    await backupAfterSetup();
    // Auto-generate Joyi start list when the operator has opted in.
    // Useful because the Joyi camera laptop reads its start list from the
    // shared folder — keeping the two in sync without a separate click
    // means re-importing draws (or generating next-round drafts via the
    // resolver) automatically refreshes what the operator on the Joyi
    // laptop sees.
    try {
      const { getConfig } = await import('../db.js');
      const cfg = await getConfig();
      if (cfg?.auto_start_list_on_import) {
        await generateJoyiStartList();
        showToast('Joyi start list regenerated.', 'info', 3000);
      }
    } catch (err) {
      console.warn('Auto-generate Joyi start list failed:', err);
    }
  }
}

async function handleJoyiFiles(files) {
  const logEl = document.getElementById('joyiImportLog');
  if (!logEl) return;

  logEl.innerHTML = '<p style="color:var(--text-secondary);">Importing...</p>';

  const results = [];
  for (const file of Array.from(files)) {
    try {
      const parsed = await parseJoyiFile(file);
      const result = await importJoyiToDb(parsed);
      results.push({ filename: file.name, raceNumber: result.raceNumber, count: result.count, success: true });
    } catch (err) {
      results.push({ filename: file.name, raceNumber: null, count: 0, success: false, error: err.message });
    }
  }

  logEl.innerHTML = results.map(r => {
    if (r.success) {
      return `<div style="padding:6px 12px; margin-bottom:4px; border-radius:var(--radius-sm); background:var(--success-bg); color:var(--success-text); font-size:13px;">
        <i class="material-icons" style="font-size:14px; vertical-align:middle; margin-right:4px;">check_circle</i>
        <strong>${r.filename}</strong> → Race ${r.raceNumber} — ${r.count} results imported
      </div>`;
    } else {
      return `<div style="padding:6px 12px; margin-bottom:4px; border-radius:var(--radius-sm); background:var(--danger-bg); color:var(--danger-text); font-size:13px;">
        <i class="material-icons" style="font-size:14px; vertical-align:middle; margin-right:4px;">error</i>
        <strong>${r.filename}</strong> — ${r.error}
      </div>`;
    }
  }).join('');

  const successCount = results.filter(r => r.success).length;
  showToast(`Imported ${successCount} Joyi result file(s)`, successCount > 0 ? 'success' : 'error');
  broadcastChange('race-updated');
}

// ──────────────── Generate Next Round Draws tab ────────────────

/**
 * Per-division grid showing each round's completion progress (e.g. "3 / 6
 * complete") and a "Resolve / Generate" button when:
 *   - the previous round is fully exported/cancelled AND
 *   - at least one race in the next round has unresolved R{n}P{n}
 *     placeholders.
 *
 * "All available draws generated" → green check, no action. The button is
 * a no-op for races that already have resolved teams, so re-clicking is
 * safe.
 */
async function renderNextRoundDrawsTab(container) {
  container.innerHTML = `
    <div class="card" style="margin-top:16px;">
      <div class="section-header">Generate Next Round Draws</div>
      <p style="font-size:13px; color:var(--text-secondary); margin-bottom:12px;">
        Resolves <code>R{n}P{n}</code> placeholders in next-round draws using completed
        source-race results. The same placeholder convention used in the source draw
        files (e.g. <code>R16P3</code> in Race 39 lane 1 → "team that finished 3rd in
        Race 16") drives the lane assignments — this just substitutes names. Generated
        files are written to <code>13 Output_Next Round Draws/</code> and the shared
        Drive folder. The in-app race state updates immediately regardless of file write.
      </p>
      <div id="nrdGrid">
        <div style="padding:24px; text-align:center; color:var(--text-tertiary);">
          <i class="material-icons" style="font-size:24px;">hourglass_top</i>
          <div style="margin-top:6px; font-size:13px;">Scanning divisions…</div>
        </div>
      </div>
    </div>
  `;

  const refresh = async () => {
    const grid = document.getElementById('nrdGrid');
    if (!grid) return;
    const divisions = await summariseDivisions();

    if (divisions.length === 0) {
      grid.innerHTML = `
        <div style="padding:24px; text-align:center; color:var(--text-tertiary);">
          No divisions configured.
          <a href="#/setup" style="color:var(--accent);">Set up divisions</a> first.
        </div>`;
      return;
    }

    // Anything still pending across all divisions?
    const anyPending = divisions.some(d => d.rounds.some(r => r.nextRaces.length > 0));
    if (!anyPending) {
      grid.innerHTML = `
        <div style="padding:20px; text-align:center; color:var(--success); display:flex; align-items:center; justify-content:center; gap:8px;">
          <i class="material-icons">check_circle</i>
          All next-round draws are populated — no action required.
        </div>` + renderDivisionTable(divisions);
      attachDivButtonHandlers(refresh);
      return;
    }

    grid.innerHTML = renderDivisionTable(divisions);
    attachDivButtonHandlers(refresh);
  };

  // Listen for draw-imported broadcasts (other tabs or our own generator
  // finishing) so the grid refreshes without manual reload.
  const onDrawImported = () => refresh();
  window.addEventListener('rdms-draw-imported', onDrawImported);
  window.addEventListener('rdms-race-updated', onDrawImported);
  // Best-effort cleanup. Import page's unmount deletes window._importTab
  // which is enough to invalidate stale closures; these listeners are
  // idempotent if re-attached on re-mount.
  container.dataset.nrdAttached = '1';

  refresh();
}

function renderDivisionTable(divisions) {
  return `
    <table class="race-table" style="width:100%; margin-top:8px;">
      <thead>
        <tr>
          <th style="width:140px; text-align:left;">Division</th>
          <th style="width:120px; text-align:left;">Round</th>
          <th style="width:100px; text-align:center;">Progress</th>
          <th style="text-align:left;">Next-round races needing draws</th>
          <th style="width:170px;"></th>
        </tr>
      </thead>
      <tbody>
        ${divisions.map(d => d.rounds.map((r, i) => renderRoundRow(d, r, i)).join('')).join('')}
      </tbody>
    </table>
  `;
}

function renderRoundRow(division, round, idx) {
  const isFirstRowForDiv = idx === 0;
  const progressColour = round.isComplete ? 'var(--success)' : 'var(--text-secondary)';
  const hasNext = round.nextRaces.length > 0;
  const btnDisabled = !round.isComplete || !hasNext;
  const btnLabel = !hasNext
    ? '✓ Generated'
    : (round.isComplete ? `Resolve ${round.nextRaces.length}` : 'Waiting…');

  return `
    <tr>
      <td>
        ${isFirstRowForDiv
          ? `<span style="display:inline-block; width:8px; height:18px; border-radius:2px; background:${division.colour}; margin-right:6px; vertical-align:middle;"></span><strong>${escapeAttr(division.division_name)}</strong>`
          : ''}
      </td>
      <td style="color:var(--text-secondary);">${escapeAttr(round.tier_name)}</td>
      <td style="text-align:center; color:${progressColour}; font-variant-numeric:tabular-nums;">
        ${round.complete} / ${round.total}
        ${round.isComplete ? '<i class="material-icons" style="font-size:14px; vertical-align:middle;">check</i>' : ''}
      </td>
      <td style="font-size:12px; color:var(--text-secondary);">
        ${hasNext
          ? round.nextRaces.map(nr => `<span title="${escapeAttr(nr.race_title)}" style="display:inline-block; padding:1px 6px; margin:1px 2px; border:1px solid var(--border); border-radius:3px; background:var(--bg-elev);">Race ${nr.race_number} <span style="color:var(--text-tertiary);">(${nr.placeholder_count})</span></span>`).join('')
          : '<span style="color:var(--text-tertiary);">no pending</span>'}
      </td>
      <td>
        <button class="btn btn-${btnDisabled ? 'ghost' : 'primary'} btn-sm"
                ${btnDisabled ? 'disabled' : ''}
                data-races="${round.nextRaces.map(n => n.race_number).join(',')}"
                data-nrd-action="generate">
          <i class="material-icons" style="font-size:14px;">auto_fix_high</i> ${btnLabel}
        </button>
      </td>
    </tr>
  `;
}

function attachDivButtonHandlers(refresh) {
  document.querySelectorAll('[data-nrd-action="generate"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const races = (btn.dataset.races || '').split(',').filter(Boolean).map(Number);
      if (races.length === 0) return;
      btn.disabled = true;
      btn.innerHTML = '<i class="material-icons" style="font-size:14px;">hourglass_top</i> Generating…';
      try {
        const { summaries, totalResolved } = await generateNextRoundDraws(races);
        const partial = summaries.filter(s => s.skipped > 0).length;
        const failed  = summaries.filter(s => !s.success).length;
        const tone = failed > 0 ? 'error' : (partial > 0 ? 'warning' : 'success');
        const msg = `Resolved ${totalResolved} placeholder${totalResolved === 1 ? '' : 's'} across ${summaries.length} race${summaries.length === 1 ? '' : 's'}` +
          (partial > 0 ? ` (${partial} partial)` : '') +
          (failed > 0 ? ` (${failed} failed)` : '');
        showToast(msg, tone, 5500);
        broadcastChange('draw-imported');
        await refresh();
      } catch (err) {
        showToast(`Generation failed: ${err.message || err}`, 'error', 5000);
        btn.disabled = false;
      }
    });
  });
}

function escapeAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
