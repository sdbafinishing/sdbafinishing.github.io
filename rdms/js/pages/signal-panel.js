/**
 * SDBA RDMS — Firebase Signal Panel
 * Embeddable race status panel (finisher/race-control/starter modes).
 * Reads/writes to Firebase Realtime Database: race_status/{RaceControlReady, StarterReady, FinishingReady}.
 *
 * Can be embedded in dashboard, race page, or opened standalone in a new tab.
 * Modes:
 *   finisher     — can toggle FinishingReady, read-only for others
 *   race-control — can toggle RaceControlReady, read-only for others
 *   starter      — can toggle StarterReady, read-only for others
 *   view-only    — read-only for all
 */

// Firebase config (same as sdbafinishing.github.io)
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBmRxbnhGwVeRlzkgCICuBGaMM7jBzWIKo",
  authDomain: "dbracecontrol.firebaseapp.com",
  databaseURL: "https://dbracecontrol-default-rtdb.firebaseio.com",
  projectId: "dbracecontrol",
  storageBucket: "dbracecontrol.firebasestorage.app",
  messagingSenderId: "833788584631",
  appId: "1:833788584631:web:cdd6697b6378fbb2b46332",
};

let firebaseApp = null;
let dbRef = null;
let statusListener = null;
let alertListener = null;
let currentStatus = { RaceControlReady: false, StarterReady: false, FinishingReady: false };

/**
 * Initialize Firebase (lazy load SDK from CDN).
 */
async function initFirebase() {
  if (firebaseApp) return;

  // Dynamically load Firebase SDK
  if (!window.firebase) {
    await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
    await loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js');
  }

  // Guard against double-init — flag-signal.js may already have done it.
  if (!window.firebase.apps?.length) {
    firebaseApp = window.firebase.initializeApp(FIREBASE_CONFIG);
  } else {
    firebaseApp = window.firebase.apps[0];
  }
  dbRef = window.firebase.database();
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

/**
 * Render the signal panel as an embeddable HTML block.
 * @param {string} containerId - DOM element ID to render into
 * @param {string} mode - 'finisher' | 'race-control' | 'starter' | 'view-only'
 */
export async function renderSignalPanel(containerId, mode = 'view-only') {
  const container = document.getElementById(containerId);
  if (!container) return;

  try {
    await initFirebase();
  } catch {
    container.innerHTML = '<p style="color:var(--danger); font-size:12px;">Firebase failed to load.</p>';
    return;
  }

  const canToggle = {
    'finisher': 'FinishingReady',
    'race-control': 'RaceControlReady',
    'starter': 'StarterReady',
    'view-only': null,
  };
  const toggleField = canToggle[mode] || null;

  container.innerHTML = `
    <div style="display:flex; gap:8px; align-items:stretch;">
      ${renderStatusBox('RaceControlReady', 'Race Control', toggleField === 'RaceControlReady')}
      ${renderStatusBox('StarterReady', 'Starter', toggleField === 'StarterReady')}
      ${renderStatusBox('FinishingReady', 'Finishing', toggleField === 'FinishingReady')}
      ${mode !== 'view-only' ? `
        <button class="btn btn-danger" style="padding:6px 10px; font-size:11px; align-self:center;"
                onclick="window._signalAlert()">
          <i class="material-icons" style="font-size:14px;">warning</i> STOP
        </button>
      ` : ''}
    </div>
  `;

  // Attach click handlers for toggleable box
  if (toggleField) {
    const box = container.querySelector(`[data-field="${toggleField}"]`);
    if (box) {
      box.style.cursor = 'pointer';
      box.addEventListener('click', async () => {
        const newVal = !currentStatus[toggleField];
        await dbRef.ref(`race_status/${toggleField}`).set(newVal);
      });
    }
  }

  // Alert handler
  window._signalAlert = async () => {
    if (!confirm('Trigger STOP RACE alert to all stations?')) return;
    await dbRef.ref('alertTrigger').set(Date.now());
  };

  // Real-time listener
  if (statusListener) dbRef.ref('race_status').off('value', statusListener);
  statusListener = dbRef.ref('race_status').on('value', (snapshot) => {
    const data = snapshot.val() || {};
    currentStatus = {
      RaceControlReady: data.RaceControlReady || false,
      StarterReady: data.StarterReady || false,
      FinishingReady: data.FinishingReady || false,
    };
    updateStatusBoxes(container);
  });

  // Alert listener — track last known alert to avoid replaying on mount
  if (alertListener) dbRef.ref('alertTrigger').off('value', alertListener);
  let lastAlertTs = null; // null = first read (skip), then track
  alertListener = dbRef.ref('alertTrigger').on('value', (snapshot) => {
    const ts = snapshot.val();
    if (lastAlertTs === null) {
      // First read on mount — just record, don't fire
      lastAlertTs = ts || 0;
      return;
    }
    if (ts && ts !== lastAlertTs) {
      // New alert! Play sound and flash
      lastAlertTs = ts;
      try {
        const audio = new Audio('https://raw.githubusercontent.com/sdbafinishing/sdbafinishing.github.io/main/Assets/alert.mp3');
        audio.play().catch(() => {});
      } catch {}
      // Full-page red flash
      const flash = document.createElement('div');
      flash.style.cssText = 'position:fixed; inset:0; background:rgba(255,0,0,0.6); z-index:99999; pointer-events:none; transition:opacity 0.5s;';
      document.body.appendChild(flash);
      setTimeout(() => { flash.style.opacity = '0'; }, 1500);
      setTimeout(() => { flash.remove(); }, 2000);
    }
  });
}

function renderStatusBox(field, label, clickable) {
  return `
    <div data-field="${field}" class="signal-box"
         style="flex:1; text-align:center; padding:8px 12px; border-radius:var(--radius-sm);
                border:2px solid var(--border); min-width:80px;
                ${clickable ? 'cursor:pointer;' : ''}
                transition:all 0.2s;">
      <div style="font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-tertiary); margin-bottom:4px;">${label}</div>
      <div class="signal-dot" style="width:16px; height:16px; border-radius:50%; margin:0 auto; background:var(--border);"></div>
    </div>
  `;
}

function updateStatusBoxes(container) {
  for (const [field, ready] of Object.entries(currentStatus)) {
    const box = container.querySelector(`[data-field="${field}"]`);
    if (!box) continue;
    const dot = box.querySelector('.signal-dot');

    if (ready) {
      box.style.borderColor = '#10b981';
      box.style.background = 'rgba(16,185,129,0.08)';
      if (dot) dot.style.background = '#10b981';
    } else {
      box.style.borderColor = '#ef4444';
      box.style.background = 'rgba(239,68,68,0.08)';
      if (dot) dot.style.background = '#ef4444';
    }
  }
}

/**
 * Cleanup Firebase listeners.
 */
export function cleanupSignalPanel() {
  if (dbRef && statusListener) dbRef.ref('race_status').off('value', statusListener);
  if (dbRef && alertListener) dbRef.ref('alertTrigger').off('value', alertListener);
  statusListener = null;
  alertListener = null;
  delete window._signalAlert;
}

// Independent listener slot for the embedded mini panel — kept separate from
// the full-page `statusListener` so opening the standalone panel later
// doesn't tear this one down.
let miniStatusListener = null;
let miniCurrentStatus = { RaceControlReady: false, StarterReady: false, FinishingReady: false };

/**
 * Render a compact in-header signal panel. Race Control + Starter are shown
 * as small read-only dots (left); Finishing is a larger toggle button (right)
 * since the finishing station is the operator using the race page.
 *
 * Designed to sit inline in the race header without dominating layout.
 *
 * @param {string} containerId - target element id
 */
export async function renderMiniSignalPanel(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  try {
    await initFirebase();
  } catch {
    container.innerHTML = '<span style="font-size:11px; color:var(--danger);">flag offline</span>';
    return;
  }

  container.innerHTML = `
    <div class="mini-flag-row" style="display:flex; gap:6px; align-items:stretch;">
      <div style="display:flex; gap:4px;">
        ${miniDot('RaceControlReady', 'RC', false)}
        ${miniDot('StarterReady', 'ST', false)}
      </div>
      <button id="miniFinishBtn" data-field="FinishingReady"
              style="border:none; background:var(--bg-card); padding:0 12px;
                     min-height:44px; border-radius:var(--radius-sm); cursor:pointer;
                     display:flex; align-items:center; gap:8px;
                     box-shadow:0 0 0 2px var(--border) inset;
                     transition:all 0.15s;"
              title="Toggle Finishing flag (click to flip green/red)">
        <span class="mini-flag-dot" data-field="FinishingReady"
              style="width:16px; height:16px; border-radius:50%; background:var(--border);"></span>
        <span style="font-size:12px; font-weight:700; letter-spacing:0.5px;
                     text-transform:uppercase; color:var(--text-secondary);">FN</span>
      </button>
    </div>
  `;

  const btn = container.querySelector('#miniFinishBtn');
  if (btn) {
    btn.addEventListener('click', async () => {
      try {
        const newVal = !miniCurrentStatus.FinishingReady;
        await dbRef.ref('race_status/FinishingReady').set(newVal);
      } catch (err) {
        console.warn('mini-flag toggle failed', err);
      }
    });
  }

  // Listener — independent from the full-page one. The mini and full panels
  // can coexist; both read the same Firebase node.
  if (miniStatusListener) dbRef.ref('race_status').off('value', miniStatusListener);
  miniStatusListener = dbRef.ref('race_status').on('value', (snapshot) => {
    const data = snapshot.val() || {};
    miniCurrentStatus = {
      RaceControlReady: data.RaceControlReady || false,
      StarterReady: data.StarterReady || false,
      FinishingReady: data.FinishingReady || false,
    };
    updateMiniBoxes(container);
  });
}

export function cleanupMiniSignalPanel() {
  if (dbRef && miniStatusListener) {
    try { dbRef.ref('race_status').off('value', miniStatusListener); } catch {}
  }
  miniStatusListener = null;
}

function miniDot(field, label, clickable) {
  return `
    <div data-field="${field}"
         title="${label === 'RC' ? 'Race Control' : 'Starter'}"
         style="display:flex; flex-direction:column; align-items:center; justify-content:center;
                padding:3px 6px; min-width:32px; min-height:44px;
                border:1px solid var(--border); border-radius:var(--radius-sm);
                background:var(--bg-card);">
      <span class="mini-flag-dot" data-field="${field}"
            style="width:12px; height:12px; border-radius:50%; background:var(--border);"></span>
      <span style="font-size:10px; font-weight:700; color:var(--text-tertiary);
                   letter-spacing:0.5px; margin-top:3px;">${label}</span>
    </div>
  `;
}

function updateMiniBoxes(container) {
  for (const [field, ready] of Object.entries(miniCurrentStatus)) {
    const dot = container.querySelector(`.mini-flag-dot[data-field="${field}"]`);
    if (!dot) continue;
    dot.style.background = ready ? '#10b981' : '#ef4444';
    // Larger Finishing button — also tint the surrounding shadow.
    if (field === 'FinishingReady') {
      const btn = container.querySelector('#miniFinishBtn');
      if (btn) {
        btn.style.boxShadow = `0 0 0 2px ${ready ? '#10b981' : '#ef4444'} inset`;
        btn.style.background = ready ? 'rgba(16,185,129,0.10)' : 'rgba(239,68,68,0.10)';
      }
    }
  }
}

/**
 * Open a specific station mode in a new tab.
 * Uses the existing sdbafinishing.github.io pages.
 * @param {string} mode - 'finisher' | 'race-control' | 'starter' | 'view-only'
 */
export function openStationTab(mode) {
  const urls = {
    'finisher': 'https://sdbafinishing.github.io/finisher.html',
    'race-control': 'https://sdbafinishing.github.io/race-control.html',
    'starter': 'https://sdbafinishing.github.io/starter.html',
    'view-only': 'https://sdbafinishing.github.io/view-only.html',
  };
  const url = urls[mode];
  if (url) window.open(url, '_blank');
}
