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
import { initWebVersion, showEventPicker } from './web-init.js';
import { mountDashboard, unmountDashboard } from './pages/dashboard.js';
import { mountSetup, unmountSetup } from './pages/setup.js';
import { mountRacePage, unmountRacePage } from './pages/race-page.js';
import { mountImportPage, unmountImportPage } from './pages/import-page.js';
import { mountTimesheetPage, unmountTimesheetPage } from './pages/timesheet-page.js';
import { mountScoringPage, unmountScoringPage } from './pages/scoring-page.js';
import { mountFlowchartPage, unmountFlowchartPage } from './pages/flowchart-page.js';
import { mountAdminPage, unmountAdminPage } from './pages/admin-page.js';
import { mountUsersPage, unmountUsersPage } from './pages/users-page.js';
import { initAuth, isLocal, renderLoginPage, logout, getCurrentUser } from './auth.js';
import { canAccessPage, getRole, hasPermission } from './rbac.js';

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
  } else {
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
            title="${clickable ? 'Click to switch event' : ''}">${config.event_short_ref}</span>
      <span style="margin-left:6px;">${config.event_long_name_en || ''}</span>
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
  }
  if (type === 'draw-imported' || type === 'race-updated') {
    // Re-mount current page if it cares about race data
    if (currentPage === 'dashboard') {
      navigate(); // re-render
    }
  }
};

export function broadcastChange(type, data = {}) {
  channel.postMessage({ type, ...data });
}

// ──── Folder Connection ────

window._connectFolder = async (type) => {
  if (type === 'source') {
    if (needsDriveFallback()) {
      // Web version — use Google Drive API
      await requestDriveAccess();
    } else {
      // Local version — use File System Access API
      await requestSourceFolder();
    }
  }
  updateFolderIcons();
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

  // Show/hide login button in navbar
  const loginBtn = document.getElementById('navLoginBtn');
  if (loginBtn) {
    if (isAuthenticated) {
      loginBtn.innerHTML = `<i class="material-icons" style="font-size:18px;">logout</i>`;
      loginBtn.title = `Logged in as ${getRole()}. Click to logout.`;
      loginBtn.onclick = async () => {
        await logout();
        isAuthenticated = false;
        await updateNavUserInfo();
        window.location.hash = '#/dashboard';
      };
    } else if (!isLocal()) {
      loginBtn.innerHTML = `<i class="material-icons" style="font-size:18px;">login</i>`;
      loginBtn.title = 'Sign in';
      loginBtn.onclick = () => { showLoginModal(); };
    } else {
      loginBtn.style.display = 'none';
    }
  }
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
        <input class="form-input" id="modalLoginEmail" type="email" placeholder="Email" autocomplete="email">
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
    const email = document.getElementById('modalLoginEmail').value.trim();
    const password = document.getElementById('modalLoginPassword').value;
    const errEl = document.getElementById('modalLoginError');

    if (!email || !password) {
      errEl.textContent = 'Enter email and password';
      errEl.style.display = 'block';
      return;
    }

    const { login } = await import('./auth.js');
    const result = await login(email, password);

    if (result) {
      isAuthenticated = true;
      window._rdmsAuthenticated = true;
      modal.remove();
      showToast(`Signed in as ${result.role}`, 'success');
      await updateNavUserInfo();
      navigate(); // re-render current page with new permissions
    } else {
      errEl.textContent = 'Invalid email or password';
      errEl.style.display = 'block';
    }
  });
}

async function init() {
  startClock();
  syncThemeIcon();

  // Auth check — expose for dashboard
  if (isLocal()) {
    isAuthenticated = true;
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
  }

  await updateNavEventName();
  startSyncService(); // Start Supabase sync (no-op if not configured)

  // Listen for hash changes
  window.addEventListener('hashchange', navigate);

  // Initial navigation
  await navigate();
}

// Start the app
init();
