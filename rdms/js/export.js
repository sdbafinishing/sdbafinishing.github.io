/**
 * SDBA RDMS — Export Engine
 * Export results to .xls (stamp into original draw file).
 * Generate start lists (Joyi + SprintTimer formats).
 */
import { getConfig, getRace, saveRace, getLaneResults, bulkSaveLaneResults, getAllRaces, getAllDivisions, getDivisionRounds, saveTimesheet, getTimesheet } from './db.js';
import { computeRankings, computeDivisionScoring } from './race.js';
import { computeDivisionStanding, computeTieredStanding } from './division-standing.js';
import { timeToDisplay, msToTime, nowISO, isoToTime, showToast, buildRaceTitle } from './utils.js';
import { broadcastChange } from './app.js';
import { backupAfterExport } from './backup.js';
import { writeToBoth, writeToSourceSubfolder, downloadFallback } from './file-access.js';
import { initDriveApi, isDriveApiConnected, writeDriveFileWithLink } from './drive-api.js';
import { queueRaceSync } from './sync.js';
import { patchXlsxCells, resizeLaneRowsXlsx, setPageHeaderXlsx, setPrintLayoutXlsx, setContentFontArialXlsx, applyRaceParityHeaderStyle, applyHeaderBordersXlsx, applyTextFormatXlsx } from './xlsx-patcher.js';
import raceTemplateUrl from '../templates/race-template.xlsx?url';

// Single bundled xlsx template used for ALL race exports (results + next
// round draws). The xlsx patcher edits cell XML in place, preserving all
// visual formatting (borders, fonts, fills, alignment, merges) bit-for-
// bit. Output is xlsx-content under .xls filename — downstream tools
// sniff content, so the extension lie is invisible.
let _cachedTemplateBytes = null;
async function loadRaceTemplate() {
  if (_cachedTemplateBytes) return _cachedTemplateBytes;
  const res = await fetch(raceTemplateUrl);
  if (!res.ok) throw new Error(`Failed to load race template: ${res.status}`);
  _cachedTemplateBytes = await res.arrayBuffer();
  return _cachedTemplateBytes;
}

/**
 * Format an mss00 raw time string into the dot-separated form used in
 * the source draw files (and printed result sheets):
 *   "10235"  → "1.02.35"
 *   "05591"  → "0.55.91"
 *   "012345" → "1.23.45" (mmss00 mode)
 * Empty / invalid input returns ''.
 */
function timeToDotFormat(raw, timeMode) {
  if (!raw) return '';
  const s = String(raw).replace(/\D/g, '');
  if (!s) return '';
  // mss00 = 5 digits = m ss hh ; mmss00 = 6 digits = mm ss hh
  const isMmss = timeMode === 'mmss00';
  const expected = isMmss ? 6 : 5;
  const padded = s.padStart(expected, '0');
  const minLen = isMmss ? 2 : 1;
  const minStr = padded.slice(0, minLen);
  const secStr = padded.slice(minLen, minLen + 2);
  const hunStr = padded.slice(minLen + 2, minLen + 4);
  return `${parseInt(minStr, 10)}.${secStr}.${hunStr}`;
}

/**
 * Export results for a race.
 * Generates an .xls file with results data and triggers download.
 * For Phase 1: generates a standalone results file.
 * TODO Phase 2: read original draw .xls and stamp results into it.
 *
 * @param {number} raceNumber
 * @param {Object} options - { isRevision: boolean, revisionNote: string }
 * @returns {Object} { success, version }
 */
export async function exportResults(raceNumber, options = {}) {
  const config = await getConfig();
  const race = await getRace(raceNumber);
  const lanes = await getLaneResults(raceNumber);
  const timeMode = config?.time_format_mode || 'mss00';

  if (!race) throw new Error(`Race ${raceNumber} not found`);

  const laneCount = config?.lane_count || 6;

  // Re-run rankings from raw_time across every lane in the DB before
  // exporting. Two real bugs made a fresh recompute necessary:
  //   1. persistCurrentRow on the race page only writes the focused row
  //      back, so when a later entry demotes an earlier row's position,
  //      the earlier row's DB computed_position goes stale (showed up
  //      as duplicated places in the export, e.g. two rows ranked 1).
  //   2. Joyi import writes lane_input + raw_time but doesn't compute
  //      positions; the grid's recalculate runs in memory but never
  //      persists back, so the DB has null computed_position for every
  //      Joyi-imported lane (places came out blank in the export).
  // Apply the persisted batch delta so the exported times + ranks
  // reflect the same shift the operator confirmed on the race page.
  const exportDelta = race.batch_override_enabled ? (race.batch_delta_ms || 0) : 0;
  computeRankings(lanes, timeMode, exportDelta);
  await bulkSaveLaneResults(lanes);

  // Snapshot of drawn teams keyed by boat lane. Source of truth for the
  // export's left-side team list — must reflect the original draw
  // (or next-round-draw resolution), not whatever joyi happened to
  // overwrite into lane_results.team_name. The draw_lanes field is
  // populated at draw-import time and updated when next-round
  // placeholders resolve. For legacy races (imported before this field
  // existed), we fall back to lane_results.team_name.
  const drawsByLane = {};
  if (Array.isArray(race.draw_lanes) && race.draw_lanes.length > 0) {
    race.draw_lanes.forEach(dl => {
      if (dl?.lane_number) {
        drawsByLane[dl.lane_number] = {
          team_code: dl.team_code || '',
          team_name: dl.team_name || '',
        };
      }
    });
  } else {
    lanes.forEach(lr => {
      if (lr.lane_number) {
        drawsByLane[lr.lane_number] = {
          team_code: lr.team_code || '',
          team_name: lr.team_name || '',
        };
      }
    });
  }

  // Pre-export validation (matches VBA ValidateResults)
  const hasInput = lanes.some(l => l.raw_time || l.remarks);
  if (!hasInput) {
    throw new Error('No results input detected. Cannot export empty results.');
  }

  // Lane_input validation — every result row needs a valid, unique, in-range lane.
  // Without this, blank lane_input silently fell back to row index in the output
  // and produced wrong team mappings.
  const laneErrors = [];
  const seenLanes = new Set();
  const resultRows = lanes.filter(l => l.raw_time || l.remarks);
  resultRows.forEach((lr, idx) => {
    const laneStr = (lr.lane_input ?? '').toString().trim();
    if (laneStr === '') {
      laneErrors.push(`Row ${idx + 1}: lane number is required`);
      return;
    }
    const lane = parseInt(laneStr, 10);
    if (!Number.isInteger(lane) || lane < 1 || lane > laneCount) {
      laneErrors.push(`Row ${idx + 1}: lane "${laneStr}" out of range (1–${laneCount})`);
      return;
    }
    if (seenLanes.has(lane)) {
      laneErrors.push(`Row ${idx + 1}: lane ${lane} used more than once`);
      return;
    }
    seenLanes.add(lane);
  });
  if (laneErrors.length > 0) {
    throw new Error(`Cannot export: ${laneErrors.join('; ')}.`);
  }

  // Rank mismatch check uses lane_input lookup for correct team mapping.
  // SOFT block: surface a toast, don't throw — Joyi's place column is
  // occasionally edited by hand after capture and can disagree with the
  // raw-time sort. Operator can review and proceed.
  const mismatches = lanes.filter(l =>
    l.joyi_rank != null && l.computed_position != null && l.joyi_rank !== l.computed_position
  );
  if (mismatches.length > 0) {
    const details = mismatches.map(l => {
      const laneNum = parseInt(l.lane_input, 10) || l.lane_number;
      return `Lane ${laneNum}: pos ${l.computed_position} ≠ Joyi ${l.joyi_rank}`;
    }).join(', ');
    showToast(`Joyi rank disagrees with RDMS rank — exporting anyway. ${details}`, 'warning', 6000);
  }

  // Every drawn team (lane 1..N with a team_name) must be referenced by some
  // result row's lane_input. If a team's lane isn't in the entered results,
  // either the operator forgot to log that boat OR (more often) Joyi
  // didn't report the lane (DNS / scratched). SOFT block: warn and keep
  // going; the missing boat will just have blank Time / Place / Remarks
  // in the exported sheet. Hard-blocking here was blocking export of
  // partial-field races (e.g. only 3 boats showed up to the start).
  const referencedLanes = new Set(
    resultRows.map(l => parseInt(l.lane_input, 10)).filter(Number.isInteger)
  );
  const activeLanes = lanes.slice(0, laneCount);
  const missingResults = activeLanes.filter(l =>
    l.team_name && l.team_name !== '---' && l.team_name !== '' &&
    !referencedLanes.has(l.lane_number)
  );
  if (missingResults.length > 0) {
    const details = missingResults.map(l => `Lane ${l.lane_number} (${l.team_name})`).join(', ');
    showToast(`Drawn boats without a result — exported as blank: ${details}`, 'warning', 6000);
  }

  // Version management
  const prevVersion = race.export_version || 0;
  let newVersion;

  if (prevVersion === 0) {
    // First export
    newVersion = 1;
  } else if (options.isRevision) {
    newVersion = prevVersion + 1;
  } else {
    newVersion = prevVersion; // re-export, same version
  }

  // Build (lane_number → result row) map for cell-stamping below.
  const inputByLane = {};
  resultRows.forEach(r => {
    const lane = parseInt(r.lane_input, 10);
    if (Number.isInteger(lane) && lane >= 1 && lane <= laneCount) {
      inputByLane[lane] = r;
    }
  });

  const ref = config?.event_short_ref || 'RDMS';
  // The exported content is already an xlsx workbook (the bundled
  // race-template.xlsx patched cell-by-cell), so name it .xlsx. The bytes are
  // unchanged from before — only the extension changes.
  const filename = `${raceNumber}.xlsx`;

  // Build the cell-update list. The bundled template has these fixed
  // positions (1-indexed rows; same layout used for every race):
  //   A1  race title
  //   D1  race start time
  //   A4..A10  boat numbers 1..7 (left as-is from the template)
  //   B4..B10  team names
  //   C4..C10  team codes
  //   D4..D10  Time  (m.ss.00)
  //   E4..E10  Place (number) — DSQ/DNS/DNF stays blank here
  //   I4..I10  Remarks (DSQ/DQ/DNS/DNF marker OR free-text)
  //   A11      progression footnote + revision marker (appended)
  // Cols F/G/H (Score / Total Score / Total Place) are cumulative-
  // series fields, not per-race, so they stay blank.
  const MARKER_SET = new Set(['DSQ', 'DQ', 'DNS', 'DNF']);
  // The bundled xlsx template carries 7 hard-coded lane rows. We use
  // resizeLaneRowsXlsx (below, when we actually call the patcher) to
  // grow or shrink that block to laneCount rows. The footnote /
  // signature rows shift accordingly, so the footnote address is no
  // longer a fixed A11 — compute it from laneCount.
  const FOOTNOTE_ROW = 4 + laneCount; // lanes occupy rows 4..(3+laneCount)
  const mods = [];

  // Header: race title (raw, exactly as it appeared in the imported
  // draw's A1) + start time. Fall back to the sanitised title if the
  // raw form is missing (e.g. races created before this field existed).
  mods.push({ addr: 'A1', value: buildRaceTitle(race.race_title_raw || race.race_title, raceNumber) });
  mods.push({ addr: 'D1', value: race.race_time || '' });

  // Cross-round scoring context — populates Score / Total Score / Total
  // Place columns when the race is on a scored chain. Total Score +
  // Total Place are only meaningful AFTER the final round; for R1/R2
  // exports we leave them blank to avoid misleading mid-series totals.
  let scoreCtx = null;       // points model (unchanged path)
  let timeStanding = null;   // time methods (#1/#2) standing, when configured
  let tieredStanding = null; // tiered cups (seeding heats + tier finals)
  let raceIsFinal = false;   // this race sits in a tier (final) round
  let finalShowTotals = false; // final round is itself time-ranked → fill totals
  if (race.division_id) {
    const division = (await getAllDivisions()).find(d => d.id === race.division_id) || null;
    const method = division?.standings_method || 'points';
    const rounds = await getDivisionRounds(race.division_id);
    const isTiered = (rounds || []).some(r => r.tier_order != null && r.tier_order > 0);
    const isTime = method === 'time_sum' || method === 'time_combined';
    const pointsScored = race.scoring_flag && race.scoring_flag !== 'N';
    // Engage scoring when: a points race on a scored chain, OR the division is
    // tiered / time-based. Tiered + time heats carry scoring_flag = N but still
    // feed the Total Time / Total Place columns — shown as "TBC" until the
    // series completes, then filled on re-export.
    if (pointsScored || isTiered || isTime) {
      const allRaces = await getAllRaces();
      let scoredRaces;
      if (isTiered || isTime) {
        // Standing keys off ALL races in the division's rounds (heats included).
        const roundNums = new Set((rounds || []).flatMap(r => r.race_numbers || []));
        scoredRaces = allRaces.filter(r => roundNums.has(r.race_number));
      } else {
        scoredRaces = allRaces.filter(r =>
          r.division_id === race.division_id && r.scoring_flag && r.scoring_flag !== 'N');
      }
      const lanesByRace = new Map();
      for (const r of scoredRaces) {
        lanesByRace.set(r.race_number, await getLaneResults(r.race_number));
      }
      // This very export completes the current race, so reflect that in the
      // completion checks (its DB status flips to 'exported' just below).
      scoredRaces.forEach(r => { if (r.race_number === race.race_number) r.status = 'exported'; });

      if (isTiered) {
        // Gold/Silver/Bronze + Bowl: heats → seeding sum (Total Time / section
        // rank), finals → overall rank. Resolved per-lane in the write block.
        tieredStanding = computeTieredStanding(division, rounds, scoredRaces, lanesByRace, laneCount, timeMode);
        const myRound = (rounds || []).find(r => (r.race_numbers || []).includes(raceNumber));
        raceIsFinal = !!(myRound && myRound.tier_order != null && myRound.tier_order > 0);
        // Only fill Total Score / Total Place on a FINAL sheet when that final
        // genuinely AGGREGATES more than one race by time (a real combined/sum
        // final). A single-race final's "total" just echoes its own Time/Place
        // (cols D/E) — redundant — and a normal-finish final has no total at
        // all, so in both cases leave G/H blank.
        finalShowTotals = !!(myRound
          && (myRound.rank_method === 'time_combined' || myRound.rank_method === 'time_sum')
          && (myRound.race_numbers || []).length > 1);
      } else if (method === 'points') {
        // Points divisions: untouched — exactly as before.
        scoreCtx = computeDivisionScoring(race, allRaces, lanesByRace, laneCount, timeMode);
      } else {
        // Time methods: per-race Time + Place export normally; Total Score /
        // Total Place are "TBC" until the round/series is complete.
        timeStanding = computeDivisionStanding(division, rounds, scoredRaces, lanesByRace, laneCount, timeMode);
      }
    }
  }
  const isRFinal = scoreCtx?.scoringFlag === 'RFinal';

  // Lane rows — resize moves the row structure to match laneCount, so
  // the loop range is the canonical 1..laneCount with no trailing-row
  // cleanup needed.
  for (let lane = 1; lane <= laneCount; lane++) {
    const rowNum = 3 + lane; // lane 1 → row 4
    const drawLane = drawsByLane[lane];
    const lr = inputByLane[lane];

    // Team name (col B) and team code (col C) come from the drawn
    // lane (drawsByLane), not the result row — the result row's
    // team_name/code are only relevant when the operator overrode
    // them, which is unusual.
    mods.push({ addr: `B${rowNum}`, value: drawLane?.team_name || '' });
    mods.push({ addr: `C${rowNum}`, value: drawLane?.team_code || '' });

    if (!lr) {
      // No result entered — blank Time/Place/Remarks
      mods.push({ addr: `D${rowNum}`, value: '' });
      mods.push({ addr: `E${rowNum}`, value: '' });
      mods.push({ addr: `I${rowNum}`, value: '' });
      continue;
    }
    const rawRemark = (lr.remarks ?? '').toString().trim();
    const isMarker = MARKER_SET.has(rawRemark.toUpperCase());

    // Column layout (new):
    //   D (Time): a time string OR the status marker text (DSQ/DQ/DNS/DNF).
    //             Each team must have ONE of the two. Operators see the
    //             status right in the result column — no need to look
    //             across to remarks to find out a boat didn't finish.
    //   E (Place): place number (string) for ranked rows; blank for
    //              markers + unranked rows.
    //   I (Remarks): time penalty ("TP=2s") + any free-text operator
    //                notes. Status marker is NOT duplicated here; it
    //                lives in the Time column only.
    let timeCellValue;
    if (isMarker) {
      timeCellValue = rawRemark.toUpperCase();
    } else if (exportDelta !== 0 && Number.isFinite(lr.effective_time_ms)) {
      // Batch override is on AND we have a finite effective time —
      // export the SHIFTED time so the published sheet matches the
      // race page's adjusted preview. Drop sub-hundredth precision via
      // msToTime → timeToDotFormat (which truncates).
      const shifted = msToTime(lr.effective_time_ms, timeMode);
      timeCellValue = timeToDotFormat(shifted, timeMode);
    } else {
      timeCellValue = timeToDotFormat(lr.raw_time, timeMode);
    }
    mods.push({ addr: `D${rowNum}`, value: timeCellValue });

    // The template's E-column cells use numFmtId="49" (text format @).
    // Writing a numeric value into a text-formatted cell renders blank
    // in some downstream tools. Write Place as a string.
    const placeVal = isMarker ? '' : (lr.computed_position ?? '');
    mods.push({
      addr: `E${rowNum}`,
      value: (placeVal === '' || placeVal == null) ? '' : String(placeVal),
    });

    // Scoring columns (F = Score, G = Total Score, H = Total Place).
    if (scoreCtx) {
      // POINTS model — unchanged. F shown for any scored race; G/H only on the
      // RFinal sheet (mid-series cumulative numbers would mislead viewers).
      const teamCode = drawLane?.team_code || '';
      const teamEntry = teamCode ? scoreCtx.teamTotals.get(teamCode) : null;
      const thisPts = teamEntry?.perRound?.[scoreCtx.scoringFlag]?.pts;
      mods.push({
        addr: `F${rowNum}`,
        value: (thisPts == null || thisPts === '') ? '' : String(thisPts),
      });
      if (isRFinal && teamEntry) {
        mods.push({ addr: `G${rowNum}`, value: String(Math.round(teamEntry.total_weighted)) });
        mods.push({ addr: `H${rowNum}`, value: String(teamEntry.overall_rank) });
      } else {
        mods.push({ addr: `G${rowNum}`, value: '' });
        mods.push({ addr: `H${rowNum}`, value: '' });
      }
    } else if (timeStanding) {
      // TIME methods (#1/#2). The boat's Time + Place (cols D/E) are already
      // written above. There's no per-race "Score", so F is blank. Total Score
      // (= total time for method #2; blank for combined-time) and Total Place
      // are "TBC" until the round/series completes, then fill on re-export.
      const teamCode = drawLane?.team_code || '';
      const entry = teamCode ? timeStanding.teamTotals.get(teamCode) : null;
      mods.push({ addr: `F${rowNum}`, value: '' });
      if (timeStanding.complete && entry) {
        mods.push({ addr: `G${rowNum}`, value: entry.total_display || '' });
        mods.push({ addr: `H${rowNum}`, value: entry.total_place == null ? '' : String(entry.total_place) });
      } else if (entry) {
        // Standing not final yet — placeholder so the scoring team knows it's
        // coming. Combined-time has no Total Score, so only its place is TBC.
        mods.push({ addr: `G${rowNum}`, value: timeStanding.method === 'time_combined' ? '' : 'TBC' });
        mods.push({ addr: `H${rowNum}`, value: 'TBC' });
      } else {
        mods.push({ addr: `G${rowNum}`, value: '' });
        mods.push({ addr: `H${rowNum}`, value: '' });
      }
    } else if (tieredStanding) {
      // TIERED cups. F (per-race score) is blank. Heat sheets show the seeding
      // SUM as Total Time (G) + section rank (H); final sheets show the tier's
      // Total Time (G) + OVERALL rank (H). "TBC" until that phase completes.
      const teamCode = drawLane?.team_code || '';
      mods.push({ addr: `F${rowNum}`, value: '' });
      if (raceIsFinal && !finalShowTotals) {
        // Normal-finish final — the boat's Place (col E) is the result.
        mods.push({ addr: `G${rowNum}`, value: '' });
        mods.push({ addr: `H${rowNum}`, value: '' });
      } else if (raceIsFinal) {
        const entry = teamCode ? tieredStanding.teamByCode?.get(teamCode) : null;
        if (entry && entry.overall_rank != null) {
          mods.push({ addr: `G${rowNum}`, value: entry.value_display || '' });
          mods.push({ addr: `H${rowNum}`, value: String(entry.overall_rank) });
        } else if (entry) {
          mods.push({ addr: `G${rowNum}`, value: entry.value_display || 'TBC' });
          mods.push({ addr: `H${rowNum}`, value: 'TBC' });
        } else {
          mods.push({ addr: `G${rowNum}`, value: '' });
          mods.push({ addr: `H${rowNum}`, value: '' });
        }
      } else {
        const seed = tieredStanding.seeding;
        const entry = seed && teamCode ? seed.rows.find(r => r.team_code === teamCode) : null;
        if (entry && seed.complete) {
          mods.push({ addr: `G${rowNum}`, value: entry.value_display || '' });
          mods.push({ addr: `H${rowNum}`, value: entry.section_rank == null ? '' : String(entry.section_rank) });
        } else if (entry) {
          mods.push({ addr: `G${rowNum}`, value: 'TBC' });
          mods.push({ addr: `H${rowNum}`, value: 'TBC' });
        } else {
          mods.push({ addr: `G${rowNum}`, value: '' });
          mods.push({ addr: `H${rowNum}`, value: '' });
        }
      }
    }

    // Remarks: penalty + free-text notes only. If lr.remarks is *just*
    // a status marker, it's already in column D — omit from remarks.
    const remarkPieces = [];
    if (lr.penalty_time) {
      const tp = String(lr.penalty_time).trim();
      if (tp && tp !== '0') remarkPieces.push(`TP=${tp}s`);
    }
    if (!isMarker && rawRemark) remarkPieces.push(rawRemark);
    mods.push({ addr: `I${rowNum}`, value: remarkPieces.join(' ') });
  }

  // Footnote (A11). Always rewrite with the race's progression text so
  // the bundled template's race-1 default doesn't leak into other
  // races. When this is a revision, append the revision marker on a
  // new line. The patcher's append:true path is reserved for cases
  // where the bundled template's footnote IS the base — here we always
  // override.
  const progressionBase = (race.progression_text || '').trim();
  let footnoteValue = progressionBase;
  if (newVersion > 1) {
    const revStamp = `Results v${newVersion} (revised ${isoToTime(nowISO())})${options.revisionNote ? ' — ' + options.revisionNote : ''}`;
    footnoteValue = footnoteValue ? `${footnoteValue}\n${revStamp}` : revStamp;
  }
  mods.push({ addr: `A${FOOTNOTE_ROW}`, value: footnoteValue });

  // Patch the bundled xlsx template and emit under .xls filename.
  // Resize the lane block to match the event's configured lane count
  // BEFORE patching cells. resizeLaneRowsXlsx clones / drops lane rows
  // and shifts the footnote + signature rows accordingly; the mod list
  // above already targets the post-resize footnote address.
  let templateBytes = await loadRaceTemplate();
  templateBytes = resizeLaneRowsXlsx(templateBytes, laneCount);
  // Stamp the dynamic page header (printed at the top of every page when Excel
  // renders the sheet). Use the OFFICIAL long names (T2) — the short
  // event_long_name_en was showing instead of the official title. Falls back to
  // the short names for events that never set the official ones.
  templateBytes = setPageHeaderXlsx(
    templateBytes,
    config?.event_official_name_en || config?.event_long_name_en || '',
    config?.event_official_name_tc || config?.event_long_name_tc || '',
  );
  // T1/T5: give the header room (top margin) + fit to one A4 page.
  templateBytes = setPrintLayoutXlsx(templateBytes);
  // T3: Latin text → Arial (Chinese cells keep their CJK font).
  templateBytes = setContentFontArialXlsx(templateBytes);
  // T4: title row coloured by race parity (odd = FFC000 bg/black, even = white/red).
  templateBytes = applyRaceParityHeaderStyle(templateBytes, raceNumber);
  // Bold box borders on the header blocks (A1:C1, D1:I1, D2:H3). MUST run after
  // parity (clones the parity-coloured row-1 styles, adding borders).
  templateBytes = applyHeaderBordersXlsx(templateBytes, laneCount);
  // Header font sizes + alignment (rows 1-3 centred, team-name/remarks left).
  templateBytes = applyTextFormatXlsx(templateBytes, laneCount);
  const patched = patchXlsxCells(templateBytes, mods);
  const xlsBlob = new Blob([patched]);
  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const sharedSub = `80 Shared/${ref}_Output_Results`;

  // #4 (approach A) — when the Drive API is connected, write the SHARED copy
  // via the API so we get the file ID immediately and can put a per-race
  // DIRECT-DOWNLOAD link in the WhatsApp message (one-click download for the
  // scoring team, not a folder). Re-export updates the SAME file → the link is
  // stable, and Drive syncs it DOWN to the mounted shared folder so manual
  // edit-and-override still works. The local copy is written via FS for instant
  // print/open. FALLBACK: if Drive isn't connected (or the API write fails),
  // write to the mounted folder exactly as before and use the folder link.
  let local = false, shared = false, directUrl = null;
  let driveConn = false;
  // initDriveApi() restores the access token from sessionStorage on a fresh page
  // load — isDriveApiConnected() alone returns false until that runs, which is
  // why a re-export after reload was falling back to the folder link even though
  // Setup showed "Connected". Returns the live connection state.
  try { driveConn = await initDriveApi(); } catch { driveConn = false; }
  if (!driveConn) { try { driveConn = isDriveApiConnected(); } catch { /* ignore */ } }

  if (driveConn) {
    try { local = !!(await writeToSourceSubfolder('12 Output_Results', filename, xlsBlob)); }
    catch (err) { console.warn('local results write failed:', err); }
    try {
      const res = await writeDriveFileWithLink(sharedSub, filename, xlsBlob, XLSX_MIME);
      if (res?.directUrl) { directUrl = res.directUrl; shared = true; }
      else { showToast('Drive API write returned no link — used folder', 'warning', 3500); }
    } catch (err) { console.warn('Drive API result write failed:', err); showToast('Drive API write failed — used folder', 'warning', 3500); }
    if (!shared) {
      // API shared write failed — fall back to the mounted-folder write so the
      // result still reaches the shared folder (folder link in the message).
      try {
        const both = await writeToBoth('12 Output_Results', filename, xlsBlob, sharedSub);
        local = local || !!both.local; shared = !!both.shared;
      } catch (err) { console.warn('fallback writeToBoth failed:', err); }
    }
  } else {
    const both = await writeToBoth('12 Output_Results', filename, xlsBlob, sharedSub);
    local = !!both.local; shared = !!both.shared;
  }

  // Persist the direct link (or clear it when Drive isn't the writer) so the
  // WhatsApp message prefers it over the generic folder link.
  race.result_direct_url = directUrl;

  if (!local) {
    downloadFallback(filename, xlsBlob);
  }

  if (directUrl) {
    showToast(`Results saved + direct link ready`, 'info', 2000);
  } else if (local && shared) {
    showToast(`Results saved to local + shared`, 'info', 2000);
  } else if (local) {
    showToast(`Results saved locally`, 'info', 2000);
  }

  // Update race + timesheet in a single transaction (atomic)
  const now = nowISO();
  race.export_time = now;
  race.export_version = newVersion;
  race.status = race.status === 'sent' ? 'sent' : 'exported';

  if (!race.export_history) race.export_history = [];
  race.export_history.push({
    version: newVersion,
    timestamp: now,
    is_revision: options.isRevision || false,
    revision_note: options.revisionNote || '',
  });

  const { db } = await import('./db.js');
  // db.config must be in the transaction scope because saveRace and
  // saveTimesheet both call assertNotLocked() which reads from it.
  // Without this, the transaction throws "object store not found"
  // since Dexie restricts table access to the declared scope.
  await db.transaction('rw', db.races, db.timesheet, db.config, async () => {
    await saveRace(race);
    const ts = await getTimesheet(raceNumber) || { race_number: raceNumber };
    if (!ts.export_time) { ts.export_time = now; } else { ts.re_export_time = now; }
    await saveTimesheet(ts);
  });

  broadcastChange('race-updated', { race_number: raceNumber });

  // Two-phase reminder for time-scored divisions (soft, non-blocking):
  //   - while the round/series is incomplete, the totals on this sheet are TBC;
  //   - once it completes (this export being the last leg), the earlier sheets
  //     still say TBC and need a re-export to fill the totals + overall ranks.
  if (timeStanding) {
    if (timeStanding.unresolvedTie) {
      showToast('Scoring tie could not be broken automatically — resolve manually before relying on the totals.', 'warning', 7000);
    }
    if (timeStanding.complete) {
      showToast('Round/series complete — re-export this division’s other sheets to fill in Total Place/Score (they currently show TBC).', 'warning', 8000);
    } else {
      showToast('Time-scored division: Total Place/Score show TBC until the round/series is complete, then re-export.', 'info', 5000);
    }
  }

  // Post-commit side effects are BEST-EFFORT. The export is already durably
  // committed above (file written + export_time/version + timesheet in a
  // transaction). If any of these throw, exportResults must STILL resolve
  // successfully — otherwise the caller's try/catch swallows the error and
  // skips the follow-on send (onComplete writes send_time to the race + the
  // timesheet), leaving the race "exported but not sent".
  // Fire-and-forget — do NOT await. The export is already committed above, so
  // a slow Drive write (saturated upload queue on a weak network) must never
  // freeze the Export & Send button. Backup still runs after EVERY export
  // (it's <500 KB), just off the critical path.
  backupAfterExport(raceNumber).catch(err =>
    console.warn('Auto-backup after export failed (non-fatal):', err));
  queueRaceSync(raceNumber).catch(err =>
    console.warn('queueRaceSync after export failed (non-fatal):', err));

  // Round-completion check (fire-and-forget). If the round this race
  // belongs to is now fully exported AND auto-prompt is enabled in config,
  // the operator gets a modal offering to generate next-round draws.
  // Failures here never block export; the module logs internally.
  import('./round-completion.js')
    .then(m => m.checkRoundCompletionAfterExport(raceNumber))
    .catch(err => console.warn('round-completion check failed', err));

  return { success: true, version: newVersion, filename };
}

/**
 * Detect GENUINE ties — lanes that will share the same Place in the export.
 *
 * Buckets by the actual computed_position (not the displayed raw_time), so it
 * mirrors exactly what the export ranks. This respects everything the ranking
 * uses to break ties: raw_time_ms (Joyi thousandths — two lanes showing the
 * same hundredth but different thousandth get DIFFERENT places, so they are
 * NOT a tie), penalty_time, and the batch delta. Also means a manual override
 * on the results grid that changes the order clears the warning.
 *
 * Returns [{ time, place, lanes:[laneNum,...] }] for any place shared by 2+
 * lanes. Empty array when there are no real ties.
 */
async function detectDuplicateTimes(raceNumber) {
  const config = await getConfig();
  const race = await getRace(raceNumber);
  const lanes = await getLaneResults(raceNumber);
  const timeMode = config?.time_format_mode || 'mss00';
  const exportDelta = race?.batch_override_enabled ? (race.batch_delta_ms || 0) : 0;
  // Same ranking the export applies — sets computed_position using raw_time_ms
  // when present.
  computeRankings(lanes, timeMode, exportDelta);

  const byPlace = new Map();
  for (const lr of lanes) {
    if (lr.computed_position == null) continue; // unranked: DSQ/DNS/no-time/dummy
    if (!byPlace.has(lr.computed_position)) byPlace.set(lr.computed_position, []);
    byPlace.get(lr.computed_position).push(lr);
  }

  const dupes = [];
  for (const [place, ls] of byPlace) {
    if (ls.length > 1) {
      dupes.push({
        time: ls[0].raw_time,
        place,
        lanes: ls.map(l => l.lane_input || l.lane_number),
      });
    }
  }
  return dupes;
}

/**
 * Show a confirm modal listing the duplicate-time lanes. Returns a
 * promise that resolves true (proceed) or false (cancel).
 */
function confirmDuplicateTimes(dupes) {
  return new Promise(resolve => {
    const existing = document.getElementById('exportDupeModal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'exportDupeModal';
    modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
    modal.innerHTML = `
      <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:22px; max-width:480px; width:100%; box-shadow:var(--shadow-lg);">
        <h5 style="font-size:16px; font-weight:600; margin:0 0 12px; color:var(--warning);">
          <i class="material-icons" style="vertical-align:middle;">warning</i> Duplicate finish times
        </h5>
        <p style="font-size:13px; color:var(--text-secondary); margin:0 0 10px;">
          The following lanes have identical times — they will share the same Place in the export:
        </p>
        <ul style="font-size:13px; margin:0 0 14px; padding-left:20px; color:var(--text-primary);">
          ${dupes.map(d => `<li><strong>${d.time}</strong> — lanes ${d.lanes.join(', ')}</li>`).join('')}
        </ul>
        <p style="font-size:12px; color:var(--text-tertiary); margin:0 0 14px;">
          Confirm this is the intended result (e.g. genuine photo-finish tie). Cancel to return and adjust.
        </p>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button class="btn btn-ghost" id="dupeCancel">Cancel</button>
          <button class="btn btn-primary" id="dupeConfirm">Confirm tie — proceed</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('#dupeCancel').addEventListener('click', () => { modal.remove(); resolve(false); });
    modal.querySelector('#dupeConfirm').addEventListener('click', () => { modal.remove(); resolve(true); });
  });
}

/**
 * Show the export modal (re-export vs revision).
 * @param {number} raceNumber
 * @param {function} onComplete - Called after export completes
 */
export async function showExportModal(raceNumber, onComplete) {
  const race = await getRace(raceNumber);
  const hasExported = race && race.export_version > 0;

  // Tie detection — surfaces before either branch of the export flow.
  // If duplicates exist, get explicit operator confirmation before
  // continuing. They CAN proceed (genuine ties are legal), but the
  // confirm step prevents accidental ties from data-entry mistakes
  // slipping through.
  const dupes = await detectDuplicateTimes(raceNumber);
  if (dupes.length > 0) {
    const proceed = await confirmDuplicateTimes(dupes);
    if (!proceed) return;
  }

  if (!hasExported) {
    // First export — no modal needed
    try {
      const result = await exportResults(raceNumber);
      showToast(`Race ${raceNumber} exported (v${result.version})`, 'success');
      if (onComplete) onComplete();
    } catch (err) {
      showToast(`Export failed: ${err.message}`, 'error');
    }
    return;
  }

  // Show re-export vs revision modal
  // Remove any existing orphaned modal first
  const existingModal = document.getElementById('exportModal');
  if (existingModal) existingModal.remove();

  const modal = document.createElement('div');
  modal.id = 'exportModal';
  modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9998; display:flex; align-items:center; justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:24px; max-width:400px; width:90%; box-shadow:var(--shadow-lg);">
      <h5 style="font-size:16px; font-weight:600; margin-bottom:16px;">Race ${raceNumber} — Already Exported (v${race.export_version})</h5>
      <div style="margin-bottom:16px;">
        <label style="display:flex; align-items:center; gap:8px; margin-bottom:8px; cursor:pointer;">
          <input type="radio" name="exportType" value="reexport" checked>
          <span>Re-export (same version, no changes)</span>
        </label>
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="radio" name="exportType" value="revision">
          <span>Revision (results were corrected)</span>
        </label>
      </div>
      <div id="revisionNoteGroup" style="display:none; margin-bottom:16px;">
        <label class="form-label">Revision note</label>
        <input class="form-input" id="revisionNote" type="text" placeholder="e.g. Lane 3 time corrected">
      </div>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button class="btn btn-ghost" id="exportCancel">Cancel</button>
        <button class="btn btn-primary" id="exportConfirm">Export</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Toggle revision note visibility
  modal.querySelectorAll('input[name="exportType"]').forEach(radio => {
    radio.addEventListener('change', () => {
      document.getElementById('revisionNoteGroup').style.display =
        radio.value === 'revision' && radio.checked ? 'block' : 'none';
    });
  });

  modal.querySelector('#exportCancel').addEventListener('click', () => modal.remove());
  modal.querySelector('#exportConfirm').addEventListener('click', async () => {
    const isRevision = modal.querySelector('input[name="exportType"]:checked').value === 'revision';
    const revisionNote = document.getElementById('revisionNote')?.value || '';
    modal.remove();

    try {
      const result = await exportResults(raceNumber, { isRevision, revisionNote });
      showToast(`Race ${raceNumber} exported (v${result.version})`, 'success');
      if (onComplete) onComplete();
    } catch (err) {
      showToast(`Export failed: ${err.message}`, 'error');
    }
  });
}
