/**
 * SDBA RDMS — Round Completion Detection
 *
 * After a race is exported, check whether its round is now fully done
 * (every race in the same division+round is exported/sent or cancelled).
 * If so, identify the next-round races that still hold unresolved
 * R{n}P{n} placeholders and surface them to the operator.
 *
 * Two consumers:
 *   1. export.js — fires `checkRoundCompletionAfterExport(raceNumber)`
 *      after a successful export. When `config.next_round_draw_enabled`
 *      is on AND a round just completed AND next-round races have
 *      placeholders → shows the auto-prompt modal.
 *   2. import-page.js (Generate Next Round Draws tab) — calls
 *      `summariseDivisions()` to render the per-division status grid.
 *
 * Idempotence: once the operator has chosen "Generate" or "Skip" for a
 * given round, we don't re-prompt until something materially changes
 * (i.e. the round un-completes via a Reset start somewhere). The
 * suppression key lives in sessionStorage so reloading the app brings
 * it back; we deliberately don't persist it across sessions because
 * yesterday's "skip" probably isn't this morning's intent.
 */
import { getAllDivisions, getAllRaces, getDivisionRounds, getDivisionProgressions, getConfig } from './db.js';
import { findPlaceholdersForRace, generateNextRoundDraws } from './draw-gen.js';
import { showToast } from './utils.js';
import { broadcastChange } from './app.js';

const PROMPT_SUPPRESS_PREFIX = 'rdms-round-prompted:';

const STATUS_COMPLETE_VALUES = new Set(['exported', 'sent']);
const STATUS_SKIP_VALUES     = new Set(['cancelled']);

/**
 * Snapshot of one division's round-completion state. Used by the
 * Generate Next Round Draws tab to render its per-division grid.
 *
 * @typedef {Object} DivisionRoundStatus
 * @property {number} division_id
 * @property {string} division_name
 * @property {string} colour
 * @property {Array<RoundStatus>} rounds
 *
 * @typedef {Object} RoundStatus
 * @property {number} round_id
 * @property {number} round_number
 * @property {string} tier_name
 * @property {number} total            number of races in this round
 * @property {number} complete         exported/sent/cancelled count
 * @property {boolean} isComplete      complete === total
 * @property {Array<NextRaceState>} nextRaces   races in the NEXT round that
 *           depend on this round's results (filtered to those with
 *           unresolved placeholders pointing at races IN this round).
 */
export async function summariseDivisions() {
  const [divisions, races] = await Promise.all([getAllDivisions(), getAllRaces()]);
  const raceMap = new Map(races.map(r => [r.race_number, r]));
  const out = [];

  for (const div of divisions) {
    const rounds = await getDivisionRounds(div.id);
    const progs  = await getDivisionProgressions(div.id);
    rounds.sort((a, b) => (a.round_number || 0) - (b.round_number || 0));

    const roundsOut = [];
    for (const round of rounds) {
      const raceNums = round.race_numbers || [];
      let complete = 0;
      for (const rn of raceNums) {
        const r = raceMap.get(rn);
        if (!r) continue;
        if (STATUS_COMPLETE_VALUES.has(r.status) || STATUS_SKIP_VALUES.has(r.status)) complete++;
      }
      const isComplete = complete === raceNums.length && raceNums.length > 0;

      // Next-round dependents: progressions whose from_round_id === this
      // round. We then expand to actual race numbers via the destination
      // round's race_numbers list.
      const nextRaceNumbers = new Set();
      for (const p of progs.filter(p => p.from_round_id === round.id)) {
        const toRound = rounds.find(r => r.id === p.to_round_id);
        if (!toRound) continue;
        for (const rn of (toRound.race_numbers || [])) nextRaceNumbers.add(rn);
      }
      // Of those next-round races, keep only the ones still holding
      // placeholders (resolved races don't need action).
      const nextRaces = [];
      for (const rn of nextRaceNumbers) {
        const placeholders = await findPlaceholdersForRace(rn);
        if (placeholders.length === 0) continue;
        const r = raceMap.get(rn);
        nextRaces.push({
          race_number: rn,
          race_title: r?.race_title || '',
          placeholder_count: placeholders.length,
        });
      }

      roundsOut.push({
        round_id: round.id,
        round_number: round.round_number,
        tier_name: round.tier_name || `Round ${round.round_number}`,
        total: raceNums.length,
        complete,
        isComplete,
        nextRaces,
      });
    }

    out.push({
      division_id: div.id,
      division_name: div.div_short_ref || div.division_name || `Division ${div.id}`,
      colour: div.colour_hex || '#9ca3af',
      rounds: roundsOut,
    });
  }
  return out;
}

/**
 * Find the round containing a given race. Returns null if the race isn't
 * slotted into any round yet — the audit's "race.no_round" / "race.no_division"
 * findings cover that situation; here we just bail.
 */
async function findRoundForRace(raceNumber) {
  const divisions = await getAllDivisions();
  for (const div of divisions) {
    const rounds = await getDivisionRounds(div.id);
    for (const round of rounds) {
      if ((round.race_numbers || []).includes(raceNumber)) {
        return { division: div, round };
      }
    }
  }
  return null;
}

/**
 * Called from export.js after a successful export. Fires the auto-prompt
 * modal if the round just completed and the config has the auto-prompt
 * checkbox enabled.
 *
 * Fire-and-forget — never throws, never blocks the export flow.
 *
 * @param {number} exportedRaceNumber
 */
export async function checkRoundCompletionAfterExport(exportedRaceNumber) {
  try {
    const config = await getConfig();
    if (!config?.next_round_draw_enabled) return;

    const found = await findRoundForRace(exportedRaceNumber);
    if (!found) return;
    const { division, round } = found;

    // Is the round fully complete?
    const races = await getAllRaces();
    const raceMap = new Map(races.map(r => [r.race_number, r]));
    const memberRaces = (round.race_numbers || []).map(rn => raceMap.get(rn)).filter(Boolean);
    if (memberRaces.length === 0) return;
    const allDone = memberRaces.every(r =>
      STATUS_COMPLETE_VALUES.has(r.status) || STATUS_SKIP_VALUES.has(r.status));
    if (!allDone) return;

    // Suppression key: division + round. Once the operator has answered
    // the prompt for this round, don't ask again in this session.
    const key = `${PROMPT_SUPPRESS_PREFIX}${division.id}:${round.id}`;
    if (sessionStorage.getItem(key)) return;

    // Find next-round races with placeholders.
    const progs = await getDivisionProgressions(division.id);
    const allRounds = await getDivisionRounds(division.id);
    const nextRoundIds = progs.filter(p => p.from_round_id === round.id).map(p => p.to_round_id);
    const nextRaceNumbers = new Set();
    for (const rid of nextRoundIds) {
      const r = allRounds.find(x => x.id === rid);
      for (const rn of (r?.race_numbers || [])) nextRaceNumbers.add(rn);
    }
    const targets = [];
    for (const rn of nextRaceNumbers) {
      const ph = await findPlaceholdersForRace(rn);
      if (ph.length > 0) targets.push({ race_number: rn, placeholder_count: ph.length });
    }
    if (targets.length === 0) return; // nothing to do — silently skip

    // Mark prompted now (idempotent guard).
    sessionStorage.setItem(key, '1');
    showAutoPrompt(division, round, targets);
  } catch (err) {
    // Round-completion checks are advisory — never let them break export.
    console.warn('checkRoundCompletionAfterExport failed', err);
  }
}

function showAutoPrompt(division, round, targets) {
  const existing = document.getElementById('rdmsRoundCompleteModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'rdmsRoundCompleteModal';
  modal.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9998; display:flex; align-items:center; justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:24px; max-width:440px; width:92%; box-shadow:var(--shadow-lg);">
      <h5 style="font-size:16px; font-weight:600; margin-bottom:8px;">
        <i class="material-icons" style="vertical-align:middle; color:var(--success);">check_circle</i>
        Round complete — generate next-round draws?
      </h5>
      <p style="font-size:13px; color:var(--text-secondary); margin-bottom:12px;">
        Every race in <strong>${escapeHtml(division.div_short_ref || division.division_name || '')} ·
        ${escapeHtml(round.tier_name || ('Round ' + round.round_number))}</strong> has been exported.
        ${targets.length} next-round race${targets.length === 1 ? '' : 's'} still hold R{n}P{n}
        placeholders waiting on these results.
      </p>
      <ul style="font-size:12px; color:var(--text-secondary); padding-left:18px; margin-bottom:14px; max-height:160px; overflow-y:auto;">
        ${targets.map(t => `<li>Race ${t.race_number} — ${t.placeholder_count} placeholder${t.placeholder_count === 1 ? '' : 's'}</li>`).join('')}
      </ul>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button class="btn btn-ghost" id="rcSkip">Skip</button>
        <button class="btn btn-primary" id="rcGenerate">
          <i class="material-icons">auto_fix_high</i> Generate ${targets.length} draw${targets.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector('#rcSkip').addEventListener('click', () => modal.remove());
  modal.querySelector('#rcGenerate').addEventListener('click', async () => {
    modal.querySelector('#rcGenerate').disabled = true;
    const { summaries, totalResolved } = await generateNextRoundDraws(targets.map(t => t.race_number));
    modal.remove();
    const partial = summaries.filter(s => s.skipped > 0).length;
    showToast(
      `Resolved ${totalResolved} placeholder${totalResolved === 1 ? '' : 's'} across ${summaries.length} race${summaries.length === 1 ? '' : 's'}` +
      (partial > 0 ? ` (${partial} partial — see warnings)` : ''),
      partial > 0 ? 'warning' : 'success',
      5000,
    );
    broadcastChange('draw-imported');
  });
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
