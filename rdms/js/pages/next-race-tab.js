/**
 * SDBA RDMS — Next Race Tab (within Setup)
 *
 * Manual override panel for the public mobile app's "Next Race" display.
 * Fires the same Lambda endpoint used by the auto-signal flow, but does NOT
 * touch any race row — no next_race_signaled flip, no IndexedDB writes.
 *
 * Intended use: race control needs to override the auto-tracked "Next up"
 * (e.g. announce a contingency race, jump ahead, manual recovery after a
 * skipped race). Keeps the dashboard's tracking logic untouched.
 */
import { getConfig, getAllRaces } from '../db.js';
import { showToast } from '../utils.js';

export async function renderNextRaceTab(container) {
  const config = await getConfig() || {};
  const apiUrl = config.next_race_signal_api || '';
  const races = (await getAllRaces()).sort((a, b) => a.race_number - b.race_number);
  const defaultRacename = config.next_race_signal_racename || 'shortcourse';

  container.innerHTML = `
    <div class="card" style="margin-top:16px; max-width:680px;">
      <div class="section-header">Manual Next Race Override</div>
      <p style="font-size:13px; color:var(--text-secondary); margin-bottom:14px;">
        Fires the Lambda used by the public mobile app to display the next race.
        <strong>Does not affect</strong> the dashboard's automatic "Next up" tracking
        — use this only for manual overrides (contingency, skip-ahead, recovery).
      </p>

      ${!apiUrl ? `
        <div style="background:rgba(245,158,11,0.12); border:1px solid var(--warning);
                    border-radius:var(--radius-sm); padding:10px 14px; font-size:12px; margin-bottom:14px;">
          <strong>Next Race Signal API</strong> is not configured (see Event tab → Integrations).
          The fire button will be disabled until the Lambda URL is set.
        </div>` : ''}

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:14px;">
        <div class="form-group">
          <label class="form-label">Race Number</label>
          <select class="form-select" id="nrtRaceNumberSel"
                  style="font-family:monospace;">
            <option value="">— Select race —</option>
            ${races.map(r => `
              <option value="${r.race_number}">
                ${r.race_number} — ${(r.race_title || 'Untitled').replace(/"/g, '&quot;')}
              </option>`).join('')}
          </select>
          <small style="color:var(--text-tertiary); font-size:11px;">
            Or use the manual entry below if the race isn't in the loaded set.
          </small>
        </div>

        <div class="form-group">
          <label class="form-label">Manual Race # <span style="color:var(--text-tertiary); font-weight:400;">— overrides dropdown</span></label>
          <input class="form-input" id="nrtRaceNumberManual" type="number" min="1" max="999"
                 placeholder="e.g. 42" style="font-family:monospace;">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Race Name Param</label>
        <select class="form-select" id="nrtRacenameSel"
                onchange="var o=document.getElementById('nrtRacenameCustom');
                          o.style.display=this.value==='_custom'?'block':'none';
                          if(this.value!=='_custom')o.value='';">
          <option value="warmup" ${defaultRacename === 'warmup' ? 'selected' : ''}>warmup</option>
          <option value="warmup2" ${defaultRacename === 'warmup2' ? 'selected' : ''}>warmup2</option>
          <option value="shortcourse" ${defaultRacename === 'shortcourse' ? 'selected' : ''}>shortcourse</option>
          <option value="main" ${defaultRacename === 'main' ? 'selected' : ''}>main</option>
          <option value="_custom">Other…</option>
        </select>
        <input class="form-input" id="nrtRacenameCustom" type="text"
               placeholder="custom racename" style="margin-top:6px; display:none;">
        <small style="color:var(--text-tertiary); font-size:11px;">
          Sent as <code>racename=</code> in the URL.
          Default from Event config: <strong>${defaultRacename}</strong>.
        </small>
      </div>

      <div style="margin-top:18px; display:flex; gap:10px; align-items:center;">
        <button class="btn btn-primary" id="nrtFireBtn" ${!apiUrl ? 'disabled' : ''}
                onclick="window._nrtFire()">
          <i class="material-icons">cell_tower</i> Fire Signal
        </button>
        <div id="nrtLastFire" style="font-size:12px; color:var(--text-tertiary);"></div>
      </div>

      <details style="margin-top:18px;">
        <summary style="cursor:pointer; font-size:12px; font-weight:600;
                        text-transform:uppercase; letter-spacing:0.5px;
                        color:var(--text-tertiary); user-select:none;">
          What this does
        </summary>
        <div style="font-size:12px; color:var(--text-secondary); margin-top:8px; line-height:1.55;">
          Sends a GET request:<br>
          <code style="font-size:11px;">
            ${apiUrl || '(Lambda URL not configured)'}?raceno=<em>N</em>&amp;racename=<em>name</em>&amp;racetype=next
          </code>
          <br><br>
          The mobile app polls this Lambda's stored value and updates its
          "next race" banner. Repeat fires are fine — same race number is
          idempotent at the Lambda side. Race row's <code>next_race_signaled</code>
          flag is NOT touched here, so auto-signal continues to operate
          normally during the next race's lifecycle.
        </div>
      </details>
    </div>
  `;

  window._nrtFire = async () => {
    const manual = document.getElementById('nrtRaceNumberManual').value.trim();
    const fromSel = document.getElementById('nrtRaceNumberSel').value;
    const raceno = manual || fromSel;
    if (!raceno || isNaN(parseInt(raceno, 10))) {
      showToast('Pick a race number (or enter one manually).', 'warning', 3500);
      return;
    }

    const sel = document.getElementById('nrtRacenameSel').value;
    const racename = sel === '_custom'
      ? document.getElementById('nrtRacenameCustom').value.trim()
      : sel;
    if (!racename) {
      showToast('Race name param required.', 'warning', 3500);
      return;
    }

    const cfg = await getConfig();
    const url = cfg?.next_race_signal_api;
    if (!url) {
      showToast('Next Race Signal API not configured.', 'error', 4000);
      return;
    }

    const fullUrl = `${url}?raceno=${encodeURIComponent(raceno)}&racename=${encodeURIComponent(racename)}&racetype=next`;
    try {
      await fetch(fullUrl, { method: 'GET', mode: 'no-cors' });
      const stamp = new Date().toLocaleTimeString();
      document.getElementById('nrtLastFire').textContent =
        `Last fire: race ${raceno} (${racename}) at ${stamp}`;
      showToast(`Signal fired: race ${raceno} (${racename})`, 'success', 3500);
    } catch (err) {
      showToast(`Signal fire failed: ${err.message || err}`, 'error', 4500);
    }
  };
}

export function cleanupNextRaceTab() {
  delete window._nrtFire;
}
