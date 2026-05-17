/**
 * SDBA RDMS — File System Access
 * Centralized folder access using File System Access API (Chrome/Edge).
 * Requests permission to the source folder once per session,
 * then reads/writes to subfolders (01, 02, 03, 04, 10) without prompts.
 *
 * Subfolders:
 * Master folder structure (all under source_folder):
 *   00 Source Files/               — raw source materials dump
 *   01 Input_Draw/                 — draw sheet .xls files (read)
 *   11 Output_Start Lists/         — generated start lists (write, local copy)
 *   12 Output_Results/             — exported results (write, local copy)
 *   13 Output_Next Round Draws/    — next round draws (write, local copy)
 *   20 Database Backup/            — auto-backup JSON files (write)
 *   99 Reference (DO NOT EDIT)/    — Joyi/SprintTimer templates
 *   80 Shared/                     — shared externally via Drive links
 *     {ref}/                       — general shared area
 *     {ref}_Joyi/                  — bidirectional: start lists out, Joyi results in
 *     {ref}_Output_Results/        — results (public link, = WhatsApp link)
 *     {ref}_Next_Round_Draws/      — optional shared draws
 *
 * Subfolders are auto-created if they don't exist ({ create: true }).
 */
import { showToast } from './utils.js';

// Cached directory handles
let sourceDirHandle = null;      // root source folder
let driveDirHandle = null;       // Google Drive share folder (optional, separate root)
const subDirCache = {};          // subfolder handles cache

/**
 * Check if File System Access API is available.
 */
export function isFileAccessSupported() {
  return 'showDirectoryPicker' in window;
}

/**
 * Request access to the source folder.
 * Only prompts if not already granted in this session.
 * @returns {FileSystemDirectoryHandle|null}
 */
export async function requestSourceFolder() {
  if (sourceDirHandle) return sourceDirHandle;

  if (!isFileAccessSupported()) {
    showToast('File System Access not supported in this browser. Use Chrome or Edge.', 'warning', 5000);
    return null;
  }

  try {
    sourceDirHandle = await window.showDirectoryPicker({
      id: 'rdms-source',
      mode: 'readwrite',
      startIn: 'documents',
    });
    subDirCache.source = {};
    showToast(`Source folder connected: ${sourceDirHandle.name}`, 'success', 2000);
    return sourceDirHandle;
  } catch {
    return null;
  }
}

/**
 * Request access to the Google Drive share folder (optional).
 * @returns {FileSystemDirectoryHandle|null}
 */
export async function requestDriveFolder() {
  if (driveDirHandle) return driveDirHandle;

  if (!isFileAccessSupported()) return null;

  try {
    driveDirHandle = await window.showDirectoryPicker({
      id: 'rdms-drive',
      mode: 'readwrite',
      startIn: 'documents',
    });
    subDirCache.drive = {};
    showToast(`Drive folder connected: ${driveDirHandle.name}`, 'success', 2000);
    return driveDirHandle;
  } catch {
    return null;
  }
}

/**
 * Get a subfolder handle from the source folder, creating if needed.
 * @param {string} subfolderName - e.g. "12 Output_Results"
 * @returns {FileSystemDirectoryHandle|null}
 */
async function getSubfolder(rootHandle, rootKey, subfolderName) {
  if (!rootHandle) return null;

  const cacheKey = `${rootKey}:${subfolderName}`;
  if (subDirCache[cacheKey]) return subDirCache[cacheKey];

  try {
    const dirHandle = await rootHandle.getDirectoryHandle(subfolderName, { create: true });
    subDirCache[cacheKey] = dirHandle;
    return dirHandle;
  } catch (err) {
    console.warn(`Cannot access subfolder "${subfolderName}":`, err);
    return null;
  }
}

/**
 * Write a file to a subfolder of the source folder.
 * @param {string} subfolder - e.g. "12 Output_Results"
 * @param {string} filename
 * @param {Blob|string|ArrayBuffer} content
 * @returns {boolean} true if written successfully
 */
export async function writeToSourceSubfolder(subfolder, filename, content) {
  if (!sourceDirHandle) {
    await requestSourceFolder();
    if (!sourceDirHandle) return false;
  }

  const dirHandle = await getSubfolder(sourceDirHandle, 'source', subfolder);
  if (!dirHandle) return false;

  return writeFile(dirHandle, filename, content);
}

/**
 * Write a file to the Drive share folder (or a subfolder of it).
 * @param {string} filename
 * @param {Blob|string|ArrayBuffer} content
 * @param {string} [subfolder] - optional subfolder within Drive
 * @returns {boolean} true if written successfully
 */
export async function writeToDriveFolder(filename, content, subfolder) {
  if (!driveDirHandle) {
    await requestDriveFolder();
    if (!driveDirHandle) return false;
  }

  let targetDir = driveDirHandle;
  if (subfolder) {
    targetDir = await getSubfolder(driveDirHandle, 'drive', subfolder);
    if (!targetDir) return false;
  }

  return writeFile(targetDir, filename, content);
}

/**
 * Write a file to a directory handle.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} filename
 * @param {Blob|string|ArrayBuffer} content
 * @returns {boolean}
 */
async function writeFile(dirHandle, filename, content) {
  try {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    return true;
  } catch (err) {
    console.error(`Failed to write "${filename}":`, err);
    return false;
  }
}

/**
 * Read files from a subfolder of the source folder.
 * @param {string} subfolder - e.g. "01 Input_Draw"
 * @returns {FileSystemFileHandle[]} Array of file handles
 */
export async function listSourceSubfolder(subfolder) {
  if (!sourceDirHandle) {
    await requestSourceFolder();
    if (!sourceDirHandle) return [];
  }

  const dirHandle = await getSubfolder(sourceDirHandle, 'source', subfolder);
  if (!dirHandle) return [];

  const files = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      files.push(entry);
    }
  }
  return files;
}

/**
 * Read a file from a subfolder of the source folder.
 * @param {string} subfolder
 * @param {string} filename
 * @returns {File|null}
 */
export async function readFromSourceSubfolder(subfolder, filename) {
  if (!sourceDirHandle) {
    await requestSourceFolder();
    if (!sourceDirHandle) return null;
  }

  const dirHandle = await getSubfolder(sourceDirHandle, 'source', subfolder);
  if (!dirHandle) return null;

  try {
    const fileHandle = await dirHandle.getFileHandle(filename);
    return await fileHandle.getFile();
  } catch {
    return null;
  }
}

/**
 * Write to both source subfolder AND Drive folder.
 * Dual-save: write to a local subfolder AND the corresponding shared subfolder.
 * e.g. "12 Output_Results" + "80 Shared/2026TN_Output_Results"
 * @param {string} localSubfolder - e.g. "12 Output_Results"
 * @param {string} filename
 * @param {Blob|string|ArrayBuffer} content
 * @param {string} [sharedSubfolder] - nested path e.g. "80 Shared/2026TN_Output_Results"
 * @returns {{ local: boolean, shared: boolean }}
 */
export async function writeToBoth(localSubfolder, filename, content, sharedSubfolder) {
  const local = await writeToSourceSubfolder(localSubfolder, filename, content);

  let shared = false;
  if (sharedSubfolder && sourceDirHandle) {
    const parts = sharedSubfolder.split('/');
    let dirHandle = sourceDirHandle;
    try {
      for (const part of parts) {
        dirHandle = await dirHandle.getDirectoryHandle(part, { create: true });
      }
      shared = await writeFile(dirHandle, filename, content);
    } catch (err) {
      console.warn(`Shared folder write failed "${sharedSubfolder}":`, err);
    }
  }

  return { local, shared };
}

/**
 * Read files from a nested subfolder path.
 * e.g. "80 Shared/2026TN_Joyi" to scan Joyi results.
 * @param {string} nestedPath
 * @returns {FileSystemFileHandle[]}
 */
export async function listNestedSubfolder(nestedPath) {
  if (!sourceDirHandle) {
    await requestSourceFolder();
    if (!sourceDirHandle) return [];
  }

  const parts = nestedPath.split('/');
  let dirHandle = sourceDirHandle;
  try {
    for (const part of parts) {
      dirHandle = await dirHandle.getDirectoryHandle(part);
    }
  } catch {
    return [];
  }

  const files = [];
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') files.push(entry);
  }
  return files;
}

/**
 * Download as fallback when File System Access API is unavailable.
 * @param {string} filename
 * @param {Blob|string} content
 */
export function downloadFallback(filename, content) {
  const blob = content instanceof Blob ? content : new Blob([content]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Check if source folder is connected.
 */
export function isSourceConnected() {
  return !!sourceDirHandle;
}

/**
 * Check if Drive folder is connected.
 */
export function isDriveConnected() {
  return !!driveDirHandle;
}

/**
 * Reset folder connections (e.g. when switching events).
 */
export function resetFolderAccess() {
  sourceDirHandle = null;
  driveDirHandle = null;
  Object.keys(subDirCache).forEach(k => delete subDirCache[k]);
}
