/**
 * SDBA RDMS — Race Sheet Page
 * Individual race processing: input grid, timing, validation, export.
 */
import { getRace, saveRace, getLaneResults, saveLaneResult, bulkSaveLaneResults, getConfig, saveTimesheet, getTimesheet, getAllRaces, getAllDivisions } from '../db.js';
import { ExcelGrid } from '../grid.js';
import { computeRankings, calcBatchDelta, validateRace, getEffectiveStartTime, positionToPoints, computeVarianceWarnings } from '../race.js';
import { timeToMs, msToTime, timeToDisplay, isValidTime, nowISO, nowDisplay, isoToTime, showToast } from '../utils.js';
import { broadcastChange } from '../app.js';
import { showExportModal } from '../export.js';
import { sendToWhatsApp } from '../whatsapp.js';
import { promptNextRaceSignal, signalNextRace, notifyResultEntryStarted } from '../next-race-signal.js';
import { isLcdPending, awaitLcd, onPendingChange } from '../joyi-lcd-pending.js';
import { parseJoyiFile, importJoyiToDb } from '../import.js';
import { printResult, printDraw, openFileFromFolder } from '../print.js';
import { renderMiniSignalPanel, cleanupMiniSignalPanel } from './signal-panel.js';
import { generateNextRoundDraw } from '../draw-gen.js';
import { hasPermission } from '../rbac.js';

let grid = null;
let raceNumber = null;
let raceData = null;
let configData = null;
let timerInterval = null;
let batchDeltaMs = 0;
let saveDebounceTimer = null;
let batchDebounceTimer = null;
let joyiChangeHandler = null;
let p1InputHandler = null;
let unsubLcdPending = null;
// Immutable per-mount snapshot of the original draws (lane_number → team info).
// Used so the output table's team column follows the user-entered lane_input,
// not the row index. See "lane input bug" in the audit.
let drawsByLane = {};
// Whether the operator has explicitly opted in to applying the batch P1
// override to computed positions. Off by default — capturing P1 (via FINISH
// or manual entry) only shows the delta until the operator flips this on.
let batchOverrideEnabled = false;

// Scoring context for the currently-mounted race — populated only when
// the race has a non-N scoring_flag. Drives the extra Score / Total /
// Overall Place columns in the output table + the reference scoreboard
// rendered below it. null when the race isn't scored.
let scoringCtx = null;

// Variance context — cross-race data needed by computeVarianceWarnings.
// Built on mount + refreshed whenever a race-updated broadcast fires.
// Kept in module state so renderValidation can stay synchronous (it
// runs on every cell change). null until the first build completes.
let varianceCtx = null;

async function buildVarianceCtx() {
  try {
    const { getAllRaces, getAllDivisionRounds, getAllDivisionProgressions, getLaneResults } = await import('../db.js');
    const allRaces = await getAllRaces();
    const divRounds = typeof getAllDivisionRounds === 'function' ? await getAllDivisionRounds() : [];
    const divProgs = typeof getAllDivisionProgressions === 'function' ? await getAllDivisionProgressions() : [];
    const allLaneResultsByRace = new Map();
    for (const r of allRaces) {
      try { allLaneResultsByRace.set(r.race_number, await getLaneResults(r.race_number)); }
      catch { /* skip individual fetch failures */ }
    }
    varianceCtx = { allRaces, allLaneResultsByRace, divRounds, divProgs };
  } catch (err) {
    console.warn('buildVarianceCtx failed:', err);
    varianceCtx = null;
  }
}

// Build (or refresh) the scoring context for the current race.
// Returns null when not applicable (race is N / no scored races in
// division yet). Otherwise:
//   {
//     scoringFlag,        // 'R1' | 'R2' | 'RFinal'
//     multiplier,         // weighting used in the tiebreak (sum)
//     laneCount,
//     scoredRaces,        // [race objects in division with R*-flag] sorted R1/R2/RFinal
//     teamTotals,         // Map<team_code, { team_name, team_code, perRound:{R1:{pts,wtd,pos,raw_time,remarks}, ...}, total_weighted, overall_rank }>
//   }
async function buildScoringContext(race, configData) {
  if (!race?.scoring_flag || race.scoring_flag === 'N') return null;
  if (!race.division_id) return null;
  const laneCount = configData?.lane_count || 6;
  const allRaces = await getAllRaces();
  const scoredRaces = allRaces
    .filter(r => r.division_id === race.division_id && r.scoring_flag && r.scoring_flag !== 'N')
    .sort((a, b) => {
      const order = { 'R1': 1, 'R2': 2, 'RFinal': 3 };
      return (order[a.scoring_flag] || 99) - (order[b.scoring_flag] || 99);
    });
  if (scoredRaces.length === 0) return null;
  const multipliers = { 'R1': 1.0000001, 'R2': 1.00001, 'RFinal': 1.001 };

  // Aggregate teams across all scored rounds — keyed by team_code (the
  // join key that survives Joyi's team_name overwrite). Display name
  // comes from race.draw_lanes per the audit fix.
  const drawLanesByRace = {};
  for (const r of scoredRaces) {
    const rec = allRaces.find(x => x.race_number === r.race_number);
    drawLanesByRace[r.race_number] = Array.isArray(rec?.draw_lanes) ? rec.draw_lanes : [];
  }

  const teamTotals = new Map();
  const timeMode = configData?.time_format_mode || 'mss00';
  const { getLaneResults: _getLanes } = await import('../db.js');
  for (const r of scoredRaces) {
    const lanes = await _getLanes(r.race_number);
    // Rank from raw_time — the stored computed_position can be null after a
    // Joyi re-import, which would silently score the race 0 points.
    computeRankings(lanes, timeMode, r.batch_override_enabled ? (r.batch_delta_ms || 0) : 0);
    for (const lr of lanes) {
      if (!lr.team_name || lr.team_name === '---' || lr.team_name === '') continue;
      const boatLane = parseInt(lr.lane_input, 10) || lr.lane_number;
      const drawTeam = drawLanesByRace[r.race_number].find(dl => dl.lane_number === boatLane);
      const displayName = drawTeam?.team_name || lr.team_name;
      const teamCode = drawTeam?.team_code || lr.team_code || lr.team_name;
      const key = teamCode || displayName;
      if (!teamTotals.has(key)) {
        teamTotals.set(key, { team_name: displayName, team_code: teamCode || '', perRound: {}, total_weighted: 0 });
      }
      const pts = positionToPoints(lr.computed_position, laneCount);
      const mult = multipliers[r.scoring_flag] || 1;
      const wtd = pts * mult;
      const entry = teamTotals.get(key);
      entry.perRound[r.scoring_flag] = {
        pts, wtd, position: lr.computed_position, raw_time: lr.raw_time || '', remarks: lr.remarks || '',
      };
      entry.total_weighted += wtd;
    }
  }

  // Overall rank
  const sortedTeams = [...teamTotals.values()].sort((a, b) => b.total_weighted - a.total_weighted);
  sortedTeams.forEach((t, i) => {
    if (i > 0 && t.total_weighted === sortedTeams[i - 1].total_weighted) {
      t.overall_rank = sortedTeams[i - 1].overall_rank;
    } else {
      t.overall_rank = i + 1;
    }
  });

  return {
    scoringFlag: race.scoring_flag,
    multiplier: multipliers[race.scoring_flag] || 1,
    laneCount,
    scoredRaces,
    teamTotals,
  };
}

// Rebuild drawsByLane from the current race + lane_results. Must be called
// after any import that changes either race.draw_lanes (draw import,
// next-round resolve) or lane_results (joyi import) so the output preview
// reflects fresh data without remounting the page.
//
// Source of truth, in order:
//   1. race.draw_lanes (set at draw-import time; survives joyi imports)
//   2. lane_results.team_name (fallback for legacy races without the
//      draw_lanes field).
function rebuildDrawsByLane(race, laneResults) {
  drawsByLane = {};
  const drawLanesMap = {};
  if (Array.isArray(race?.draw_lanes)) {
    race.draw_lanes.forEach(dl => {
      if (dl?.lane_number) drawLanesMap[dl.lane_number] = dl;
    });
  }
  (laneResults || []).forEach(lr => {
    if (lr.lane_number) {
      const drawTeam = drawLanesMap[lr.lane_number];
      drawsByLane[lr.lane_number] = {
        team_code: drawTeam ? (drawTeam.team_code || '') : (lr.team_code || ''),
        team_name: drawTeam ? (drawTeam.team_name || '') : (lr.team_name || ''),
        joyi_rank: lr.joyi_rank ?? null,
      };
    }
  });
}

export async function mountRacePage(container, params) {
  // Defensive: clean up any previous mount that wasn't properly unmounted
  unmountRacePage();

  raceNumber = parseInt(params[0], 10);
  if (!raceNumber || raceNumber < 1) {
    // No race specified — show a picker so the Race nav tab is useful on
    // first click, instead of showing an "Invalid race number" dead-end.
    await renderRacePicker(container);
    return;
  }

  configData = await getConfig();
  raceData = await getRace(raceNumber);
  // Build scoring context up-front; renderOutput uses it to add the
  // Score / Total / Overall Place columns when the race is scored.
  scoringCtx = raceData ? await buildScoringContext(raceData, configData) : null;
  // Build variance context (cross-race data for cohort + per-team
  // continuity checks). Fire-and-forget — renderValidation degrades
  // gracefully when varianceCtx is still null on the first paint.
  buildVarianceCtx().catch(() => {});

  if (!raceData) {
    container.innerHTML = `<div class="card"><p>Race ${raceNumber} not found. Import draws first.</p></div>`;
    return;
  }

  // Walk the actual race set to find adjacent races — race numbers can have
  // gaps and the highest race number isn't always laneCount * something.
  // Without this, the "Race N+1 →" link points at a race that doesn't
  // exist and dead-ends with "Race N+1 not found".
  const allRaceNums = (await getAllRaces()).map(r => r.race_number).sort((a, b) => a - b);
  const prevRaceNum = [...allRaceNums].reverse().find(n => n < raceNumber) ?? null;
  const nextRaceNum = allRaceNums.find(n => n > raceNumber) ?? null;

  const laneCount = configData?.lane_count || 6;
  const timeMode = configData?.time_format_mode || 'mss00';
  const laneResults = await getLaneResults(raceNumber);

  // Resolve the division this race belongs to (for the colour swatch).
  let divisionInfo = null;
  if (raceData.division_id) {
    const divs = await getAllDivisions();
    divisionInfo = divs.find(d => d.id === raceData.division_id) || null;
  }
  const divColour = divisionInfo?.colour_hex || '#9ca3af';
  const divLabel = divisionInfo ? (divisionInfo.division_name || '') : '';

  // Restore persisted batch-adjustment state so the toggle + delta
  // survive a page reload / navigation away-and-back. Without this the
  // export would silently lose the operator's batch override on the
  // next session.
  batchOverrideEnabled = !!raceData?.batch_override_enabled;
  batchDeltaMs = Number.isFinite(raceData?.batch_delta_ms) ? raceData.batch_delta_ms : 0;

  // Snapshot draws keyed by the actual boat lane. Output uses this so changing
  // lane_input remaps the team correctly (previously the row index won).
  rebuildDrawsByLane(raceData, laneResults);

  // Detect R{n}P{n} placeholders in either column (templates park them in
  // team_name on some events, team_code on others). When present, expose
  // a "Resolve from prior results" button in the nav row.
  //
  // We also gate the button on the source races' status — if any of the
  // referenced races (R{n} in the placeholder) hasn't been exported yet,
  // the button stays visible but disabled with a tooltip naming the
  // missing race(s). Visible-but-disabled is more discoverable than
  // hidden ("why isn't this option available?").
  const placeholderRe = /^R(\d+)P\d+$/i;
  const placeholderSourceRaces = new Set();
  for (const lr of laneResults) {
    for (const cell of [(lr.team_name || '').trim(), (lr.team_code || '').trim()]) {
      const m = cell.match(placeholderRe);
      if (m) placeholderSourceRaces.add(parseInt(m[1], 10));
    }
  }
  const hasPlaceholders = placeholderSourceRaces.size > 0;
  // Which source races aren't ready? Status must be exported or sent
  // (cancelled doesn't help — its lanes have no computed_position).
  const placeholderSourceRacesNotReady = [];
  if (hasPlaceholders) {
    const allRaces = await getAllRaces();
    const byNum = new Map(allRaces.map(r => [r.race_number, r]));
    for (const srcNum of placeholderSourceRaces) {
      const src = byNum.get(srcNum);
      if (!src || !['exported', 'sent'].includes(src.status)) {
        placeholderSourceRacesNotReady.push(srcNum);
      }
    }
    placeholderSourceRacesNotReady.sort((a, b) => a - b);
  }
  const canResolveNow = hasPlaceholders && placeholderSourceRacesNotReady.length === 0;

  container.innerHTML = `
    <!-- Race Header — odd/even shaded to match the race-list striping. -->
    <div class="card race-page-header" style="margin-bottom:8px; padding:10px 14px; ${raceNumber % 2 === 1 ? 'background: rgba(250, 204, 21, 0.10);' : ''}">
      <div class="race-header-row" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:12px;">
        <div class="race-header-title" style="display:flex; align-items:center; gap:10px;">
          <span title="${divLabel}" style="display:inline-block; width:10px; height:32px; border-radius:3px; background:${divColour}; flex-shrink:0;"></span>
          <div>
            <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:0.5px;">Race</div>
            <div style="font-size:22px; font-weight:700; line-height:1.1;">${raceNumber}</div>
            <div style="font-size:13px; color:var(--text-secondary); margin-top:2px; max-width:340px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${(raceData.race_title || 'Untitled').replace(/"/g, '&quot;')}">${raceData.race_title || 'Untitled'}</div>
          </div>
        </div>
        <div class="race-header-times" style="display:grid; grid-template-columns:repeat(4, auto); gap:14px; text-align:center;">
          <div>
            <div style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase;">Sched</div>
            <div style="font-size:13px; font-weight:500;">${raceData.race_time || '—'}</div>
          </div>
          <div>
            <div style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase;">Start</div>
            <div style="font-size:13px; font-weight:500; color:var(--success);" id="raceStartTime">${renderStartTimeText(raceData)}</div>
            <!-- Inline pending chip: shown while a sibling .lcd is being
                 fetched in the background after a Joyi import. Auto-hides
                 once joyi_start_time lands or the fetch fails. -->
            <div id="raceJoyiPending" style="display:none; align-items:center; gap:4px; font-size:10px; color:#7dd3fc; margin-top:2px;">
              <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#7dd3fc; opacity:0.9; animation:pf-pulse 1.2s ease-in-out infinite;"></span>
              Joyi start time loading…
            </div>
          </div>
          <div>
            <div style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase;">Export</div>
            <div style="font-size:13px; font-weight:500;" id="raceExportTime">${renderExportTimeText(raceData)}</div>
          </div>
          <div>
            <div style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase;">Send</div>
            <div style="font-size:13px; font-weight:500;" id="raceSendTime">${renderSendTimeText(raceData)}</div>
          </div>
        </div>
        <div class="race-header-status" style="display:flex; flex-direction:column; align-items:flex-end; gap:2px;">
          <div class="race-header-status-row" style="display:flex; gap:8px; align-items:center;">
            <span class="badge badge-${raceData.status}" id="raceStatus">${raceData.status?.toUpperCase() || 'PENDING'}</span>
            <!-- Mini digital flag — RC+ST dots (read-only) + Finishing toggle.
                 Finishing is the primary user of this race page, so it's the
                 only one the operator can flip from here. -->
            <span id="raceHeaderMiniFlag" style="display:inline-flex; align-items:stretch;"></span>
            <span id="raceTimer" style="font-size:18px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--accent);"></span>
          </div>
          <button class="btn btn-ghost" id="stopCounterBtn" onclick="window._stopCounter()" title="Stop the running counter (data is preserved)"
                  style="font-size:11px; padding:1px 8px; ${raceData.status === 'started' && (raceData.start_time || raceData.joyi_start_time) ? '' : 'display:none;'}">
            <i class="material-icons" style="font-size:14px;">pause</i> Stop
          </button>
        </div>
      </div>
    </div>

    <!-- Navigation — odd/even tint on the prev/next buttons matches the
         race-table striping so the operator can tell parity at a glance.
         Buttons only render when the adjacent race actually exists in
         the loaded set — no more "Race N not found" dead-ends. -->
    <div class="race-page-nav" style="display:flex; gap:6px; margin-bottom:6px; flex-wrap:wrap; align-items:center;">
      ${prevRaceNum != null
        ? `<a href="#/race/${prevRaceNum}" class="btn btn-outline btn-sm" style="${prevRaceNum % 2 === 1 ? 'background: rgba(250, 204, 21, 0.12);' : ''}"><i class="material-icons" style="font-size:16px;">chevron_left</i> Race ${prevRaceNum}</a>`
        : `<button class="btn btn-outline btn-sm" disabled style="opacity:0.4;" title="No previous race"><i class="material-icons" style="font-size:16px;">chevron_left</i></button>`}
      ${nextRaceNum != null
        ? `<a href="#/race/${nextRaceNum}" class="btn btn-outline btn-sm" style="${nextRaceNum % 2 === 1 ? 'background: rgba(250, 204, 21, 0.12);' : ''}">Race ${nextRaceNum} <i class="material-icons" style="font-size:16px;">chevron_right</i></a>`
        : `<button class="btn btn-outline btn-sm" disabled style="opacity:0.4;" title="No next race"><i class="material-icons" style="font-size:16px;">chevron_right</i></button>`}
      <span style="border-left:1px solid var(--border); height:20px; margin:0 4px;"></span>
      <button class="btn btn-ghost btn-sm" onclick="window._printDraw()" title="Print draw"><i class="material-icons" style="font-size:16px;">description</i> Print Draw</button>
      <button class="btn btn-ghost btn-sm" onclick="window._downloadDraw()" title="Download draw as .xls"><i class="material-icons" style="font-size:16px;">download</i> Download Draw</button>
      <button class="btn btn-ghost btn-sm" onclick="window._photoFinish()" title="Open Joyi photo-finish image (.lcd + .jyd) — interactive crop view">
        <i class="material-icons" style="font-size:16px;">photo_camera</i> Photo Finish
      </button>
      <button class="btn btn-ghost btn-sm" onclick="window._photoFinishPng()" title="Quick view of the finish image — fast, works on local + online">
        <i class="material-icons" style="font-size:16px;">image</i> Quick View
      </button>
      ${hasPlaceholders && hasPermission('race.import_draw') ? (canResolveNow
        ? `<button class="btn btn-outline btn-sm" onclick="window._resolvePlaceholders()"
                  title="Replace R{n}P{n} placeholders with actual teams from the source races' results."
                  style="color:var(--accent);">
            <i class="material-icons" style="font-size:16px;">auto_fix_high</i> Resolve from prior results
          </button>`
        : `<button class="btn btn-ghost btn-sm" disabled
                  title="Waiting for source race${placeholderSourceRacesNotReady.length === 1 ? '' : 's'} ${placeholderSourceRacesNotReady.join(', ')} to be exported before placeholders can be resolved.">
            <i class="material-icons" style="font-size:16px;">hourglass_empty</i> Awaiting Race ${placeholderSourceRacesNotReady.slice(0, 3).join(', ')}${placeholderSourceRacesNotReady.length > 3 ? '…' : ''}
          </button>`
      ) : ''}
      <div style="flex:1;"></div>
      ${raceData.status === 'cancelled'
        ? `<button class="btn btn-outline btn-sm" onclick="window._reviveRace()"
                  style="color:var(--success); border-color:var(--success);"
                  title="Restore this cancelled race. Status returns to PENDING (or STARTED if a start time was already recorded). Lane results and start/joyi/export history are untouched.">
            <i class="material-icons" style="font-size:16px;">restart_alt</i> Revive Race
          </button>`
        : `<button class="btn btn-danger btn-outline btn-sm" onclick="window._cancelRace()">
            Cancel Race
          </button>`
      }
    </div>

    <!-- START / RESTART + FINISH row (70:30) -->
    ${hasPermission('race.start') ? `
    <div style="display:flex; gap:6px; margin-bottom:8px;" id="startStopWrap"></div>
    ` : ''}

    <!-- Results Input Section -->
    <div class="card race-results-input" style="margin-bottom:8px; padding:10px 14px;">
      <div class="section-header-row" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px; gap:8px; flex-wrap:wrap;">
        <div class="section-header section-header-inline" style="margin:0; border:none;">
          <span class="section-header-main">Results Input</span>
          <span class="section-header-hint" style="font-weight:400; color:var(--text-tertiary);"> — must be in finishing order</span>
        </div>
        <div style="display:flex; gap:6px;">
          ${hasPermission('race.input') ? `
          <button class="btn btn-ghost" onclick="window._clearInputs()"
                  style="cursor:pointer; font-size:12px; padding:3px 10px; color:var(--danger);"
                  title="Clear all input cells (Lane, Time, TP, Remarks). Keeps team draws + race state untouched.">
            <i class="material-icons" style="font-size:16px;">backspace</i> Clear Inputs
          </button>
          ` : ''}
          ${configData?.shared_joyi_folder || hasPermission('race.import_joyi') ? `
          <button class="btn btn-outline" onclick="window._importJoyi()"
                  style="cursor:pointer; font-size:12px; padding:3px 10px;"
                  title="Auto-finds .jyd / .xls / .lcd in the Joyi folder for this race; falls back to drag-drop.">
            <i class="material-icons" style="font-size:16px;">cloud_download</i> Import Joyi
          </button>
          ` : ''}
        </div>
      </div>
      <div id="inputGridContainer"></div>
    </div>

    <!-- Batch Adjustment — collapsed by default, fallback for the FINISH capture -->
    <details style="margin-bottom:8px; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-sm);">
      <summary style="cursor:pointer; padding:6px 14px; font-size:12px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-tertiary); user-select:none;">
        Batch Adjustment (Backup)
      </summary>
      <div style="padding:8px 14px 10px; display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
        <div class="form-group" style="margin:0;">
          <label class="form-label">P1 Time (${timeMode})</label>
          <input class="form-input" id="batchP1Time" type="text" style="width:120px; font-family:monospace;"
                 placeholder="${timeMode === 'mmss00' ? '000000' : '00000'}">
        </div>
        <div>
          <div class="form-label">Difference</div>
          <span id="batchDelta" style="font-family:monospace; font-size:14px;">0.00.00</span>
        </div>
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none;"
               title="If on, every row's effective time is shifted by Difference before ranking.">
          <input type="checkbox" id="batchOverrideToggle" style="margin:0;">
          <span style="font-size:13px;">Apply batch adjustment</span>
        </label>
      </div>
    </details>

    <!-- Validation -->
    <div id="validationPanel" style="margin-bottom:8px;"></div>

    <!-- Results Output Section -->
    <div class="card race-results-output" style="margin-bottom:8px; padding:10px 14px;">
      <div class="section-header-row" style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
        <div class="section-header section-header-inline" style="margin:0; border:none;">Results Output</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          ${hasPermission('race.export') ? `
          ${configData?.whatsapp_group
            ? `<button class="btn btn-primary" onclick="window._exportAndSend()"><i class="material-icons">send</i> Export & Send</button>`
            : ''}
          <button class="btn ${configData?.whatsapp_group ? 'btn-outline' : 'btn-primary'}" onclick="window._exportOnly()"><i class="material-icons">save</i> Export Only</button>
          ` : ''}
          ${hasPermission('race.send') && configData?.whatsapp_group ? `
          <button class="btn btn-outline" onclick="window._sendOnly()"><i class="material-icons">chat</i> Send Only</button>
          ` : ''}
          <span style="border-left:1px solid var(--border); margin:0 2px;"></span>
          <button class="btn btn-ghost" onclick="window._printResult()" title="Print result"><i class="material-icons">print</i></button>
          <button class="btn btn-ghost" onclick="window._openResult()" title="Open result file"><i class="material-icons">open_in_new</i></button>
        </div>
      </div>
      <div id="outputTableContainer" class="race-output-scroll" style="overflow-x:auto; -webkit-overflow-scrolling:touch;"></div>
    </div>

    <!-- Blocking overlay: only shown when the operator has started result
         entry / clicked FINISH but the Joyi LCD fetch hasn't finished yet.
         The fetch is usually < 1 s, so this appears momentarily; longer
         delays warrant the wait so the elapsed-time delta is correct. -->
    <div id="raceJoyiBlock" style="display:none; position:fixed; inset:0; z-index:9000;
                                   background:rgba(15,23,42,0.55); backdrop-filter:blur(2px);
                                   align-items:center; justify-content:center;">
      <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:20px 24px;
                  box-shadow:var(--shadow-lg); display:flex; gap:14px; align-items:center; max-width:420px;">
        <span style="display:inline-block; width:18px; height:18px; border-radius:50%;
                     border:3px solid rgba(125,211,252,0.35); border-top-color:#7dd3fc;
                     animation:pf-spin 0.9s linear infinite;"></span>
        <div>
          <div style="font-weight:600; font-size:14px;">Waiting for Joyi start time…</div>
          <div style="font-size:12px; color:var(--text-tertiary); margin-top:2px;">
            The finish-time delta depends on the Joyi-derived race start.
            This usually takes &lt; 1 s.
          </div>
        </div>
      </div>
    </div>
    <style>
      @keyframes pf-pulse { 0%,100% { opacity:0.4 } 50% { opacity:1 } }
      @keyframes pf-spin  { to { transform:rotate(360deg) } }
    </style>
  `;

  // Build input grid
  const gridData = buildGridData(laneResults, laneCount);
  const canEdit = hasPermission('race.input');
  const gridColumns = buildGridColumns(timeMode, canEdit);

  grid = new ExcelGrid(document.getElementById('inputGridContainer'), {
    rowCount: laneCount,
    columns: gridColumns,
    data: gridData,
    onChange: onCellChange,
    // Strict validation runs on cell blur (after change), not on every
    // keystroke. The first digit you type is always "invalid" against
    // the full mss00 format, so flagging mid-typing is noise. The blur
    // recompute calls the same recalculate() — it just sees focusedRow
    // === null and so applies the -2 flags to every row.
    onBlur: onCellBlur,
  });

  // Initial ranking
  recalculate();

  // Start the running timer if the race has begun via either source.
  // Joyi-derived start counts too — operator may have skipped the manual
  // click and we should still tick.
  if (raceData.start_time || raceData.joyi_start_time) {
    startTimer();
  }

  // Attach handlers
  attachHandlers();

  // Render the START/RESTART + FINISH button row now that handlers are wired.
  if (hasPermission('race.start')) renderStartStopButton();

  // Subscribe to the LCD-pending tracker so the inline chip near the
  // Start cell reflects in-flight Joyi background fetches. When the
  // pending set changes, refresh visibility for THIS race only.
  refreshJoyiPendingChip();
  unsubLcdPending = onPendingChange(refreshJoyiPendingChip);

  // Refresh start-time display + chip when our race is updated from
  // another tab (e.g. the joyi-watch loop finished its LCD fetch).
  window.addEventListener('rdms-race-updated', _onRaceUpdateRefresh);

  // Mount the mini digital flag in the race header. Fire-and-forget — the
  // panel handles its own Firebase init failure gracefully.
  renderMiniSignalPanel('raceHeaderMiniFlag').catch(() => {});
}

// Refresh the inline pending chip + start-time display for the current race.
function refreshJoyiPendingChip() {
  const chip = document.getElementById('raceJoyiPending');
  if (!chip || !raceNumber) return;
  chip.style.display = isLcdPending(raceNumber) ? 'inline-flex' : 'none';
}

// Listen for cross-tab race-updated broadcasts (joyi-watch finished an
// LCD fetch in another tab, or auto-imported joyi results in the same
// tab → refresh our display in place, no full remount needed).
async function _onRaceUpdateRefresh(ev) {
  const detail = ev.detail || {};
  if (detail.race_number !== raceNumber) return;
  // Reload race + lane_results and re-render the affected pieces.
  const fresh = await getRace(raceNumber);
  if (!fresh) return;
  raceData = fresh;

  // Pull the freshest lane_results from DB and push them through the grid
  // + drawsByLane map + bottom output preview. Without this, the joyi-
  // watch's background import lands in the DB but the operator only
  // sees the new times after navigating away and back.
  if (grid) {
    try {
      const freshLanes = await getLaneResults(raceNumber);
      const newGridData = buildGridData(freshLanes, configData?.lane_count || 6);
      for (let i = 0; i < newGridData.length; i++) {
        grid.setRowData(i, newGridData[i]);
      }
      rebuildDrawsByLane(raceData, freshLanes);
      // Rebuild scoring context too — joyi import on this race changes
      // computed_position, which feeds the Score/Total columns.
      scoringCtx = await buildScoringContext(raceData, configData);
      // Refresh variance ctx so cohort means / team continuity use
      // the latest results from other races.
      buildVarianceCtx().catch(() => {});
      recalculate();
    } catch (err) {
      console.warn('Race-page refresh failed:', err);
    }
  }

  const startEl = document.getElementById('raceStartTime');
  if (startEl) startEl.innerHTML = renderStartTimeText(raceData);
  renderStartStopButton();
  refreshJoyiPendingChip();
  // Re-anchor the running timer if joyi_start_time just landed.
  if (raceData.start_time || raceData.joyi_start_time) {
    if (!timerInterval) startTimer();
  }

  // #7 — fresh Joyi RESULTS import on the race we're viewing: if it's clean,
  // auto-open Export & Send so the operator just pastes the WhatsApp message.
  if (detail.joyi_results) {
    maybeAutoExportOnCleanJoyi().catch(() => {});
  }
}

// Races whose clean-Joyi auto-export has already fired this session — guards
// against re-firing on repeated broadcasts for the same import.
const _autoExportFired = new Set();

/**
 * #7 — auto-open the Export & Send flow when a Joyi results import lands
 * clean on the currently-viewed race. Tightly gated to avoid surprise
 * exports:
 *   • opt-out escape hatch (config.auto_export_on_clean_joyi === false)
 *   • not already exported (don't auto re-export — operator drives revisions)
 *   • there are actually rankable results
 *   • zero validation errors AND zero warnings (no missing team, no tight
 *     finish, no ties, no variance flags)
 *   • no modal already open; fires at most once per race per session
 */
async function maybeAutoExportOnCleanJoyi() {
  if (!grid || !raceData) return;
  if (configData?.auto_export_on_clean_joyi === false) return;
  if (_autoExportFired.has(raceNumber)) return;
  if (raceData.export_version > 0) return;
  if (document.getElementById('exportModal') ||
      document.getElementById('rdmsWhatsAppModal') ||
      document.getElementById('connectFolderPromptModal') ||
      document.getElementById('watcherPromptModal')) return;

  const data = grid.getData();
  if (!data.some(r => r.computed_position != null)) return;

  const result = computeRaceValidation(data);
  // A missing start time does NOT block auto export+send — as long as results
  // are present we can publish. (Joyi often hasn't stamped the start yet, or
  // the operator never clicked START.) Every other warning/error still blocks.
  const blockingWarnings = result.warnings.filter(w => !/no start time/i.test(w));
  if (result.errors.length > 0 || blockingWarnings.length > 0) return;

  _autoExportFired.add(raceNumber);
  showToast('Joyi results clean — opening Export & Send…', 'info', 2500);
  if (typeof window._exportAndSend === 'function') {
    await window._exportAndSend();
  }
}

export function unmountRacePage() {
  // Clear all timers
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  clearTimeout(saveDebounceTimer); saveDebounceTimer = null;
  clearTimeout(batchDebounceTimer); batchDebounceTimer = null;

  // Destroy grid
  if (grid) { grid.destroy(); grid = null; }

  // joyiChangeHandler is unused now (the <input> was replaced by a button
  // + drag-drop modal) — kept the ref-clear here in case any half-mounted
  // state remains. The modal cleans up its own handlers on close.
  joyiChangeHandler = null;

  const p1Input = document.getElementById('batchP1Time');
  if (p1Input && p1InputHandler) {
    p1Input.removeEventListener('input', p1InputHandler);
  }
  p1InputHandler = null;

  // Detach the joyi-pending subscriber + cross-tab listener.
  if (typeof unsubLcdPending === 'function') {
    try { unsubLcdPending(); } catch {}
    unsubLcdPending = null;
  }
  window.removeEventListener('rdms-race-updated', _onRaceUpdateRefresh);

  // Tear down the mini-flag Firebase listener so it doesn't leak across mounts.
  try { cleanupMiniSignalPanel(); } catch {}

  // Clear state
  raceNumber = null;
  raceData = null;
  batchDeltaMs = 0;
  batchOverrideEnabled = false;
  drawsByLane = {};
  scoringCtx = null;

  // Clean up window handlers
  delete window._startRace;
  delete window._stopCounter;
  delete window._cancelRace;
  delete window._reviveRace;
  delete window._resetStart;
  delete window._resetRace;
  delete window._clearInputs;
  delete window._resolvePlaceholders;
  delete window._importJoyi;
  delete window._finishBackup;
  delete window._toggleStartSource;
  delete window._exportAndSend;
  delete window._exportOnly;
  delete window._sendOnly;
  delete window._printResult;
  delete window._printDraw;
  delete window._downloadDraw;
  delete window._openDraw;
  delete window._openResult;
  delete window._photoFinish;
  delete window._photoFinishPng;
}

/**
 * Render a race picker when the Race nav tab is clicked without a race number.
 * Lists every race grouped by status with quick links, instead of the old
 * "Invalid race number" dead-end.
 */
async function renderRacePicker(container) {
  const allRaces = await getAllRaces();
  const divisions = await getAllDivisions();
  const divMap = Object.fromEntries(divisions.map(d => [d.id, d]));

  if (!allRaces || allRaces.length === 0) {
    container.innerHTML = `<div class="card" style="text-align:center; padding:40px;">
      <i class="material-icons" style="font-size:48px; color:var(--text-tertiary);">event_busy</i>
      <h3 style="margin-top:12px;">No races loaded</h3>
      <p style="color:var(--text-tertiary);">Go to <a href="#/import">Im/Export → Import Draws</a> first.</p>
    </div>`;
    return;
  }

  const sorted = [...allRaces].sort((a, b) => a.race_number - b.race_number);
  const statusBadge = (s) => {
    const map = {
      pending: ['badge-pending', 'PENDING'],
      started: ['badge-started', 'STARTED'],
      exported: ['badge-exported', 'EXPORTED'],
      sent: ['badge-sent', 'SENT'],
      cancelled: ['badge-cancelled', 'CANCELLED'],
    };
    const [cls, label] = map[s] || ['badge-pending', (s || 'PENDING').toUpperCase()];
    return `<span class="badge ${cls}">${label}</span>`;
  };

  container.innerHTML = `
    <div class="card" style="padding:16px;">
      <div class="section-header" style="margin-bottom:12px;">Pick a race</div>
      <table class="race-table" style="width:100%;">
        <thead><tr>
          <th style="text-align:left;">#</th>
          <th style="text-align:left;">Title</th>
          <th style="text-align:left;">Division</th>
          <th style="text-align:left;">Sched</th>
          <th style="text-align:left;">Status</th>
          <th></th>
        </tr></thead>
        <tbody>
          ${sorted.map(r => {
            const div = r.division_id ? divMap[r.division_id] : null;
            const divCol = div?.colour_hex || '#9ca3af';
            const divName = div ? (div.division_name || '') : '';
            return `<tr>
              <td><strong>${r.race_number}</strong></td>
              <td>${r.race_title || '—'}</td>
              <td><span class="division-color" style="background:${divCol};"></span>${divName}</td>
              <td style="color:var(--text-tertiary);">${r.race_time || ''}</td>
              <td>${statusBadge(r.status)}</td>
              <td><a href="#/race/${r.race_number}" class="btn btn-outline" style="padding:4px 12px; font-size:12px;">Open</a></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function buildGridColumns(timeMode, canEdit = true) {
  const timeLen = timeMode === 'mmss00' ? 6 : 5;
  return [
    { key: 'lane_input', label: 'Lane', editable: canEdit, type: 'input', width: 50, maxLength: 2, placeholder: '#' },
    { key: 'raw_time', label: `Time (${timeMode})`, editable: canEdit, type: 'input', width: 90, maxLength: timeLen, placeholder: '0'.repeat(timeLen) },
    { key: 'penalty_time', label: 'TP (s)', editable: canEdit, type: 'input', width: 60, placeholder: '' },
    { key: 'display_time', label: 'Format', editable: false, type: 'computed', width: 80, format: (v) => v || '' },
    { key: 'computed_position', label: 'Place', editable: false, type: 'computed', width: 50, format: (v) => v ?? '' },
    { key: 'remarks', label: 'Remarks', editable: canEdit, type: 'input', width: 100, maxLength: 40,
      placeholder: '',
      suggestions: ['DNF', 'DSQ', 'DNS', 'DQ'],
    },
    { key: 'validation', label: 'Valid?', editable: false, type: 'computed', width: 50,
      format: (v) => {
        if (v === 1) return '\u25CF'; // green dot (styled via CSS)
        if (v === -2) return '\u2716'; // red X
        return '';
      }
    },
  ];
}

function buildGridData(laneResults, laneCount) {
  const data = [];
  for (let i = 0; i < laneCount; i++) {
    const lr = laneResults.find(r => r.lane_number === i + 1) || {};
    data.push({
      lane_input: lr.lane_input || '',
      raw_time: lr.raw_time || '',
      raw_time_ms: lr.raw_time_ms ?? null,
      penalty_time: lr.penalty_time || '',
      display_time: '',
      computed_position: null,
      remarks: lr.remarks || '',
      validation: null,
      // Preserve DB fields
      lane_number: i + 1,
      race_number: raceNumber,
      team_code: lr.team_code || '',
      team_name: lr.team_name || '',
      joyi_rank: lr.joyi_rank || null,
    });
  }
  return data;
}

function onCellChange(rowIndex, colKey, newValue, rowData) {
  const timeMode = configData?.time_format_mode || 'mss00';

  // Update display time
  if (colKey === 'raw_time') {
    rowData.display_time = timeToDisplay(newValue, timeMode);
    // Operator overrode the time — clear any joyi-imported full-precision
    // ms so the new hundredth-precision input drives ranking. Without
    // this, the stale ms value would silently keep ranking by an old
    // thousandth even after manual correction.
    rowData.raw_time_ms = null;
  }

  // First non-empty entry in raw_time or remarks → fire result-entry signals
  // (Lambda nextraceedit + Firebase digital flag → red). notifyResultEntryStarted
  // is itself idempotent and gated on "next race not yet started" so we only
  // need a cheap local trigger: cell key + non-empty value.
  if ((colKey === 'raw_time' || colKey === 'remarks') && newValue && String(newValue).trim()) {
    notifyResultEntryStarted(raceNumber).catch(() => {});
  }

  // Recalculate rankings (live — leniently skips -2 flag on the
  // currently-focused row to avoid mid-typing red flashes).
  recalculate();

  // Debounced save to IndexedDB
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => persistCurrentRow(rowIndex), 200);
}

/**
 * Fires when the operator leaves a cell after a value change (or
 * presses Enter). At this point grid.focusedRow has been cleared by
 * the blur handler, so recalculate() now applies strict validation
 * (including the -2 flags we deferred during live typing). Also
 * commits any pending debounced save immediately — operator's done
 * with this row, no need to wait 200ms.
 */
function onCellBlur(rowIndex, colKey, newValue, rowData) {
  recalculate();
  clearTimeout(saveDebounceTimer);
  persistCurrentRow(rowIndex);
}

function recalculate() {
  if (!grid) return;
  const data = grid.getData();
  const timeMode = configData?.time_format_mode || 'mss00';

  // Update display times
  data.forEach(row => {
    row.display_time = timeToDisplay(row.raw_time, timeMode);
  });

  // Compute rankings. The batch delta is only applied when the operator
  // has explicitly opted in via the "Apply batch adjustment" toggle —
  // capturing P1 alone shouldn't silently re-rank everyone.
  const appliedDeltaMs = batchOverrideEnabled ? batchDeltaMs : 0;
  computeRankings(data, timeMode, appliedDeltaMs);

  const laneCount = configData?.lane_count || 6;

  // Validation checks (G21/H22 equivalents).
  // The currently-focused row (if any) is treated leniently: partial
  // input like "1" or "10" isn't yet a valid mss00 time and would
  // flash the row red on every keystroke. We hold off on the -2 flag
  // for that one row until the operator blurs out — at which point
  // the onCellBlur handler triggers a fresh recalculate() with
  // focusedRow === null and the strict check runs.
  const focusedIdx = grid?.focusedRow ?? null;
  data.forEach((row, i) => {
    const isLive = i === focusedIdx;
    if (!row.raw_time && !row.remarks) {
      row.validation = null; // empty row
    } else if (row.raw_time && row.effective_time_ms != null) {
      row.validation = 1; // ok
      // Check time format
      if (row.raw_time && !isValidTime(row.raw_time, timeMode)) {
        row.validation = isLive ? null : -2;
      }
    } else if (row.remarks) {
      row.validation = 1; // has remark, ok
    } else {
      // Has raw_time but no parsed time → either invalid format or
      // user still typing. Defer to blur for the row being edited.
      row.validation = isLive ? null : -2;
    }
  });

  // Lane validity per row — blank/out-of-range/duplicate lane_input flips the
  // row to invalid so the per-row colour + Valid? indicator agree with the
  // panel message (panel says "lane out of range" → row also goes red).
  const laneCounts = new Map();
  data.forEach(row => {
    if (!row.raw_time && !row.remarks) return;
    const lane = parseInt(row.lane_input, 10);
    if (Number.isInteger(lane) && lane >= 1 && lane <= laneCount) {
      laneCounts.set(lane, (laneCounts.get(lane) || 0) + 1);
    }
  });
  data.forEach((row, i) => {
    if (!row.raw_time && !row.remarks) return;
    if (row.validation === -2) return; // already invalid for another reason
    const isLive = i === focusedIdx;
    const laneStr = (row.lane_input ?? '').toString().trim();
    if (laneStr === '') {
      // While the operator is still typing in this row, an empty lane
      // is expected — they may not have entered it yet. Skip the -2
      // flag for the focused row; blur will reapply strictly.
      if (!isLive) row.validation = -2;
      return;
    }
    const lane = parseInt(laneStr, 10);
    if (!Number.isInteger(lane) || lane < 1 || lane > laneCount) {
      if (!isLive) row.validation = -2; // out of range
      return;
    }
    if ((laneCounts.get(lane) || 0) > 1) {
      row.validation = -2; // duplicate lane across rows — flag always
    }
  });

  // Check input order — compare PRE-penalty raw times. TP doesn't change
  // who crossed the line first; operators enter by actual finish order.
  const withTimes = data
    .map(r => ({ r, rawMs: r.raw_time ? timeToMs(r.raw_time, timeMode) : null }))
    .filter(x => x.rawMs != null);
  for (let i = 0; i < withTimes.length - 1; i++) {
    if (withTimes[i].rawMs > withTimes[i + 1].rawMs) {
      const idx = data.indexOf(withTimes[i + 1].r);
      if (idx >= 0) data[idx].validation = -2;
    }
  }

  // Refresh grid display
  grid.refreshAll();

  // Apply per-row validity colour so the operator can see at a glance which
  // rows are incomplete or invalid without scanning the panel.
  applyRowValidationStyles(data);

  // Hide the running clock (and the Stop pill next to it) once the operator
  // starts logging results or after a Joyi import populates raw_time —
  // attention shifts to the data at that point. Show again only when the
  // race restarts (no times yet).
  const hasResults = data.some(r => r.raw_time);
  const timerEl = document.getElementById('raceTimer');
  if (timerEl) timerEl.style.display = hasResults ? 'none' : '';
  const stopBtn = document.getElementById('stopCounterBtn');
  if (stopBtn) {
    const timerRunning = !!timerInterval;
    // Stop pill is only meaningful when the timer is actively running AND
    // hasn't been auto-hidden behind the results entry.
    stopBtn.style.display = (timerRunning && !hasResults) ? '' : 'none';
  }

  // Batch override toggle: disabled when P1 input is empty (or was cleared).
  // If the toggle was on and P1 just got cleared, flip it off to match.
  const toggleEl = document.getElementById('batchOverrideToggle');
  const p1Val = document.getElementById('batchP1Time')?.value?.trim();
  if (toggleEl) {
    const enabled = !!p1Val;
    toggleEl.disabled = !enabled;
    if (!enabled && batchOverrideEnabled) {
      batchOverrideEnabled = false;
      toggleEl.checked = false;
    }
  }

  // Update output table
  renderOutput(data);

  // Update validation panel
  renderValidation(data);
}

function applyRowValidationStyles(data) {
  const trs = document.querySelectorAll('#inputGridContainer table.excel-grid tbody tr');
  trs.forEach((tr, i) => {
    const row = data[i];
    tr.classList.remove('row-valid', 'row-invalid', 'row-warning');
    if (!row) return;
    if (row.validation === -2) tr.classList.add('row-invalid');
    else if (row.validation === 1) tr.classList.add('row-valid');
    else if (row.raw_time || row.remarks) tr.classList.add('row-warning');
  });
}

// Use isValidTime from utils.js (imported at top) — no duplicate needed

// Debounced Supabase sync trigger — race-page state changes happen fast
// (every keystroke debounces to persistCurrentRow), but Supabase upserts
// should batch. 3-second debounce on the queue-then-flush call;
// queueRaceSync's own dedup keeps the actual writes minimal.
let syncDebounceTimer = null;
function kickSync(rn = raceNumber) {
  if (!rn) return;
  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(async () => {
    try {
      const { queueRaceSync } = await import('../sync.js');
      await queueRaceSync(rn);
    } catch (err) {
      // Sync is best-effort from the race page — the periodic 30s
      // interval will retry. Don't surface to operator.
      console.warn('kickSync failed:', err);
    }
  }, 3000);
}

async function persistCurrentRow(rowIndex) {
  const data = grid.getData();
  const row = data[rowIndex];
  await saveLaneResult({
    race_number: raceNumber,
    lane_number: row.lane_number,
    lane_input: row.lane_input,
    raw_time: row.raw_time,
    raw_time_ms: row.raw_time_ms ?? null,
    penalty_time: row.penalty_time,
    remarks: row.remarks,
    computed_position: row.computed_position,
    effective_time_ms: row.effective_time_ms,
    team_code: row.team_code,
    team_name: row.team_name,
    joyi_rank: row.joyi_rank,
  });
  // Surface results changes to Supabase. Debounced so a typing burst
  // collapses to one sync attempt.
  kickSync();
}

function renderOutput(data) {
  const container = document.getElementById('outputTableContainer');
  if (!container) return;
  const timeMode = configData?.time_format_mode || 'mss00';
  const laneCount = configData?.lane_count || 6;

  // Bottom section is a fixed-lane view of the same data the operator types
  // into the top section. One row per lane 1..laneCount, always in order.
  // Time/place/remarks come from whichever input row references this lane
  // via lane_input; if no row does, the cells stay blank.
  const inputByLane = {};
  data.forEach(r => {
    const lane = parseInt(r.lane_input, 10);
    if (Number.isInteger(lane) && lane >= 1 && lane <= laneCount) {
      // If two rows somehow point at the same lane, validation flags it;
      // here we keep the last-wins so the operator at least sees something.
      inputByLane[lane] = r;
    }
  });

  const rowsHtml = [];
  for (let lane = 1; lane <= laneCount; lane++) {
    const r = inputByLane[lane];
    const draw = drawsByLane[lane] || {};
    const teamName = draw.team_name || '';
    const teamCode = draw.team_code || '';

    if (!r) {
      // A drawn boat (has team_name) with no input row pointing at this
      // lane = missing result. Highlight the row in amber so the
      // operator spots it instantly and inputs a placeholder (DNS / DNF
      // / time). The validation banner repeats the warning textually.
      const missing = teamName && teamName !== '---';
      const rowStyle = missing ? ' style="background:rgba(245, 158, 11, 0.22);"' : '';
      const missingTag = missing ? ' <span style="font-size:10px; color:var(--warning);">⚠ no time/status</span>' : '';
      const scoreCells = scoringCtx ? `<td></td><td></td><td></td>` : '';
      rowsHtml.push(`<tr${rowStyle}>
        <td>${lane}</td>
        <td></td>
        <td></td>
        ${scoreCells}
        <td>${missingTag}</td>
        <td class="team-name">${teamName}</td>
        <td>${teamCode}</td>
      </tr>`);
      continue;
    }

    const posClass = r.computed_position === 1 ? 'first' : r.computed_position === 2 ? 'second' : r.computed_position === 3 ? 'third' : '';
    const remarksDisplay = [];
    if (r.penalty_time) remarksDisplay.push(`TP=${r.penalty_time}s`);
    if (r.remarks) remarksDisplay.push(r.remarks);

    // Time display:
    //   - When the operator has enabled "Apply batch adjustment", show the
    //     adjusted time (raw_time + batch delta + penalty) — that's the
    //     effective time used for ranking. The raw time stays in the input
    //     grid above. Output table is the "what gets exported" preview.
    //   - Otherwise just format raw_time.
    let timeStr;
    if (batchOverrideEnabled && r.effective_time_ms != null) {
      timeStr = timeToDisplay(msToTime(r.effective_time_ms, timeMode), timeMode);
    } else {
      timeStr = timeToDisplay(r.raw_time, timeMode);
    }

    // Scoring columns (only when the race is on a scored chain).
    //   Score = this round's points (always shown).
    //   Total Score + Total Place = cumulative across rounds. Before the
    //   final round (RFinal) these are provisional, so we show them tinted
    //   amber and the header carries a "(so far)" qualifier so a mid-series
    //   standing isn't mistaken for the final result. (#15)
    let scoreCells = '';
    if (scoringCtx) {
      const teamEntry = scoringCtx.teamTotals.get(teamCode);
      const thisPts = teamEntry?.perRound?.[scoringCtx.scoringFlag]?.pts ?? '';
      const isFinalRound = scoringCtx.scoringFlag === 'RFinal';
      const totalScore = teamEntry ? Math.round(teamEntry.total_weighted) : '';
      const totalPlace = teamEntry?.overall_rank ?? '';
      const provStyle = !isFinalRound ? 'color:var(--warning-text);' : '';
      scoreCells = `
        <td style="font-weight:600;">${thisPts}</td>
        <td style="${provStyle}">${totalScore === '' ? '—' : totalScore}</td>
        <td style="${provStyle}">${totalPlace === '' ? '—' : totalPlace}</td>`;
    }

    rowsHtml.push(`<tr>
      <td>${lane}</td>
      <td>${timeStr}</td>
      <td class="cell-position ${posClass}">${r.remarks && ['DSQ', 'DQ'].includes(r.remarks) ? r.remarks : (r.computed_position ?? '')}</td>
      ${scoreCells}
      <td>${remarksDisplay.join(', ')}</td>
      <td class="team-name">${teamName}</td>
      <td>${teamCode}</td>
    </tr>`);
  }

  const finalRound = scoringCtx?.scoringFlag === 'RFinal';
  const soFar = finalRound ? '' : ' <span style="font-size:10px; color:var(--warning-text);">(so far)</span>';
  const headerExtra = scoringCtx
    ? `<th title="Points for this round">Score</th><th title="Sum of weighted points across rounds${finalRound ? '' : ' — provisional until RFinal'}">Total Score${soFar}</th><th title="Overall rank in division${finalRound ? '' : ' — provisional until RFinal'}">Total Place${soFar}</th>`
    : '';

  const refTableHtml = scoringCtx ? buildScoringReferenceTable() : '';

  container.innerHTML = `
    <table class="output-table">
      <thead><tr>
        <th>Lane</th><th>Time</th><th>Place</th>${headerExtra}<th>Remarks</th><th>Team Name</th><th>Code</th>
      </tr></thead>
      <tbody>${rowsHtml.join('')}</tbody>
    </table>
    ${refTableHtml}
  `;
}

// Reference table — replica of the Scoring tab's totals for the race's
// division. Shown below the race output when scoring applies, so the
// operator can see how this race contributes to the season scoreboard
// without leaving the race page.
function buildScoringReferenceTable() {
  if (!scoringCtx) return '';
  const teams = [...scoringCtx.teamTotals.values()]
    .sort((a, b) => b.total_weighted - a.total_weighted);
  const rounds = scoringCtx.scoredRaces;
  if (teams.length === 0) return '';

  const flagToRaceLink = (flag) => {
    const r = rounds.find(x => x.scoring_flag === flag);
    if (!r) return '';
    // Don't hyperlink the row that points to THIS race — clicking would
    // navigate to the page you're already on. Plain text instead.
    if (r.race_number === raceNumber) {
      return `<span style="color:var(--text-secondary);">Race ${r.race_number}</span>`;
    }
    return `<a href="#/race/${r.race_number}" style="color:var(--accent);">Race ${r.race_number}</a>`;
  };

  return `
    <div style="margin-top:14px;">
      <div style="font-size:13px; font-weight:600; margin-bottom:6px; color:var(--text-secondary);">
        <i class="material-icons" style="font-size:14px; vertical-align:middle;">leaderboard</i>
        Division scoreboard reference
      </div>
      <table class="output-table">
        <thead><tr>
          <th>Rank</th>
          <th style="text-align:left;">Team</th>
          <th>Code</th>
          ${rounds.map(r => `<th>${r.scoring_flag}<br><small>${flagToRaceLink(r.scoring_flag)}</small></th>`).join('')}
          <th>Total</th>
        </tr></thead>
        <tbody>
          ${teams.map(t => {
            const rankCls = t.overall_rank === 1 ? 'first' : t.overall_rank === 2 ? 'second' : t.overall_rank === 3 ? 'third' : '';
            return `<tr>
              <td class="cell-position ${rankCls}">${t.overall_rank}</td>
              <td class="team-name" style="text-align:left;">${t.team_name}</td>
              <td>${t.team_code}</td>
              ${rounds.map(r => {
                const pr = t.perRound?.[r.scoring_flag];
                return `<td title="${pr?.position != null ? `Position ${pr.position}` : ''}">${pr?.pts ?? '—'}</td>`;
              }).join('')}
              <td><strong>${Math.round(t.total_weighted)}</strong></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

// Compute the combined validation state (base checks + cross-race variance)
// for the current race. Shared by renderValidation (display) and the #7
// auto-export gate so both judge "clean" identically.
function computeRaceValidation(data) {
  const result = validateRace(raceData, data, configData || { lane_count: 6, time_format_mode: 'mss00' });
  if (varianceCtx && raceData) {
    const v = computeVarianceWarnings({
      race: raceData,
      lanes: data,
      allRaces: varianceCtx.allRaces,
      allLaneResultsByRace: varianceCtx.allLaneResultsByRace,
      divRounds: varianceCtx.divRounds,
      divProgs: varianceCtx.divProgs,
      laneCount: configData?.lane_count || 6,
      timeMode: configData?.time_format_mode || 'mss00',
    });
    result.errors.push(...v.errors);
    result.warnings.push(...v.warnings);
  }
  return result;
}

function renderValidation(data) {
  const panel = document.getElementById('validationPanel');
  if (!panel) return;

  const result = computeRaceValidation(data);

  if (result.errors.length === 0 && result.warnings.length === 0) {
    const hasData = data.some(r => r.raw_time || r.remarks);
    if (!hasData) {
      panel.innerHTML = '';
      return;
    }
    panel.innerHTML = `<div style="padding:8px 14px; border-radius:var(--radius-sm); background:var(--success-bg); color:var(--success-text); font-size:13px;">
      <i class="material-icons" style="font-size:16px; vertical-align:middle; margin-right:6px;">check_circle</i>
      All checks passed
    </div>`;
    return;
  }

  panel.innerHTML = [
    ...result.errors.map(e => `<div style="padding:6px 14px; margin-bottom:4px; border-radius:var(--radius-sm); border-left:3px solid var(--danger); background:var(--danger-bg); color:var(--danger-text); font-size:13px;">
      <i class="material-icons" style="font-size:14px; vertical-align:middle; margin-right:4px;">error</i> ${e}
    </div>`),
    ...result.warnings.map(w => `<div style="padding:6px 14px; margin-bottom:4px; border-radius:var(--radius-sm); border-left:3px solid var(--warning); background:var(--warning-bg); color:var(--warning-text); font-size:13px;">
      <i class="material-icons" style="font-size:14px; vertical-align:middle; margin-right:4px;">warning</i> ${w}
    </div>`),
  ].join('');
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  const timerEl = document.getElementById('raceTimer');
  // Restart wins (operator-initiated re-baseline); otherwise prefer the
  // Joyi-derived start (sub-second accurate, no missed clicks), falling
  // back to the manual click.
  const baseline = raceData.restart_time || raceData.joyi_start_time || raceData.start_time;
  if (!timerEl || !baseline) return;

  function update() {
    const elapsed = Date.now() - new Date(baseline).getTime();
    const totalSec = Math.floor(elapsed / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const cs = Math.floor((elapsed % 1000) / 10);
    timerEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  update();
  timerInterval = setInterval(update, 100);
}

/**
 * Check previous races for missing exports/sends (VBA pattern).
 * Shows warnings for any earlier race that hasn't been exported or sent.
 */
async function checkPreviousRaces(currentRaceNum) {
  const { getAllRaces } = await import('../db.js');
  const allRaces = await getAllRaces();

  const missingExports = [];
  const missingSends = [];

  for (const r of allRaces) {
    if (r.race_number >= currentRaceNum) continue;
    if (r.status === 'cancelled') continue;
    if (r.status === 'pending') continue;

    if (!r.export_time) missingExports.push(r.race_number);
    if (!r.send_time) missingSends.push(r.race_number);
  }

  // Singular/plural label so the message reads naturally for one race vs many.
  const fmtRaces = (nums) => (nums.length === 1 ? `Race ${nums[0]}` : `Races ${nums.join(', ')}`);
  if (missingExports.length > 0) {
    showToast(`Reminder: ${fmtRaces(missingExports)} NOT exported`, 'warning', 6000);
  }
  if (missingSends.length > 0) {
    showToast(`Reminder: ${fmtRaces(missingSends)} NOT sent`, 'warning', 6000);
  }
}

/**
 * Render the primary action row: START or RESTART on the left (~70%) + a
 * FINISH-capture button on the right (~30%). After the race has been started
 * once, the left button permanently becomes RESTART. FINISH stays enabled as
 * long as there's a start time; clicking it again will prompt to override.
 */
function renderStartStopButton() {
  const wrap = document.getElementById('startStopWrap');
  if (!wrap) return;
  const cancelled = raceData.status === 'cancelled';
  // The race has "begun" if either source has a start: a Joyi-imported
  // .lcd has populated joyi_start_time, OR the operator has clicked START.
  // Either way, the button flips to RESTART RACE so the operator can
  // manually re-baseline the timer if needed.
  const everStarted = !!(raceData.start_time || raceData.joyi_start_time);
  const startLabel = everStarted ? 'RESTART RACE' : 'START RACE';
  const startIcon = everStarted ? 'replay' : 'play_arrow';
  const startCls = everStarted ? 'btn-primary' : 'btn-success';
  const finishDisabled = (!everStarted || cancelled) ? 'disabled' : '';

  // "Reset start" is a light escape hatch for a misclick on START — only
  // useful before any results land. Hidden once results are exported.
  const canResetStart = everStarted && !raceData.export_time && !cancelled;
  // "Reset race" is the draconian re-race button. Available at any point
  // EXCEPT when the race is cancelled. After export/send it also clears
  // export markers so the race genuinely returns to a pre-start state
  // (export_history is preserved as an audit trail).
  const canResetRace = !cancelled;

  wrap.innerHTML = `
    <button class="btn ${startCls}" style="flex:7;" onclick="window._startRace()" id="startBtn" ${cancelled ? 'disabled' : ''}>
      <i class="material-icons">${startIcon}</i> ${startLabel}
    </button>
    <button class="btn btn-outline" style="flex:3;" onclick="window._finishBackup()" id="finishBtn" ${finishDisabled}
            title="Capture first-boat finish timestamp at click moment">
      <i class="material-icons">flag</i> FINISH
    </button>
    ${canResetStart ? `
    <button class="btn btn-ghost btn-sm" style="flex:0 0 auto;" onclick="window._resetStart()" id="resetStartBtn"
            title="Undo START — clears start_time and goes back to PENDING. Hidden once results are exported.">
      <i class="material-icons" style="font-size:16px;">undo</i> Reset start
    </button>
    ` : ''}
    ${canResetRace ? `
    <button class="btn btn-ghost btn-sm" style="flex:0 0 auto; color:var(--danger);" onclick="window._resetRace()" id="resetRaceBtn"
            title="Draconian reset — clears start times, all lane results, and export/send markers. Use only for a confirmed re-race.">
      <i class="material-icons" style="font-size:16px;">delete_forever</i> Reset race
    </button>
    ` : ''}
  `;
}

/**
 * Header "Start" cell content. Priority:
 *   1. joyi_start_time (derived from Joyi files — sub-second accurate when
 *      transport preserves mtime; always present after a Joyi import)
 *   2. start_time (operator click — kept as fallback for when Joyi isn't
 *      available or hasn't been imported yet)
 *   3. restart_time (operator restart — overrides timer baseline but the
 *      original start stays for the record)
 *
 * Small inline badge shows the source so the operator knows which value
 * is being shown. Manual + Joyi disagreement is surfaced via tooltip.
 */
function renderStartTimeText(race) {
  const { start, source, restartedFrom } = getEffectiveStartTime(race);
  if (!start && !restartedFrom) return '—';
  const baseDisplay = start ? isoToTime(start) : isoToTime(restartedFrom);
  // Build a tooltip noting both manual and joyi when both exist + differ.
  const both = race.joyi_start_time && race.start_time;
  const driftMs = both ? Math.abs(new Date(race.joyi_start_time) - new Date(race.start_time)) : 0;
  const driftNote = both && driftMs > 1000
    ? ` (manual=${isoToTime(race.start_time)}, Δ=${(driftMs / 1000).toFixed(1)}s)`
    : '';
  const badge = source === 'joyi'
    ? `<span title="From Joyi .lcd metadata${driftNote}" style="display:inline-block; font-size:9px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase; color:#7dd3fc; background:rgba(125,211,252,0.18); padding:1px 5px; border-radius:3px; margin-left:5px; vertical-align:middle;">Joyi</span>`
    : (source === 'manual' && race.prefer_manual_start && race.joyi_start_time
        ? `<span title="Operator forced manual start (Joyi value=${isoToTime(race.joyi_start_time)})" style="display:inline-block; font-size:9px; font-weight:600; letter-spacing:0.5px; text-transform:uppercase; color:#fbbf24; background:rgba(251,191,36,0.18); padding:1px 5px; border-radius:3px; margin-left:5px; vertical-align:middle;">MANUAL</span>`
        : '');
  // Small "use other start" toggle when BOTH sources exist — lets the
  // operator switch which one drives display + ranking baseline.
  let toggle = '';
  if (both) {
    const flipTo = race.prefer_manual_start ? 'joyi' : 'manual';
    const toggleLabel = race.prefer_manual_start ? 'use Joyi' : 'use RDMS';
    toggle = `<button class="btn btn-ghost btn-sm" style="padding:0 6px; margin-left:6px; font-size:10px; opacity:0.7;"
                  onclick="window._toggleStartSource('${flipTo}')" title="Switch the canonical start time">${toggleLabel}</button>`;
  }
  if (restartedFrom && start) {
    return `<s style="color:var(--text-tertiary); font-weight:400;">${baseDisplay}</s> → ${isoToTime(restartedFrom)}${badge}${toggle}`;
  }
  return `${baseDisplay}${badge}${toggle}`;
}

/**
 * Header "Export" cell — if there's been more than one export, show the
 * previous one struck through next to the latest.
 */
// Stack the previous (struck-through) value ABOVE the latest so a re-export /
// re-send keeps the header cell NARROW. Showing them side-by-side ("old → new")
// roughly doubled the column width and pushed the header onto a second line.
function stackedTimeText(prevIso, currentIso) {
  return `<span style="display:inline-flex; flex-direction:column; align-items:center; line-height:1.05;">`
    + `<s style="color:var(--text-tertiary); font-weight:400; font-size:10px;">${isoToTime(prevIso)}</s>`
    + `<span>${isoToTime(currentIso)}</span></span>`;
}

function renderExportTimeText(race) {
  if (!race.export_time) return '—';
  const history = race.export_history || [];
  if (history.length >= 2) {
    const prev = history[history.length - 2]?.timestamp;
    if (prev) return stackedTimeText(prev, race.export_time);
  }
  return isoToTime(race.export_time);
}

/**
 * Header "Send" cell — if there's been a re-send, show the previous send
 * struck through above the latest (stacked, to keep the cell narrow).
 */
function renderSendTimeText(race) {
  if (!race.send_time) return '—';
  if (race.prev_send_time) return stackedTimeText(race.prev_send_time, race.send_time);
  return isoToTime(race.send_time);
}

function attachHandlers() {
  window._startRace = async () => {
    const now = nowISO();
    const isRestart = !!raceData.start_time;
    if (isRestart) {
      if (!confirm(`Restart Race ${raceNumber}? The original start time stays for the record; the timer resets to 0.`)) return;
      raceData.restart_time = now;
    } else {
      raceData.start_time = now;
      raceData.restart_time = null;
    }
    raceData.status = 'started';
    await saveRace(raceData);
    await saveTimesheet({
      race_number: raceNumber,
      start_time: raceData.start_time,
      restart_time: raceData.restart_time,
    });
    broadcastChange('race-updated', { race_number: raceNumber });

    document.getElementById('raceStartTime').innerHTML = renderStartTimeText(raceData);
    document.getElementById('raceStatus').textContent = 'STARTED';
    document.getElementById('raceStatus').className = 'badge badge-started';
    renderStartStopButton();
    // Show the small Stop button next to the timer.
    const stopBtn = document.getElementById('stopCounterBtn');
    if (stopBtn) stopBtn.style.display = '';
    startTimer();
    showToast(isRestart ? `Race ${raceNumber} restarted` : `Race ${raceNumber} started!`, isRestart ? 'info' : 'success');

    // Clear "Race has no start time" validation error.
    recalculate();

    // Force-signal this race as "next" on the mobile app, in case the prior
    // race's export flow missed it.
    signalNextRace(raceNumber).catch(() => {});
  };

  // STOP just halts the running counter. No data change — the start_time
  // (and restart_time if any) stays so it can still be exported. Press
  // RESTART to start counting again with a new restart_time.
  window._stopCounter = () => {
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    const stopBtn = document.getElementById('stopCounterBtn');
    if (stopBtn) stopBtn.style.display = 'none';
    showToast('Counter stopped. Press RESTART to begin again.', 'info', 4000);
  };

  window._cancelRace = async () => {
    if (!confirm(`Cancel Race ${raceNumber}? You can restore it later from this same page (Revive Race).`)) return;
    raceData.status = 'cancelled';
    await saveRace(raceData);
    broadcastChange('race-updated', { race_number: raceNumber });
    document.getElementById('raceStatus').textContent = 'CANCELLED';
    document.getElementById('raceStatus').className = 'badge badge-cancelled';
    showToast(`Race ${raceNumber} cancelled. Use Revive Race to restore.`, 'warning', 5000);
  };

  // Revive a previously cancelled race. Mirrors _cancelRace in reverse —
  // flips status back to whichever state the recorded times imply:
  //   - exported / sent if export_time exists (the cancellation didn't
  //     wipe the export history — preserve that audit trail)
  //   - started if start_time or joyi_start_time exists
  //   - pending otherwise
  // No other state is touched; if the operator also wants to clear lane
  // results, they use Reset race separately.
  window._reviveRace = async () => {
    if (raceData.status !== 'cancelled') {
      showToast('Race is not cancelled — nothing to revive.', 'info', 2500);
      return;
    }
    if (!confirm(`Revive Race ${raceNumber}? Returns status to where it logically should be based on existing start/export times. Lane results stay as they are.`)) return;

    let newStatus = 'pending';
    if (raceData.export_time) newStatus = raceData.send_time ? 'sent' : 'exported';
    else if (raceData.start_time || raceData.joyi_start_time) newStatus = 'started';

    raceData.status = newStatus;
    await saveRace(raceData);
    broadcastChange('race-updated', { race_number: raceNumber });

    // Re-render the affected header pieces in place (no full remount —
    // the operator may be mid-task and we want to preserve any unsaved
    // grid edits).
    const statusEl = document.getElementById('raceStatus');
    if (statusEl) {
      statusEl.textContent = newStatus.toUpperCase();
      statusEl.className = `badge badge-${newStatus}`;
    }
    renderStartStopButton();
    // Swap the Revive button back to Cancel in-place. The button sits
    // inside the .race-page-nav row; find it by current text content
    // (we don't have a stable id on it since both buttons share the slot).
    const navRow = document.querySelector('.race-page-nav');
    const revive = navRow?.querySelector('button[onclick="window._reviveRace()"]');
    if (revive) {
      const cancel = document.createElement('button');
      cancel.className = 'btn btn-danger btn-outline btn-sm';
      cancel.setAttribute('onclick', 'window._cancelRace()');
      cancel.textContent = 'Cancel Race';
      revive.replaceWith(cancel);
    }
    showToast(`Race ${raceNumber} revived (status: ${newStatus.toUpperCase()}).`, 'success', 4000);
  };

  // Draconian race reset — clears start times AND all lane results
  // (raw_time, penalty_time, remarks, computed_position, joyi fields).
  // Team_name / team_code / lane_number / designation stay (those are the
  // imported draw — unchanged by a re-race). Status returns to pending.
  //
  // Gated behind type-the-race-number confirmation because this destroys
  // recorded data. Only relevant for a confirmed re-race (e.g. boat hit
  // a buoy, race officials void the result, restart on the water).
  window._resetRace = async () => {
    if (raceData.status === 'cancelled') {
      showToast('Race is cancelled — nothing to reset. Change status in DB Admin.', 'warning', 5000);
      return;
    }
    const typed = window.prompt(
      `RESET RACE ${raceNumber}?\n\n` +
      `This permanently clears:\n` +
      `  • start_time / restart_time / joyi_start_time\n` +
      `  • p1 finish time\n` +
      `  • EVERY lane's raw_time, penalty, remarks, computed position\n` +
      `  • EVERY lane's Joyi result fields\n` +
      `  • export_time / export_version / send_time\n\n` +
      `Team draw (lane assignments) is preserved.\n` +
      `Export history (audit trail) is preserved.\n\n` +
      `Type the race number (${raceNumber}) to confirm:`
    );
    if (typed == null) return; // cancelled
    if (parseInt(typed, 10) !== raceNumber) {
      showToast('Race number did not match — reset aborted.', 'info', 4000);
      return;
    }

    // 1) Clear start-related fields on the race record.
    raceData.start_time = null;
    raceData.joyi_start_time = null;
    raceData.restart_time = null;
    raceData.p1_finish_time = null;
    raceData.p1_finish_elapsed_ms = null;
    raceData.result_entry_signaled = false;
    raceData.joyi_imported = false;
    raceData.status = 'pending';
    // Clear export and send markers so the race genuinely returns to a
    // pre-start state (status badge, dashboard tile, next-race signal,
    // etc. all read these). export_history is preserved as the audit
    // trail of what WAS exported before the reset; the next export
    // will create a fresh v1 entry alongside the prior versions.
    raceData.export_time = null;
    raceData.export_version = 0;
    raceData.send_time = null;
    raceData.re_send_time = null;
    await saveRace(raceData);

    // 2) Clear lane-result fields. Preserve identity (lane_number, team).
    const laneCount = configData?.lane_count || 6;
    const existing = await getLaneResults(raceNumber);
    const wipedLanes = [];
    for (let i = 0; i < laneCount; i++) {
      const lr = existing.find(r => r.lane_number === i + 1) || {};
      wipedLanes.push({
        race_number: raceNumber,
        lane_number: i + 1,
        team_name: lr.team_name || '',
        team_code: lr.team_code || '',
        designation: lr.designation || '',
        // Wipe everything else:
        lane_input: '',
        raw_time: '',
        penalty_time: '',
        remarks: '',
        computed_position: null,
        effective_time_ms: null,
        joyi_lane: null,
        joyi_time: null,
        joyi_name: null,
        joyi_rank: null,
        validation: null,
      });
    }
    await bulkSaveLaneResults(wipedLanes);

    // 3) Clear timesheet too.
    const ts = await getTimesheet(raceNumber);
    if (ts) {
      ts.start_time = null;
      ts.restart_time = null;
      ts.p1_finish_time = null;
      ts.p1_finish_elapsed_ms = null;
      ts.send_time = null;
      ts.re_send_time = null;
      await saveTimesheet(ts);
    }

    // 4) Stop the running timer + reload the grid from the now-empty DB.
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    const newGridData = buildGridData(wipedLanes, laneCount);
    for (let i = 0; i < newGridData.length; i++) {
      grid.setRowData(i, newGridData[i]);
    }

    // 5) Re-render header + buttons.
    document.getElementById('raceStartTime').innerHTML = renderStartTimeText(raceData);
    document.getElementById('raceStatus').textContent = 'PENDING';
    document.getElementById('raceStatus').className = 'badge badge-pending';
    const timerEl = document.getElementById('raceTimer');
    if (timerEl) timerEl.textContent = '';
    renderStartStopButton();
    broadcastChange('race-updated', { race_number: raceNumber });
    showToast(`Race ${raceNumber} fully reset (re-race). Start when ready.`, 'warning', 6000);
    recalculate();
  };

  // Manual placeholder resolver — replaces R{n}P{n} cells with actual
  // teams from the source races. Mirrors the auto-prompt flow but runs
  // for just this one race. Persists DB + writes .xls to 13/ + shared.
  window._resolvePlaceholders = async () => {
    if (!confirm(
      `Resolve R{n}P{n} placeholders for Race ${raceNumber}?\n\n` +
      `Looks at the placeholder in each lane (e.g. "R5P1") and pulls the\n` +
      `matching team from the source race's results. Lane assignments stay\n` +
      `as they are — only the team names + codes change.\n\n` +
      `Source races must have computed positions (i.e. results entered).\n` +
      `An .xls file is written to 13 Output_Next Round Draws/ + shared folder.`
    )) return;

    showToast('Resolving placeholders…', 'info', 2000);
    const result = await generateNextRoundDraw(raceNumber);
    if (result.warnings.length > 0) {
      console.warn('Resolve placeholders warnings:', result.warnings);
    }
    if (result.resolved > 0) {
      showToast(
        `Resolved ${result.resolved} of ${result.total} placeholder${result.total === 1 ? '' : 's'}` +
        (result.skipped > 0 ? ` (${result.skipped} skipped — see console)` : '') +
        (result.filename ? ` · ${result.filename}` : ''),
        result.skipped > 0 ? 'warning' : 'success', 5500);
      broadcastChange('draw-imported', { race_number: raceNumber });
      // Reload lane_results + re-render the grid in place.
      const fresh = await getLaneResults(raceNumber);
      const newGridData = buildGridData(fresh, configData?.lane_count || 6);
      for (let i = 0; i < newGridData.length; i++) {
        grid?.setRowData(i, newGridData[i]);
      }
      recalculate();
      // Refresh the page-level snapshot so the output table picks up the
      // new team names without a full re-mount.
      raceData = (await getRace(raceNumber)) || raceData;
    } else {
      showToast(result.warnings[0] || 'No placeholders resolved.', 'warning', 5000);
    }
  };

  // Clear the Results Input panel only: lane_input / raw_time / penalty_time
  // / remarks / computed_position on every lane row. Preserves team draws,
  // race state (start_time, status, export_time), Joyi imports, etc.
  //
  // Use when the operator wants a quick wipe of entered values to start
  // typing again — distinct from "Reset start" (race-level) and
  // "Reset race" (race + lane_results destructive).
  window._clearInputs = async () => {
    const data = grid?.getData() || [];
    const hasAny = data.some(r =>
      (r.lane_input && String(r.lane_input).trim()) ||
      (r.raw_time && String(r.raw_time).trim()) ||
      (r.penalty_time && String(r.penalty_time).trim()) ||
      (r.remarks && String(r.remarks).trim())
    );
    if (!hasAny) {
      showToast('Input panel is already empty.', 'info', 2500);
      return;
    }
    if (!confirm(
      `Clear all entered values in the Results Input panel for Race ${raceNumber}?\n\n` +
      `Cleared: Lane, Time, TP, Remarks (every row).\n` +
      `Preserved: team draws, start times, race status, export/send history,\n` +
      `Joyi import results, and the Output table will recompute automatically.`
    )) return;

    // Wipe IndexedDB lane_results entries — keep identity columns (team_*,
    // lane_number, designation) and Joyi columns (those came from import,
    // not from manual input).
    const laneCount = configData?.lane_count || 6;
    const existing = await getLaneResults(raceNumber);
    const wiped = [];
    for (let i = 0; i < laneCount; i++) {
      const lr = existing.find(r => r.lane_number === i + 1) || {};
      wiped.push({
        race_number: raceNumber,
        lane_number: i + 1,
        team_name: lr.team_name || '',
        team_code: lr.team_code || '',
        designation: lr.designation || '',
        // Joyi-derived columns persist — they're not manual input.
        joyi_lane: lr.joyi_lane ?? null,
        joyi_time: lr.joyi_time ?? null,
        joyi_name: lr.joyi_name ?? null,
        joyi_rank: lr.joyi_rank ?? null,
        // Wiped:
        lane_input: '',
        raw_time: '',
        penalty_time: '',
        remarks: '',
        computed_position: null,
        effective_time_ms: null,
        validation: null,
      });
    }
    await bulkSaveLaneResults(wiped);

    // Refresh grid in-place so the UI mirrors the DB without remount.
    const fresh = buildGridData(wiped, laneCount);
    for (let i = 0; i < fresh.length; i++) {
      grid.setRowData(i, fresh[i]);
    }
    recalculate();
    broadcastChange('race-updated', { race_number: raceNumber });
    showToast(`Race ${raceNumber} inputs cleared.`, 'info', 3000);
  };

  window._resetStart = async () => {
    // Sanity-check at click time (re-render guards already hide the button in
    // these cases, but the operator could have edited DB Admin in another tab).
    if (raceData.export_time) {
      showToast('Cannot reset start after export. Use DB Admin to roll back.', 'error', 5000);
      return;
    }
    if (!confirm(
      `Reset START for Race ${raceNumber}?\n\n` +
      `This clears start_time, restart_time, p1_finish_time and returns the\n` +
      `race to PENDING. Use only when START was clicked by mistake.`
    )) return;

    raceData.start_time = null;
    raceData.joyi_start_time = null;          // re-derived on next Joyi import
    raceData.restart_time = null;
    raceData.p1_finish_time = null;
    raceData.p1_finish_elapsed_ms = null;
    raceData.result_entry_signaled = false;   // re-arm result-entry signals
    raceData.status = 'pending';
    await saveRace(raceData);

    // Mirror the same clear in the TimeSheet log so reports don't show a
    // ghost start. The row stays so prior history isn't lost.
    const ts = await getTimesheet(raceNumber);
    if (ts) {
      ts.start_time = null;
      ts.restart_time = null;
      ts.p1_finish_time = null;
      ts.p1_finish_elapsed_ms = null;
      await saveTimesheet(ts);
    }

    // Stop the running clock; re-render header + buttons.
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    document.getElementById('raceStartTime').innerHTML = renderStartTimeText(raceData);
    document.getElementById('raceStatus').textContent = 'PENDING';
    document.getElementById('raceStatus').className = 'badge badge-pending';
    const timerEl = document.getElementById('raceTimer');
    if (timerEl) timerEl.textContent = '';
    renderStartStopButton();
    broadcastChange('race-updated', { race_number: raceNumber });
    showToast(`Race ${raceNumber} start reset. Press START when ready.`, 'info', 4000);
    recalculate(); // re-runs validation (start-time warning comes back)
  };

  // Toggle which start time is canonical. Argument is the new preference:
  // 'manual' (RDMS click) or 'joyi' (LCD-derived). Both must already
  // exist on the race for this to be meaningful.
  window._toggleStartSource = async (preference) => {
    if (!raceData) return;
    raceData.prefer_manual_start = (preference === 'manual');
    await saveRace(raceData);
    showToast(
      `Start time source: ${preference === 'manual' ? 'RDMS click' : 'Joyi (default)'}`,
      'info', 2500,
    );
    document.getElementById('raceStartTime').innerHTML = renderStartTimeText(raceData);
    broadcastChange('race-updated', { race_number: raceNumber });
  };

  window._finishBackup = async () => {
    // CAPTURE FIRST — at the click moment. We never let the confirm dialog
    // move the recorded timestamp; ms precision must reflect when the
    // operator's finger hit the button, not when they dismissed the prompt.
    const captureISO = nowISO();

    // If a Joyi LCD fetch is in flight, block on it before computing the
    // delta — the elapsed-time math depends on the right baseline. Block
    // is short-lived: byte-range read against Drive is ~30 bytes, settles
    // in under a second on a reasonable connection.
    if (isLcdPending(raceNumber)) {
      const overlay = document.getElementById('raceJoyiBlock');
      if (overlay) overlay.style.display = 'flex';
      try { await awaitLcd(raceNumber); }
      finally { if (overlay) overlay.style.display = 'none'; }
      // Re-read race after the fetch so the new joyi_start_time is in
      // raceData for the baseline calculation below.
      raceData = (await getRace(raceNumber)) || raceData;
    }

    if (!raceData.start_time && !raceData.joyi_start_time) {
      showToast('Cannot capture finish: race has no start time', 'warning');
      return;
    }

    if (raceData.p1_finish_time) {
      const captureMs = String(new Date(captureISO).getMilliseconds()).padStart(3, '0');
      const ok = confirm(
        `First-boat finish already captured at ${isoToTime(raceData.p1_finish_time)}.\n\n` +
        `Override with the moment you just clicked (${isoToTime(captureISO)}.${captureMs})?`
      );
      if (!ok) return;
    }

    // FINISH elapsed time anchors on the effective start (Joyi-derived if
    // available, manual otherwise), with restart_time overriding when the
    // operator has explicitly re-baselined the timer.
    const baseline = raceData.restart_time || raceData.joyi_start_time || raceData.start_time;
    const elapsedMs = new Date(captureISO).getTime() - new Date(baseline).getTime();
    raceData.p1_finish_time = captureISO;
    raceData.p1_finish_elapsed_ms = elapsedMs;
    await saveRace(raceData);
    await saveTimesheet({
      race_number: raceNumber,
      start_time: raceData.start_time,
      p1_finish_time: captureISO,
      p1_finish_elapsed_ms: elapsedMs,
    });

    const timeMode = configData?.time_format_mode || 'mss00';
    const p1Input = document.getElementById('batchP1Time');
    if (p1Input) p1Input.value = msToTime(elapsedMs, timeMode);

    // Update batch-delta display if a row has a manual time entered.
    const data = grid.getData();
    const firstTime = data.find(r => r.raw_time)?.raw_time;
    if (firstTime && p1Input) {
      batchDeltaMs = calcBatchDelta(p1Input.value, firstTime, timeMode);
      const deltaEl = document.getElementById('batchDelta');
      if (deltaEl) {
        const deltaDisplay = timeToDisplay(msToTime(Math.abs(batchDeltaMs), timeMode), timeMode);
        deltaEl.textContent = (batchDeltaMs >= 0 ? '+' : '-') + deltaDisplay;
      }
    }

    const ms = String(new Date(captureISO).getMilliseconds()).padStart(3, '0');
    showToast(`First-boat finish captured at ${isoToTime(captureISO)}.${ms}`, 'success', 4000);
    recalculate();
  };

  window._exportAndSend = async () => {
    await showExportModal(raceNumber, async () => {
      // Mark "sent" the moment we're about to surface the WhatsApp
      // copy-modal — the operator's intent is to send, and asking
      // them to confirm afterwards adds a click without value.
      raceData = await getRace(raceNumber);
      if (raceData.send_time) raceData.prev_send_time = raceData.send_time;
      raceData.send_time = nowISO();
      raceData.status = 'sent';
      await saveRace(raceData);
      const ts = await getTimesheet(raceNumber) || { race_number: raceNumber };
      if (!ts.send_time) { ts.send_time = raceData.send_time; } else { ts.re_send_time = raceData.send_time; }
      await saveTimesheet(ts);
      document.getElementById('raceSendTime').innerHTML = renderSendTimeText(raceData);
      document.getElementById('raceStatus').textContent = 'SENT';
      document.getElementById('raceStatus').className = 'badge badge-sent';
      broadcastChange('race-updated', { race_number: raceNumber });
      // Back up AFTER the send is persisted so the send_time is captured —
      // the export-time backup predates it, and for the last race of an event
      // there's no later export to catch it. Fire-and-forget.
      import('../backup.js').then(m => m.backupAfterSend(raceNumber)).catch(() => {});
      // Show the WhatsApp copy modal AFTER state is marked sent. The
      // modal auto-copies the message to clipboard; operator just
      // pastes. Resolves on OK / close.
      await sendToWhatsApp(raceNumber);
      await promptNextRaceSignal(raceNumber);
      await checkPreviousRaces(raceNumber);
    });
    // Refresh export display via the helper (handles strikethrough for re-export).
    raceData = await getRace(raceNumber);
    if (raceData.export_time) {
      document.getElementById('raceExportTime').innerHTML = renderExportTimeText(raceData);
    }
  };

  window._exportOnly = () => {
    showExportModal(raceNumber, async () => {
      raceData = await getRace(raceNumber);
      document.getElementById('raceExportTime').innerHTML = renderExportTimeText(raceData);
      document.getElementById('raceStatus').textContent = 'EXPORTED';
      document.getElementById('raceStatus').className = 'badge badge-exported';
      showToast('Export complete. Send results to the scoring team when ready.', 'success', 5000);
      await promptNextRaceSignal(raceNumber);
      await checkPreviousRaces(raceNumber);
    });
  };

  window._sendOnly = async () => {
    raceData = await getRace(raceNumber);
    if (!raceData.export_time) {
      if (!confirm('Results not yet exported for this race. Export first before sending?')) return;
      showExportModal(raceNumber);
      return;
    }
    // Mark sent BEFORE showing the copy-modal — modal-open means
    // operator intent to send. Same semantics as _exportAndSend.
    if (raceData.send_time) raceData.prev_send_time = raceData.send_time;
    raceData.send_time = nowISO();
    raceData.status = 'sent';
    await saveRace(raceData);
    const ts = await getTimesheet(raceNumber) || { race_number: raceNumber };
    if (!ts.send_time) { ts.send_time = raceData.send_time; } else { ts.re_send_time = raceData.send_time; }
    await saveTimesheet(ts);
    document.getElementById('raceSendTime').innerHTML = renderSendTimeText(raceData);
    document.getElementById('raceStatus').textContent = 'SENT';
    document.getElementById('raceStatus').className = 'badge badge-sent';
    broadcastChange('race-updated', { race_number: raceNumber });
    // Capture the send in a backup (export-time backup predates it; the last
    // race has no later export to catch it). Fire-and-forget.
    import('../backup.js').then(m => m.backupAfterSend(raceNumber)).catch(() => {});
    await sendToWhatsApp(raceNumber);
    await promptNextRaceSignal(raceNumber);
    await checkPreviousRaces(raceNumber);
  };

  // Print / Open handlers
  window._printResult = () => printResult(raceNumber);
  window._printDraw = () => printDraw(raceNumber);

  // Download Draw: build the draw .xls from the bundled template
  // (same pipeline export uses), trigger a browser download. Online
  // viewers can't write to the local filesystem — this is the way
  // they get the printable file. Filename is always {N}.xls.
  window._downloadDraw = async () => {
    try {
      const { buildDrawXlsxBlob } = await import('../draw-gen.js');
      const blob = await buildDrawXlsxBlob(raceNumber);
      if (!blob) {
        showToast('Could not build draw file.', 'error');
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${raceNumber}.xls`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      showToast(`Download failed: ${err.message}`, 'error', 5000);
    }
  };
  window._openDraw = () => openFileFromFolder('01 Input_Draw', raceNumber);
  window._openResult = async () => {
    const r = await getRace(raceNumber);
    if (!r?.export_time) {
      showToast('Results not yet exported for this race.', 'error');
      return;
    }
    openFileFromFolder('12 Output_Results', raceNumber);
  };

  // Import Joyi orchestrator:
  //   1. Try auto-find in the Joyi folder (.jyd preferred for results,
  //      .lcd kicked off in background for start time).
  //   2. On miss, open a single-zone drag-drop modal that accepts any of
  //      .jyd / .xls / .lcd (sorted by extension automatically) and runs
  //      the same import + LCD-fetch pipeline.
  window._importJoyi = async () => {
    const [{ findJoyiTripletForRace }, { enqueueLcdFetch }] = await Promise.all([
      import('../joyi-folder.js'),
      import('../joyi-lcd-pending.js'),
    ]);

    // Try auto-find first.
    try {
      const found = await findJoyiTripletForRace(raceNumber);
      const resultsFile = found.jyd || found.xls;
      if (resultsFile) {
        await runJoyiImport(resultsFile);
        // The triplet already includes the .lcd File when it's sitting
        // alongside in the Joyi folder. Use it directly — derives in a
        // few KB read, no second folder walk needed. Falling through to
        // enqueueLcdFetch was failing silently in some setups (the
        // ranged Drive path or the second nested-walk wasn't matching
        // the lcd filename consistently), so the operator would see no
        // Joyi start time after auto-import.
        if (found.lcd) {
          try {
            const { deriveJoyiStartTime, setJoyiStartTimeOnRace } = await import('../import.js');
            const iso = await deriveJoyiStartTime(found.lcd);
            if (iso) {
              await setJoyiStartTimeOnRace(raceNumber, iso);
              broadcastChange('race-updated', { race_number: raceNumber, joyi_start: true });
            } else {
              console.warn(`Joyi .lcd found for race ${raceNumber} but start-time derivation returned null`);
            }
          } catch (err) {
            console.warn(`Joyi .lcd derive failed for race ${raceNumber}:`, err);
          }
        } else {
          // .lcd not in the same folder — fall back to the lazy lookup.
          enqueueLcdFetch(raceNumber);
        }
        showToast(`Imported ${resultsFile.name} from ${found.source === 'drive' ? 'Drive' : 'Joyi folder'}`, 'success', 3000);
        return;
      }
      if (found.source !== 'none') {
        showToast(`Race ${raceNumber} not found in ${found.folderPath} — pick manually.`, 'info', 4000);
      }
    } catch (err) {
      console.warn('Joyi auto-find failed:', err);
    }

    // Fallback: drag-drop picker.
    await showJoyiDropPicker(async (files) => {
      const results = files.find(f => /\.jyd$/i.test(f.name)) || files.find(f => /\.xlsx?$/i.test(f.name));
      const lcd = files.find(f => /\.lcd$/i.test(f.name));
      if (!results) {
        showToast('Need a .jyd or .xls file with the results', 'warning');
        return;
      }
      await runJoyiImport(results);
      // If the operator handed us the .lcd directly, derive start time
      // straight from the File (no folder lookup needed).
      if (lcd) {
        const { deriveJoyiStartTime, setJoyiStartTimeOnRace } = await import('../import.js');
        const iso = await deriveJoyiStartTime(lcd);
        if (iso) {
          await setJoyiStartTimeOnRace(raceNumber, iso);
          broadcastChange('race-updated', { race_number: raceNumber, joyi_start: true });
        }
      } else {
        // Otherwise try the folder-based lazy lookup in case the .lcd is
        // sitting alongside the .jyd in the configured Joyi folder.
        enqueueLcdFetch(raceNumber);
      }
    });
  };

  // Shared inner pipeline used by both auto-find and the drop-picker.
  async function runJoyiImport(file) {
    const { parseJoyiAnyFile } = await import('../import.js');
    const parsed = await parseJoyiAnyFile(file);
    if (parsed.raceNumber !== raceNumber) {
      if (!confirm(`This Joyi file is for Race ${parsed.raceNumber}, but you're on Race ${raceNumber}. Import anyway?`)) return;
    }
    // Confirm before clobbering manually-entered times. We probe with
    // skipIfHasUserData first — if it returns skipped=true the race has
    // user data and a re-import would overwrite it. The auto-watcher
    // gets the same protection in joyi-watch.js (no prompt, just skip
    // + toast). Here, since this IS the operator's explicit action,
    // we ask whether to proceed.
    const probe = await importJoyiToDb({ ...parsed, raceNumber }, { skipIfHasUserData: true });
    if (probe.skipped) {
      const ok = confirm(
        `Race ${raceNumber} has manually-entered times. ` +
        `Overwrite with Joyi results from this file?`);
      if (!ok) return;
      // Re-run without the skip flag so the import actually lands.
      await importJoyiToDb({ ...parsed, raceNumber });
    }
    const freshLanes = await getLaneResults(raceNumber);
    const newGridData = buildGridData(freshLanes, configData?.lane_count || 6);
    for (let i = 0; i < newGridData.length; i++) {
      grid.setRowData(i, newGridData[i]);
    }
    raceData = await getRace(raceNumber);
    // Joyi import overwrites lane_results.team_name with finisher names;
    // rebuild drawsByLane from race.draw_lanes (preserved at draw import)
    // so the output preview shows the correct boat-lane → team mapping.
    rebuildDrawsByLane(raceData, freshLanes);
    // Refresh scoring context — joyi import sets computed_position which
    // feeds the Score/Total/Overall columns.
    scoringCtx = await buildScoringContext(raceData, configData);
    recalculate();
    notifyResultEntryStarted(raceNumber).catch(() => {});
    broadcastChange('race-updated', { race_number: raceNumber, joyi_results: true });
  }

  // Batch adjustment — store handler ref for cleanup in unmount
  const p1Input = document.getElementById('batchP1Time');
  if (p1Input) {
    p1InputHandler = () => {
      const timeMode = configData?.time_format_mode || 'mss00';
      const data = grid?.getData();
      if (!data) return;
      const firstTime = data.find(r => r.raw_time)?.raw_time;
      if (p1Input.value && firstTime) {
        batchDeltaMs = calcBatchDelta(p1Input.value, firstTime, timeMode);
        const deltaDisplay = timeToDisplay(msToTime(Math.abs(batchDeltaMs), timeMode), timeMode);
        document.getElementById('batchDelta').textContent = (batchDeltaMs >= 0 ? '+' : '-') + deltaDisplay;
        // If the override is already on, keep the persisted delta in
        // sync so export uses the latest figure.
        if (batchOverrideEnabled && raceData) {
          raceData.batch_delta_ms = batchDeltaMs;
          saveRace(raceData).catch(err => console.warn('Save batch delta failed:', err));
        }
        clearTimeout(batchDebounceTimer);
        batchDebounceTimer = setTimeout(recalculate, 200);
      }
    };
    p1Input.addEventListener('input', p1InputHandler);
  }

  // Apply batch adjustment toggle — only re-rank when explicitly opted in.
  // Persist the operator's intent + the current delta on the race record
  // so the EXPORT can apply the same shift. Without the persisted flag,
  // the toggle only affected the in-memory output preview and exports
  // silently came out with unshifted times.
  const toggleEl = document.getElementById('batchOverrideToggle');
  if (toggleEl) {
    toggleEl.checked = batchOverrideEnabled;
    toggleEl.addEventListener('change', async () => {
      batchOverrideEnabled = toggleEl.checked;
      raceData.batch_override_enabled = batchOverrideEnabled;
      raceData.batch_delta_ms = batchOverrideEnabled ? batchDeltaMs : 0;
      try { await saveRace(raceData); } catch (err) { console.warn('Save batch state failed:', err); }
      recalculate();
    });
  }

  // Photo Finish — try to auto-find the .lcd/.jyd pair in the Joyi shared
  // folder first (saves the operator a manual pick during race-day). On
  // miss or no folder connection, fall through to the drag-and-drop picker.
  window._photoFinish = async () => {
    const [{ showPhotoFinishPicker, showPhotoFinishModal }, { findJoyiTripletForRace }] = await Promise.all([
      import('../photo-finish.js'),
      import('../joyi-folder.js'),
    ]);

    // .lcd files can be hundreds of MB and a Drive download on slow
    // internet takes a while. Show a loading modal with a Cancel button
    // so the operator can bail out and switch to drag-drop instead of
    // staring at a frozen page. Cancel doesn't kill the in-flight
    // download (Drive API doesn't expose abort here), but it short-
    // circuits the result handling and opens the manual picker.
    const loadingModal = document.createElement('div');
    loadingModal.id = 'photoFinishLoadingModal';
    loadingModal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9999; display:flex; align-items:center; justify-content:center;';
    loadingModal.innerHTML = `
      <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:24px 28px; max-width:440px; width:90%; box-shadow:var(--shadow-lg); text-align:center;">
        <div style="font-size:14px; color:var(--text-primary); margin-bottom:8px;">
          <i class="material-icons" style="font-size:20px; vertical-align:middle; color:var(--accent); animation:spin 1.4s linear infinite;">refresh</i>
          Loading photo finish for Race ${raceNumber}…
        </div>
        <div style="font-size:12px; color:var(--text-tertiary); margin-bottom:14px;">
          .lcd files are large (often 100-300 MB). On a slow connection this can take a minute.
        </div>
        <button class="btn btn-ghost btn-sm" id="photoFinishLoadCancel">Cancel &amp; pick files manually</button>
      </div>
      <style>@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }</style>
    `;
    document.body.appendChild(loadingModal);
    let cancelled = false;
    loadingModal.querySelector('#photoFinishLoadCancel').addEventListener('click', () => {
      cancelled = true;
      loadingModal.remove();
      // Open the manual picker so the operator isn't stuck.
      showPhotoFinishPicker(raceData).catch(() => {});
    });

    try {
      const found = await findJoyiTripletForRace(raceNumber);
      if (cancelled) return; // operator already moved on
      loadingModal.remove();
      // Auto-open only when BOTH .lcd and .jyd are present — JYD is required
      // for the time axis to anchor on race-start. Missing either falls
      // through to the drag-and-drop picker so the operator can supply
      // whatever's missing.
      if (found.lcd && found.jyd) {
        showToast(`Loaded ${found.lcd.name} + .jyd from ${found.source === 'drive' ? 'Drive' : 'Joyi folder'}`, 'success', 2500);
        await showPhotoFinishModal(raceData, [found.lcd, found.jyd]);
        return;
      }
      if (found.source !== 'none') {
        const missing = !found.lcd ? '.lcd' : '.jyd';
        showToast(`No ${missing} for race ${raceNumber} in ${found.folderPath} — pick manually.`, 'info', 4500);
      }
      // Pre-fill picker with whatever we did find so the operator only
      // has to provide the missing half.
      await showPhotoFinishPicker(raceData, { lcd: found.lcd || null, jyd: found.jyd || null });
      return;
    } catch (err) {
      console.warn('Photo finish auto-find failed:', err);
      if (!cancelled) loadingModal.remove();
    } finally {
      // Defensive cleanup — guarantees the modal doesn't linger on any
      // exit path. Removing twice is a no-op.
      if (document.getElementById('photoFinishLoadingModal')) {
        loadingModal.remove();
      }
    }
    if (cancelled) return;
    // Fallback: empty drag-and-drop picker.
    await showPhotoFinishPicker(raceData);
  };

  // #5 — smart "Photo PNG": read the saved results PNG instantly, else
  // generate it on the fly from the Joyi files, else open the manual picker.
  // Parallel to _photoFinish (interactive view); neither affects the other.
  window._photoFinishPng = async () => {
    const { smartViewPhotoFinishPng } = await import('../photo-finish-png.js');
    await smartViewPhotoFinishPng(raceData);
  };
}

/**
 * Lightweight drag-drop modal used by Import Joyi when auto-find misses.
 * Single combined zone accepting `.jyd`, `.xls`, `.xlsx`, `.lcd`. The
 * `onAccept(files)` callback runs when the operator clicks "Open" with at
 * least one valid file present.
 */
async function showJoyiDropPicker(onAccept) {
  // Reuse styles from photo-finish picker for consistency.
  const existing = document.getElementById('joyiDropPicker');
  if (existing) existing.remove();

  const files = [];
  const refresh = () => {
    const status = modal.querySelector('#joyiDropStatus');
    const openBtn = modal.querySelector('#joyiDropOpen');
    if (files.length === 0) {
      status.innerHTML = '<span style="color:var(--text-tertiary);">drop here or click</span>';
      openBtn.disabled = true;
    } else {
      status.innerHTML = files.map(f => `${f.name} <span style="color:var(--text-tertiary);">(${(f.size/1024).toFixed(1)} KB)</span>`).join('<br>');
      // Need at least one results-bearing file (.jyd or .xls).
      const hasResults = files.some(f => /\.(jyd|xlsx?)$/i.test(f.name));
      openBtn.disabled = !hasResults;
    }
  };

  const modal = document.createElement('div');
  modal.id = 'joyiDropPicker';
  modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:9998; display:flex; align-items:center; justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:18px 20px; width:min(540px,92vw); box-shadow:var(--shadow-lg);">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
        <i class="material-icons" style="font-size:22px; color:var(--accent);">cloud_download</i>
        <strong style="font-size:15px;">Import Joyi — Race ${raceNumber}</strong>
        <span style="flex:1;"></span>
        <button class="btn btn-ghost btn-sm" id="joyiDropClose"><i class="material-icons" style="font-size:18px;">close</i></button>
      </div>
      <p style="font-size:12px; color:var(--text-tertiary); margin:0 0 12px;">
        Drop the <code>.jyd</code> (or <code>.xls</code>) for results, plus
        the matching <code>.lcd</code> if you want the Joyi-derived start
        time. Files are sorted by extension automatically — you can drop them
        in any order.
      </p>
      <div id="joyiDropZone"
           style="border:2px dashed var(--border); border-radius:var(--radius-sm); padding:24px;
                  text-align:center; cursor:pointer; transition:all 0.15s; min-height:120px;
                  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px;">
        <i class="material-icons" style="font-size:28px; color:var(--text-tertiary);">upload_file</i>
        <div style="font-weight:600;">.jyd / .xls / .lcd</div>
        <div id="joyiDropStatus" style="font-size:11px; color:var(--text-tertiary); min-height:14px;"></div>
      </div>
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:14px;">
        <button class="btn btn-ghost" id="joyiDropCancel">Cancel</button>
        <button class="btn btn-primary" id="joyiDropOpen" disabled>
          <i class="material-icons">open_in_new</i> Import
        </button>
      </div>
      <input type="file" id="joyiDropInput" accept=".jyd,.xls,.xlsx,.lcd" multiple style="display:none;">
    </div>
  `;
  document.body.appendChild(modal);
  refresh();

  const zone = modal.querySelector('#joyiDropZone');
  const input = modal.querySelector('#joyiDropInput');

  function acceptFiles(list) {
    for (const f of list) {
      if (/\.(jyd|xlsx?|lcd)$/i.test(f.name)) files.push(f);
    }
    refresh();
  }

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.style.background = 'rgba(255,255,255,0.04)'; });
  zone.addEventListener('dragleave', () => { zone.style.background = ''; });
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.style.background = ''; acceptFiles(e.dataTransfer.files); });
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { acceptFiles(input.files); input.value = ''; });

  const close = () => modal.remove();
  modal.querySelector('#joyiDropClose').addEventListener('click', close);
  modal.querySelector('#joyiDropCancel').addEventListener('click', close);
  modal.querySelector('#joyiDropOpen').addEventListener('click', async () => {
    close();
    try { await onAccept(files); }
    catch (err) { showToast(`Joyi import failed: ${err.message}`, 'error'); }
  });
}
