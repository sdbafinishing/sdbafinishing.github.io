/**
 * SDBA RDMS — Google Drive API Fallback
 * Used when File System Access API is unavailable (web hosted version).
 * Reads/writes files to Google Drive folders via REST API.
 *
 * Setup:
 *   1. Create a Google Cloud project with Drive API enabled
 *   2. Create OAuth 2.0 Client ID (web application)
 *   3. Add the hosted origin to authorized JS origins
 *   4. Store client_id in event config (supabase or setup page)
 *
 * The user grants Drive access via Google Sign-In popup.
 * Access token is stored in sessionStorage for the session.
 */
import { getConfig } from './db.js';
import { showToast } from './utils.js';

let accessToken = null;
let driveInitialized = false;

// Google API config — set from event config
let googleClientId = null;

/**
 * Check if Google Drive API fallback is available and needed.
 * Returns true if File System Access API is NOT available.
 */
export function needsDriveFallback() {
  return !('showDirectoryPicker' in window);
}

/**
 * Initialize Google Drive API (load GIS + GAPI).
 */
export async function initDriveApi() {
  if (driveInitialized) return !!accessToken;

  const config = await getConfig();
  googleClientId = config?.google_client_id;

  if (!googleClientId) {
    // No client ID configured — Drive API unavailable
    return false;
  }

  // Check for cached token
  const cached = sessionStorage.getItem('rdms-drive-token');
  if (cached) {
    accessToken = cached;
    driveInitialized = true;
    return true;
  }

  // Load Google Identity Services
  await loadScript('https://accounts.google.com/gsi/client');

  driveInitialized = true;
  return false; // Need user to sign in
}

/**
 * Request Drive access via Google Sign-In.
 * @returns {boolean} true if access granted
 */
export async function requestDriveAccess() {
  if (!googleClientId) {
    showToast('Google Client ID not configured. Set it in Setup → Event Config.', 'warning');
    return false;
  }

  if (accessToken) return true;

  return new Promise((resolve) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (tokenResponse) => {
        if (tokenResponse.access_token) {
          accessToken = tokenResponse.access_token;
          sessionStorage.setItem('rdms-drive-token', accessToken);
          showToast('Google Drive connected', 'success');
          resolve(true);
        } else {
          resolve(false);
        }
      },
    });
    client.requestAccessToken();
  });
}

/**
 * Check if Drive is connected.
 */
export function isDriveApiConnected() {
  return !!accessToken;
}

// ──── File Operations ────

/**
 * Find a folder by name within a parent folder.
 * @param {string} folderName
 * @param {string} parentId - Parent folder ID (or 'root')
 * @returns {string|null} Folder ID
 */
async function findFolder(folderName, parentId = 'root') {
  const query = `name='${folderName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name)`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) return null;

  const data = await resp.json();
  return data.files?.[0]?.id || null;
}

/**
 * Create a folder.
 * @param {string} folderName
 * @param {string} parentId
 * @returns {string} Folder ID
 */
async function createFolder(folderName, parentId = 'root') {
  const resp = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });

  const data = await resp.json();
  return data.id;
}

/**
 * Get or create a folder by path (e.g. "11 Output_Start Lists").
 * Navigates from the configured source folder.
 * @param {string} subfolderPath - e.g. "80 Shared/2026TN_Joyi"
 * @returns {string|null} Folder ID
 */
async function getOrCreateFolder(subfolderPath) {
  const config = await getConfig();
  let parentId = config?.drive_source_folder_id;

  if (!parentId) {
    showToast('Drive source folder ID not configured', 'warning');
    return null;
  }

  const parts = subfolderPath.split('/');
  for (const part of parts) {
    let folderId = await findFolder(part, parentId);
    if (!folderId) {
      folderId = await createFolder(part, parentId);
    }
    parentId = folderId;
  }

  return parentId;
}

/**
 * List files in a Drive folder.
 * @param {string} subfolderPath
 * @returns {Array<{id, name, mimeType}>}
 */
export async function listDriveFiles(subfolderPath) {
  if (!accessToken) return [];

  const folderId = await getOrCreateFolder(subfolderPath);
  if (!folderId) return [];

  const query = `'${folderId}' in parents and trashed=false`;
  // `size` is needed by the Joyi LCD start-time derivation to compute the
  // last-scanline byte offset without downloading the full image.
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,modifiedTime,size)&orderBy=name`;

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) return [];

  const data = await resp.json();
  return data.files || [];
}

/**
 * Read a file from Drive.
 * @param {string} fileId
 * @returns {ArrayBuffer}
 */
export async function readDriveFile(fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) throw new Error(`Failed to read file: ${resp.statusText}`);
  return resp.arrayBuffer();
}

/**
 * Read a byte range from a Drive file using an HTTP Range header.
 * Used by the Joyi LCD start-time derivation to fetch only the 24-byte
 * header + 4 bytes at the last-scanline offset — ~30 bytes total instead
 * of downloading the full 100-300 MB image.
 *
 * @param {string} fileId
 * @param {number} start - inclusive byte offset
 * @param {number} end   - inclusive byte offset (per Range header convention)
 * @returns {Promise<ArrayBuffer>}
 */
export async function readDriveFileRange(fileId, start, end) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Range: `bytes=${start}-${end}`,
    },
  });
  // 206 Partial Content is the success case; 200 indicates the server
  // ignored Range and sent the whole thing — still usable.
  if (resp.status !== 206 && resp.status !== 200) {
    throw new Error(`Range read failed (${resp.status}): ${resp.statusText}`);
  }
  return resp.arrayBuffer();
}

/**
 * Upload/overwrite a file to a Drive folder.
 * @param {string} subfolderPath - e.g. "12 Output_Results"
 * @param {string} filename
 * @param {Blob|ArrayBuffer} content
 * @param {string} mimeType
 * @returns {boolean}
 */
export async function writeDriveFile(subfolderPath, filename, content, mimeType = 'application/octet-stream') {
  if (!accessToken) return false;

  const folderId = await getOrCreateFolder(subfolderPath);
  if (!folderId) return false;

  // Check if file already exists (to overwrite)
  const existingFiles = await listDriveFiles(subfolderPath);
  const existing = existingFiles.find(f => f.name === filename);

  const blob = content instanceof Blob ? content : new Blob([content]);

  if (existing) {
    // Update existing file
    const url = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`;
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': mimeType },
      body: blob,
    });
    return resp.ok;
  } else {
    // Create new file (multipart upload)
    const metadata = JSON.stringify({ name: filename, parents: [folderId] });
    const form = new FormData();
    form.append('metadata', new Blob([metadata], { type: 'application/json' }));
    form.append('file', blob);

    const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
    });
    return resp.ok;
  }
}

/**
 * Write to both local subfolder and Drive (auto-detect which is available).
 * This wraps file-access.js writeToBoth with Drive API fallback.
 * @param {string} localSub - e.g. "12 Output_Results"
 * @param {string} filename
 * @param {Blob} content
 * @param {string} sharedSub - e.g. "80 Shared/2026TN_Output_Results"
 */
export async function writeToBothWithFallback(localSub, filename, content, sharedSub) {
  // Try File System Access API first
  const { writeToBoth, isSourceConnected, downloadFallback } = await import('./file-access.js');

  if (isSourceConnected()) {
    return writeToBoth(localSub, filename, content, sharedSub);
  }

  // Fallback to Drive API
  if (accessToken) {
    const local = await writeDriveFile(localSub, filename, content);
    let shared = false;
    if (sharedSub) {
      shared = await writeDriveFile(sharedSub, filename, content);
    }
    return { local, shared };
  }

  // Last resort: browser download
  downloadFallback(filename, content);
  return { local: false, shared: false };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
