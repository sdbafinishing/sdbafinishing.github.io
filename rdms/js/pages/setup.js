/**
 * SDBA RDMS — Setup Page
 * Event config, division management, race schedule.
 * Naming aligned with SDBA-RMS: event = the race day, race = each numbered race.
 */
import { getConfig, saveConfig } from '../db.js';
import { showToast } from '../utils.js';
import { broadcastChange } from '../app.js';
import { requestSourceFolder, isSourceConnected } from '../file-access.js';
import { renderDivisionsTab, cleanupDivisionHandlers } from './division-config.js';
import { renderScheduleTab, cleanupScheduleHandlers } from './schedule-tab.js';
import { renderNextRaceTab, cleanupNextRaceTab } from './next-race-tab.js';
import { renderUsersTab, cleanupUsersTab } from './users-page.js';
import { renderUserGuideTab } from './user-guide.js';
import { hasPermission } from '../rbac.js';

export async function mountSetup(container) {
  // Tab-level gating. Admins see everything; editors see the Next Race
  // manual-fire tab + User Guide; viewers (if they somehow reach this
  // page — they shouldn't) see User Guide only.
  const canConfig    = hasPermission('setup.tab.config');
  const canDivisions = hasPermission('setup.tab.divisions');
  const canSchedule  = hasPermission('setup.tab.schedule');
  const canNextRace  = hasPermission('setup.tab.next_race');
  const canUsers     = hasPermission('setup.tab.users');
  const canGuide     = hasPermission('setup.tab.guide');
  const isAdmin      = canConfig; // legacy alias for the page title

  // Pick the first tab the user can access as the default.
  const firstTab = canConfig ? 'config'
                 : canDivisions ? 'divisions'
                 : canSchedule ? 'schedule'
                 : canNextRace ? 'next-race'
                 : canUsers ? 'users'
                 : 'guide';

  container.innerHTML = `
    <div id="setupPage">
      <h4 style="font-size:18px; font-weight:600; margin-bottom:16px;">${isAdmin ? 'Event Setup' : 'Event Tools'}</h4>
      <div class="tabs">
        ${canConfig    ? `<button class="tab ${firstTab === 'config' ? 'active' : ''}" data-tab="config" onclick="window._setupTab('config')">Event</button>` : ''}
        ${canDivisions ? `<button class="tab ${firstTab === 'divisions' ? 'active' : ''}" data-tab="divisions" onclick="window._setupTab('divisions')">Divisions</button>` : ''}
        ${canSchedule  ? `<button class="tab ${firstTab === 'schedule' ? 'active' : ''}" data-tab="schedule" onclick="window._setupTab('schedule')">Schedule</button>` : ''}
        ${canNextRace  ? `<button class="tab ${firstTab === 'next-race' ? 'active' : ''}" data-tab="next-race" onclick="window._setupTab('next-race')">Next Race</button>` : ''}
        ${canUsers     ? `<button class="tab ${firstTab === 'users' ? 'active' : ''}" data-tab="users" onclick="window._setupTab('users')">Users</button>` : ''}
        ${canGuide     ? `<button class="tab ${firstTab === 'guide' ? 'active' : ''}" data-tab="guide" onclick="window._setupTab('guide')">User Guide</button>` : ''}
      </div>
      <div id="setupTabContent"></div>
    </div>
  `;

  window._setupTab = (tabName) => {
    // Defensive: ignore clicks on tabs the user shouldn't have access to.
    // Tabs are already filtered above, but a stale `onclick` from a prior
    // render could leak through during permission downgrade.
    const permKey = tabName === 'next-race' ? 'setup.tab.next_race' : `setup.tab.${tabName}`;
    if (!hasPermission(permKey)) return;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    renderTab(tabName);
  };

  renderTab(firstTab);
}

export function unmountSetup() {
  delete window._setupTab;
  delete window._saveConfig;
  delete window._generateBlank;
  delete window._resetEvent;
  cleanupDivisionHandlers();
  cleanupScheduleHandlers();
  cleanupNextRaceTab();
  cleanupUsersTab();
}

async function renderTab(tabName) {
  const content = document.getElementById('setupTabContent');
  if (!content) return;

  if (tabName === 'config') {
    await renderConfigTab(content);
  } else if (tabName === 'divisions') {
    await renderDivisionsTab(content);
  } else if (tabName === 'schedule') {
    await renderScheduleTab(content);
  } else if (tabName === 'next-race') {
    await renderNextRaceTab(content);
  } else if (tabName === 'users') {
    await renderUsersTab(content);
  } else if (tabName === 'guide') {
    renderUserGuideTab(content);
  }
}

async function renderConfigTab(container) {
  const c = await getConfig() || {};

  container.innerHTML = `
    <div class="card" style="margin-top:16px; max-width:700px;">

      <!-- Event Details (aligns with SDBA-RMS annual_event_config) -->
      <div class="section-header">Event Details</div>

      <!-- Existing short name kept exactly as-is — used internally
           throughout RDMS (page titles, status lines, etc.). -->
      <div class="form-group">
        <label class="form-label">Event Name</label>
        <input class="form-input" id="cfgEventName" type="text"
               placeholder="e.g. Tuen Ng Championships 2026"
               value="${c.event_long_name_en || ''}">
        <small style="color:var(--text-tertiary); font-size:11px;">Used as the in-app short label.</small>
      </div>

      <!-- Optional long names. Only surface on the photo-finish export — if
           blank the export falls back to "Event Name" above, then to the
           short ref. Mirrors SDBA-RMS annual_event_config naming. -->
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
        <div class="form-group">
          <label class="form-label">Event Official Name (English) <span style="color:var(--text-tertiary); font-weight:400;">— optional</span></label>
          <input class="form-input" id="cfgEventOfficialEn" type="text"
                 placeholder="e.g. 2026 SDBA Tuen Ng Dragon Boat Championships"
                 value="${c.event_official_name_en || ''}">
          <small style="color:var(--text-tertiary); font-size:11px;">Long English name printed on photo-finish exports.</small>
        </div>
        <div class="form-group">
          <label class="form-label">Event Official Name (中文) <span style="color:var(--text-tertiary); font-weight:400;">— optional</span></label>
          <input class="form-input" id="cfgEventOfficialTc" type="text"
                 placeholder="e.g. 2026 SDBA 端午龍舟錦標賽"
                 value="${c.event_official_name_tc || ''}">
          <small style="color:var(--text-tertiary); font-size:11px;">Long Traditional Chinese name on photo-finish exports.</small>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:16px;">
        <div class="form-group">
          <label class="form-label">Event Short Ref</label>
          <input class="form-input" id="cfgEventRef" type="text" placeholder="e.g. 2026TN"
                 value="${c.event_short_ref || ''}">
          <small style="color:var(--text-tertiary); font-size:11px;">Same as SDBA-RMS event_short_ref</small>
        </div>
        <div class="form-group">
          <label class="form-label">Event Type</label>
          <input class="form-input" id="cfgEventType" type="text" placeholder="e.g. TN"
                 value="${c.event_type || ''}">
          <small style="color:var(--text-tertiary); font-size:11px;">Maps to event_type_short_code_general</small>
        </div>
        <div class="form-group">
          <label class="form-label">Event Date (YYYYMMDD)</label>
          <input class="form-input" id="cfgEventDate" type="text" placeholder="e.g. 20260531" maxlength="8"
                 value="${c.race_date || ''}">
        </div>
      </div>

      <div style="display:grid; grid-template-columns:auto 1fr 1fr 1fr; gap:16px; align-items:end;">
        <div class="form-group">
          <label class="form-label">Event Colour</label>
          <div style="display:flex; align-items:center; gap:6px;">
            <input type="color" id="cfgEventColourPicker" value="${c.event_colour_code_hex || '#08394c'}"
                   style="width:36px; height:36px; border:1px solid var(--border); border-radius:var(--radius-sm); cursor:pointer; padding:2px;"
                   oninput="document.getElementById('cfgEventColourHex').value=this.value">
            <input class="form-input" id="cfgEventColourHex" type="text" maxlength="7"
                   placeholder="#08394c" value="${c.event_colour_code_hex || '#08394c'}"
                   style="width:90px; font-family:monospace; font-size:13px;"
                   oninput="if(/^#[0-9A-Fa-f]{6}$/.test(this.value))document.getElementById('cfgEventColourPicker').value=this.value">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Number of Lanes</label>
          <select class="form-select" id="cfgLaneCount">
            ${Array.from({length: 13}, (_, i) => i + 1).map(n =>
              `<option value="${n}" ${(c.lane_count || 6) === n ? 'selected' : ''}>${n}</option>`
            ).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Time Format</label>
          <select class="form-select" id="cfgTimeFormat">
            <option value="mss00" ${(c.time_format_mode || 'mss00') === 'mss00' ? 'selected' : ''}>mss00 (0:55.91)</option>
            <option value="mmss00" ${c.time_format_mode === 'mmss00' ? 'selected' : ''}>mmss00 (12:55.91)</option>
          </select>
        </div>
      </div>

      <!-- Scoring (after event details, before folder paths) -->
      <div class="section-header" style="margin-top:20px;">Scoring</div>

      <div class="form-group">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" id="cfgScoring" ${(c.scoring_exported ?? c.scoring_enabled) ? 'checked' : ''}>
          <span style="font-size:14px;">Export scoring results</span>
        </label>
        <small style="color:var(--text-tertiary); font-size:11px; margin-top:4px; display:block;">
          When checked, the per-race export also writes a scoring file alongside the result.
          Scoring is always calculated in-app (Scoring tab) regardless of this setting —
          this flag controls whether the scoring output is written out to the results folder.
          Configure scoring rounds in the Divisions tab.
        </small>
      </div>

      <div class="form-group">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" id="cfgNextRoundDraws" ${c.next_round_draw_enabled ? 'checked' : ''}>
          <span style="font-size:14px;">Auto-prompt to generate next round draws</span>
        </label>
        <small style="color:var(--text-tertiary); font-size:11px; margin-top:4px; display:block;">
          When checked, RDMS prompts to resolve next-round R{n}P{n} placeholders
          automatically after every race in a round is exported.
          Manual generation is always available from
          <a href="#/import" style="color:var(--accent);">Im/Export → Generate Next Round Draws</a>
          regardless of this setting.
        </small>
      </div>

      <div class="form-group">
        <label style="display:flex; align-items:center; gap:8px; cursor:pointer;">
          <input type="checkbox" id="cfgAutoStartList" ${c.auto_start_list_on_import ? 'checked' : ''}>
          <span style="font-size:14px;">Auto-generate Joyi start list after draw import</span>
        </label>
        <small style="color:var(--text-tertiary); font-size:11px; margin-top:4px; display:block;">
          When checked, RDMS regenerates the Joyi start list automatically after
          every draw import (manual or from <code>01 Input_Draw/</code>). The file
          lands in <code>11 Output_Start Lists/</code> + the shared <code>{ref}_Joyi/</code>
          folder so the Joyi camera laptop sees the updated start list without
          a separate click.
        </small>
      </div>

      <!-- Folder Paths -->
      <div class="section-header" style="margin-top:20px;">Folder Paths</div>

      <div class="form-group">
        <label class="form-label">Event Folder (Local / Drive synced) <span style="color:var(--danger);">*</span></label>
        <input class="form-input" id="cfgSourceFolder" type="text"
               placeholder="e.g. /Users/me/Google Drive/Events/2026TN/"
               value="${c.source_folder || ''}">
        <small style="color:var(--text-tertiary); font-size:11px;">
          Master event folder. Contains: 01 Input_Draw/, 11 Output_Start Lists/,
          12 Output_Results/, 13 Output_Next Round Draws/, 20 Database Backup/
        </small>
        <!-- Inline connect button — same flow as the navbar folder icon
             but reachable while editing config, so an admin can attach
             the folder without leaving this tab. The label reflects
             current connection state. -->
        <div style="margin-top:8px; display:flex; align-items:center; gap:10px;">
          <button class="btn btn-outline" type="button" id="cfgConnectSourceBtn">
            <i class="material-icons" style="font-size:16px;">folder_open</i>
            <span id="cfgConnectSourceLabel">Connect event folder</span>
          </button>
          <small id="cfgConnectSourceStatus" style="font-size:11px; color:var(--text-tertiary);">
            Pick the root event folder (e.g. <code>2026TN/</code>) — RDMS finds the
            <code>01 Input_Draw/</code>, <code>12 Output_Results/</code>, etc. subfolders inside it.
          </small>
        </div>
      </div>

      <div class="section-header" style="margin-top:16px;">Shared Folder Paths (for external parties)</div>
      <p style="font-size:12px; color:var(--text-tertiary); margin-bottom:8px;">
        Google Drive shared folder paths. Files are written to both the local subfolder and the corresponding shared folder.
        Leave blank if not sharing externally.
      </p>

      <div class="form-group">
        <label class="form-label">Shared Results Folder <span style="color:var(--danger);">*</span></label>
        <input class="form-input" id="cfgSharedResults" type="text"
               placeholder="e.g. /Users/me/Google Drive/Shared/2026TN_Output_Results/"
               value="${c.shared_results_folder || ''}">
        <small style="color:var(--text-tertiary); font-size:11px;">Exported results for scoring team / public. Use local synced path OR Google Drive shared link (URL used in WhatsApp messages).</small>
      </div>

      <div class="form-group">
        <label class="form-label">Shared Next Round Draws Folder <span style="color:var(--text-tertiary);">optional</span></label>
        <input class="form-input" id="cfgSharedDraws" type="text"
               placeholder="e.g. /Users/me/Google Drive/Shared/2026TN_Next_Round_Draws/"
               value="${c.shared_draws_folder || ''}">
        <small style="color:var(--text-tertiary); font-size:11px;">Generated next-round draws written here for scoring team</small>
      </div>

      <div class="form-group">
        <label class="form-label">Shared Joyi Folder <span style="color:var(--text-tertiary);">optional — leave blank to disable Joyi import</span></label>
        <input class="form-input" id="cfgSharedJoyi" type="text"
               placeholder="e.g. /Users/me/Google Drive/Shared/2026TN_Joyi/"
               value="${c.shared_joyi_folder || ''}">
        <small style="color:var(--text-tertiary); font-size:11px;">Bidirectional: start lists written here, Joyi results read from here</small>
      </div>

      <!-- Communication (optional) -->
      <div class="section-header" style="margin-top:20px;">Communication <span style="font-weight:400; font-size:10px; color:var(--text-tertiary);">optional</span></div>

      <div class="form-group">
        <label class="form-label">WhatsApp Group Name <span style="color:var(--text-tertiary);">optional — leave blank to disable Send button</span></label>
        <input class="form-input" id="cfgWhatsApp" type="text"
               placeholder="e.g. SDBA Results Group"
               value="${c.whatsapp_group || ''}">
      </div>

      <!-- Integrations (optional) -->
      <div class="section-header" style="margin-top:20px;">Integrations <span style="font-weight:400; font-size:10px; color:var(--text-tertiary);">optional</span></div>

      <div style="display:grid; grid-template-columns:2fr 1fr; gap:12px;">
        <div class="form-group">
          <label class="form-label">Next Race Signal API (optional)</label>
          <input class="form-input" id="cfgNextRaceApi" type="text"
                 placeholder="e.g. https://...lambda-url.ap-east-1.on.aws/"
                 value="${c.next_race_signal_api || ''}">
          <small style="color:var(--text-tertiary); font-size:11px;">Lambda URL — called automatically after export to signal next race. Leave blank to disable.</small>
        </div>
        <div class="form-group">
          <label class="form-label">Race Name Param</label>
          <select class="form-select" id="cfgNextRaceRacenameSelect"
                  onchange="var o=document.getElementById('cfgNextRaceRacenameCustom');o.style.display=this.value==='_custom'?'block':'none';if(this.value!=='_custom')o.value='';">
            <option value="" ${!c.next_race_signal_racename ? 'selected' : ''}>— Select —</option>
            <option value="warmup" ${c.next_race_signal_racename === 'warmup' ? 'selected' : ''}>warmup</option>
            <option value="warmup2" ${c.next_race_signal_racename === 'warmup2' ? 'selected' : ''}>warmup2</option>
            <option value="shortcourse" ${c.next_race_signal_racename === 'shortcourse' ? 'selected' : ''}>shortcourse</option>
            <option value="main" ${c.next_race_signal_racename === 'main' ? 'selected' : ''}>main</option>
            <option value="_custom" ${c.next_race_signal_racename && !['warmup','warmup2','shortcourse','main'].includes(c.next_race_signal_racename) ? 'selected' : ''}>Other...</option>
          </select>
          <input class="form-input" id="cfgNextRaceRacenameCustom" type="text"
                 placeholder="Enter custom race name"
                 value="${c.next_race_signal_racename && !['warmup','warmup2','shortcourse','main'].includes(c.next_race_signal_racename) ? c.next_race_signal_racename : ''}"
                 style="margin-top:6px; display:${c.next_race_signal_racename && !['warmup','warmup2','shortcourse','main'].includes(c.next_race_signal_racename) ? 'block' : 'none'};">
          <small style="color:var(--text-tertiary); font-size:11px;">Passed as racename= in the API call</small>
        </div>
      </div>

      <!-- Sync (Supabase) -->
      <div class="section-header" style="margin-top:20px;">Live Sync <span style="font-weight:400; font-size:10px; color:var(--text-tertiary);">optional</span></div>
      <p style="font-size:12px; color:var(--text-tertiary); margin-bottom:8px;">
        Connect to Supabase for live dashboard, remote web access, and RBAC. Leave blank to disable.
      </p>
      <div class="form-group">
        <label class="form-label">Supabase URL</label>
        <input class="form-input" id="cfgSupabaseUrl" type="text"
               placeholder="e.g. https://abc123.supabase.co"
               value="${c.supabase_url || ''}">
      </div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div class="form-group">
          <label class="form-label">Anon Key (public, for web users)</label>
          <input class="form-input" id="cfgSupabaseKey" type="text"
                 placeholder="eyJ..."
                 value="${c.supabase_anon_key || ''}"
                 style="font-family:monospace; font-size:11px;">
        </div>
        <div class="form-group">
          <label class="form-label">Service Role Key (local admin only)</label>
          <input class="form-input" id="cfgSupabaseServiceKey" type="password"
                 placeholder="eyJ..."
                 value="${c.supabase_service_key || ''}"
                 style="font-family:monospace; font-size:11px;">
          <small style="color:var(--danger); font-size:11px;">Secret — never expose in web builds. Used locally to bypass RLS for user management.</small>
        </div>
      </div>

      <!-- Google Drive API (for web version) -->
      <div class="section-header" style="margin-top:20px;">Google Drive API <span style="font-weight:400; font-size:10px; color:var(--text-tertiary);">optional — web version only</span></div>
      <p style="font-size:12px; color:var(--text-tertiary); margin-bottom:8px;">
        For web-hosted version only. Enables file read/write via Google Drive API when File System Access is unavailable.
        Create an OAuth Client ID at <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color:var(--accent);">Google Cloud Console</a>.
      </p>
      <div style="display:grid; grid-template-columns:2fr 1fr; gap:12px;">
        <div class="form-group">
          <label class="form-label">Google OAuth Client ID</label>
          <input class="form-input" id="cfgGoogleClientId" type="text"
                 placeholder="e.g. 123456789.apps.googleusercontent.com"
                 value="${c.google_client_id || ''}"
                 style="font-family:monospace; font-size:11px;">
        </div>
        <div class="form-group">
          <label class="form-label">Drive Source Folder ID</label>
          <input class="form-input" id="cfgDriveFolderId" type="text"
                 placeholder="Folder ID from Drive URL"
                 value="${c.drive_source_folder_id || ''}"
                 style="font-family:monospace; font-size:11px;">
          <small style="color:var(--text-tertiary); font-size:11px;">From the URL: drive.google.com/drive/folders/<strong>THIS_PART</strong></small>
        </div>
      </div>

      <div style="margin-top:20px; display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
        <button class="btn btn-primary" onclick="window._saveConfig()">
          <i class="material-icons">save</i> Save Configuration
        </button>

        <div style="margin-left:auto; display:flex; gap:8px;">
          <button class="btn btn-outline" onclick="window._generateBlank()">
            <i class="material-icons">grid_on</i> Generate Blank Races
          </button>
          <button class="btn btn-danger" style="font-size:12px;" onclick="window._resetEvent()">
            <i class="material-icons">restart_alt</i> New Event
          </button>
        </div>
      </div>
    </div>
  `;

  // Connect-source-folder handler. Mirrors the navbar folder icon flow.
  // Updates the button label + status text live so the operator can tell
  // whether the connection succeeded without checking elsewhere.
  const cfgConnectBtn   = document.getElementById('cfgConnectSourceBtn');
  const cfgConnectLabel = document.getElementById('cfgConnectSourceLabel');
  const cfgConnectStat  = document.getElementById('cfgConnectSourceStatus');
  const refreshConnectState = () => {
    if (!cfgConnectBtn || !cfgConnectLabel || !cfgConnectStat) return;
    if (isSourceConnected()) {
      cfgConnectLabel.textContent = 'Reconnect event folder';
      cfgConnectStat.innerHTML = `
        <span style="color:var(--success);">✓ Connected</span> — RDMS can read/write
        directly to <code>01 Input_Draw/</code>, <code>12 Output_Results/</code>, etc.
      `;
    } else {
      cfgConnectLabel.textContent = 'Connect event folder';
      cfgConnectStat.innerHTML = `
        Pick the root event folder (e.g. <code>${(c.event_short_ref || '2026XX')}/</code>) —
        RDMS finds the <code>01 Input_Draw/</code>, <code>12 Output_Results/</code>, etc.
        subfolders inside it.
      `;
    }
  };
  refreshConnectState();
  if (cfgConnectBtn) {
    cfgConnectBtn.addEventListener('click', async () => {
      const handle = await requestSourceFolder();
      if (handle) {
        showToast(`Event folder connected: ${handle.name}`, 'success', 3000);
      }
      refreshConnectState();
    });
  }

  window._saveConfig = async () => {
    const data = {
      event_long_name_en: document.getElementById('cfgEventName').value.trim(),
      event_official_name_en: document.getElementById('cfgEventOfficialEn').value.trim(),
      event_official_name_tc: document.getElementById('cfgEventOfficialTc').value.trim(),
      event_short_ref: document.getElementById('cfgEventRef').value.trim(),
      event_type: document.getElementById('cfgEventType').value.trim(),
      event_colour_code_hex: document.getElementById('cfgEventColourHex').value.trim() || '#08394c',
      race_date: document.getElementById('cfgEventDate').value.trim(),
      lane_count: parseInt(document.getElementById('cfgLaneCount').value, 10),
      time_format_mode: document.getElementById('cfgTimeFormat').value,
      source_folder: document.getElementById('cfgSourceFolder').value.trim(),
      shared_results_folder: document.getElementById('cfgSharedResults').value.trim(),
      shared_draws_folder: document.getElementById('cfgSharedDraws').value.trim(),
      shared_joyi_folder: document.getElementById('cfgSharedJoyi').value.trim(),
      supabase_url: document.getElementById('cfgSupabaseUrl').value.trim(),
      supabase_anon_key: document.getElementById('cfgSupabaseKey').value.trim(),
      supabase_service_key: document.getElementById('cfgSupabaseServiceKey').value.trim(),
      google_client_id: document.getElementById('cfgGoogleClientId').value.trim(),
      drive_source_folder_id: document.getElementById('cfgDriveFolderId').value.trim(),
      whatsapp_group: document.getElementById('cfgWhatsApp').value.trim(),
      next_race_signal_api: document.getElementById('cfgNextRaceApi').value.trim(),
      next_race_signal_racename: (() => {
        const sel = document.getElementById('cfgNextRaceRacenameSelect').value;
        if (sel === '_custom') return document.getElementById('cfgNextRaceRacenameCustom').value.trim();
        return sel;
      })(),
      // Renamed from scoring_enabled → scoring_exported (new semantics: gates
      // whether scoring file is written out, not whether the page is shown).
      scoring_exported: document.getElementById('cfgScoring').checked,
      next_round_draw_enabled: document.getElementById('cfgNextRoundDraws').checked,
      auto_start_list_on_import: document.getElementById('cfgAutoStartList').checked,
    };

    // Validate required fields
    const missing = [];
    if (!data.event_long_name_en) missing.push('Event Name');
    if (!data.event_short_ref) missing.push('Event Short Ref');
    if (!data.race_date) missing.push('Event Date');
    if (data.race_date && (data.race_date.length !== 8 || isNaN(data.race_date))) {
      missing.push('Event Date (must be YYYYMMDD)');
    }

    // Validate folder path format (must end with / or \)
    if (data.source_folder && !data.source_folder.endsWith('/') && !data.source_folder.endsWith('\\')) {
      missing.push('Source Folder must end with /');
    }

    if (missing.length > 0) {
      showToast(`Missing or invalid: ${missing.join(', ')}`, 'error', 5000);
      return;
    }

    await saveConfig(data);
    broadcastChange('config-updated');

    // Sync config to Supabase immediately (if configured)
    if (data.supabase_url && data.supabase_anon_key) {
      try {
        const { queueRaceSync } = await import('../sync.js');
        await queueRaceSync(-1); // -1 triggers event_config sync only
      } catch {}
    }

    showToast('Configuration saved', 'success');
  };

  window._generateBlank = async () => {
    const input = prompt('Enter total number of races (1-100):');
    if (!input) return;
    const count = parseInt(input, 10);
    if (isNaN(count) || count < 1 || count > 100) {
      showToast('Enter a number between 1 and 100', 'error');
      return;
    }
    const config = await getConfig();
    const laneCount = config?.lane_count || 6;
    if (!confirm(`Generate ${count} blank races with ${laneCount} lanes each?\nTeams will be named R{n}B{lane} (e.g. R1B1, R1B2...)`)) return;

    const { generateBlankRaces } = await import('../db.js');
    await generateBlankRaces(count, laneCount);
    broadcastChange('draw-imported');
    showToast(`Generated ${count} blank races`, 'success');
  };

  window._resetEvent = async () => {
    if (!confirm('Start a new event? This will clear ALL current data from the browser.')) return;
    if (!confirm('Have you backed up the current event? (Check 20 Database Backup/ folder)')) return;

    const { clearAllData } = await import('../db.js');
    await clearAllData();
    broadcastChange('config-updated');
    showToast('Database cleared. Configure your new event.', 'info');
    // Re-render the config tab
    const tabContent = document.getElementById('setupTabContent');
    if (tabContent) await renderConfigTab(tabContent);
  };
}
