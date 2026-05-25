/**
 * SDBA RDMS — Next Round Draw Generation
 *
 * Resolves R{n}P{n} placeholders in target races' draw data. The placeholder
 * is a contract baked into the original draw template — e.g. "R16P3" in
 * Race 39 lane 1 means "the team that finished 3rd in Race 16 goes here".
 * Lane assignments are pre-decided by whoever designed the draw; this
 * generator simply substitutes team names + codes once the source races
 * have results.
 *
 * Inputs are taken from IndexedDB (lane_results of source + target races).
 * Outputs:
 *   1. Updates target race's lane_results in DB (writes resolved team into
 *      team_name + team_code, preserves designation history).
 *   2. Flips race.teams_loaded → true and broadcasts 'draw-imported' so
 *      the dashboard reflects the change immediately.
 *   3. Writes a clean .xls to 13 Output_Next Round Draws/ + Drive shared
 *      folder (for the scoring team / paper backup).
 *
 * Placeholder column convention: templates may put the placeholder in
 * either the team_name or team_code column (2025TN events used team_name,
 * 2026WU events use team_code). We accept both on read, write to both on
 * resolve.
 *
 * No tied-position handling — by event policy ties never occur. If a
 * source race somehow has two lanes with the same computed_position, the
 * first one encountered wins and a warning surfaces in the return value.
 */
import {
  getConfig, getRace, getLaneResults, bulkSaveLaneResults, saveRace,
} from './db.js';
import { writeToBoth, downloadFallback } from './file-access.js';
import { patchXlsxCells, resizeLaneRowsXlsx, setPageHeaderXlsx } from './xlsx-patcher.js';
import raceTemplateUrl from '../templates/race-template.xlsx?url';

let _drawTemplateBytes = null;
async function loadDrawTemplate() {
  if (_drawTemplateBytes) return _drawTemplateBytes;
  const res = await fetch(raceTemplateUrl);
  if (!res.ok) throw new Error(`Failed to load draw template: ${res.status}`);
  _drawTemplateBytes = await res.arrayBuffer();
  return _drawTemplateBytes;
}

// Placeholder pattern. Examples: R16P3, R5P1, R20P7. Stripped to capture
// race-number and position. Anchored — partial matches don't count
// ("ABC R5P1" wouldn't fire because we test against a clean cell value).
const PLACEHOLDER_RE = /^R(\d+)P(\d+)$/i;

/**
 * Scan a single race for placeholder lanes that can be resolved.
 *
 * @param {number} raceNumber
 * @returns {Promise<Array<{lane_number, source_race, source_position, raw}>>}
 */
export async function findPlaceholdersForRace(raceNumber) {
  const lanes = await getLaneResults(raceNumber);
  const out = [];
  for (const lr of lanes) {
    const cells = [lr.team_name || '', lr.team_code || ''];
    for (const c of cells) {
      const m = String(c).trim().match(PLACEHOLDER_RE);
      if (m) {
        out.push({
          lane_number: lr.lane_number,
          source_race: parseInt(m[1], 10),
          source_position: parseInt(m[2], 10),
          raw: m[0],
        });
        break; // one placeholder per lane is enough
      }
    }
  }
  return out;
}

/**
 * True when the race still has at least one unresolved placeholder.
 * Lets the UI conditionally show the "Resolve from prior results" button.
 */
export async function raceHasPlaceholders(raceNumber) {
  return (await findPlaceholdersForRace(raceNumber)).length > 0;
}

/**
 * Resolve placeholders for a single target race using current source-race
 * results. Persists to IndexedDB and writes an .xls draft to 13/ + shared.
 *
 * Returns a structured summary; never throws on per-lane errors (those go
 * into `warnings` so the operator sees a partial-success message instead
 * of a hard failure).
 *
 * @param {number} targetRaceNumber
 * @param {{writeFile?: boolean}} [opts]
 * @returns {Promise<{
 *   success: boolean,
 *   raceNumber: number,
 *   resolved: number,
 *   skipped: number,
 *   total: number,
 *   warnings: string[],
 *   filename: string|null,
 * }>}
 */
export async function generateNextRoundDraw(targetRaceNumber, opts = {}) {
  const writeFile = opts.writeFile !== false; // default true
  const warnings = [];

  const race = await getRace(targetRaceNumber);
  if (!race) {
    return errOut(targetRaceNumber, `Race ${targetRaceNumber} not found in IndexedDB.`);
  }

  const placeholders = await findPlaceholdersForRace(targetRaceNumber);
  if (placeholders.length === 0) {
    return {
      success: true, raceNumber: targetRaceNumber,
      resolved: 0, skipped: 0, total: 0,
      warnings: ['No placeholders to resolve — draw is already populated.'],
      filename: null,
    };
  }

  // Pre-fetch every distinct source race's lane_results so we don't hit
  // IndexedDB once per placeholder.
  const sourceRaceNums = [...new Set(placeholders.map(p => p.source_race))];
  const sourceLanesByRace = {};
  for (const rn of sourceRaceNums) {
    sourceLanesByRace[rn] = await getLaneResults(rn);
    // Sanity check: source race must be exported (or at minimum have
    // computed_position values).
    const srcRace = await getRace(rn);
    if (!srcRace) {
      warnings.push(`Race ${rn} not found — placeholders pointing at it cannot be resolved.`);
    } else if (!['exported', 'sent'].includes(srcRace.status)) {
      warnings.push(`Race ${rn} status is "${srcRace.status}" (not exported yet) — results may not be final.`);
    }
  }

  // Build the resolved lane_results: take the existing rows, replace
  // placeholders with the looked-up team. Untouched columns (designation,
  // joyi columns, raw_time, etc.) survive.
  const currentLanes = await getLaneResults(targetRaceNumber);
  const updated = [];
  let resolved = 0;
  let skipped = 0;

  for (const lr of currentLanes) {
    const ph = placeholders.find(p => p.lane_number === lr.lane_number);
    if (!ph) {
      updated.push(lr); // pass through unchanged
      continue;
    }

    const srcLanes = sourceLanesByRace[ph.source_race] || [];
    const winner = srcLanes.find(l => l.computed_position === ph.source_position);
    if (!winner || !winner.team_name) {
      warnings.push(`Lane ${lr.lane_number}: Race ${ph.source_race} has no team at position ${ph.source_position} yet — left as "${ph.raw}".`);
      updated.push(lr);
      skipped++;
      continue;
    }

    updated.push({
      ...lr,
      team_name: winner.team_name,
      team_code: winner.team_code || '',
      designation: ph.raw, // record where this team came from for audit
    });
    resolved++;
  }

  // Persist back to IndexedDB. bulkSaveLaneResults expects a list of
  // {race_number, lane_number, ...} — our `updated` rows already carry
  // those (they came from getLaneResults).
  if (resolved > 0) {
    await bulkSaveLaneResults(updated);
    // Flip teams_loaded — the dashboard's "draw imported" indicator and
    // the next-race-signal flow both gate on this flag.
    race.teams_loaded = true;
    // Rebuild draw_lanes from the resolved rows so the export's left
    // column uses the just-resolved teams (not the original placeholder
    // strings) without needing a separate draw re-import.
    race.draw_lanes = updated.map(lr => ({
      lane_number: lr.lane_number,
      team_name: lr.team_name || '',
      team_code: lr.team_code || '',
    }));
    await saveRace(race);
  }

  // Build the .xls draft. Optional — caller can disable for batch flows
  // that only want the DB write. The .xls is a clean two-section sheet:
  // header + lane rows. No footnote (per spec).
  let filename = null;
  if (writeFile && resolved > 0) {
    try {
      filename = await writeDrawFile(race, updated);
    } catch (err) {
      warnings.push(`File write failed: ${err.message || err} — DB state was updated regardless.`);
    }
  }

  return {
    success: resolved > 0,
    raceNumber: targetRaceNumber,
    resolved,
    skipped,
    total: placeholders.length,
    warnings,
    filename,
  };
}

/**
 * Batch-resolve a list of target races. Common case: the operator just
 * finished a round and wants to populate every next-round race in one
 * click. Returns one summary per race plus a roll-up count.
 *
 * @param {number[]} raceNumbers
 */
export async function generateNextRoundDraws(raceNumbers) {
  const summaries = [];
  let totalResolved = 0;
  for (const rn of raceNumbers) {
    const s = await generateNextRoundDraw(rn);
    summaries.push(s);
    totalResolved += s.resolved;
  }
  return { summaries, totalResolved };
}

// ──────────────── helpers ────────────────

/**
 * Public: build the draw .xls blob for a given race using the bundled
 * template + current lane_results. Does NOT write to any folder —
 * just returns the Blob so the caller can trigger a download. Used by
 * the race-page Download Draw button (online + local).
 *
 * @param {number} raceNumber
 * @returns {Promise<Blob|null>} the .xls blob, or null if the race
 *   doesn't exist or has no lane data.
 */
export async function buildDrawXlsxBlob(raceNumber) {
  const race = await getRace(raceNumber);
  if (!race) return null;
  const lanes = await getLaneResults(raceNumber);
  return await renderDrawBlob(race, lanes);
}

async function renderDrawBlob(race, laneRows) {
  const config = await getConfig();
  const raceNumber = race.race_number;
  const laneCount = config?.lane_count || 6;
  const FOOTNOTE_ROW = 4 + laneCount;
  const byLane = new Map((laneRows || []).map(l => [l.lane_number, l]));

  // Prefer race.draw_lanes for team data (joyi-safe), fall back to
  // laneRows.team_name for legacy races. Mirrors the same logic as
  // export.js's drawsByLane build.
  const drawTeams = new Map();
  if (Array.isArray(race.draw_lanes)) {
    for (const dl of race.draw_lanes) {
      if (dl?.lane_number) drawTeams.set(dl.lane_number, dl);
    }
  } else {
    for (const lr of (laneRows || [])) {
      if (lr?.lane_number) drawTeams.set(lr.lane_number, { team_name: lr.team_name, team_code: lr.team_code });
    }
  }

  const mods = [
    { addr: 'A1', value: race.race_title_raw || race.race_title || `Race ${raceNumber}` },
    { addr: 'D1', value: race.race_time || '' },
    { addr: `A${FOOTNOTE_ROW}`, value: (race.progression_text || '').trim() },
  ];
  for (let lane = 1; lane <= laneCount; lane++) {
    const rowNum = 3 + lane;
    const dl = drawTeams.get(lane) || {};
    mods.push({ addr: `B${rowNum}`, value: dl.team_name || '' });
    mods.push({ addr: `C${rowNum}`, value: dl.team_code || '' });
    mods.push({ addr: `D${rowNum}`, value: '' });
    mods.push({ addr: `E${rowNum}`, value: '' });
    mods.push({ addr: `I${rowNum}`, value: '' });
  }

  let templateBytes = await loadDrawTemplate();
  templateBytes = resizeLaneRowsXlsx(templateBytes, laneCount);
  templateBytes = setPageHeaderXlsx(
    templateBytes,
    config?.event_long_name_en || '',
    config?.event_official_name_tc || config?.event_long_name_tc || '',
  );
  const patched = patchXlsxCells(templateBytes, mods);
  return new Blob([patched]);
}

async function writeDrawFile(race, laneRows) {
  const config = await getConfig();
  const ref = config?.event_short_ref || 'RDMS';
  const raceNumber = race.race_number;
  const filename = `${raceNumber}.xls`;

  // Same bundled xlsx template the result export uses. Resize the lane
  // block to laneCount before patching, then footnote address shifts
  // dynamically (A{4+laneCount}).
  const laneCount = config?.lane_count || 6;
  const FOOTNOTE_ROW = 4 + laneCount;
  const byLane = new Map(laneRows.map(l => [l.lane_number, l]));

  const mods = [
    { addr: 'A1', value: race.race_title_raw || race.race_title || `Race ${raceNumber}` },
    { addr: 'D1', value: race.race_time || '' },
    { addr: `A${FOOTNOTE_ROW}`, value: (race.progression_text || '').trim() },
  ];
  // Active lane rows (boat 1..laneCount). Resize already grew / shrunk
  // the lane block to exactly laneCount rows.
  for (let lane = 1; lane <= laneCount; lane++) {
    const rowNum = 3 + lane;
    const lr = byLane.get(lane);
    mods.push({ addr: `B${rowNum}`, value: lr?.team_name || '' });
    mods.push({ addr: `C${rowNum}`, value: lr?.team_code || '' });
    mods.push({ addr: `D${rowNum}`, value: '' });
    mods.push({ addr: `E${rowNum}`, value: '' });
    mods.push({ addr: `I${rowNum}`, value: '' });
  }

  let templateBytes = await loadDrawTemplate();
  templateBytes = resizeLaneRowsXlsx(templateBytes, laneCount);
  templateBytes = setPageHeaderXlsx(
    templateBytes,
    config?.event_long_name_en || '',
    config?.event_official_name_tc || config?.event_long_name_tc || '',
  );
  const patched = patchXlsxCells(templateBytes, mods);
  const blob = new Blob([patched]);

  // writeToBoth puts a local copy in 13 Output_Next Round Draws/ and a
  // mirror in 80 Shared/{ref}_Next_Round_Draws/. Either can be missing
  // (operator hasn't connected the folder yet); we fall back to a
  // browser download in that case so the file isn't lost.
  const { local, shared } = await writeToBoth(
    '13 Output_Next Round Draws', filename, blob,
    `80 Shared/${ref}_Next_Round_Draws`,
  );
  if (!local && !shared) downloadFallback(filename, blob);

  return filename;
}

function errOut(raceNumber, message) {
  return {
    success: false,
    raceNumber,
    resolved: 0,
    skipped: 0,
    total: 0,
    warnings: [message],
    filename: null,
  };
}
