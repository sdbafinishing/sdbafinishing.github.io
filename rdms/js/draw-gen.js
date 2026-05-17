/**
 * SDBA RDMS — Next Round Draw Generation (Beta)
 * Generate draw sheets for subsequent rounds based on current results.
 * Uses division progression rules to determine which teams advance where.
 *
 * Output: .xls files to 13 Output_Next Round Draws/ + 80 Shared/{ref}_Next_Round_Draws/
 */
import * as XLSX from 'xlsx';
import { getConfig, getAllRaces, getLaneResults, getDivisionRounds, getDivisionProgressions, getAllDivisions } from './db.js';
import { showToast } from './utils.js';
import { writeToBoth, downloadFallback } from './file-access.js';

/**
 * Generate next round draw for a specific target race.
 * Looks up progression rules to find source races + position ranges,
 * pulls results, and builds the draw.
 *
 * @param {number} targetRaceNumber - The race to generate a draw for
 * @returns {Object} { success, filename, teams[] }
 */
export async function generateNextRoundDraw(targetRaceNumber) {
  const config = await getConfig();
  const divisions = await getAllDivisions();
  const laneCount = config?.lane_count || 6;
  const ref = config?.event_short_ref || 'RDMS';

  // Find which division/round this race belongs to
  let targetRound = null;
  let targetDivision = null;
  let progressionsToTarget = [];

  for (const div of divisions) {
    const rounds = await getDivisionRounds(div.id);
    const progs = await getDivisionProgressions(div.id);

    for (const round of rounds) {
      if ((round.race_numbers || []).includes(targetRaceNumber)) {
        targetRound = round;
        targetDivision = div;

        // Find progressions pointing TO this round
        progressionsToTarget = progs.filter(p => p.to_round_id === round.id);
        break;
      }
    }
    if (targetRound) break;
  }

  if (!targetRound) {
    showToast(`Race ${targetRaceNumber} not found in any division's round configuration`, 'warning');
    return { success: false };
  }

  if (progressionsToTarget.length === 0) {
    showToast(`No progression rules point to Race ${targetRaceNumber}. This may be a first-round race.`, 'warning');
    return { success: false };
  }

  // Collect qualifying teams from source races
  const teams = [];
  const allRounds = await getDivisionRounds(targetDivision.id);

  for (const prog of progressionsToTarget) {
    const fromRound = allRounds.find(r => r.id === prog.from_round_id);
    if (!fromRound) continue;

    const sourceRaces = fromRound.race_numbers || [];
    const posRange = prog.position_range || '1-3';

    for (const sourceRaceNum of sourceRaces) {
      const lanes = await getLaneResults(sourceRaceNum);
      const sorted = lanes
        .filter(l => l.computed_position != null)
        .sort((a, b) => a.computed_position - b.computed_position);

      // Parse position range
      let qualifiers;
      if (posRange.toLowerCase() === 'all') {
        qualifiers = sorted;
      } else if (posRange === 'rest') {
        // "rest" means everyone not covered by explicit ranges — skip for now
        qualifiers = sorted;
      } else {
        const [start, end] = posRange.split('-').map(Number);
        qualifiers = sorted.filter(l => l.computed_position >= start && l.computed_position <= end);
      }

      qualifiers.forEach(l => {
        teams.push({
          team_name: l.team_name || '',
          team_code: l.team_code || '',
          source_race: sourceRaceNum,
          source_position: l.computed_position,
          designation: `R${sourceRaceNum}P${l.computed_position}`,
        });
      });
    }
  }

  if (teams.length === 0) {
    showToast(`No qualifying teams found for Race ${targetRaceNumber}. Check that source races have results.`, 'warning');
    return { success: false };
  }

  // Build .xls draw sheet
  const wsData = [];
  const raceTitle = `Race ${targetRaceNumber} — ${targetRound.tier_name || ''} (Generated)`;
  wsData.push([raceTitle]);
  wsData.push(['BOAT', 'Team Name', 'Code']);

  for (let i = 0; i < laneCount; i++) {
    const team = teams[i];
    wsData.push([
      i + 1,
      team ? team.team_name : '',
      team ? team.team_code : '',
    ]);
  }

  // Add note about source
  wsData.push([]);
  wsData.push([`Generated from: ${teams.map(t => t.designation).join(', ')}`]);

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Draw');

  const filename = `${targetRaceNumber}.xls`;
  const xlsBlob = new Blob([XLSX.write(wb, { bookType: 'xls', type: 'array' })]);

  // Write to 13 Output_Next Round Draws/ + 80 Shared
  const { local, shared } = await writeToBoth(
    '13 Output_Next Round Draws', filename, xlsBlob,
    `80 Shared/${ref}_Next_Round_Draws`
  );

  if (!local) downloadFallback(filename, xlsBlob);

  showToast(`Draw generated for Race ${targetRaceNumber} (${teams.length} teams)`, 'success');
  return { success: true, filename, teams };
}
