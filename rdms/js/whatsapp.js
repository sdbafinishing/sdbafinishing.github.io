/**
 * SDBA RDMS — WhatsApp Integration
 * Generate formatted message, copy to clipboard, open WhatsApp Web.
 */
import { getConfig, getRace, getLaneResults } from './db.js';
import { computeRankings } from './race.js';
import { timeToDisplay, showToast } from './utils.js';

/**
 * Build the finishing sequence string for a quick eyeball check, e.g.
 * "2-5-6-3-1-4-7-8" — boat/draw lane numbers (lane_input) in finish order.
 *
 * Re-ranks from raw_time exactly as the export does (same time mode + batch
 * delta) so the sequence shown matches the exported result, not whatever
 * stale computed_position happens to sit in the DB rows. DSQ/DNS/DNF/no-time
 * rows have no computed_position and are dropped. Returns '' when nothing is
 * rankable yet.
 *
 * @param {number} raceNumber
 * @returns {Promise<string>}
 */
export async function getFinishingSequence(raceNumber) {
  const config = await getConfig();
  const race = await getRace(raceNumber);
  if (!race) return '';
  const lanes = await getLaneResults(raceNumber);
  const exportDelta = race.batch_override_enabled ? (race.batch_delta_ms || 0) : 0;
  computeRankings(lanes, config?.time_format_mode || 'mss00', exportDelta);
  return lanes
    .filter(l => l.computed_position != null)
    .sort((a, b) => a.computed_position - b.computed_position)
    .map(l => l.lane_input || l.lane_number)
    .join('-');
}

/**
 * Generate a WhatsApp-formatted results message for a race.
 * @param {number} raceNumber
 * @returns {string} Formatted message text
 */
export async function generateWhatsAppMessage(raceNumber) {
  const config = await getConfig();
  const race = await getRace(raceNumber);

  if (!race) throw new Error(`Race ${raceNumber} not found`);

  const isRevision = race.export_version > 1;

  // Minimal message — link + race title + revision marker. The full
  // results table lives in the .xls in the shared folder; the operator
  // pastes the link, recipients click through to read details. Keeps
  // WhatsApp body short and avoids redundant data.
  let msg = isRevision
    ? `Race ${raceNumber} — REVISED Result (v${race.export_version})`
    : `Race ${raceNumber} — Result`;

  if (race.race_title) msg += `\n${race.race_title}`;

  // Per-race DIRECT-DOWNLOAD link (#4) preferred — set on export when the Drive
  // API wrote the file (one-click download for the scoring team). Falls back to
  // the dedicated share URL, then the legacy "url stuffed into
  // shared_results_folder" behavior for old configs.
  const resultsLink = (race?.result_direct_url || '').trim()
    || (config?.shared_results_url || '').trim()
    || ((config?.shared_results_folder || '').startsWith('http')
         ? config.shared_results_folder
         : '');
  if (resultsLink) msg += `\n${resultsLink}`;

  return msg;
}

/**
 * Show the operator a modal containing the generated WhatsApp message
 * plus a Copy button. Caller treats this race as "sent" the moment
 * the modal is shown (per operator preference — opening the modal
 * means they're about to paste it, so the timestamp should reflect
 * that intent, not the OK click).
 *
 * Returns a Promise that resolves when the operator closes the modal.
 * The caller can chain follow-ups (next-race signal, etc.) on that
 * resolution.
 *
 * @param {number} raceNumber
 * @returns {Promise<void>}
 */
export async function sendToWhatsApp(raceNumber) {
  const config = await getConfig();
  if (!config?.whatsapp_group) {
    // No group configured isn't fatal — operator can still copy +
    // paste manually. Just inform them once.
    showToast('WhatsApp group not configured — message will still be copied for manual paste.', 'info', 3500);
  }

  let message;
  try {
    message = await generateWhatsAppMessage(raceNumber);
  } catch (err) {
    showToast(`WhatsApp error: ${err.message}`, 'error');
    return;
  }

  // Finishing sequence for the operator's eyeball check before sending —
  // glance the order without parsing every time. Best-effort: never block
  // the send if it can't be computed.
  let finishSeq = '';
  try { finishSeq = await getFinishingSequence(raceNumber); } catch { /* non-fatal */ }

  return new Promise((resolve) => {
    // Remove any orphaned modal from a prior aborted send.
    const existing = document.getElementById('rdmsWhatsAppModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'rdmsWhatsAppModal';
    modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9998; display:flex; align-items:center; justify-content:center; padding:20px;';
    modal.innerHTML = `
      <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:20px 22px; max-width:520px; width:100%; box-shadow:var(--shadow-lg);">
        <h5 style="font-size:16px; font-weight:600; margin:0 0 6px;">
          <i class="material-icons" style="vertical-align:middle; color:var(--success);">chat</i>
          WhatsApp message ready
        </h5>
        <p id="waCopyHint" style="font-size:12px; color:var(--text-secondary); margin:0 0 10px;">
          Click <strong>Copy message</strong>, then paste into your WhatsApp group.
          The race is recorded as sent now (when this dialog appeared).
        </p>
        ${finishSeq ? `
        <div style="display:flex; align-items:center; gap:8px; margin:0 0 12px; padding:10px 12px;
                    background:var(--bg-elev); border:1px solid var(--border);
                    border-radius:var(--radius-sm);">
          <span style="font-size:11px; font-weight:700; text-transform:uppercase;
                       letter-spacing:0.5px; color:var(--text-tertiary);">Finishing sequence</span>
          <span style="font-family:monospace; font-size:18px; font-weight:700;
                       letter-spacing:1px; color:var(--text-primary);">${finishSeq}</span>
        </div>` : ''}
        <textarea id="waMsgBox" readonly style="
          width:100%; min-height:90px; max-height:200px; resize:vertical;
          padding:10px 12px; font-family:monospace; font-size:13px;
          background:var(--bg-elev); border:1px solid var(--border);
          border-radius:var(--radius-sm); color:var(--text-primary);
          margin-bottom:12px;"></textarea>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button class="btn btn-ghost" id="waCloseBtn">Close</button>
          <button class="btn btn-primary" id="waCopyBtn">
            <i class="material-icons" style="font-size:16px;">content_copy</i> Copy message
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const textarea = modal.querySelector('#waMsgBox');
    textarea.value = message;
    const hint = modal.querySelector('#waCopyHint');
    const copyBtn = modal.querySelector('#waCopyBtn');

    const markCopied = () => {
      if (hint) hint.innerHTML = '<i class="material-icons" style="font-size:14px; vertical-align:middle; color:var(--success);">done</i> Copied to clipboard — paste into WhatsApp.';
      copyBtn.innerHTML = '<i class="material-icons" style="font-size:16px;">done</i> Copied';
    };

    // Try to auto-copy, but DON'T trust it: the modal is often opened by the
    // auto-export flow (a folder-watch tick), which has no user activation, so
    // the browser silently rejects clipboard writes — leaving the PREVIOUS
    // race's text on the clipboard. So "Copy message" is a prominent one-click
    // (user-gesture) action that always works, and the hint tells the operator
    // to use it. Pre-select the text too so Cmd/Ctrl+C is available.
    textarea.focus();
    textarea.select();
    (async () => {
      try {
        await navigator.clipboard.writeText(message);
        markCopied(); // only reached when the browser actually allowed it
      } catch {
        // No activation — operator must click Copy. Hint already says so.
        textarea.select();
      }
    })();

    const cleanup = () => { modal.remove(); resolve(); };

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(message); // user gesture → reliable
        markCopied();
        showToast('Copied — paste into WhatsApp.', 'success', 1500);
      } catch {
        textarea.select();
        showToast('Clipboard blocked — select the text above and press Cmd/Ctrl+C.', 'warning', 4000);
      }
    });
    modal.querySelector('#waCloseBtn').addEventListener('click', cleanup);
    modal.addEventListener('click', (e) => { if (e.target === modal) cleanup(); });
  });
}
