/**
 * SDBA RDMS — Auto Backup
 * Saves full database snapshot as JSON to the configured backup folder
 * (source_folder/20 Database Backup/) using File System Access API.
 * Falls back to browser download if API unavailable or permission denied.
 * Triggered after: (1) initial setup/import complete, (2) every race export.
 */
import { db } from './db.js';
import { showToast } from './utils.js';
import { writeToSourceSubfolder, downloadFallback } from './file-access.js';

const TABLE_NAMES = [
  'config', 'races', 'lane_results', 'timesheet',
  'divisions', 'division_rounds', 'division_progressions',
  'race_relationships', 'sync_queue', 'import_log',
];


/**
 * Create a full database backup.
 * Tries to write to backup folder first, falls back to download.
 * @param {string} trigger - What triggered the backup (for filename)
 */
export async function autoBackup(trigger = 'manual') {
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

  // Write to 20 Database Backup/ subfolder (auto-created if missing)
  const written = await writeToSourceSubfolder('20 Database Backup', filename, jsonStr);

  if (written) {
    showToast(`Backup saved: ${filename}`, 'info', 2000);
  } else {
    downloadFallback(filename, jsonStr);
    showToast(`Backup downloaded: ${filename}`, 'info', 2000);
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
