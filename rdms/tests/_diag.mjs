import * as CFBmod from 'cfb';
import { readFileSync } from 'fs';
const CFB = CFBmod.default || CFBmod;

function wb(path) {
  const u8 = new Uint8Array(readFileSync(new URL(path, import.meta.url)));
  const c = CFB.parse(u8, { type: 'array' });
  return Uint8Array.from(c.FileIndex.find(f => /workbook/i.test(f.name)).content);
}
const hex = (d, s, n) => [...d.subarray(s, s + n)].map(x => x.toString(16).padStart(2, '0')).join(' ');

const a = wb('../sample start list/after_Joyi_StartList_2026TN_20260619.xls');

// Walk records; note substream (BOF dt), DIMENSIONS, first 3 ROW, first LABELSST + first RK
let off = 0, sub = '?', shownRow = 0, shownLabel = false, shownRK = false;
while (off + 4 <= a.length) {
  const t = a[off] | (a[off+1]<<8); const len = a[off+2] | (a[off+3]<<8);
  const data = a.subarray(off + 4, off + 4 + len);
  if (t === 0x0809) { const dt = data[2] | (data[3]<<8); sub = dt === 0x0010 ? 'SHEET' : dt === 0x0005 ? 'GLOBALS' : 'dt' + dt; console.log(`BOF ${sub}`); }
  if (t === 0x0200) console.log(`DIMENSIONS (len ${len}):`, hex(data, 0, len), '= rwMic,rwMac,colMic,colMac');
  if (t === 0x0208 && shownRow < 3) { console.log(`ROW (len ${len}):`, hex(data, 0, len)); shownRow++; }
  if (t === 0x00fd && !shownLabel) { console.log(`LABELSST (len ${len}):`, hex(data, 0, len), '= rw,col,ixfe,isst'); shownLabel = true; }
  if (t === 0x027e && !shownRK) { console.log(`RK (len ${len}):`, hex(data, 0, len), '= rw,col,ixfe,rkval'); shownRK = true; }
  off += 4 + len;
}
