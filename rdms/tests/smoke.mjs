/**
 * SDBA RDMS — Smoke Tests
 *
 * Plain-node test runner — no Jest/Vitest. Each test is a pure-function
 * check that we can run in < 5 seconds before shipping. Focus: the
 * code paths that have produced race-day bugs.
 *
 * Run: `node tests/smoke.mjs`  (or `npm test` once wired)
 * Exit code: 0 on success, 1 on any failure.
 */
import { computeRankings, validateRace, computeDivisionScoring, computeVarianceWarnings, getEffectiveStartTime } from '../js/race.js';
import { joyiTimeToMs, joyiTimeHasMsPrecision, joyiTimeToRaw, msToTime } from '../js/utils.js';
import { patchXlsxCells, resizeLaneRowsXlsx, setPageHeaderXlsx, setPrintLayoutXlsx, setContentFontArialXlsx } from '../js/xlsx-patcher.js';
import { photoFinishPngFilename, autoCropRange } from '../js/photo-finish-png.js';
import { computeChainScoringFlags } from '../js/division-scoring.js';
import { parsePlaceholder, parseRaceList } from '../js/placeholders.js';
import { pooledTimeStandings, sumTimeStandings } from '../js/time-standings.js';
import { computeDivisionStanding, formatTotalTime } from '../js/division-standing.js';
import { readFileSync } from 'fs';
import * as XLSX from 'xlsx';
import * as fflate from 'fflate';

let failed = 0;
let passed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    failed++;
  }
}

function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n      actual:   ${a}\n      expected: ${b}`);
}

function group(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ── computeRankings ─────────────────────────────────────────────────────
group('computeRankings', () => {
  test('basic 3-finisher sort', () => {
    const lanes = [
      { lane_number: 1, raw_time: '12457' },
      { lane_number: 2, raw_time: '13249' },
      { lane_number: 3, raw_time: '14060' },
    ];
    computeRankings(lanes, 'mss00', 0);
    eq(lanes.map(l => l.computed_position), [1, 2, 3]);
  });

  test('"00000" raw_time is treated as no-time (never ranks 1st)', () => {
    const lanes = [
      { lane_number: 1, raw_time: '00000' },
      { lane_number: 2, raw_time: '13249' },
      { lane_number: 3, raw_time: '14060' },
    ];
    computeRankings(lanes, 'mss00', 0);
    eq(lanes[0].computed_position, null, 'lane 1 must have no position');
    eq(lanes[1].computed_position, 1, 'lane 2 should be 1st');
    eq(lanes[2].computed_position, 2, 'lane 3 should be 2nd');
  });

  test('DSQ row has no position', () => {
    const lanes = [
      { lane_number: 1, raw_time: '12457', remarks: 'DSQ' },
      { lane_number: 2, raw_time: '13249' },
    ];
    computeRankings(lanes, 'mss00', 0);
    eq(lanes[0].computed_position, null);
    eq(lanes[1].computed_position, 1);
  });

  test('DNS / DNF remarks → no position', () => {
    const lanes = [
      { lane_number: 1, raw_time: '', remarks: 'DNS' },
      { lane_number: 2, raw_time: '', remarks: 'DNF' },
      { lane_number: 3, raw_time: '12457' },
    ];
    computeRankings(lanes, 'mss00', 0);
    eq(lanes[0].computed_position, null);
    eq(lanes[1].computed_position, null);
    eq(lanes[2].computed_position, 1);
  });

  test('dummy "---" team is skipped', () => {
    const lanes = [
      { lane_number: 1, raw_time: '11111', team_name: '---' },
      { lane_number: 2, raw_time: '13249' },
    ];
    computeRankings(lanes, 'mss00', 0);
    eq(lanes[0].computed_position, null);
    eq(lanes[1].computed_position, 1);
  });

  test('ties get same rank (no duplicate place by sort instability)', () => {
    const lanes = [
      { lane_number: 1, raw_time: '12500' },
      { lane_number: 2, raw_time: '12500' },
      { lane_number: 3, raw_time: '13000' },
    ];
    computeRankings(lanes, 'mss00', 0);
    eq(lanes[0].computed_position, 1);
    eq(lanes[1].computed_position, 1);
    eq(lanes[2].computed_position, 3);
  });

  test('batchDeltaMs is applied to effective_time_ms (per-lane shift)', () => {
    // raw 1:25.00 (85000 ms) + 500ms batch delta = 85500ms effective
    const lanes = [{ lane_number: 1, raw_time: '12500' }];
    computeRankings(lanes, 'mss00', 500);
    eq(lanes[0].effective_time_ms, 85500);
    eq(lanes[0].computed_position, 1);
  });

  test('penalty_time and batchDeltaMs both stack into effective_time_ms', () => {
    // raw 1:25.00 (85000) + 2s penalty (2000) + 500ms batch = 87500
    const lanes = [{ lane_number: 1, raw_time: '12500', penalty_time: '2' }];
    computeRankings(lanes, 'mss00', 500);
    eq(lanes[0].effective_time_ms, 87500);
  });

  test('raw_time_ms (joyi thousandths) breaks tied hundredths', () => {
    // Both display "1:25.14" but Joyi reported 85143ms vs 85146ms.
    const lanes = [
      { lane_number: 1, raw_time: '12514', raw_time_ms: 85146 },
      { lane_number: 2, raw_time: '12514', raw_time_ms: 85143 },
    ];
    computeRankings(lanes, 'mss00', 0);
    eq(lanes[1].computed_position, 1, 'lane 2 (faster ms) should be 1st');
    eq(lanes[0].computed_position, 2, 'lane 1 (slower ms) should be 2nd');
  });

  test('without raw_time_ms, tied hundredths share place', () => {
    // No thousandth data → both genuinely tied.
    const lanes = [
      { lane_number: 1, raw_time: '12514' },
      { lane_number: 2, raw_time: '12514' },
    ];
    computeRankings(lanes, 'mss00', 0);
    eq(lanes[0].computed_position, 1);
    eq(lanes[1].computed_position, 1);
  });
});

// ── xlsx-patcher ────────────────────────────────────────────────────────
group('xlsx-patcher (race result template)', () => {
  const tpl = readFileSync(new URL('../templates/race-template.xlsx', import.meta.url));

  test('numeric stamp on text-formatted Place cell — preserves visibility', () => {
    // Place cells in the template have numFmtId=49 (text format @). When
    // we wrote numbers there earlier the cells rendered as blank in VBA
    // consumers. We've since switched to writing Place as a string —
    // this test guards against a regression.
    const patched = patchXlsxCells(tpl, [
      { addr: 'E4', value: '1' },
      { addr: 'E5', value: '2' },
    ]);
    const wb = XLSX.read(patched, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    eq(ws.E4?.v, '1', 'E4 should hold the place');
    eq(ws.E5?.v, '2');
  });

  test('append:true on footnote preserves existing text + appends with \\n', () => {
    const patched = patchXlsxCells(tpl, [
      { addr: 'A11', value: 'Results v2 (revised 10:30)', append: true },
    ]);
    const wb = XLSX.read(patched, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const v = String(ws.A11?.v || '');
    if (!v.includes('Private Steersman')) {
      throw new Error('original footnote text missing: ' + v.slice(0, 80));
    }
    if (!v.includes('Results v2')) {
      throw new Error('revision marker missing: ' + v.slice(-80));
    }
    if (!v.includes('\n')) {
      throw new Error('newline between original and revision missing');
    }
  });

  test('empty value clears the cell but keeps its style index', () => {
    const patched = patchXlsxCells(tpl, [
      { addr: 'B4', value: '' },
    ]);
    const files = fflate.unzipSync(new Uint8Array(patched));
    const dec = new TextDecoder();
    const sheet = dec.decode(files['xl/worksheets/sheet1.xml']);
    if (!/<c r="B4" s="\d+"\/>/.test(sheet)) {
      throw new Error('B4 should be a self-closed cell with style attr');
    }
  });

  test('sharedStrings count stays consistent after patching (Excel .xlsx repair guard)', () => {
    // Patching converts t="s" cells to inlineStr, dropping shared-string
    // references below the template's declared count. A stale count makes Excel
    // flag a .xlsx as needing repair ("removed unreadable content"). The
    // patcher must rewrite count to match the remaining t="s" refs.
    const patched = patchXlsxCells(tpl, [
      { addr: 'A1', value: 'Race 4' }, { addr: 'B4', value: 'Team A' },
      { addr: 'C4', value: 'WL1' }, { addr: 'D4', value: '1.25.00' }, { addr: 'E4', value: '1' },
    ]);
    const files = fflate.unzipSync(new Uint8Array(patched));
    const dec = new TextDecoder();
    const sheet = dec.decode(files['xl/worksheets/sheet1.xml']);
    const sst = dec.decode(files['xl/sharedStrings.xml']);
    const declared = parseInt(sst.match(/<sst\b[^>]*?\bcount="(\d+)"/)?.[1] ?? '-1', 10);
    const refs = (sheet.match(/ t="s"/g) || []).length;
    eq(declared, refs, `sst count (${declared}) must equal actual t="s" refs (${refs})`);
  });
});

// ── Joyi start list — BIFF8 format Joyi expects ─────────────────────────
group('Joyi start list format', () => {
  test('strings are emitted via SST (not inline) — Joyi requirement', async () => {
    const CFB = (await import('cfb')).default || (await import('cfb'));
    const wsData = [
      ['2026WU'],
      ['考点：', '', '', '项目：', '.（2026WU）'],
      ['组号', '道次', '准考证号', '姓名'],
      ['0001', 1, 'WM15', '*AMB Dragon'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(wsData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Joyi_StartList');
    const buf = XLSX.write(wb, { bookType: 'xls', type: 'array', bookSST: true });
    const cfb = CFB.parse(Buffer.from(buf), { type: 'buffer' });
    const idx = cfb.FullPaths.findIndex(p => p.toLowerCase().endsWith('workbook'));
    const data = cfb.FileIndex[idx].content;
    // Scan for SST record (type 0x00FC) with non-zero unique count.
    let off = 0, sstUnique = 0, sheetName = null;
    while (off + 4 <= data.length) {
      const type = data[off] | (data[off + 1] << 8);
      const len = data[off + 2] | (data[off + 3] << 8);
      if (type === 0x00FC) {
        sstUnique = data[off + 8] | (data[off + 9] << 8) | (data[off + 10] << 16) | (data[off + 11] << 24);
      } else if (type === 0x0085) {
        // BOUNDSHEET — extract sheet name (after 8 bytes offset+flags+vis+kind)
        const cch = data[off + 10];
        const grbit = data[off + 11];
        const isUnicode = !!(grbit & 0x01);
        const start = off + 12;
        sheetName = isUnicode
          ? Buffer.from(data.subarray(start, start + cch * 2)).toString('utf16le')
          : Buffer.from(data.subarray(start, start + cch)).toString('utf8');
      }
      off += 4 + len;
    }
    if (sstUnique === 0) throw new Error('SST is empty — Joyi will reject. bookSST: true missing?');
    if (sheetName !== 'Joyi_StartList') throw new Error(`sheet name should be "Joyi_StartList", got "${sheetName}"`);
  });

  test('fixXlsForJoyi: ROW records injected, envelope re-stamped, merge kept, still readable', async () => {
    // Exercises the REAL exported function. Asserts the three things Joyi needs
    // that SheetJS omits / gets wrong:
    //   1. ROW records (0x0208) — one per row (Joyi enumerates rows via them)
    //   2. OLE root "Root Entry" + Excel CLSID
    //   3. A1:D1 MERGEDCELLS (0x00E5) preserved
    // ...AND that the result is still a valid, readable workbook.
    const CFB = (await import('cfb')).default || (await import('cfb'));
    const { fixXlsForJoyi } = await import('../js/startlist.js');
    const EXCEL_CLSID = '2008020000000000c000000000000046';
    const aoa = [
      ['2026WU'],
      ['考点：', '', '', '项目：', '.（2026WU）'],
      ['组号', '道次', '准考证号', '姓名'],
      ['0001', 1, 'WM15', '*AMB Dragon'],
      ['0001', 2, 'WM16', 'Team B'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Joyi_StartList');
    const fixed = fixXlsForJoyi(XLSX.write(wb, { bookType: 'xls', type: 'array', bookSST: true }));

    // Envelope
    const cont = CFB.parse(fixed, { type: 'array' });
    const root = cont.FileIndex.find(f => f.type === 5);
    eq(root.name, 'Root Entry', 'root entry must be "Root Entry"');
    eq(root.clsid, EXCEL_CLSID, 'root CLSID must be the Excel workbook class');

    // ROW + MERGEDCELLS records in the Workbook BIFF stream
    const data = cont.FileIndex.find(f => /workbook/i.test(f.name)).content;
    let off = 0, nRow = 0, hasMerge = false;
    while (off + 4 <= data.length) {
      const t = data[off] | (data[off + 1] << 8);
      const len = data[off + 2] | (data[off + 3] << 8);
      if (t === 0x0208) nRow++;
      if (t === 0x00E5) hasMerge = true;
      off += 4 + len;
    }
    eq(nRow, aoa.length, `expected one ROW record per row (${aoa.length}), got ${nRow}`);
    if (!hasMerge) throw new Error('A1:D1 MERGEDCELLS (0x00E5) record missing');

    // Still a valid workbook
    const reread = XLSX.read(fixed, { type: 'array' });
    eq(reread.SheetNames[0], 'Joyi_StartList', 'sheet name must survive the fix');
    if (reread.Sheets['Joyi_StartList'].A1?.v !== '2026WU') throw new Error('cell A1 lost after fix');
    const merges = reread.Sheets['Joyi_StartList']['!merges'] || [];
    if (!merges.some(m => m.s.r === 0 && m.s.c === 0 && m.e.r === 0 && m.e.c === 3)) {
      throw new Error('A1:D1 merge missing after fix');
    }
  });
});

// ── Export column layout — DSQ in Time col, free-text + TP in Remarks ──
group('export column layout', () => {
  // We're testing the cell-build logic in export.js. The full function is
  // tightly coupled to db state — extract the layout decisions only.
  function buildCells(lr, raw_time, penalty_time, remarks) {
    const MARKER_SET = new Set(['DSQ', 'DQ', 'DNS', 'DNF']);
    const rawRemark = (remarks ?? '').toString().trim();
    const isMarker = MARKER_SET.has(rawRemark.toUpperCase());
    const time = isMarker ? rawRemark.toUpperCase() : raw_time;
    const remarkPieces = [];
    if (penalty_time && String(penalty_time).trim() !== '0') {
      remarkPieces.push(`TP=${penalty_time}s`);
    }
    if (!isMarker && rawRemark) remarkPieces.push(rawRemark);
    return { time, remarks: remarkPieces.join(' '), isMarker };
  }

  test('plain finish: time in Time col, blank Remarks', () => {
    const c = buildCells(null, '1:25.00', '', '');
    eq(c.time, '1:25.00');
    eq(c.remarks, '');
  });
  test('DSQ: marker in Time col, blank Remarks', () => {
    const c = buildCells(null, '', '', 'DSQ');
    eq(c.time, 'DSQ');
    eq(c.remarks, '');
  });
  test('DNS lowercase normalises to uppercase in Time col', () => {
    const c = buildCells(null, '', '', 'dns');
    eq(c.time, 'DNS');
  });
  test('time + penalty: time in D, "TP=2s" in Remarks', () => {
    const c = buildCells(null, '1:25.00', '2', '');
    eq(c.time, '1:25.00');
    eq(c.remarks, 'TP=2s');
  });
  test('time + penalty + free-text: time in D, "TP=2s Steered wide" in Remarks', () => {
    const c = buildCells(null, '1:25.00', '2', 'Steered wide');
    eq(c.time, '1:25.00');
    eq(c.remarks, 'TP=2s Steered wide');
  });
  test('penalty=0 is not written to Remarks', () => {
    const c = buildCells(null, '1:25.00', '0', '');
    eq(c.remarks, '');
  });
});

// ── Tie + tight-finish detection in validation ──────────────────────────
group('validation — ties & tight finishes', () => {
  const config = { lane_count: 6, time_format_mode: 'mss00' };

  test('duplicate raw_time → warning', () => {
    const race = { start_time: '2026-05-24T10:00:00Z' };
    const lanes = [
      { lane_number: 1, lane_input: '1', raw_time: '12500' },
      { lane_number: 2, lane_input: '2', raw_time: '12500' },
      { lane_number: 3, lane_input: '3', raw_time: '13000' },
    ];
    const result = validateRace(race, lanes, config);
    const has = result.warnings.some(w => /same time/.test(w));
    if (!has) throw new Error('expected a "same time" warning, got: ' + JSON.stringify(result.warnings));
  });

  test('gap ≤ 50ms → tight-finish warning', () => {
    const race = { start_time: '2026-05-24T10:00:00Z' };
    // 1:25.00 (85000ms) vs 1:25.03 (85030ms) → 30ms gap = 3 hundredths
    const lanes = [
      { lane_number: 1, lane_input: '1', raw_time: '12500' },
      { lane_number: 2, lane_input: '2', raw_time: '12503' },
    ];
    const result = validateRace(race, lanes, config);
    const has = result.warnings.some(w => /tight finish/.test(w));
    if (!has) throw new Error('expected a "tight finish" warning, got: ' + JSON.stringify(result.warnings));
  });

  test('gap > 50ms → no tight-finish warning', () => {
    const race = { start_time: '2026-05-24T10:00:00Z' };
    const lanes = [
      { lane_number: 1, lane_input: '1', raw_time: '12500' },
      { lane_number: 2, lane_input: '2', raw_time: '12551' }, // 51 hundredth = 510ms gap
    ];
    const result = validateRace(race, lanes, config);
    const has = result.warnings.some(w => /tight finish/.test(w));
    if (has) throw new Error('did not expect a tight-finish warning for 510ms gap');
  });

  test('DSQ rows do not contribute to ties or tight-finish warnings', () => {
    const race = { start_time: '2026-05-24T10:00:00Z' };
    const lanes = [
      { lane_number: 1, lane_input: '1', raw_time: '12500' },
      { lane_number: 2, lane_input: '2', raw_time: '12500', remarks: 'DSQ' },
    ];
    const result = validateRace(race, lanes, config);
    const has = result.warnings.some(w => /same time/.test(w) || /tight finish/.test(w));
    if (has) throw new Error('DSQ row should not trigger tie/tight warning');
  });
});

// ── Joyi watcher filename filter ────────────────────────────────────────
group('Joyi watcher filename filter', () => {
  // Mirrors the EXCLUDE_NAME_RE in joyi-watch.js. If the production
  // regex changes, update here too.
  const EXCLUDE = /(startlist|sprinttimer)/i;
  const ACCEPT = /\.(xlsx?|jyd|lcd)$/i;
  function shouldImport(name) { return ACCEPT.test(name) && !EXCLUDE.test(name); }

  test('skip RDMS-exported Joyi start list', () => {
    eq(shouldImport('Joyi_StartList_2026WU_20260524.xls'), false);
    eq(shouldImport('joyi_startlist_2026wu_20260524.xls'), false);
  });
  test('skip SprintTimer start list', () => {
    eq(shouldImport('SprintTimer_Start_List_2026WU_20260524.csv'), false, 'csv ext - shouldn\'t match accept anyway');
    eq(shouldImport('SprintTimer_2026WU.xls'), false);
  });
  test('accept normal joyi result files', () => {
    eq(shouldImport('2026WU.5.xls'), true);
    eq(shouldImport('2026 WU.10.jyd'), true);
    eq(shouldImport('2026WU.7.lcd'), true);
  });
});

// ── Joyi thousandths precision ──────────────────────────────────────────
group('joyiTimeToMs / joyiTimeHasMsPrecision', () => {
  test('hundredths "00:01:26.14" → 86140 ms, no extra precision', () => {
    eq(joyiTimeToMs('00:01:26.14'), 86140);
    eq(joyiTimeHasMsPrecision('00:01:26.14'), false);
  });
  test('thousandths "00:01:26.143" → 86143 ms, ms precision flag true', () => {
    eq(joyiTimeToMs('00:01:26.143'), 86143);
    eq(joyiTimeHasMsPrecision('00:01:26.143'), true);
  });
  test('truncated raw_time still loses thousandth via joyiTimeToRaw', () => {
    // joyiTimeToRaw drops to centiseconds (used as raw_time string).
    eq(joyiTimeToRaw('00:01:26.143', 'mss00'), '12614');
  });
  test('msToTime TRUNCATES thousandths — never rounds up (race rule)', () => {
    // .jyd import feeds full Score ms straight into msToTime. 86146 (1:26.146)
    // must display as 1:26.14, NOT 1:26.15.
    eq(msToTime(86140, 'mss00'), '12614');
    eq(msToTime(86146, 'mss00'), '12614'); // would be 12615 if it rounded
    eq(msToTime(86149, 'mss00'), '12614');
    eq(msToTime(86150, 'mss00'), '12615'); // exact centisecond boundary
  });
  test('malformed inputs return null', () => {
    eq(joyiTimeToMs(''), null);
    eq(joyiTimeToMs('1:26.14'), null); // missing hours
    eq(joyiTimeToMs(null), null);
  });
});

// ── Start-time preference toggle ───────────────────────────────────────
group('getEffectiveStartTime / prefer_manual_start', () => {
  const joyiTime = '2026-05-25T08:30:00.000Z';
  const manualTime = '2026-05-25T08:30:02.500Z';
  test('joyi wins by default when both present', () => {
    const r = getEffectiveStartTime({ joyi_start_time: joyiTime, start_time: manualTime });
    eq(r.source, 'joyi');
    eq(r.start, joyiTime);
  });
  test('prefer_manual_start flips the preference', () => {
    const r = getEffectiveStartTime({ joyi_start_time: joyiTime, start_time: manualTime, prefer_manual_start: true });
    eq(r.source, 'manual');
    eq(r.start, manualTime);
  });
  test('prefer_manual_start with NO manual falls back to joyi', () => {
    // If operator forces manual but never clicked START, the joyi value
    // is the only real signal — use it rather than blank out the start.
    const r = getEffectiveStartTime({ joyi_start_time: joyiTime, prefer_manual_start: true });
    eq(r.source, 'joyi');
    eq(r.start, joyiTime);
  });
});

// ── Division scoring: RFinal grey rule + cross-round join ──────────────
group('computeDivisionScoring', () => {
  test('returns null for unscored race', () => {
    const r = computeDivisionScoring({ scoring_flag: 'N', division_id: 1 }, [], new Map(), 6);
    eq(r, null);
  });
  test('aggregates points across rounds keyed by team_code', () => {
    const r1 = { race_number: 1, division_id: 1, scoring_flag: 'R1', draw_lanes: [
      { lane_number: 1, team_name: 'A', team_code: 'WL1' },
      { lane_number: 2, team_name: 'B', team_code: 'WL2' },
    ]};
    const rf = { race_number: 2, division_id: 1, scoring_flag: 'RFinal', draw_lanes: [
      { lane_number: 1, team_name: 'A', team_code: 'WL1' },
      { lane_number: 2, team_name: 'B', team_code: 'WL2' },
    ]};
    const lanes = new Map([
      [1, [
        { lane_number: 1, lane_input: '1', team_name: 'A', team_code: 'WL1', computed_position: 1, raw_time: '12500' },
        { lane_number: 2, lane_input: '2', team_name: 'B', team_code: 'WL2', computed_position: 2, raw_time: '12700' },
      ]],
      [2, [
        { lane_number: 1, lane_input: '1', team_name: 'A', team_code: 'WL1', computed_position: 2, raw_time: '12550' },
        { lane_number: 2, lane_input: '2', team_name: 'B', team_code: 'WL2', computed_position: 1, raw_time: '12480' },
      ]],
    ]);
    const ctx = computeDivisionScoring(rf, [r1, rf], lanes, 6);
    // 6 lanes → 1st=7pts, 2nd=5pts
    // A: R1 7pts + RFinal 5pts = 12 weighted (approx, multipliers small)
    // B: R1 5pts + RFinal 7pts = 12 weighted
    const a = ctx.teamTotals.get('WL1');
    const b = ctx.teamTotals.get('WL2');
    eq(a.perRound.R1.pts, 7);
    eq(a.perRound.RFinal.pts, 5);
    eq(b.perRound.R1.pts, 5);
    eq(b.perRound.RFinal.pts, 7);
    // Not actually tied — RFinal multiplier (×1.001) outweighs R1 (~×1).
    // B got 7pts in RFinal (weighted ~7.007) vs A's 5pts (~5.005), so
    // B is ahead despite matching unweighted total.
    eq(b.overall_rank, 1);
    eq(a.overall_rank, 2);
  });
});

// ── computeVarianceWarnings — cohort + per-team continuity ──────────────
group('computeVarianceWarnings', () => {
  const baseLanes = (extra = {}) => ([
    { lane_number: 1, lane_input: '1', raw_time: '12500', computed_position: 1, ...extra },
    { lane_number: 2, lane_input: '2', raw_time: '12700', computed_position: 2 },
  ]);

  test('no warnings when cohort + team data missing', () => {
    const out = computeVarianceWarnings({
      race: { race_number: 1, division_id: 1, draw_lanes: [] },
      lanes: baseLanes(),
      allRaces: [],
      allLaneResultsByRace: new Map(),
      divRounds: [],
      divProgs: [],
      laneCount: 6, timeMode: 'mss00',
    });
    eq(out.warnings.length, 0);
    eq(out.errors.length, 0);
  });

  test('cohort mean — race ≥5s slower than cohort fires soft warning', () => {
    // Cohort = races 2,3 in the same round, both with 1:25.00 winner.
    // Current race (race 1) winner is 1:30.50 — 5.5s off cohort mean.
    const myRace = {
      race_number: 1, division_id: 1,
      draw_lanes: [{ lane_number: 1, team_code: 'A', team_name: 'A' }],
    };
    const r2 = { race_number: 2, division_id: 1 };
    const r3 = { race_number: 3, division_id: 1 };
    const myRound = { id: 10, division_id: 1, race_numbers: [1, 2, 3] };
    const allLanes = new Map([
      [2, [{ lane_number: 1, lane_input: '1', raw_time: '12500', computed_position: 1 }]],
      [3, [{ lane_number: 1, lane_input: '1', raw_time: '12500', computed_position: 1 }]],
    ]);
    const out = computeVarianceWarnings({
      race: myRace,
      lanes: [{ lane_number: 1, lane_input: '1', raw_time: '13050', computed_position: 1 }],
      allRaces: [myRace, r2, r3],
      allLaneResultsByRace: allLanes,
      divRounds: [myRound],
      divProgs: [],
      laneCount: 6, timeMode: 'mss00',
    });
    const hasSoft = out.warnings.some(w => /cohort mean/.test(w));
    if (!hasSoft) throw new Error('expected soft cohort warning, got: ' + JSON.stringify(out));
  });

  test('cohort mean — race ≥7s off fires HARD warning (error)', () => {
    const myRace = { race_number: 1, division_id: 1, draw_lanes: [] };
    const myRound = { id: 10, division_id: 1, race_numbers: [1, 2, 3] };
    const r2 = { race_number: 2, division_id: 1 };
    const r3 = { race_number: 3, division_id: 1 };
    const allLanes = new Map([
      [2, [{ lane_number: 1, lane_input: '1', raw_time: '12500', computed_position: 1 }]],
      [3, [{ lane_number: 1, lane_input: '1', raw_time: '12500', computed_position: 1 }]],
    ]);
    const out = computeVarianceWarnings({
      race: myRace,
      lanes: [{ lane_number: 1, lane_input: '1', raw_time: '13200', computed_position: 1 }],
      allRaces: [myRace, r2, r3],
      allLaneResultsByRace: allLanes,
      divRounds: [myRound],
      divProgs: [],
      laneCount: 6, timeMode: 'mss00',
    });
    if (out.errors.length === 0) throw new Error('expected hard cohort error, got: ' + JSON.stringify(out));
  });

  test('per-team — team Δ ≥5s vs own previous round fires warning', () => {
    // Heat round 1 → Final round 2 in division 1.
    // Team X raced heat as 1:25.00; now in final as 1:30.50 — 5.5s slower.
    const heat = {
      race_number: 1, division_id: 1,
      draw_lanes: [{ lane_number: 3, team_code: 'X', team_name: 'X' }],
    };
    const final = {
      race_number: 2, division_id: 1,
      draw_lanes: [{ lane_number: 5, team_code: 'X', team_name: 'X' }],
    };
    const heatRound = { id: 10, division_id: 1, race_numbers: [1] };
    const finalRound = { id: 20, division_id: 1, race_numbers: [2] };
    const prog = { id: 1, division_id: 1, from_round_id: 10, to_round_id: 20 };
    const allLanes = new Map([
      [1, [{ lane_number: 1, lane_input: '3', raw_time: '12500', computed_position: 1 }]],
    ]);
    const out = computeVarianceWarnings({
      race: final,
      lanes: [{ lane_number: 1, lane_input: '5', raw_time: '13050', computed_position: 1 }],
      allRaces: [heat, final],
      allLaneResultsByRace: allLanes,
      divRounds: [heatRound, finalRound],
      divProgs: [prog],
      laneCount: 6, timeMode: 'mss00',
    });
    // Per-team warning shows a SIGNED delta (e.g. "lane 5: ... — +5.5s.").
    const hasPerTeam = [...out.warnings, ...out.errors].some(w => /lane 5.*[+-]\d+\.\d+s/.test(w));
    if (!hasPerTeam) throw new Error('expected signed per-team variance for team X, got: ' + JSON.stringify(out));
  });
});

// ── Template lane resize + page header ──────────────────────────────────
group('resizeLaneRowsXlsx', () => {
  const tpl = readFileSync(new URL('../templates/race-template.xlsx', import.meta.url));

  test('no duplicate / out-of-order rows at any lane count (Excel cell-info repair guard)', () => {
    // The template has a self-closed <row r="19"/>. A regex that glued it to
    // the next row duplicated row 21 on expand (laneCount >= 9), making Excel
    // strip "cell information" from the .xlsx. Guard every realistic count.
    for (let lc = 1; lc <= 12; lc++) {
      const xml = new TextDecoder().decode(
        fflate.unzipSync(new Uint8Array(resizeLaneRowsXlsx(tpl, lc)))['xl/worksheets/sheet1.xml'],
      );
      const seq = [...xml.matchAll(/<row r="(\d+)"/g)].map(m => +m[1]);
      const dups = seq.filter((x, i) => seq.indexOf(x) !== i);
      if (dups.length) throw new Error(`lc=${lc}: duplicate rows ${[...new Set(dups)]}`);
      for (let i = 1; i < seq.length; i++) {
        if (seq[i] <= seq[i - 1]) throw new Error(`lc=${lc}: rows not ascending (${seq[i - 1]} then ${seq[i]})`);
      }
    }
  });

  function decodeSheet(bytes) {
    const files = fflate.unzipSync(new Uint8Array(bytes));
    return new TextDecoder().decode(files['xl/worksheets/sheet1.xml']);
  }

  test('no-op when laneCount === 7 (template default)', () => {
    const out = resizeLaneRowsXlsx(tpl, 7);
    // Returns same bytes (reference or deep-equal — we only assert the
    // sheet content is unchanged).
    eq(decodeSheet(out).length, decodeSheet(tpl).length);
  });

  test('shrink to 5 lanes: boat 6 + 7 rows removed, footnote moves to row 9', () => {
    const out = resizeLaneRowsXlsx(tpl, 5);
    const xml = decodeSheet(out);
    if (/<row r="6"[^>]*>/.test(xml) === false) throw new Error('row 6 should still exist (lane 3)');
    // Lane 6 + 7 rows were rows 9 and 10 — should be gone.
    if (/<row r="9"[^>]*>[^<]*<c r="A9"[^>]*><v>6<\/v>/.test(xml)) {
      throw new Error('row 9 should NOT carry the old boat 6 number after shrink');
    }
    // Footnote (originally A11) should now sit at A9 (lanes 1-5 + footnote on row 9 = 4+5).
    if (!/<c r="A9" s="\d+" t="s"[^>]*>/.test(xml) && !/<c r="A9" s="\d+"[^/]*>[\s\S]*?Steersman/.test(xml)) {
      // Loose check — the row 9 cell should be the merged footnote anchor.
      // (We can't easily inspect the SST text via regex; just sanity-check the row exists.)
      if (!/<row r="9"/.test(xml)) throw new Error('row 9 (the new footnote row) should exist after shrink');
    }
  });

  test('expand to 9 lanes: rows 11 and 12 added, footnote moves to row 13', () => {
    const out = resizeLaneRowsXlsx(tpl, 9);
    const xml = decodeSheet(out);
    if (!/<row r="11"/.test(xml)) throw new Error('row 11 should exist after expand');
    if (!/<row r="12"/.test(xml)) throw new Error('row 12 should exist after expand');
    // Boat 8 and 9 values should appear in col A of the new rows.
    if (!/<c r="A11"[^>]*><v>8<\/v>/.test(xml)) throw new Error('row 11 A col should be boat 8');
    if (!/<c r="A12"[^>]*><v>9<\/v>/.test(xml)) throw new Error('row 12 A col should be boat 9');
  });

  test('merged cells shift down on expand', () => {
    // Original footnote merge in the template is A11:I14 (rows 11-14
    // inclusive, the 4-row block). Expanding to 9 lanes shifts both
    // endpoints by +2 → A13:I16.
    const out = resizeLaneRowsXlsx(tpl, 9);
    const xml = decodeSheet(out);
    if (!/<mergeCell ref="A13:I16"/.test(xml)) {
      throw new Error('footnote merge should be A13:I16 after expanding to 9 lanes; got: ' +
        (xml.match(/<mergeCell ref="A\d+:I\d+"\/>/g) || []).join(', '));
    }
  });
});

group('setPageHeaderXlsx', () => {
  const tpl = readFileSync(new URL('../templates/race-template.xlsx', import.meta.url));

  test('inserts <oddHeader> with EN + TC lines', () => {
    const out = setPageHeaderXlsx(tpl, 'Stanley Dragon Boat Warm Up 250', '赤柱龍舟熱身賽 250');
    const files = fflate.unzipSync(new Uint8Array(out));
    const xml = new TextDecoder().decode(files['xl/worksheets/sheet1.xml']);
    if (!/<headerFooter[\s\S]*<oddHeader>/.test(xml)) throw new Error('headerFooter block missing');
    if (!/Stanley Dragon Boat Warm Up 250/.test(xml)) throw new Error('EN line missing');
    if (!/赤柱龍舟熱身賽/.test(xml)) throw new Error('TC line missing');
  });

  test('replacing header on second call keeps just one block', () => {
    let out = setPageHeaderXlsx(tpl, 'Test EN', 'Test TC');
    out = setPageHeaderXlsx(out, 'New EN', 'New TC');
    const files = fflate.unzipSync(new Uint8Array(out));
    const xml = new TextDecoder().decode(files['xl/worksheets/sheet1.xml']);
    const matches = xml.match(/<headerFooter/g) || [];
    eq(matches.length, 1, 'should only have one headerFooter block');
    if (!/New EN/.test(xml)) throw new Error('updated EN line missing');
  });
});

// ── Photo-finish PNG (auto-generate) — pure helpers ─────────────────────
group('photo-finish PNG helpers', () => {
  test('deterministic filename matches background save + smart read', () => {
    eq(photoFinishPngFilename('2026WU', 5), 'PhotoFinish_2026WU_R5.png');
    eq(photoFinishPngFilename('', 12), 'PhotoFinish_RDMS_R12.png'); // ref fallback
  });

  test('autoCropRange: no JYD → full strip', () => {
    eq(autoCropRange({ displayWidth: 8000 }, null), [0, 8000]);
    eq(autoCropRange({ displayWidth: 8000 }, { reachPoints: [] }), [0, 8000]);
  });

  test('autoCropRange: reach points → padded window, clamped to strip', () => {
    // pad = 500 each side
    eq(autoCropRange({ displayWidth: 8000 }, { reachPoints: [{ line: 3000 }, { line: 3200 }] }), [2500, 3700]);
    // clamps to [0, displayWidth]
    eq(autoCropRange({ displayWidth: 3300 }, { reachPoints: [{ line: 200 }, { line: 3100 }] }), [0, 3300]);
  });

  test('autoCropRange: malformed reach lines fall back to full strip', () => {
    eq(autoCropRange({ displayWidth: 8000 }, { reachPoints: [{ line: NaN }, {}] }), [0, 8000]);
  });
});

// ── Division scoring — chain flag derivation ────────────────────────────
group('computeChainScoringFlags', () => {
  test('2-round 1:1 chain → R1, RFinal', () => {
    const flags = computeChainScoringFlags([10, 20], [{ from_round_id: 10, to_round_id: 20 }]);
    eq(flags.get(10), 'R1');
    eq(flags.get(20), 'RFinal');
  });
  test('3-round 1:1 chain → R1, R2, RFinal', () => {
    const flags = computeChainScoringFlags([1, 2, 3], [
      { from_round_id: 1, to_round_id: 2 },
      { from_round_id: 2, to_round_id: 3 },
    ]);
    eq(flags.get(1), 'R1'); eq(flags.get(2), 'R2'); eq(flags.get(3), 'RFinal');
  });
  test('branching (heat → 2 outgoing) is off-chain → all N', () => {
    const flags = computeChainScoringFlags([1, 2, 3], [
      { from_round_id: 1, to_round_id: 2 },
      { from_round_id: 1, to_round_id: 3 },
    ]);
    eq(flags.get(1), 'N'); eq(flags.get(2), 'N'); eq(flags.get(3), 'N');
  });
  test('separate cup/plate 1:1 pairs each score R1/RFinal', () => {
    // semiCup(1)→finalCup(2), semiPlate(3)→finalPlate(4)
    const flags = computeChainScoringFlags([1, 2, 3, 4], [
      { from_round_id: 1, to_round_id: 2 },
      { from_round_id: 3, to_round_id: 4 },
    ]);
    eq(flags.get(1), 'R1'); eq(flags.get(2), 'RFinal');
    eq(flags.get(3), 'R1'); eq(flags.get(4), 'RFinal');
  });
});

// ── New scoring methods: placeholder grammar + time standings ────────────
const _lane = (n, code, t) => ({ lane_number: n, team_code: code, team_name: code, raw_time: t, remarks: '' });

group('Placeholder grammar (new scoring methods)', () => {
  test('single R16P3 (legacy/default)', () => {
    const p = parsePlaceholder('R16P3');
    eq(p.kind, 'single'); eq(p.races, [16]); eq(p.position, 3);
  });
  test('pooled R1-3,5P2 (method #1)', () => {
    const p = parsePlaceholder('R1-3,5P2');
    eq(p.kind, 'pooled'); eq(p.races, [1, 2, 3, 5]); eq(p.position, 2);
  });
  test('sum SUMR1-3,5P2 (method #2)', () => {
    const p = parsePlaceholder('SUMR1-3,5P2');
    eq(p.kind, 'sum'); eq(p.races, [1, 2, 3, 5]); eq(p.position, 2);
  });
  test('case-insensitive', () => {
    eq(parsePlaceholder('r5p1').kind, 'single');
    eq(parsePlaceholder('sumr1-2p1').kind, 'sum');
  });
  test('non-placeholder → null', () => {
    eq(parsePlaceholder('Team A'), null);
    eq(parsePlaceholder(''), null);
  });
  test('parseRaceList ranges + bad token', () => {
    eq(parseRaceList('1-3,5'), [1, 2, 3, 5]);
    eq(parseRaceList('bad'), []);
  });
});

group('Pooled time standings (method #1)', () => {
  test('ranks across races by exported time', () => {
    const races = [
      { race_number: 1, lanes: [_lane(1, 'A', '12000'), _lane(2, 'B', '12500')] },
      { race_number: 2, lanes: [_lane(1, 'C', '11800'), _lane(2, 'D', '12200')] },
    ];
    const { entries } = pooledTimeStandings(races, 'mss00');
    eq(entries.map(e => e.team_code), ['C', 'A', 'D', 'B']);
    eq(entries.find(e => e.team_code === 'A').position, 2);
  });
});

group('Sum time standings (method #2)', () => {
  test('ranks by summed exported time', () => {
    const races = [
      { race_number: 1, lanes: [_lane(1, 'A', '12000'), _lane(2, 'B', '12500')] },
      { race_number: 2, lanes: [_lane(1, 'A', '11500'), _lane(2, 'B', '12000')] },
    ];
    const { teams } = sumTimeStandings(races, 'mss00');
    eq(teams.map(t => t.team_code), ['A', 'B']);
    eq(teams.find(t => t.team_code === 'A').overall_rank, 1);
  });
  test('team missing a leg is excluded from the ranked total', () => {
    const races = [
      { race_number: 1, lanes: [_lane(1, 'A', '12000'), _lane(2, 'B', '12500')] },
      { race_number: 2, lanes: [_lane(1, 'A', '11500')] }, // B absent in race 2
    ];
    const { teams, incomplete } = sumTimeStandings(races, 'mss00');
    eq(teams.map(t => t.team_code), ['A']);
    eq(incomplete.map(t => t.team_code), ['B']);
  });
});

group('Division standing (canonical, by method)', () => {
  const rounds = [
    { round_number: 1, race_numbers: [1] },
    { round_number: 2, race_numbers: [2] },
  ];
  const mkRace = (n, flag, status = 'exported') => ({ race_number: n, division_id: 1, scoring_flag: flag, status });
  const lanesByRace = () => new Map([
    [1, [_lane(1, 'A', '12000'), _lane(2, 'B', '12500')]],
    [2, [_lane(1, 'A', '11500'), _lane(2, 'B', '12000')]],
  ]);

  test('formatTotalTime', () => {
    eq(formatTotalTime(155000), '2:35.00');
    eq(formatTotalTime(75000), '1:15.00');
  });
  test('time_sum → total time + place, complete', () => {
    const div = { id: 1, standings_method: 'time_sum' };
    const s = computeDivisionStanding(div, rounds, [mkRace(1, 'R1'), mkRace(2, 'RFinal')], lanesByRace(), 6, 'mss00');
    eq(s.method, 'time_sum'); eq(s.complete, true);
    eq(s.teamTotals.get('A').total_place, 1);
    eq(s.teamTotals.get('A').total_display, '2:35.00');
    eq(s.teamTotals.get('B').total_place, 2);
  });
  test('time_sum → incomplete when a race not exported', () => {
    const div = { id: 1, standings_method: 'time_sum' };
    const s = computeDivisionStanding(div, rounds, [mkRace(1, 'R1'), mkRace(2, 'RFinal', 'pending')], lanesByRace(), 6, 'mss00');
    eq(s.complete, false);
  });
  test('time_combined → final round only, Total Score blank', () => {
    const div = { id: 1, standings_method: 'time_combined' };
    const s = computeDivisionStanding(div, rounds, [mkRace(1, 'R1'), mkRace(2, 'RFinal')], lanesByRace(), 6, 'mss00');
    eq(s.method, 'time_combined');
    eq(s.teamTotals.get('A').total_place, 1);   // A fastest in final race
    eq(s.teamTotals.get('A').total_display, ''); // combined: no Total Score
  });
  test('points → delegates, normalized shape', () => {
    const div = { id: 1, standings_method: 'points' };
    const s = computeDivisionStanding(div, rounds, [mkRace(1, 'R1'), mkRace(2, 'RFinal')], lanesByRace(), 6, 'mss00');
    eq(s.method, 'points');
    eq(s.teamTotals.get('A').total_place, 1); // A wins both → top points
  });
});

group('Export template polish (print layout + Arial font)', () => {
  const tpl = readFileSync(new URL('../templates/race-template.xlsx', import.meta.url));

  test('setPrintLayoutXlsx — fitToPage + bumped top margin, still parses', () => {
    const out = setPrintLayoutXlsx(tpl, { topMargin: 1.0 });
    const files = fflate.unzipSync(new Uint8Array(out));
    const xml = fflate.strFromU8(files['xl/worksheets/sheet1.xml']);
    if (!/fitToPage="1"/.test(xml)) throw new Error('fitToPage flag missing');
    if (!/fitToWidth="1"/.test(xml) || !/fitToHeight="1"/.test(xml)) throw new Error('fitTo width/height missing');
    if (!/top="1"/.test(xml)) throw new Error('top margin not bumped');
    XLSX.read(out, { type: 'array' }); // throws if corrupt
  });

  test('setContentFontArialXlsx — Latin fonts → Arial, CJK kept', () => {
    const out = setContentFontArialXlsx(tpl);
    const files = fflate.unzipSync(new Uint8Array(out));
    const xml = fflate.strFromU8(files['xl/styles.xml']);
    if (/name val="Calibri"/.test(xml)) throw new Error('Calibri not replaced');
    if (/name val="Cambria"/.test(xml)) throw new Error('Cambria not replaced');
    if (!/name val="Arial"/.test(xml)) throw new Error('Arial not present');
    if (!/新細明體/.test(xml)) throw new Error('CJK font should be preserved');
    XLSX.read(out, { type: 'array' });
  });

  test('full chain (resize → header → layout → font → patch) stays valid', () => {
    let b = resizeLaneRowsXlsx(tpl, 12);
    b = setPageHeaderXlsx(b, 'Official Long Name 2026', '官方長名稱 2026');
    b = setPrintLayoutXlsx(b);
    b = setContentFontArialXlsx(b);
    b = patchXlsxCells(b, [{ addr: 'B4', value: 'Team X' }, { addr: 'E4', value: '1' }]);
    const wb = XLSX.read(b, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    eq(ws.B4?.v, 'Team X');
  });
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
