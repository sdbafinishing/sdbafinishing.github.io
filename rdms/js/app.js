/**
 * SDBA RDMS — App Entry Point
 * Hash-based SPA router, clock, page lifecycle, BroadcastChannel.
 */
import { getConfig } from './db.js';
import { showToast } from './utils.js';
import { requestSourceFolder, isSourceConnected } from './file-access.js';
import { needsDriveFallback, initDriveApi, requestDriveAccess, isDriveApiConnected } from './drive-api.js';
import './rbac.js'; // Initialize RBAC (exposes window._hasPermission)
import { startSyncService } from './sync.js';
import { initWebVersion, showEventPicker, getWebSupabase, startWebDashboardPoll } from './web-init.js';
import { mountDashboard, unmountDashboard } from './pages/dashboard.js';
import { mountSetup, unmountSetup } from './pages/setup.js';
import { mountRacePage, unmountRacePage } from './pages/race-page.js';
import { mountImportPage, unmountImportPage } from './pages/import-page.js';
import { mountTimesheetPage, unmountTimesheetPage } from './pages/timesheet-page.js';
import { mountScoringPage, unmountScoringPage } from './pages/scoring-page.js';
import { mountFlowchartPage, unmountFlowchartPage } from './pages/flowchart-page.js';
import { mountAdminPage, unmountAdminPage } from './pages/admin-page.js';
import { mountArchivePage, unmountArchivePage } from './pages/archive-page.js';
import { mountUsersPage, unmountUsersPage } from './pages/users-page.js';
import { initAuth, isLocal, renderLoginPage, logout, getCurrentUser } from './auth.js';
import { canAccessPage, getRole, hasPermission, setRole } from './rbac.js';
import { refreshLockBanner } from './event-lock.js';

// ──── Page Registry ────
// Each page exports mount(container) and unmount()
const pages = {
  dashboard: { mount: mountDashboard, unmount: unmountDashboard },
  setup: { mount: mountSetup, unmount: unmountSetup },
  race: { mount: mountRacePage, unmount: unmountRacePage },
  import: { mount: mountImportPage, unmount: unmountImportPage },
  timesheet: { mount: mountTimesheetPage, unmount: unmountTimesheetPage },
  scoring: { mount: mountScoringPage, unmount: unmountScoringPage },
  flowchart: { mount: mountFlowchartPage, unmount: unmountFlowchartPage },
  admin: { mount: mountAdminPage, unmount: unmountAdminPage },
  archive: { mount: mountArchivePage, unmount: unmountArchivePage },
  users: { mount: mountUsersPage, unmount: unmountUsersPage },
};

let currentPage = null;
let clockInterval = null;
let isAuthenticated = false;

// ──── Router ────

function getRoute() {
  const hash = window.location.hash || '#/dashboard';
  const parts = hash.slice(2).split('/'); // strip "#/"
  return { page: parts[0] || 'dashboard', params: parts.slice(1) };
}

async function navigate() {
  const { page, params } = getRoute();
  const container = document.getElementById('app');

  // Unmount current page
  if (currentPage && pages[currentPage]) {
    pages[currentPage].unmount();
  }
  currentPage = page;

  // Update nav active state
  document.querySelectorAll('.nav-link').forEach(link => {
    const linkPage = link.getAttribute('data-page');
    link.classList.toggle('active', linkPage === page);
  });

  // Dashboard is always accessible (public mode for unauthenticated)
  // Other pages require login on web
  if (page !== 'dashboard' && !isAuthenticated && !isLocal()) {
    container.innerHTML = `
      <div class="card" style="text-align:center; padding:40px;">
        <i class="material-icons" style="font-size:48px; color:var(--text-tertiary);">lock</i>
        <h3 style="margin-top:12px; color:var(--text-secondary);">Sign in required</h3>
        <p style="color:var(--text-tertiary); margin-top:8px;">Sign in to access this page.</p>
        <button class="btn btn-primary" style="margin-top:16px;" onclick="window.location.hash='#/dashboard'">
          Go to Dashboard
        </button>
      </div>
    `;
    return;
  }

  // RBAC: check page access (skip for dashboard — always allowed)
  if (page !== 'dashboard' && !canAccessPage(page)) {
    container.innerHTML = `
      <div class="card" style="text-align:center; padding:40px;">
        <i class="material-icons" style="font-size:48px; color:var(--danger);">lock</i>
        <h3 style="margin-top:12px; color:var(--text-secondary);">Access Denied</h3>
        <p style="color:var(--text-tertiary); margin-top:8px;">Your role (${getRole()}) does not have access to this page.</p>
      </div>
    `;
    return;
  }

  // Mount new page
  if (pages[page]) {
    container.innerHTML = '';
    await pages[page].mount(container, params);
  }
  // Sticky lock banner — refresh on every navigation so it stays visible
  // even after page swaps. Fire-and-forget; never blocks routing.
  refreshLockBanner().catch(() => {});

  // Navbar folder icon — also resync on every navigation. Connection
  // state can change from inside the Setup page (its own Connect button)
  // and the navbar didn't know about that until next render. Calling
  // updateFolderIcons here guarantees the icon reflects current state
  // whenever the user lands on a new page.
  try { updateFolderIcons(); } catch {}
  if (!pages[page]) {
    container.innerHTML = `
      <div class="card" style="text-align:center; padding:40px;">
        <i class="material-icons" style="font-size:48px; color:var(--text-tertiary);">construction</i>
        <h3 style="margin-top:12px; color:var(--text-secondary);">Page "${page}" — Coming Soon</h3>
        <p style="color:var(--text-tertiary); margin-top:8px;">This page is under construction.</p>
      </div>
    `;
  }
}

// ──── Clock ────

function startClock() {
  const clockEl = document.getElementById('navClock');
  if (!clockEl) return;

  function update() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    clockEl.textContent = `${h}:${m}:${s}`;
  }

  update();
  clockInterval = setInterval(update, 1000);
}

// ──── Event Name in Navbar ────

async function updateNavEventName() {
  const el = document.getElementById('navEventName');
  if (!el) return;
  const config = await getConfig();
  if (config && config.event_short_ref) {
    const colour = config.event_colour_code_hex || '#FF5722';
    const clickable = !isLocal(); // Web users can click to switch events
    el.innerHTML = `
      <span class="event-badge" style="background:${colour}; color:#fff; padding:2px 8px; border-radius:var(--radius-full); font-size:11px; font-weight:600; letter-spacing:0.5px; ${clickable ? 'cursor:pointer;' : ''}"
            ${clickable ? 'onclick="window._showEventPicker()"' : ''}
            title="${clickable ? 'Click to switch event' : config.event_long_name_en || ''}">${config.event_short_ref}</span>
    `;
    document.getElementById('navbar').style.borderBottom = `3px solid ${colour}`;
  } else {
    el.innerHTML = '<span style="opacity:0.5;">No event configured</span>';
    document.getElementById('navbar').style.borderBottom = 'none';
  }

  // Event picker for web users
  window._showEventPicker = () => {
    const container = document.getElementById('app');
    showEventPicker(container, async () => {
      await updateNavEventName();
      navigate();
    });
  };
}

// ──── Theme Icon Sync ────

function syncThemeIcon() {
  const icon = document.getElementById('themeToggleIcon');
  if (!icon) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  icon.textContent = isDark ? 'light_mode' : 'dark_mode';
}

// ──── BroadcastChannel ────

const channel = new BroadcastChannel('rdms-sync');

channel.onmessage = (event) => {
  const { type } = event.data;
  if (type === 'config-updated') {
    updateNavEventName();
    // Lock state lives on config — refresh the banner so lock / unlock /
    // New Event / restore / event-switch all reflect immediately (New Event
    // clears the config, so a stale locked banner must come down).
    refreshLockBanner().catch(() => {});
  }
  if (type === 'draw-imported' || type === 'race-updated') {
    // Re-mount current page if it cares about race data
    if (currentPage === 'dashboard') {
      navigate(); // re-render
    }
  }
};

// Same-tab listener — BroadcastChannel.onmessage only fires in OTHER
// tabs of the same origin, so the tab that called broadcastChange()
// itself needs its own hook. Without this, DB Admin → Restore (and
// any other same-tab config write) leaves the nav badge stale until
// page reload. The CustomEvent is dispatched in broadcastChange below.
window.addEventListener('rdms-config-updated', () => {
  updateNavEventName();
  refreshLockBanner().catch(() => {});
});

export function broadcastChange(type, data = {}) {
  channel.postMessage({ type, ...data });
  // Also fan out a window CustomEvent so same-tab subscribers (e.g. the
  // race page that already has its DOM mounted) can react without
  // remounting. The BroadcastChannel onmessage above only fires in OTHER
  // tabs of the same origin.
  try {
    window.dispatchEvent(new CustomEvent(`rdms-${type}`, { detail: data }));
  } catch { /* no-op in environments without CustomEvent */ }

  // Auto-sync to Supabase on every race-updated broadcast — catches all
  // the start/finish/cancel/reset/joyi paths that previously only
  // updated the local DB. The sync layer's own dedup keeps the actual
  // upserts to one per race per flush cycle. Fire-and-forget; the
  // periodic 30s retry handles transient failures.
  if (type === 'race-updated' && data?.race_number) {
    import('./sync.js').then(m => m.queueRaceSync(data.race_number)).catch(() => {});
  }
}

// ──── Folder Connection ────

window._connectFolder = async (type) => {
  if (type === 'source') {
    if (needsDriveFallback()) {
      // Web version — use Google Drive API
      await requestDriveAccess();
    } else {
      // Local version — use File System Access API. When a folder is
      // already attached, treat the click as "switch to another folder"
      // (e.g. operator just restored 2026WU2 over 2026WU and needs to
      // point at the new event's directory). Reset the handle first so
      // requestSourceFolder doesn't short-circuit on the cached one.
      if (isSourceConnected()) {
        const ok = confirm('A folder is already connected. Pick a different folder?\n\nWatchers will be stopped; restart them from Im/Export after picking.');
        if (!ok) return;
        const { resetFolderAccess } = await import('./file-access.js');
        resetFolderAccess();
        try {
          const { stopDrawWatch } = await import('./draw-watch.js');
          stopDrawWatch();
        } catch {}
        try {
          const { stopJoyiWatch } = await import('./joyi-watch.js');
          stopJoyiWatch();
        } catch {}
      }
      await requestSourceFolder();
    }
  }
  updateFolderIcons();

  // After a (re)connect, resume any watcher whose persisted intent is "on"
  // but whose timer isn't running this session — e.g. after a DB restore
  // paused the loops and reset the folder handle. startJoyiWatch/start-
  // DrawWatch re-resolve the folder path from the (possibly new) event and
  // re-bootstrap their seen-files baseline. No-op when nothing is enabled,
  // or after a "switch folder" (which clears the intent via stop*Watch).
  try {
    if (isSourceConnected() || isDriveApiConnected()) {
      const { isJoyiWatchEnabled, isJoyiWatchRunning, startJoyiWatch } = await import('./joyi-watch.js');
      if (isJoyiWatchEnabled() && !isJoyiWatchRunning()) {
        try { await startJoyiWatch(); } catch { /* surfaced by start() */ }
      }
      const { isDrawWatchEnabled, isDrawWatchRunning, startDrawWatch } = await import('./draw-watch.js');
      if (isDrawWatchEnabled() && !isDrawWatchRunning()) {
        try { await startDrawWatch(); } catch { /* surfaced by start() */ }
      }
    }
  } catch { /* watch modules optional */ }
};

function updateFolderIcons() {
  const srcBtn = document.getElementById('btnConnectSource');
  const label = document.getElementById('btnConnectLabel');
  if (srcBtn) {
    const connected = needsDriveFallback() ? isDriveApiConnected() : isSourceConnected();
    srcBtn.style.color = connected ? '#10b981' : '';
    srcBtn.querySelector('i').textContent = connected ? 'folder' : (needsDriveFallback() ? 'cloud' : 'folder_open');
    if (label) {
      label.textContent = connected ? 'Connected' : 'Connect Folder';
      label.style.color = connected ? '#10b981' : '';
    }
  }
}

// Expose so other modules (notably Setup → Event's inline Connect button)
// can refresh the navbar icon state without a hard re-render. Avoids a
// stale "Connect Folder" label after connecting from a non-navbar path.
window._rdmsUpdateFolderIcons = updateFolderIcons;

// ──── Init ────

async function updateNavUserInfo() {
  if (!isLocal()) {
    document.querySelectorAll('.nav-link').forEach(link => {
      const page = link.getAttribute('data-page');
      if (page === 'dashboard') {
        link.style.display = ''; // always visible
      } else if (!isAuthenticated) {
        link.style.display = 'none'; // hide all except dashboard when not logged in
      } else if (page && !canAccessPage(page)) {
        link.style.display = 'none'; // hide by role
      } else {
        link.style.display = '';
      }

      // Rename "Setup" to "Guide" for non-admin roles
      if (page === 'setup' && !hasPermission('config.edit')) {
        const textNode = [...link.childNodes].find(n => n.nodeType === 3 || n.tagName !== 'I');
        if (link.textContent.includes('Setup')) {
          link.innerHTML = link.innerHTML.replace('Setup', 'Guide');
        }
      }
    });
  }

  // Show/hide login button in navbar. Local mode never shows it — local
  // dev is always admin and offering a logout button just lets the
  // operator stuck themselves out of their own machine.
  const loginBtn = document.getElementById('navLoginBtn');
  if (loginBtn) {
    if (isLocal()) {
      loginBtn.style.display = 'none';
    } else if (isAuthenticated) {
      loginBtn.style.display = '';
      loginBtn.innerHTML = `<i class="material-icons" style="font-size:18px;">logout</i>`;
      loginBtn.title = `Logged in as ${getRole()}. Click to logout.`;
      loginBtn.onclick = async () => {
        await logout();
        isAuthenticated = false;
        window._rdmsAuthenticated = false;
        await updateNavUserInfo();
        // Force the route back to the public dashboard. If the user is
        // already on #/dashboard, setting the same hash is a no-op and
        // hashchange won't fire — so we replace history + call navigate()
        // ourselves to guarantee the page re-renders as the public
        // (unauthenticated) view with the digital-flag panel.
        if ((window.location.hash || '').replace('#/', '').split('/')[0] === 'dashboard') {
          await navigate();
        } else {
          window.location.hash = '#/dashboard';
        }
      };
    } else {
      loginBtn.style.display = '';
      loginBtn.innerHTML = `<i class="material-icons" style="font-size:18px;">login</i>`;
      loginBtn.title = 'Sign in';
      loginBtn.onclick = () => { showLoginModal(); };
    }
  }
}

// External Firebase station pages — used when default_mode points at a
// physical station rather than an RDMS route. Keep aligned with
// signal-panel.js's openStationTab() URL table.
const STATION_URLS = {
  finish:        'https://sdbafinishing.github.io/finisher.html',
  finisher:      'https://sdbafinishing.github.io/finisher.html',
  'race-control': 'https://sdbafinishing.github.io/race-control.html',
  starter:       'https://sdbafinishing.github.io/starter.html',
};

/**
 * Navigate to the user's configured landing page.
 *   - Station modes (finish / starter / race-control) → external standalone
 *     Firebase station URL (full-page redirect).
 *   - RDMS routes (race, timesheet, scoring, …) → set the hash + let the
 *     router pick it up.
 *   - Anything else / unreachable → return false so the caller can fall
 *     back to whatever default behavior makes sense.
 * @param {string|null} mode
 * @returns {boolean} true if the redirect was issued
 */
function routeToDefaultMode(mode) {
  if (!mode) return false;
  if (STATION_URLS[mode]) {
    window.location.href = STATION_URLS[mode];
    return true;
  }
  // 'read-only' is an alias for the dashboard — explicit label in the
  // user form for accounts that just need to watch progress, no edit
  // permissions. Routes to dashboard (where the role gate handles the
  // actual read-only enforcement).
  if (mode === 'dashboard' || mode === 'read-only') return false;
  if (canAccessPage(mode)) {
    window.location.hash = `#/${mode}`;
    return true;
  }
  return false;
}

function showLoginModal() {
  const modal = document.createElement('div');
  modal.id = 'loginModal';
  modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9998; display:flex; align-items:center; justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:24px; max-width:360px; width:90%; box-shadow:var(--shadow-lg);">
      <div style="text-align:center; margin-bottom:20px;">
        <span style="font-size:20px; font-weight:700; color:var(--brand);">SDBA</span>
        <span style="font-size:15px; font-weight:500; color:var(--text-secondary); margin-left:4px;">RDMS</span>
      </div>
      <div class="form-group">
        <input class="form-input" id="modalLoginEmail" type="text" placeholder="Username"
               autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false">
      </div>
      <div class="form-group">
        <input class="form-input" id="modalLoginPassword" type="password" placeholder="Password" autocomplete="current-password">
      </div>
      <div id="modalLoginError" style="color:var(--danger); font-size:12px; margin-bottom:8px; display:none;"></div>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button class="btn btn-ghost" onclick="document.getElementById('loginModal').remove()">Cancel</button>
        <button class="btn btn-primary" id="modalLoginBtn">Sign In</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Enter key support
  ['modalLoginEmail', 'modalLoginPassword'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('modalLoginBtn').click();
    });
  });

  modal.querySelector('#modalLoginBtn').addEventListener('click', async () => {
    const usernameInput = document.getElementById('modalLoginEmail').value.trim();
    const password = document.getElementById('modalLoginPassword').value;
    const errEl = document.getElementById('modalLoginError');

    if (!usernameInput || !password) {
      errEl.textContent = 'Enter username and password';
      errEl.style.display = 'block';
      return;
    }

    const { login } = await import('./auth.js');
    const result = await login(usernameInput, password);

    if (result) {
      isAuthenticated = true;
      window._rdmsAuthenticated = true;
      modal.remove();
      showToast(`Signed in as ${result.role}`, 'success');
      await updateNavUserInfo();
      // Route the user to their preferred landing page (default_mode from
      // rdms_users). For station modes (finish/starter/race-control) we
      // redirect to the standalone Firebase station pages instead.
      if (!routeToDefaultMode(result.defaultMode)) {
        navigate(); // re-render current page with new permissions
      }
    } else {
      errEl.textContent = 'Invalid username or password';
      errEl.style.display = 'block';
    }
  });
}

async function init() {
  startClock();
  syncThemeIcon();

  // Auth check — expose for dashboard.
  // Local dev is always admin: force the role on every init so a stale
  // localStorage value (e.g. from clicking the logout button) can't lock
  // the operator out of their own machine.
  if (isLocal()) {
    isAuthenticated = true;
    setRole('admin');
  }
  window._rdmsAuthenticated = isAuthenticated;

  // Web version: auto-configure from baked-in web-config, load latest event
  if (!isLocal()) {
    const { ready, eventRef } = await initWebVersion();
    if (!ready) {
      document.getElementById('app').innerHTML = `
        <div class="card" style="text-align:center; padding:40px; margin-top:40px;">
          <i class="material-icons" style="font-size:48px; color:var(--text-tertiary);">cloud_off</i>
          <h3 style="margin-top:12px; color:var(--text-secondary);">RDMS Not Configured</h3>
          <p style="color:var(--text-tertiary); margin-top:8px;">Web config (Supabase keys) not set. Contact the administrator.</p>
        </div>`;
      return;
    }

    // Wire the Supabase client into the auth module so login() can use it.
    // Also restores an existing session if one is already saved.
    const authResult = await initAuth(getWebSupabase());
    if (authResult?.authenticated) {
      isAuthenticated = true;
      window._rdmsAuthenticated = true;
      // Honor default_mode on initial load — but only if the user hasn't
      // already deep-linked into a specific page. The default is
      // #/dashboard (empty hash), so we only redirect from that.
      const hash = window.location.hash || '';
      if (!hash || hash === '#/' || hash === '#/dashboard') {
        routeToDefaultMode(authResult.defaultMode);
      }
    }

    // Keep a left-open web viewer current: poll Supabase for race-snapshot
    // changes so a second tab showing the dashboard tracks the operator's
    // local app without a manual reload. Online only; no-op locally.
    startWebDashboardPoll();
  }

  await updateNavEventName();
  await updateNavUserInfo(); // Set up login/logout button
  startSyncService(); // Start Supabase sync (no-op if not configured)

  // Listen for hash changes
  window.addEventListener('hashchange', navigate);

  // Initial navigation
  await navigate();

  // Suggest connecting the event folder if nothing is connected yet.
  // Fires once per page-load, dismissible — operators who don't need
  // file IO (read-only viewers) can just click "Skip".
  promptConnectFolderIfMissing().catch(() => {});
}

async function promptConnectFolderIfMissing() {
  // View-only / public users never do file IO — they're here to watch the
  // 3 digital flags, not import/export. Don't nag them to connect a folder.
  //   • Web + not signed in  → public viewer (note: the RBAC role defaults
  //     to "admin" before login, so we must check isAuthenticated, not just
  //     the permission).
  //   • Any host + signed-in "viewer" role → read-only, lacks file perms.
  //   • Local dev is always an authenticated admin → falls through.
  if (!isLocal() && !isAuthenticated) return;
  if (!hasPermission('race.import_joyi')) return;

  // Only show on actual app pages (not the public dashboard / sign-in
  // splash). hasPermission gates on a real user being signed in.
  const localOk = isSourceConnected();
  const driveOk = isDriveApiConnected();
  if (localOk || driveOk) {
    // Folder already connected — still nudge the operator on watchers
    // if neither is running. Most race-day pain is people forgetting to
    // hit "Start watching" on Joyi.
    await maybePromptStartWatchers();
    return;
  }
  // Wait a beat so the page has rendered before stacking a modal on top.
  await new Promise(r => setTimeout(r, 500));

  const existing = document.getElementById('connectFolderPromptModal');
  if (existing) existing.remove();

  // Lazy-load watch modules so we don't pay the import cost on every
  // page-load. They're only needed for the two extra buttons.
  // Note: "Running" not "Enabled" — the intent flag persists across
  // reloads via localStorage but the setInterval dies on page unload.
  // The modal needs the actual-running state to decide what to show.
  const [{ startDrawWatch, isDrawWatchRunning, isDrawWatchEnabled }, { startJoyiWatch, isJoyiWatchRunning, isJoyiWatchEnabled }] = await Promise.all([
    import('./draw-watch.js'),
    import('./joyi-watch.js'),
  ]);

  const modal = document.createElement('div');
  modal.id = 'connectFolderPromptModal';
  modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:22px 26px; max-width:520px; width:100%; box-shadow:var(--shadow-lg);">
      <h5 style="font-size:16px; font-weight:600; margin:0 0 10px;">
        <i class="material-icons" style="vertical-align:middle; color:var(--accent);">folder_open</i>
        Race-day setup
      </h5>
      <p style="font-size:13px; color:var(--text-secondary); margin:0 0 14px;">
        RDMS needs the event folder connected to read draws / Joyi results
        and to write exports. Connect once per browser session.
      </p>

      <div id="connectPromptSteps" style="display:flex; flex-direction:column; gap:8px; margin-bottom:16px;"></div>

      <p style="font-size:12px; color:var(--text-tertiary); margin:0 0 14px;">
        Watchers auto-import any new <code>.xls</code> / <code>.jyd</code> / <code>.lcd</code> that lands in the folder. You can also start them later via Im/Export.
      </p>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button class="btn btn-ghost" id="connectPromptSkip">Skip for now</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  // Render the three step rows based on current state. Called after each
  // step completes so the visual "ticked" state stays in sync without a
  // re-mount. Done steps render as a flat, disabled row with a green
  // check; pending steps render as actionable buttons.
  function renderSteps() {
    const connected = isSourceConnected() || isDriveApiConnected();
    const drawOn = isDrawWatchRunning();
    const joyiOn = isJoyiWatchRunning();
    const stepsEl = modal.querySelector('#connectPromptSteps');
    const row = ({ id, done, label, doneLabel, kind }) => done
      ? `<div style="display:flex; align-items:center; gap:8px; padding:8px 12px; border:1px solid var(--success); background:rgba(16,185,129,0.08); border-radius:var(--radius-md); color:var(--text-secondary);">
          <i class="material-icons" style="font-size:18px; color:var(--success);">check_circle</i>
          <span style="font-size:13px;">${doneLabel}</span>
        </div>`
      : `<button class="btn ${kind}" id="${id}" style="justify-content:flex-start;">
          <i class="material-icons" style="font-size:16px;">${kind === 'btn-primary' ? 'folder_open' : 'visibility'}</i>
          ${label}
        </button>`;

    stepsEl.innerHTML = [
      row({ id: 'connectPromptGo', done: connected, kind: 'btn-primary',
            label: '1. Connect event folder',
            doneLabel: '1. Event folder connected' }),
      row({ id: 'connectPromptDrawWatch', done: drawOn, kind: 'btn-outline',
            label: `2. Start watching <code>01 Input_Draw/</code>`,
            doneLabel: '2. Watching <code>01 Input_Draw/</code>' }),
      row({ id: 'connectPromptJoyiWatch', done: joyiOn, kind: 'btn-outline',
            label: '3. Start watching Joyi folder',
            doneLabel: '3. Watching Joyi folder' }),
    ].join('');

    // Rewire any buttons that are still actionable.
    const goBtn = stepsEl.querySelector('#connectPromptGo');
    if (goBtn) goBtn.addEventListener('click', onConnect);
    const drawBtn = stepsEl.querySelector('#connectPromptDrawWatch');
    if (drawBtn) drawBtn.addEventListener('click', onStartDraw);
    const joyiBtn = stepsEl.querySelector('#connectPromptJoyiWatch');
    if (joyiBtn) joyiBtn.addEventListener('click', onStartJoyi);

    const skipBtn = modal.querySelector('#connectPromptSkip');
    if (skipBtn) skipBtn.textContent = (connected && drawOn && joyiOn) ? 'Close' : 'Skip for now';
  }

  async function onConnect() {
    try {
      await window._connectFolder('source');
      const nowConnected = isSourceConnected() || isDriveApiConnected();
      if (nowConnected) {
        // Auto-restart any watcher whose persisted intent says "on" but
        // whose timer isn't actually running this session. Race-day path:
        // operator had Joyi watch enabled, reloaded the tab, expects it
        // to resume the moment the folder is reconnected.
        if (isDrawWatchEnabled() && !isDrawWatchRunning()) {
          try { await startDrawWatch(); } catch { /* surfaced by start() */ }
        }
        if (isJoyiWatchEnabled() && !isJoyiWatchRunning()) {
          try { await startJoyiWatch(); } catch { /* surfaced by start() */ }
        }
        renderSteps();
      }
    } catch (err) {
      console.warn('Connect folder from prompt failed:', err);
    }
  }

  async function onStartDraw() {
    try { await startDrawWatch(); renderSteps(); }
    catch (err) { console.warn('Start draw watch failed:', err); }
  }

  async function onStartJoyi() {
    try { await startJoyiWatch(); renderSteps(); }
    catch (err) { console.warn('Start joyi watch failed:', err); }
  }

  modal.querySelector('#connectPromptSkip').addEventListener('click', () => modal.remove());
  renderSteps();
}

// When a folder IS already connected, surface a slimmer "do you want
// to start the watchers" nudge if they're off. Race-day operators
// often connect the folder via Setup and forget the watcher toggles.
async function maybePromptStartWatchers() {
  const { isDrawWatchRunning, isDrawWatchEnabled, startDrawWatch } = await import('./draw-watch.js');
  const { isJoyiWatchRunning, isJoyiWatchEnabled, startJoyiWatch } = await import('./joyi-watch.js');

  // Auto-restart watchers on boot when the operator's persisted intent
  // says "on" but the page-session timer isn't actually scanning yet.
  // This is the common race-day path: reload the tab, watchers should
  // resume automatically. Failures here are silent — start() will toast
  // its own diagnostic if the folder isn't connected.
  if (isDrawWatchEnabled() && !isDrawWatchRunning()) {
    try { await startDrawWatch(); } catch { /* surfaced by start() */ }
  }
  if (isJoyiWatchEnabled() && !isJoyiWatchRunning()) {
    try { await startJoyiWatch(); } catch { /* surfaced by start() */ }
  }

  // If after the auto-restart both watchers are running, no prompt needed.
  if (isDrawWatchRunning() && isJoyiWatchRunning()) return;
  // Single dismiss-per-session flag — don't re-nag on every navigation.
  if (sessionStorage.getItem('rdms-watcher-prompt-dismissed') === '1') return;
  await new Promise(r => setTimeout(r, 500));
  if (document.getElementById('watcherPromptModal')) return;

  const modal = document.createElement('div');
  modal.id = 'watcherPromptModal';
  modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9999; display:flex; align-items:center; justify-content:center; padding:20px;';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:22px 26px; max-width:500px; width:100%; box-shadow:var(--shadow-lg);">
      <h5 style="font-size:16px; font-weight:600; margin:0 0 10px;">
        <i class="material-icons" style="vertical-align:middle; color:var(--accent);">visibility</i>
        Start file watchers?
      </h5>
      <p style="font-size:13px; color:var(--text-secondary); margin:0 0 14px;">
        Folder is connected. RDMS can auto-import draws + Joyi results
        as soon as they appear in the folder. Start the watchers now?
      </p>
      <div id="watcherPromptSteps" style="display:flex; flex-direction:column; gap:8px; margin-bottom:14px;"></div>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button class="btn btn-ghost" id="watcherPromptSkip">Skip for now</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  function renderSteps() {
    const drawOn = isDrawWatchRunning();
    const joyiOn = isJoyiWatchRunning();
    const row = ({ id, done, label, doneLabel }) => done
      ? `<div style="display:flex; align-items:center; gap:8px; padding:8px 12px; border:1px solid var(--success); background:rgba(16,185,129,0.08); border-radius:var(--radius-md); color:var(--text-secondary);">
          <i class="material-icons" style="font-size:18px; color:var(--success);">check_circle</i>
          <span style="font-size:13px;">${doneLabel}</span>
        </div>`
      : `<button class="btn btn-outline" id="${id}" style="justify-content:flex-start;">
          <i class="material-icons" style="font-size:16px;">visibility</i>
          ${label}
        </button>`;
    modal.querySelector('#watcherPromptSteps').innerHTML = [
      row({ id: 'watcherPromptDraw', done: drawOn,
            label: 'Watch <code>01 Input_Draw/</code>',
            doneLabel: 'Watching <code>01 Input_Draw/</code>' }),
      row({ id: 'watcherPromptJoyi', done: joyiOn,
            label: 'Watch Joyi folder',
            doneLabel: 'Watching Joyi folder' }),
    ].join('');
    const drawBtn = modal.querySelector('#watcherPromptDraw');
    if (drawBtn) drawBtn.addEventListener('click', async () => {
      try { await startDrawWatch(); renderSteps(); }
      catch (err) { console.warn('Start draw watch failed:', err); }
    });
    const joyiBtn = modal.querySelector('#watcherPromptJoyi');
    if (joyiBtn) joyiBtn.addEventListener('click', async () => {
      try { await startJoyiWatch(); renderSteps(); }
      catch (err) { console.warn('Start joyi watch failed:', err); }
    });
    modal.querySelector('#watcherPromptSkip').textContent = (drawOn && joyiOn) ? 'Close' : 'Skip for now';
  }

  modal.querySelector('#watcherPromptSkip').addEventListener('click', () => {
    sessionStorage.setItem('rdms-watcher-prompt-dismissed', '1');
    modal.remove();
  });
  renderSteps();
}

// Start the app
init();
