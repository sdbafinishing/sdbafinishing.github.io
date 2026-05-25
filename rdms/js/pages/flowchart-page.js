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
  // Source of truth: race.draw_lanes (the boat-lane → team snapshot taken
  // at draw-import time). lane_results.team_code is overwritten by Joyi
  // import to finish-order finisher codes, which would silently drop
  // boats from the team-filter map for any race already joyi-imported.
  const teamMap = new Map(); // team_code → team_name
  fcRacesByTeamCode = new Map(); // team_code → Set<race_number>
  for (const r of races) {
    const drawLanes = Array.isArray(r.draw_lanes) ? r.draw_lanes : null;
    if (drawLanes && drawLanes.length > 0) {
      drawLanes.forEach(dl => {
        if (!dl?.team_code) return;
        const name = (dl.team_name && dl.team_name !== '---' && dl.team_name !== '' && !/^R\d+[BP]\d+$/i.test(dl.team_name))
          ? dl.team_name : dl.team_code;
        if (!teamMap.has(dl.team_code)) teamMap.set(dl.team_code, name);
        if (!fcRacesByTeamCode.has(dl.team_code)) fcRacesByTeamCode.set(dl.team_code, new Set());
        fcRacesByTeamCode.get(dl.team_code).add(r.race_number);
      });
    } else {
      // Legacy races without draw_lanes — fall back to lane_results.
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
  }

  // Display as "(CODE) name" — code first so operators can scan codes,
  // name carried alongside for readability.
  const teamOptions = [...teamMap.entries()]
    .map(([code, name]) => ({ value: code, label: `(${code}) ${name}` }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const divOptions = divisions.map(d => ({
    value: d.id,
    label: d.division_name || `Div ${d.id}`,
    sublabel: '',
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
  // Track the widest division so the outer SVG viewBox is sized to fit
  // the largest bracket — otherwise the right edge of multi-column
  // brackets gets clipped by the hardcoded 800px viewBox.
  let svgMaxWidth = 480;

  for (const div of filteredDivs) {
    const rounds = await getDivisionRounds(div.id);
    const progs = await getDivisionProgressions(div.id);

    if (rounds.length === 0) continue;

    // ── Bracket-style column assignment ──
    // Column index for each round is the LENGTH OF THE LONGEST CHAIN OF
    // PROGRESSIONS leading INTO it, not the operator-typed round_number.
    // This way "Cup Semi" and "Plate Semi" both reachable in one hop from
    // Heats land in column 1, and the 4 finals all sit in column 2 —
    // exactly the layout the official bracket diagrams use. round_number
    // is still preserved for tie-breaking within a column.
    const depthByRoundId = computeRoundDepths(rounds, progs);
    const roundGroups = {};
    for (const r of rounds) {
      const depth = depthByRoundId.get(r.id) ?? 0;
      if (!roundGroups[depth]) roundGroups[depth] = [];
      roundGroups[depth].push(r);
    }
    // Sort tiers within each column by round_number then tier_name so
    // the layout is stable across reloads.
    for (const k of Object.keys(roundGroups)) {
      roundGroups[k].sort((a, b) =>
        (a.round_number || 0) - (b.round_number || 0) ||
        String(a.tier_name || '').localeCompare(String(b.tier_name || '')));
    }
    const roundNums = Object.keys(roundGroups).sort((a, b) => Number(a) - Number(b));

    // Layout constants. ONE BOX PER TIER (round-row in DB), not per
    // individual race — matches the official bracket diagrams. Each
    // box's label includes the tier name + the race-number list.
    const nodeW = 220, nodeH = 56, gapX = 80, gapY = 18;
    const colWidth = nodeW + gapX;
    const divLabelH = 30;

    // Rows per column = number of TIERS in that column (no longer
    // multiplied out by race count, because each tier collapses to a
    // single node now).
    let maxRows = 0;
    roundNums.forEach(rn => {
      maxRows = Math.max(maxRows, roundGroups[rn].length);
    });

    const divHeight = divLabelH + maxRows * (nodeH + gapY) + 20;
    const divWidth = roundNums.length * colWidth + 40;
    if (divWidth > svgMaxWidth) svgMaxWidth = divWidth;

    // Division header
    svgContent += `<g transform="translate(0, ${yOffset})">`;
    svgContent += `<rect x="0" y="0" width="${divWidth}" height="${divHeight}" rx="8" fill="none" stroke="${div.colour_hex || '#9ca3af'}" stroke-width="1.5" stroke-dasharray="4"/>`;
    svgContent += `<text x="10" y="18" font-size="13" font-weight="600" fill="${div.colour_hex || '#333'}">${div.division_name || 'Division'}</text>`;

    // Render nodes per column. ONE NODE PER TIER (a row in the
    // division_rounds table). The label lists the race numbers
    // belonging to that tier, matching the printed bracket diagram.
    const tierPositions = {}; // key: round.id → { x (right edge), y (centre), lx (left edge) }

    roundNums.forEach((depth, colIdx) => {
      const tiers = roundGroups[depth];
      const x = 20 + colIdx * colWidth;

      // Vertically centre when this column has fewer tiers than the
      // tallest one — mirrors the centred look of a printed bracket
      // where the final-round box sits across from the middle of the
      // semi-final column.
      const colRows = tiers.length;
      const colTopPad = ((maxRows - colRows) * (nodeH + gapY)) / 2;

      // Column header reads "Round N" where N is depth+1 (1-indexed
      // for the operator).
      svgContent += `<text x="${x + nodeW / 2}" y="${divLabelH + 10}" font-size="10" fill="var(--text-tertiary)" text-anchor="middle" font-weight="500">Round ${Number(depth) + 1}</text>`;

      tiers.forEach((tier, tierIdx) => {
        const y = divLabelH + 20 + colTopPad + tierIdx * (nodeH + gapY);
        const tierRaceNums = tier.race_numbers || [];

        // Per-tier status — derived from the rolled-up race statuses.
        const tierRaceObjs = tierRaceNums.map(rn => raceMap[rn]).filter(Boolean);
        const allDone = tierRaceObjs.length > 0 && tierRaceObjs.every(r =>
          r.status === 'exported' || r.status === 'sent');
        const anyStarted   = tierRaceObjs.some(r => r.status === 'started');
        const anyCancelled = tierRaceObjs.some(r => r.status === 'cancelled');
        let fillColor = 'var(--bg-input)';
        let strokeColor = 'var(--border)';
        if (allDone)         { fillColor = 'var(--success-bg)'; strokeColor = 'var(--success)'; }
        else if (anyStarted) { fillColor = 'var(--info-bg)';    strokeColor = 'var(--info)'; }
        else if (anyCancelled) { fillColor = 'var(--danger-bg)'; strokeColor = 'var(--danger)'; }

        // Team highlight: any race in this tier matches a selected team.
        const highlight = selectedTeamCodes.size > 0 &&
          tierRaceNums.some(rn => highlightedRaces.has(rn));

        // Tier box.
        svgContent += `<rect x="${x}" y="${y}" width="${nodeW}" height="${nodeH}" rx="6" fill="${fillColor}" stroke="${highlight ? 'var(--accent)' : strokeColor}" stroke-width="${highlight ? 2.5 : 1}"/>`;

        // Top line: tier name. Falls back to "Round N" when blank.
        const tierLabel = tier.tier_name || `Round ${tier.round_number || '?'}`;
        const shortLabel = tierLabel.length > 28 ? tierLabel.slice(0, 26) + '…' : tierLabel;
        svgContent += `<text x="${x + 10}" y="${y + 20}" font-size="12" font-weight="600" fill="var(--text-primary)">${escapeXml(shortLabel)}</text>`;

        // Bottom line: race-number list. Compact ranges for runs of 3+.
        let racesStr = '(no races)';
        if (tierRaceNums.length > 0) {
          const sorted = [...tierRaceNums].sort((a, b) => a - b);
          // Compact: e.g. [1,2,3,5,7,8,9] → "1-3, 5, 7-9"
          const parts = [];
          let runStart = sorted[0], runEnd = sorted[0];
          for (let i = 1; i <= sorted.length; i++) {
            const cur = sorted[i];
            if (cur === runEnd + 1) { runEnd = cur; }
            else {
              parts.push(runEnd === runStart ? `${runStart}`
                       : runEnd === runStart + 1 ? `${runStart}, ${runEnd}`
                       : `${runStart}-${runEnd}`);
              runStart = cur; runEnd = cur;
            }
          }
          racesStr = `Race ${parts.join(', ')}`;
          if (racesStr.length > 30) racesStr = racesStr.slice(0, 28) + '…';
        }
        svgContent += `<text x="${x + 10}" y="${y + 40}" font-size="10" fill="var(--text-secondary)">${escapeXml(racesStr)}</text>`;

        // Roll-up status dot at top-right.
        if (allDone || anyStarted || anyCancelled) {
          const dot = allDone ? '#10b981' : (anyStarted ? '#3b82f6' : '#ef4444');
          svgContent += `<circle cx="${x + nodeW - 12}" cy="${y + 12}" r="4" fill="${dot}"/>`;
        }

        tierPositions[tier.id] = {
          x: x + nodeW,
          y: y + nodeH / 2,
          lx: x,
        };
      });
    });

    // Render progression arrows — one per (from_tier → to_tier).
    // Arrows now connect TIER boxes, not individual race nodes, so the
    // chart looks like a real bracket diagram.
    for (const prog of progs) {
      const from = tierPositions[prog.from_round_id];
      const to   = tierPositions[prog.to_round_id];
      if (!from || !to) continue;

      const strokeCol = 'var(--text-tertiary)';
      const midX = from.x + (to.lx - from.x) / 2;

      if (prog.is_scored) {
        // Double line (====) for scored progressions.
        svgContent += `<path d="M${from.x},${from.y - 2} C${midX},${from.y - 2} ${midX},${to.y - 2} ${to.lx},${to.y - 2}" fill="none" stroke="${strokeCol}" stroke-width="1.5"/>`;
        svgContent += `<path d="M${from.x},${from.y + 2} C${midX},${from.y + 2} ${midX},${to.y + 2} ${to.lx},${to.y + 2}" fill="none" stroke="${strokeCol}" stroke-width="1.5"/>`;
      } else {
        svgContent += `<path d="M${from.x},${from.y} C${midX},${from.y} ${midX},${to.y} ${to.lx},${to.y}" fill="none" stroke="${strokeCol}" stroke-width="1.2"/>`;
      }

      // Arrow head at the destination tier's left edge.
      svgContent += `<polygon points="${to.lx},${to.y} ${to.lx - 7},${to.y - 5} ${to.lx - 7},${to.y + 5}" fill="${strokeCol}"/>`;

      // Position-range label at the curve midpoint.
      if (prog.position_range && prog.position_range !== 'all') {
        svgContent += `<text x="${midX}" y="${(from.y + to.y) / 2 - 5}" font-size="10" fill="var(--text-tertiary)" text-anchor="middle" font-weight="500">${escapeXml(prog.position_range)}</text>`;
      }
      if (prog.is_scored) {
        svgContent += `<text x="${midX}" y="${(from.y + to.y) / 2 + 12}" font-size="9" fill="var(--text-tertiary)" text-anchor="middle" font-style="italic">scored</text>`;
      }
    }

    svgContent += '</g>';
    yOffset += divHeight + 20;
  }

  // Render SVG. The outer `flowchart-scroll` wrapper lets phones swipe
  // horizontally when the chart is wider than the viewport (mobile CSS
  // strips the max-width cap so the SVG can extend past the viewport).
  // totalWidth is the widest division's box width plus a small margin,
  // so multi-column brackets aren't clipped on the right.
  const totalWidth = Math.max(svgMaxWidth + 20, 800);
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
          ? `<a class="btn btn-primary" href="#/setup/divisions">
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
          Fix issues in <a href="#/setup/divisions" style="color:var(--accent);">Setup → Divisions</a>
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

// SVG text content also needs <>& escaped. Quote forms are fine inside
// the text node so we don't bother — keeping the helper minimal.
function escapeXml(s) {
  return String(s ?? '').replace(/[&<>]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
  }[c]));
}

/**
 * Compute each round's column depth in the bracket using BFS over the
 * progression edges. depth = length of the longest chain of
 * progressions leading INTO this round.
 *   - Rounds with no incoming progressions live at depth 0.
 *   - A round reachable in one hop from depth 0 lives at depth 1.
 *   - Parallel tiers (Cup Semi + Plate Semi both fed by Heats) share
 *     a depth and end up in the same column visually.
 * Cycles are tolerated — any round in a cycle gets depth 0 and any
 * second-visit recursion bails to avoid infinite descent.
 *
 * @returns {Map<round.id, number>} depth keyed by round id
 */
function computeRoundDepths(rounds, progs) {
  const depthByRoundId = new Map();
  // Adjacency list: for each round, the set of rounds that progress
  // INTO it. Used as the recursion's parent lookup.
  const parentsOf = new Map();
  for (const r of rounds) parentsOf.set(r.id, []);
  for (const p of progs) {
    if (parentsOf.has(p.to_round_id) && parentsOf.has(p.from_round_id)) {
      parentsOf.get(p.to_round_id).push(p.from_round_id);
    }
  }

  function depthOf(roundId, visiting) {
    if (depthByRoundId.has(roundId)) return depthByRoundId.get(roundId);
    if (visiting.has(roundId)) return 0; // cycle — break here
    visiting.add(roundId);
    const parents = parentsOf.get(roundId) || [];
    if (parents.length === 0) {
      depthByRoundId.set(roundId, 0);
      visiting.delete(roundId);
      return 0;
    }
    let best = 0;
    for (const pid of parents) {
      const d = depthOf(pid, visiting) + 1;
      if (d > best) best = d;
    }
    depthByRoundId.set(roundId, best);
    visiting.delete(roundId);
    return best;
  }

  for (const r of rounds) depthOf(r.id, new Set());
  return depthByRoundId;
}
