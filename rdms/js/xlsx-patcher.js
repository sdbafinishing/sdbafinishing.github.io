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
  return zipSync(files);
}
