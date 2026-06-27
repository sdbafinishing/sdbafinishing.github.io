/**
 * SDBA RDMS — Scoring Page
 * Multi-round scoring tables for scored divisions.
 * Points: 1st = lane_count+1, Nth = lane_count-(N-1), DNS/DNF/DSQ/DQ = 0.
 * Tiebreak: RFinal × 1.001 > R2 × 1.00001 > R1 × 1.0000001.
 */
import { getAllRaces, getAllDivisions, getLaneResults, getConfig, getRace, getDivisionRounds, bulkSaveLaneResults } from '../db.js';
import { positionToPoints, computeRankings } from '../race.js';
import { computeDivisionStanding, computeTieredStanding, formatTotalTime } from '../division-standing.js';
import { timeToDisplay, showToast } from '../utils.js';
import { broadcastChange } from '../app.js';

export async function mountScoringPage(container) {
  const config = await getConfig();
  const races = await getAllRaces();
  const divisions = await getAllDivisions();

  // Scoring is always calculable. The `scoring_exported` config flag only
  // controls whether the export pipeline writes a scoring file out — the
  // in-app Scoring page renders as long as there are races with R1/R2/RFinal
  // flags set. The "no scored races" empty-state below handles the case
  // where no flags have been set.

  // A division appears on the Scoring tab if EITHER:
  //   • it has points-scored races (scoring_flag R1/R2/RFinal), OR
  //   • it's configured for a time method (standings_method) or tiered scoring
  //     (a round with tier_order) — these don't use scoring_flag, so we key off
  //     the division config + its rounds' race lists instead.
  const divGroups = {};
  // Points races, grouped by division (incl. an "unassigned" bucket).
  for (const r of races.filter(r => r.scoring_flag && r.scoring_flag !== 'N')) {
    const divId = r.division_id || 'unassigned';
    if (!divGroups[divId]) divGroups[divId] = [];
    divGroups[divId].push(r);
  }
  // Time / tiered divisions — include the races listed in their rounds.
  for (const d of divisions) {
    const rounds = await getDivisionRounds(d.id).catch(() => []);
    const isTiered = (rounds || []).some(rr => rr.tier_order != null && rr.tier_order > 0);
    const isTime = d.standings_method === 'time_sum' || d.standings_method === 'time_combined';
    if (!isTiered && !isTime) continue;
    const roundRaceNums = new Set((rounds || []).flatMap(rr => rr.race_numbers || []));
    const divRaces = races.filter(r => roundRaceNums.has(r.race_number));
    if (divRaces.length) divGroups[d.id] = divRaces;
  }

  if (Object.keys(divGroups).length === 0) {
    container.innerHTML = `
      <h4 style="font-size:18px; font-weight:600; margin-bottom:16px;">Scoring</h4>
      <div class="card" style="text-align:center; padding:32px; color:var(--text-tertiary);">
        No scored divisions yet. Set scoring flags (R1/R2/RFinal) in Setup → Race Schedule,
        or configure a time/tiered method (Final standing / Tier order) in Setup → Divisions.
      </div>`;
    return;
  }

  const laneCount = config?.lane_count || 6;
  const timeMode = config?.time_format_mode || 'mss00';

  // Build tabs for each scored division
  const divIds = Object.keys(divGroups);
  let tabsHtml = '<div class="tabs">';
  divIds.forEach((divId, idx) => {
    const div = divisions.find(d => d.id === parseInt(divId));
    const name = div?.division_name || `Division ${divId}`;
    const colour = div?.colour_hex || '#9ca3af';
    tabsHtml += `<button class="tab ${idx === 0 ? 'active' : ''}" data-tab="scoring-${divId}"
                          data-colour="${colour}"
                          onclick="window._scoringTab('${divId}')"
                          style="border-bottom-color:${idx === 0 ? colour : 'transparent'};">
                   <span style="display:inline-block; width:8px; height:8px; border-radius:2px; background:${colour}; margin-right:6px;"></span>
                   ${name}
                 </button>`;
  });
  tabsHtml += '</div>';

  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
      <h4 style="font-size:18px; font-weight:600; margin:0;">Scoring</h4>
      <button class="btn btn-outline btn-sm" id="recomputeScoringBtn" onclick="window._recomputeAllScoring()"
              title="Re-runs rank computation against raw_time for every scored race and persists the result back to lane_results. Use when a race's scoring column is blank despite results being entered.">
        <i class="material-icons" style="font-size:16px;">refresh</i> Recompute all scored races
      </button>
    </div>
    ${tabsHtml}
    <div id="scoringTabContent"></div>
  `;

  window._scoringTab = async (divId) => {
    document.querySelectorAll('.tab').forEach(t => {
      const isActive = t.dataset.tab === `scoring-${divId}`;
      t.classList.toggle('active', isActive);
      // The underline colour is an inline style (per-division colour), which
      // overrides the .active CSS — so move it explicitly, else the underline
      // stays under the first tab.
      t.style.borderBottomColor = isActive ? (t.dataset.colour || '') : 'transparent';
    });
    await renderScoringDiv(divId, divGroups[divId], laneCount, timeMode, divisions);
  };

  // Recompute handler — for races where computed_position is null in DB
  // (e.g. exported before the auto-recompute landed) the scoring table
  // shows blank columns despite times being entered. This button fetches
  // each scored race's lane_results, re-runs computeRankings, and
  // persists. Idempotent — running it on a clean DB is a no-op.
  window._recomputeAllScoring = async () => {
    const btn = document.getElementById('recomputeScoringBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Recomputing…'; }
    try {
      let touchedRaces = 0;
      for (const r of scoredRaces) {
        const lanes = await getLaneResults(r.race_number);
        if (!lanes.length) continue;
        computeRankings(lanes, timeMode, 0);
        await bulkSaveLaneResults(lanes);
        touchedRaces++;
        broadcastChange('race-updated', { race_number: r.race_number });
      }
      showToast(`Recomputed positions for ${touchedRaces} scored race${touchedRaces === 1 ? '' : 's'}. Reloading…`, 'success', 3000);
      // Reload the page so the scoring tables reflect fresh data.
      setTimeout(() => mountScoringPage(container), 600);
    } catch (err) {
      showToast(`Recompute failed: ${err.message}`, 'error', 6000);
    } finally {
      if (btn) { btn.disabled = false; }
    }
  };

  // Export just the overall standings for a division (any method).
  window._exportOverallRanks = async (divId) => {
    showToast('Exporting overall ranks…', 'info', 1500);
    try {
      const { exportOverallRanks } = await import('../scoring-export.js');
      const res = await exportOverallRanks(divId);
      if (res.success) {
        showToast(`Overall ranks exported: ${res.filename}${res.complete ? '' : ' (PROVISIONAL — totals TBC)'}`, 'success', 4500);
      } else {
        showToast(`Export failed: ${res.error}`, 'error', 5000);
      }
    } catch (err) {
      showToast(`Export failed: ${err.message}`, 'error', 5000);
    }
  };

  // Render first division
  await renderScoringDiv(divIds[0], divGroups[divIds[0]], laneCount, timeMode, divisions);

  // Auto-refresh: re-mount when draws are imported or a race updates (results
  // entered / exported), so the scoring tables aren't stale. Debounced so a
  // burst of broadcasts (e.g. bulk draw import) only re-renders once.
  if (scoringRefreshHandler) {
    window.removeEventListener('rdms-draw-imported', scoringRefreshHandler);
    window.removeEventListener('rdms-race-updated', scoringRefreshHandler);
  }
  let pending = null;
  scoringRefreshHandler = () => {
    clearTimeout(pending);
    pending = setTimeout(() => { mountScoringPage(container).catch(() => {}); }, 250);
  };
  window.addEventListener('rdms-draw-imported', scoringRefreshHandler);
  window.addEventListener('rdms-race-updated', scoringRefreshHandler);
}

let scoringRefreshHandler = null;

export function unmountScoringPage() {
  delete window._scoringTab;
  delete window._recomputeAllScoring;
  delete window._exportOverallRanks;
  if (scoringRefreshHandler) {
    window.removeEventListener('rdms-draw-imported', scoringRefreshHandler);
    window.removeEventListener('rdms-race-updated', scoringRefreshHandler);
    scoringRefreshHandler = null;
  }
}

async function renderScoringDiv(divId, scoredRaces, laneCount, timeMode, divisions) {
  const content = document.getElementById('scoringTabContent');
  if (!content) return;

  const div = divisions.find(d => d.id === parseInt(divId));

  // Sort races by scoring flag order: R1 < R2 < RFinal
  const flagOrder = { 'R1': 1, 'R2': 2, 'RFinal': 3 };
  scoredRaces.sort((a, b) => (flagOrder[a.scoring_flag] || 0) - (flagOrder[b.scoring_flag] || 0));

  const exportBtn = `<button class="btn btn-outline btn-sm" onclick="window._exportOverallRanks('${divId}')" title="Export the standings table (sections + overall) as an .xlsx for the scoring team."><i class="material-icons" style="font-size:15px;">file_download</i> Export table</button>`;

  // ── Tiered division (Gold/Silver/Bronze + Bowl) — any round has tier_order ──
  const rounds = await getDivisionRounds(parseInt(divId, 10)).catch(() => []);
  if ((rounds || []).some(r => r.tier_order != null && r.tier_order > 0)) {
    await renderTieredScoringDiv(content, div, rounds, scoredRaces, laneCount, timeMode, exportBtn);
    return;
  }

  // ── Time-scored divisions (methods #1/#2) render their own table ──
  const method = div?.standings_method || 'points';
  if (method === 'time_sum' || method === 'time_combined') {
    await renderTimeScoringDiv(content, div, scoredRaces, laneCount, timeMode, exportBtn);
    return;
  }

  // Tiebreaker multipliers
  const multipliers = { 'R1': 1.0000001, 'R2': 1.00001, 'RFinal': 1.001 };

  // Build race reference header
  const raceHeaders = scoredRaces.map(r => `${r.scoring_flag} = Race ${r.race_number}`).join(', ');

  // Collect results from all scored races in parallel (avoid N+1)
  const allLanes = await Promise.all(scoredRaces.map(r => getLaneResults(r.race_number)));
  // Rank each race from raw_time rather than trusting the stored
  // computed_position — a Joyi re-import can leave it null, which would score
  // the race 0 points (the bug where one category showed RFinal = 0).
  scoredRaces.forEach((r, i) => {
    computeRankings(allLanes[i], timeMode, r.batch_override_enabled ? (r.batch_delta_ms || 0) : 0);
  });
  const roundResults = {};
  scoredRaces.forEach((r, i) => { roundResults[r.scoring_flag] = allLanes[i]; });

  // Build team score map — keyed by team_code (stable across rounds even
  // when team_name on lane_results differs between draw-imported rows
  // (long form) and joyi-imported rows (often a short abbreviated form).
  // For display, prefer the team_name from race.draw_lanes (boat-lane
  // mapped, joyi-safe). Falls back to the row's own team_name when no
  // draw_lanes snapshot exists yet.
  //
  // We need each race's draw_lanes to resolve the display name by lane.
  const drawLanesByRace = {};
  for (const r of scoredRaces) {
    const race = await getRace(r.race_number);
    drawLanesByRace[r.race_number] = Array.isArray(race?.draw_lanes) ? race.draw_lanes : [];
  }

  const teamScores = {};
  for (const r of scoredRaces) {
    const lanes = roundResults[r.scoring_flag] || [];
    for (const lr of lanes) {
      if (!lr.team_name || lr.team_name === '---' || lr.team_name === '') continue;

      // Resolve the canonical team_name from the source race's
      // draw_lanes by matching boat lane (= lr.lane_input, falling back
      // to lr.lane_number for legacy data where the operator never
      // set lane_input).
      const boatLane = parseInt(lr.lane_input, 10) || lr.lane_number;
      const drawLanes = drawLanesByRace[r.race_number] || [];
      const drawLane = drawLanes.find(dl => dl.lane_number === boatLane);
      const displayName = (drawLane?.team_name) || lr.team_name;
      const teamCode = (drawLane?.team_code) || lr.team_code || lr.team_name;
      const key = teamCode || displayName;

      if (!teamScores[key]) {
        teamScores[key] = { team_name: displayName, team_code: teamCode || '' };
      }

      const points = positionToPoints(lr.computed_position, laneCount);
      const multiplier = multipliers[r.scoring_flag] || 1;
      teamScores[key][r.scoring_flag + '_points'] = points;
      teamScores[key][r.scoring_flag + '_weighted'] = points * multiplier;
      teamScores[key][r.scoring_flag + '_time'] = lr.raw_time || '';
      teamScores[key][r.scoring_flag + '_position'] = lr.computed_position;
      teamScores[key][r.scoring_flag + '_remarks'] = lr.remarks || '';
    }
  }

  // Calculate totals
  const teams = Object.values(teamScores);
  teams.forEach(t => {
    t.total_weighted = scoredRaces.reduce((sum, r) => sum + (t[r.scoring_flag + '_weighted'] || 0), 0);
    t.total_display = Math.round(t.total_weighted);
  });

  // Sort by total_weighted descending (highest = best)
  teams.sort((a, b) => b.total_weighted - a.total_weighted);

  // Assign overall rank
  teams.forEach((t, i) => {
    if (i === 0) {
      t.rank = 1;
    } else if (t.total_weighted === teams[i - 1].total_weighted) {
      t.rank = teams[i - 1].rank;
    } else {
      t.rank = i + 1;
    }
  });

  // Check if any round has results
  const hasResults = teams.some(t => t.total_weighted > 0);

  // Totals are provisional until the final round (RFinal) is scored — label
  // them "so far" so a mid-series standing isn't mistaken for the final
  // result. (#15)
  const finalReached = scoredRaces.some(r => r.scoring_flag === 'RFinal');

  content.innerHTML = `
    <div class="card" style="margin-top:16px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px;">
        <div>
          <strong style="font-size:14px;">${div?.division_name || 'Unassigned Division'}</strong>
          <span style="font-size:13px; color:var(--text-tertiary); margin-left:12px;">${raceHeaders}</span>
        </div>
        ${exportBtn}
      </div>

      ${!hasResults
        ? '<p style="color:var(--text-tertiary); font-size:13px;">No results yet for scored races in this division.</p>'
        : `<div style="overflow:auto;">
            <table class="output-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th style="text-align:left;">Team Name</th>
                  <th>Code</th>
                  ${scoredRaces.map(r => `<th class="scoring-header">
                    ${r.scoring_flag}<br>
                    <a href="#/race/${r.race_number}" style="font-size:11px; color:var(--accent); text-decoration:underline;" title="Open race ${r.race_number}">Race ${r.race_number}</a>
                  </th>`).join('')}
                  <th class="scoring-header">Total${finalReached ? '' : '<br><span style="font-size:10px; font-weight:600; color:var(--warning-text, #b45309);">so far</span>'}</th>
                  <th class="scoring-header">Overall${finalReached ? '' : '<br><span style="font-size:10px; font-weight:600; color:var(--warning-text, #b45309);">so far</span>'}</th>
                </tr>
              </thead>
              <tbody>
                ${teams.map(t => `
                  <tr>
                    <td class="cell-position ${t.rank === 1 ? 'first' : t.rank === 2 ? 'second' : t.rank === 3 ? 'third' : ''}">${t.rank}</td>
                    <td class="team-name">${t.team_name}</td>
                    <td>${t.team_code}</td>
                    ${scoredRaces.map(r => {
                      const pts = t[r.scoring_flag + '_points'];
                      const rmk = t[r.scoring_flag + '_remarks'];
                      return `<td class="scoring-cell">${rmk ? rmk : (pts || '—')}</td>`;
                    }).join('')}
                    <td class="scoring-cell" style="font-weight:700;">${t.total_display || '—'}</td>
                    <td class="cell-position ${t.rank === 1 ? 'first' : t.rank === 2 ? 'second' : t.rank === 3 ? 'third' : ''}">${t.rank}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <p style="font-size:11px; color:var(--text-tertiary); margin-top:8px;">
            ${finalReached ? '' : '<strong>Provisional standings — the final round (RFinal) has not been scored yet; totals are "so far".</strong><br>'}
            ^ RFinal score includes ×1.001 multiplier as tiebreak decider for total score.
          </p>`
      }
    </div>
  `;
}

/**
 * Time-scored divisions (method #1 combined-time, #2 sum-of-times). Renders the
 * standing from the canonical computeDivisionStanding so it matches the export.
 * Totals show "TBC" until the round/series is complete.
 */
async function renderTimeScoringDiv(content, div, scoredRaces, laneCount, timeMode, exportBtn) {
  const lanesByRace = new Map();
  await Promise.all(scoredRaces.map(async r => lanesByRace.set(r.race_number, await getLaneResults(r.race_number))));
  const rounds = await getDivisionRounds(div.id);
  const standing = computeDivisionStanding(div, rounds, scoredRaces, lanesByRace, laneCount, timeMode);

  const methodLabel = div.standings_method === 'time_sum'
    ? 'Sum of times across rounds (method #2)'
    : 'Combined time of the final round (method #1)';
  const raceHeaders = scoredRaces.map(r => `${r.scoring_flag} = Race ${r.race_number}`).join(', ');

  const teams = standing
    ? [...standing.teamTotals.values()].sort((a, b) => (a.total_place ?? 9999) - (b.total_place ?? 9999))
    : [];
  const complete = standing?.complete;
  const isSum = div.standings_method === 'time_sum';

  const cell = (t, r) => {
    const pr = t.perRound?.[r.race_number];
    if (!pr) return '—';
    const ms = pr.exported_ms ?? pr.time_ms;
    return ms != null ? `${formatTotalTime(ms)}<br><span style="font-size:11px; color:var(--text-tertiary);">P${pr.position ?? '—'}</span>` : '—';
  };

  content.innerHTML = `
    <div class="card" style="margin-top:16px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px;">
        <div>
          <strong style="font-size:14px;">${div?.division_name || 'Division'}</strong>
          <span style="font-size:13px; color:var(--text-tertiary); margin-left:12px;">${raceHeaders}</span>
          <div style="font-size:11px; color:var(--text-tertiary); margin-top:2px;">Scoring: ${methodLabel}</div>
        </div>
        ${exportBtn}
      </div>
      ${teams.length === 0
        ? '<p style="color:var(--text-tertiary); font-size:13px;">No results yet for scored races in this division.</p>'
        : `<div style="overflow:auto;">
            <table class="output-table">
              <thead>
                <tr>
                  <th>Rank${complete ? '' : '<br><span style="font-size:10px; font-weight:600; color:var(--warning-text, #b45309);">TBC</span>'}</th>
                  <th style="text-align:left;">Team Name</th>
                  <th>Code</th>
                  ${scoredRaces.map(r => `<th class="scoring-header">${r.scoring_flag}<br><a href="#/race/${r.race_number}" style="font-size:11px; color:var(--accent); text-decoration:underline;">Race ${r.race_number}</a></th>`).join('')}
                  <th class="scoring-header">${isSum ? 'Total Time' : 'Final'}${complete ? '' : '<br><span style="font-size:10px; font-weight:600; color:var(--warning-text, #b45309);">TBC</span>'}</th>
                </tr>
              </thead>
              <tbody>
                ${teams.map(t => `
                  <tr>
                    <td class="cell-position ${t.total_place === 1 ? 'first' : t.total_place === 2 ? 'second' : t.total_place === 3 ? 'third' : ''}">${complete ? (t.total_place ?? '—') : 'TBC'}</td>
                    <td class="team-name">${t.team_name || ''}</td>
                    <td>${t.team_code || ''}</td>
                    ${scoredRaces.map(r => `<td class="scoring-cell">${cell(t, r)}</td>`).join('')}
                    <td class="scoring-cell" style="font-weight:700;">${complete ? (t.total_display || (isSum ? '—' : '')) : 'TBC'}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <p style="font-size:11px; color:var(--text-tertiary); margin-top:8px;">
            ${complete
              ? 'Standings are final.'
              : '<strong>Provisional — Total / Rank show TBC until every race in the ' + (isSum ? 'series' : 'final round') + ' is exported, then re-export the sheets.</strong>'}
            ${standing?.unresolvedTie ? '<br><strong style="color:var(--danger);">⚠ An unbroken tie needs manual resolution.</strong>' : ''}
            Times are the exported (hundredth) times; full ms breaks ties.
          </p>`
      }
    </div>
  `;
}

/**
 * Tiered division (Gold/Silver/Bronze cups + Bowl). Renders one section per
 * tier (in tier order) showing each team's section rank + time, plus the
 * stacked overall rank. Exportable via the same "Export table" button.
 */
async function renderTieredScoringDiv(content, div, rounds, scoredRaces, laneCount, timeMode, exportBtn) {
  const lanesByRace = new Map();
  await Promise.all(scoredRaces.map(async r => lanesByRace.set(r.race_number, await getLaneResults(r.race_number))));
  const standing = computeTieredStanding(div, rounds, scoredRaces, lanesByRace, laneCount, timeMode);

  if (!standing || standing.tiers.length === 0) {
    content.innerHTML = `<div class="card" style="margin-top:16px;"><p style="color:var(--text-tertiary); font-size:13px;">No tiers configured (set a Tier order on the final rounds in Setup → Divisions).</p></div>`;
    return;
  }

  const tierBlock = (tier) => {
    const methodLabel = tier.method === 'time_sum' ? 'summed time' : 'time';
    const rows = tier.rows.slice().sort((a, b) => (a.section_rank ?? 9999) - (b.section_rank ?? 9999));
    return `
      <div style="margin-top:14px;">
        <div style="font-weight:600; font-size:13px; margin-bottom:4px;">
          ${tier.tier_name}
          <span style="font-size:11px; color:var(--text-tertiary); font-weight:400;">— ranked by ${methodLabel}${tier.complete ? '' : ' · <span style="color:var(--warning-text,#b45309); font-weight:600;">TBC</span>'}</span>
        </div>
        <div style="overflow:auto;">
          <table class="output-table">
            <thead><tr>
              <th>Section</th><th style="text-align:left;">Team</th><th>Code</th><th>Time</th><th>Overall</th>
            </tr></thead>
            <tbody>
              ${rows.length === 0 ? '<tr><td colspan="5" style="color:var(--text-tertiary); font-size:12px;">No results yet.</td></tr>' : rows.map(row => `
                <tr>
                  <td class="cell-position ${row.section_rank === 1 ? 'first' : row.section_rank === 2 ? 'second' : row.section_rank === 3 ? 'third' : ''}">${row.section_rank ?? '—'}</td>
                  <td class="team-name">${row.team_name || ''}</td>
                  <td>${row.team_code || ''}</td>
                  <td>${row.value_display || '—'}</td>
                  <td style="font-weight:700;">${row.overall_rank == null ? 'TBC' : row.overall_rank}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  };

  content.innerHTML = `
    <div class="card" style="margin-top:16px;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:6px;">
        <div>
          <strong style="font-size:14px;">${div?.division_name || 'Division'}</strong>
          <span style="font-size:12px; color:var(--text-tertiary); margin-left:10px;">Tiered standing — Overall stacks the tiers in order; each tier keeps its own Section rank.</span>
        </div>
        ${exportBtn}
      </div>
      ${standing.unresolvedTie ? '<p style="font-size:11px; color:var(--danger);"><strong>⚠ An unbroken tie needs manual resolution.</strong></p>' : ''}
      ${standing.seeding ? seedingBlock(standing.seeding) : ''}
      ${standing.tiers.map(tierBlock).join('')}
    </div>
  `;
}

/** Render the summed-heats "seeding" standing block (who's seeded into tiers). */
function seedingBlock(seeding) {
  const rows = seeding.rows.slice().sort((a, b) => (a.section_rank ?? 9999) - (b.section_rank ?? 9999));
  return `
    <div style="margin-top:14px; padding:8px 10px; border:1px dashed var(--border); border-radius:var(--radius-sm);">
      <div style="font-weight:600; font-size:13px; margin-bottom:4px;">
        Summed standings — ${seeding.label}
        <span style="font-size:11px; color:var(--text-tertiary); font-weight:400;">— seeding basis (sum of heat times)${seeding.complete ? '' : ' · <span style="color:var(--warning-text,#b45309); font-weight:600;">in progress</span>'}</span>
      </div>
      <div style="overflow:auto;">
        <table class="output-table">
          <thead><tr><th>Rank</th><th style="text-align:left;">Team</th><th>Code</th><th>Total time</th></tr></thead>
          <tbody>
            ${rows.length === 0 ? '<tr><td colspan="4" style="color:var(--text-tertiary); font-size:12px;">No heat results yet.</td></tr>' : rows.map(row => `
              <tr>
                <td class="cell-position ${row.section_rank === 1 ? 'first' : row.section_rank === 2 ? 'second' : row.section_rank === 3 ? 'third' : ''}">${row.section_rank ?? '—'}</td>
                <td class="team-name">${row.team_name || ''}</td>
                <td>${row.team_code || ''}</td>
                <td style="font-weight:600;">${row.value_display || '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}
