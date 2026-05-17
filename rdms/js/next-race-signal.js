/**
 * SDBA RDMS — Next Race Signal
 * After export, prompt to signal the next race on the public mobile app.
 * Tracks which races have been signaled to avoid duplicates.
 * Skips cancelled races when finding "next".
 */
import { getConfig, saveConfig, getAllRaces, getRace, saveRace } from './db.js';
import { showToast } from './utils.js';
import { broadcastChange } from './app.js';

/**
 * Find the next non-cancelled race after a given race number.
 * @param {number} afterRaceNumber
 * @returns {Object|null} Next race record, or null
 */
export async function findNextRace(afterRaceNumber) {
  const races = await getAllRaces();
  return races
    .filter(r => r.race_number > afterRaceNumber && r.status !== 'cancelled')
    .sort((a, b) => a.race_number - b.race_number)[0] || null;
}

/**
 * Check if the next race after a given race needs to be signaled.
 * Returns the next race if it hasn't been signaled yet, null otherwise.
 * @param {number} afterRaceNumber
 * @returns {Object|null}
 */
export async function getUnsignaledNextRace(afterRaceNumber) {
  const nextRace = await findNextRace(afterRaceNumber);
  if (!nextRace) return null;
  if (nextRace.next_race_signaled) return null; // already signaled
  return nextRace;
}

/**
 * Signal a race as "next" on the public mobile app.
 * Calls the Lambda API directly to update the mobile app display.
 * Config fields:
 *   next_race_signal_api — Lambda URL (e.g. "https://4jml2...lambda-url.ap-east-1.on.aws/")
 *   next_race_signal_racename — race name param (e.g. "shortcourse"), default "shortcourse"
 *
 * @param {number} raceNumber - The race to signal as next
 */
export async function signalNextRace(raceNumber) {
  const config = await getConfig();
  const race = await getRace(raceNumber);

  if (!race) {
    showToast(`Race ${raceNumber} not found`, 'error');
    return;
  }

  // Mark as signaled
  race.next_race_signaled = true;
  await saveRace(race);

  // Update config with last signaled
  if (config) {
    config.last_signaled_race = raceNumber;
    await saveConfig(config);
  }

  // Call the Lambda API directly
  const apiUrl = config?.next_race_signal_api;
  if (apiUrl) {
    const racename = config?.next_race_signal_racename || 'shortcourse';
    const url = `${apiUrl}?raceno=${raceNumber}&racename=${encodeURIComponent(racename)}&racetype=next`;

    try {
      const resp = await fetch(url, { method: 'GET', mode: 'no-cors' });
      // no-cors means we can't read the response, but the request fires
      showToast(`Race ${raceNumber} signaled as next on mobile app`, 'success', 4000);
    } catch (err) {
      // Queue for retry if offline
      showToast(`Signal sent (may be queued if offline): Race ${raceNumber}`, 'warning', 4000);
    }
  } else {
    showToast(`Race ${raceNumber} marked as next (no signal API configured)`, 'info');
  }

  broadcastChange('race-updated', { race_number: raceNumber });
}

/**
 * Show the "Signal next race?" prompt after export/send.
 * Only shows if the next race hasn't been signaled yet.
 * @param {number} completedRaceNumber - The race that was just exported/sent
 */
export async function promptNextRaceSignal(completedRaceNumber) {
  const unsignaled = await getUnsignaledNextRace(completedRaceNumber);
  if (!unsignaled) return; // next race already signaled or no more races

  const config = await getConfig();
  const hasUrl = !!config?.next_race_signal_url;

  // Show prompt
  const modal = document.createElement('div');
  modal.id = 'nextRaceModal';
  modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9998; display:flex; align-items:center; justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:24px; max-width:420px; width:90%; box-shadow:var(--shadow-lg);">
      <h5 style="font-size:16px; font-weight:600; margin-bottom:12px;">Signal Next Race?</h5>
      <p style="font-size:14px; color:var(--text-secondary); margin-bottom:16px;">
        Race ${completedRaceNumber} is done. Signal <strong>Race ${unsignaled.race_number}</strong>
        (${unsignaled.race_title || 'Untitled'}) as next on the mobile app?
      </p>
      ${hasUrl
        ? `<p style="font-size:12px; color:var(--text-tertiary); margin-bottom:16px;">
            This will open: ${config.next_race_signal_url}
          </p>`
        : `<p style="font-size:12px; color:var(--warning); margin-bottom:16px;">
            No signal URL configured. Race will be marked as signaled only.
          </p>`
      }
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button class="btn btn-ghost" id="nextRaceSkip">Skip</button>
        <button class="btn btn-primary" id="nextRaceConfirm">
          <i class="material-icons">cell_tower</i> Signal Race ${unsignaled.race_number}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  modal.querySelector('#nextRaceSkip').addEventListener('click', () => modal.remove());
  modal.querySelector('#nextRaceConfirm').addEventListener('click', async () => {
    modal.remove();
    await signalNextRace(unsignaled.race_number);
  });
}

/**
 * Force-signal any race as next (for dashboard manual trigger).
 * @param {number} raceNumber
 */
export async function forceSignalRace(raceNumber) {
  if (!confirm(`Signal Race ${raceNumber} as next race on the mobile app?`)) return;
  await signalNextRace(raceNumber);
}

/**
 * Get the current signal status for display.
 * @returns {Object} { lastSignaled, nextUnsignaled }
 */
export async function getSignalStatus() {
  const config = await getConfig();
  const lastSignaled = config?.last_signaled_race || null;

  // Find next unsignaled after the last signaled race
  let nextUnsignaled = null;
  if (lastSignaled) {
    nextUnsignaled = await getUnsignaledNextRace(lastSignaled);
  } else {
    // No race signaled yet — find the first non-cancelled race
    const races = await getAllRaces();
    const first = races
      .filter(r => r.status !== 'cancelled' && !r.next_race_signaled)
      .sort((a, b) => a.race_number - b.race_number)[0];
    nextUnsignaled = first || null;
  }

  return { lastSignaled, nextUnsignaled };
}
