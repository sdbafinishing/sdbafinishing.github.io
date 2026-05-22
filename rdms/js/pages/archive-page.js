/**
 * SDBA RDMS — Past Events Archive
 *
 * Lists every event in Supabase except the one currently loaded. Each row
 * shows event metadata + a link out to the event's Drive folder (when a
 * drive_source_folder_id was captured in that event's config snapshot).
 *
 * Selecting an event opens a results browser that pulls race_snapshots
 * filtered by the chosen event_ref — read-only, no edits, no sync.
 *
 * Gated by permission `page.archive` (admin + editor only).
 */
import { getConfig } from '../db.js';
import { timeToDisplay, showToast } from '../utils.js';

let supabaseRef = null; // shared between mount and inner navigation

// Lazy-load supabase client using the current configured URL/key. Mirrors
// sync.js getSupabase() but local to this module so we don't disturb the
// sync queue's client reference.
async function getSupabaseLocal() {
  const config = await getConfig();
  if (!config?.supabase_url || !config?.supabase_anon_key) return null;
  if (!window.supabase) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  if (!window.supabase) return null;
  return window.supabase.createClient(config.supabase_url, config.supabase_anon_key);
}

export async function mountArchivePage(container, params) {
  const config = await getConfig();
  const currentRef = (config?.event_short_ref || '').trim();

  if (!config?.supabase_url || !config?.supabase_anon_key) {
    container.innerHTML = `
      <div class="card" style="text-align:center; padding:40px;">
        <i class="material-icons" style="font-size:48px; color:var(--text-tertiary);">cloud_off</i>
        <h3 style="margin-top:12px;">Supabase not configured</h3>
        <p style="color:var(--text-tertiary);">
          Past Events archive reads from Supabase. Configure Supabase URL + Anon Key in
          <a href="#/setup">Setup → Live Sync</a> first.
        </p>
      </div>`;
    return;
  }

  // Route shape: #/archive  (list)  |  #/archive/<event_ref>  (results)
  const selectedRef = params && params[0] ? decodeURIComponent(params[0]) : null;

  supabaseRef = await getSupabaseLocal();
  if (!supabaseRef) {
    container.innerHTML = `
      <div class="card" style="text-align:center; padding:40px;">
        <i class="material-icons" style="font-size:48px; color:var(--danger);">cloud_off</i>
        <h3 style="margin-top:12px;">Couldn't reach Supabase</h3>
        <p style="color:var(--text-tertiary);">Check Supabase URL + Anon Key in Setup.</p>
      </div>`;
    return;
  }

  if (selectedRef) {
    await renderEventRaces(container, selectedRef);
  } else {
    await renderEventList(container, currentRef);
  }
}

export function unmountArchivePage() {
  supabaseRef = null;
}

async function renderEventList(container, currentRef) {
  container.innerHTML = `
    <h4 style="font-size:18px; font-weight:600; margin-bottom:8px;">Past Events</h4>
    <p style="font-size:13px; color:var(--text-secondary); margin-bottom:12px;">
      Read-only archive of events stored in Supabase. The currently loaded event
      (${currentRef || '—'}) is excluded.
    </p>
    <div class="card" id="archEventListCard" style="padding:0;">
      <div style="padding:20px; text-align:center; color:var(--text-tertiary);">
        <i class="material-icons" style="font-size:24px;">hourglass_top</i>
        <div style="margin-top:6px; font-size:13px;">Loading events…</div>
      </div>
    </div>
  `;

  let rows;
  try {
    const { data, error } = await supabaseRef
      .from('event_config')
      .select('event_ref, config, updated_at')
      .order('updated_at', { ascending: false });
    if (error) throw error;
    rows = data || [];
  } catch (err) {
    document.getElementById('archEventListCard').innerHTML = `
      <div style="padding:16px; color:var(--danger); font-size:13px;">
        Failed to load events: ${err.message || err}
      </div>`;
    return;
  }

  // Drop the current event.
  const past = rows.filter(r => (r.event_ref || '').trim() !== (currentRef || '').trim());

  if (past.length === 0) {
    document.getElementById('archEventListCard').innerHTML = `
      <div style="padding:24px; text-align:center; color:var(--text-tertiary);">
        No past events yet. Events appear here once they're synced to Supabase
        and a new event is set up locally.
      </div>`;
    return;
  }

  const driveUrl = (folderId) => folderId
    ? `https://drive.google.com/drive/folders/${folderId}`
    : null;

  document.getElementById('archEventListCard').innerHTML = `
    <table class="race-table" style="width:100%;">
      <thead>
        <tr>
          <th style="text-align:left; width:120px;">Ref</th>
          <th style="text-align:left;">Event Name</th>
          <th style="text-align:left; width:110px;">Date</th>
          <th style="text-align:center; width:90px;">Races</th>
          <th style="text-align:center; width:90px;">Exported</th>
          <th style="width:90px;"></th>
          <th style="width:130px;"></th>
        </tr>
      </thead>
      <tbody>
        ${past.map(r => {
          const cfg = r.config || {};
          const ref = (r.event_ref || '').trim();
          const name = (cfg.event_name || '—').replace(/"/g, '&quot;');
          const date = formatEventDate(cfg.event_date);
          const total = cfg.total_races ?? '—';
          const exp = cfg.exported_races ?? '—';
          const drive = driveUrl(cfg.drive_source_folder_id);
          const swatch = cfg.event_colour || '#9ca3af';
          return `
            <tr>
              <td>
                <span style="display:inline-block; width:8px; height:24px; border-radius:2px; background:${swatch}; margin-right:6px; vertical-align:middle;"></span>
                <strong>${ref}</strong>
              </td>
              <td>${name}</td>
              <td style="color:var(--text-secondary);">${date}</td>
              <td style="text-align:center;">${total}</td>
              <td style="text-align:center;">${exp}</td>
              <td>
                ${drive
                  ? `<a class="btn btn-ghost btn-sm" href="${drive}" target="_blank"
                        title="Open this event's Drive folder">
                       <i class="material-icons" style="font-size:14px;">folder_open</i> Drive
                     </a>`
                  : '<span style="font-size:11px; color:var(--text-tertiary);">no link</span>'}
              </td>
              <td>
                <a class="btn btn-outline btn-sm" href="#/archive/${encodeURIComponent(ref)}">
                  <i class="material-icons" style="font-size:14px;">visibility</i> Open
                </a>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function renderEventRaces(container, eventRef) {
  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
      <h4 style="font-size:18px; font-weight:600; margin:0;">Archive — ${eventRef}</h4>
      <a class="btn btn-ghost" href="#/archive">
        <i class="material-icons" style="font-size:16px;">arrow_back</i> All Past Events
      </a>
    </div>
    <div id="archEventMeta" style="margin-bottom:10px;"></div>
    <div class="card" id="archRacesCard" style="padding:0;">
      <div style="padding:20px; text-align:center; color:var(--text-tertiary);">
        <i class="material-icons" style="font-size:24px;">hourglass_top</i>
        <div style="margin-top:6px; font-size:13px;">Loading races…</div>
      </div>
    </div>
  `;

  // Fetch event config + races in parallel.
  let configRow, races;
  try {
    const [cfgRes, raceRes] = await Promise.all([
      supabaseRef.from('event_config')
        .select('event_ref, config, updated_at')
        .eq('event_ref', eventRef).single(),
      supabaseRef.from('race_snapshots')
        .select('race_number, event_ref, snapshot, updated_at')
        .eq('event_ref', eventRef)
        .order('race_number', { ascending: true }),
    ]);
    if (cfgRes.error && cfgRes.error.code !== 'PGRST116') throw cfgRes.error;
    if (raceRes.error) throw raceRes.error;
    configRow = cfgRes.data;
    races = raceRes.data || [];
  } catch (err) {
    document.getElementById('archRacesCard').innerHTML = `
      <div style="padding:16px; color:var(--danger); font-size:13px;">
        Failed to load archive: ${err.message || err}
      </div>`;
    return;
  }

  const cfg = configRow?.config || {};
  const driveUrl = cfg.drive_source_folder_id
    ? `https://drive.google.com/drive/folders/${cfg.drive_source_folder_id}` : null;

  document.getElementById('archEventMeta').innerHTML = `
    <div class="card" style="padding:10px 14px; display:flex; flex-wrap:wrap; gap:18px; align-items:center;">
      <span style="display:inline-block; width:10px; height:32px; border-radius:3px;
                   background:${cfg.event_colour || '#9ca3af'};"></span>
      <div>
        <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase;">Event</div>
        <div style="font-size:14px; font-weight:600;">${cfg.event_name || '—'}</div>
      </div>
      <div>
        <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase;">Date</div>
        <div style="font-size:13px;">${formatEventDate(cfg.event_date)}</div>
      </div>
      <div>
        <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase;">Races</div>
        <div style="font-size:13px;">${cfg.total_races ?? races.length}</div>
      </div>
      <div>
        <div style="font-size:11px; color:var(--text-tertiary); text-transform:uppercase;">Exported</div>
        <div style="font-size:13px;">${cfg.exported_races ?? '—'}</div>
      </div>
      <div style="flex:1;"></div>
      ${driveUrl
        ? `<a class="btn btn-outline" href="${driveUrl}" target="_blank">
             <i class="material-icons">folder_open</i> Open Drive Folder
           </a>` : ''}
    </div>
  `;

  if (races.length === 0) {
    document.getElementById('archRacesCard').innerHTML = `
      <div style="padding:24px; text-align:center; color:var(--text-tertiary);">
        No race snapshots stored for ${eventRef}.
      </div>`;
    return;
  }

  document.getElementById('archRacesCard').innerHTML = `
    <table class="race-table" style="width:100%;">
      <thead>
        <tr>
          <th style="width:50px; text-align:left;">#</th>
          <th style="text-align:left;">Title</th>
          <th style="text-align:left; width:80px;">Sched</th>
          <th style="text-align:left; width:80px;">Status</th>
          <th style="text-align:left; width:110px;">Exported</th>
          <th style="width:110px;"></th>
        </tr>
      </thead>
      <tbody>
        ${races.map(r => {
          const s = r.snapshot || {};
          return `
            <tr>
              <td><strong>${r.race_number}</strong></td>
              <td>${(s.title || '—').replace(/"/g, '&quot;')}</td>
              <td style="color:var(--text-secondary);">${s.race_time || ''}</td>
              <td>${statusBadge(s.status)}</td>
              <td style="color:var(--text-secondary); font-size:12px;">
                ${s.export_time ? new Date(s.export_time).toLocaleString() : '—'}
              </td>
              <td>
                <button class="btn btn-ghost btn-sm" onclick="window._archShowRace(${r.race_number})">
                  <i class="material-icons" style="font-size:14px;">expand_more</i> Results
                </button>
              </td>
            </tr>
            <tr id="archRaceDetail-${r.race_number}" style="display:none;">
              <td colspan="6" style="padding:0;">
                <div id="archRaceDetailBody-${r.race_number}" style="padding:10px 14px; background:var(--bg-elev);"></div>
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  // Stash the loaded races for the inline expand handler.
  const racesByNumber = {};
  for (const r of races) racesByNumber[r.race_number] = r;

  window._archShowRace = (raceNumber) => {
    const detailRow = document.getElementById(`archRaceDetail-${raceNumber}`);
    if (!detailRow) return;
    const open = detailRow.style.display === 'none';
    detailRow.style.display = open ? '' : 'none';
    if (!open) return;
    const body = document.getElementById(`archRaceDetailBody-${raceNumber}`);
    body.innerHTML = renderRaceDetailHtml(racesByNumber[raceNumber]?.snapshot || {}, cfg);
  };
}

function renderRaceDetailHtml(snapshot, eventCfg) {
  const timeMode = eventCfg?.time_format_mode || 'mss00';
  const lanes = snapshot.lane_results || [];
  const sortedByPos = [...lanes].sort((a, b) => {
    const aP = a.computed_position == null ? 999 : a.computed_position;
    const bP = b.computed_position == null ? 999 : b.computed_position;
    return aP - bP;
  });

  if (sortedByPos.length === 0) {
    return '<div style="color:var(--text-tertiary); font-size:13px;">No lane results in this snapshot.</div>';
  }

  return `
    <table class="race-table" style="width:100%; font-size:12px;">
      <thead>
        <tr>
          <th style="width:50px;">Pos</th>
          <th style="width:50px;">Lane</th>
          <th>Team</th>
          <th style="width:90px;">Time</th>
          <th style="width:60px;">TP (s)</th>
          <th>Remarks</th>
        </tr>
      </thead>
      <tbody>
        ${sortedByPos.map(l => `
          <tr>
            <td><strong>${l.computed_position ?? ''}</strong></td>
            <td>${l.lane_input || l.lane_number}</td>
            <td>${(l.team_name || '').replace(/"/g, '&quot;')}
                ${l.team_code ? `<span style="color:var(--text-tertiary); font-size:11px;">(${l.team_code})</span>` : ''}</td>
            <td style="font-family:monospace;">${timeToDisplay(l.raw_time, timeMode)}</td>
            <td>${l.penalty_time ?? ''}</td>
            <td style="color:var(--text-secondary);">${l.remarks || ''}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function statusBadge(s) {
  const map = {
    pending: ['badge-pending', 'PENDING'],
    started: ['badge-started', 'STARTED'],
    exported: ['badge-exported', 'EXPORTED'],
    sent: ['badge-sent', 'SENT'],
    cancelled: ['badge-cancelled', 'CANCELLED'],
  };
  const [cls, label] = map[s] || ['badge-pending', (s || 'PENDING').toUpperCase()];
  return `<span class="badge ${cls}">${label}</span>`;
}

function formatEventDate(yyyymmdd) {
  const s = String(yyyymmdd || '').trim();
  if (!/^\d{8}$/.test(s)) return s || '—';
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}
