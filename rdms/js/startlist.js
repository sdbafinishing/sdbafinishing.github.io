/**
 * SDBA RDMS — Start List Generation
 * Generate Joyi Start List (.xls) and SprintTimer Start List (.csv).
 * Output to both local 02/ folder (download) and Drive share folder.
 */
import * as XLSX from 'xlsx';
import * as CFBmod from 'cfb';
import { getConfig, getAllRaces, getLaneResults, getRace } from './db.js';
import { showToast, rowsToCsvBlob } from './utils.js';
import { writeToBoth, downloadFallback } from './file-access.js';

const CFB = CFBmod.default || CFBmod;

// Excel BIFF8 workbook CLSID — {00020820-0000-0000-C000-000000000046},
// stored little-endian as the OLE2 root-entry class id.
const EXCEL_WORKBOOK_CLSID = '2008020000000000c000000000000046';

/**
 * Re-stamp the OLE2 container envelope SheetJS produces so Joyi's BIFF8
 * reader accepts the .xls.
 *
 * SheetJS writes the compound-file root entry named "R" with an all-zero
 * CLSID (plus a private "\x01Sh33tJ5" marker stream). Real Excel — and the
 * file Joyi accepts — names the root "Root Entry" and stamps the Excel
 * workbook CLSID. Joyi keys on that standard envelope, so the SheetJS
 * default is silently rejected. We learned this by diffing a generated
 * file (rejected) against the same file re-saved by Excel (accepted): the
 * only meaningful difference was the root name + CLSID.
 *
 * This rewrites only the directory envelope — the Workbook stream (BIFF
 * records, SST, sheet name) is untouched, so the file stays byte-for-byte
 * valid for SheetJS too. Wrapped in try/catch: a cosmetic envelope fix
 * must never block the export.
 *
 * @param {ArrayBuffer|Uint8Array} written - XLSX.write(..., {type:'array'})
 * @returns {Uint8Array}
 */
function fixXlsEnvelopeForJoyi(written) {
  const u8 = written instanceof Uint8Array ? written : new Uint8Array(written);
  try {
    const cont = CFB.parse(u8, { type: 'array' });
    const root = cont.FileIndex.find(f => f.type === 5);
    if (!root) return u8;
    root.name = 'Root Entry';
    root.clsid = EXCEL_WORKBOOK_CLSID;
    cont.FullPaths = cont.FullPaths.map(p =>
      p.replace(/^R\//, 'Root Entry/').replace(/^R$/, 'Root Entry'));
    const out = CFB.write(cont, { type: 'array' });
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  } catch {
    return u8; // never block the export on the envelope fix
  }
}

// Resolve "team in boat lane X for race R". Prefers race.draw_lanes
// (the draw-time snapshot that survives Joyi imports), falling back to
// lane_results.team_name for legacy races without the field. Returns
// `{ team_name, team_code }` — both strings, possibly empty.
async function teamInLaneForRace(raceNumber, laneNumber, laneResultsCache) {
  const race = await getRace(raceNumber);
  if (Array.isArray(race?.draw_lanes) && race.draw_lanes.length > 0) {
    const dl = race.draw_lanes.find(d => d.lane_number === laneNumber);
    return { team_name: dl?.team_name || '', team_code: dl?.team_code || '' };
  }
  const lr = (laneResultsCache || []).find(l => l.lane_number === laneNumber);
  return { team_name: lr?.team_name || '', team_code: lr?.team_code || '' };
}

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
  // Joyi_StartList_<RACEREF>_<RACEDATE>.xls). A1 is the event ref code
  // (matches what Joyi writes to row 1 of its own outputs), NOT the
  // long event name. Labels in row 2 and column headers in row 3 are
  // what Joyi expects to find.
  wsData.push([eventRef]);
  wsData.push(['考点：', '', '', '项目：', `.（${eventRef}）`]);
  wsData.push(['组号', '道次', '准考证号', '姓名']);

  // Generate race blocks
  const allRaceNums = [...sortedRaces.map(r => r.race_number), 9991, 9992, 9993, 9994, 9995];

  for (const raceNum of allRaceNums) {
    const isDummy = raceNum >= 9991;
    const lanes = isDummy ? [] : await getLaneResults(raceNum);

    for (let i = 0; i < laneCount; i++) {
      // Pull boat-lane team from race.draw_lanes (Joyi-safe) — falling
      // back to lane_results.team_name for legacy races. Crucial when
      // the start list is regenerated AFTER some races have results
      // imported: without this, lane 1's team_name would be the winner's
      // team in finish-order rather than the boat-lane-1 drawn team.
      const { team_name, team_code } = isDummy
        ? { team_name: `Test Team ${i + 1}`, team_code: '' }
        : await teamInLaneForRace(raceNum, i + 1, lanes);
      wsData.push([
        String(raceNum).padStart(4, '0'), // Race ID
        i + 1,                             // Lane number
        team_code,
        team_name,
      ]);
    }
  }

  // Create workbook. Sheet name MUST be "Joyi_StartList" — Joyi's parser
  // keys on it (the reference template confirms; "StartList" alone was
  // not recognised).
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Joyi_StartList');

  const filename = `Joyi_StartList_${eventRef}_${raceDate}.xls`;

  // Write to 11 Output_Start Lists/ (local) + 80 Shared/{ref}_Joyi/.
  // bookSST: true forces SheetJS to emit string cells as LABELSST records
  // (pointing into the Shared String Table) instead of inline LABEL
  // records. Joyi's BIFF8 parser only reads strings via the SST — the
  // file we shipped yesterday had an EMPTY SST and Joyi rejected it.
  // bookSST: true emits LABELSST records (strings via the Shared String
  // Table) — Joyi's parser only reads strings through the SST.
  // fixXlsEnvelopeForJoyi then repairs the OLE2 root entry name + CLSID so
  // Joyi accepts the container itself. Both are required.
  const xlsBytes = fixXlsEnvelopeForJoyi(
    XLSX.write(wb, { bookType: 'xls', type: 'array', bookSST: true })
  );
  const xlsBlob = new Blob([xlsBytes]);
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
