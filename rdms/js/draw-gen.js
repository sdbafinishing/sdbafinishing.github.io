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
import { patchXlsxCells, resizeLaneRowsXlsx, setPageHeaderXlsx, setPrintLayoutXlsx, setContentFontArialXlsx } from './xlsx-patcher.js';
import { parsePlaceholder } from './placeholders.js';
import { pooledTimeStandings, sumTimeStandings } from './time-standings.js';
import raceTemplateUrl from '../templates/race-template.xlsx?url';

let _drawTemplateBytes = null;
async function loadDrawTemplate() {
  if (_drawTemplateBytes) return _drawTemplateBytes;
  const res = await fetch(raceTemplateUrl);
  if (!res.ok) throw new Error(`Failed to load draw template: ${res.status}`);
  _drawTemplateBytes = await res.arrayBuffer();
  return _drawTemplateBytes;
}

/**
 * Scan a single race for placeholder lanes that can be resolved. Understands
 * all three placeholder forms (see js/placeholders.js):
 *   - single (R{n}P{p})      — legacy single-race position (default/unscored).
 *   - pooled (R{list}P{p})   — combined-time rank across races (method #1).
 *   - sum    (SUMR{list}P{p})— sum-of-times rank across races (method #2).
 *
 * `source_race` / `source_position` are kept for backward compatibility (they
 * reflect the single-race case); `kind` + `races` carry the full descriptor.
 *
 * @param {number} raceNumber
 * @returns {Promise<Array<{lane_number, kind, races, position, source_race, source_position, raw}>>}
 */
export async function findPlaceholdersForRace(raceNumber) {
  const lanes = await getLaneResults(raceNumber);
  const out = [];
  for (const lr of lanes) {
    const cells = [lr.team_name || '', lr.team_code || ''];
    for (const c of cells) {
      const ph = parsePlaceholder(c);
      if (ph) {
        out.push({
          lane_number: lr.lane_number,
          kind: ph.kind,
          races: ph.races,
          position: ph.position,
          source_race: ph.races[0],      // legacy field (single-race callers)
          source_position: ph.position,  // legacy field
          raw: ph.raw,
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

  // Pre-fetch every distinct source race (across ALL placeholder kinds — a
  // pooled/sum placeholder references several races) so we don't hit IndexedDB
  // repeatedly. batchDeltaMs per race is needed so the pooled/sum standings use
  // the same effective time the result sheet exports.
  const config = await getConfig();
  const timeMode = config?.time_format_mode || 'mss00';
  const sourceRaceNums = [...new Set(placeholders.flatMap(p => p.races))];
  const lanesByRace = new Map();
  const batchByRace = new Map();
  for (const rn of sourceRaceNums) {
    lanesByRace.set(rn, await getLaneResults(rn));
    const srcRace = await getRace(rn);
    batchByRace.set(rn, srcRace?.batch_override_enabled ? (srcRace.batch_delta_ms || 0) : 0);
    if (!srcRace) {
      warnings.push(`Race ${rn} not found — placeholders pointing at it cannot be resolved.`);
    } else if (!['exported', 'sent'].includes(srcRace.status)) {
      warnings.push(`Race ${rn} status is "${srcRace.status}" (not exported yet) — results may not be final.`);
    }
  }

  // Build the racesLanes shape the standings engine expects for a race list.
  const racesLanesFor = (races) => races.map(rn => ({
    race_number: rn,
    lanes: lanesByRace.get(rn) || [],
    batchDeltaMs: batchByRace.get(rn) || 0,
  }));

  // Cache pooled / sum standings per distinct race-list so a draw that
  // references the same combined field many times only computes it once.
  const pooledCache = new Map();
  const sumCache = new Map();
  const pooledFor = (races) => {
    const key = races.join(',');
    if (!pooledCache.has(key)) pooledCache.set(key, pooledTimeStandings(racesLanesFor(races), timeMode));
    return pooledCache.get(key);
  };
  const sumFor = (races) => {
    const key = races.join(',');
    if (!sumCache.has(key)) sumCache.set(key, sumTimeStandings(racesLanesFor(races), timeMode));
    return sumCache.get(key);
  };

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

    // Resolve the winning team for this placeholder by kind.
    let winner = null;       // { team_name, team_code }
    let tie = false;
    if (ph.kind === 'single') {
      // Legacy/default path — unchanged: position within one race.
      const srcLanes = lanesByRace.get(ph.races[0]) || [];
      winner = srcLanes.find(l => l.computed_position === ph.position) || null;
    } else if (ph.kind === 'pooled') {
      const standing = pooledFor(ph.races);
      const e = standing.entries.find(x => x.position === ph.position);
      if (e) winner = { team_name: e.team_name, team_code: e.team_code };
      if (standing.unresolvedTies.some(x => x.position === ph.position)) tie = true;
    } else if (ph.kind === 'sum') {
      const standing = sumFor(ph.races);
      const t = standing.teams.find(x => x.overall_rank === ph.position);
      if (t) winner = { team_name: t.team_name, team_code: t.team_code };
      if (standing.unresolvedTies.some(x => x.overall_rank === ph.position)) tie = true;
    }

    if (tie) {
      warnings.push(`Lane ${lr.lane_number}: position ${ph.position} of "${ph.raw}" is an unbroken tie — resolve manually before relying on this draw.`);
    }
    if (!winner || !winner.team_name) {
      warnings.push(`Lane ${lr.lane_number}: "${ph.raw}" has no team at position ${ph.position} yet — left as-is.`);
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
    config?.event_official_name_en || config?.event_long_name_en || '',
    config?.event_official_name_tc || config?.event_long_name_tc || '',
  );
  templateBytes = setPrintLayoutXlsx(templateBytes);
  templateBytes = setContentFontArialXlsx(templateBytes);
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
    config?.event_official_name_en || config?.event_long_name_en || '',
    config?.event_official_name_tc || config?.event_long_name_tc || '',
  );
  templateBytes = setPrintLayoutXlsx(templateBytes);
  templateBytes = setContentFontArialXlsx(templateBytes);
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
