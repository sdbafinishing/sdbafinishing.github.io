/**
 * SDBA RDMS — Dashboard Page
 *
 * Two modes:
 *   PUBLIC (not logged in): Digital flag panel + current race number. Mobile-friendly.
 *     URL modes: #/dashboard, #/dashboard/finisher, #/dashboard/starter, #/dashboard/race-control
 *   AUTHENTICATED: Full dashboard with summary, progress, alerts + signal panel at top.
 */
import { getAllRaces, getConfig, getAllDivisions, isEventLocked } from '../db.js';
import { isoToTime, showToast } from '../utils.js';
import { getSignalStatus, forceSignalRace } from '../next-race-signal.js';
import { renderSignalPanel, cleanupSignalPanel } from './signal-panel.js';
import { isRaceDayComplete, showLockModal } from '../event-lock.js';
import { summariseDivisions } from '../round-completion.js';
import { hasPermission } from '../rbac.js';

// Race's effective start time: prefer the Joyi-derived value (sub-second
// accuracy from the .lcd file) over the operator-clicked time. Matches
// the priority order in race.js#getEffectiveStartTime. Returns the ISO
// string or null. Use this everywhere the dashboard compares / displays
// a start, so races that only have joyi_start_time (no operator click)
// still show up as started + sort correctly.
function effectiveStartIso(race) {
  return race?.joyi_start_time || race?.start_time || null;
}
function effectiveStartMs(race) {
  const iso = effectiveStartIso(race);
  return iso ? new Date(iso).getTime() : 0;
}

let refreshInterval = null;
let isAuthenticatedUser = false;
let lastRaceHash = ''; // Change detection — skip re-render if data unchanged
let unsubCurrentRace = null; // Firebase live current-race subscription (public view)
let onConfigUpdatedHandler = null; // window listener for lock/unlock + config changes

export async function mountDashboard(container, params) {
  // Detect auth state
  const { isLocal } = await import('../auth.js');
  // Local is always authenticated (admin). Web checks auth flag.
  isAuthenticatedUser = isLocal() || window._rdmsAuthenticated === true;

  const stationMode = params?.[0] || null; // 'finisher', 'starter', 'race-control', or null

  if (!isAuthenticatedUser && !isLocal()) {
    // Hide all nav elements except Dashboard for public users
    document.querySelectorAll('.nav-link').forEach(link => {
      link.style.display = link.getAttribute('data-page') === 'dashboard' ? '' : 'none';
    });
    const navFolders = document.getElementById('navFolders');
    if (navFolders) navFolders.style.display = 'none';
    const navClock = document.getElementById('navClock');
    if (navClock) navClock.style.display = 'none';
    const navEvent = document.getElementById('navEventName');
    if (navEvent) navEvent.style.display = 'none';

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
  delete window._eventLockOpen;
  lastRaceHash = '';
  if (unsubCurrentRace) { try { unsubCurrentRace(); } catch {} unsubCurrentRace = null; }
  if (onConfigUpdatedHandler) {
    window.removeEventListener('rdms-config-updated', onConfigUpdatedHandler);
    window.removeEventListener('rdms-web-pulled', onConfigUpdatedHandler);
    onConfigUpdatedHandler = null;
  }
  cleanupSignalPanel();
}

// ──── PUBLIC DASHBOARD (pre-login, mobile-friendly) ────

function renderPublicDashboard(container, stationMode) {
  const mode = stationMode || 'view-only';
  // Order: Race Control → Starter → Finish → View Only
  const modeLabels = new Map([
    ['race-control', { icon: 'sports', label: 'Race Ctrl', canToggle: 'RaceControlReady' }],
    ['starter', { icon: 'flag', label: 'Starter', canToggle: 'StarterReady' }],
    ['finisher', { icon: 'sports_score', label: 'Finish', canToggle: 'FinishingReady' }],
    ['view-only', { icon: 'visibility', label: 'View', canToggle: null }],
  ]);
  const modeInfo = modeLabels.get(mode) || modeLabels.get('view-only');

  // No station mode selected → show mode picker (like original home.html)
  if (!stationMode) {
    return renderModePicker(container, modeLabels);
  }

  // Station mode selected → show status boxes + back button
  const audioUnlocked = sessionStorage.getItem('rdms-audio-unlocked') === '1';

  container.innerHTML = `
    ${audioUnlocked ? '' : `
    <div id="splashOverlay" style="
      position:fixed; inset:0; z-index:9000; background:var(--brand-dark);
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      cursor:pointer; -webkit-tap-highlight-color:transparent;
    ">
      <div style="text-align:center; color:#fff;">
        <i class="material-icons" style="font-size:48px; opacity:0.8; margin-bottom:12px;">${modeInfo.icon}</i>
        <h1 style="font-size:22px; font-weight:700; margin-bottom:4px;">SDBA RDMS</h1>
        <p style="font-size:14px; opacity:0.6; margin-bottom:24px;">${modeInfo.label}</p>
        <div style="display:inline-flex; align-items:center; gap:8px; padding:14px 36px; border-radius:12px; background:var(--accent); color:#fff; font-size:16px; font-weight:600;">
          <i class="material-icons">touch_app</i> Tap to Enter
        </div>
        <p style="font-size:10px; opacity:0.3; margin-top:12px;">Enables alert sounds</p>
      </div>
    </div>`}

    <div id="publicContent" style="
      max-width:500px; margin:0 auto; padding:8px;
      display:flex; flex-direction:column;
      height:calc(100vh - var(--navbar-height) - 16px);
      height:calc(100dvh - var(--navbar-height) - 16px);
      ${audioUnlocked ? '' : 'visibility:hidden;'}
    ">
      <!-- Back button + mode label -->
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
        <a href="#/dashboard" style="display:flex; align-items:center; gap:4px; color:var(--accent); text-decoration:none; font-size:13px; font-weight:500;">
          <i class="material-icons" style="font-size:18px;">arrow_back</i> Back
        </a>
        <span style="margin-left:auto; font-size:13px; color:var(--text-tertiary);">
          <i class="material-icons" style="font-size:16px; vertical-align:middle;">${modeInfo.icon}</i>
          ${modeInfo.label}
        </span>
      </div>

      <!-- STATUS BOXES (hero) -->
      <div id="publicSignalPanel" style="flex:1; display:flex; flex-direction:column; gap:10px; min-height:0;"></div>

      <!-- Race + Clock footer -->
      <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 0; border-top:1px solid var(--border); margin-top:8px;">
        <div>
          <span style="font-size:10px; color:var(--text-tertiary); text-transform:uppercase;">Race</span>
          <span id="publicCurrentRace" style="font-size:24px; font-weight:700; font-variant-numeric:tabular-nums; color:var(--text-primary); margin-left:4px;">—</span>
          <span id="publicRaceTitle" style="font-size:11px; color:var(--text-secondary); margin-left:6px;"></span>
        </div>
        <span id="publicClock" style="font-size:16px; font-weight:500; font-variant-numeric:tabular-nums; color:var(--text-tertiary);"></span>
      </div>
    </div>
  `;

  // Splash handler
  const splash = document.getElementById('splashOverlay');
  if (splash) {
    splash.addEventListener('click', () => {
      try { new Audio('https://raw.githubusercontent.com/sdbafinishing/sdbafinishing.github.io/main/Assets/silent.mp3').play().catch(() => {}); } catch {}
      sessionStorage.setItem('rdms-audio-unlocked', '1');
      splash.style.opacity = '0';
      splash.style.transition = 'opacity 0.3s';
      setTimeout(() => { splash.remove(); document.getElementById('publicContent').style.visibility = 'visible'; }, 300);
    }, { once: true });
  }

  // Render signal panel + style boxes
  renderSignalPanel('publicSignalPanel', mode);
  setTimeout(() => {
    const panel = document.getElementById('publicSignalPanel');
    if (!panel) return;
    // Tall hero boxes that fill the available space. The footer (Race # +
    // STOP) stays visible because the container is sized to 100dvh (so the
    // mobile URL bar can't push it off-screen) and the boxes flex within the
    // remaining height (min-height:0 lets them shrink to fit short screens).
    panel.querySelectorAll('.signal-box').forEach(box => {
      const field = box.getAttribute('data-field');
      const isClickable = modeInfo.canToggle === field;
      Object.assign(box.style, {
        flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        borderRadius: '16px', padding: '16px', fontSize: '14px', minHeight: '0',
        borderWidth: isClickable ? '3px' : '2px', opacity: isClickable ? '1' : '0.7',
      });
      const dot = box.querySelector('.signal-dot');
      if (dot) { dot.style.width = '24px'; dot.style.height = '24px'; dot.style.marginTop = '8px'; }
      if (isClickable) {
        const lbl = document.createElement('div');
        lbl.style.cssText = 'font-size:10px; margin-top:6px; opacity:0.5; text-transform:uppercase; letter-spacing:1px;';
        lbl.textContent = 'tap to toggle';
        box.appendChild(lbl);
      }
    });
    const inner = panel.querySelector('div');
    if (inner) inner.style.cssText = 'display:flex; flex-direction:column; gap:10px; flex:1; min-height:0;';
  }, 100);

  updatePublicRaceNumber();
  const clockEl = document.getElementById('publicClock');
  const tick = () => { if (!clockEl) return; const n = new Date(); clockEl.textContent = `${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}`; };
  tick();
  refreshInterval = setInterval(tick, 10000);
}

/**
 * Mode picker — big buttons like original home.html
 */
function renderModePicker(container, modeLabels) {
  const audioUnlocked = sessionStorage.getItem('rdms-audio-unlocked') === '1';

  container.innerHTML = `
    ${audioUnlocked ? '' : `
    <div id="splashOverlay" style="
      position:fixed; inset:0; z-index:9000; background:var(--brand-dark);
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      cursor:pointer; -webkit-tap-highlight-color:transparent;
    ">
      <div style="text-align:center; color:#fff;">
        <h1 style="font-size:24px; font-weight:700; margin-bottom:8px;">Dragon Boat Race Status</h1>
        <p style="font-size:14px; opacity:0.6; margin-bottom:24px;">Select your station</p>
        <div style="display:inline-flex; align-items:center; gap:8px; padding:14px 36px; border-radius:12px; background:var(--accent); color:#fff; font-size:16px; font-weight:600;">
          <i class="material-icons">touch_app</i> Tap to Enter
        </div>
        <p style="font-size:10px; opacity:0.3; margin-top:12px;">Enables alert sounds</p>
      </div>
    </div>`}

    <div id="publicContent" style="
      max-width:400px; margin:0 auto; padding:16px;
      display:flex; flex-direction:column; justify-content:center;
      min-height:calc(100vh - var(--navbar-height) - 32px);
      ${audioUnlocked ? '' : 'visibility:hidden;'}
    ">
      <h2 style="text-align:center; font-size:20px; font-weight:700; margin-bottom:20px; color:var(--text-primary);">
        Dragon Boat Race Status
      </h2>
      ${[...modeLabels.entries()].map(([key, info]) => `
        <a href="#/dashboard/${key}" style="
          display:flex; align-items:center; justify-content:center; gap:12px;
          width:100%; padding:28px 16px; margin-bottom:12px;
          background:var(--bg-card); color:var(--text-primary);
          border:2px solid var(--border); border-radius:16px; text-decoration:none;
          font-size:22px; font-weight:600; transition:all 0.15s;
        " onmouseenter="this.style.borderColor='var(--accent)'" onmouseleave="this.style.borderColor='var(--border)'">
          <i class="material-icons" style="font-size:32px;">${info.icon}</i>
          ${info.label === 'Race Ctrl' ? 'Race Control' : info.label === 'Finish' ? 'Finish Mode' : info.label === 'View' ? 'View Only' : info.label + ' Mode'}
        </a>
      `).join('')}
    </div>
  `;

  // Splash handler
  const splash = document.getElementById('splashOverlay');
  if (splash) {
    splash.addEventListener('click', () => {
      try { new Audio('https://raw.githubusercontent.com/sdbafinishing/sdbafinishing.github.io/main/Assets/silent.mp3').play().catch(() => {}); } catch {}
      sessionStorage.setItem('rdms-audio-unlocked', '1');
      splash.style.opacity = '0';
      splash.style.transition = 'opacity 0.3s';
      setTimeout(() => { splash.remove(); document.getElementById('publicContent').style.visibility = 'visible'; }, 300);
    }, { once: true });
  }
}

async function updatePublicRaceNumber() {
  const config = await getConfig();
  const raceEl = document.getElementById('publicCurrentRace');
  const titleEl = document.getElementById('publicRaceTitle');
  if (!raceEl) return;

  // Initial paint from local config (fallback / instant). May be absent on the
  // online viewer when Supabase hasn't hydrated — the live Firebase feed below
  // is the authoritative, real-time source and overrides this.
  if (config?.last_signaled_race) {
    raceEl.textContent = config.last_signaled_race;
    const races = await getAllRaces();
    const race = races.find(r => r.race_number === config.last_signaled_race);
    if (titleEl && race) titleEl.textContent = race.race_title || '';
  }

  // Live current-race feed from Firebase — same real-time, login-free path as
  // the digital flags, independent of Supabase. Keeps the label fresh as races
  // progress and works in pre-login view-only mode.
  try {
    const { subscribeCurrentRace } = await import('../flag-signal.js');
    if (unsubCurrentRace) { try { unsubCurrentRace(); } catch {} }
    unsubCurrentRace = await subscribeCurrentRace(({ raceNumber, raceTitle }) => {
      const rEl = document.getElementById('publicCurrentRace');
      const tEl = document.getElementById('publicRaceTitle');
      if (!rEl) return;
      if (raceNumber != null && raceNumber !== '') {
        rEl.textContent = raceNumber;
        if (tEl) tEl.textContent = raceTitle || '';
      }
    });
  } catch { /* Firebase unavailable — local fallback already painted */ }
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

      <!-- Event Lock — race-day-complete seal. Visible to admins only;
           the button enables itself once every race is in a terminal
           state (exported/sent/cancelled). See event-lock.js for the
           full lock semantics. -->
      <div id="dashEventLockRow" style="margin-top:14px;"></div>
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

  // Re-render on config changes (notably lock/unlock). renderDashboard's hash
  // gate keys on race status/times only, so a lock toggle — which changes
  // config, not races — would otherwise leave the footer lock row stale
  // (showing "Lock event" after the event was already locked). Reset the hash
  // so the re-render actually runs.
  onConfigUpdatedHandler = () => { lastRaceHash = ''; renderDashboard(); };
  window.addEventListener('rdms-config-updated', onConfigUpdatedHandler);
  // Web viewer: repaint immediately when the background poll pulls fresh data
  // from Supabase (web-init dispatches rdms-web-pulled), rather than waiting
  // for the next 10s tick. Same reset-hash-then-render path.
  window.addEventListener('rdms-web-pulled', onConfigUpdatedHandler);
}

async function renderDashboard() {
  const races = await getAllRaces();

  // Change detection — hash race statuses/times to skip redundant re-renders
  const hash = races.map(r => `${r.race_number}:${r.status}:${r.export_time || ''}:${r.send_time || ''}`).join('|');
  if (hash === lastRaceHash) return; // Nothing changed — skip
  lastRaceHash = hash;

  const divisions = await getAllDivisions();

  renderSummary(races);
  await renderCurrentNext(races);
  await renderDelayTracking(races);
  await renderNextRacePanel();
  await renderAlerts(races);

  const activeSort = document.querySelector('.btn-sort.active');
  renderRaces(activeSort ? activeSort.dataset.sort : 'race', races, divisions);

  await renderEventLockRow(races);
}

async function renderEventLockRow(races) {
  const el = document.getElementById('dashEventLockRow');
  if (!el) return;
  // Only admins can lock/unlock — hide the row entirely for editors and
  // viewers (the locked-state banner at the top of every page is enough
  // signal for them).
  if (!hasPermission('config.edit')) { el.innerHTML = ''; return; }

  const locked = await isEventLocked();
  if (locked) {
    // The persistent top banner carries the unlock control; keep this
    // footer row quiet so it doesn't duplicate the same call-to-action.
    el.innerHTML = `
      <div style="font-size:12px; color:var(--text-tertiary); text-align:right;">
        Event is locked — see the banner at the top of the page to unlock.
      </div>`;
    return;
  }

  const complete = races.length > 0 && races.every(r =>
    ['exported', 'sent', 'cancelled'].includes(r.status));
  const remaining = races.length - races.filter(r =>
    ['exported', 'sent', 'cancelled'].includes(r.status)).length;
  const btnTone   = complete ? 'btn-primary' : 'btn-ghost';
  const hint      = complete
    ? 'All races complete — safe to lock.'
    : `${remaining} race${remaining === 1 ? '' : 's'} still pending — locking now will block their exports.`;

  el.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:flex-end; gap:10px; font-size:12px; color:var(--text-tertiary);">
      <span>${hint}</span>
      <button class="btn ${btnTone} btn-sm" onclick="window._eventLockOpen()">
        <i class="material-icons" style="font-size:14px;">lock</i> Lock event
      </button>
    </div>`;
  window._eventLockOpen = showLockModal;
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

async function renderCurrentNext(races) {
  const el = document.getElementById('currentNextCard');
  if (!el) return;

  // Current = most recently started (multiple started races possible; want the latest).
  // Tie-break by race_number desc. Use effective start (joyi-derived or
  // operator-clicked) so races that started via Joyi alone still sort.
  const started = races.filter(r => r.status === 'started').sort((a, b) => {
    const ta = effectiveStartMs(a);
    const tb = effectiveStartMs(b);
    if (tb !== ta) return tb - ta;
    return b.race_number - a.race_number;
  });
  const pending = races.filter(r => r.status === 'pending').sort((a, b) => a.race_number - b.race_number);

  // Need divisions for the colour swatch.
  const divisions = await getAllDivisions();
  const divMap = Object.fromEntries(divisions.map(d => [d.id, d]));

  // Helper: tinted background for odd race numbers, division swatch up front.
  function renderRow(r, badgeText, badgeCls, rightText, openCls) {
    const div = r.division_id ? divMap[r.division_id] : null;
    const divColour = div?.colour_hex || '#9ca3af';
    const tint = r.race_number % 2 === 1 ? 'background: rgba(250, 204, 21, 0.10);' : '';
    return `
      <div style="display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid var(--border); ${tint}">
        <span class="badge ${badgeCls}">${badgeText}</span>
        <span title="${div?.division_name || ''}" style="display:inline-block; width:8px; height:24px; border-radius:2px; background:${divColour}; flex-shrink:0;"></span>
        <strong>Race ${r.race_number}</strong> — ${r.race_title || 'Untitled'}
        <span style="color:var(--text-tertiary); margin-left:auto;">${rightText}</span>
        <a href="#/race/${r.race_number}" class="btn ${openCls}" style="padding:4px 12px; font-size:12px;">Open</a>
      </div>
    `;
  }

  let html = '';
  if (started.length > 0) {
    html += renderRow(started[0], 'CURRENT', 'badge-started', `Started ${isoToTime(effectiveStartIso(started[0]))}`, 'btn-primary');
  }
  if (pending.length > 0) {
    html += renderRow(pending[0], 'NEXT UP', 'badge-pending', `Sched: ${pending[0].race_time || '—'}`, 'btn-outline');
  }
  if (!html) {
    html = '<div style="padding:16px; text-align:center; color:var(--text-tertiary);">No races loaded. Go to Setup → Import Draws.</div>';
  }
  el.innerHTML = html;
}

async function renderAlerts(races) {
  const el = document.getElementById('alertsPanel');
  if (!el) return;

  // Group by alert category and collapse to one line per category — a long
  // list of identical-shape rows just adds noise on a busy race day.
  const alerts = [];
  const fmt = (nums) => nums.length === 1 ? `Race ${nums[0]}` : `Races ${nums.join(', ')}`;

  const exportedNotSent = races
    .filter(r => r.export_time && !r.send_time && r.status !== 'cancelled')
    .map(r => r.race_number);
  if (exportedNotSent.length > 0) {
    alerts.push({ type: 'warning', msg: `${fmt(exportedNotSent)}: exported but NOT sent` });
  }

  const now = Date.now();
  const startedNotExported = races
    .filter(r => r.status === 'started' && effectiveStartMs(r) > 0 && (now - effectiveStartMs(r)) > 10 * 60 * 1000)
    .map(r => r.race_number);
  if (startedNotExported.length > 0) {
    alerts.push({ type: 'danger', msg: `${fmt(startedNotExported)}: started > 10 min ago, not exported` });
  }

  // "Draws not yet imported" — narrowed to races that are actually ready
  // to have draws generated/imported RIGHT NOW. A race is ready when its
  // source rounds (the rounds that progress INTO it via the flowchart)
  // are all complete. Round 1 races with no incoming progressions aren't
  // listed here — those need manual import at event setup, not a runtime
  // nudge during racing.
  try {
    const summaries = await summariseDivisions();
    const readyForDraw = new Set();
    for (const div of summaries) {
      for (const round of div.rounds) {
        if (!round.isComplete) continue;        // source not done → don't nag
        if (!round.nextRaces?.length) continue; // no waiting next races
        for (const nr of round.nextRaces) readyForDraw.add(nr.race_number);
      }
    }
    // Intersect with races that genuinely lack draws + are still pending.
    // (`nextRaces` from summariseDivisions already filters to races with
    // unresolved placeholders, but cross-reference with the race table to
    // be safe against any data-shape drift.)
    const noDraw = [...readyForDraw].filter(rn => {
      const r = races.find(x => x.race_number === rn);
      return r && !r.teams_loaded && r.status === 'pending';
    }).sort((a, b) => a - b);
    if (noDraw.length > 0) {
      alerts.push({ type: 'info', msg: `${fmt(noDraw)}: prior round complete — next round draws ready to generate` });
    }
  } catch (err) {
    // Don't let the alerts panel die if the audit walk throws.
    console.warn('renderAlerts: noDraw scan failed', err);
  }

  if (alerts.length === 0) { el.innerHTML = ''; return; }

  el.innerHTML = alerts.map(a => `
    <div style="padding:8px 14px; margin-bottom:6px; border-radius:var(--radius-sm); border-left:3px solid var(--${a.type}); background:var(--${a.type}-bg); color:var(--${a.type}-text); font-size:13px;">
      <i class="material-icons" style="font-size:16px; vertical-align:middle; margin-right:6px;">${a.type === 'danger' ? 'error' : a.type === 'warning' ? 'warning' : 'info'}</i>
      ${a.msg}
    </div>
  `).join('');
}

// Parse a "HH:MM" race_time string and anchor it to today's date.
// Returns a Date or null on malformed input.
function parseSchedToday(raceTime) {
  if (!raceTime) return null;
  const parts = raceTime.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

// Today's date as YYYY-MM-DD in local time (matches config.race_date format).
function localTodayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function renderDelayTracking(races) {
  const panel = document.getElementById('delayPanel');
  if (!panel) return;

  // Schedule / delay tracking is only meaningful for TODAY's event. The
  // schedule times are anchored onto the current day (parseSchedToday), so for
  // a past or future event the delta is nonsense (e.g. "started 38854 min
  // early"). When the configured event date isn't today, hide the banner.
  const config = await getConfig();
  const raceDate = (config?.race_date || '').trim();
  if (raceDate && raceDate !== localTodayISO()) {
    panel.innerHTML = '';
    return;
  }

  // Two independent measures of delay, both in minutes:
  //   x = "started delay" — how late the LAST started race actually started
  //       vs its schedule (joyi-derived start preferred). Tells you what
  //       happened.
  //   y = "upcoming delay" — for the NEXT pending race, how much its
  //       scheduled time has already slipped past wall clock. Live
  //       (refreshes with each renderDashboard tick).
  // The overall projection uses the larger of x and y — whichever is more
  // alarming. Banner shows both so the operator sees the trend.

  // x: started delay (effective start of latest started race vs schedule)
  const startedWithTime = races
    .filter(r => effectiveStartIso(r) && r.race_time && r.status !== 'cancelled')
    .sort((a, b) => b.race_number - a.race_number);
  const latest = startedWithTime[0];
  let startedDelayMin = null;
  let startedSchedDate = null;
  let actualStart = null;
  if (latest) {
    const schedDate = parseSchedToday(latest.race_time);
    if (schedDate) {
      actualStart = new Date(effectiveStartIso(latest));
      startedSchedDate = schedDate;
      startedDelayMin = Math.round((actualStart.getTime() - schedDate.getTime()) / 60000);
    }
  }

  // y: upcoming overdue (next pending race's scheduled time vs now)
  const pending = races
    .filter(r => r.status === 'pending' && r.race_time && r.status !== 'cancelled')
    .sort((a, b) => a.race_number - b.race_number);
  const next = pending[0];
  let upcomingDelayMin = null;
  let nextSched = null;
  if (next) {
    const sched = parseSchedToday(next.race_time);
    if (sched) {
      nextSched = sched;
      const now = Date.now();
      const diffMin = Math.round((now - sched.getTime()) / 60000);
      // Only counts as "delay" when wall clock has already passed the
      // scheduled time. Future-scheduled races aren't "delayed".
      if (diffMin > 0) upcomingDelayMin = diffMin;
    }
  }

  if (latest == null && next == null) { panel.innerHTML = ''; return; }

  // Overall delay = max(x, y). Used for severity colour + headline.
  const overall = Math.max(
    startedDelayMin != null && startedDelayMin > 0 ? startedDelayMin : 0,
    upcomingDelayMin != null ? upcomingDelayMin : 0,
  );

  // Build ETA for the next race using overall projection delay (carries
  // forward today's delay onto the scheduled time).
  let etaHtml = '';
  if (next && nextSched && overall > 0) {
    const projected = new Date(nextSched.getTime() + overall * 60000);
    const etaH = String(projected.getHours()).padStart(2, '0');
    const etaM = String(projected.getMinutes()).padStart(2, '0');
    etaHtml = `<span style="margin-left:16px; font-size:13px; color:var(--text-secondary);">
      Race ${next.race_number} ETA: <strong>${etaH}:${etaM}</strong> (sched ${next.race_time})
    </span>`;
  }

  // Lines of detail — show whichever measure is available.
  const lines = [];
  if (startedDelayMin != null) {
    if (startedDelayMin > 0) {
      lines.push(`Race ${latest.race_number} started ${startedDelayMin} min late (sched ${latest.race_time}, actual ${isoToTime(effectiveStartIso(latest))})`);
    } else if (startedDelayMin < 0) {
      lines.push(`Race ${latest.race_number} started ${Math.abs(startedDelayMin)} min early`);
    } else {
      lines.push(`Race ${latest.race_number} started on time`);
    }
  }
  if (upcomingDelayMin != null) {
    lines.push(`Race ${next.race_number} overdue by ${upcomingDelayMin} min (sched ${next.race_time})`);
  }

  let severity, headline;
  if (overall === 0) {
    severity = 'success'; headline = 'On schedule';
  } else if (overall > 10) {
    severity = 'danger'; headline = `+${overall} min behind`;
  } else if (overall > 5) {
    severity = 'warning'; headline = `+${overall} min behind`;
  } else {
    severity = 'info'; headline = `+${overall} min behind`;
  }

  panel.innerHTML = `
    <div style="padding:8px 14px; border-radius:var(--radius-sm); background:var(--${severity}-bg); color:var(--${severity}-text); font-size:13px; display:flex; align-items:flex-start; gap:8px; flex-wrap:wrap;">
      <i class="material-icons" style="font-size:16px; margin-top:1px;">schedule</i>
      <div style="flex:1; min-width:0;">
        <div><strong>${headline}</strong> ${etaHtml}</div>
        ${lines.map(l => `<div style="font-size:12px; opacity:0.9;">${l}</div>`).join('')}
      </div>
    </div>`;
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

  const statusIcon = (val, field) => {
    if (!val) return '<i class="material-icons status-icon pending">radio_button_unchecked</i>';
    if (field === 'draw') return '<i class="material-icons status-icon done">check_circle</i>';
    return `<i class="material-icons status-icon done">check_circle</i> <span style="font-size:11px; color:var(--text-tertiary);">${isoToTime(val)}</span>`;
  };

  const renderRaceRow = (r) => {
    const div = r.division_id ? divMap[r.division_id] : null;
    const divColor = div ? div.colour_hex || '#9ca3af' : '#9ca3af';
    const divName = div ? (div.division_name || '') : '';
    const parityClass = r.race_number % 2 === 1 ? 'race-row-odd' : 'race-row-even';
    return `
      <tr class="${parityClass}">
        <td><strong>${r.race_number}</strong></td>
        <td>${r.race_title || '—'}</td>
        <td><span class="division-color" style="background:${divColor};"></span>${divName}</td>
        <td style="font-size:12px; color:var(--text-tertiary);">${r.race_time || ''}</td>
        <td style="text-align:center;">${statusIcon(r.teams_loaded, 'draw')}</td>
        <td style="text-align:center;">${statusIcon(r.restart_time || effectiveStartIso(r))}</td>
        <td style="text-align:center;">${r.status === 'cancelled' ? '<span class="badge badge-cancelled">CANCEL</span>' : statusIcon(r.joyi_imported || (effectiveStartIso(r) && r.status !== 'started' && r.status !== 'pending') ? 'yes' : null, 'draw')}</td>
        <td style="text-align:center;">${statusIcon(r.export_time)}${r.export_version > 1 ? ` <span style="font-size:10px; color:var(--warning);">v${r.export_version}</span>` : ''}</td>
        <td style="text-align:center;">${statusIcon(r.send_time)}</td>
        <td style="text-align:center; font-size:11px; color:var(--text-tertiary);">${r.scoring_flag !== 'N' && r.scoring_flag ? r.scoring_flag : ''}</td>
        <td><a href="#/race/${r.race_number}" style="color:var(--accent); font-size:12px;">Open</a></td>
      </tr>
    `;
  };

  if (sortMode === 'division') {
    // Real grouped view: one header row per division (in division_id order),
    // then its races (in race_number order), with an "Unassigned" bucket at
    // the end for races without a division_id.
    const byDiv = new Map();        // div_id -> race[]
    const unassigned = [];
    for (const r of races) {
      if (r.division_id) {
        if (!byDiv.has(r.division_id)) byDiv.set(r.division_id, []);
        byDiv.get(r.division_id).push(r);
      } else {
        unassigned.push(r);
      }
    }
    // Sort each bucket by race_number; sort divisions by id.
    const sortedDivIds = [...byDiv.keys()].sort((a, b) => a - b);

    const groupHeader = (label, colour) => `
      <tr class="div-group-header" style="background:var(--bg-input);">
        <td colspan="11" style="padding:8px 10px; font-weight:600; font-size:13px; border-top:2px solid var(--border);">
          <span style="display:inline-block; width:10px; height:10px; border-radius:2px; background:${colour}; margin-right:8px; vertical-align:middle;"></span>
          ${label}
        </td>
      </tr>
    `;

    const parts = [];
    for (const divId of sortedDivIds) {
      const div = divMap[divId];
      const label = div ? (div.division_name || `Division ${divId}`) : `Division ${divId}`;
      const colour = div?.colour_hex || '#9ca3af';
      parts.push(groupHeader(label, colour));
      byDiv.get(divId).sort((a, b) => a.race_number - b.race_number).forEach(r => parts.push(renderRaceRow(r)));
    }
    if (unassigned.length > 0) {
      parts.push(groupHeader('Unassigned', '#9ca3af'));
      unassigned.sort((a, b) => a.race_number - b.race_number).forEach(r => parts.push(renderRaceRow(r)));
    }
    body.innerHTML = parts.join('');
  } else {
    const sorted = [...races].sort((a, b) => a.race_number - b.race_number);
    body.innerHTML = sorted.map(renderRaceRow).join('');
  }
}
