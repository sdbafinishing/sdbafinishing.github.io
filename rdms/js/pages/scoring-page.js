/**
 * SDBA RDMS — Scoring Page
 * Multi-round scoring tables for scored divisions.
 * Points: 1st = lane_count+1, Nth = lane_count-(N-1), DNS/DNF/DSQ/DQ = 0.
 * Tiebreak: RFinal × 1.001 > R2 × 1.00001 > R1 × 1.0000001.
 */
import { getAllRaces, getAllDivisions, getLaneResults, getConfig } from '../db.js';
import { positionToPoints } from '../race.js';
import { timeToDisplay } from '../utils.js';

export async function mountScoringPage(container) {
  const config = await getConfig();
  const races = await getAllRaces();
  const divisions = await getAllDivisions();

  if (!config?.scoring_enabled) {
    container.innerHTML = `
      <h4 style="font-size:18px; font-weight:600; margin-bottom:16px;">Scoring</h4>
      <div class="card" style="text-align:center; padding:32px; color:var(--text-tertiary);">
        Scoring is not enabled. Enable it in Setup → Event Config → Scoring.
      </div>`;
    return;
  }

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
    const name = div?.div_short_ref || div?.division_name || `Division ${divId}`;
    const colour = div?.colour_hex || '#9ca3af';
    tabsHtml += `<button class="tab ${idx === 0 ? 'active' : ''}" data-tab="scoring-${divId}"
                          onclick="window._scoringTab('${divId}')"
                          style="border-bottom-color:${idx === 0 ? colour : 'transparent'};">
                   <span style="display:inline-block; width:8px; height:8px; border-radius:2px; background:${colour}; margin-right:6px;"></span>
                   ${name}
                 </button>`;
  });
  tabsHtml += '</div>';

  container.innerHTML = `
    <h4 style="font-size:18px; font-weight:600; margin-bottom:16px;">Scoring</h4>
    ${tabsHtml}
    <div id="scoringTabContent"></div>
  `;

  window._scoringTab = async (divId) => {
    document.querySelectorAll('.tab').forEach(t => {
      const isActive = t.dataset.tab === `scoring-${divId}`;
      t.classList.toggle('active', isActive);
    });
    await renderScoringDiv(divId, divGroups[divId], laneCount, timeMode, divisions);
  };

  // Render first division
  await renderScoringDiv(divIds[0], divGroups[divIds[0]], laneCount, timeMode, divisions);
}

export function unmountScoringPage() {
  delete window._scoringTab;
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
  const roundResults = {};
  scoredRaces.forEach((r, i) => { roundResults[r.scoring_flag] = allLanes[i]; });

  // Build team score map — keyed by team_name (since same teams race across rounds)
  const teamScores = {};

  for (const r of scoredRaces) {
    const lanes = roundResults[r.scoring_flag] || [];
    for (const lr of lanes) {
      if (!lr.team_name || lr.team_name === '---' || lr.team_name === '') continue;

      if (!teamScores[lr.team_name]) {
        teamScores[lr.team_name] = { team_name: lr.team_name, team_code: lr.team_code || '' };
      }

      const points = positionToPoints(lr.computed_position, laneCount);
      const multiplier = multipliers[r.scoring_flag] || 1;
      teamScores[lr.team_name][r.scoring_flag + '_points'] = points;
      teamScores[lr.team_name][r.scoring_flag + '_weighted'] = points * multiplier;
      teamScores[lr.team_name][r.scoring_flag + '_time'] = lr.raw_time || '';
      teamScores[lr.team_name][r.scoring_flag + '_position'] = lr.computed_position;
      teamScores[lr.team_name][r.scoring_flag + '_remarks'] = lr.remarks || '';
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
                  ${scoredRaces.map(r => `<th class="scoring-header">${r.scoring_flag}<br><small>Race ${r.race_number}</small></th>`).join('')}
                  <th class="scoring-header">Total</th>
                  <th class="scoring-header">Overall</th>
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
            ^ RFinal score includes ×1.001 multiplier as tiebreak decider for total score.
          </p>`
      }
    </div>
  `;
}
