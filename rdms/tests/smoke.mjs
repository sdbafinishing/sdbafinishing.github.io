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
import { computeRankings, validateRace, computeDivisionScoring, getEffectiveStartTime } from '../js/race.js';
import { joyiTimeToMs, joyiTimeHasMsPrecision, joyiTimeToRaw } from '../js/utils.js';
import { patchXlsxCells } from '../js/xlsx-patcher.js';
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

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
