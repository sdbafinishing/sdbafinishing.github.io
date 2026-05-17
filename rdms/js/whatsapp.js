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
  const lanes = await getLaneResults(raceNumber);
  const timeMode = config?.time_format_mode || 'mss00';

  if (!race) throw new Error(`Race ${raceNumber} not found`);

  const eventRef = config?.event_short_ref || '';
  const isRevision = race.export_version > 1;

  // Sort by position
  const ranked = lanes
    .filter(l => l.computed_position != null)
    .sort((a, b) => a.computed_position - b.computed_position);

  const remarked = lanes.filter(l => l.remarks && ['DNF', 'DSQ', 'DNS', 'DQ'].includes(l.remarks));

  let msg = '';

  if (isRevision) {
    msg += `Race ${raceNumber} - REVISED Result (v${race.export_version})`;
  } else {
    msg += `Race ${raceNumber} - Result`;
  }

  // Include results link in WhatsApp message (only if it's a URL, not a local path)
  const resultsLink = config?.shared_results_folder || '';
  if (resultsLink.startsWith('http')) {
    msg += ` - ${resultsLink}`;
  }

  msg += '\n';
  msg += `${race.race_title || ''}\n\n`;

  // Results table
  ranked.forEach(lr => {
    const time = timeToDisplay(lr.raw_time, timeMode);
    const penalty = lr.penalty_time ? ` (TP=${lr.penalty_time}s)` : '';
    msg += `${lr.computed_position}. ${lr.team_name || lr.team_code || `Lane ${lr.lane_number}`} - ${time}${penalty}\n`;
  });

  // DNF/DSQ/DNS/DQ
  if (remarked.length > 0) {
    msg += '\n';
    remarked.forEach(lr => {
      msg += `${lr.team_name || lr.team_code || `Lane ${lr.lane_number}`}: ${lr.remarks}\n`;
    });
  }

  return msg;
}

/**
 * Copy message to clipboard and open WhatsApp Web.
 * @param {number} raceNumber
 */
export async function sendToWhatsApp(raceNumber) {
  const config = await getConfig();

  // Check WhatsApp group configured (VBA: "WhatsApp Group not configured. Please send results manually")
  if (!config?.whatsapp_group) {
    showToast('WhatsApp group not configured. Please send results manually.', 'warning', 5000);
    // Still generate and copy the message for manual send
  }

  try {
    const message = await generateWhatsAppMessage(raceNumber);

    // Copy to clipboard
    await navigator.clipboard.writeText(message);
    showToast('Message copied to clipboard! Paste in WhatsApp.', 'success', 4000);

    // Open WhatsApp Web
    window.open('https://web.whatsapp.com', '_blank');
  } catch (err) {
    showToast(`WhatsApp error: ${err.message}`, 'error');
  }
}
