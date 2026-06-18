import * as CFBmod from 'cfb';
import { readFileSync, writeFileSync } from 'fs';
const CFB = CFBmod.default || CFBmod;

const SAMPLE = new URL('../sample start list/', import.meta.url);
const u8 = new Uint8Array(readFileSync(new URL('before_Joyi_StartList_2026TN_20260619.xls', SAMPLE)));
const cont = CFB.parse(u8, { type: 'array' });
const wbEntry = cont.FileIndex.find(f => /workbook/i.test(f.name));
const wbBytes = Uint8Array.from(wbEntry.content);

// Walk to the SHEET substream's DIMENSIONS record; capture its end offset + dims.
let off = 0, sub = null, dimEnd = -1, rwMac = 0, colMac = 0;
while (off + 4 <= wbBytes.length) {
  const t = wbBytes[off] | (wbBytes[off+1]<<8);
  const len = wbBytes[off+2] | (wbBytes[off+3]<<8);
  const d = wbBytes.subarray(off + 4, off + 4 + len);
  if (t === 0x0809) sub = (d[2] | (d[3]<<8)) === 0x0010 ? 'sheet' : 'globals';
  if (t === 0x0200 && sub === 'sheet') {
    rwMac = d[4] | (d[5]<<8) | (d[6]<<16) | (d[7]<<24);
    colMac = d[10] | (d[11]<<8);
    dimEnd = off + 4 + len;
    break;
  }
  off += 4 + len;
}
if (dimEnd < 0) throw new Error('DIMENSIONS not found in sheet substream');
console.log('rwMac=', rwMac, 'colMac=', colMac, 'dimEnd=', dimEnd);

// Build ROW records (0x0208), one per row 0..rwMac-1, modelled byte-for-byte on
// Excel's: colMic=0, colMac=<dim>, miyRw=0x0140, grbit=0x0100 (fGhostDirty), ixfe=15.
const rows = [];
for (let r = 0; r < rwMac; r++) {
  const rec = [0x08, 0x02, 0x10, 0x00,                  // header: type 0x0208, len 16
    r & 0xff, (r >> 8) & 0xff,                          // rw
    0x00, 0x00,                                         // colMic = 0
    colMac & 0xff, (colMac >> 8) & 0xff,                // colMac
    0x40, 0x01,                                         // miyRw = 0x0140
    0x00, 0x00, 0x00, 0x00,                             // reserved
    0x00, 0x01,                                         // grbit = 0x0100 (fGhostDirty)
    0x0f, 0x00];                                        // ixfe = 15
  rows.push(...rec);
}
const rowBlock = Uint8Array.from(rows);

const out = new Uint8Array(wbBytes.length + rowBlock.length);
out.set(wbBytes.subarray(0, dimEnd), 0);
out.set(rowBlock, dimEnd);
out.set(wbBytes.subarray(dimEnd), dimEnd + rowBlock.length);

wbEntry.content = out;
wbEntry.size = out.length;
const root = cont.FileIndex.find(f => f.type === 5);
root.name = 'Root Entry';
root.clsid = '2008020000000000c000000000000046';

const built = CFB.write(cont, { type: 'array' });
const builtU8 = built instanceof Uint8Array ? built : Uint8Array.from(built);
writeFileSync(new URL('ROWFIX_test_2026TN.xls', SAMPLE), builtU8);

// Verify it re-parses + has ROW records now
import('xlsx').then(XLSXm => {
  const XLSX = XLSXm;
  const re = XLSX.read(builtU8, { type: 'array' });
  const c2 = CFB.parse(builtU8, { type: 'array' });
  const d2 = Uint8Array.from(c2.FileIndex.find(f => /workbook/i.test(f.name)).content);
  let o = 0, nrow = 0;
  while (o + 4 <= d2.length) { const t = d2[o]|(d2[o+1]<<8); const l = d2[o+2]|(d2[o+3]<<8); if (t===0x0208) nrow++; o += 4 + l; }
  console.log('WROTE ROWFIX_test_2026TN.xls  | sheet:', re.SheetNames[0], '| ROW records now:', nrow, '| readable A1:', re.Sheets[re.SheetNames[0]].A1?.v);
});
