/**
 * SDBA RDMS — XLSX cell patcher
 *
 * Modify specific cell values in an .xlsx file WITHOUT re-serializing the
 * workbook. We unzip the xlsx, edit `xl/worksheets/sheet1.xml` in place
 * (and pull existing strings from `xl/sharedStrings.xml` when appending),
 * then rezip. Everything we don't touch — styles, fonts, borders, fills,
 * merges, drawings, print settings — survives bit-for-bit because we
 * never go through a workbook serializer.
 *
 * String cells are written as `t="inlineStr"` so we don't have to mutate
 * the SST (shared string table). Each cell's `s="N"` style index is
 * preserved on the rebuilt `<c>` element, so the cell keeps its borders,
 * font, alignment (incl. wrap-text), and fill.
 */
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

const SHEET_PATH = 'xl/worksheets/sheet1.xml';
const SST_PATH = 'xl/sharedStrings.xml';

// Bundled template ships with 7 hard-coded lane rows (rows 4..10).
// resizeLaneRowsXlsx adapts this to any laneCount by either cloning the
// last lane row (for laneCount > 7) or dropping tail rows (laneCount < 7),
// then shifting everything below the lane block (footnote, signature,
// etc.) by the delta. Merge cell refs that touch the shifted region are
// updated too. <dimension> is left alone — readers tolerate a stale
// dimension that's larger than the actual data; smaller would cause
// rendering issues. Returns a fresh xlsx Uint8Array.
const TEMPLATE_LANE_COUNT = 7;
const TEMPLATE_LANE_START_ROW = 4; // rows 4..10 in bundled template

export function resizeLaneRowsXlsx(xlsxBytes, laneCount) {
  if (!Number.isFinite(laneCount) || laneCount < 1) return xlsxBytes;
  const delta = laneCount - TEMPLATE_LANE_COUNT;
  if (delta === 0) return xlsxBytes;

  const input = xlsxBytes instanceof Uint8Array ? xlsxBytes : new Uint8Array(xlsxBytes);
  const files = unzipSync(input);
  if (!files[SHEET_PATH]) return xlsxBytes;
  const dec = new TextDecoder('utf-8');
  let sheetXml = dec.decode(files[SHEET_PATH]);

  // The last lane row in the bundled template (row 10). We use its
  // XML as the prototype when CLONING new rows on expansion.
  const lastLaneRow = TEMPLATE_LANE_START_ROW + TEMPLATE_LANE_COUNT - 1; // 10
  const lastLaneMatch = sheetXml.match(new RegExp(`<row r="${lastLaneRow}"[^>]*>[\\s\\S]*?<\\/row>`));
  if (!lastLaneMatch) return xlsxBytes; // unexpected template layout

  const firstPostLaneRow = lastLaneRow + 1; // 11
  if (delta > 0) {
    // EXPAND. Shift post-lane rows DOWN first (row 11 → row 11+delta)
    // so the slot at row 11..10+delta is empty for the new clones —
    // without this we'd end up with duplicate row numbers when the
    // cloned lane rows collide with the still-original footnote row.
    sheetXml = shiftRowsBy(sheetXml, firstPostLaneRow, delta);
    sheetXml = shiftMergesBy(sheetXml, firstPostLaneRow, delta);

    const protoXml = lastLaneMatch[0];
    let added = '';
    for (let i = 1; i <= delta; i++) {
      const newRowNum = lastLaneRow + i;
      let cloned = protoXml
        .replace(`<row r="${lastLaneRow}"`, `<row r="${newRowNum}"`)
        .replace(new RegExp(`r="([A-Z]+)${lastLaneRow}"`, 'g'), (m, col) => `r="${col}${newRowNum}"`);
      // Boat number value in col A (row 10's first <c> is <v>7</v>) →
      // next boat #. Match within the leading A-column cell only.
      cloned = cloned.replace(
        /(<c r="A\d+"[^>]*>)<v>\d+<\/v>/,
        (m, prefix) => `${prefix}<v>${TEMPLATE_LANE_COUNT + i}</v>`,
      );
      added += cloned;
    }
    sheetXml = sheetXml.replace(protoXml, protoXml + added);
  } else {
    // SHRINK. Delete tail lane rows FIRST so the freed row numbers
    // (e.g. 10 when shrinking by 1) don't conflict with the shifted
    // footnote that would otherwise also land at 10.
    const negDelta = -delta;
    for (let i = 0; i < negDelta; i++) {
      const rowToDelete = lastLaneRow - i;
      const re = new RegExp(`<row r="${rowToDelete}"[^>]*>[\\s\\S]*?<\\/row>`);
      sheetXml = sheetXml.replace(re, '');
    }
    sheetXml = shiftRowsBy(sheetXml, firstPostLaneRow, delta);
    sheetXml = shiftMergesBy(sheetXml, firstPostLaneRow, delta);
  }

  files[SHEET_PATH] = strToU8(sheetXml);
  return zipSync(files);
}

function shiftRowsBy(xml, startRow, delta) {
  // Match a full row in EITHER form: self-closed `<row .../>` or
  // `<row ...>...</row>`. The bundled template has a self-closed empty row
  // (`<row r="19" .../>`); a naive `<row ...>([\s\S]*?)</row>` regex would
  // glue that self-closed tag to the NEXT row's content, duplicating/merging
  // rows on expand — which made Excel strip "cell information" from the .xlsx.
  return xml.replace(
    /<row r="(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g,
    (m, n, attrs, inner) => {
      const num = parseInt(n, 10);
      if (num < startRow) return m;
      const newNum = num + delta;
      if (inner === undefined) {
        // self-closed empty row — just renumber
        return `<row r="${newNum}"${attrs}/>`;
      }
      // Each cell inside this row has r="<col><num>" — update only when the
      // cell row matches the row we're shifting (defensive).
      const newInner = inner.replace(/r="([A-Z]+)(\d+)"/g, (mm, col, rn) => {
        return parseInt(rn, 10) === num ? `r="${col}${newNum}"` : mm;
      });
      return `<row r="${newNum}"${attrs}>${newInner}</row>`;
    },
  );
}

/**
 * Set the printed page header (the band Excel prints at the top of each
 * page, controlled by sheet1.xml `<headerFooter>` → `<oddHeader>`).
 * Two lines:
 *   line 1: long English event name
 *   line 2: long Chinese event name
 *
 * Existing `<headerFooter>` block is replaced. If none exists, one is
 * inserted before the sheet's closing tag.
 *
 * Escapes user text minimally — `&` < > " are XML-encoded.
 * The OOXML header DSL uses `&L` / `&C` / `&R` for left/center/right and
 * `&"font,style"&size` for typography. We center everything by default.
 *
 * @returns {Uint8Array} patched xlsx bytes
 */
export function setPageHeaderXlsx(xlsxBytes, lineEn, lineTc) {
  const input = xlsxBytes instanceof Uint8Array ? xlsxBytes : new Uint8Array(xlsxBytes);
  const files = unzipSync(input);
  if (!files[SHEET_PATH]) return xlsxBytes;
  const dec = new TextDecoder('utf-8');
  let sheetXml = dec.decode(files[SHEET_PATH]);

  const escape = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  // Page-header DSL uses literal & escaping (we already XML-escape to &amp;);
  // the && double-encode is what's emitted by Excel for centred headers.
  const en = escape(lineEn || '');
  const tc = escape(lineTc || '');
  const headerText = `&amp;C&amp;14${en}&#10;${tc}`;

  const headerFooter = `<headerFooter differentFirst="0" differentOddEven="0"><oddHeader>${headerText}</oddHeader></headerFooter>`;

  if (/<headerFooter[\s\S]*?<\/headerFooter>/.test(sheetXml)) {
    sheetXml = sheetXml.replace(/<headerFooter[\s\S]*?<\/headerFooter>/, headerFooter);
  } else {
    // Insert just before </worksheet>. OOXML schema lets headerFooter
    // sit near the end; placement before the closing tag is safe.
    sheetXml = sheetXml.replace(/<\/worksheet>\s*$/, `${headerFooter}</worksheet>`);
  }

  files[SHEET_PATH] = strToU8(sheetXml);
  return zipSync(files);
}

/**
 * T1 + T5 — print layout. Bumps the TOP page margin so the centred two-line
 * page header doesn't sit on top of the title box ("header sits too low"), and
 * fits the sheet to one A4 page (paperSize 9 is already A4). Setting fitToPage
 * needs BOTH the pageSetup attrs and the sheetPr/pageSetUpPr flag, else Excel
 * ignores it. Idempotent; pure sheet1.xml attribute edits.
 *
 * @returns {Uint8Array} patched xlsx bytes
 */
export function setPrintLayoutXlsx(xlsxBytes, { topMargin = 1.0 } = {}) {
  const input = xlsxBytes instanceof Uint8Array ? xlsxBytes : new Uint8Array(xlsxBytes);
  const files = unzipSync(input);
  if (!files[SHEET_PATH]) return xlsxBytes;
  let xml = strFromU8(files[SHEET_PATH]);

  // Top margin — pull content down so the header clears it.
  xml = xml.replace(/<pageMargins\b([^>]*?)\/>/, (m, attrs) => {
    const a = /\btop="[^"]*"/.test(attrs)
      ? attrs.replace(/\btop="[^"]*"/, `top="${topMargin}"`)
      : `${attrs} top="${topMargin}"`;
    return `<pageMargins${a}/>`;
  });

  // fitToPage 1×1 on pageSetup.
  xml = xml.replace(/<pageSetup\b([^>]*?)\/>/, (m, attrs) => {
    let a = attrs;
    a = /fitToWidth=/.test(a) ? a.replace(/fitToWidth="[^"]*"/, 'fitToWidth="1"') : `${a} fitToWidth="1"`;
    a = /fitToHeight=/.test(a) ? a.replace(/fitToHeight="[^"]*"/, 'fitToHeight="1"') : `${a} fitToHeight="1"`;
    return `<pageSetup${a}/>`;
  });

  // The fitToPage flag lives on sheetPr/pageSetUpPr. sheetPr must be the FIRST
  // child of worksheet, so when absent we insert it right after the open tag.
  if (!/<sheetPr\b/.test(xml)) {
    xml = xml.replace(/(<worksheet\b[^>]*>)/, '$1<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>');
  } else if (/<pageSetUpPr\b/.test(xml)) {
    xml = xml.replace(/<pageSetUpPr\b([^>]*?)\/?>/, (m, a) =>
      `<pageSetUpPr${/fitToPage=/.test(a) ? a.replace(/fitToPage="[^"]*"/, 'fitToPage="1"') : `${a} fitToPage="1"`}/>`);
  } else if (/<sheetPr\b[^>]*\/>/.test(xml)) {
    xml = xml.replace(/<sheetPr\b([^>]*)\/>/, (m, a) => `<sheetPr${a}><pageSetUpPr fitToPage="1"/></sheetPr>`);
  } else {
    xml = xml.replace(/<sheetPr\b([^>]*)>/, (m, a) => `<sheetPr${a}><pageSetUpPr fitToPage="1"/>`);
  }

  files[SHEET_PATH] = strToU8(xml);
  return zipSync(files);
}

/**
 * T3 — make ALL text Arial. Rewrites every font name in styles.xml to Arial,
 * including the CJK fonts (新細明體 / Arial Unicode MS) that were rendering Latin
 * as a serif. Chinese glyphs still show via Excel's font fallback (Arial has no
 * CJK glyphs, so the OS substitutes a CJK font for those characters only). Pure
 * font-name string swap, no structural change.
 *
 * @returns {Uint8Array} patched xlsx bytes
 */
export function setContentFontArialXlsx(xlsxBytes) {
  const input = xlsxBytes instanceof Uint8Array ? xlsxBytes : new Uint8Array(xlsxBytes);
  const files = unzipSync(input);
  const STYLES_PATH = 'xl/styles.xml';
  if (!files[STYLES_PATH]) return xlsxBytes;
  let xml = strFromU8(files[STYLES_PATH]);
  // Every <name val="…"/> in <fonts> → Arial.
  xml = xml.replace(/<name val="[^"]*"\/>/g, '<name val="Arial"/>');
  files[STYLES_PATH] = strToU8(xml);
  return zipSync(files);
}

/**
 * T4 — colour the title row (row 1) by race-number parity, a scoring-team
 * convention: ODD race → yellow background; EVEN race → white background with
 * red text. Row 1 cells use styles 37 (A1:C1) + 38 (D1:I1) in the bundled
 * template and those style indices appear nowhere else, so we can clone those
 * two xfs (preserving border/alignment), override fill (yellow) or font (red),
 * and re-point row 1. Pure styles.xml + sheet1.xml edit; re-parse-guarded.
 *
 * @returns {Uint8Array} patched xlsx bytes
 */
export function applyRaceParityHeaderStyle(xlsxBytes, raceNumber) {
  const ROW1_A = 37; // A1:C1
  const ROW1_B = 38; // D1:I1
  const input = xlsxBytes instanceof Uint8Array ? xlsxBytes : new Uint8Array(xlsxBytes);
  const files = unzipSync(input);
  const STYLES_PATH = 'xl/styles.xml';
  if (!files[STYLES_PATH] || !files[SHEET_PATH]) return xlsxBytes;
  let styles = strFromU8(files[STYLES_PATH]);
  let sheet = strFromU8(files[SHEET_PATH]);

  // Parse the existing xf list to clone the two row-1 xfs.
  const xfs = [...styles.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map(m => m[0]);
  const xfA = xfs[ROW1_A], xfB = xfs[ROW1_B];
  if (!xfA || !xfB) return xlsxBytes; // template changed — bail safely
  const fontIdOf = (xf) => { const m = xf.match(/fontId="(\d+)"/); return m ? +m[1] : 0; };

  // Set/replace an attribute on an <xf ...> element.
  const xfSet = (xf, name, value) => (new RegExp(`\\b${name}="[^"]*"`).test(xf)
    ? xf.replace(new RegExp(`\\b${name}="[^"]*"`), `${name}="${value}"`)
    : xf.replace(/^<xf\b/, `<xf ${name}="${value}"`));

  // Red-tint a <font> — strip any existing colour, insert one BEFORE <name>
  // (CT_Font schema order: ... sz, color, name ... — wrong order = repair).
  const reddenFont = (f) => {
    const g = f.replace(/<color\b[^>]*\/>/g, '');
    return /<name\b/.test(g)
      ? g.replace(/<name\b/, '<color rgb="FFFF0000"/><name')
      : g.replace('</font>', '<color rgb="FFFF0000"/></font>');
  };

  const fonts = [...styles.matchAll(/<font\b[^>]*>[\s\S]*?<\/font>|<font\s*\/>/g)].map(m => m[0]);
  const fontCount = fonts.length;
  const redA = reddenFont(fonts[fontIdOf(xfA)] || '<font/>');
  const redB = reddenFont(fonts[fontIdOf(xfB)] || '<font/>');
  const redAId = fontCount, redBId = fontCount + 1;

  const fillCount = parseInt((styles.match(/<fills count="(\d+)">/) || [])[1] || '0', 10);
  // ODD race title row = amber (FFC000) background + black (original) text.
  const amberFill = '<fill><patternFill patternType="solid"><fgColor rgb="FFFFC000"/><bgColor indexed="64"/></patternFill></fill>';
  const amberFillId = fillCount;

  // Centre all row-1 content (the title cell is left-aligned in the base style).
  const centre = (xf) => {
    let g = xf;
    if (/<alignment\b[^>]*\/>/.test(g)) g = g.replace(/<alignment\b[^>]*\/>/, '<alignment horizontal="center" vertical="center" wrapText="1"/>');
    else if (/<\/xf>/.test(g)) g = g.replace('</xf>', '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>');
    else g = g.replace(/\/>\s*$/, '><alignment horizontal="center" vertical="center" wrapText="1"/></xf>');
    if (!/applyAlignment="1"/.test(g)) g = g.replace(/^<xf\b/, '<xf applyAlignment="1"');
    return g;
  };

  const xfCount = parseInt((styles.match(/<cellXfs count="(\d+)">/) || [])[1] || '0', 10);
  // Odd: amber fill + original (black) font + centred.
  const xfA_odd = centre(xfSet(xfSet(xfA, 'fillId', amberFillId), 'applyFill', '1'));
  const xfB_odd = centre(xfSet(xfSet(xfB, 'fillId', amberFillId), 'applyFill', '1'));
  // Even: forced white (fillId 0) + red font + centred.
  const xfA_even = centre(xfSet(xfSet(xfSet(xfA, 'fontId', redAId), 'applyFont', '1'), 'fillId', '0'));
  const xfB_even = centre(xfSet(xfSet(xfSet(xfB, 'fontId', redBId), 'applyFont', '1'), 'fillId', '0'));
  const idxOA = xfCount, idxOB = xfCount + 1, idxEA = xfCount + 2, idxEB = xfCount + 3;

  // Splice into styles.xml (append + bump counts).
  styles = styles
    .replace(/<fonts count="\d+">/, `<fonts count="${fontCount + 2}">`)
    .replace('</fonts>', `${redA}${redB}</fonts>`)
    .replace(/<fills count="\d+">/, `<fills count="${fillCount + 1}">`)
    .replace('</fills>', `${amberFill}</fills>`)
    .replace(/<cellXfs count="\d+">/, `<cellXfs count="${xfCount + 4}">`)
    .replace('</cellXfs>', `${xfA_odd}${xfB_odd}${xfA_even}${xfB_even}</cellXfs>`);

  // Re-point row 1 (37/38 are row-1-only, so a global s= swap is safe).
  const odd = (Number(raceNumber) % 2) === 1;
  const useA = odd ? idxOA : idxEA;
  const useB = odd ? idxOB : idxEB;
  sheet = sheet.replace(/ s="37"/g, ` s="${useA}"`).replace(/ s="38"/g, ` s="${useB}"`);

  files[STYLES_PATH] = strToU8(styles);
  files[SHEET_PATH] = strToU8(sheet);
  return zipSync(files);
}

/**
 * T6 — Remarks column alignment. The lane-row Remarks cells (column I) ship
 * centred (center/center), which reads wrong for free-text notes. Re-align them
 * to left / top / wrap (matching the Team-name column + the footnote), to match
 * the provided sample. Clones the two xfs used by column-I lane cells (s=11 on
 * I4, s=17 on I5+) so other columns sharing those styles are untouched, then
 * re-points only the column-I lane cells. Run AFTER resizeLaneRowsXlsx so the
 * cloned/added lane rows are covered. Re-parse-guarded.
 *
 * @returns {Uint8Array} patched xlsx bytes
 */
export function setRemarksAlignmentXlsx(xlsxBytes) {
  const REMARK_FIRST = 11; // I4
  const REMARK_REST = 17;  // I5+
  const input = xlsxBytes instanceof Uint8Array ? xlsxBytes : new Uint8Array(xlsxBytes);
  const files = unzipSync(input);
  const STYLES_PATH = 'xl/styles.xml';
  if (!files[STYLES_PATH] || !files[SHEET_PATH]) return xlsxBytes;
  let styles = strFromU8(files[STYLES_PATH]);
  let sheet = strFromU8(files[SHEET_PATH]);

  const xfs = [...styles.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map(m => m[0]);
  const xf11 = xfs[REMARK_FIRST], xf17 = xfs[REMARK_REST];
  if (!xf11 || !xf17) return xlsxBytes;

  const leftTop = (xf) => {
    let g = xf;
    if (/<alignment\b[^>]*\/>/.test(g)) {
      g = g.replace(/<alignment\b[^>]*\/>/, '<alignment horizontal="left" vertical="top" wrapText="1"/>');
    } else if (/<\/xf>/.test(g)) {
      g = g.replace('</xf>', '<alignment horizontal="left" vertical="top" wrapText="1"/></xf>');
    } else {
      g = g.replace(/\/>\s*$/, '><alignment horizontal="left" vertical="top" wrapText="1"/></xf>');
    }
    if (!/applyAlignment="1"/.test(g)) g = g.replace(/^<xf\b/, '<xf applyAlignment="1"');
    return g;
  };

  const xfCount = parseInt((styles.match(/<cellXfs count="(\d+)">/) || [])[1] || '0', 10);
  const c11 = leftTop(xf11), c17 = leftTop(xf17);
  const idx11 = xfCount, idx17 = xfCount + 1;

  styles = styles
    .replace(/<cellXfs count="\d+">/, `<cellXfs count="${xfCount + 2}">`)
    .replace('</cellXfs>', `${c11}${c17}</cellXfs>`);

  sheet = sheet
    .replace(/<c r="I4" s="11"/g, `<c r="I4" s="${idx11}"`)
    .replace(/(<c r="I\d+") s="17"/g, `$1 s="${idx17}"`);

  files[STYLES_PATH] = strToU8(styles);
  files[SHEET_PATH] = strToU8(sheet);
  return zipSync(files);
}

function shiftMergesBy(xml, startRow, delta) {
  return xml.replace(/<mergeCell ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"\s*\/>/g, (m, c1, r1, c2, r2) => {
    const n1 = parseInt(r1, 10);
    const n2 = parseInt(r2, 10);
    const newN1 = n1 >= startRow ? n1 + delta : n1;
    const newN2 = n2 >= startRow ? n2 + delta : n2;
    return `<mergeCell ref="${c1}${newN1}:${c2}${newN2}"/>`;
  });
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function encodeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Pull a shared-string entry's plain text. <si> may contain a single <t>
// or multiple <r><t>...</t></r> runs; we concatenate the text segments.
function resolveSST(sstXml, idx) {
  const matches = [...sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)];
  if (idx < 0 || idx >= matches.length) return '';
  const parts = [...matches[idx][1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
    .map(m => decodeXml(m[1]));
  return parts.join('');
}

// Build the <c> element for an updated cell. Preserves the original
// style index (s="N") so the visual formatting is unchanged.
function buildCell(addr, sIdx, value, type) {
  const sAttr = sIdx != null ? ` s="${sIdx}"` : '';
  if (value === '' || value == null) {
    return `<c r="${addr}"${sAttr}/>`;
  }
  if (type === 'n') {
    return `<c r="${addr}"${sAttr}><v>${value}</v></c>`;
  }
  return `<c r="${addr}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${encodeXml(value)}</t></is></c>`;
}

/**
 * Patch cells in an xlsx file.
 *
 * @param {ArrayBuffer|Uint8Array} xlsxBytes  raw xlsx file
 * @param {Array<{addr:string, value:any, type?:'s'|'n', append?:boolean}>} mods
 *   - addr: cell address like "D4"
 *   - value: new value (string or number); '' to blank
 *   - type: 's' (default) or 'n'
 *   - append: when true, prepend the cell's existing text + "\n" before value
 * @returns {Uint8Array} patched xlsx bytes
 */
export function patchXlsxCells(xlsxBytes, mods) {
  const input = xlsxBytes instanceof Uint8Array ? xlsxBytes : new Uint8Array(xlsxBytes);
  const files = unzipSync(input);

  if (!files[SHEET_PATH]) throw new Error(`xlsx is missing ${SHEET_PATH}`);
  const dec = new TextDecoder('utf-8');
  let sheetXml = dec.decode(files[SHEET_PATH]);
  const sstXml = files[SST_PATH] ? dec.decode(files[SST_PATH]) : '';

  for (const mod of mods) {
    const { addr, value, type = 's', append = false } = mod;

    // Match the existing <c r="ADDR" ...> element. Two shapes:
    //   <c r="D4" s="9" t="s"><v>18</v></c>
    //   <c r="F4" s="10"/>
    const cellRe = new RegExp(
      `<c\\s+r="${addr}"((?:\\s+[a-zA-Z][^=]*="[^"]*")*)(?:\\s*/>|\\s*>([\\s\\S]*?)<\\/c>)`,
    );
    const m = sheetXml.match(cellRe);
    if (!m) continue; // cell not in template — silently skip (template owns the layout)

    const attrs = m[1] || '';
    const inner = m[2] || '';
    const sMatch = attrs.match(/\bs="(\d+)"/);
    const sIdx = sMatch ? sMatch[1] : null;

    let finalValue = value;
    if (append) {
      let existing = '';
      const inlineMatch = inner.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);
      if (inlineMatch) {
        existing = decodeXml(inlineMatch[1]);
      } else if (/\bt="s"/.test(attrs)) {
        const vMatch = inner.match(/<v>(\d+)<\/v>/);
        if (vMatch) existing = resolveSST(sstXml, parseInt(vMatch[1], 10));
      }
      finalValue = existing ? `${existing}\n${value}` : value;
    }

    const replacement = buildCell(addr, sIdx, finalValue, type);
    sheetXml = sheetXml.replace(cellRe, replacement);
  }

  files[SHEET_PATH] = strToU8(sheetXml);

  // Keep sharedStrings.xml's `count` consistent with the sheet. We convert
  // patched string cells to inlineStr (and blank others), so the number of
  // t="s" references drops below the template's declared count. A stale count
  // is tolerated when the file is read as .xls (content-sniffed) but makes
  // Excel flag a .xlsx as needing repair ("removed unreadable content"). The
  // `<si>` entries + uniqueCount are untouched, so only `count` needs updating.
  if (sstXml) {
    const refs = (sheetXml.match(/ t="s"/g) || []).length;
    const updatedSst = sstXml.replace(/(<sst\b[^>]*?\bcount=")\d+(")/, `$1${refs}$2`);
    files[SST_PATH] = strToU8(updatedSst);
  }

  return zipSync(files);
}
