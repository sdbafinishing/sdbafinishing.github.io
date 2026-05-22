/**
 * SDBA RDMS — Draw Folder Watch
 *
 * Polls `01 Input_Draw/` for new or modified `.xls` / `.xlsx` files and
 * auto-imports them. Mirrors joyi-watch.js — same backend selection
 * (Drive API preferred, falls back to local File System Access), same
 * bootstrap-then-watch pattern, same per-tick re-entrancy guard.
 *
 * Use case: RMS pushes a revised draw (or a brand-new Round-2 file) via
 * Drive-for-Desktop sync mid-event. Without this watcher the operator
 * has to spot the change manually and click "Import all from 01" again.
 *
 * Persistence: lastModified per filename is held in memory only. On the
 * first scan after start(), files are recorded but NOT re-imported (so
 * re-enabling the watcher doesn't re-process every file in the folder).
 *
 * Side effects: a successful import broadcasts `draw-imported` so the
 * dashboard + schedule + flowchart audit refresh in place. If the user's
 * config has `auto_start_list_on_import` enabled, that hook fires too —
 * matches the manual Im/Export import path.
 */
import { listSourceSubfolder, isSourceConnected } from './file-access.js';
import { isDriveApiConnected, listDriveFiles, readDriveFile } from './drive-api.js';
import { parseDrawFile, importDrawToDb } from './import.js';
import { getConfig } from './db.js';
import { showToast } from './utils.js';
import { broadcastChange } from './app.js';
import { generateJoyiStartList } from './startlist.js';

const STORAGE_KEY = 'rdms-draw-watch-enabled';
const DEFAULT_INTERVAL_MS = 8000; // slightly slower than Joyi — draws don't change as often
const LOCAL_SUBFOLDER = '01 Input_Draw';
const SHARED_SUBFOLDER_RE = /\.(xlsx?)$/i; // accepts .xls and .xlsx

let intervalId = null;
// seenMtimes is keyed by:
//   local mode: filename → lastModified epoch (number)
//   drive mode: file.id  → modifiedTime ISO string
let seenMtimes = new Map();
let folderPath = null;
let onTick = null;
let lastError = null;
let lastScanAt = null;
let importedSinceStart = 0;
let scanInFlight = false;
let bootstrapDone = false;
let backend = 'local';
let intervalMsActive = DEFAULT_INTERVAL_MS;

export function isDrawWatchEnabled() {
  return localStorage.getItem(STORAGE_KEY) === '1';
}

export function getDrawWatchStatus() {
  return {
    enabled: !!intervalId,
    backend,
    folderPath,
    lastScanAt,
    lastError,
    importedSinceStart,
    knownFiles: seenMtimes.size,
  };
}

/**
 * Start the watch loop. Returns silently if already running.
 *
 * Backend selection at start time: Drive if a token is present (no local
 * sync delay), else the connected source folder. If neither is available
 * we toast + bail rather than queuing.
 *
 * @param {function} [statusCallback] - called after every scan tick
 * @param {number} [intervalMs]
 */
export async function startDrawWatch(statusCallback, intervalMs = DEFAULT_INTERVAL_MS) {
  if (intervalId) return;
  if (isDriveApiConnected()) {
    backend = 'drive';
  } else if (isSourceConnected()) {
    backend = 'local';
  } else {
    showToast('Connect Drive or source folder first (top-right folder icon).', 'warning', 4500);
    return;
  }
  onTick = statusCallback || null;
  folderPath = LOCAL_SUBFOLDER;
  seenMtimes = new Map();
  importedSinceStart = 0;
  lastError = null;
  bootstrapDone = false;
  intervalMsActive = intervalMs;
  localStorage.setItem(STORAGE_KEY, '1');
  await scanOnce();
  intervalId = setInterval(scanOnce, intervalMs);
  showToast(`Draw auto-import (${backend}) watching ${folderPath}`, 'info', 3000);
}

export function stopDrawWatch() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  localStorage.removeItem(STORAGE_KEY);
  onTick = null;
}

async function scanOnce() {
  if (scanInFlight) return;
  scanInFlight = true;
  try {
    const candidates = backend === 'drive'
      ? await listDriveCandidates(folderPath)
      : await listLocalCandidates(folderPath);

    if (!bootstrapDone) {
      // First scan — record state without importing so the operator can
      // start watching mid-event without re-processing yesterday's files.
      for (const c of candidates) seenMtimes.set(c.key, c.mtime);
      bootstrapDone = true;
      lastScanAt = new Date().toISOString();
      lastError = null;
      if (onTick) onTick(getDrawWatchStatus());
      return;
    }

    const toImport = candidates.filter(c => {
      const seen = seenMtimes.get(c.key);
      return seen == null || isNewer(c.mtime, seen);
    });

    let anyImported = false;
    for (const c of toImport) {
      try {
        const file = await c.getFile();
        const parsed = await parseDrawFile(file);
        await importDrawToDb(parsed);
        seenMtimes.set(c.key, c.mtime);
        importedSinceStart++;
        anyImported = true;
        showToast(
          `Auto-imported draw (${backend}): ${c.name} → Race ${parsed.raceNumber}`,
          'success', 3500);
      } catch (err) {
        // Don't keep retrying a malformed file — record the mtime so we
        // skip it on the next pass. Surface the error so the operator
        // can investigate.
        seenMtimes.set(c.key, c.mtime);
        const msg = err?.message || String(err);
        showToast(`Draw auto-import failed (${c.name}): ${msg}`, 'error', 5000);
      }
    }

    // If anything imported, broadcast + optionally regenerate the Joyi
    // start list (same downstream side-effects as the manual Import flow).
    if (anyImported) {
      broadcastChange('draw-imported');
      try {
        const cfg = await getConfig();
        if (cfg?.auto_start_list_on_import) {
          await generateJoyiStartList();
        }
      } catch (err) {
        console.warn('Draw watch: start list regen failed', err);
      }
    }

    lastScanAt = new Date().toISOString();
    lastError = null;
  } catch (err) {
    lastError = err?.message || String(err);
  } finally {
    scanInFlight = false;
    if (onTick) onTick(getDrawWatchStatus());
  }
}

// File System Access path: returns candidates with filename keys + ms mtimes.
async function listLocalCandidates(subfolder) {
  const handles = await listSourceSubfolder(subfolder);
  // Accept both .xls and .xlsx — same set the manual import flow takes.
  const filtered = handles.filter(h => SHARED_SUBFOLDER_RE.test(h.name));
  const out = [];
  for (const h of filtered) {
    try {
      const f = await h.getFile();
      out.push({
        key: h.name,
        name: h.name,
        mtime: f.lastModified,
        getFile: async () => f,
      });
    } catch { /* skip individual errors */ }
  }
  return out;
}

// Drive API path: returns candidates with Drive file id keys + ISO mtimes.
async function listDriveCandidates(subfolder) {
  const files = await listDriveFiles(subfolder);
  return files
    .filter(f => SHARED_SUBFOLDER_RE.test(f.name))
    .map(f => ({
      key: f.id,
      name: f.name,
      mtime: f.modifiedTime,
      getFile: async () => {
        const buf = await readDriveFile(f.id);
        return new File([buf], f.name);
      },
    }));
}

function isNewer(a, b) {
  // Numbers (epoch ms) for local, ISO strings for Drive. Both compare
  // correctly with >.
  return a > b;
}
