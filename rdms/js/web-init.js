/**
 * SDBA RDMS — Web Version Initialization
 * For GitHub Pages deployment: auto-configures Supabase from web-config.js,
 * loads available events, lets user pick (defaults to latest).
 *
 * Local version skips this entirely (uses IndexedDB config).
 */
import { WEB_CONFIG } from './web-config.js';
import { isLocal } from './auth.js';
import { getConfig, saveConfig } from './db.js';
import { showToast } from './utils.js';

let supabaseClient = null;

/**
 * Initialize the web version.
 * - Loads Supabase client from baked-in config
 * - Fetches available events
 * - Auto-selects latest or lets user pick
 * - Syncs event config into local IndexedDB for the app to use
 *
 * @returns {{ ready: boolean, eventRef: string|null }}
 */
export async function initWebVersion() {
  if (isLocal()) return { ready: true, eventRef: null }; // Local — skip

  if (!WEB_CONFIG.supabase_url || !WEB_CONFIG.supabase_anon_key) {
    return { ready: false, eventRef: null }; // Not configured
  }

  // Load Supabase
  if (!window.supabase) {
    try {
      await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
    } catch {
      return { ready: false, eventRef: null };
    }
  }

  supabaseClient = window.supabase.createClient(WEB_CONFIG.supabase_url, WEB_CONFIG.supabase_anon_key);

  // Check if we already have a selected event in this session
  const savedRef = sessionStorage.getItem('rdms-web-event');
  if (savedRef) {
    await loadEventConfig(savedRef);
    return { ready: true, eventRef: savedRef };
  }

  // Fetch available events from Supabase
  const events = await fetchEvents();
  if (events.length === 0) {
    return { ready: true, eventRef: null }; // No events yet
  }

  // Auto-select latest event
  const latest = events[0]; // sorted by updated_at desc
  await loadEventConfig(latest.event_ref);
  sessionStorage.setItem('rdms-web-event', latest.event_ref);

  return { ready: true, eventRef: latest.event_ref };
}

/**
 * Fetch available events from Supabase.
 */
async function fetchEvents() {
  if (!supabaseClient) return [];

  const { data, error } = await supabaseClient
    .from('event_config')
    .select('event_ref, config, updated_at')
    .order('updated_at', { ascending: false });

  if (error || !data) return [];
  return data;
}

/**
 * Load event config + race snapshots into local IndexedDB.
 * Web version uses Supabase as source of truth.
 */
async function loadEventConfig(eventRef) {
  if (!supabaseClient) return;

  const { db } = await import('./db.js');

  // ────── event_config ──────
  const { data: eventData } = await supabaseClient
    .from('event_config')
    .select('*')
    .eq('event_ref', eventRef)
    .single();

  if (eventData?.config) {
    const cfg = eventData.config;

    // Merge top-level config fields into the local singleton.
    const localConfig = await getConfig() || {};
    const merged = {
      ...localConfig,
      ...cfg,
      event_short_ref: eventRef,
      supabase_url: WEB_CONFIG.supabase_url,
      supabase_anon_key: WEB_CONFIG.supabase_anon_key,
      google_client_id: WEB_CONFIG.google_client_id,
    };
    // The nested arrays don't belong on the config singleton — they have
    // their own tables. Strip before persisting.
    delete merged.divisions;
    delete merged.division_rounds;
    delete merged.division_progressions;
    await saveConfig(merged);

    // Hydrate divisions + flowchart DAG so viewer pages (dashboard
    // swatches, scoring tabs, flowchart, timesheet) render fully.
    if (Array.isArray(cfg.divisions)) {
      await db.divisions.clear();
      if (cfg.divisions.length > 0) await db.divisions.bulkPut(cfg.divisions);
    }
    if (Array.isArray(cfg.division_rounds)) {
      await db.division_rounds.clear();
      if (cfg.division_rounds.length > 0) await db.division_rounds.bulkPut(cfg.division_rounds);
    }
    if (Array.isArray(cfg.division_progressions)) {
      await db.division_progressions.clear();
      if (cfg.division_progressions.length > 0) await db.division_progressions.bulkPut(cfg.division_progressions);
    }
  }

  // ────── race_snapshots ──────
  // Full reset on event (re)selection so a previously-loaded event's races
  // don't linger when switching to a smaller one.
  await hydrateRaceSnapshots(eventRef, { clear: true });
}

/**
 * Pull race snapshots for an event from Supabase into local IndexedDB.
 *
 * Shared by the initial event load (clear:true — full reset, drops stale races
 * from a previously-selected event) and the periodic dashboard poll
 * (clear:false — in-place refresh; bulkPut overwrites by primary key so no
 * duplicates and no flicker while a live event's race count is stable).
 *
 * @param {string} eventRef
 * @param {{ clear?: boolean }} [opts]
 * @returns {Promise<boolean>} true when snapshots were fetched + applied
 */
async function hydrateRaceSnapshots(eventRef, { clear = false } = {}) {
  if (!supabaseClient) return false;
  const { db } = await import('./db.js');

  const { data: snapshots } = await supabaseClient
    .from('race_snapshots')
    .select('*')
    .eq('event_ref', eventRef)
    .order('race_number');

  if (!snapshots) return false; // fetch failed — leave existing data intact

  if (clear) {
    // Done AFTER the fetch succeeded so a transient failure can't blank the
    // viewer. An empty event (snapshots === []) correctly clears to nothing.
    await db.races.clear();
    await db.lane_results.clear();
    await db.timesheet.clear();
  }

  // Races — preserve everything the snapshot carries (restart_time,
  // export_history, prev_send_time, p1_finish_*).
  const races = snapshots.map(s => ({
    race_number: s.race_number,
    race_title: s.snapshot?.title || '',
    race_time: s.snapshot?.race_time || '',
    status: s.snapshot?.status || 'pending',
    start_time: s.snapshot?.start_time || null,
    restart_time: s.snapshot?.restart_time || null,
    export_time: s.snapshot?.export_time || null,
    send_time: s.snapshot?.send_time || null,
    prev_send_time: s.snapshot?.prev_send_time || null,
    p1_finish_time: s.snapshot?.p1_finish_time || null,
    p1_finish_elapsed_ms: s.snapshot?.p1_finish_elapsed_ms ?? null,
    export_version: s.snapshot?.export_version || 0,
    export_history: s.snapshot?.export_history || [],
    scoring_flag: s.snapshot?.scoring_flag || 'N',
    division_id: s.snapshot?.division_id || null,
    next_race_signaled: !!s.snapshot?.next_race_signaled,
    teams_loaded: true,
    joyi_imported: false,
  }));
  await db.races.bulkPut(races);

  // Lane results — prefer the new full-shape lane_results. Fall back to
  // the legacy summarized results[] for snapshots produced by older
  // operator builds (where lane_input wasn't carried).
  for (const s of snapshots) {
    if (Array.isArray(s.snapshot?.lane_results) && s.snapshot.lane_results.length > 0) {
      const lanes = s.snapshot.lane_results.map(l => ({
        race_number: s.race_number,
        lane_number: l.lane_number,
        lane_input: l.lane_input || '',
        team_name: l.team_name || '',
        team_code: l.team_code || '',
        raw_time: l.raw_time || '',
        computed_position: l.computed_position ?? null,
        remarks: l.remarks || '',
        penalty_time: l.penalty_time ?? null,
        joyi_rank: l.joyi_rank ?? null,
        effective_time_ms: l.effective_time_ms ?? null,
      }));
      await db.lane_results.bulkPut(lanes);
    } else if (Array.isArray(s.snapshot?.results)) {
      const lanes = s.snapshot.results.map((r, i) => ({
        race_number: s.race_number,
        lane_number: r.lane || (i + 1),
        // Best-effort lane_input recovery so the by-lane output table still
        // resolves for legacy snapshots.
        lane_input: r.lane ? String(r.lane) : '',
        team_name: r.team_name || '',
        team_code: r.team_code || '',
        raw_time: r.time_raw || '',
        computed_position: r.position || null,
        remarks: r.remarks || '',
      }));
      await db.lane_results.bulkPut(lanes);
    }
  }

  // Timesheet — one row per race with timing log.
  const timesheets = snapshots
    .map(s => s.snapshot?.timesheet)
    .filter(Boolean);
  if (timesheets.length > 0) {
    await db.timesheet.bulkPut(timesheets);
  }

  return true;
}

// ────── Live dashboard polling (web viewer only) ──────
let webPollInterval = null;
const WEB_POLL_MS = 20000;

/**
 * Periodically re-pull the selected event's race snapshots from Supabase so a
 * web viewer left open (e.g. a second tab showing the dashboard while the
 * operator works in the local app) stays current. The dashboard's own 10s
 * render tick picks up the refreshed IndexedDB via its hash-based change
 * detection, so we don't force a render here.
 *
 * Online viewer only; no-op locally. Skips polling while the tab is hidden to
 * avoid needless Supabase traffic.
 */
export function startWebDashboardPoll() {
  if (isLocal() || webPollInterval) return;
  webPollInterval = setInterval(async () => {
    if (document.hidden) return;
    const ref = sessionStorage.getItem('rdms-web-event');
    if (!ref || !supabaseClient) return;
    try {
      await hydrateRaceSnapshots(ref, { clear: false });
    } catch (err) {
      console.warn('web dashboard poll failed:', err);
    }
  }, WEB_POLL_MS);
}

export function stopWebDashboardPoll() {
  if (webPollInterval) {
    clearInterval(webPollInterval);
    webPollInterval = null;
  }
}

/**
 * Show event picker UI.
 * @param {HTMLElement} container
 * @param {function} onSelect - Called with eventRef when user picks an event
 */
export async function showEventPicker(container, onSelect) {
  const events = await fetchEvents();

  if (events.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:40px; color:var(--text-tertiary);">
        <i class="material-icons" style="font-size:48px;">event_busy</i>
        <p style="margin-top:12px;">No events available yet.</p>
        <p style="font-size:13px;">Events appear here once the operator syncs from the local system.</p>
      </div>
    `;
    return;
  }

  const currentRef = sessionStorage.getItem('rdms-web-event');

  container.innerHTML = `
    <div style="max-width:400px; margin:20px auto;">
      <h4 style="font-size:16px; font-weight:600; margin-bottom:12px;">Select Event</h4>
      ${events.map(e => {
        const cfg = e.config || {};
        const isActive = e.event_ref === currentRef;
        const colour = cfg.event_colour || '#08394c';
        return `
          <div class="card" style="margin-bottom:8px; padding:12px 16px; cursor:pointer; ${isActive ? `border-color:${colour}; border-width:2px;` : ''}"
               onclick="window._selectEvent('${e.event_ref}')">
            <div style="display:flex; align-items:center; gap:10px;">
              <span style="background:${colour}; color:#fff; padding:2px 8px; border-radius:var(--radius-full); font-size:11px; font-weight:600;">${e.event_ref}</span>
              <strong style="font-size:14px;">${cfg.event_name || e.event_ref}</strong>
              ${isActive ? '<span style="margin-left:auto; color:var(--success); font-size:12px;">Active</span>' : ''}
            </div>
            <div style="font-size:12px; color:var(--text-tertiary); margin-top:4px;">
              ${cfg.event_date || ''} | ${cfg.total_races || '?'} races | Updated ${new Date(e.updated_at).toLocaleString()}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  window._selectEvent = async (ref) => {
    sessionStorage.setItem('rdms-web-event', ref);
    showToast(`Loading ${ref}...`, 'info', 2000);
    await loadEventConfig(ref);
    if (onSelect) onSelect(ref);
    delete window._selectEvent;
  };
}

/**
 * Get the Supabase client for web version.
 */
export function getWebSupabase() {
  return supabaseClient;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}
