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
import { isDriveApiConnected, listDriveFiles, readDriveFile, readDriveFileRange } from './drive-api.js';
import { parseJoyiFile, parseJoyiAnyFile, importJoyiToDb, deriveJoyiStartTime, setJoyiStartTimeOnRace } from './import.js';
import { getConfig } from './db.js';
import { showToast } from './utils.js';
import { broadcastChange } from './app.js';
import { notifyResultEntryStarted } from './next-race-signal.js';
import { enqueueLcdFetch } from './joyi-lcd-pending.js';

const STORAGE_KEY = 'rdms-joyi-watch-enabled';
const DEFAULT_INTERVAL_MS = 5000;

let intervalId = null;
// seenMtimes is keyed by:
//   local mode: filename → lastModified epoch (number)
//   drive mode: file.id  → modifiedTime ISO string
// Mixed-mode is not supported (we resolve which backend at start()).
let seenMtimes = new Map();
let folderPath = null;       // resolved path string for UI
let onTick = null;           // optional UI callback (lastScan, importedCount, error)
let lastError = null;
let lastScanAt = null;
let importedSinceStart = 0;
let scanInFlight = false;    // re-entrancy guard
let bootstrapDone = false;   // first scan only records mtimes
let backend = 'local';       // 'local' (FS Access) | 'drive' (Drive API)

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

// "Enabled" = the operator's persisted intent. Survives reloads via
// localStorage. Use this to auto-restart the watcher on boot.
export function isJoyiWatchEnabled() {
  return localStorage.getItem(STORAGE_KEY) === '1';
}

// "Running" = the setInterval is actually active in THIS page session.
// Use this for UI state (modal labels, "already running" indicators)
// — the intent flag persists across reloads but the timer doesn't.
export function isJoyiWatchRunning() {
  return intervalId != null;
}

export function getJoyiWatchStatus() {
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
 * Start the watch loop.
 *
 * Backend selection: prefers Drive (faster — no local FS sync delay) if a
 * Drive token is present; falls back to the connected source folder. If
 * neither is available, surfaces a toast and bails.
 *
 * @param {function} [statusCallback] - called after every scan tick
 * @param {number} [intervalMs] - poll interval (defaults to 5s)
 */
export async function startJoyiWatch(statusCallback, intervalMs = DEFAULT_INTERVAL_MS) {
  if (intervalId) return; // already running
  // Backend selection. Drive API path is feature-flagged via
  // `config.drive_polling_enabled` — currently defaulting to OFF
  // because the OAuth scope + folder access path needs more shaking
  // out. Operators stay on local FS polling unless they explicitly
  // opt in (Setup → Event → Google Drive API → "Enable Drive
  // polling" checkbox).
  const cfg = await getConfig();
  const drivePollingEnabled = !!cfg?.drive_polling_enabled;
  if (drivePollingEnabled && isDriveApiConnected()) {
    backend = 'drive';
  } else if (isSourceConnected()) {
    backend = 'local';
  } else {
    showToast('Connect the source folder first (top-right folder icon).', 'warning');
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
  showToast(`Joyi auto-import (${backend}) watching ${folderPath}`, 'info', 3000);
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
    // Each backend returns a list of {key, mtime, getFile} entries — `key`
    // is filename (local) or Drive file id (drive); both stay stable across
    // ticks. getFile() returns a File object on demand so we only pay the
    // download cost on actual changes.
    const candidates = backend === 'drive'
      ? await listDriveCandidates(folderPath)
      : await listLocalCandidates(folderPath);

    if (!bootstrapDone) {
      // Record current mtimes without importing — avoids re-importing every
      // file the first time the watcher starts on an already-populated folder.
      for (const c of candidates) seenMtimes.set(c.key, c.mtime);
      bootstrapDone = true;
      lastScanAt = new Date().toISOString();
      lastError = null;
      // Diagnostic: if the bootstrap saw zero candidates, the configured
      // folder is empty OR mis-pathed. Surface a hint so the operator
      // doesn't wait for files that will never arrive.
      if (candidates.length === 0) {
        showToast(
          `Joyi watcher: 0 files found in ${backend === 'drive' ? 'Drive folder' : 'local folder'} "${folderPath}". ` +
          `Check Setup → Shared Joyi Folder uses a RELATIVE path under your event folder (e.g. "80 Shared/2026TN_Joyi"), not an absolute filesystem path.`,
          'warning', 8000);
      }
      if (onTick) onTick(getJoyiWatchStatus());
      return;
    }

    const toImport = candidates.filter(c => {
      const seen = seenMtimes.get(c.key);
      return seen == null || isNewer(c.mtime, seen);
    });

    for (const c of toImport) {
      try {
        const isLcd = /\.lcd$/i.test(c.name);
        if (isLcd) {
          // .lcd files often land LATER than the .xls / .jyd because they
          // are much larger. Process independently — derive
          // joyi_start_time from the file and stamp it on the race even
          // if the results were already imported earlier. Tolerant of
          // races we haven't imported results for yet (the start time is
          // still useful when results arrive shortly after).
          const raceNumber = extractRaceNumberFromLcd(c.name);
          if (!Number.isInteger(raceNumber)) {
            // Filename didn't match {ref}.{N}.lcd — mark seen so we
            // don't keep retrying.
            seenMtimes.set(c.key, c.mtime);
            continue;
          }
          const file = await c.getFile();
          const iso = await deriveJoyiStartTime(file);
          if (iso) {
            await setJoyiStartTimeOnRace(raceNumber, iso);
            broadcastChange('race-updated', { race_number: raceNumber, joyi_start: true });
            showToast(`Auto-derived Joyi start (${backend}): ${c.name} → Race ${raceNumber}`, 'info', 3500);
          }
          // Whether iso came out null or not, record the mtime so we
          // don't redo the same file on the next tick. A later
          // file modification (Joyi re-export) would change the mtime
          // and trigger another derive.
          seenMtimes.set(c.key, c.mtime);
          continue;
        }

        const file = await c.getFile();
        // parseJoyiAnyFile picks the right parser by extension — supports
        // both .xls(x) and .jyd that may live in the Joyi folder.
        const parsed = await parseJoyiAnyFile(file);
        // Auto-watch never silently overwrites manually-entered times.
        // skipIfHasUserData returns early with skipped=true when the
        // operator has typed in any lane and the race isn't already a
        // Joyi import. The toast tells them to apply manually from the
        // race page if they want to overwrite.
        const result = await importJoyiToDb(parsed, { skipIfHasUserData: true });
        if (result.skipped) {
          seenMtimes.set(c.key, c.mtime); // don't loop on the same file
          showToast(
            `Joyi (${c.name}) → Race ${parsed?.raceNumber ?? '?'} has manual times — skipped. ` +
            `Use Race page → Import Joyi to overwrite.`,
            'warning', 6000);
          continue;
        }
        seenMtimes.set(c.key, c.mtime);
        importedSinceStart++;
        broadcastChange('race-updated', { race_number: parsed?.raceNumber });
        if (parsed?.raceNumber) {
          notifyResultEntryStarted(parsed.raceNumber).catch(() => {});
          // Best-effort kick of the lazy LCD fetch in case the sibling
          // is ALREADY in the folder. If it isn't yet, this scan loop
          // will pick it up later when its mtime appears in the
          // candidates list (.lcd files often arrive after the .xls /
          // .jyd because they're much bigger).
          enqueueLcdFetch(parsed.raceNumber);
        }
        showToast(`Auto-imported Joyi (${backend}): ${c.name} → Race ${parsed?.raceNumber ?? '?'}`, 'success', 4000);
      } catch (err) {
        // Don't keep retrying a bad file: record the mtime so we move on.
        seenMtimes.set(c.key, c.mtime);
        showToast(`Joyi import failed (${c.name}): ${err.message}`, 'error', 5000);
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

// File System Access path: returns candidates with filename keys + ms mtimes.
// Joyi result filenames look like "{ref}.{N}.xls". RDMS exports its own
// start list to the SAME folder under names like "Joyi_StartList_*.xls"
// — those must never be picked up by the result watcher (they'd parse
// as junk results and clobber a real race). We also defend against
// SprintTimer outputs ("SprintTimer_*") and any "startlist" pattern.
const EXCLUDE_NAME_RE = /(startlist|sprinttimer)/i;

async function listLocalCandidates(path) {
  const handles = await listNestedSubfolder(path);
  // Watch all formats we care about: result files (.xls/.xlsx/.jyd) and
  // start-time files (.lcd). .lcd is typically much larger so it tends
  // to land after the results — the scan loop picks it up later and
  // populates joyi_start_time once it appears.
  const filtered = handles.filter(h =>
    /\.(xlsx?|jyd|lcd)$/i.test(h.name) && !EXCLUDE_NAME_RE.test(h.name)
  );
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
async function listDriveCandidates(path) {
  const files = await listDriveFiles(path);
  return files
    .filter(f => /\.(xlsx?|jyd|lcd)$/i.test(f.name) && !EXCLUDE_NAME_RE.test(f.name))
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

// Parse "{event_ref}.{race_number}.lcd" → race_number. Whitespace-tolerant
// in the prefix (Joyi sometimes writes "2026 WU.7.lcd" instead of
// "2026WU.7.lcd"). Returns NaN when the filename doesn't match.
function extractRaceNumberFromLcd(filename) {
  if (!filename) return NaN;
  const m = String(filename).match(/\.(\d+)\.lcd$/i);
  if (!m) return NaN;
  return parseInt(m[1], 10);
}

function isNewer(a, b) {
  // Both backends produce comparable values: numbers (epoch ms) for local,
  // ISO strings for Drive. The same type is used on each side per session,
  // so a direct > comparison works for both.
  return a > b;
}
