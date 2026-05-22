/**
 * SDBA RDMS — Authentication
 *
 * Local (localhost / 127.0.0.1): always admin, no login required.
 * Web (GitHub Pages / any other host): Supabase Auth, role from user metadata.
 *
 * Username scheme: Supabase Auth requires an email, so each user's Auth
 * record uses `username@sdba.local`. The login form accepts username only;
 * we append the suffix before calling signInWithPassword. The domain is
 * never used for email delivery (no SMTP), so non-routable is fine.
 *
 * User profile stored in Supabase `rdms_users` table:
 *   { id, email, username, role, display_name, default_mode,
 *     created_at, updated_at }
 *
 * On login: look up user's profile from rdms_users by email.
 *   - role     → drives RBAC
 *   - default_mode → which RDMS page the user lands on after login
 *                    ('dashboard', 'race', 'finish', 'starter', 'race-control',
 *                     'timesheet', 'scoring', etc.)
 * If user exists in Auth but not in rdms_users → viewer (default), dashboard.
 */
import { setRole, getRole } from './rbac.js';
import { showToast } from './utils.js';

// Synthetic email suffix used to satisfy Supabase Auth's email requirement
// while keeping the user-facing identifier a plain username. Don't change
// this without coordinating an email rewrite in the rdms_users table.
const USERNAME_SUFFIX = '@sdba.local';

let supabaseAuth = null;
let currentUser = null;
let currentDefaultMode = null;

function toEmail(usernameOrEmail) {
  const v = (usernameOrEmail || '').trim();
  if (!v) return '';
  return v.includes('@') ? v : `${v}${USERNAME_SUFFIX}`;
}

export function emailToUsername(email) {
  const v = (email || '').trim();
  if (!v) return '';
  return v.endsWith(USERNAME_SUFFIX)
    ? v.slice(0, -USERNAME_SUFFIX.length)
    : v;
}

export function getDefaultMode() {
  return currentDefaultMode;
}

/**
 * Check if running locally (no auth needed).
 */
export function isLocal() {
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0';
}

/**
 * Initialize auth system.
 * - Local: set admin, return immediately.
 * - Web: check Supabase session, show login if needed.
 * @param {Object} supabaseClient - Initialized Supabase client (or null)
 * @returns {{ authenticated: boolean, user: Object|null, role: string }}
 */
export async function initAuth(supabaseClient) {
  if (isLocal()) {
    setRole('admin');
    return { authenticated: true, user: null, role: 'admin' };
  }

  if (!supabaseClient) {
    // No Supabase configured — show login prompt
    return { authenticated: false, user: null, role: 'viewer' };
  }

  supabaseAuth = supabaseClient;

  // Check existing session
  const { data: { session } } = await supabaseAuth.auth.getSession();
  if (session?.user) {
    return await resolveUser(session.user);
  }

  // No session — need login
  return { authenticated: false, user: null, role: 'viewer' };
}

/**
 * Login with username (or legacy email) + password.
 * Plain usernames are mapped to <username>@sdba.local before being passed
 * to Supabase. Inputs containing `@` are treated as legacy emails.
 */
export async function login(usernameOrEmail, password) {
  if (!supabaseAuth) {
    showToast('Supabase not configured', 'error');
    return null;
  }

  const email = toEmail(usernameOrEmail);
  const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
  if (error) {
    showToast(`Login failed: ${error.message}`, 'error');
    return null;
  }

  return await resolveUser(data.user);
}

/**
 * Logout.
 */
export async function logout() {
  if (supabaseAuth) {
    await supabaseAuth.auth.signOut();
  }
  currentUser = null;
  setRole('viewer');
  showToast('Logged out', 'info');
}

/**
 * Resolve user's role + default landing station from rdms_users table.
 *
 * default_mode names the physical race-day station the user runs:
 *   'race-control' | 'starter' | 'finish'
 * The router redirects to the matching standalone Firebase station page.
 * Anything else (or blank) lands on the Dashboard; admins default to
 * 'finish' on race day, others to 'dashboard'.
 *
 * Legacy values that pre-dated this constraint (e.g. 'race', 'scoring',
 * 'timesheet') are still accepted on read for back-compat — the router
 * just falls back to dashboard if they aren't routable to a station URL.
 */
async function resolveUser(authUser) {
  currentUser = authUser;

  let role = 'viewer';
  let defaultMode = null;
  try {
    const { data } = await supabaseAuth
      .from('rdms_users')
      .select('role, display_name, default_mode')
      .eq('email', authUser.email)
      .single();
    if (data?.role) role = data.role;
    if (data?.default_mode) defaultMode = data.default_mode;
  } catch {
    // Table missing or user not in rdms_users — fall through to defaults.
  }

  if (!defaultMode) defaultMode = role === 'admin' ? 'finish' : 'dashboard';
  currentDefaultMode = defaultMode;

  setRole(role);
  return { authenticated: true, user: authUser, role, defaultMode };
}

/**
 * Get current authenticated user.
 */
export function getCurrentUser() {
  return currentUser;
}

/**
 * Render login page.
 * @param {HTMLElement} container
 * @param {function} onSuccess - Called after successful login
 */
export function renderLoginPage(container, onSuccess) {
  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:center; min-height:80vh;">
      <div class="card" style="max-width:360px; width:100%; text-align:center;">
        <div style="margin-bottom:20px;">
          <span style="font-size:24px; font-weight:700; color:var(--brand);">SDBA</span>
          <span style="font-size:18px; font-weight:500; color:var(--text-secondary); margin-left:6px;">RDMS</span>
        </div>
        <p style="font-size:13px; color:var(--text-secondary); margin-bottom:20px;">
          Race Day Management System — Sign in to continue
        </p>
        <div class="form-group">
          <input class="form-input" id="loginEmail" type="text" placeholder="Username"
                 autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false">
        </div>
        <div class="form-group">
          <input class="form-input" id="loginPassword" type="password" placeholder="Password" autocomplete="current-password">
        </div>
        <div id="loginError" style="color:var(--danger); font-size:12px; margin-bottom:8px; display:none;"></div>
        <button class="btn btn-primary" style="width:100%;" id="loginBtn" onclick="window._doLogin()">
          Sign In
        </button>
        <p style="font-size:11px; color:var(--text-tertiary); margin-top:16px;">
          Contact your administrator for access.
        </p>
      </div>
    </div>
  `;

  // Allow Enter key to submit
  ['loginEmail', 'loginPassword'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') window._doLogin();
    });
  });

  window._doLogin = async () => {
    const usernameInput = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');

    if (!usernameInput || !password) {
      errEl.textContent = 'Enter username and password';
      errEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Signing in...';
    errEl.style.display = 'none';

    const result = await login(usernameInput, password);
    btn.disabled = false;
    btn.textContent = 'Sign In';

    if (result) {
      showToast(`Signed in as ${result.role}`, 'success');
      if (onSuccess) onSuccess(result);
    } else {
      errEl.textContent = 'Invalid username or password';
      errEl.style.display = 'block';
    }
  };
}
