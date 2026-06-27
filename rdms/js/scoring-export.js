/**
 * SDBA RDMS — Overall-ranks export (Scoring tab)
 *
 * Exports just the division's overall standings — Rank / Team / Code /
 * per-round breakdown / Total — as a standalone .xlsx for the scoring team.
 * Works for every method (points / time_sum / time_combined) via the canonical
 * computeDivisionStanding. Built programmatically with SheetJS (no template).
 */
import * as XLSX from 'xlsx';
import { getConfig, getAllRaces, getAllDivisions, getDivisionRounds, getLaneResults } from './db.js';
import { computeDivisionStanding, computeTieredStanding, formatTotalTime } from './division-standing.js';
import { writeToBoth, downloadFallback } from './file-access.js';

const FLAG_ORDER = { R1: 1, R2: 2, RFinal: 3 };

export async function exportOverallRanks(divId) {
  const config = await getConfig();
  const laneCount = config?.lane_count || 6;
  const timeMode = config?.time_format_mode || 'mss00';
  const ref = config?.event_short_ref || 'RDMS';

  const division = (await getAllDivisions()).find(d => d.id === parseInt(divId, 10)) || null;
  if (!division) return { success: false, error: 'Division not found.' };

  const scoredRaces = (await getAllRaces())
    .filter(r => r.division_id === division.id && r.scoring_flag && r.scoring_flag !== 'N')
    .sort((a, b) => (FLAG_ORDER[a.scoring_flag] || 9) - (FLAG_ORDER[b.scoring_flag] || 9));
  if (!scoredRaces.length) return { success: false, error: 'No scored races in this division.' };

  const lanesByRace = new Map();
  for (const r of scoredRaces) lanesByRace.set(r.race_number, await getLaneResults(r.race_number));
  const rounds = await getDivisionRounds(division.id);

  // Tiered division (Gold/Silver/Bronze + Bowl): export Tier · Section · Overall.
  if ((rounds || []).some(r => r.tier_order != null && r.tier_order > 0)) {
    const tiered = computeTieredStanding(division, rounds, scoredRaces, lanesByRace, laneCount, timeMode);
    if (!tiered) return { success: false, error: 'Nothing to rank yet.' };
    const aoa = [
      [division.division_name || 'Division', '', '', '', tiered.complete ? '' : 'PROVISIONAL'],
      ['Tier', 'Section rank', 'Team', 'Code', 'Time', 'Overall rank'],
    ];
    for (const tier of tiered.tiers) {
      const rows = tier.rows.slice().sort((a, b) => (a.section_rank ?? 9999) - (b.section_rank ?? 9999));
      for (const row of rows) {
        aoa.push([
          tier.tier_name,
          row.section_rank ?? '',
          row.team_name || '',
          row.team_code || '',
          row.value_display || '',
          row.overall_rank == null ? 'TBC' : row.overall_rank,
        ]);
      }
    }
    return await writeStandingsXlsx(division, ref, aoa, tiered.complete);
  }

  const standing = computeDivisionStanding(division, rounds, scoredRaces, lanesByRace, laneCount, timeMode);
  if (!standing) return { success: false, error: 'Nothing to rank yet.' };

  const method = standing.method;
  const totalLabel = method === 'points' ? 'Total Score'
    : method === 'time_sum' ? 'Total Time'
      : 'Final (combined time)';
  const roundCols = scoredRaces.map(r => `${r.scoring_flag} (R${r.race_number})`);

  // A cell for one team's result in one race, per method.
  const roundCell = (t, r) => {
    const pr = t.perRound?.[r.scoring_flag] ?? t.perRound?.[r.race_number];
    if (!pr) return '';
    if (method === 'points') return pr.pts != null ? String(pr.pts) : '';
    const ms = pr.exported_ms ?? pr.time_ms;
    return ms != null ? `${formatTotalTime(ms)} (${pr.position ?? ''})` : '';
  };

  const teams = [...standing.teamTotals.values()]
    .sort((a, b) => (a.total_place ?? 9999) - (b.total_place ?? 9999));

  const aoa = [
    [division.division_name || 'Division', '', '', ...roundCols.map(() => ''), standing.complete ? '' : 'PROVISIONAL'],
    ['Rank', 'Team', 'Code', ...roundCols, totalLabel],
    ...teams.map(t => [
      t.total_place ?? '',
      t.team_name || '',
      t.team_code || '',
      ...scoredRaces.map(r => roundCell(t, r)),
      standing.complete ? (t.total_display || '') : 'TBC',
    ]),
  ];

  return await writeStandingsXlsx(division, ref, aoa, standing.complete);
}

/** Build the standings .xlsx from an array-of-arrays + write it (or download). */
async function writeStandingsXlsx(division, ref, aoa, complete) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Overall');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  const safe = (division.division_name || 'division').replace(/[^\w\-]+/g, '_');
  const filename = `${ref}_${safe}_overall_ranks.xlsx`;
  const { local, shared } = await writeToBoth('14 Output_Scoring', filename, blob, `80 Shared/${ref}_Scoring`);
  if (!local && !shared) downloadFallback(filename, blob);

  return { success: true, filename, complete };
}
