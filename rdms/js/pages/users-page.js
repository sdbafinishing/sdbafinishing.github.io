/**
 * SDBA RDMS — User Management Page (Admin only)
 * CRUD for rdms_users table in Supabase.
 * Users are created in Supabase Auth first, then assigned roles here.
 */
import { showToast } from '../utils.js';
import { getRole, hasPermission } from '../rbac.js';
import { isLocal, emailToUsername } from '../auth.js';

// Pages a user can default-land on after login. Kept in sync with the
// page registry in app.js + signal modes available in signal-panel.js.
// 'finish' / 'starter' / 'race-control' route to the standalone Firebase
// signal panels embedded on the dashboard (see signal-panel.js modes).
const DEFAULT_MODES = [
  { value: 'dashboard',    label: 'Dashboard (general)' },
  { value: 'race',         label: 'Race (input/scoring)' },
  { value: 'finish',       label: 'Finish station' },
  { value: 'starter',      label: 'Starter station' },
  { value: 'race-control', label: 'Race Control station' },
  { value: 'timesheet',    label: 'TimeSheet' },
  { value: 'scoring',      label: 'Scoring' },
];

// Mirror of USERNAME_SUFFIX from auth.js — kept duplicated here only because
// this module needs to build the synthetic email on user-add (auth.js doesn't
// export this constant since callers shouldn't hand-assemble emails normally).
const USERNAME_SUFFIX = '@sdba.local';

let supabaseRef = null;

// Standalone page mount (kept for nav link compatibility)
export async function mountUsersPage(container) {
  await renderUsersTab(container);
}

// Embeddable tab renderer (used by Setup page)
export async function renderUsersTab(container) {

  // Get Supabase client
  const { getConfig } = await import('../db.js');
  const config = await getConfig();

  if (!config?.supabase_url || !config?.supabase_anon_key) {
    container.innerHTML = `
      <div style="margin-top:16px;">
        <div class="card" style="padding:24px;">
          <p style="color:var(--text-secondary); margin-bottom:12px;">
            <i class="material-icons" style="vertical-align:middle; margin-right:4px;">info</i>
            User management requires Supabase. Local mode is always admin — no login needed.
          </p>
          <p style="font-size:13px; color:var(--text-tertiary);">
            To set up web access with user roles:<br>
            1. Configure Supabase URL + key in the Event tab → Live Sync section<br>
            2. Create users in Supabase Auth dashboard (email + password)<br>
            3. Come back here to assign roles (admin / editor / viewer)<br>
            4. Deploy to GitHub Pages and share the URL
          </p>
        </div>
      </div>
    `;
    return;
  }

  // Lazy load Supabase client if not already loaded
  if (!window.supabase) {
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    } catch {
      container.innerHTML = '<div style="margin-top:16px;"><div class="card" style="padding:24px; color:var(--danger);">Failed to load Supabase client.</div></div>';
      return;
    }
  }
  // Local uses service_role key (bypasses RLS for admin operations)
  // Web uses anon key (RLS enforced, requires login)
  const key = isLocal() && config.supabase_service_key
    ? config.supabase_service_key
    : config.supabase_anon_key;
  supabaseRef = window.supabase.createClient(config.supabase_url, key);

  await renderUserList(container);
}

export function unmountUsersPage() {
  cleanupUsersTab();
}

export function cleanupUsersTab() {
  delete window._userAdd;
  delete window._userEdit;
  delete window._userDelete;
  supabaseRef = null;
}

async function renderUserList(container) {
  const { data: users, error } = await supabaseRef.from('rdms_users').select('*').order('created_at');

  container.innerHTML = `
    <h4 style="font-size:18px; font-weight:600; margin-bottom:16px;">User Management</h4>

    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:16px;">
      <p style="font-size:13px; color:var(--text-secondary);">
        ${users ? users.length : 0} user(s). Roles: admin (full), editor (import/export/results), viewer (read-only).
      </p>
      <button class="btn btn-primary" onclick="window._userAdd()">
        <i class="material-icons">person_add</i> Add User
      </button>
    </div>

    ${error ? `<div class="card" style="padding:16px; margin-bottom:12px; border-left:3px solid var(--warning); background:var(--warning-bg); color:var(--warning-text); font-size:13px;">
      <strong>Cannot read users:</strong> ${error.message}<br><br>
      ${error.message.includes('row-level security') || error.message.includes('policy')
        ? `<strong>First admin must be seeded via SQL.</strong> Run this in Supabase SQL Editor:<br>
           <code style="display:block; margin-top:6px; padding:8px; background:var(--bg-card); border-radius:4px; font-size:12px; color:var(--text-primary);">
             INSERT INTO rdms_users (email, role, display_name)<br>
             VALUES ('your-email@example.com', 'admin', 'Your Name');
           </code><br>
           After seeding, log in via the web version to manage users.`
        : 'Make sure the rdms_users table exists in Supabase (run 001_init.sql).'}
    </div>` : ''}

    <div class="card" style="padding:0; overflow:auto;">
      <table class="race-table">
        <thead>
          <tr>
            <th>Username</th>
            <th>Display Name</th>
            <th>Role</th>
            <th>Default Mode</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${(users || []).map(u => {
            const username = u.username || emailToUsername(u.email) || u.email;
            const mode = u.default_mode || (u.role === 'admin' ? 'finish' : 'dashboard');
            return `
            <tr>
              <td>${username}</td>
              <td>${u.display_name || '—'}</td>
              <td>
                <span class="badge ${u.role === 'admin' ? 'badge-sent' : u.role === 'editor' ? 'badge-started' : 'badge-pending'}">
                  ${u.role}
                </span>
              </td>
              <td style="font-size:12px;">${mode}</td>
              <td style="font-size:12px; color:var(--text-tertiary);">${u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
              <td>
                <button class="btn btn-ghost" style="padding:2px 8px; font-size:12px;"
                        onclick='window._userEdit(${JSON.stringify({ id: u.id, email: u.email, username, role: u.role, display_name: u.display_name || "", default_mode: mode }).replace(/'/g, "&apos;")})'>Edit</button>
                <button class="btn btn-ghost" style="padding:2px 8px; font-size:12px; color:var(--danger);"
                        onclick="window._userDelete('${u.id}', '${username}')">Delete</button>
              </td>
            </tr>`;
          }).join('') || '<tr><td colspan="6" style="text-align:center; color:var(--text-tertiary); padding:20px;">No users. Click "Add User" to create one.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div style="margin-top:16px; padding:12px 16px; background:var(--info-bg); border-radius:var(--radius-md); font-size:12px; color:var(--info-text);">
      <strong>Note:</strong> Users must also exist in Supabase Auth (email + password).
      Create them in the <a href="${supabaseRef?.supabaseUrl || '#'}/auth/users" target="_blank" style="color:var(--accent);">Supabase Dashboard → Authentication</a> first, then assign roles here.
    </div>
  `;

  window._userAdd = () => showUserModal(null, container);
  // _userEdit now takes a full record so we don't have to encode every
  // field positionally in the HTML attribute (which broke when display
  // names contained quotes).
  window._userEdit = (record) => showUserModal(record, container);
  window._userDelete = async (id, username) => {
    if (!confirm(`Remove ${username} from RDMS users? (This does NOT delete their Supabase Auth account.)`)) return;
    await supabaseRef.from('rdms_users').delete().eq('id', id);
    showToast(`User ${username} removed`, 'info');
    await renderUserList(container);
  };
}

function showUserModal(existingUser, listContainer) {
  const isNew = !existingUser;
  const u = existingUser || {
    email: '', username: '', role: 'viewer', display_name: '', default_mode: '',
  };

  const modeOptions = DEFAULT_MODES
    .map(m => `<option value="${m.value}" ${u.default_mode === m.value ? 'selected' : ''}>${m.label}</option>`)
    .join('');

  const modal = document.createElement('div');
  modal.id = 'userModal';
  modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9998; display:flex; align-items:center; justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:24px; max-width:420px; width:90%; box-shadow:var(--shadow-lg);">
      <h5 style="font-size:16px; font-weight:600; margin-bottom:16px;">${isNew ? 'Add' : 'Edit'} User</h5>

      <div class="form-group">
        <label class="form-label">Username</label>
        <input class="form-input" id="userUsername" type="text"
               value="${u.username || ''}"
               ${!isNew ? 'disabled style="opacity:0.6;"' : ''}
               autocapitalize="none" autocorrect="off" spellcheck="false"
               placeholder="e.g. john">
        ${isNew
          ? `<small style="color:var(--text-tertiary); font-size:11px;">
              Stored in Supabase Auth as <code>&lt;username&gt;${USERNAME_SUFFIX}</code>.
              You must also create the matching account in
              <a href="${supabaseRef?.supabaseUrl || '#'}/auth/users" target="_blank" style="color:var(--accent);">Supabase Auth</a>
              with that exact email and the user's initial password.
            </small>`
          : ''}
      </div>

      <div class="form-group">
        <label class="form-label">Display Name</label>
        <input class="form-input" id="userName" type="text" value="${(u.display_name || '').replace(/"/g, '&quot;')}" placeholder="e.g. John">
      </div>

      <div class="form-group">
        <label class="form-label">Role</label>
        <select class="form-select" id="userRole">
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin — full access</option>
          <option value="editor" ${u.role === 'editor' ? 'selected' : ''}>Editor — import, export, results input</option>
          <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Viewer — read-only</option>
        </select>
      </div>

      <div class="form-group">
        <label class="form-label">Default Mode (landing page)</label>
        <select class="form-select" id="userDefaultMode">
          <option value="">— Auto (admin→finish, others→dashboard)</option>
          ${modeOptions}
        </select>
        <small style="color:var(--text-tertiary); font-size:11px;">
          Which RDMS page this user lands on after login. Editors/viewers will be
          bounced back to dashboard if the chosen page isn't permitted for their role.
        </small>
      </div>

      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:20px;">
        <button class="btn btn-ghost" onclick="document.getElementById('userModal').remove()">Cancel</button>
        <button class="btn btn-primary" id="userSaveBtn">${isNew ? 'Add' : 'Save'}</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#userSaveBtn').addEventListener('click', async () => {
    const username = document.getElementById('userUsername').value.trim().toLowerCase();
    const displayName = document.getElementById('userName').value.trim();
    const role = document.getElementById('userRole').value;
    const defaultMode = document.getElementById('userDefaultMode').value || null;

    if (!username) { showToast('Username is required', 'error'); return; }
    if (!/^[a-z0-9._-]+$/i.test(username)) {
      showToast('Username may only contain letters, digits, dot, dash, underscore.', 'error', 4500);
      return;
    }

    const email = isNew ? `${username}${USERNAME_SUFFIX}` : u.email;
    const record = {
      email,
      username,
      role,
      display_name: displayName,
      default_mode: defaultMode,
      updated_at: new Date().toISOString(),
    };

    if (isNew) {
      record.created_at = new Date().toISOString();
      const { error } = await supabaseRef.from('rdms_users').insert(record);
      if (error) { showToast(`Error: ${error.message}`, 'error'); return; }
    } else {
      const { error } = await supabaseRef.from('rdms_users').update(record).eq('id', u.id);
      if (error) { showToast(`Error: ${error.message}`, 'error'); return; }
    }

    modal.remove();
    showToast(`User ${username} ${isNew ? 'added' : 'updated'} as ${role}`, 'success');
    await renderUserList(listContainer);
  });
}
