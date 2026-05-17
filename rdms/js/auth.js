/**
 * SDBA RDMS — Authentication
 *
 * Local (localhost / 127.0.0.1): always admin, no login required.
 * Web (GitHub Pages / any other host): Supabase Auth, role from user metadata.
 *
 * User roles stored in Supabase `rdms_users` table:
 *   { id, email, role, display_name, created_at, updated_at }
 *
 * On login: look up user's role from rdms_users table.
 * If user exists in Supabase Auth but not in rdms_users → viewer (default).
 */
import { setRole, getRole } from './rbac.js';
import { showToast } from './utils.js';

let supabaseAuth = null;
let currentUser = null;

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
 * Login with email + password.
 */
export async function login(email, password) {
  if (!supabaseAuth) {
    showToast('Supabase not configured', 'error');
    return null;
  }

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
 * Resolve user's role from rdms_users table.
 */
async function resolveUser(authUser) {
  currentUser = authUser;

  // Look up role in rdms_users table
  let role = 'viewer'; // default
  try {
    const { data } = await supabaseAuth
      .from('rdms_users')
      .select('role, display_name')
      .eq('email', authUser.email)
      .single();

    if (data?.role) {
      role = data.role;
    }
  } catch {
    // Table might not exist yet or user not in it
  }

  setRole(role);
  return { authenticated: true, user: authUser, role };
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
          <input class="form-input" id="loginEmail" type="email" placeholder="Email" autocomplete="email">
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
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');

    if (!email || !password) {
      errEl.textContent = 'Enter email and password';
      errEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Signing in...';
    errEl.style.display = 'none';

    const result = await login(email, password);
    btn.disabled = false;
    btn.textContent = 'Sign In';

    if (result) {
      showToast(`Signed in as ${result.role}`, 'success');
      if (onSuccess) onSuccess(result);
    } else {
      errEl.textContent = 'Invalid email or password';
      errEl.style.display = 'block';
    }
  };
}
