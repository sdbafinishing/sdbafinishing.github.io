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
import { db, getConfig, getAllRaces, getLaneResults } from './db.js';
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
  const timeMode = config?.time_format_mode || 'mss00';

  // Sort by position
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
      lane: l.lane_number,
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
      start_time: race.start_time,
      export_time: race.export_time,
      send_time: race.send_time,
      export_version: race.export_version || 0,
      scoring_flag: race.scoring_flag,
      division_id: race.division_id,
      results,
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
      total_races: total,
      exported_races: exported,
      sent_races: sent,
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

async function doSync(sb) {
  try {
    // Get all pending items (synced_at is null)
    const allPending = (await db.sync_queue.toArray()).filter(item => !item.synced_at);

    if (allPending.length === 0) { isSyncing = false; return; }

    // Dedup: keep latest per table+key
    const deduped = {};
    for (const item of allPending) {
      deduped[`${item.table_name}:${item.key}`] = item;
    }

    for (const item of Object.values(deduped)) {
      try {
        if (item.table_name === 'race_snapshots') {
          const snapshot = await buildRaceSnapshot(item.key);
          if (snapshot) {
            await sb.from('race_snapshots').upsert(snapshot, { onConflict: 'race_number,event_ref' });
          }
        } else if (item.table_name === 'event_config') {
          const eventSnap = await buildEventSnapshot();
          if (eventSnap) {
            await sb.from('event_config').upsert(eventSnap, { onConflict: 'event_ref' });
          }
        }

        // Mark synced
        await db.sync_queue.update(item.id, { synced_at: new Date().toISOString() });
      } catch (err) {
        console.warn('Sync failed for item:', item, err);
        // Don't mark as synced — will retry next time
        break;
      }
    }

    // Cleanup old synced items (keep last 100)
    const synced = await db.sync_queue.where('synced_at').notEqual('').toArray();
    if (synced.length > 100) {
      const toDelete = synced.slice(0, synced.length - 100).map(s => s.id);
      await db.sync_queue.bulkDelete(toDelete);
    }
  } catch (err) {
    console.warn('Sync error:', err);
  }
}

// ──── Lifecycle ────

/**
 * Start the sync service.
 * Listens for online events and syncs periodically.
 */
export async function startSyncService() {
  // Check if sync is even configured before doing anything
  const config = await getConfig();
  if (!config?.supabase_url || !config?.supabase_anon_key) return; // Not configured — skip entirely

  // Sync on reconnect
  window.addEventListener('online', () => {
    showToast('Back online — syncing...', 'info', 2000);
    attemptSync();
  });

  // Periodic sync every 30s (don't sync on init — wait for first state change)
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
