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
// Cached token client — created once, reused for silent refresh. The
// GIS library is happy to call requestAccessToken({prompt: ''}) on the
// same client to renew without re-prompting the user (works as long as
// the user has previously granted the scope and the consent is still
// valid).
let cachedTokenClient = null;
// Single-flight guard: avoid kicking off multiple parallel refreshes
// when several concurrent requests all 401 at once.
let refreshInflight = null;

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
 * Get or create the cached GIS token client. We reuse it for both the
 * initial connect (with user prompt) and silent refreshes (no prompt).
 */
function getTokenClient() {
  if (cachedTokenClient) return cachedTokenClient;
  if (typeof google === 'undefined' || !google.accounts?.oauth2) return null;
  cachedTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: googleClientId,
    // Use full `drive` scope, not `drive.file`. drive.file only allows
    // access to files the app itself created OR that the user opened
    // via Google Picker API — it CANNOT list/read arbitrary folders
    // by ID. Since RDMS needs to scan the operator's shared Joyi
    // folder by ID (configured in drive_source_folder_id + relative
    // subpath), full drive scope is necessary. This is considered a
    // sensitive scope by Google: for Internal-mode consent screens
    // (Workspace orgs) it's free; for External-Testing mode it works
    // for up to 100 listed test users without verification.
    scope: 'https://www.googleapis.com/auth/drive',
    callback: () => { /* per-call callback set via .callback = ... before each requestAccessToken() */ },
  });
  return cachedTokenClient;
}

/**
 * Request Drive access via Google Sign-In.
 * Initial connect: shows the OAuth popup so the user can pick an account
 * and grant the scope. Subsequent silent refreshes go through
 * `refreshDriveToken()` below.
 * @returns {boolean} true if access granted
 */
export async function requestDriveAccess() {
  if (!googleClientId) {
    showToast('Google Client ID not configured. Set it in Setup → Event Config.', 'warning');
    return false;
  }

  if (accessToken) return true;

  return new Promise((resolve) => {
    const client = getTokenClient();
    if (!client) { resolve(false); return; }
    client.callback = (tokenResponse) => {
      if (tokenResponse.access_token) {
        accessToken = tokenResponse.access_token;
        sessionStorage.setItem('rdms-drive-token', accessToken);
        showToast('Google Drive connected', 'success');
        resolve(true);
      } else {
        resolve(false);
      }
    };
    // Empty prompt allows the popup; user picks account on first connect.
    client.requestAccessToken();
  });
}

/**
 * Silently refresh the Drive access token without user interaction.
 * Works as long as the user has previously granted the scope and the
 * grant hasn't been revoked. Returns true on success.
 *
 * Single-flight: parallel callers all get the same in-flight Promise so
 * we don't pop multiple OAuth windows on a burst of 401s.
 */
export async function refreshDriveToken() {
  if (refreshInflight) return refreshInflight;
  if (!googleClientId) return false;
  // GIS script must be loaded — initDriveApi normally handles this.
  if (typeof google === 'undefined' || !google.accounts?.oauth2) {
    await loadScript('https://accounts.google.com/gsi/client');
  }
  refreshInflight = new Promise((resolve) => {
    const client = getTokenClient();
    if (!client) { resolve(false); return; }
    client.callback = (tokenResponse) => {
      if (tokenResponse.access_token) {
        accessToken = tokenResponse.access_token;
        sessionStorage.setItem('rdms-drive-token', accessToken);
        resolve(true);
      } else {
        // Silent refresh failed — usually because the user revoked the
        // grant or hasn't connected yet this browser session. The
        // caller's next user-driven action should re-trigger
        // requestDriveAccess() (with a popup) instead.
        accessToken = null;
        sessionStorage.removeItem('rdms-drive-token');
        resolve(false);
      }
    };
    // `prompt: ''` = silent reauth. No popup, no consent screen, just
    // returns a fresh token if the grant is still live.
    client.requestAccessToken({ prompt: '' });
  });
  try { return await refreshInflight; }
  finally { refreshInflight = null; }
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

  const resp = await fetchWithRefresh(url);
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
  const resp = await fetchWithRefresh('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  let parentId = sanitizeDriveFolderId(config?.drive_source_folder_id);

  if (!parentId) {
    showToast('Drive source folder ID not configured (or looks like a URL — paste only the ID from Copy Link).', 'warning', 5000);
    return null;
  }

  // Sanitize the path too. If the operator pasted a Drive URL into
  // shared_joyi_folder by mistake, the split('/') would produce
  // ['https:', '', 'drive.google.com', …] and we'd uselessly search
  // for folders named "https:" etc. Surface a clear error instead.
  const cleanPath = sanitizeDriveSubpath(subfolderPath);
  if (cleanPath === null) {
    showToast('Shared folder path looks like a URL. Use a RELATIVE path like "80 Shared/2026TN_Joyi" — not a Drive link.', 'warning', 6000);
    return null;
  }
  if (!cleanPath) return parentId; // empty path = the root itself

  const parts = cleanPath.split('/').filter(Boolean);
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
 * Strip noise from a configured Drive folder ID:
 *   - "1AbCd...?usp=drive_link"  → "1AbCd..."   (query stripped)
 *   - "https://drive.google.com/drive/folders/1AbCd...?usp=…" → "1AbCd..."
 *   - "  1AbCd...  "             → "1AbCd..."   (trimmed)
 * Returns null if no plausible ID was found.
 */
function sanitizeDriveFolderId(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Pull ID out of a folders/ URL if pasted by mistake.
  const m = s.match(/folders\/([A-Za-z0-9_-]+)/);
  if (m) s = m[1];
  // Strip query string if present.
  s = s.split('?')[0].split('#')[0];
  // Plausibility: Drive IDs are 25+ chars of [A-Za-z0-9_-].
  if (!/^[A-Za-z0-9_-]{10,}$/.test(s)) return null;
  return s;
}

/**
 * Cull a configured shared-folder subpath. Returns:
 *   - "" if the input is blank.
 *   - a cleaned relative path (no leading/trailing slashes) for valid input.
 *   - null if the input looks like a URL (operator paste mistake), so
 *     the caller can surface a helpful error.
 */
function sanitizeDriveSubpath(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return null;
  // Strip leading/trailing slashes but preserve internal ones.
  return s.replace(/^\/+|\/+$/g, '');
}

/**
 * Wrap a fetch call so that a 401 (token expired) triggers a silent
 * refresh and one retry. After the retry, errors propagate normally.
 * All Drive REST calls below go through this so the operator doesn't
 * have to re-authenticate after the ~1-hour token lifetime.
 */
async function fetchWithRefresh(input, init = {}) {
  const buildInit = () => ({
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });
  let resp = await fetch(input, buildInit());
  if (resp.status === 401 || resp.status === 403) {
    const ok = await refreshDriveToken();
    if (ok) {
      resp = await fetch(input, buildInit());
    }
  }
  return resp;
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

  const resp = await fetchWithRefresh(url);
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
  const resp = await fetchWithRefresh(url);
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
  const resp = await fetchWithRefresh(url, {
    headers: { Range: `bytes=${start}-${end}` },
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
 * @returns {string|false} the Drive file ID on success (truthy), false on failure.
 *   Returning the ID lets callers build a direct-download link (#4) and update
 *   the SAME file on re-export so the link stays stable; existing boolean
 *   callers (e.g. backup.js `if (written)`) still work because an ID is truthy.
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
    // Update existing file — keeps the SAME file ID (stable direct link even
    // after a manual edit-and-override or a re-export).
    const url = `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=media`;
    const resp = await fetchWithRefresh(url, {
      method: 'PATCH',
      headers: { 'Content-Type': mimeType },
      body: blob,
    });
    return resp.ok ? existing.id : false;
  } else {
    // Create new file (multipart upload)
    const metadata = JSON.stringify({ name: filename, parents: [folderId] });
    const form = new FormData();
    form.append('metadata', new Blob([metadata], { type: 'application/json' }));
    form.append('file', blob);

    const resp = await fetchWithRefresh('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      body: form,
    });
    if (!resp.ok) return false;
    try {
      const data = await resp.json();
      return data?.id || true; // true keeps boolean callers happy if id missing
    } catch {
      return true;
    }
  }
}

/** Direct-download URL for a Drive file ID (forces download, not a preview). */
export function driveDirectDownloadUrl(fileId) {
  return fileId ? `https://drive.google.com/uc?export=download&id=${fileId}` : null;
}

/**
 * Make a Drive file readable by anyone with the link (idempotent — Drive
 * accepts a repeat "anyone/reader" grant). Returns true on success.
 */
export async function shareDriveFileAnyone(fileId) {
  if (!accessToken || !fileId) return false;
  try {
    const resp = await fetchWithRefresh(
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone' }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Write a file via the Drive API AND return a public direct-download link
 * (#4 approach A). Writes to the SAME file on re-export (stable ID/link), shares
 * it anyone-with-link, and returns { id, directUrl }. Returns null on any
 * failure so the caller can fall back to the mounted-folder write.
 */
export async function writeDriveFileWithLink(subfolderPath, filename, content, mimeType) {
  const id = await writeDriveFile(subfolderPath, filename, content, mimeType);
  if (!id || id === true) return null;
  await shareDriveFileAnyone(id);
  return { id, directUrl: driveDirectDownloadUrl(id) };
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
