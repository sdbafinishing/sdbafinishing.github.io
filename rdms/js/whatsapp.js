/**
 * SDBA RDMS — WhatsApp Integration
 * Generate formatted message, copy to clipboard, open WhatsApp Web.
 */
import { getConfig, getRace, getLaneResults } from './db.js';
import { timeToDisplay, showToast } from './utils.js';

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

  // Dedicated share URL preferred; falls back to legacy "url stuffed
  // into shared_results_folder" behavior for old configs.
  const resultsLink = (config?.shared_results_url || '').trim()
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
          Preparing clipboard… paste into your WhatsApp group. The race is
          recorded as sent now (when this dialog appeared).
        </p>
        <textarea id="waMsgBox" readonly style="
          width:100%; min-height:90px; max-height:200px; resize:vertical;
          padding:10px 12px; font-family:monospace; font-size:13px;
          background:var(--bg-elev); border:1px solid var(--border);
          border-radius:var(--radius-sm); color:var(--text-primary);
          margin-bottom:12px;"></textarea>
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          <button class="btn btn-ghost" id="waCopyBtn"
                  title="If the auto-copy got blocked, click here to copy again">
            <i class="material-icons" style="font-size:16px;">content_copy</i> Copy again
          </button>
          <button class="btn btn-primary" id="waCloseBtn">OK</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const textarea = modal.querySelector('#waMsgBox');
    textarea.value = message;
    textarea.focus();
    textarea.select();

    // Copy to clipboard automatically — the operator shouldn't have to
    // click an extra button. They just need to paste. If the browser
    // blocks the auto-clipboard write (some require explicit user
    // gesture), the Copy button below stays as a fallback.
    let autoCopied = false;
    (async () => {
      try {
        await navigator.clipboard.writeText(message);
        autoCopied = true;
        const hint = modal.querySelector('#waCopyHint');
        if (hint) hint.innerHTML = '<i class="material-icons" style="font-size:14px; vertical-align:middle; color:var(--success);">done</i> Copied to clipboard — paste into WhatsApp.';
      } catch {
        // Pre-select stays in effect so Cmd/Ctrl+C still works.
      }
    })();

    const cleanup = () => { modal.remove(); resolve(); };

    modal.querySelector('#waCopyBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(message);
        showToast('Copied again.', 'success', 1500);
      } catch {
        textarea.select();
        showToast('Clipboard blocked — select the text above and Cmd/Ctrl+C.', 'warning', 4000);
      }
    });
    modal.querySelector('#waCloseBtn').addEventListener('click', cleanup);
    modal.addEventListener('click', (e) => { if (e.target === modal) cleanup(); });
  });
}
