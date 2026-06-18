/**
 * SDBA RDMS — Firebase Digital Flag Setter
 *
 * Lean writer for the Firebase Realtime Database `race_status/{role}Ready`
 * booleans used by the public mobile app. The full UI lives in
 * pages/signal-panel.js; this module is the headless write-only path used by
 * the race page to flip the flag to red when result entry starts.
 *
 * The DB schema:
 *   race_status/RaceControlReady : bool  (race control desk)
 *   race_status/StarterReady     : bool  (starter platform)
 *   race_status/FinishingReady   : bool  (finishing/scoring — this is the
 *                                         one we flip when scoring begins)
 *
 * `true`  = green = ready to start the next race
 * `false` = red   = not ready (e.g. scoring in progress)
 *
 * Init is lazy — the Firebase SDK is only loaded once (here OR via
 * signal-panel.js) and the same app instance is reused.
 */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBmRxbnhGwVeRlzkgCICuBGaMM7jBzWIKo",
  authDomain: "dbracecontrol.firebaseapp.com",
  databaseURL: "https://dbracecontrol-default-rtdb.firebaseio.com",
  projectId: "dbracecontrol",
  storageBucket: "dbracecontrol.firebasestorage.app",
  messagingSenderId: "833788584631",
  appId: "1:833788584631:web:cdd6697b6378fbb2b46332",
};

let initPromise = null;
let dbRef = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      // A tag may exist but NOT be loaded yet (a concurrent caller appended
      // it a tick ago). Resolving on mere tag-existence is the bug that made
      // a second consumer use window.firebase before it was ready. Wait for
      // the real load instead.
      if (existing.dataset.loaded === '1') { resolve(); return; }
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', reject);
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => { s.dataset.loaded = '1'; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

export async function ensureFirebase() {
  if (dbRef) return dbRef;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (!window.firebase) {
      await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js');
    }
    // Reuse an existing app if one is already initialised (signal-panel may
    // have done it). initializeApp() throws if called twice with the same
    // name, so guard against that.
    if (!window.firebase.apps?.length) {
      window.firebase.initializeApp(FIREBASE_CONFIG);
    }
    dbRef = window.firebase.database();
    return dbRef;
  })();
  return initPromise;
}

/**
 * Set the Finishing-ready flag (red/green) for the public mobile app.
 * Fire-and-forget: never blocks the caller; logs but doesn't throw on error.
 *
 * @param {boolean} ready - true = green (ready), false = red (busy/scoring)
 * @returns {Promise<boolean>} true if the write was acknowledged
 */
export async function setFinishingFlag(ready) {
  try {
    const db = await ensureFirebase();
    await db.ref('race_status/FinishingReady').set(!!ready);
    return true;
  } catch (err) {
    console.warn('setFinishingFlag failed:', err);
    return false;
  }
}

/**
 * Publish the current/next race number (+ title) to Firebase so the public
 * view-only dashboard can show it live — the same real-time, login-free path
 * the flags use, with no Supabase dependency. Written whenever the next race
 * is signaled.
 *
 * Schema:
 *   race_status/CurrentRace      : number  (the race spectators should ready for)
 *   race_status/CurrentRaceTitle : string  (optional human label)
 *
 * Fire-and-forget: never blocks the caller; logs but doesn't throw on error.
 *
 * @param {number} raceNumber
 * @param {string} [raceTitle]
 * @returns {Promise<boolean>}
 */
export async function setCurrentRace(raceNumber, raceTitle = '') {
  try {
    const db = await ensureFirebase();
    await db.ref('race_status/CurrentRace').set(raceNumber ?? null);
    await db.ref('race_status/CurrentRaceTitle').set(raceTitle || '');
    return true;
  } catch (err) {
    console.warn('setCurrentRace failed:', err);
    return false;
  }
}

/**
 * Subscribe to live current-race updates from Firebase. The callback receives
 * { raceNumber, raceTitle } on every change. Returns an unsubscribe function.
 * Used by the public view-only dashboard to show the race number live.
 *
 * @param {(info: {raceNumber: number|null, raceTitle: string}) => void} callback
 * @returns {Promise<() => void>}
 */
export async function subscribeCurrentRace(callback) {
  try {
    const db = await ensureFirebase();
    const ref = db.ref('race_status');
    const handler = (snap) => {
      const v = snap.val() || {};
      callback({ raceNumber: v.CurrentRace ?? null, raceTitle: v.CurrentRaceTitle || '' });
    };
    ref.on('value', handler);
    return () => { try { ref.off('value', handler); } catch { /* no-op */ } };
  } catch (err) {
    console.warn('subscribeCurrentRace failed:', err);
    return () => {};
  }
}
