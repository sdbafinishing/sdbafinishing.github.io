/**
 * SDBA RDMS — Event Lock
 *
 * One-shot mechanism for marking race day complete. Once locked, every
 * IndexedDB write in db.js refuses to proceed (assertNotLocked throws
 * EventLockedError), so a stray tab or accidental click can't clobber
 * the final state. Unlocking is an admin action gated by RBAC and a
 * type-the-event-ref confirmation.
 *
 * Persistence: the lock lives on the config record (`event_locked: bool`)
 * + an audit trail (`event_locked_at`, `event_locked_by`). Persists to
 * Supabase via the normal config sync so other authenticated devices
 * see the lock state on next refresh.
 *
 * UI surface:
 *   - Dashboard footer button: "Lock event" when not locked, "Unlock"
 *     when locked. Lock button only enabled once every race has reached
 *     a terminal state (exported/sent/cancelled).
 *   - Persistent banner at the top of every page when locked.
 */
import { db, getConfig, isEventLocked, getAllRaces } from './db.js';
import { showToast } from './utils.js';
import { broadcastChange } from './app.js';
import { hasPermission, getRole } from './rbac.js';
import { getCurrentUser, emailToUsername } from './auth.js';

/**
 * Are all races in a terminal state? Used to gate the lock button — we
 * don't want to lock mid-event by mistake. Terminal = exported/sent for
 * a race that ran, cancelled for one that didn't. A race still in
 * pending or started counts as in-flight.
 */
export async function isRaceDayComplete() {
  const races = await getAllRaces();
  if (races.length === 0) return false;
  return races.every(r => ['exported', 'sent', 'cancelled'].includes(r.status));
}

/**
 * Lock the event. Returns a structured result; caller decides how to
 * surface the outcome (toast / modal). Idempotent — re-locking is a
 * no-op and returns success.
 */
export async function lockEvent({ force = false } = {}) {
  if (!hasPermission('config.edit')) {
    return { success: false, reason: 'permission' };
  }
  if (!force && !(await isRaceDayComplete())) {
    return { success: false, reason: 'incomplete' };
  }

  const config = (await getConfig()) || {};
  // Bypass saveConfig's normal path since the lock write must still
  // succeed when the lock is already on (in case someone wants to refresh
  // the audit timestamp). saveConfig itself doesn't gate on lock, so this
  // is a straight put().
  config.event_locked = true;
  config.event_locked_at = new Date().toISOString();
  config.event_locked_by = currentActor();
  config.event_locked_role = getRole();
  config.id = 'event-config';
  config.updated_at = config.event_locked_at;
  await db.config.put(config);

  broadcastChange('config-updated');
  return { success: true };
}

/**
 * Unlock. Two-factor gate: admin RBAC + type-the-event-ref. The caller is
 * expected to have already collected the typed confirmation; this function
 * just flips the flag and writes an audit row.
 */
export async function unlockEvent() {
  if (!hasPermission('config.edit')) {
    return { success: false, reason: 'permission' };
  }
  const config = (await getConfig()) || {};
  config.event_locked = false;
  config.event_unlocked_at = new Date().toISOString();
  config.event_unlocked_by = currentActor();
  config.id = 'event-config';
  config.updated_at = config.event_unlocked_at;
  await db.config.put(config);
  broadcastChange('config-updated');
  return { success: true };
}

/**
 * Render a top-of-page banner whenever the event is locked. Idempotent —
 * call this from app.js after every navigation so it survives page swaps.
 */
export async function refreshLockBanner() {
  const locked = await isEventLocked();
  let banner = document.getElementById('rdmsLockBanner');
  if (!locked) {
    if (banner) banner.remove();
    return;
  }
  const config = await getConfig();
  const at  = config?.event_locked_at ? new Date(config.event_locked_at).toLocaleString() : '?';
  const by  = config?.event_locked_by || 'admin';
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'rdmsLockBanner';
    banner.style.cssText = `
      position:sticky; top:0; z-index:9000;
      background:rgba(245,158,11,0.18); border-bottom:2px solid var(--warning);
      color:var(--warning-text, var(--text-primary));
      font-size:13px; padding:6px 14px;
      display:flex; align-items:center; gap:10px;`;
    document.body.insertBefore(banner, document.body.firstChild);
  }
  const unlockBtn = hasPermission('config.edit')
    ? `<button class="btn btn-ghost btn-sm" style="margin-left:auto; color:var(--warning);"
              onclick="window._eventLockUnlock()">
         <i class="material-icons" style="font-size:14px;">lock_open</i> Unlock event
       </button>`
    : `<span style="margin-left:auto; font-size:11px; color:var(--text-tertiary);">
         Ask an admin to unlock.
       </span>`;
  banner.innerHTML = `
    <i class="material-icons" style="color:var(--warning);">lock</i>
    <strong>Event locked</strong>
    <span style="color:var(--text-secondary);">— sealed ${at} by ${escape(by)}. All writes refused until unlocked.</span>
    ${unlockBtn}
  `;

  // Wire the unlock handler once. We rebind on every refresh because the
  // banner element may have been replaced (e.g. on lock-banner re-render).
  window._eventLockUnlock = showUnlockModal;
}

/**
 * "Lock event" modal. Shown when the dashboard's Lock button is clicked.
 * Requires the operator to type the event short ref to confirm —
 * mirrors the Reset Race UX so destructive-feeling actions get the same
 * gate.
 */
export async function showLockModal() {
  if (!hasPermission('config.edit')) {
    showToast('Only admins can lock the event.', 'warning', 4000);
    return;
  }
  const config = await getConfig();
  const ref = (config?.event_short_ref || '').trim();
  const races = await getAllRaces();
  const remaining = races.filter(r => !['exported', 'sent', 'cancelled'].includes(r.status));
  const raceDayComplete = remaining.length === 0;

  const modal = document.createElement('div');
  modal.id = 'rdmsLockModal';
  modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9998; display:flex; align-items:center; justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:24px; max-width:460px; width:92%; box-shadow:var(--shadow-lg);">
      <h5 style="font-size:16px; font-weight:600; margin-bottom:10px;">
        <i class="material-icons" style="vertical-align:middle; color:var(--warning);">lock</i>
        Lock event "${escape(ref)}"
      </h5>
      <p style="font-size:13px; color:var(--text-secondary); margin-bottom:10px;">
        Marks race day complete. Once locked, no writes are allowed —
        race results, start times, configurations, exports are all frozen
        until an admin unlocks the event.
      </p>
      ${!raceDayComplete ? `
        <div style="padding:10px 12px; margin-bottom:12px; border-radius:var(--radius-sm); background:rgba(239,68,68,0.10); border:1px solid var(--danger); font-size:12px;">
          <strong style="color:var(--danger);">${remaining.length} race${remaining.length === 1 ? '' : 's'} not yet complete:</strong>
          ${remaining.slice(0, 8).map(r => `Race ${r.race_number} (${r.status})`).join(', ')}${remaining.length > 8 ? '…' : ''}
          <br><small style="color:var(--text-tertiary);">Locking now will block exporting these races. Continue only if you're sure.</small>
        </div>
      ` : ''}
      <label style="font-size:12px; color:var(--text-secondary); display:block; margin-bottom:6px;">
        Type the event short ref to confirm:
      </label>
      <input class="form-input" id="lockConfirmInput" type="text" placeholder="${escape(ref)}"
             autocapitalize="none" autocorrect="off" spellcheck="false"
             style="font-family:monospace; margin-bottom:14px;">
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button class="btn btn-ghost" id="lockCancel">Cancel</button>
        <button class="btn btn-danger" id="lockConfirm" disabled>
          <i class="material-icons">lock</i> Lock event
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  const input    = modal.querySelector('#lockConfirmInput');
  const confirmB = modal.querySelector('#lockConfirm');
  input.addEventListener('input', () => {
    confirmB.disabled = input.value.trim() !== ref;
  });
  modal.querySelector('#lockCancel').addEventListener('click', () => modal.remove());
  confirmB.addEventListener('click', async () => {
    confirmB.disabled = true;
    const r = await lockEvent({ force: !raceDayComplete });
    modal.remove();
    if (r.success) {
      showToast('Event locked. All writes are now refused.', 'warning', 5000);
      await refreshLockBanner();
    } else {
      showToast(`Lock failed: ${r.reason}`, 'error', 4000);
    }
  });
}

function showUnlockModal() {
  if (!hasPermission('config.edit')) {
    showToast('Only admins can unlock the event.', 'warning', 4000);
    return;
  }
  // Build inline since this is a smaller modal — no race-status banner
  // needed and fewer fields to manage.
  (async () => {
    const config = await getConfig();
    const ref = (config?.event_short_ref || '').trim();
    const modal = document.createElement('div');
    modal.id = 'rdmsUnlockModal';
    modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9998; display:flex; align-items:center; justify-content:center;';
    modal.innerHTML = `
      <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:24px; max-width:420px; width:92%; box-shadow:var(--shadow-lg);">
        <h5 style="font-size:16px; font-weight:600; margin-bottom:10px;">
          <i class="material-icons" style="vertical-align:middle; color:var(--warning);">lock_open</i>
          Unlock event "${escape(ref)}"
        </h5>
        <p style="font-size:13px; color:var(--text-secondary); margin-bottom:10px;">
          Unlocking re-enables all writes. The lock/unlock action is recorded
          in the config audit fields. Type the event short ref to confirm.
        </p>
        <input class="form-input" id="unlockInput" type="text" placeholder="${escape(ref)}"
               autocapitalize="none" autocorrect="off" spellcheck="false"
               style="font-family:monospace; margin-bottom:14px;">
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button class="btn btn-ghost" id="unlockCancel">Cancel</button>
          <button class="btn btn-primary" id="unlockConfirm" disabled>
            <i class="material-icons">lock_open</i> Unlock
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    const input = modal.querySelector('#unlockInput');
    const btn   = modal.querySelector('#unlockConfirm');
    input.addEventListener('input', () => { btn.disabled = input.value.trim() !== ref; });
    modal.querySelector('#unlockCancel').addEventListener('click', () => modal.remove());
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await unlockEvent();
      modal.remove();
      if (r.success) {
        showToast('Event unlocked. Writes re-enabled.', 'success', 3000);
        await refreshLockBanner();
      } else {
        showToast(`Unlock failed: ${r.reason}`, 'error', 4000);
      }
    });
  })();
}

function currentActor() {
  const user = getCurrentUser?.();
  if (user?.email) return emailToUsername(user.email);
  return 'local';
}

function escape(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
