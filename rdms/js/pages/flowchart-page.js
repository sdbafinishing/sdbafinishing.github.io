/**
 * SDBA RDMS — Flowchart Page
 * Visual DAG of division progressions. Filter by division or team.
 * Renders as SVG with race nodes and progression arrows.
 */
import { getAllRaces, getAllDivisions, getDivisionRounds, getDivisionProgressions,
         getLaneResults, getAllRaceRelationships } from '../db.js';
import { showToast } from '../utils.js';

export async function mountFlowchartPage(container) {
  const divisions = await getAllDivisions();
  const races = await getAllRaces();
  const raceMap = Object.fromEntries(races.map(r => [r.race_number, r]));

  // Build all teams list for search
  const allTeams = new Set();
  for (const r of races) {
    const lanes = await getLaneResults(r.race_number);
    lanes.forEach(l => {
      if (l.team_name && l.team_name !== '---' && l.team_name !== '' && !/^R\d+[BP]\d+$/i.test(l.team_name)) {
        allTeams.add(l.team_name);
      }
      if (l.team_code) allTeams.add(l.team_code);
    });
  }

  container.innerHTML = `
    <h4 style="font-size:18px; font-weight:600; margin-bottom:16px;">Race Flowchart</h4>

    <!-- Filters -->
    <div style="display:flex; gap:12px; margin-bottom:16px; flex-wrap:wrap; align-items:center;">
      <div class="form-group" style="margin:0;">
        <select class="form-select" id="fcDivFilter" style="min-width:180px;"
                onchange="window._fcRender()">
          <option value="all">All Divisions</option>
          ${divisions.map(d => `<option value="${d.id}">
            ${d.div_short_ref || d.division_name}
          </option>`).join('')}
        </select>
      </div>
      <div class="form-group" style="margin:0;">
        <input class="form-input" id="fcTeamSearch" type="text" list="fcTeamList"
               placeholder="Search team name or code..."
               style="min-width:220px;"
               oninput="window._fcRender()">
        <datalist id="fcTeamList">
          ${[...allTeams].sort().map(t => `<option value="${t}">`).join('')}
        </datalist>
      </div>
      <button class="btn btn-ghost" onclick="document.getElementById('fcTeamSearch').value=''; window._fcRender();">
        <i class="material-icons" style="font-size:16px;">clear</i> Clear
      </button>
    </div>

    <!-- Flowchart SVG -->
    <div class="card" style="padding:16px; overflow:auto;">
      <div id="flowchartContainer" style="min-height:300px;"></div>
    </div>

    <!-- Legend -->
    <div style="margin-top:12px; font-size:12px; color:var(--text-tertiary); display:flex; gap:16px; flex-wrap:wrap;">
      <span><span style="display:inline-block; width:12px; height:12px; background:var(--bg-input); border:1px solid var(--border); border-radius:2px;"></span> Pending</span>
      <span><span style="display:inline-block; width:12px; height:12px; background:var(--info-bg); border:1px solid var(--info); border-radius:2px;"></span> Started</span>
      <span><span style="display:inline-block; width:12px; height:12px; background:var(--success-bg); border:1px solid var(--success); border-radius:2px;"></span> Exported/Sent</span>
      <span><span style="display:inline-block; width:12px; height:12px; background:var(--danger-bg); border:1px solid var(--danger); border-radius:2px;"></span> Cancelled</span>
      <span><span style="display:inline-block; width:24px; height:1px; background:var(--text-tertiary); vertical-align:middle;"></span> Progression</span>
      <span><span style="display:inline-block; width:24px; vertical-align:middle; border-top:2px solid var(--text-tertiary); border-bottom:2px solid var(--text-tertiary); height:6px;"></span> Scored (1:1)</span>
    </div>
  `;

  window._fcRender = () => renderFlowchart(divisions, races, raceMap);
  renderFlowchart(divisions, races, raceMap);
}

export function unmountFlowchartPage() {
  delete window._fcRender;
}

async function renderFlowchart(divisions, races, raceMap) {
  const container = document.getElementById('flowchartContainer');
  if (!container) return;

  const divFilter = document.getElementById('fcDivFilter')?.value || 'all';
  const teamSearch = (document.getElementById('fcTeamSearch')?.value || '').toLowerCase().trim();

  // Filter divisions
  const filteredDivs = divFilter === 'all'
    ? divisions
    : divisions.filter(d => d.id === parseInt(divFilter));

  if (filteredDivs.length === 0) {
    container.innerHTML = '<p style="color:var(--text-tertiary); text-align:center; padding:40px;">No divisions to display.</p>';
    return;
  }

  // Build flowchart data per division
  let svgContent = '';
  let yOffset = 0;

  for (const div of filteredDivs) {
    const rounds = await getDivisionRounds(div.id);
    const progs = await getDivisionProgressions(div.id);

    if (rounds.length === 0) continue;

    // Group rounds by round_number
    const roundGroups = {};
    rounds.forEach(r => {
      if (!roundGroups[r.round_number]) roundGroups[r.round_number] = [];
      roundGroups[r.round_number].push(r);
    });
    const roundNums = Object.keys(roundGroups).sort((a, b) => a - b);

    // Layout constants
    const nodeW = 160, nodeH = 50, gapX = 60, gapY = 16;
    const colWidth = nodeW + gapX;
    const divLabelH = 30;

    // Calculate max rows per column
    let maxRows = 0;
    roundNums.forEach(rn => {
      let rowCount = 0;
      roundGroups[rn].forEach(tier => {
        rowCount += (tier.race_numbers || []).length || 1;
      });
      maxRows = Math.max(maxRows, rowCount);
    });

    const divHeight = divLabelH + maxRows * (nodeH + gapY) + 20;
    const divWidth = roundNums.length * colWidth + 40;

    // Division header
    svgContent += `<g transform="translate(0, ${yOffset})">`;
    svgContent += `<rect x="0" y="0" width="${divWidth}" height="${divHeight}" rx="8" fill="none" stroke="${div.colour_hex || '#9ca3af'}" stroke-width="1.5" stroke-dasharray="4"/>`;
    svgContent += `<text x="10" y="18" font-size="13" font-weight="600" fill="${div.colour_hex || '#333'}">${div.division_name || div.div_short_ref || 'Division'}</text>`;

    // Render nodes per column (round)
    const nodePositions = {}; // key: raceNumber → { x, y, roundIdx }

    roundNums.forEach((rn, colIdx) => {
      const tiers = roundGroups[rn];
      let rowIdx = 0;
      const x = 20 + colIdx * colWidth;

      // Column header
      svgContent += `<text x="${x + nodeW / 2}" y="${divLabelH + 10}" font-size="10" fill="var(--text-tertiary)" text-anchor="middle" font-weight="500">Round ${rn}</text>`;

      tiers.forEach(tier => {
        (tier.race_numbers || []).forEach(raceNum => {
          const race = raceMap[raceNum];
          const y = divLabelH + 20 + rowIdx * (nodeH + gapY);

          // Node color based on status
          let fillColor = 'var(--bg-input)';
          let strokeColor = 'var(--border)';
          if (race) {
            if (race.status === 'cancelled') { fillColor = 'var(--danger-bg)'; strokeColor = 'var(--danger)'; }
            else if (race.status === 'sent' || race.status === 'exported') { fillColor = 'var(--success-bg)'; strokeColor = 'var(--success)'; }
            else if (race.status === 'started') { fillColor = 'var(--info-bg)'; strokeColor = 'var(--info)'; }
          }

          // Team highlight
          let highlight = false;
          if (teamSearch && race) {
            // Check if this race has the searched team — would need lane data
            // For now, highlight is based on title match
            highlight = (race.race_title || '').toLowerCase().includes(teamSearch);
          }

          svgContent += `<rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="6" fill="${fillColor}" stroke="${highlight ? 'var(--accent)' : strokeColor}" stroke-width="${highlight ? 2.5 : 1}"/>`;
          svgContent += `<text x="${x + 8}" y="${y + 18}" font-size="12" font-weight="600" fill="var(--text-primary)">Race ${raceNum}</text>`;

          const title = race?.race_title || tier.tier_name || '';
          const shortTitle = title.length > 20 ? title.slice(0, 18) + '...' : title;
          svgContent += `<text x="${x + 8}" y="${y + 33}" font-size="10" fill="var(--text-secondary)">${shortTitle}</text>`;

          // Status badge
          if (race?.status && race.status !== 'pending') {
            const badgeColors = { started: '#3b82f6', exported: '#10b981', sent: '#10b981', cancelled: '#ef4444' };
            svgContent += `<circle cx="${x + nodeW - 10}" cy="${y + 10}" r="4" fill="${badgeColors[race.status] || '#9ca3af'}"/>`;
          }

          nodePositions[raceNum] = { x: x + nodeW, y: y + nodeH / 2, lx: x, colIdx };
          rowIdx++;
        });
      });
    });

    // Render progression arrows
    for (const prog of progs) {
      const fromRound = rounds.find(r => r.id === prog.from_round_id);
      const toRound = rounds.find(r => r.id === prog.to_round_id);
      if (!fromRound || !toRound) continue;

      const fromRaces = fromRound.race_numbers || [];
      const toRaces = toRound.race_numbers || [];

      for (const fr of fromRaces) {
        for (const tr of toRaces) {
          const from = nodePositions[fr];
          const to = nodePositions[tr];
          if (!from || !to) continue;

          const strokeCol = 'var(--text-tertiary)';
          const midX = from.x + (to.lx - from.x) / 2;

          if (prog.is_scored) {
            // Double line (====) for scored progressions
            svgContent += `<path d="M${from.x},${from.y - 2} C${midX},${from.y - 2} ${midX},${to.y - 2} ${to.lx},${to.y - 2}" fill="none" stroke="${strokeCol}" stroke-width="1.5"/>`;
            svgContent += `<path d="M${from.x},${from.y + 2} C${midX},${from.y + 2} ${midX},${to.y + 2} ${to.lx},${to.y + 2}" fill="none" stroke="${strokeCol}" stroke-width="1.5"/>`;
          } else {
            // Single line for tournament progression
            svgContent += `<path d="M${from.x},${from.y} C${midX},${from.y} ${midX},${to.y} ${to.lx},${to.y}" fill="none" stroke="${strokeCol}" stroke-width="1"/>`;
          }

          // Arrow head
          svgContent += `<polygon points="${to.lx},${to.y} ${to.lx - 6},${to.y - 4} ${to.lx - 6},${to.y + 4}" fill="${strokeCol}"/>`;

          // Position range label
          if (prog.position_range && prog.position_range !== 'all') {
            svgContent += `<text x="${midX}" y="${(from.y + to.y) / 2 - 5}" font-size="9" fill="var(--text-tertiary)" text-anchor="middle">${prog.position_range}</text>`;
          }
          if (prog.is_scored) {
            svgContent += `<text x="${midX}" y="${(from.y + to.y) / 2 + 10}" font-size="8" fill="var(--text-tertiary)" text-anchor="middle" font-style="italic">scored</text>`;
          }
        }
      }
    }

    svgContent += '</g>';
    yOffset += divHeight + 20;
  }

  // Render SVG
  const totalWidth = 800;
  container.innerHTML = `
    <svg width="100%" viewBox="0 0 ${totalWidth} ${yOffset || 100}" style="max-width:${totalWidth}px;">
      <style>
        text { font-family: 'Inter', sans-serif; }
      </style>
      ${svgContent || '<text x="50%" y="50" text-anchor="middle" fill="var(--text-tertiary)" font-size="14">No flowchart data. Configure divisions with rounds first.</text>'}
    </svg>
  `;
}
