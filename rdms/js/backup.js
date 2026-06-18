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
import { isDriveApiConnected, writeDriveFile } from './drive-api.js';

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
  // Local timestamp in `YYYY-MM-DD-HH-MM-SS` form. We do this manually
  // rather than via toISOString() because that returns UTC, which on a
  // race day in HK reads back 8 hours behind wall-clock — confusing
  // when comparing backup filenames against the actual event timeline.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const localTs =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  // ISO-ish local string for the meta field (kept human-readable; not
  // a true ISO 8601 UTC stamp anymore). Restore code only displays this
  // back to the operator, so format choice is fine.
  const localIso =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  backup._meta = {
    exported_at: localIso,
    trigger,
    version: 1,
    app: 'sdba-rdms',
  };

  const config = backup.config?.[0];
  const eventRef = config?.event_short_ref || 'RDMS';
  const filename = `rdms_backup_${eventRef}_${trigger}_${localTs}.json`;
  const jsonStr = JSON.stringify(backup);

  // Write target priority:
  //   1. Local FS handle if connected → 20 Database Backup/ via FS Access.
  //   2. Drive API if connected → 20 Database Backup/ via Drive REST.
  //   3. Manual trigger: browser download fallback.
  //   4. Automatic trigger with nothing connected: skip silently (avoid
  //      popping a folder picker mid-import).
  const isManual      = trigger === 'manual';
  const localConn     = isSourceConnected();
  const driveConn     = isDriveApiConnected();
  const anyConnected  = localConn || driveConn;

  if (!anyConnected && !isManual) {
    if (!opts.silent) {
      showToast(
        `Auto-backup skipped (no folder connected). Use DB Admin → Backup to download a copy.`,
        'info', 3500);
    }
    return null;
  }

  let written = false;
  let backend = null;
  if (localConn) {
    written = await writeToSourceSubfolder('20 Database Backup', filename, jsonStr);
    if (written) backend = 'local';
  }
  if (!written && driveConn) {
    // Drive API write — operator opted into Drive backend explicitly
    // via Setup → Google Drive API. Backups land in the same
    // "20 Database Backup" subfolder of the event's Drive folder
    // (the folder ID configured in drive_source_folder_id).
    try {
      written = await writeDriveFile('20 Database Backup', filename, jsonStr, 'application/json');
      if (written) backend = 'drive';
    } catch (err) {
      console.warn('Drive backup write failed:', err);
    }
  }

  if (written) {
    if (!opts.silent) {
      const where = backend === 'drive' ? 'Drive' : 'event folder';
      showToast(`Backup saved to ${where}: ${filename}`, 'info', 2000);
    }
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

/**
 * Backup after a race is SENT. Without this, the only backups are taken right
 * after export — before send_time is written — so the send is captured only by
 * the NEXT race's export-backup. The LAST race of an event has no next export,
 * so its send_time would never make it into any backup; restoring the
 * end-of-day backup then shows the final race "exported but not sent".
 * @param {number} raceNumber
 */
export async function backupAfterSend(raceNumber) {
  return autoBackup(`R${raceNumber}_send`, { silent: true });
}
