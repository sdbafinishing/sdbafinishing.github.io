/**
 * SDBA RDMS — Auto Backup
 * Saves full database snapshot as JSON to the configured backup folder
 * (source_folder/20 Database Backup/) using File System Access API.
 * Falls back to browser download if API unavailable or permission denied.
 * Triggered after: (1) initial setup/import complete, (2) every race export.
 */
import { db } from './db.js';
import { showToast } from './utils.js';
import { writeToSourceSubfolder, downloadFallback, isSourceConnected } from './file-access.js';

const TABLE_NAMES = [
  'config', 'races', 'lane_results', 'timesheet',
  'divisions', 'division_rounds', 'division_progressions',
  'race_relationships', 'sync_queue', 'import_log',
];


/**
 * Create a full database backup.
 * Tries to write to backup folder first, falls back to download — but only
 * when the folder is already connected. We don't pop a folder picker mid-
 * import (that surprised operators after drag-and-drop), so an unconnected
 * source folder + non-manual trigger results in a quiet "skipped" outcome.
 * @param {string} trigger - What triggered the backup (for filename)
 * @param {{silent?: boolean}} [opts] - silent: skip toasts (default false)
 */
export async function autoBackup(trigger = 'manual', opts = {}) {
  const backup = {};
  for (const table of TABLE_NAMES) {
    backup[table] = await db[table].toArray();
  }
  backup._meta = {
    exported_at: new Date().toISOString(),
    trigger,
    version: 1,
    app: 'sdba-rdms',
  };

  const config = backup.config?.[0];
  const eventRef = config?.event_short_ref || 'RDMS';
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  const filename = `rdms_backup_${eventRef}_${trigger}_${timestamp}.json`;
  const jsonStr = JSON.stringify(backup);

  // Skip the disk write when no folder is connected — popping a picker
  // here interrupts whatever the operator was doing. The browser-download
  // fallback IS still ok for explicit manual backups; we only suppress it
  // for automatic triggers (setup-complete, R*_export).
  const isManual  = trigger === 'manual';
  const connected = isSourceConnected();
  if (!connected && !isManual) {
    if (!opts.silent) {
      showToast(
        `Auto-backup skipped (no event folder connected). Use DB Admin → Backup to download a copy.`,
        'info', 3500);
    }
    return null;
  }

  const written = connected
    ? await writeToSourceSubfolder('20 Database Backup', filename, jsonStr)
    : false;

  if (written) {
    if (!opts.silent) showToast(`Backup saved: ${filename}`, 'info', 2000);
  } else if (isManual) {
    // Only fall through to browser-download for explicit manual triggers.
    downloadFallback(filename, jsonStr);
    if (!opts.silent) showToast(`Backup downloaded: ${filename}`, 'info', 2000);
  } else {
    if (!opts.silent) {
      showToast(`Auto-backup write failed — folder may be read-only.`, 'warning', 4000);
    }
    return null;
  }

  return filename;
}

/**
 * Backup after initial setup is complete (draws imported, start lists generated).
 */
export async function backupAfterSetup() {
  return autoBackup('setup-complete');
}

/**
 * Backup after a race is exported.
 * @param {number} raceNumber
 */
export async function backupAfterExport(raceNumber) {
  return autoBackup(`R${raceNumber}_export`);
}
