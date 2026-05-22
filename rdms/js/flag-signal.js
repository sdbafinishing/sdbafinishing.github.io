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
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function ensureFirebase() {
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
