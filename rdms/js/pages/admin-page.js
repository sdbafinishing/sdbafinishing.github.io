/**
 * SDBA RDMS — Admin / DB Viewer
 * Raw IndexedDB viewer for debugging and manual data fixes.
 */
import { db } from '../db.js';
import { showToast } from '../utils.js';
import { autoBackup } from '../backup.js';
import { broadcastChange } from '../app.js';

const TABLE_NAMES = [
  'config', 'races', 'lane_results', 'timesheet',
  'divisions', 'division_rounds', 'division_progressions',
  'race_relationships', 'sync_queue', 'import_log',
];

let currentTable = 'races';

export async function mountAdminPage(container) {
  container.innerHTML = `
    <h4 style="font-size:18px; font-weight:600; margin-bottom:16px;">
      <i class="material-icons" style="vertical-align:middle; margin-right:4px;">storage</i> Database Viewer
    </h4>

    <div style="display:flex; gap:16px; margin-bottom:16px; flex-wrap:wrap; align-items:center;">
      <select class="form-select" id="adminTableSelect" style="width:auto; min-width:200px;"
              onchange="window._adminLoadTable(this.value)">
        ${TABLE_NAMES.map(t => `<option value="${t}" ${t === currentTable ? 'selected' : ''}>${t}</option>`).join('')}
      </select>
      <span id="adminRowCount" style="font-size:13px; color:var(--text-tertiary);"></span>
      <div style="margin-left:auto; display:flex; gap:8px;">
        <button class="btn btn-outline" onclick="window._adminRefresh()">
          <i class="material-icons">refresh</i> Refresh
        </button>
        <button class="btn btn-outline" onclick="window._adminExportJson()">
          <i class="material-icons">download</i> Export Table
        </button>
        <button class="btn btn-danger" onclick="window._adminClearTable()" style="font-size:12px;">
          <i class="material-icons">delete_sweep</i> Clear Table
        </button>
      </div>
    </div>

    <!-- Full DB Backup / Restore -->
    <div class="card" style="margin-bottom:16px; padding:12px 16px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      <i class="material-icons" style="color:var(--accent);">backup</i>
      <span style="font-size:13px; color:var(--text-secondary);">Full database backup — saves all tables as a single JSON file. Restore loads it back.</span>
      <div style="margin-left:auto; display:flex; gap:8px;">
        <button class="btn btn-primary" onclick="window._adminBackupAll()">
          <i class="material-icons">cloud_download</i> Backup All
        </button>
        <label class="btn btn-outline" style="cursor:pointer;">
          <i class="material-icons">cloud_upload</i> Restore
          <input type="file" accept=".json" style="display:none;" onchange="window._adminRestoreAll(this.files[0])">
        </label>
      </div>
    </div>

    <!-- Edit panel -->
    <div id="adminEditPanel" style="display:none; margin-bottom:16px;">
      <div class="card" style="border-color:var(--accent);">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
          <span class="card-title" id="adminEditTitle">Editing record</span>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-ghost" onclick="window._adminCancelEdit()">Cancel</button>
            <button class="btn btn-primary" onclick="window._adminSaveEdit()">
              <i class="material-icons">save</i> Save
            </button>
          </div>
        </div>
        <textarea id="adminEditJson" class="form-input"
                  style="font-family:monospace; font-size:12px; min-height:200px; resize:vertical;"></textarea>
      </div>
    </div>

    <!-- Data table -->
    <div class="card" style="padding:0; overflow:auto; max-height:60vh;">
      <table class="race-table" id="adminDataTable">
        <thead id="adminTableHead"></thead>
        <tbody id="adminTableBody"></tbody>
      </table>
    </div>
  `;

  window._adminLoadTable = loadTable;
  window._adminRefresh = () => loadTable(currentTable);
  window._adminExportJson = exportTableJson;
  window._adminClearTable = clearTable;
  window._adminEditRow = editRow;
  window._adminDeleteRow = deleteRow;
  window._adminCancelEdit = cancelEdit;
  window._adminSaveEdit = saveEdit;
  window._adminBackupAll = backupAll;
  window._adminRestoreAll = restoreAll;

  await loadTable(currentTable);
}

export function unmountAdminPage() {
  delete window._adminLoadTable;
  delete window._adminRefresh;
  delete window._adminExportJson;
  delete window._adminClearTable;
  delete window._adminEditRow;
  delete window._adminDeleteRow;
  delete window._adminCancelEdit;
  delete window._adminSaveEdit;
  delete window._adminBackupAll;
  delete window._adminRestoreAll;
  editingTable = null;
  editingKey = null;
}

async function loadTable(tableName) {
  currentTable = tableName;
  const rows = await db[tableName].toArray();
  const countEl = document.getElementById('adminRowCount');
  if (countEl) countEl.textContent = `${rows.length} row${rows.length !== 1 ? 's' : ''}`;

  const headEl = document.getElementById('adminTableHead');
  const bodyEl = document.getElementById('adminTableBody');
  if (!headEl || !bodyEl) return;

  if (rows.length === 0) {
    headEl.innerHTML = '';
    bodyEl.innerHTML = '<tr><td style="padding:20px; text-align:center; color:var(--text-tertiary);">Empty table</td></tr>';
    return;
  }

  // Get all unique keys across all rows
  const allKeys = new Set();
  rows.forEach(row => Object.keys(row).forEach(k => allKeys.add(k)));
  const keys = [...allKeys];

  headEl.innerHTML = `<tr>
    ${keys.map(k => `<th style="white-space:nowrap; font-size:11px;">${k}</th>`).join('')}
    <th style="width:80px;">Actions</th>
  </tr>`;

  bodyEl.innerHTML = rows.map((row, idx) => {
    const pk = getPrimaryKey(tableName, row);
    return `<tr>
      ${keys.map(k => {
        let val = row[k];
        if (val === null || val === undefined) val = '';
        if (typeof val === 'object') val = JSON.stringify(val);
        const display = String(val).length > 40 ? String(val).slice(0, 40) + '...' : String(val);
        return `<td style="font-size:12px; font-family:monospace; white-space:nowrap; max-width:200px; overflow:hidden; text-overflow:ellipsis;"
                    title="${String(val).replace(/"/g, '&quot;')}">${display}</td>`;
      }).join('')}
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost" style="padding:2px 6px; font-size:11px;" onclick="window._adminEditRow('${tableName}', ${JSON.stringify(pk).replace(/'/g, "\\'")})">Edit</button>
        <button class="btn btn-ghost" style="padding:2px 6px; font-size:11px; color:var(--danger);" onclick="window._adminDeleteRow('${tableName}', ${JSON.stringify(pk).replace(/'/g, "\\'")})">Del</button>
      </td>
    </tr>`;
  }).join('');
}

function getPrimaryKey(tableName, row) {
  // Dexie primary keys
  if (tableName === 'config') return row.id;
  if (tableName === 'races') return row.race_number;
  if (tableName === 'lane_results') return [row.race_number, row.lane_number];
  if (tableName === 'timesheet') return row.race_number;
  return row.id;
}

let editingTable = null;
let editingKey = null;

async function editRow(tableName, pk) {
  const row = await db[tableName].get(pk);
  if (!row) { showToast('Record not found', 'error'); return; }

  editingTable = tableName;
  editingKey = pk;

  const panel = document.getElementById('adminEditPanel');
  const title = document.getElementById('adminEditTitle');
  const textarea = document.getElementById('adminEditJson');

  title.textContent = `Editing ${tableName} — key: ${JSON.stringify(pk)}`;
  textarea.value = JSON.stringify(row, null, 2);
  panel.style.display = 'block';
  textarea.focus();
}

function cancelEdit() {
  document.getElementById('adminEditPanel').style.display = 'none';
  editingTable = null;
  editingKey = null;
}

async function saveEdit() {
  const textarea = document.getElementById('adminEditJson');
  let data;
  try {
    data = JSON.parse(textarea.value);
  } catch (e) {
    showToast('Invalid JSON: ' + e.message, 'error');
    return;
  }

  try {
    // Capture editingTable BEFORE cancelEdit clears it — otherwise the
    // loadTable below sees null and `db[null].toArray()` throws.
    const tableName = editingTable;
    await db[tableName].put(data);
    showToast('Record saved', 'success');
    cancelEdit();
    await loadTable(tableName);
  } catch (e) {
    showToast('Save failed: ' + e.message, 'error');
  }
}

async function deleteRow(tableName, pk) {
  if (!confirm(`Delete record with key ${JSON.stringify(pk)} from ${tableName}?`)) return;
  try {
    await db[tableName].delete(pk);
    showToast('Record deleted', 'info');
    await loadTable(tableName);
  } catch (e) {
    showToast('Delete failed: ' + e.message, 'error');
  }
}

async function exportTableJson() {
  const rows = await db[currentTable].toArray();
  const blob = new Blob([JSON.stringify(rows, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rdms_${currentTable}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Exported ${rows.length} rows from ${currentTable}`, 'success');
}

async function backupAll() {
  // Route through autoBackup() so the result lands in the connected
  // event folder's "20 Database Backup/" subfolder (or Drive's, if
  // that's the connected backend). Previously this function had its
  // own download-only implementation that ignored the connected
  // folder — so even with a local folder attached, backups went to
  // the browser's Downloads.
  await autoBackup('manual');
}

async function restoreAll(file) {
  if (!file) return;
  if (!confirm('Restore will REPLACE all current data. Continue?')) return;

  try {
    const text = await file.text();
    const backup = JSON.parse(text);

    if (!backup._meta || backup._meta.app !== 'sdba-rdms') {
      showToast('Invalid backup file — missing metadata', 'error');
      return;
    }

    let totalRows = 0;
    for (const table of TABLE_NAMES) {
      if (backup[table] && Array.isArray(backup[table])) {
        await db[table].clear();
        if (backup[table].length > 0) {
          await db[table].bulkPut(backup[table]);
        }
        totalRows += backup[table].length;
      }
    }

    showToast(`Restored ${totalRows} records from backup (${backup._meta.exported_at})`, 'success');
    await loadTable(currentTable);

    // The restored backup may carry a different event_config row (e.g.
    // switching from 2026WU to 2026WU2), so the navbar badge + every
    // page that hydrates from config is now stale. Fan out the same
    // broadcast that Setup save uses so the badge re-renders + other
    // tabs reload. Folder watchers are reset separately because the
    // newly-restored event likely points at a different physical folder.
    broadcastChange('config-updated');
    try {
      const { resetFolderAccess } = await import('../file-access.js');
      resetFolderAccess();
      if (typeof window._rdmsUpdateFolderIcons === 'function') window._rdmsUpdateFolderIcons();
    } catch { /* file-access may not be loaded yet */ }
  } catch (e) {
    showToast('Restore failed: ' + e.message, 'error');
  }
}

async function clearTable() {
  if (!confirm(`Clear ALL data from "${currentTable}"? This cannot be undone.`)) return;
  if (!confirm(`Are you sure? This will delete ${(await db[currentTable].count())} records.`)) return;
  await db[currentTable].clear();
  showToast(`Table "${currentTable}" cleared`, 'warning');
  await loadTable(currentTable);
}
