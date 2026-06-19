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
  return xml.replace(/<row r="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g, (m, n, attrs, inner) => {
    const num = parseInt(n, 10);
    if (num < startRow) return m;
    const newNum = num + delta;
    // Each cell inside this row has r="<col><num>" — update only when
    // the cell row matches the row we're shifting (defensive).
    const newInner = inner.replace(/r="([A-Z]+)(\d+)"/g, (mm, col, rn) => {
      return parseInt(rn, 10) === num ? `r="${col}${newNum}"` : mm;
    });
    return `<row r="${newNum}"${attrs}>${newInner}</row>`;
  });
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
