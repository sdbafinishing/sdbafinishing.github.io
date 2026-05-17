/**
 * SDBA RDMS — Joyi Folder Watch
 *
 * Polls the connected source folder's Joyi subfolder (typically
 * "80 Shared/{event_ref}_Joyi") for new or modified .xls files and
 * auto-imports them as race results.
 *
 * Hooks into the existing File System Access API folder handle — the
 * operator only needs to connect the source folder once (the same
 * connection that import-draws and export use).
 *
 * Persistence: lastModified seen per filename is held in memory for the
 * session. On first scan after start(), files are recorded but not
 * imported (so re-enabling the watcher doesn't re-import everything).
 */
import { listNestedSubfolder, isSourceConnected } from './file-access.js';
import { parseJoyiFile, importJoyiToDb } from './import.js';
import { getConfig } from './db.js';
import { showToast } from './utils.js';
import { broadcastChange } from './app.js';

const STORAGE_KEY = 'rdms-joyi-watch-enabled';
const DEFAULT_INTERVAL_MS = 5000;

let intervalId = null;
let seenMtimes = new Map(); // filename → lastModified epoch
let folderPath = null;       // resolved path string for UI
let onTick = null;           // optional UI callback (lastScan, importedCount, error)
let lastError = null;
let lastScanAt = null;
let importedSinceStart = 0;
let scanInFlight = false;    // re-entrancy guard
let bootstrapDone = false;   // first scan only records mtimes

/**
 * Build the path to scan. Prefers an explicit config.shared_joyi_folder
 * (relative to source root) but defaults to "80 Shared/{ref}_Joyi".
 */
async function resolveFolderPath() {
  const config = await getConfig();
  const explicit = (config?.shared_joyi_folder || '').trim();
  if (explicit) return explicit;
  const ref = config?.event_short_ref || 'RDMS';
  return `80 Shared/${ref}_Joyi`;
}

export function isJoyiWatchEnabled() {
  return localStorage.getItem(STORAGE_KEY) === '1';
}

export function getJoyiWatchStatus() {
  return {
    enabled: !!intervalId,
    folderPath,
    lastScanAt,
    lastError,
    importedSinceStart,
    knownFiles: seenMtimes.size,
  };
}

/**
 * Start the watch loop.
 * @param {function} [statusCallback] - called after every scan tick
 * @param {number} [intervalMs] - poll interval (defaults to 5s)
 */
export async function startJoyiWatch(statusCallback, intervalMs = DEFAULT_INTERVAL_MS) {
  if (intervalId) return; // already running
  if (!isSourceConnected()) {
    showToast('Connect the source folder first (folder icon in navbar)', 'warning');
    return;
  }
  onTick = statusCallback || null;
  folderPath = await resolveFolderPath();
  seenMtimes = new Map();
  importedSinceStart = 0;
  lastError = null;
  bootstrapDone = false;
  localStorage.setItem(STORAGE_KEY, '1');
  // Run an immediate scan, then schedule.
  await scanOnce();
  intervalId = setInterval(scanOnce, intervalMs);
  showToast(`Joyi auto-import watching ${folderPath}`, 'info', 3000);
}

export function stopJoyiWatch() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  localStorage.removeItem(STORAGE_KEY);
  onTick = null;
}

async function scanOnce() {
  if (scanInFlight) return; // skip if previous tick still importing
  scanInFlight = true;
  try {
    const handles = await listNestedSubfolder(folderPath);
    const xls = handles.filter(h => /\.xlsx?$/i.test(h.name));

    if (!bootstrapDone) {
      // Record current mtimes without importing — avoids re-importing every
      // file the first time the watcher starts on an already-populated folder.
      for (const fh of xls) {
        try {
          const f = await fh.getFile();
          seenMtimes.set(fh.name, f.lastModified);
        } catch { /* ignore individual file errors */ }
      }
      bootstrapDone = true;
      lastScanAt = new Date().toISOString();
      lastError = null;
      if (onTick) onTick(getJoyiWatchStatus());
      return;
    }

    // Look for new or modified files.
    const toImport = [];
    for (const fh of xls) {
      const f = await fh.getFile();
      const seen = seenMtimes.get(fh.name);
      if (seen == null || f.lastModified > seen) {
        toImport.push({ handle: fh, file: f });
      }
    }

    for (const { handle, file } of toImport) {
      try {
        const parsed = await parseJoyiFile(file);
        await importJoyiToDb(parsed);
        seenMtimes.set(handle.name, file.lastModified);
        importedSinceStart++;
        broadcastChange('race-updated', { race_number: parsed?.raceNumber });
        showToast(`Auto-imported Joyi: ${handle.name} → Race ${parsed?.raceNumber ?? '?'}`, 'success', 4000);
      } catch (err) {
        // Don't keep retrying a bad file: record the mtime so we move on.
        seenMtimes.set(handle.name, file.lastModified);
        showToast(`Joyi import failed (${handle.name}): ${err.message}`, 'error', 5000);
      }
    }

    lastScanAt = new Date().toISOString();
    lastError = null;
  } catch (err) {
    lastError = err.message || String(err);
  } finally {
    scanInFlight = false;
    if (onTick) onTick(getJoyiWatchStatus());
  }
}
