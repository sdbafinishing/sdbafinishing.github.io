/**
 * SDBA RDMS — Start List Generation
 * Generate Joyi Start List (.xls) and SprintTimer Start List (.csv).
 * Output to both local 02/ folder (download) and Drive share folder.
 */
import * as XLSX from 'xlsx';
import * as CFBmod from 'cfb';
import { getConfig, getAllRaces, getLaneResults, getRace, saveConfig } from './db.js';
import { showToast, rowsToCsvBlob } from './utils.js';
import { writeToBoth, downloadFallback } from './file-access.js';

const CFB = CFBmod.default || CFBmod;

// Excel BIFF8 workbook CLSID {00020820-0000-0000-C000-000000000046}.
const EXCEL_WORKBOOK_CLSID_STR = '2008020000000000c000000000000046';
const EXCEL_WORKBOOK_CLSID = [
  0x20, 0x08, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
];
const OLE_SIGNATURE = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

/**
 * Inject BIFF8 ROW records (0x0208) into a SheetJS-written Workbook stream.
 *
 * SheetJS's free .xls writer emits ZERO ROW records — it relies on readers
 * reconstructing rows from the cell records. Joyi's reader does NOT; it
 * enumerates rows via the ROW table, so a SheetJS file looks empty to it
 * (this is THE reason a fresh file is rejected but an Excel re-save — which
 * adds the ROW table — is accepted; operator-confirmed on the Joyi hardware).
 *
 * We add one ROW record per row 0..rwMac-1 right after DIMENSIONS, modelled
 * byte-for-byte on Excel's: colMic=0, colMac=<dim colMac>, miyRw=0x0140,
 * grbit=0x0100 (fGhostDirty), ixfe=15. No INDEX/DBCELL exist in SheetJS
 * output, so there are no absolute offsets to fix up.
 *
 * @param {Uint8Array} wb - Workbook stream bytes
 * @returns {Uint8Array} Workbook stream with ROW records inserted
 */
function injectRowRecords(wb) {
  let off = 0, sub = null, dimEnd = -1, rwMac = 0, colMac = 0;
  while (off + 4 <= wb.length) {
    const t = wb[off] | (wb[off + 1] << 8);
    const len = wb[off + 2] | (wb[off + 3] << 8);
    if (t === 0x0809) { // BOF — track which substream we're in
      const dt = wb[off + 4 + 2] | (wb[off + 4 + 3] << 8);
      sub = dt === 0x0010 ? 'sheet' : 'globals';
    } else if (t === 0x0208) {
      return wb; // already has ROW records — leave as-is (idempotent)
    } else if (t === 0x0200 && sub === 'sheet') { // DIMENSIONS
      rwMac = wb[off + 8] | (wb[off + 9] << 8) | (wb[off + 10] << 16) | (wb[off + 11] << 24);
      colMac = wb[off + 14] | (wb[off + 15] << 8);
      dimEnd = off + 4 + len;
      break;
    }
    off += 4 + len;
  }
  if (dimEnd < 0 || rwMac <= 0) return wb;

  const REC = 20; // 4-byte header + 16-byte data
  const block = new Uint8Array(rwMac * REC);
  for (let r = 0; r < rwMac; r++) {
    const b = r * REC;
    block[b] = 0x08; block[b + 1] = 0x02; block[b + 2] = 0x10; block[b + 3] = 0x00; // 0x0208, len 16
    block[b + 4] = r & 0xff; block[b + 5] = (r >> 8) & 0xff;                          // rw
    block[b + 6] = 0; block[b + 7] = 0;                                               // colMic = 0
    block[b + 8] = colMac & 0xff; block[b + 9] = (colMac >> 8) & 0xff;                // colMac
    block[b + 10] = 0x40; block[b + 11] = 0x01;                                       // miyRw = 0x0140
    block[b + 12] = 0; block[b + 13] = 0; block[b + 14] = 0; block[b + 15] = 0;       // reserved
    block[b + 16] = 0x00; block[b + 17] = 0x01;                                       // grbit = fGhostDirty
    block[b + 18] = 0x0f; block[b + 19] = 0x00;                                       // ixfe = 15
  }

  const out = new Uint8Array(wb.length + block.length);
  out.set(wb.subarray(0, dimEnd), 0);
  out.set(block, dimEnd);
  out.set(wb.subarray(dimEnd), dimEnd + block.length);
  return out;
}

/**
 * Make SheetJS's .xls readable by Joyi. Two gaps vs a real Excel file:
 *   1. Missing ROW records — injected into the Workbook stream (see above).
 *   2. OLE envelope — root entry must be "Root Entry" + the Excel workbook
 *      CLSID (SheetJS writes "R" + zero CLSID).
 *
 * Done via the `cfb` library because adding ROW records changes the Workbook
 * stream length, which requires rebuilding the OLE2 container (FAT/directory).
 * Falls back to an envelope-only direct byte patch if cfb is unavailable —
 * that alone won't satisfy Joyi, but it keeps start-list generation working.
 *
 * @param {ArrayBuffer|Uint8Array} written - XLSX.write(..., {type:'array'})
 * @returns {Uint8Array}
 */
export function fixXlsForJoyi(written) {
  const u8 = written instanceof Uint8Array ? written : new Uint8Array(written);
  try {
    const cont = CFB.parse(u8, { type: 'array' });
    const wbEntry = cont.FileIndex.find(f => /workbook/i.test(f.name));
    if (!wbEntry) throw new Error('no Workbook stream');
    const injected = injectRowRecords(Uint8Array.from(wbEntry.content));
    wbEntry.content = injected;
    wbEntry.size = injected.length;
    const root = cont.FileIndex.find(f => f.type === 5);
    if (root) { root.name = 'Root Entry'; root.clsid = EXCEL_WORKBOOK_CLSID_STR; }
    const out = CFB.write(cont, { type: 'array' });
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  } catch (err) {
    console.warn('Joyi .xls fix (ROW inject) failed; envelope-only fallback:', err);
    return bytePatchOleRoot(u8);
  }
}

/**
 * Dependency-free fallback: byte-patch only the OLE2 root entry name + CLSID.
 * Used if the cfb-based full fix throws (e.g. cfb failed to load). Joyi still
 * needs the ROW records, so this is a degraded path — but it never blocks
 * generation.
 */
function bytePatchOleRoot(u8) {
  try {
    for (let i = 0; i < 8; i++) if (u8[i] !== OLE_SIGNATURE[i]) return u8;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const sectorSize = 1 << dv.getUint16(30, true);
    const dirOff = (dv.getUint32(48, true) + 1) * sectorSize;
    if (dirOff + 128 > u8.length || u8[dirOff + 66] !== 5) return u8;
    const name = 'Root Entry';
    for (let i = 0; i < 64; i++) u8[dirOff + i] = 0;
    for (let i = 0; i < name.length; i++) dv.setUint16(dirOff + i * 2, name.charCodeAt(i), true);
    dv.setUint16(dirOff + 64, (name.length + 1) * 2, true);
    for (let i = 0; i < 16; i++) u8[dirOff + 80 + i] = EXCEL_WORKBOOK_CLSID[i];
    return u8;
  } catch {
    return u8;
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
  // Merge A1:D1 to match the Joyi reference / the operator's known-good
  // (Excel-saved) start list, where the event ref banner spans the four
  // data columns.
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
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
  // fixXlsForJoyi then injects the ROW records SheetJS omits (Joyi needs them
  // to enumerate rows) and repairs the OLE2 envelope (root "Root Entry" +
  // Excel CLSID). All three — SST, ROW records, envelope — are required.
  const xlsBytes = fixXlsForJoyi(
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

/**
 * One-shot auto-export of the SprintTimer start list, for the INITIAL draw
 * import of an event. The SprintTimer list depends only on race + lane count
 * (not the actual draw teams), so re-importing updated draws for the same races
 * needs no regen — we generate it once and set `sprinttimer_startlist_done` so
 * subsequent imports skip it. Follows the same opt-in as the Joyi auto start
 * list (`auto_start_list_on_import`, default ON). A New Event clears the config,
 * so the flag resets and the next event regenerates on its first import.
 *
 * @returns {Promise<boolean>} true if it generated this time.
 */
export async function maybeAutoSprintTimerStartList() {
  const cfg = await getConfig();
  if (!cfg) return false;
  if (cfg.auto_start_list_on_import === false) return false; // start-list automation off
  if (cfg.sprinttimer_startlist_done) return false;          // already done (initial-load only)
  try {
    await generateSprintTimerStartList();
    await saveConfig({ ...cfg, sprinttimer_startlist_done: true });
    return true;
  } catch (err) {
    console.warn('Auto SprintTimer start list failed:', err);
    return false;
  }
}
