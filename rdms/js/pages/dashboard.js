/**
 * SDBA RDMS — Dashboard Page
 *
 * Two modes:
 *   PUBLIC (not logged in): Digital flag panel + current race number. Mobile-friendly.
 *     URL modes: #/dashboard, #/dashboard/finisher, #/dashboard/starter, #/dashboard/race-control
 *   AUTHENTICATED: Full dashboard with summary, progress, alerts + signal panel at top.
 */
import { getAllRaces, getConfig, getAllDivisions } from '../db.js';
import { isoToTime, showToast } from '../utils.js';
import { getSignalStatus, forceSignalRace } from '../next-race-signal.js';
import { renderSignalPanel, cleanupSignalPanel, openStationTab } from './signal-panel.js';

let refreshInterval = null;
let isAuthenticatedUser = false;
let lastRaceHash = ''; // Change detection — skip re-render if data unchanged

export async function mountDashboard(container, params) {
  // Detect auth state
  const { isLocal } = await import('../auth.js');
  const { getRole } = await import('../rbac.js');
  isAuthenticatedUser = isLocal() || getRole() !== 'viewer' || !!window._isAuthenticated;

  // Check if user is actually authenticated (not just default)
  try {
    const appModule = await import('../app.js');
    isAuthenticatedUser = isLocal() || window._rdmsAuthenticated === true;
  } catch {}
  // Simple check: local is always full, web checks auth flag
  if (isLocal()) isAuthenticatedUser = true;

  const stationMode = params?.[0] || null; // 'finisher', 'starter', 'race-control', or null

  if (!isAuthenticatedUser && !isLocal()) {
    renderPublicDashboard(container, stationMode);
  } else {
    await renderFullDashboard(container, stationMode);
  }
}

export function unmountDashboard() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
  delete window._dbSortBy;
  delete window._openStation;
  delete window._dashForceSignal;
  delete window._dashForceSignalCustom;
  delete window._switchStationMode;
  lastRaceHash = '';
  cleanupSignalPanel();
}

// ──── PUBLIC DASHBOARD (pre-login, mobile-friendly) ────

function renderPublicDashboard(container, stationMode) {
  const mode = stationMode || 'view-only';
  const modeLabels = {
    'finisher': { icon: 'sports_score', label: 'Finishing Station', canToggle: 'FinishingReady' },
    'race-control': { icon: 'sports', label: 'Race Control', canToggle: 'RaceControlReady' },
    'starter': { icon: 'flag', label: 'Starter Station', canToggle: 'StarterReady' },
    'view-only': { icon: 'visibility', label: 'View Only', canToggle: null },
  };
  const modeInfo = modeLabels[mode] || modeLabels['view-only'];

  // Check if audio has been unlocked this session
  const audioUnlocked = sessionStorage.getItem('rdms-audio-unlocked') === '1';

  container.innerHTML = `
    <!-- Splash overlay — unlocks audio on tap, then reveals controls -->
    ${audioUnlocked ? '' : `<div id="splashOverlay" style="
      position:fixed; inset:0; z-index:9000;
      background:var(--brand-dark);
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      cursor:pointer; -webkit-tap-highlight-color:transparent;
    ">`}
      <div style="text-align:center; color:#fff;">
        <i class="material-icons" style="font-size:64px; opacity:0.8; margin-bottom:16px;">${modeInfo.icon}</i>
        <h1 style="font-size:24px; font-weight:700; margin-bottom:8px;">SDBA RDMS</h1>
        <p style="font-size:16px; opacity:0.7; margin-bottom:32px;">${modeInfo.label}</p>
        <div style="
          display:inline-flex; align-items:center; gap:8px;
          padding:16px 40px; border-radius:12px;
          background:var(--accent); color:#fff;
          font-size:18px; font-weight:600;
        ">
          <i class="material-icons">touch_app</i> Tap to Enter
        </div>
        <p style="font-size:11px; opacity:0.4; margin-top:16px;">This enables alert sounds</p>
      </div>
    ${audioUnlocked ? '' : '</div>'}

    <!-- Main content (hidden behind splash until tap) -->
    <div id="publicContent" style="max-width:500px; margin:0 auto; padding:8px; ${audioUnlocked ? '' : 'visibility:hidden;'}">

      <!-- Station Mode Selector (large buttons like original home.html) -->
      <div style="display:flex; flex-direction:column; gap:12px; margin-bottom:20px;">
        ${Object.entries(modeLabels).map(([key, info]) => `
          <a href="#/dashboard/${key}" style="
            display:flex; align-items:center; justify-content:center; gap:12px;
            width:100%; padding:24px 16px;
            background:${key === mode ? 'var(--accent)' : 'var(--bg-card)'};
            color:${key === mode ? '#fff' : 'var(--text-primary)'};
            border:${key === mode ? '2px solid var(--accent)' : '2px solid var(--border)'};
            border-radius:16px; text-decoration:none;
            font-size:20px; font-weight:600;
            transition:all 0.2s;
          ">
            <i class="material-icons" style="font-size:28px;">${info.icon}</i>
            ${info.label}
          </a>
        `).join('')}
      </div>

      <!-- Digital Flag Status (mobile-friendly large boxes) -->
      <div id="publicSignalPanel"></div>

      <!-- Current Race Number -->
      <div class="card" style="text-align:center; padding:20px; margin-top:16px;">
        <div style="font-size:12px; color:var(--text-tertiary); text-transform:uppercase; letter-spacing:1px;">Current Race</div>
        <div id="publicCurrentRace" style="font-size:64px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--text-primary); line-height:1.1; margin:8px 0;">
          —
        </div>
        <div id="publicRaceTitle" style="font-size:14px; color:var(--text-secondary);"></div>
      </div>

      <!-- Clock -->
      <div style="text-align:center; margin-top:16px;">
        <span id="publicClock" style="font-size:32px; font-weight:600; font-variant-numeric:tabular-nums; color:var(--text-primary);"></span>
      </div>
    </div>
  `;

  // Splash tap handler — unlock audio + reveal controls
  const splash = document.getElementById('splashOverlay');
  if (splash && !audioUnlocked) {
    splash.addEventListener('click', () => {
      // Play silent audio to unlock browser audio policy
      try {
        const audio = new Audio('https://raw.githubusercontent.com/sdbafinishing/sdbafinishing.github.io/main/Assets/silent.mp3');
        audio.play().catch(() => {});
      } catch {}

      sessionStorage.setItem('rdms-audio-unlocked', '1');
      splash.style.opacity = '0';
      splash.style.transition = 'opacity 0.3s';
      setTimeout(() => {
        splash.style.display = 'none';
        document.getElementById('publicContent').style.visibility = 'visible';
      }, 300);
    }, { once: true });
  }

  // Render signal panel in station mode
  renderSignalPanel('publicSignalPanel', mode);

  // Style the signal panel boxes for mobile (large, full-width)
  setTimeout(() => {
    const panel = document.getElementById('publicSignalPanel');
    if (panel) {
      panel.querySelectorAll('.signal-box').forEach(box => {
        box.style.padding = '20px 16px';
        box.style.borderRadius = '16px';
        box.style.minHeight = '100px';
      });
      const innerDiv = panel.querySelector('div');
      if (innerDiv) innerDiv.style.cssText = 'display:flex; flex-direction:column; gap:12px;';
    }
  }, 100);

  // Update current race from config (if Supabase connected, use realtime)
  updatePublicRaceNumber();

  // Clock
  const clockEl = document.getElementById('publicClock');
  function updateClock() {
    if (!clockEl) return;
    const now = new Date();
    clockEl.textContent = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  }
  updateClock();
  refreshInterval = setInterval(updateClock, 1000);
}

async function updatePublicRaceNumber() {
  const config = await getConfig();
  const raceEl = document.getElementById('publicCurrentRace');
  const titleEl = document.getElementById('publicRaceTitle');
  if (!raceEl) return;

  if (config?.last_signaled_race) {
    raceEl.textContent = config.last_signaled_race;
    // Try to get race title
    const races = await getAllRaces();
    const race = races.find(r => r.race_number === config.last_signaled_race);
    if (titleEl && race) titleEl.textContent = race.race_title || '';
  }
}

// ──── FULL DASHBOARD (authenticated) ────

async function renderFullDashboard(container, stationMode) {
  container.innerHTML = `
    <div id="dashboardPage">
      <!-- Signal Panel + Station Links -->
      <div class="card" style="margin-bottom:16px; padding:12px 16px;">
        <div style="display:flex; align-items:center; gap:16px; flex-wrap:wrap;">
          <div id="dashSignalPanel" style="flex:1; min-width:280px;"></div>
          <div style="display:flex; gap:6px; border-left:1px solid var(--border); padding-left:12px;">
            <button class="btn btn-ghost" style="font-size:11px; padding:4px 8px;" onclick="window._openStation('race-control')" title="Race Control">
              <i class="material-icons" style="font-size:14px;">sports</i> RC
            </button>
            <button class="btn btn-ghost" style="font-size:11px; padding:4px 8px;" onclick="window._openStation('starter')" title="Starter">
              <i class="material-icons" style="font-size:14px;">flag</i> ST
            </button>
            <button class="btn btn-ghost" style="font-size:11px; padding:4px 8px;" onclick="window._openStation('finisher')" title="Finisher">
              <i class="material-icons" style="font-size:14px;">sports_score</i> FN
            </button>
            <button class="btn btn-ghost" style="font-size:11px; padding:4px 8px;" onclick="window._openStation('view-only')" title="View Only">
              <i class="material-icons" style="font-size:14px;">visibility</i> VO
            </button>
          </div>
        </div>
      </div>

      <!-- Summary Cards -->
      <div class="summary-cards" id="summaryCards"></div>

      <!-- Current / Next Race -->
      <div class="card" id="currentNextCard" style="margin-bottom:16px;"></div>

      <!-- Delay Tracking -->
      <div id="delayPanel" style="margin-bottom:16px;"></div>

      <!-- Next Race Signal -->
      <div id="nextRaceSignalPanel" style="margin-bottom:16px;"></div>

      <!-- Alerts -->
      <div id="alertsPanel" style="margin-bottom:16px;"></div>

      <!-- Sort Controls -->
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
        <span class="section-header" style="border:none; margin:0; padding:0;">Race Progress</span>
        <div style="margin-left:auto; display:flex; gap:8px;">
          <button class="btn btn-outline btn-sort active" data-sort="race" onclick="window._dbSortBy('race')">
            By Race #
          </button>
          <button class="btn btn-outline btn-sort" data-sort="division" onclick="window._dbSortBy('division')">
            By Division
          </button>
        </div>
      </div>

      <!-- Race Progress Table -->
      <div class="card" style="padding:0; overflow:auto;">
        <table class="race-table" id="raceProgressTable">
          <thead>
            <tr>
              <th>Race</th>
              <th>Title</th>
              <th>Division</th>
              <th>Time</th>
              <th>Draw</th>
              <th>Started</th>
              <th>Results</th>
              <th>Exported</th>
              <th>Sent</th>
              <th>Scored</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="raceProgressBody"></tbody>
        </table>
      </div>
    </div>
  `;

  // Handlers
  window._dbSortBy = (mode) => {
    document.querySelectorAll('.btn-sort').forEach(b => b.classList.toggle('active', b.dataset.sort === mode));
    renderRaces(mode);
  };
  window._openStation = (mode) => {
    // Open in public dashboard mode instead of external page
    window.open(`${window.location.pathname}#/dashboard/${mode}`, '_blank');
  };

  // Init Firebase signal panel
  renderSignalPanel('dashSignalPanel', stationMode || 'finisher');

  await renderDashboard();
  refreshInterval = setInterval(renderDashboard, 10000);
}

async function renderDashboard() {
  const races = await getAllRaces();

  // Change detection — hash race statuses/times to skip redundant re-renders
  const hash = races.map(r => `${r.race_number}:${r.status}:${r.export_time || ''}:${r.send_time || ''}`).join('|');
  if (hash === lastRaceHash) return; // Nothing changed — skip
  lastRaceHash = hash;

  const divisions = await getAllDivisions();

  renderSummary(races);
  renderCurrentNext(races);
  renderDelayTracking(races);
  await renderNextRacePanel();
  renderAlerts(races);

  const activeSort = document.querySelector('.btn-sort.active');
  renderRaces(activeSort ? activeSort.dataset.sort : 'race', races, divisions);
}

function renderSummary(races) {
  const el = document.getElementById('summaryCards');
  if (!el) return;

  const total = races.length;
  const pending = races.filter(r => r.status === 'pending').length;
  const started = races.filter(r => r.status === 'started').length;
  const exported = races.filter(r => ['exported', 'sent'].includes(r.status)).length;
  const sent = races.filter(r => r.status === 'sent').length;
  const cancelled = races.filter(r => r.status === 'cancelled').length;

  el.innerHTML = `
    <div class="summary-card"><div class="summary-card-value">${total}</div><div class="summary-card-label">Total</div></div>
    <div class="summary-card"><div class="summary-card-value">${pending}</div><div class="summary-card-label">Pending</div></div>
    <div class="summary-card"><div class="summary-card-value">${started}</div><div class="summary-card-label">In Progress</div></div>
    <div class="summary-card"><div class="summary-card-value">${exported}</div><div class="summary-card-label">Exported</div></div>
    <div class="summary-card"><div class="summary-card-value">${sent}</div><div class="summary-card-label">Sent</div></div>
    ${cancelled > 0 ? `<div class="summary-card"><div class="summary-card-value">${cancelled}</div><div class="summary-card-label">Cancelled</div></div>` : ''}
  `;
}

function renderCurrentNext(races) {
  const el = document.getElementById('currentNextCard');
  if (!el) return;

  const started = races.filter(r => r.status === 'started').sort((a, b) => a.race_number - b.race_number);
  const pending = races.filter(r => r.status === 'pending').sort((a, b) => a.race_number - b.race_number);

  let html = '';
  if (started.length > 0) {
    const current = started[0];
    html += `
      <div style="display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--border);">
        <span class="badge badge-started">CURRENT</span>
        <strong>Race ${current.race_number}</strong> — ${current.race_title || 'Untitled'}
        <span style="color:var(--text-tertiary); margin-left:auto;">Started ${isoToTime(current.start_time)}</span>
        <a href="#/race/${current.race_number}" class="btn btn-primary" style="padding:4px 12px; font-size:12px;">Open</a>
      </div>
    `;
  }
  if (pending.length > 0) {
    const next = pending[0];
    html += `
      <div style="display:flex; align-items:center; gap:12px; padding:12px 16px;">
        <span class="badge badge-pending">NEXT UP</span>
        <strong>Race ${next.race_number}</strong> — ${next.race_title || 'Untitled'}
        <span style="color:var(--text-tertiary); margin-left:auto;">Sched: ${next.race_time || '—'}</span>
        <a href="#/race/${next.race_number}" class="btn btn-outline" style="padding:4px 12px; font-size:12px;">Open</a>
      </div>
    `;
  }
  if (!html) {
    html = '<div style="padding:16px; text-align:center; color:var(--text-tertiary);">No races loaded. Go to Setup → Import Draws.</div>';
  }
  el.innerHTML = html;
}

function renderAlerts(races) {
  const el = document.getElementById('alertsPanel');
  if (!el) return;

  const alerts = [];
  const exportedNotSent = races.filter(r => r.export_time && !r.send_time && r.status !== 'cancelled');
  exportedNotSent.forEach(r => {
    alerts.push({ type: 'warning', msg: `Race ${r.race_number}: exported but NOT sent` });
  });

  const now = Date.now();
  races.filter(r => r.status === 'started' && r.start_time).forEach(r => {
    const elapsed = now - new Date(r.start_time).getTime();
    if (elapsed > 10 * 60 * 1000) {
      alerts.push({ type: 'danger', msg: `Race ${r.race_number}: started ${Math.floor(elapsed / 60000)} min ago, not exported` });
    }
  });

  const noDraw = races.filter(r => !r.teams_loaded && r.status === 'pending');
  if (noDraw.length > 0) {
    const nums = noDraw.map(r => r.race_number).join(', ');
    alerts.push({ type: 'info', msg: `Races ${nums}: draws not yet imported` });
  }

  if (alerts.length === 0) { el.innerHTML = ''; return; }

  el.innerHTML = alerts.map(a => `
    <div style="padding:8px 14px; margin-bottom:6px; border-radius:var(--radius-sm); border-left:3px solid var(--${a.type}); background:var(--${a.type}-bg); color:var(--${a.type}-text); font-size:13px;">
      <i class="material-icons" style="font-size:16px; vertical-align:middle; margin-right:6px;">${a.type === 'danger' ? 'error' : a.type === 'warning' ? 'warning' : 'info'}</i>
      ${a.msg}
    </div>
  `).join('');
}

function renderDelayTracking(races) {
  const panel = document.getElementById('delayPanel');
  if (!panel) return;

  // Find the most recently started race with a scheduled time
  const startedWithTime = races
    .filter(r => r.start_time && r.race_time && r.status !== 'cancelled')
    .sort((a, b) => b.race_number - a.race_number);

  if (startedWithTime.length === 0) { panel.innerHTML = ''; return; }

  const latest = startedWithTime[0];

  // Parse scheduled time (HH:MM format from draw file)
  const schedParts = (latest.race_time || '').split(':');
  if (schedParts.length < 2) { panel.innerHTML = ''; return; }

  const schedHour = parseInt(schedParts[0], 10);
  const schedMin = parseInt(schedParts[1], 10);
  if (isNaN(schedHour) || isNaN(schedMin)) { panel.innerHTML = ''; return; }

  // Calculate delay
  const actualStart = new Date(latest.start_time);
  const schedDate = new Date(actualStart);
  schedDate.setHours(schedHour, schedMin, 0, 0);

  const delayMs = actualStart.getTime() - schedDate.getTime();
  const delayMin = Math.round(delayMs / 60000);

  // Project next race ETA
  const pending = races
    .filter(r => r.status === 'pending' && r.race_time)
    .sort((a, b) => a.race_number - b.race_number);

  let etaHtml = '';
  if (pending.length > 0 && delayMin !== 0) {
    const next = pending[0];
    const nextParts = (next.race_time || '').split(':');
    if (nextParts.length >= 2) {
      const nextHour = parseInt(nextParts[0], 10);
      const nextMin = parseInt(nextParts[1], 10);
      if (!isNaN(nextHour) && !isNaN(nextMin)) {
        const projectedDate = new Date(actualStart);
        projectedDate.setHours(nextHour, nextMin, 0, 0);
        projectedDate.setTime(projectedDate.getTime() + delayMs);
        const etaH = String(projectedDate.getHours()).padStart(2, '0');
        const etaM = String(projectedDate.getMinutes()).padStart(2, '0');
        etaHtml = `<span style="margin-left:16px; font-size:13px; color:var(--text-secondary);">
          Race ${next.race_number} ETA: <strong>${etaH}:${etaM}</strong> (sched ${next.race_time})
        </span>`;
      }
    }
  }

  if (delayMin === 0) {
    panel.innerHTML = `
      <div style="padding:8px 14px; border-radius:var(--radius-sm); background:var(--success-bg); color:var(--success-text); font-size:13px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <i class="material-icons" style="font-size:16px;">schedule</i>
        <strong>On schedule</strong> — Race ${latest.race_number} started on time
        ${etaHtml}
      </div>`;
  } else if (delayMin > 0) {
    const severity = delayMin > 10 ? 'danger' : delayMin > 5 ? 'warning' : 'info';
    panel.innerHTML = `
      <div style="padding:8px 14px; border-radius:var(--radius-sm); background:var(--${severity}-bg); color:var(--${severity}-text); font-size:13px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <i class="material-icons" style="font-size:16px;">schedule</i>
        <strong>+${delayMin} min behind</strong> — Race ${latest.race_number} started at ${isoToTime(latest.start_time)} (sched ${latest.race_time})
        ${etaHtml}
      </div>`;
  } else {
    panel.innerHTML = `
      <div style="padding:8px 14px; border-radius:var(--radius-sm); background:var(--success-bg); color:var(--success-text); font-size:13px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <i class="material-icons" style="font-size:16px;">schedule</i>
        <strong>${Math.abs(delayMin)} min ahead</strong> — Race ${latest.race_number} started early
        ${etaHtml}
      </div>`;
  }
}

async function renderNextRacePanel() {
  const panel = document.getElementById('nextRaceSignalPanel');
  if (!panel) return;

  const { lastSignaled, nextUnsignaled } = await getSignalStatus();
  const config = await getConfig();
  const hasApi = !!config?.next_race_signal_api;

  if (!hasApi) { panel.innerHTML = ''; return; }

  panel.innerHTML = `
    <div class="card" style="padding:12px 16px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      <i class="material-icons" style="color:var(--accent);">cell_tower</i>
      <div>
        <span style="font-size:13px; color:var(--text-secondary);">
          Last signaled: <strong>${lastSignaled ? `Race ${lastSignaled}` : 'None'}</strong>
        </span>
      </div>
      ${nextUnsignaled ? `
        <button class="btn btn-primary" style="margin-left:auto; padding:6px 14px; font-size:13px;"
                onclick="window._dashForceSignal(${nextUnsignaled.race_number})">
          <i class="material-icons" style="font-size:16px;">cell_tower</i>
          Signal Race ${nextUnsignaled.race_number}
        </button>
      ` : `
        <span style="margin-left:auto; font-size:13px; color:var(--text-tertiary);">All races signaled</span>
      `}
      <button class="btn btn-outline" style="padding:6px 10px; font-size:12px;" onclick="window._dashForceSignalCustom()">
        <i class="material-icons" style="font-size:16px;">edit</i> Custom
      </button>
    </div>
  `;

  window._dashForceSignal = async (raceNum) => {
    await forceSignalRace(raceNum);
    await renderNextRacePanel();
  };
  window._dashForceSignalCustom = async () => {
    const input = prompt('Enter race number to signal as next:');
    if (!input) return;
    const num = parseInt(input, 10);
    if (isNaN(num) || num < 1) { showToast('Invalid race number', 'error'); return; }
    await forceSignalRace(num);
    await renderNextRacePanel();
  };
}

async function renderRaces(sortMode = 'race', racesArg, divisionsArg) {
  const races = racesArg || await getAllRaces();
  const divisions = divisionsArg || await getAllDivisions();
  const divMap = Object.fromEntries(divisions.map(d => [d.id, d]));

  const body = document.getElementById('raceProgressBody');
  if (!body) return;

  let sorted = [...races];
  if (sortMode === 'division') {
    sorted.sort((a, b) => {
      const da = a.division_id || 999;
      const db_val = b.division_id || 999;
      if (da !== db_val) return da - db_val;
      return a.race_number - b.race_number;
    });
  } else {
    sorted.sort((a, b) => a.race_number - b.race_number);
  }

  const statusIcon = (val, field) => {
    if (!val) return '<i class="material-icons status-icon pending">radio_button_unchecked</i>';
    if (field === 'draw') return '<i class="material-icons status-icon done">check_circle</i>';
    return `<i class="material-icons status-icon done">check_circle</i> <span style="font-size:11px; color:var(--text-tertiary);">${isoToTime(val)}</span>`;
  };

  body.innerHTML = sorted.map(r => {
    const div = r.division_id ? divMap[r.division_id] : null;
    const divColor = div ? div.colour_hex || '#9ca3af' : '#9ca3af';
    const divName = div ? (div.div_short_ref || div.division_name || '') : '';

    return `
      <tr>
        <td><strong>${r.race_number}</strong></td>
        <td>${r.race_title || '—'}</td>
        <td><span class="division-color" style="background:${divColor};"></span>${divName}</td>
        <td style="font-size:12px; color:var(--text-tertiary);">${r.race_time || ''}</td>
        <td style="text-align:center;">${statusIcon(r.teams_loaded, 'draw')}</td>
        <td style="text-align:center;">${statusIcon(r.start_time)}</td>
        <td style="text-align:center;">${r.status === 'cancelled' ? '<span class="badge badge-cancelled">CANCEL</span>' : statusIcon(r.joyi_imported || (r.start_time && r.status !== 'started' && r.status !== 'pending') ? 'yes' : null, 'draw')}</td>
        <td style="text-align:center;">${statusIcon(r.export_time)}${r.export_version > 1 ? ` <span style="font-size:10px; color:var(--warning);">v${r.export_version}</span>` : ''}</td>
        <td style="text-align:center;">${statusIcon(r.send_time)}</td>
        <td style="text-align:center; font-size:11px; color:var(--text-tertiary);">${r.scoring_flag !== 'N' && r.scoring_flag ? r.scoring_flag : ''}</td>
        <td><a href="#/race/${r.race_number}" style="color:var(--accent); font-size:12px;">Open</a></td>
      </tr>
    `;
  }).join('');
}
