/**
 * SDBA RDMS — Scoring Page
 * Multi-round scoring tables for scored divisions.
 * Points: 1st = lane_count+1, Nth = lane_count-(N-1), DNS/DNF/DSQ/DQ = 0.
 * Tiebreak: RFinal × 1.001 > R2 × 1.00001 > R1 × 1.0000001.
 */
import { getAllRaces, getAllDivisions, getLaneResults, getConfig, getRace, bulkSaveLaneResults } from '../db.js';
import { positionToPoints, computeRankings } from '../race.js';
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

  // Find scored race pairs/groups
  // Scored races have scoring_flag = R1, R2, or RFinal
  const scoredRaces = races.filter(r => r.scoring_flag && r.scoring_flag !== 'N');

  // Group by division
  const divGroups = {};
  for (const r of scoredRaces) {
    const divId = r.division_id || 'unassigned';
    if (!divGroups[divId]) divGroups[divId] = [];
    divGroups[divId].push(r);
  }

  if (Object.keys(divGroups).length === 0) {
    container.innerHTML = `
      <h4 style="font-size:18px; font-weight:600; margin-bottom:16px;">Scoring</h4>
      <div class="card" style="text-align:center; padding:32px; color:var(--text-tertiary);">
        No scored races found. Set scoring flags (R1/R2/RFinal) in Setup → Race Schedule.
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

  // Render first division
  await renderScoringDiv(divIds[0], divGroups[divIds[0]], laneCount, timeMode, divisions);
}

export function unmountScoringPage() {
  delete window._scoringTab;
  delete window._recomputeAllScoring;
}

async function renderScoringDiv(divId, scoredRaces, laneCount, timeMode, divisions) {
  const content = document.getElementById('scoringTabContent');
  if (!content) return;

  const div = divisions.find(d => d.id === parseInt(divId));

  // Sort races by scoring flag order: R1 < R2 < RFinal
  const flagOrder = { 'R1': 1, 'R2': 2, 'RFinal': 3 };
  scoredRaces.sort((a, b) => (flagOrder[a.scoring_flag] || 0) - (flagOrder[b.scoring_flag] || 0));

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
      <div style="margin-bottom:12px;">
        <strong style="font-size:14px;">${div?.division_name || 'Unassigned Division'}</strong>
        <span style="font-size:13px; color:var(--text-tertiary); margin-left:12px;">${raceHeaders}</span>
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
