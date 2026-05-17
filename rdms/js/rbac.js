/**
 * SDBA RDMS — Role-Based Access Control (RBAC)
 *
 * Roles:
 *   admin   — full access: config, divisions, import, export, results input, scoring, reset
 *   editor  — can import/export, input/edit race results, but NO config/division/reset changes
 *   viewer  — read-only: dashboard, results, scoring, flowchart, timesheet (no edits)
 *   public  — no login: can only see digital flag status (finisher/starter/race-control pages)
 *
 * Implementation:
 *   Phase 1 (current): No auth. All users are implicitly "admin".
 *                       RBAC module defines permissions but doesn't enforce yet.
 *   Phase 3 (future):  Supabase Auth or Firebase Auth. Login required for RDMS pages.
 *                       Digital flag pages remain public (no login needed).
 *
 * When hosted on GitHub Pages:
 *   - Digital flag pages (home.html, finisher.html, etc.) = public, no auth
 *   - RDMS (/rdms/) = requires auth, role determines access
 *
 * Local dev mode:
 *   - Bypass auth, default to admin role
 *   - All features accessible for testing
 */

// Permission matrix
const PERMISSIONS = {
  // Page access
  'page.dashboard':      { admin: true,  editor: true,  viewer: true  },
  'page.race':           { admin: true,  editor: true,  viewer: true  },
  'page.timesheet':      { admin: true,  editor: true,  viewer: true  },
  'page.scoring':        { admin: true,  editor: true,  viewer: true  },
  'page.flowchart':      { admin: true,  editor: true,  viewer: true  },
  'page.import':         { admin: true,  editor: true,  viewer: false },
  'page.setup':          { admin: true,  editor: false, viewer: false },
  'page.admin':          { admin: true,  editor: false, viewer: false },

  // Actions
  'race.start':          { admin: true,  editor: true,  viewer: false },
  'race.input':          { admin: true,  editor: true,  viewer: false },
  'race.cancel':         { admin: true,  editor: true,  viewer: false },
  'race.export':         { admin: true,  editor: true,  viewer: false },
  'race.send':           { admin: true,  editor: true,  viewer: false },
  'race.import_joyi':    { admin: true,  editor: true,  viewer: false },
  'race.import_draw':    { admin: true,  editor: true,  viewer: false },
  'race.signal_next':    { admin: true,  editor: true,  viewer: false },

  // Config
  'config.edit':         { admin: true,  editor: false, viewer: false },
  'config.reset':        { admin: true,  editor: false, viewer: false },
  'division.edit':       { admin: true,  editor: false, viewer: false },
  'schedule.edit':       { admin: true,  editor: false, viewer: false },

  // Data management
  'db.view':             { admin: true,  editor: false, viewer: false },
  'db.edit':             { admin: true,  editor: false, viewer: false },
  'db.backup':           { admin: true,  editor: true,  viewer: false },
  'db.restore':          { admin: true,  editor: false, viewer: false },
  'db.clear':            { admin: true,  editor: false, viewer: false },

  // Station signals
  'signal.finisher':     { admin: true,  editor: true,  viewer: false },
  'signal.race_control': { admin: true,  editor: false, viewer: false },
  'signal.starter':      { admin: true,  editor: false, viewer: false },
};

// Current user role (default: admin for local dev)
let currentRole = 'admin';

/**
 * Set the current user's role.
 * @param {'admin'|'editor'|'viewer'} role
 */
export function setRole(role) {
  if (['admin', 'editor', 'viewer'].includes(role)) {
    currentRole = role;
    localStorage.setItem('rdms-role', role);
  }
}

/**
 * Get the current user's role.
 * @returns {string}
 */
export function getRole() {
  return currentRole;
}

/**
 * Check if the current user has a specific permission.
 * @param {string} permission - e.g. 'race.export', 'config.edit'
 * @returns {boolean}
 */
export function hasPermission(permission) {
  const perm = PERMISSIONS[permission];
  if (!perm) return false;
  return perm[currentRole] || false;
}

/**
 * Check if the current user can access a page.
 * @param {string} pageName - e.g. 'dashboard', 'setup', 'admin'
 * @returns {boolean}
 */
export function canAccessPage(pageName) {
  return hasPermission(`page.${pageName}`);
}

/**
 * Get all permissions for the current role.
 * @returns {Object} { permission: boolean }
 */
export function getAllPermissions() {
  const result = {};
  for (const [key, roles] of Object.entries(PERMISSIONS)) {
    result[key] = roles[currentRole] || false;
  }
  return result;
}

/**
 * Initialize RBAC from localStorage or default.
 */
export function initRBAC() {
  const saved = localStorage.getItem('rdms-role');
  if (saved && ['admin', 'editor', 'viewer'].includes(saved)) {
    currentRole = saved;
  } else {
    // Default to admin for local dev
    currentRole = 'admin';
  }
}

// Auto-initialize
initRBAC();

// Expose to window for UI checks
window._hasPermission = hasPermission;
window._getRole = getRole;
