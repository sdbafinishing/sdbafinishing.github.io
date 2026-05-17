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
  race.teams_loaded = parsed.lanes.some(l => l.team_name && !l.team_name.match(/^R\d+P\d+$/i));
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
      designation: drawLane?.team_name?.match(/^R\d+P\d+$/i) ? drawLane.team_name : '',
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

  // Parse all Players.
  const players = [...doc.querySelectorAll('Players > Player')].map(p => {
    const t = (sel) => p.querySelector(sel)?.textContent || '';
    return {
      lane: parseInt(t('Lane'), 10),
      rank: parseInt(t('Rank'), 10),
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
    const raw = Number.isFinite(p.realScoreMs) ? msToTime(p.realScoreMs, timeMode) : '';
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
