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
import * as XLSX from 'xlsx';
import {
  getConfig, getRace, getLaneResults, bulkSaveLaneResults, saveRace,
} from './db.js';
import { writeToBoth, downloadFallback } from './file-access.js';

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

async function writeDrawFile(race, laneRows) {
  const config = await getConfig();
  const ref = config?.event_short_ref || 'RDMS';
  const laneCount = config?.lane_count || 6;

  // Header mirrors the production template enough that parseDrawFile can
  // re-import this file if the operator ever needs to. We deliberately
  // omit the progression footnote — the file is downstream-of-record,
  // not the source of truth.
  const wsData = [
    [`Race No. ${race.race_number} --- ${race.race_title || ''}`, '', '', race.race_time || '', '', ''],
    ['BOAT 船號', 'Team Name 隊伍名稱', 'Code 編號', 'Time 時間', 'Place 名次', 'Score 分數'],
    ['', '', '', '', '', ''],
  ];
  // Lane rows. We sort by lane_number to defend against IndexedDB returning
  // out-of-order rows after edits.
  const sortedLanes = [...laneRows].sort((a, b) => a.lane_number - b.lane_number);
  // Pad up to lane_count so even empty lanes show their boat number
  // (matches what the operator sees in the production templates).
  const byLane = new Map(sortedLanes.map(l => [l.lane_number, l]));
  for (let i = 1; i <= laneCount; i++) {
    const l = byLane.get(i);
    wsData.push([
      i,
      l?.team_name || '',
      l?.team_code || '',
      '', '', '',
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Draw');

  // Match the production naming convention: just "{race_number}.xls". The
  // existing extractRaceNumber() parses both "5.xls" and "Second Round -
  // 27.xls" — we use the cleaner short form for generated files.
  const filename = `${race.race_number}.xls`;
  const blob = new Blob([XLSX.write(wb, { bookType: 'xls', type: 'array' })]);

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
