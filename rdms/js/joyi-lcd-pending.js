/**
 * SDBA RDMS — Joyi LCD Lazy-Fetch State Tracker
 *
 * Tracks which races currently have a Joyi LCD download in flight (so the
 * UI can show a small "loading start time" chip), and lets the FINISH /
 * input handlers `await` the in-flight fetch to complete before computing
 * a delta — that's the "block on operator action" requirement.
 *
 * The actual fetching is done by joyi-folder.js's deriveJoyiStartTimeForRace.
 * This module just keeps the per-race state and a promise so callers can
 * subscribe to the result.
 *
 * Design: the watch loop / Import Joyi handler kicks off `enqueue(N)` after
 * a successful results import. The fetch runs in the background, calls
 * setJoyiStartTimeOnRace + broadcasts, and removes itself from the pending
 * Set when done.
 */
import { deriveJoyiStartTimeForRace } from './joyi-folder.js';
import { setJoyiStartTimeOnRace } from './import.js';
import { broadcastChange } from './app.js';

// raceNumber → in-flight Promise that resolves to ISO string | null
const inflight = new Map();
// Listeners that want to know when the pending Set changes (for the
// inline-spinner chip on the race page).
const listeners = new Set();

function notify() {
  for (const l of listeners) {
    try { l(getPendingSnapshot()); } catch { /* ignore listener errors */ }
  }
}

/**
 * Subscribe to pending-set changes. Returns an unsubscribe function.
 * @param {(pendingArr: number[]) => void} fn
 */
export function onPendingChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Snapshot of currently-pending race numbers.
 */
export function getPendingSnapshot() {
  return [...inflight.keys()];
}

/**
 * Is there an LCD fetch in flight for this race?
 */
export function isLcdPending(raceNumber) {
  return inflight.has(raceNumber);
}

/**
 * Wait for any in-flight LCD fetch for this race to settle. Resolves to
 * the derived ISO start (or null) once done; resolves immediately if no
 * fetch is in flight. Used by the FINISH / input handlers to "await Joyi"
 * before computing a delta.
 */
export function awaitLcd(raceNumber) {
  const p = inflight.get(raceNumber);
  return p || Promise.resolve(null);
}

/**
 * Kick off the lazy LCD fetch for a race. Safe to call multiple times —
 * subsequent calls return the existing in-flight promise.
 *
 * The fetch:
 *   1. Calls deriveJoyiStartTimeForRace (ranged read against Drive or
 *      File.slice() against local — both very lightweight).
 *   2. Writes joyi_start_time to the race + flips status to 'started'.
 *   3. Broadcasts 'race-updated' so other tabs / the open race page
 *      can refresh the displayed start time.
 *
 * @param {number} raceNumber
 * @returns {Promise<string|null>}
 */
export function enqueueLcdFetch(raceNumber) {
  if (!raceNumber) return Promise.resolve(null);
  if (inflight.has(raceNumber)) return inflight.get(raceNumber);

  const promise = (async () => {
    try {
      const iso = await deriveJoyiStartTimeForRace(raceNumber);
      if (iso) {
        await setJoyiStartTimeOnRace(raceNumber, iso);
        broadcastChange('race-updated', { race_number: raceNumber, joyi_start: true });
      }
      return iso;
    } catch (err) {
      console.warn(`enqueueLcdFetch race ${raceNumber} failed`, err);
      return null;
    } finally {
      inflight.delete(raceNumber);
      notify();
    }
  })();

  inflight.set(raceNumber, promise);
  notify();
  return promise;
}
