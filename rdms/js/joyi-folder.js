/**
 * SDBA RDMS — Joyi Folder Helpers
 *
 * Locate the Joyi triplet (.lcd / .jyd / .xls) for a given race by walking
 * either the connected source folder (File System Access API) or the
 * configured Google Drive folder. Used by the photo-finish picker to skip
 * the manual file dialog when the files exist in the standard location.
 *
 * Naming convention (per the user guide):
 *   {event_short_ref}.{race_number}.{lcd|jyd|xls}
 *   e.g. 2025TN.50.lcd, 2025TN.50.jyd
 *
 * Folder convention:
 *   <source>/80 Shared/{event_short_ref}_Joyi/
 *
 * Both paths fall back to null if nothing matches. The Drive path requires
 * an already-authed token (initDriveApi + requestDriveAccess) — we do not
 * pop the consent flow inside the photo-finish hot path.
 */
import { getConfig } from './db.js';
import { listNestedSubfolder, isSourceConnected } from './file-access.js';
import { isDriveApiConnected, listDriveFiles, readDriveFile, readDriveFileRange } from './drive-api.js';

/**
 * Build the standard Joyi folder path for the current event.
 */
async function resolveJoyiFolderPath() {
  const config = await getConfig();
  const explicit = (config?.shared_joyi_folder || '').trim();
  if (explicit) return explicit;
  const ref = config?.event_short_ref || 'RDMS';
  return `80 Shared/${ref}_Joyi`;
}

/**
 * Filename basename for a race in the Joyi folder.
 * @returns {string|null} e.g. "2025TN.50" — or null if no event_short_ref.
 */
async function resolveBasename(raceNumber) {
  const config = await getConfig();
  const ref = (config?.event_short_ref || '').trim();
  if (!ref) return null;
  return `${ref}.${raceNumber}`;
}

/**
 * Whitespace-insensitive match against `{basename}.{ext}`. Joyi has been
 * observed to write filenames with a stray space in the prefix
 * (`2026 WU.10.lcd` vs `2026WU.10.lcd`) — likely a UI typo on the
 * capture machine — but the .lcd / .jyd / .xls in the SAME race share
 * whatever the prefix is, so a normalised comparison still uniquely
 * identifies the race.
 */
function fileMatchesRace(filename, basename, ext) {
  const norm = (s) => String(s).replace(/\s+/g, '').toLowerCase();
  const target = norm(`${basename}.${ext}`);
  return norm(filename) === target;
}
function fileMatchesRaceAnyXlsExt(filename, basename) {
  return fileMatchesRace(filename, basename, 'xls') || fileMatchesRace(filename, basename, 'xlsx');
}

/**
 * Try the File System Access path. Returns { lcd, jyd, xls } as File objects
 * (or nulls if any are missing). Returns null if the source folder isn't
 * connected at all.
 */
async function findFromLocalFolder(folderPath, basename) {
  if (!isSourceConnected()) return null;
  const handles = await listNestedSubfolder(folderPath);
  if (!handles || handles.length === 0) return { lcd: null, jyd: null, xls: null };

  const found = { lcd: null, jyd: null, xls: null };
  for (const h of handles) {
    if (!found.lcd && fileMatchesRace(h.name, basename, 'lcd')) {
      try { found.lcd = await h.getFile(); } catch { /* skip */ }
    } else if (!found.jyd && fileMatchesRace(h.name, basename, 'jyd')) {
      try { found.jyd = await h.getFile(); } catch { /* skip */ }
    } else if (!found.xls && fileMatchesRaceAnyXlsExt(h.name, basename)) {
      try { found.xls = await h.getFile(); } catch { /* skip */ }
    }
  }
  return found;
}

/**
 * Try the Drive API path. Returns { lcd, jyd, xls } as File objects (built
 * from downloaded ArrayBuffers) or null if Drive isn't authed.
 */
async function findFromDrive(folderPath, basename) {
  if (!isDriveApiConnected()) return null;
  const files = await listDriveFiles(folderPath);
  if (!files || files.length === 0) return { lcd: null, jyd: null, xls: null };

  const found = { lcd: null, jyd: null, xls: null };
  for (const f of files) {
    let kind = null;
    if (!found.lcd && fileMatchesRace(f.name, basename, 'lcd')) kind = 'lcd';
    else if (!found.jyd && fileMatchesRace(f.name, basename, 'jyd')) kind = 'jyd';
    else if (!found.xls && fileMatchesRaceAnyXlsExt(f.name, basename)) kind = 'xls';
    if (!kind) continue;
    try {
      const buf = await readDriveFile(f.id);
      // Wrap as a File so downstream code (parseLcdHeader / parseJydFile)
      // can call .arrayBuffer() / .text() uniformly with the local path.
      found[kind] = new File([buf], f.name);
    } catch { /* skip — caller falls back to manual picker */ }
  }
  return found;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find the Joyi triplet for a race, trying local folder then Drive.
 *
 * Result shape:
 *   { lcd: File|null, jyd: File|null, xls: File|null, source: 'local'|'drive'|'none' }
 *
 * source='none' means neither path is connected or the folder is empty.
 * source='local'/'drive' means at least one of {lcd, jyd, xls} was found
 * (caller should still check which fields are non-null).
 */
export async function findJoyiTripletForRace(raceNumber) {
  const folderPath = await resolveJoyiFolderPath();
  const basename = await resolveBasename(raceNumber);
  if (!basename) return { lcd: null, jyd: null, xls: null, source: 'none' };

  const local = await findFromLocalFolder(folderPath, basename);
  if (local && (local.lcd || local.jyd || local.xls)) {
    return { ...local, source: 'local', folderPath };
  }

  const drive = await findFromDrive(folderPath, basename);
  if (drive && (drive.lcd || drive.jyd || drive.xls)) {
    return { ...drive, source: 'drive', folderPath };
  }

  return { lcd: null, jyd: null, xls: null, source: 'none', folderPath };
}

/**
 * Lazy / cheap start-time derivation. Locates the `.lcd` for a race and
 * pulls just the header + last-scanline timestamp instead of downloading
 * the full 100-300 MB image.
 *
 * Resolution path:
 *   - Drive: HTTP Range requests on the file id (~30 bytes downloaded).
 *   - Local: File.slice() on the handle's File object (kernel reads only
 *     the needed pages).
 *
 * Returns ISO start-time string or null when the file is missing / empty.
 *
 * @param {number} raceNumber
 */
export async function deriveJoyiStartTimeForRace(raceNumber) {
  const folderPath = await resolveJoyiFolderPath();
  const basename = await resolveBasename(raceNumber);
  if (!basename) return null;
  const matchLcd = (name) => fileMatchesRace(name, basename, 'lcd');

  // Drive path (preferred — no local sync delay).
  if (isDriveApiConnected()) {
    const files = await listDriveFiles(folderPath);
    const lcdMeta = files.find(f => matchLcd(f.name));
    if (lcdMeta) {
      const startIso = await deriveStartFromDriveLcd(lcdMeta);
      if (startIso) return startIso;
    }
  }

  // Local FS path. Reuse the existing folder-walk + File handle.
  if (isSourceConnected()) {
    const handles = await listNestedSubfolder(folderPath);
    const h = handles.find(x => matchLcd(x.name));
    if (h) {
      try {
        const file = await h.getFile();
        const { deriveJoyiStartTime } = await import('./import.js');
        return await deriveJoyiStartTime(file);
      } catch { /* ignore */ }
    }
  }

  return null;
}

/**
 * Derive race-start from a Drive file metadata object using two byte-range
 * reads. Mirrors the deriveJoyiStartTime logic in import.js but works
 * against Drive's HTTP Range support instead of File.slice().
 */
async function deriveStartFromDriveLcd(meta) {
  const size = Number(meta.size);
  if (!Number.isFinite(size) || size < 24 + 2168) return null;

  // 1) Read the 24-byte LCD header.
  const headBuf = await readDriveFileRange(meta.id, 0, 23);
  if (headBuf.byteLength < 24) return null;
  const headView = new DataView(headBuf);
  const magic = String.fromCharCode(headView.getUint8(0), headView.getUint8(1), headView.getUint8(2), headView.getUint8(3));
  if (magic !== 'JLIF') return null;
  const storageCols = headView.getUint32(12, true);
  const headerBytes = headView.getUint32(20, true);
  if (!storageCols || !headerBytes) return null;

  // 2) Compute the last scanline's offset + read its first 4 bytes.
  const dataBytes = size - headerBytes;
  const storageRows = Math.floor(dataBytes / storageCols);
  if (storageRows < 2) return null;
  const lastOffset = headerBytes + (storageRows - 1) * storageCols;
  const lastBuf = await readDriveFileRange(meta.id, lastOffset, lastOffset + 3);
  if (lastBuf.byteLength < 4) return null;
  const lastTsUs = new DataView(lastBuf).getUint32(0, true);
  if (!lastTsUs) return null;

  // 3) Drive's modifiedTime is the authoritative mtime for our purposes.
  // Per the validation against TestRace2/3, it equals the moment Joyi
  // closed the file (Save click moment).
  const mtimeMs = Date.parse(meta.modifiedTime);
  if (!Number.isFinite(mtimeMs)) return null;
  const predictedMs = mtimeMs - Math.round(lastTsUs / 1000);
  if (Math.abs(mtimeMs - predictedMs) > 86_400_000) return null;
  return new Date(predictedMs).toISOString();
}
