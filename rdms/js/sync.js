/**
 * SDBA RDMS — Supabase Sync Layer
 *
 * Architecture:
 *   Local IndexedDB ──(sync queue)──▶ Supabase ──(realtime)──▶ Mobile dashboard / Web viewers
 *
 * Tables in Supabase:
 *   race_snapshots    — one JSONB row per race (full result data, publicly readable)
 *   event_config      — event metadata (name, ref, date, colour)
 *   sync_log          — sync history for debugging
 *
 * Sync is fire-and-forget from the operator's perspective:
 *   1. Every state change pushes to the local sync_queue
 *   2. When online, queue is flushed to Supabase
 *   3. If offline, queue accumulates and drains on reconnect
 *
 * Configuration:
 *   Supabase URL + anon key stored in event config.
 *   If not configured, sync is silently disabled.
 */
import { db, getConfig, getAllRaces, getLaneResults, getTimesheet } from './db.js';
import { timeToDisplay, isoToTime, showToast } from './utils.js';

let supabaseClient = null;
let syncInterval = null;

// ──── Supabase Client (lazy init) ────

async function getSupabase() {
  if (supabaseClient) return supabaseClient;

  const config = await getConfig();
  if (!config?.supabase_url || !config?.supabase_anon_key) return null;

  // Lazy load Supabase client
  if (!window.supabase) {
    await loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
  }

  if (!window.supabase) return null;

  supabaseClient = window.supabase.createClient(config.supabase_url, config.supabase_anon_key);
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

// ──── Snapshot Builder ────

/**
 * Build a race snapshot for Supabase.
 * Self-contained JSON — no joins needed on the reader side.
 */
async function buildRaceSnapshot(raceNumber) {
  const config = await getConfig();
  const race = await db.races.get(raceNumber);
  if (!race) return null;

  const lanes = await getLaneResults(raceNumber);
  const timesheet = await getTimesheet(raceNumber);
  const timeMode = config?.time_format_mode || 'mss00';

  // Full per-lane data so viewers can reproduce the input grid + by-lane
  // output table exactly as the operator sees them. The map below intentionally
  // mirrors the lane_results table shape.
  const lane_results = lanes
    .slice()
    .sort((a, b) => a.lane_number - b.lane_number)
    .map(l => ({
      lane_number: l.lane_number,
      lane_input: l.lane_input || '',
      team_name: l.team_name || '',
      team_code: l.team_code || '',
      raw_time: l.raw_time || '',
      computed_position: l.computed_position ?? null,
      remarks: l.remarks || '',
      penalty_time: l.penalty_time || null,
      joyi_rank: l.joyi_rank ?? null,
      effective_time_ms: l.effective_time_ms ?? null,
    }));

  // Legacy summarized results[] — kept for backward compat with any mobile
  // clients reading the old shape. Web viewer uses lane_results instead.
  const results = lanes
    .filter(l => l.raw_time || l.remarks)
    .sort((a, b) => {
      if (a.computed_position == null && b.computed_position == null) return a.lane_number - b.lane_number;
      if (a.computed_position == null) return 1;
      if (b.computed_position == null) return -1;
      return a.computed_position - b.computed_position;
    })
    .map(l => ({
      position: l.computed_position,
      lane: parseInt(l.lane_input, 10) || l.lane_number,
      team_name: l.team_name || '',
      team_code: l.team_code || '',
      time_display: timeToDisplay(l.raw_time, timeMode),
      time_raw: l.raw_time || '',
      remarks: [l.penalty_time ? `TP=${l.penalty_time}s` : '', l.remarks || ''].filter(Boolean).join(', '),
    }));

  return {
    race_number: raceNumber,
    event_ref: config?.event_short_ref || '',
    snapshot: {
      race_number: raceNumber,
      title: race.race_title || '',
      status: race.status,
      start_time: race.start_time || null,
      restart_time: race.restart_time || null,
      export_time: race.export_time || null,
      send_time: race.send_time || null,
      prev_send_time: race.prev_send_time || null,
      p1_finish_time: race.p1_finish_time || null,
      p1_finish_elapsed_ms: race.p1_finish_elapsed_ms ?? null,
      export_version: race.export_version || 0,
      export_history: race.export_history || [],
      scoring_flag: race.scoring_flag || 'N',
      division_id: race.division_id || null,
      race_time: race.race_time || '',
      next_race_signaled: !!race.next_race_signaled,
      lane_results,        // full per-lane data — used by viewer hydration
      results,             // legacy summary — kept for back-compat
      timesheet: timesheet || null,
    },
    updated_at: new Date().toISOString(),
  };
}

/**
 * Build event config snapshot.
 */
async function buildEventSnapshot() {
  const config = await getConfig();
  if (!config) return null;

  const races = await getAllRaces();
  const divisions = await db.divisions.toArray();
  const division_rounds = await db.division_rounds.toArray();
  const division_progressions = await db.division_progressions.toArray();

  const total = races.length;
  const exported = races.filter(r => r.export_time).length;
  const sent = races.filter(r => r.send_time).length;

  return {
    event_ref: config.event_short_ref || '',
    config: {
      event_name: config.event_long_name_en || '',
      event_ref: config.event_short_ref || '',
      event_date: config.race_date || '',
      event_colour: config.event_colour_code_hex || '#08394c',
      lane_count: config.lane_count || 6,
      time_format_mode: config.time_format_mode || 'mss00',
      // Renamed: new semantics gate the scoring EXPORT, not calculation.
      // Fall back to legacy scoring_enabled for configs synced before rename.
      scoring_exported: !!(config.scoring_exported ?? config.scoring_enabled),
      next_round_draw_enabled: !!config.next_round_draw_enabled,
      auto_start_list_on_import: !!config.auto_start_list_on_import,
      // Event-day lock + audit fields. Synced so other authenticated
      // devices see the lock state on next refresh; web viewers can
      // also use this to display a "locked" banner.
      event_locked: !!config.event_locked,
      event_locked_at: config.event_locked_at || null,
      event_locked_by: config.event_locked_by || null,
      event_unlocked_at: config.event_unlocked_at || null,
      event_unlocked_by: config.event_unlocked_by || null,
      total_races: total,
      exported_races: exported,
      sent_races: sent,
      // Drive folder id is captured so the Past Events archive viewer
      // (and other read-only viewers) can deep-link to the event's Drive
      // folder without needing per-event extra metadata.
      drive_source_folder_id: config.drive_source_folder_id || '',
      // Divisions + flowchart DAG — needed so viewer pages (dashboard
      // swatches, scoring tabs, flowchart, timesheet) render fully.
      divisions,
      division_rounds,
      division_progressions,
    },
    updated_at: new Date().toISOString(),
  };
}

// ──── Sync Queue Operations ────

/**
 * Queue a race for sync.
 * Called after any race state change (start, export, send, results update).
 */
export async function queueRaceSync(raceNumber) {
  await db.sync_queue.add({
    table_name: 'race_snapshots',
    operation: 'upsert',
    key: raceNumber,
    payload: null, // built at sync time for freshness
    created_at: new Date().toISOString(),
    synced_at: null,
  });

  // Also queue event config update
  await db.sync_queue.add({
    table_name: 'event_config',
    operation: 'upsert',
    key: 'event',
    payload: null,
    created_at: new Date().toISOString(),
    synced_at: null,
  });

  // Try sync immediately
  attemptSync();
}

/**
 * Flush the sync queue to Supabase.
 */
let syncPromise = null; // Promise-based lock instead of boolean flag

async function attemptSync() {
  if (syncPromise) return syncPromise; // Already syncing — return existing promise
  if (!navigator.onLine) return;

  const sb = await getSupabase();
  if (!sb) return;

  syncPromise = doSync(sb);
  try { await syncPromise; } finally { syncPromise = null; }
}

// Track most recent sync activity so the Setup status indicator + the
// race-day prompt can show whether Supabase is actually receiving data.
let lastSyncAt = null;
let lastSyncError = null;
let lastSyncWrites = 0;

export function getSyncDiagnostics() {
  return { lastSyncAt, lastSyncError, lastSyncWrites };
}

async function doSync(sb) {
  try {
    // Get all pending items (synced_at is null)
    const allPending = (await db.sync_queue.toArray()).filter(item => !item.synced_at);

    if (allPending.length === 0) return;

    // Dedup: keep latest per table+key
    const deduped = {};
    for (const item of allPending) {
      deduped[`${item.table_name}:${item.key}`] = item;
    }

    let writes = 0;
    let firstErr = null;
    for (const item of Object.values(deduped)) {
      try {
        if (item.table_name === 'race_snapshots') {
          const snapshot = await buildRaceSnapshot(item.key);
          if (snapshot) {
            const { error } = await sb.from('race_snapshots').upsert(snapshot, { onConflict: 'race_number,event_ref' });
            if (error) throw error;
          }
        } else if (item.table_name === 'event_config') {
          const eventSnap = await buildEventSnapshot();
          if (eventSnap) {
            const { error } = await sb.from('event_config').upsert(eventSnap, { onConflict: 'event_ref' });
            if (error) throw error;
          }
        }

        // Mark synced
        await db.sync_queue.update(item.id, { synced_at: new Date().toISOString() });
        writes++;
      } catch (err) {
        console.warn('Sync failed for item:', item, err);
        if (!firstErr) firstErr = err;
        // Don't mark as synced — will retry next time
        break;
      }
    }

    lastSyncAt = new Date().toISOString();
    lastSyncWrites = writes;
    if (firstErr) {
      lastSyncError = firstErr.message || String(firstErr);
    } else {
      lastSyncError = null;
    }

    // Cleanup old synced items (keep last 100)
    const synced = await db.sync_queue.where('synced_at').notEqual('').toArray();
    if (synced.length > 100) {
      const toDelete = synced.slice(0, synced.length - 100).map(s => s.id);
      await db.sync_queue.bulkDelete(toDelete);
    }
  } catch (err) {
    console.warn('Sync error:', err);
    lastSyncError = err.message || String(err);
    lastSyncAt = new Date().toISOString();
  }
}

/**
 * Force-flush every race + event config to Supabase, ignoring the
 * sync_queue state. Used by the manual "Sync now" button in Setup —
 * race-day operators who lost coverage / queue rows can recover with
 * one click. Returns { writes, error } so the UI can surface result.
 */
export async function forceFullSync() {
  const sb = await getSupabase();
  if (!sb) {
    return { writes: 0, error: 'Supabase not configured (URL + anon key required in Setup).' };
  }
  let writes = 0;
  let firstErr = null;
  try {
    const eventSnap = await buildEventSnapshot();
    if (eventSnap) {
      const { error } = await sb.from('event_config').upsert(eventSnap, { onConflict: 'event_ref' });
      if (error) firstErr = error; else writes++;
    }
    if (!firstErr) {
      const races = await getAllRaces();
      for (const r of races) {
        try {
          const snap = await buildRaceSnapshot(r.race_number);
          if (snap) {
            const { error } = await sb.from('race_snapshots').upsert(snap, { onConflict: 'race_number,event_ref' });
            if (error) { firstErr = error; break; }
            writes++;
          }
        } catch (err) {
          firstErr = err;
          break;
        }
      }
    }
  } catch (err) {
    firstErr = err;
  }
  lastSyncAt = new Date().toISOString();
  lastSyncWrites = writes;
  lastSyncError = firstErr ? (firstErr.message || String(firstErr)) : null;
  return { writes, error: firstErr ? (firstErr.message || String(firstErr)) : null };
}

// ──── Lifecycle ────

/**
 * Start the sync service.
 * Listens for online events and syncs periodically.
 */
export async function startSyncService() {
  // Idempotent — kill any previous interval so re-calling after a
  // config save (when supabase URL was newly set) doesn't accumulate
  // timers. Without this, an operator who configured supabase post-
  // boot would see the sync interval never installed.
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
  // Reset cached client so a URL change picks up the new connection.
  supabaseClient = null;

  // Check if sync is even configured before doing anything
  const config = await getConfig();
  if (!config?.supabase_url || !config?.supabase_anon_key) return; // Not configured — skip entirely

  // Sync on reconnect
  window.addEventListener('online', () => {
    showToast('Back online — syncing...', 'info', 2000);
    attemptSync();
  });

  // Periodic sync every 30s. Kick once immediately so any items
  // queued during a previous session (before sync was configured)
  // flush right away instead of waiting up to 30s.
  attemptSync();
  syncInterval = setInterval(attemptSync, 30000);
}

/**
 * Stop the sync service.
 */
export function stopSyncService() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

/**
 * Check if sync is configured and connected.
 */
export async function isSyncConfigured() {
  const config = await getConfig();
  return !!(config?.supabase_url && config?.supabase_anon_key);
}

/**
 * Get sync status for display.
 */
export async function getSyncStatus() {
  const configured = await isSyncConfigured();
  const pendingCount = (await db.sync_queue.toArray()).filter(item => !item.synced_at).length;

  return {
    configured,
    online: navigator.onLine,
    pendingCount,
  };
}
