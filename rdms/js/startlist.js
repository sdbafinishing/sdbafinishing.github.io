/**
 * SDBA RDMS — Start List Generation
 * Generate Joyi Start List (.xls) and SprintTimer Start List (.csv).
 * Output to both local 02/ folder (download) and Drive share folder.
 */
import * as XLSX from 'xlsx';
import { getConfig, getAllRaces, getLaneResults } from './db.js';
import { showToast, rowsToCsvBlob } from './utils.js';
import { writeToBoth, downloadFallback } from './file-access.js';

/**
 * Generate Joyi Start List (.xls) and trigger download.
 * Format: One continuous sheet with all races.
 * Each race block: race ID (4-digit), lane number, team code, team name.
 * Plus 5 dummy races (9991-9995) for testing.
 */
export async function generateJoyiStartList() {
  const config = await getConfig();
  const races = await getAllRaces();
  const sortedRaces = races.filter(r => r.status !== 'cancelled').sort((a, b) => a.race_number - b.race_number);

  if (sortedRaces.length === 0) {
    showToast('No races loaded. Import draws first.', 'warning');
    return;
  }

  const laneCount = config?.lane_count || 6;
  const eventRef = config?.event_short_ref || 'RDMS';
  const eventName = config?.event_long_name_en || 'Race Event';
  const raceDate = config?.race_date || '';

  const wsData = [];

  // Header — matches the Joyi reference template (99 Reference/
  // Joyi_StartList_<RACEREF>_<RACEDATE>.xls). The labels in row 2 and
  // column headers in row 3 are what Joyi expects to find; the legacy
  // VBA tool wrote these and our flat output was missing them.
  wsData.push([eventName]);
  wsData.push(['考点：', '', '', '项目：', `.（${eventRef}）`]);
  wsData.push(['组号', '道次', '准考证号', '姓名']);

  // Generate race blocks
  const allRaceNums = [...sortedRaces.map(r => r.race_number), 9991, 9992, 9993, 9994, 9995];

  for (const raceNum of allRaceNums) {
    const isDummy = raceNum >= 9991;
    const lanes = isDummy ? [] : await getLaneResults(raceNum);

    for (let i = 0; i < laneCount; i++) {
      const lane = lanes.find(l => l.lane_number === i + 1);
      wsData.push([
        String(raceNum).padStart(4, '0'), // Race ID
        i + 1,                             // Lane number
        isDummy ? '' : (lane?.team_code || ''),
        isDummy ? `Test Team ${i + 1}` : (lane?.team_name || ''),
      ]);
    }
  }

  // Create workbook
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'StartList');

  const filename = `Joyi_StartList_${eventRef}_${raceDate}.xls`;

  // Write to 11 Output_Start Lists/ (local) + 80 Shared/{ref}_Joyi/ (shared with Joyi team)
  const xlsBlob = new Blob([XLSX.write(wb, { bookType: 'xls', type: 'array' })]);
  const { local, shared } = await writeToBoth(
    '11 Output_Start Lists', filename, xlsBlob,
    `80 Shared/${eventRef}_Joyi`
  );
  if (!local) downloadFallback(filename, xlsBlob);

  showToast(`Joyi Start List saved: ${filename}`, 'success');
  return filename;
}

/**
 * Generate SprintTimer Start List (.csv) and trigger download.
 * Format per race:
 *   {REF}_R{N},,,{NNNN}   (header line)
 *   ,{lane},,              (one per lane)
 *   #,,,                   (separator)
 */
export async function generateSprintTimerStartList() {
  const config = await getConfig();
  const races = await getAllRaces();
  const sortedRaces = races.filter(r => r.status !== 'cancelled').sort((a, b) => a.race_number - b.race_number);

  if (sortedRaces.length === 0) {
    showToast('No races loaded. Import draws first.', 'warning');
    return;
  }

  const laneCount = config?.lane_count || 6;
  const eventRef = config?.event_short_ref || 'RDMS';
  const raceDate = config?.race_date || '';

  const lines = [];
  const allRaceNums = [...sortedRaces.map(r => r.race_number), 9991, 9992, 9993, 9994, 9995];

  for (const raceNum of allRaceNums) {
    // Header line
    lines.push(`${eventRef}_R${raceNum},,,${String(raceNum).padStart(4, '0')}`);

    // Lane lines
    for (let i = 1; i <= laneCount; i++) {
      lines.push(`,${i},,`);
    }

    // Separator
    lines.push('#,,,');
  }

  const filename = `SprintTimer_Start_List_${eventRef}_${raceDate}.csv`;

  // Use the shared UTF-8 CSV helper so the file opens cleanly in Excel/Numbers
  // (BOM-prefixed, text/csv;charset=utf-8). The pre-built `lines` array has
  // commas baked in, so re-parse to a rows matrix before handing it over.
  const rowsMatrix = lines.map(l => l.split(','));
  const csvBlob = rowsToCsvBlob(rowsMatrix);
  const { local } = await writeToBoth('11 Output_Start Lists', filename, csvBlob);
  if (!local) downloadFallback(filename, csvBlob);

  showToast(`SprintTimer Start List saved: ${filename}`, 'success');
  return filename;
}
