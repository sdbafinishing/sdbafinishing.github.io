/**
 * SDBA RDMS — File Import Engine
 * Parse draw .xls files and Joyi result .xls files via SheetJS.
 */
import * as XLSX from 'xlsx';
import { getConfig, getRace, saveRace, bulkSaveLaneResults, bulkSaveRaces, addImportLog } from './db.js';
import { sanitiseTitle, extractRaceNumber, extractJoyiRaceNumber, joyiTimeToRaw, msToTime, showToast } from './utils.js';

/**
 * Parse a draw .xls file and return structured data.
 * Draw file format:
 *   Row 0 (A1): "Race No. N --- [Chinese] [English title] - 場次 Race N"
 *   Row 0 (D1): Scheduled time (e.g. "10:00")
 *   Row 1-2: Headers
 *   Row 3 to (3 + laneCount - 1): Data — A=lane, B=team name or R{n}P{n}, C=team code
 *   Row (3 + laneCount): Progression text (Chinese + English)
 *
 * @param {File} file - The .xls File object
 * @returns {Object} { raceNumber, rawTitle, sanitisedTitle, raceTime, lanes[], progressionText }
 */
export async function parseDrawFile(file) {
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (rows.length < 4) {
    throw new Error(`Draw file "${file.name}" has too few rows (${rows.length})`);
  }

  // Extract race number from filename first, fallback to title
  let raceNumber = extractRaceNumber(file.name);

  // Row 0: Title and scheduled time
  const rawTitle = String(rows[0][0] || '');
  const raceTime = String(rows[0][3] || '');

  // If no race number from filename, try from title
  if (!raceNumber) {
    const titleMatch = rawTitle.match(/Race\s*No\.\s*(\d+)/i);
    if (titleMatch) raceNumber = parseInt(titleMatch[1], 10);
  }

  if (!raceNumber) {
    throw new Error(`Cannot determine race number from "${file.name}"`);
  }

  const sanitisedTitle = sanitiseTitle(rawTitle);

  // Parse lane data (Row 3+)
  const lanes = [];
  for (let r = 3; r < rows.length; r++) {
    const row = rows[r];
    const laneVal = row[0];

    // Stop at non-numeric lane (progression text or signature row)
    if (laneVal === '' || laneVal == null) continue;
    const laneNum = typeof laneVal === 'number' ? laneVal : parseFloat(laneVal);
    if (isNaN(laneNum) || laneNum < 1 || laneNum > 13) {
      // This is likely the progression text row
      break;
    }

    lanes.push({
      lane_number: Math.round(laneNum),
      team_name: String(row[1] || '').trim(),
      team_code: String(row[2] || '').trim(),
    });
  }

  // Find progression text — first row after lane data with long text in column A
  let progressionText = '';
  for (let r = 3 + lanes.length; r < rows.length; r++) {
    const cellA = String(rows[r][0] || '');
    if (cellA.length > 30) {
      progressionText = cellA;
      break;
    }
  }

  // Detect R{n}P{n} placeholders
  const placeholders = lanes
    .filter(l => /^R\d+P\d+$/i.test(l.team_name))
    .map(l => ({ lane: l.lane_number, designation: l.team_name }));

  return {
    raceNumber,
    rawTitle,
    sanitisedTitle,
    raceTime,
    lanes,
    progressionText,
    placeholders,
    filename: file.name,
  };
}

/**
 * Import parsed draw data into IndexedDB.
 * Creates/updates race record and lane_results.
 * @param {Object} parsed - Output from parseDrawFile
 * @returns {Object} { success, raceNumber, teamsLoaded }
 */
export async function importDrawToDb(parsed) {
  const config = await getConfig();
  const laneCount = config?.lane_count || 6;

  // Get or create race record
  let race = await getRace(parsed.raceNumber) || {
    race_number: parsed.raceNumber,
    status: 'pending',
    teams_loaded: false,
    joyi_imported: false,
    export_version: 0,
    export_history: [],
    scoring_flag: 'N',
  };

  race.race_title = parsed.sanitisedTitle;
  race.race_time = parsed.raceTime;
  // A draw is "loaded" once at least one lane has a real team. A real team
  // is any non-empty team_name that ISN'T an R{n}P{n} placeholder. Note:
  // some templates park the placeholder in team_code (column C) with
  // team_name blank — those rows shouldn't count as loaded either.
  race.teams_loaded = parsed.lanes.some(l => {
    const name = (l.team_name || '').trim();
    const code = (l.team_code || '').trim();
    if (!name && !code) return false;
    if (name && !/^R\d+P\d+$/i.test(name)) return true;
    // team_name empty but team_code set → real team only if code isn't a placeholder
    if (!name && code && !/^R\d+P\d+$/i.test(code)) return true;
    return false;
  });
  await saveRace(race);

  // Build lane results (preserve existing times if any)
  const laneResults = [];
  for (let i = 0; i < laneCount; i++) {
    const drawLane = parsed.lanes.find(l => l.lane_number === i + 1);
    laneResults.push({
      race_number: parsed.raceNumber,
      lane_number: i + 1,
      team_name: drawLane?.team_name || '',
      team_code: drawLane?.team_code || '',
      // The placeholder may live in either column — remember the raw
      // designation so audit + downstream code can identify the slot
      // regardless of which template variant was imported.
      designation: (drawLane?.team_name && /^R\d+P\d+$/i.test(drawLane.team_name))
        ? drawLane.team_name
        : (drawLane?.team_code && /^R\d+P\d+$/i.test(drawLane.team_code))
            ? drawLane.team_code
            : '',
      // Preserve existing result fields (don't overwrite)
      raw_time: '',
      penalty_time: '',
      remarks: '',
      computed_position: null,
      effective_time_ms: null,
      joyi_lane: null,
      joyi_time: null,
      joyi_name: null,
      joyi_rank: null,
    });
  }

  await bulkSaveLaneResults(laneResults);
  await addImportLog({ filename: parsed.filename, type: 'draw', race_number: parsed.raceNumber });

  return { success: true, raceNumber: parsed.raceNumber, teamsLoaded: race.teams_loaded };
}

/**
 * Import multiple draw files at once.
 * @param {FileList|File[]} files - Array of .xls files
 * @returns {Object[]} Array of { filename, raceNumber, success, error }
 */
export async function importMultipleDrawFiles(files) {
  const results = [];

  for (const file of files) {
    try {
      const parsed = await parseDrawFile(file);
      const result = await importDrawToDb(parsed);
      results.push({
        filename: file.name,
        raceNumber: result.raceNumber,
        title: parsed.sanitisedTitle,
        teamsLoaded: result.teamsLoaded,
        success: true,
      });
    } catch (err) {
      results.push({
        filename: file.name,
        raceNumber: null,
        title: '',
        teamsLoaded: false,
        success: false,
        error: err.message,
      });
    }
  }

  return results;
}

/**
 * Parse a Joyi results .xls file.
 * Joyi format:
 *   Row 0: Event name
 *   Row 1: Race ref + wind speed + datetime
 *   Row 2: Chinese headers (道次/名次/号码/姓名/单位/成绩/得分/备注)
 *   Row 3+: Data — A=lane, B=place, C=code, D=name, F=time (HH:MM:SS.cc)
 *   Filename: {ref}.{race_number}.xls
 *
 * @param {File} file - The Joyi .xls File object
 * @returns {Object} { raceNumber, results[] }
 */
/**
 * Parse a Joyi .jyd file (UTF-8 XML, native Joyi finish format).
 *
 * The .jyd carries the same finishing data as the .xls Joyi export but as
 * structured XML. RealScore is in milliseconds. Players are listed in lane
 * order; we sort by Rank so the import path can treat results[i] as the
 * i-th finisher (matching parseJoyiFile's output shape).
 *
 * @param {File} file - The Joyi .jyd File object
 * @returns {Object} { raceNumber, results[], filename, jyd: <raw parsed for downstream overlay use> }
 */
export async function parseJydFile(file) {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');

  const parseErr = doc.querySelector('parsererror');
  if (parseErr) throw new Error(`Invalid .jyd XML: ${parseErr.textContent.slice(0, 100)}`);

  const magic = doc.querySelector('FileInfo > Magic')?.textContent;
  if (magic !== 'JoyiFinishFile') {
    throw new Error(`Not a Joyi finish file. Magic = "${magic || 'missing'}"`);
  }

  let raceNumber = parseInt(doc.querySelector('Game > Heat')?.textContent, 10);
  if (!raceNumber) raceNumber = extractJoyiRaceNumber(file.name);
  if (!raceNumber) throw new Error(`Cannot determine race number from .jyd "${file.name}"`);

  const config = await getConfig();
  const timeMode = config?.time_format_mode || 'mss00';

  // Parse all Players. Three time fields in the JYD:
  //   RealScore  — raw bow-crossing time the camera measured (ms)
  //   FirstScore — same as RealScore in observed samples (preserved for
  //                forward-compat; might diverge if Joyi later adds a
  //                separate first-touch field)
  //   Score      — official finish time = RealScore + TimeDelta correction
  // The OFFICIAL displayed time is Score; the photo-finish overlay anchor and
  // the operator-facing imports should both use it. RealScore is kept for the
  // viewer's optional raw-camera-time comparison.
  const players = [...doc.querySelectorAll('Players > Player')].map(p => {
    const t = (sel) => p.querySelector(sel)?.textContent || '';
    return {
      lane: parseInt(t('Lane'), 10),
      rank: parseInt(t('Rank'), 10),
      scoreMs: parseInt(t('Score'), 10),
      firstScoreMs: parseInt(t('FirstScore'), 10),
      realScoreMs: parseInt(t('RealScore'), 10),
      name: t('Name').trim(),
      code: t('No').trim(),
    };
  }).filter(p => Number.isInteger(p.lane) && p.lane >= 1);

  // Sort by Rank so results[i] = (i+1)-th finisher. Players without a real
  // rank (NaN) drop to the end.
  players.sort((a, b) => {
    const ra = Number.isFinite(a.rank) ? a.rank : 9999;
    const rb = Number.isFinite(b.rank) ? b.rank : 9999;
    return ra - rb;
  });

  const results = players.map(p => {
    // Prefer Score (official, with TimeDelta correction). Fall back to
    // RealScore for older .jyd files that might not carry Score.
    const officialMs = Number.isFinite(p.scoreMs) ? p.scoreMs : p.realScoreMs;
    const raw = Number.isFinite(officialMs) ? msToTime(officialMs, timeMode) : '';
    return {
      joyi_lane: p.lane,
      joyi_rank: Number.isFinite(p.rank) ? p.rank : null,
      joyi_code: p.code,
      joyi_name: p.name,
      joyi_time_raw: raw,
      joyi_time_mss00: raw,
    };
  });

  // Pull the photo-finish overlay metadata out for downstream viewers.
  const lcImage = doc.querySelector('LcImage');
  const reachPoints = lcImage
    ? [...lcImage.querySelectorAll('ReachPoints > ReachPoint')].map(rp => ({
        no: parseInt(rp.querySelector('No')?.textContent, 10),
        line: parseInt(rp.querySelector('Line')?.textContent, 10),
      })).filter(rp => Number.isFinite(rp.no) && Number.isFinite(rp.line))
    : [];
  const direction = lcImage?.querySelector('Direction')?.textContent || 'LeftToRight';
  const lcPath = lcImage?.querySelector('Path')?.textContent || '';

  return {
    raceNumber,
    results,
    filename: file.name,
    jyd: {
      gameTime: doc.querySelector('Game > GameTime')?.textContent || '',
      windSpeed: parseFloat(doc.querySelector('Game > WindSpeed')?.textContent) || 0,
      timeDelta: parseInt(doc.querySelector('Game > TimeDelta')?.textContent, 10) || 0,
      players,
      reachPoints,
      direction,
      lcPath,
    },
  };
}

/**
 * Dispatch a Joyi import to the right parser based on extension.
 * Operators can hand us either the native .jyd (XML) or the legacy .xls,
 * and they end up in the same downstream importJoyiToDb flow.
 */
export async function parseJoyiAnyFile(file) {
  const lower = (file.name || '').toLowerCase();
  if (lower.endsWith('.jyd')) return parseJydFile(file);
  return parseJoyiFile(file);
}

/**
 * Persist a Joyi-derived start time onto a race record. Also flips the
 * race status to "started" when it was previously "pending" — the Joyi
 * import is unambiguous evidence that the race has run, regardless of
 * whether the operator remembered to click START in RDMS.
 *
 * Idempotent: skipped when joyi_start_time is already set to the same
 * value (lets callers fire this from multiple paths without worrying
 * about duplicate writes).
 *
 * Overwrite protection: once joyi_start_time is set, this function will
 * NOT overwrite it with a different value. This prevents accidental
 * clobbering when the operator re-opens an archive, copies files between
 * folders (which may re-stamp .lcd mtime), or re-runs auto-import on a
 * stale tree. To re-derive intentionally, clear joyi_start_time first
 * via "Reset start" or "Reset race" on the race page (both set it to
 * null) — the next import will then populate.
 *
 * @param {number} raceNumber
 * @param {string} isoTime
 * @returns {Promise<boolean>} true if anything changed
 */
export async function setJoyiStartTimeOnRace(raceNumber, isoTime) {
  if (!raceNumber || !isoTime) return false;
  const race = await getRace(raceNumber);
  if (!race) return false;
  let changed = false;
  if (race.joyi_start_time && race.joyi_start_time !== isoTime) {
    // Already set with a different value — preserve. The operator must
    // explicitly clear via Reset start / Reset race to re-derive.
    // Status may still need promotion if it's lagging behind.
    if (race.status === 'pending' || !race.status) {
      race.status = 'started';
      await saveRace(race);
      return true;
    }
    return false;
  }
  if (race.joyi_start_time !== isoTime) {
    race.joyi_start_time = isoTime;
    changed = true;
  }
  // Auto-promote pending → started when we have any evidence of a start.
  if (race.status === 'pending' || !race.status) {
    race.status = 'started';
    changed = true;
  }
  if (changed) await saveRace(race);
  return changed;
}

/**
 * Derive the wall-clock race start time from a Joyi `.lcd` file. Reads only
 * the header + the last scanline's 4-byte timestamp via `file.slice()` —
 * no need to load the multi-hundred-MB image into memory just to compute
 * a start time.
 *
 * Formula validated across four samples (races 27, 29 + TestRace2,
 * TestRace3): the camera's per-scanline µs clock runs from 0 at race-start;
 * the file's `lastModified` is when Joyi closed the file (capture-stop /
 * Save click — both work because the camera streams until close). So:
 *
 *   raceStart_PC = lcd.lastModified − lastScanlineTs_us / 1000
 *
 * Returns `null` when the file is empty-header (no scanlines yet — race
 * was aborted before capture) or when the inferred start is implausibly
 * far from the file's mtime day (file mtime was likely stomped by a copy
 * step that broke precision).
 *
 * @param {File} lcdFile - the .lcd File object
 * @returns {Promise<string|null>} ISO timestamp or null
 */
export async function deriveJoyiStartTime(lcdFile) {
  if (!lcdFile || lcdFile.size < 24 + 2168) return null; // header only

  // Read the 24-byte LCD header and pull storage_cols + header_bytes.
  const headBuf = await lcdFile.slice(0, 24).arrayBuffer();
  const headView = new DataView(headBuf);
  // Magic check — bail if this isn't a JLIF file.
  const magic = String.fromCharCode(headView.getUint8(0), headView.getUint8(1), headView.getUint8(2), headView.getUint8(3));
  if (magic !== 'JLIF') return null;
  const storageCols = headView.getUint32(12, true);
  const headerBytes = headView.getUint32(20, true);
  if (!storageCols || !headerBytes) return null;

  // Derive how many scanlines were actually written, then read the last
  // scanline's u32 LE timestamp (first 4 bytes of its 8-byte preamble).
  const dataBytes = lcdFile.size - headerBytes;
  const storageRows = Math.floor(dataBytes / storageCols);
  if (storageRows < 2) return null;
  const lastOffset = headerBytes + (storageRows - 1) * storageCols;
  const lastBuf = await lcdFile.slice(lastOffset, lastOffset + 4).arrayBuffer();
  const lastTsUs = new DataView(lastBuf).getUint32(0, true);
  if (!lastTsUs) return null;

  const mtimeMs = lcdFile.lastModified;
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return null;
  const predictedMs = mtimeMs - Math.round(lastTsUs / 1000);

  // Sanity: predicted start must be within 24 h of mtime (otherwise file
  // mtime was likely re-stamped during a copy and the derivation is
  // garbage).
  if (Math.abs(mtimeMs - predictedMs) > 86_400_000) return null;

  return new Date(predictedMs).toISOString();
}

export async function parseJoyiFile(file) {
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // Extract race number from filename
  let raceNumber = extractJoyiRaceNumber(file.name);
  if (!raceNumber) {
    // Try from Row 1 content: "2025TN.9  ..."
    const row1 = String(rows[1]?.[0] || '');
    const match = row1.match(/\.(\d+)\s/);
    if (match) raceNumber = parseInt(match[1], 10);
  }

  if (!raceNumber) {
    throw new Error(`Cannot determine race number from Joyi file "${file.name}"`);
  }

  const config = await getConfig();
  const timeMode = config?.time_format_mode || 'mss00';

  // Parse data rows (Row 3+)
  const results = [];
  for (let r = 3; r < rows.length; r++) {
    const row = rows[r];
    const laneVal = row[0];
    if (laneVal === '' || laneVal == null) continue;
    const lane = typeof laneVal === 'number' ? Math.round(laneVal) : parseInt(laneVal, 10);
    if (isNaN(lane) || lane < 1) continue;

    const place = typeof row[1] === 'number' ? Math.round(row[1]) : parseInt(row[1], 10);
    const code = String(row[2] || '').trim();
    const name = String(row[3] || '').trim();
    const timeStr = String(row[5] || '').trim(); // Column F = index 5

    results.push({
      joyi_lane: lane,
      joyi_rank: isNaN(place) ? null : place,
      joyi_code: code,
      joyi_name: name,
      joyi_time_raw: timeStr,
      joyi_time_mss00: joyiTimeToRaw(timeStr, timeMode),
    });
  }

  return { raceNumber, results, filename: file.name };
}

/**
 * Import Joyi results into IndexedDB for a specific race.
 * Updates lane_results with Joyi data and auto-populates raw_time + lane_input.
 * @param {Object} parsed - Output from parseJoyiFile
 * @returns {Object} { success, raceNumber, count }
 */
export async function importJoyiToDb(parsed) {
  const config = await getConfig();
  const laneCount = config?.lane_count || 6;
  const race = await getRace(parsed.raceNumber);

  if (!race) {
    throw new Error(`Race ${parsed.raceNumber} not found. Import draws first.`);
  }

  // Build lane_results updates
  // Joyi results are sorted by finish order — populate input area accordingly
  const laneResults = [];
  for (let i = 0; i < laneCount; i++) {
    const joyiResult = parsed.results[i]; // ith finisher
    if (!joyiResult) {
      laneResults.push({
        race_number: parsed.raceNumber,
        lane_number: i + 1,
      });
      continue;
    }

    laneResults.push({
      race_number: parsed.raceNumber,
      lane_number: i + 1,
      // Auto-populate input area from Joyi
      lane_input: String(joyiResult.joyi_lane),
      raw_time: joyiResult.joyi_time_mss00,
      // Joyi comparison fields
      joyi_lane: joyiResult.joyi_lane,
      joyi_time: joyiResult.joyi_time_raw,
      joyi_name: joyiResult.joyi_name,
      joyi_rank: joyiResult.joyi_rank,
      // Preserve existing fields
      team_code: joyiResult.joyi_code || '',
      team_name: joyiResult.joyi_name || '',
    });
  }

  await bulkSaveLaneResults(laneResults);

  // Update race status
  race.joyi_imported = true;
  await saveRace(race);

  await addImportLog({ filename: parsed.filename, type: 'joyi', race_number: parsed.raceNumber });

  return { success: true, raceNumber: parsed.raceNumber, count: parsed.results.length };
}
