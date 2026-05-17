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

export async function mountImportPage(container) {
  container.innerHTML = `
    <h4 style="font-size:18px; font-weight:600; margin-bottom:16px;">Import & Start Lists</h4>

    <div class="tabs">
      <button class="tab active" data-tab="draws" onclick="window._importTab('draws')">Import Draws</button>
      <button class="tab" data-tab="joyi" onclick="window._importTab('joyi')">Import Joyi Results</button>
      <button class="tab" data-tab="startlists" onclick="window._importTab('startlists')">Generate Start Lists</button>
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
  container.innerHTML = `
    <div class="card" style="margin-top:16px;">
      <div class="section-header">Import Draw Files</div>
      <p style="font-size:13px; color:var(--text-secondary); margin-bottom:16px;">
        Drop .xls draw files here. Race numbers are auto-detected from filenames
        (e.g. <code>1.xls</code>, <code>Second Round - 25.xls</code>).
      </p>

      <div style="display:flex; gap:12px; margin-bottom:16px;">
        <button class="btn btn-primary" onclick="window._importFromSourceFolder()">
          <i class="material-icons">folder</i> Import from Source Folder (01 Input_Draw/)
        </button>
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
  container.innerHTML = `
    <div class="card" style="margin-top:16px;">
      <div class="section-header">Import Joyi Race Results</div>
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
