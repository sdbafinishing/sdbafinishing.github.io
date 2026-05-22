/**
 * SDBA RDMS — Flowchart Page
 * Visual DAG of division progressions. Filter by division or team.
 * Renders as SVG with race nodes and progression arrows.
 */
import { getAllRaces, getAllDivisions, getDivisionRounds, getDivisionProgressions,
         getLaneResults, getAllRaceRelationships } from '../db.js';
import { showToast } from '../utils.js';
import { mountMultiSelect } from '../components/multi-select.js';
import { runFlowchartAudit } from '../flowchart-audit.js';

let fcDivSelect = null;
let fcTeamSelect = null;
let fcRacesByTeamCode = null;

export async function mountFlowchartPage(container) {
  const divisions = await getAllDivisions();
  const races = await getAllRaces();
  const raceMap = Object.fromEntries(races.map(r => [r.race_number, r]));

  // Run the audit up front. If the flowchart isn't ready (no divisions or
  // no rounds anywhere), short-circuit with a directed empty state instead
  // of rendering an empty SVG and an "All teams" picker with nothing to
  // pick from.
  const audit = await runFlowchartAudit();
  if (!audit.ready) {
    container.innerHTML = renderNotReadyState(audit);
    return;
  }

  // Build unique team list keyed by team_code with team_name as the display.
  // Also remember which races each team_code appears in, so the team filter
  // can highlight those races without re-scanning lane_results every render.
  const teamMap = new Map(); // team_code → team_name
  fcRacesByTeamCode = new Map(); // team_code → Set<race_number>
  for (const r of races) {
    const lanes = await getLaneResults(r.race_number);
    lanes.forEach(l => {
      if (!l.team_code) return;
      const name = (l.team_name && l.team_name !== '---' && l.team_name !== '' && !/^R\d+[BP]\d+$/i.test(l.team_name))
        ? l.team_name : (l.team_code);
      if (!teamMap.has(l.team_code)) teamMap.set(l.team_code, name);
      if (!fcRacesByTeamCode.has(l.team_code)) fcRacesByTeamCode.set(l.team_code, new Set());
      fcRacesByTeamCode.get(l.team_code).add(r.race_number);
    });
  }

  // Display as "(CODE) name" — code first so operators can scan codes,
  // name carried alongside for readability.
  const teamOptions = [...teamMap.entries()]
    .map(([code, name]) => ({ value: code, label: `(${code}) ${name}` }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const divOptions = divisions.map(d => ({
    value: d.id,
    label: d.div_short_ref || d.division_name || `Div ${d.id}`,
    sublabel: d.division_name && d.div_short_ref && d.division_name !== d.div_short_ref ? d.division_name : '',
  }));

  container.innerHTML = `
    <h4 style="font-size:18px; font-weight:600; margin-bottom:8px;">Race Flowchart</h4>

    <!-- Audit panel: surfaces conflicts (red) and missing data (yellow)
         picked up by flowchart-audit.js. Collapsed when clean; expanded
         automatically when something's wrong. -->
    <div id="fcAuditPanel" style="margin-bottom:12px;">${renderAuditPanel(audit)}</div>

    <!-- Filters -->
    <div style="display:flex; gap:12px; margin-bottom:16px; flex-wrap:wrap; align-items:center;">
      <div id="fcDivPickerWrap"></div>
      <div id="fcTeamPickerWrap"></div>
      <button class="btn btn-ghost" id="fcClearBtn">
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

  fcDivSelect = mountMultiSelect(document.getElementById('fcDivPickerWrap'), {
    options: divOptions,
    placeholder: 'All divisions',
    allLabel: 'All divisions',
    searchPlaceholder: 'Filter divisions…',
    onChange: () => renderFlowchart(divisions, races, raceMap),
  });

  fcTeamSelect = mountMultiSelect(document.getElementById('fcTeamPickerWrap'), {
    options: teamOptions,
    placeholder: 'Highlight teams…',
    allLabel: `All teams (${teamOptions.length})`,
    searchPlaceholder: 'Search code or name…',
    onChange: () => renderFlowchart(divisions, races, raceMap),
  });

  document.getElementById('fcClearBtn').addEventListener('click', () => {
    fcDivSelect.setSelected([]);
    fcTeamSelect.setSelected([]);
    renderFlowchart(divisions, races, raceMap);
  });

  renderFlowchart(divisions, races, raceMap);
}

export function unmountFlowchartPage() {
  if (fcDivSelect) { fcDivSelect.destroy(); fcDivSelect = null; }
  if (fcTeamSelect) { fcTeamSelect.destroy(); fcTeamSelect = null; }
  fcRacesByTeamCode = null;
  delete window._fcRender;
}

async function renderFlowchart(divisions, races, raceMap) {
  const container = document.getElementById('flowchartContainer');
  if (!container) return;

  // Multi-select state: empty = no filter (show all).
  const selectedDivIds = new Set((fcDivSelect?.getSelected() || []).map(Number));
  const selectedTeamCodes = new Set(fcTeamSelect?.getSelected() || []);

  // Highlight any race that contains *any* selected team.
  const highlightedRaces = new Set();
  if (selectedTeamCodes.size > 0 && fcRacesByTeamCode) {
    selectedTeamCodes.forEach(code => {
      const raceSet = fcRacesByTeamCode.get(code);
      if (raceSet) raceSet.forEach(rn => highlightedRaces.add(rn));
    });
  }

  // Filter divisions
  const filteredDivs = selectedDivIds.size === 0
    ? divisions
    : divisions.filter(d => selectedDivIds.has(d.id));

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

          // Team highlight — driven by the precomputed team→races map so we
          // catch the actual lane assignments, not just title text matches.
          const highlight = selectedTeamCodes.size > 0 && highlightedRaces.has(raceNum);

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

  // Render SVG. The outer `flowchart-scroll` wrapper lets phones swipe
  // horizontally when the chart is wider than the viewport (mobile CSS
  // strips the max-width cap so the SVG can extend past the viewport).
  const totalWidth = 800;
  container.innerHTML = `
    <div class="flowchart-scroll">
      <svg width="100%" viewBox="0 0 ${totalWidth} ${yOffset || 100}" style="max-width:${totalWidth}px; min-width:${Math.min(totalWidth, 480)}px;">
        <style>
          text { font-family: 'Inter', sans-serif; }
        </style>
        ${svgContent || '<text x="50%" y="50" text-anchor="middle" fill="var(--text-tertiary)" font-size="14">No flowchart data. Configure divisions with rounds first.</text>'}
      </svg>
    </div>
  `;
}

// ──────────────── Audit panel rendering ────────────────

/**
 * Empty-state shown when no divisions or no rounds are configured. Directs
 * the operator to the right place to fix it (Setup → Divisions). Also
 * surfaces the most critical missing data so they don't waste a click on
 * an empty Divisions tab.
 */
function renderNotReadyState(audit) {
  const stats = audit.stats;
  const haveRaces = stats.races > 0;
  return `
    <h4 style="font-size:18px; font-weight:600; margin-bottom:16px;">Race Flowchart</h4>
    <div class="card" style="padding:32px; text-align:center;">
      <i class="material-icons" style="font-size:48px; color:var(--text-tertiary);">account_tree</i>
      <h3 style="margin-top:12px; color:var(--text-secondary); font-size:16px;">
        Flowchart needs divisions to be configured
      </h3>
      <p style="color:var(--text-tertiary); margin-top:8px; font-size:13px; max-width:480px; margin-left:auto; margin-right:auto;">
        ${haveRaces
          ? `${stats.races} races are loaded but no division rounds exist yet.
             Configure divisions (or auto-populate from the draws) so the flowchart
             knows how to group and progress them.`
          : 'No races have been imported yet. Import draws, then configure divisions.'}
      </p>
      <div style="margin-top:18px; display:flex; gap:10px; justify-content:center; flex-wrap:wrap;">
        ${haveRaces
          ? `<a class="btn btn-primary" href="#/setup">
               <i class="material-icons">tune</i> Configure Divisions
             </a>`
          : `<a class="btn btn-primary" href="#/import">
               <i class="material-icons">upload_file</i> Import Draws
             </a>`}
      </div>
    </div>
  `;
}

/**
 * Render the audit panel. Two banners — conflicts on top (red), missing
 * data below (amber). Each is collapsed to the first 3 items with a
 * "show all" toggle so a single broken event doesn't bury the chart.
 */
function renderAuditPanel(audit) {
  const c = audit.conflicts || [];
  const m = audit.missing || [];
  if (c.length === 0 && m.length === 0) {
    // Clean — show a subtle one-liner so the operator knows the audit ran.
    return `
      <div style="font-size:12px; color:var(--success); display:flex; align-items:center; gap:6px;">
        <i class="material-icons" style="font-size:16px;">check_circle</i>
        Flowchart audit clean — ${audit.stats.divisions} divisions, ${audit.stats.rounds} rounds, ${audit.stats.progressions} progressions.
      </div>
    `;
  }

  return `
    <details ${c.length > 0 ? 'open' : ''} style="background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-sm); padding:0;">
      <summary style="cursor:pointer; padding:10px 14px; font-size:13px; font-weight:600; user-select:none; display:flex; align-items:center; gap:8px;">
        <i class="material-icons" style="font-size:18px; color:${c.length > 0 ? 'var(--danger)' : 'var(--warning)'};">
          ${c.length > 0 ? 'error' : 'warning'}
        </i>
        Flowchart audit:
        ${c.length > 0 ? `<span style="color:var(--danger);">${c.length} conflict${c.length === 1 ? '' : 's'}</span>` : ''}
        ${c.length > 0 && m.length > 0 ? '·' : ''}
        ${m.length > 0 ? `<span style="color:var(--warning);">${m.length} missing</span>` : ''}
      </summary>
      <div style="padding:0 14px 12px;">
        ${c.length > 0 ? `
          <div class="section-header" style="border:none; margin:6px 0 4px; color:var(--danger);">Conflicts</div>
          ${renderFindingList(c)}
        ` : ''}
        ${m.length > 0 ? `
          <div class="section-header" style="border:none; margin:10px 0 4px; color:var(--warning);">Missing data</div>
          ${renderFindingList(m)}
        ` : ''}
        <div style="margin-top:10px; font-size:11px; color:var(--text-tertiary);">
          Fix issues in <a href="#/setup" style="color:var(--accent);">Setup → Divisions</a>
          ${audit.stats.uncoveredRaces > 0 ? ` — ${audit.stats.uncoveredRaces} race(s) aren't in any round yet.` : ''}
        </div>
      </div>
    </details>
  `;
}

function renderFindingList(items) {
  const MAX = 3;
  const head = items.slice(0, MAX);
  const tail = items.slice(MAX);
  const liStyle = 'padding:4px 0; font-size:12px; color:var(--text-secondary); border-bottom:1px solid var(--border-subtle);';
  let html = `<ul style="list-style:none; padding:0; margin:0;">`;
  for (const it of head) html += renderFindingRow(it, liStyle);
  if (tail.length > 0) {
    const detailsId = 'fc-find-' + Math.random().toString(36).slice(2, 8);
    html += `</ul>
      <details id="${detailsId}" style="margin-top:4px;">
        <summary style="cursor:pointer; font-size:11px; color:var(--accent); padding:4px 0;">
          Show ${tail.length} more…
        </summary>
        <ul style="list-style:none; padding:0; margin:0;">`;
    for (const it of tail) html += renderFindingRow(it, liStyle);
    html += `</ul></details>`;
  } else {
    html += `</ul>`;
  }
  return html;
}

function renderFindingRow(it, liStyle) {
  const refLink = it.refs?.race_number
    ? `<a href="#/race/${it.refs.race_number}" style="color:var(--accent); margin-left:6px; font-size:11px;">Race ${it.refs.race_number} →</a>`
    : '';
  return `
    <li style="${liStyle}">
      ${escapeHtml(it.message)}
      ${refLink}
      <span style="display:inline-block; margin-left:6px; font-size:10px; color:var(--text-tertiary); font-family:monospace;">${it.code}</span>
    </li>
  `;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
