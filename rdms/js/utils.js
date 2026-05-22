/**
 * SDBA RDMS — Utility Functions
 * Time conversion, formatting, toast notifications.
 */

// ──── Time Format Conversion (mss00 / mmss00) ────

/**
 * Convert mss00 string to milliseconds.
 * "05591" → 0 min, 55 sec, 91 centisec → 55910 ms
 * "15230" → 1 min, 52 sec, 30 centisec → 112300 ms
 * @param {string} raw - Time string in mss00 format
 * @param {string} mode - 'mss00' (default) or 'mmss00'
 * @returns {number|null} Milliseconds, or null if invalid
 */
export function timeToMs(raw, mode = 'mss00') {
  if (!raw || typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  const expectedLen = mode === 'mmss00' ? 6 : 5;
  if (digits.length !== expectedLen) return null;

  let min, sec, cs;
  if (mode === 'mmss00') {
    min = parseInt(digits.slice(0, 2), 10);
    sec = parseInt(digits.slice(2, 4), 10);
    cs = parseInt(digits.slice(4, 6), 10);
  } else {
    min = parseInt(digits.slice(0, 1), 10);
    sec = parseInt(digits.slice(1, 3), 10);
    cs = parseInt(digits.slice(3, 5), 10);
  }

  if (sec >= 60 || cs >= 100) return null;
  return (min * 60 + sec) * 1000 + cs * 10;
}

/**
 * Convert milliseconds to mss00 string.
 * 55910 → "05591"
 * @param {number} ms - Milliseconds
 * @param {string} mode - 'mss00' or 'mmss00'
 * @returns {string} Formatted time string
 */
export function msToTime(ms, mode = 'mss00') {
  if (ms == null || ms < 0) return '';
  const totalCs = Math.round(ms / 10);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60);

  if (mode === 'mmss00') {
    return `${String(min).padStart(2, '0')}${String(sec).padStart(2, '0')}${String(cs).padStart(2, '0')}`;
  }
  return `${min}${String(sec).padStart(2, '0')}${String(cs).padStart(2, '0')}`;
}

/**
 * Convert mss00 string to display format.
 * "05591" → "0:55.91"
 * "15230" → "1:52.30"
 * @param {string} raw - Time string in mss00 format
 * @param {string} mode - 'mss00' or 'mmss00'
 * @returns {string} Display formatted time
 */
export function timeToDisplay(raw, mode = 'mss00') {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  const expectedLen = mode === 'mmss00' ? 6 : 5;
  if (digits.length !== expectedLen) return raw;

  if (mode === 'mmss00') {
    return `${digits.slice(0, 2)}:${digits.slice(2, 4)}.${digits.slice(4, 6)}`;
  }
  return `${digits.slice(0, 1)}:${digits.slice(1, 3)}.${digits.slice(3, 5)}`;
}

/**
 * Parse Joyi time format "HH:MM:SS.cc" to mss00.
 * "00:01:17.14" → "11714"
 * @param {string} joyiTime - Time in HH:MM:SS.cc format
 * @param {string} mode - 'mss00' or 'mmss00'
 * @returns {string} mss00/mmss00 formatted string
 */
export function joyiTimeToRaw(joyiTime, mode = 'mss00') {
  if (!joyiTime || typeof joyiTime !== 'string') return '';
  const parts = joyiTime.split(':');
  if (parts.length !== 3) return '';

  const hours = parseInt(parts[0], 10);
  const mins = parseInt(parts[1], 10);
  const secParts = parts[2].split('.');
  const secs = parseInt(secParts[0], 10);
  const cs = secParts.length > 1 ? parseInt(secParts[1].padEnd(2, '0').slice(0, 2), 10) : 0;

  const totalMin = hours * 60 + mins;
  const totalMs = (totalMin * 60 + secs) * 1000 + cs * 10;
  return msToTime(totalMs, mode);
}

/**
 * Validate a time string.
 * @param {string} raw - Time string
 * @param {string} mode - 'mss00' or 'mmss00'
 * @returns {boolean} True if valid
 */
export function isValidTime(raw, mode = 'mss00') {
  return timeToMs(raw, mode) !== null;
}

// ──── Timestamps ────

/**
 * Get current timestamp as ISO string with millisecond precision.
 * @returns {string} ISO timestamp
 */
export function nowISO() {
  return new Date().toISOString();
}

/**
 * Get current time as "HH:MM:SS.cc" display string.
 * @returns {string} Formatted clock time
 */
export function nowDisplay() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const cs = String(Math.floor(d.getMilliseconds() / 10)).padStart(2, '0');
  return `${h}:${m}:${s}.${cs}`;
}

/**
 * Format ISO timestamp to display time "HH:MM:SS".
 * @param {string} iso - ISO timestamp
 * @returns {string} Formatted time
 */
export function isoToTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

// ──── Title Sanitisation ────

const REPLACE_WORDS = [
  ['Corporates', 'Corp'], ['Corporate', 'Corp'],
  ['Disciplinary', 'Disc'], ['Hong Kong', 'HK'],
  ['Groups', 'Grp'], ['Group', 'Grp'],
  ['Small Boat', 'SB'], ['Standard', 'Std'],
  ['Division', 'Div'], ['Round', 'Rnd'],
  ['Services', 'Srvcs'], ['Community', 'Commty'],
  ['Invitational', 'Invt'],
  ['( ', '('], [' )', ')'],
];

/**
 * Clean and shorten a race title from draw file.
 * Strips "Race No. N ---" prefix and "- 場次 Race N" suffix.
 * @param {string} raw - Raw title from A1 of draw file
 * @returns {string} Sanitised title
 */
export function sanitiseTitle(raw) {
  if (!raw) return '';
  let title = raw;

  // Strip prefix "Race No. N --- "
  const dashIdx = title.indexOf('---');
  if (dashIdx !== -1) {
    title = title.substring(dashIdx + 3).trim();
  }

  // Strip suffix "- 場次 Race N" or "- Race N"
  const suffixMatch = title.match(/\s*-\s*場次\s*Race\s*\d+\s*$/i)
    || title.match(/\s*-\s*Race\s*\d+\s*$/i);
  if (suffixMatch) {
    title = title.substring(0, suffixMatch.index).trim();
  }

  // Shorten common words
  for (const [from, to] of REPLACE_WORDS) {
    title = title.replaceAll(from, to);
  }

  // Clean whitespace
  title = title.replace(/\s+/g, ' ').trim();
  title = title.replace(/\n/g, '').replace(/\r/g, '');

  return title;
}

/**
 * Extract race number from draw filename.
 * "1.xls" → 1, "Second Round - 25.xls" → 25, "18 -raw sample.xls" → 18
 * @param {string} filename
 * @returns {number|null} Race number or null
 */
export function extractRaceNumber(filename) {
  if (!filename) return null;
  const name = filename.replace(/\.[^.]+$/, ''); // strip extension

  // "Second Round - 25" → 25
  const secondRound = name.match(/Second\s*Round\s*-\s*(\d+)/i);
  if (secondRound) return parseInt(secondRound[1], 10);

  // "25" or "25 -raw sample" → 25
  const leadingNum = name.match(/^(\d+)/);
  if (leadingNum) return parseInt(leadingNum[1], 10);

  return null;
}

/**
 * Extract race number from Joyi filename.
 * "2025TN.9.xls" → 9
 * @param {string} filename
 * @returns {number|null} Race number or null
 */
export function extractJoyiRaceNumber(filename) {
  if (!filename) return null;
  const match = filename.match(/\.(\d+)\.xls$/i);
  if (match) return parseInt(match[1], 10);
  return null;
}

// ──── Range Expand (VBA equivalent) ────

/**
 * Parse a range string like "1-3, 5, 7-9" into an array of integers.
 * Ignores non-positive numbers. Same logic as VBA RangeExpand().
 * @param {string} rangeStr
 * @returns {number[]}
 */
export function rangeExpand(rangeStr) {
  if (!rangeStr) return [];
  const result = [];
  const parts = rangeStr.replace(/[^0-9,\-]/g, '').split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const dashIdx = trimmed.indexOf('-', 1); // skip leading negative
    if (dashIdx > 0) {
      const start = parseInt(trimmed.slice(0, dashIdx), 10);
      const end = parseInt(trimmed.slice(dashIdx + 1), 10);
      if (!isNaN(start) && !isNaN(end) && start > 0 && end > 0 && end >= start) {
        for (let i = start; i <= end; i++) result.push(i);
      }
    } else {
      const num = parseInt(trimmed, 10);
      if (!isNaN(num) && num > 0) result.push(num);
    }
  }

  return result;
}

// ──── Folder Path Validation ────

/**
 * Validate a folder path ends with / (Mac/Linux) or \ (Windows).
 * @param {string} path
 * @returns {boolean}
 */
export function isValidFolderPath(path) {
  if (!path || path.length === 0) return false;
  return path.endsWith('/') || path.endsWith('\\');
}

// ──── Toast Notifications ────

let toastCounter = 0;

/**
 * Show a toast notification.
 * @param {string} message - Toast text
 * @param {'success'|'warning'|'error'|'info'} type - Toast type
 * @param {number} duration - Auto-dismiss after ms (0 = persist)
 */
export function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const id = `toast-${++toastCounter}`;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.id = id;
  toast.textContent = message;
  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.remove();
    }, duration);
  }
}

// ──── CSV (UTF-8) ────

/**
 * Build a UTF-8 CSV blob from rows. Prepends a BOM (U+FEFF) so Excel opens
 * the file with the right encoding without the operator having to choose a
 * code page in the import dialog. Each cell is quoted iff it contains a
 * comma, quote, or newline; embedded quotes are doubled per RFC 4180.
 *
 * @param {string[][]} rows - 2D array of cell values
 * @returns {Blob} text/csv;charset=utf-8 blob with BOM
 */
export function rowsToCsvBlob(rows) {
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  // U+FEFF as the first character is the Excel-friendly UTF-8 BOM. Without
  // it Excel falls back to the OS code page (Big5 on HK / GB on CN) and
  // mangles Chinese division names.
  return new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
}

/**
 * Quote a single CSV cell per RFC 4180. Numbers / booleans get String()'d;
 * null/undefined → empty string.
 */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * Parse a UTF-8 CSV file/Blob into rows. Reads via Blob.text() which always
 * decodes as UTF-8, then drops a leading BOM if present. Supports quoted
 * fields with embedded commas, quotes ("" → "), and newlines.
 *
 * @param {File|Blob|string} input - File/Blob or already-decoded string
 * @returns {Promise<string[][]>}
 */
export async function csvToRows(input) {
  const raw = typeof input === 'string' ? input : await input.text();
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;

  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(cell); cell = ''; continue; }
    if (c === '\r') { continue; }
    if (c === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; continue; }
    cell += c;
  }
  // Flush last cell/row (handles files without a trailing newline).
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}
