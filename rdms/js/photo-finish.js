/**
 * SDBA RDMS — Photo Finish Viewer
 *
 * Renders Joyi line-scan photo-finish images (.lcd, magic = "JLIF") to a
 * canvas, with optional overlays driven by a matching .jyd file:
 *   - vertical "reach line" per lane at the pixel column the boat crossed,
 *     labelled with lane number + finish time
 *   - bottom time axis built from per-lane finish times
 *
 * Format notes (reverse-engineered from sample 2025TN.9.lcd):
 *   Magic         : "JLIF" at offset 0
 *   width  (u32?) : not directly stored; derived from data size / height
 *   height (u32)  : offset 12, 0x0878 = 2168 for the sample
 *   header size   : 24 bytes seems to fit (data = w*h*bytesPerPx exactly)
 *
 * For the sample file:
 *   file size 31,080,472 - 24 header = 31,080,448 data
 *   = 14336 cols * 2168 rows * 1 byte/px  ✓  (largest ReachPoint = 11519 fits)
 *   = 7168 cols * 2168 rows * 2 bytes/px  ✗  (7168 < ReachPoint 11519)
 * So the working theory is **1 byte per photosite** (most likely Bayer,
 * possibly raw grayscale from a monochrome sensor). We render as
 * grayscale by default; demosaicing can be added later once we confirm
 * the Bayer pattern with the operator.
 *
 * The format is *guessed* — the viewer exposes width/bytesPerPx/header
 * overrides via the `formatHint` parameter so we can iterate without a
 * redeploy if the assumption is wrong.
 */

const DEFAULT_HEADER_BYTES = 24;
const SUPPORTED_RENDERS = ['grayscale', 'bayer-rggb', 'bayer-bggr', 'bayer-grbg', 'bayer-gbrg'];

/**
 * Parse the JLIF header and return image metadata.
 * @param {ArrayBuffer} buf
 * @param {Object} [hint] - optional overrides { width, height, bytesPerPx, headerBytes }
 * @returns {{ width, height, bytesPerPx, headerBytes, raw: Uint8Array }}
 */
export function parseLcdHeader(buf, hint = {}) {
  if (buf.byteLength < 32) throw new Error('LCD file too small');
  const u8 = new Uint8Array(buf);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== 'JLIF') throw new Error(`Not a JLIF file. Magic = "${magic}"`);

  const view = new DataView(buf);
  const headerHeight = view.getUint32(12, /* littleEndian */ true); // 0x0878 = 2168 in sample
  const height = hint.height || headerHeight || 2168;
  const headerBytes = hint.headerBytes || DEFAULT_HEADER_BYTES;
  const bytesPerPx = hint.bytesPerPx || 1;

  const dataBytes = buf.byteLength - headerBytes;
  const computedWidth = Math.floor(dataBytes / height / bytesPerPx);
  const width = hint.width || computedWidth;

  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid derived dimensions: ${width}x${height}`);
  }

  return {
    width,
    height,
    bytesPerPx,
    headerBytes,
    raw: new Uint8Array(buf, headerBytes, width * height * bytesPerPx),
  };
}

/**
 * Render the JLIF pixel data onto a 2D canvas context.
 * Uses createImageData so we can write pixel-level data directly.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ width, height, bytesPerPx, raw }} img
 * @param {string} [renderMode] - one of SUPPORTED_RENDERS
 */
export function renderLcdToCanvas(ctx, img, renderMode = 'grayscale') {
  const { width, height, raw, bytesPerPx } = img;
  const imageData = ctx.createImageData(width, height);
  const dst = imageData.data;

  if (bytesPerPx === 1 && renderMode === 'grayscale') {
    // Each photosite as luminance. If the source is Bayer-pattern, this
    // produces a faintly checkered grayscale — still legible for
    // verifying boat positions.
    for (let i = 0; i < raw.length; i++) {
      const j = i * 4;
      const v = raw[i];
      dst[j] = v;
      dst[j + 1] = v;
      dst[j + 2] = v;
      dst[j + 3] = 255;
    }
  } else if (bytesPerPx === 1 && renderMode.startsWith('bayer-')) {
    // Quick-and-dirty 2×2 block demosaic: each 2×2 block of photosites
    // produces one RGB pixel. The output image is still full size; we
    // just sample neighbours per pattern. Patterns:
    //   rggb: row even col even = R, col odd = G
    //         row odd  col even = G, col odd = B
    const pattern = renderMode.slice('bayer-'.length); // rggb / bggr / grbg / gbrg
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const j = i * 4;
        const v = raw[i];
        // Sample neighbours for the two missing channels.
        const left  = x > 0 ? raw[i - 1] : v;
        const right = x < width - 1 ? raw[i + 1] : v;
        const up    = y > 0 ? raw[i - width] : v;
        const down  = y < height - 1 ? raw[i + width] : v;
        const ul = (x > 0 && y > 0) ? raw[i - width - 1] : v;
        const ur = (x < width - 1 && y > 0) ? raw[i - width + 1] : v;
        const dl = (x > 0 && y < height - 1) ? raw[i + width - 1] : v;
        const dr = (x < width - 1 && y < height - 1) ? raw[i + width + 1] : v;

        // Decide which channel this photosite is, based on pattern + parity.
        const rowEven = (y & 1) === 0;
        const colEven = (x & 1) === 0;
        let role; // 'R', 'G', 'B'
        switch (pattern) {
          case 'rggb': role = rowEven ? (colEven ? 'R' : 'G') : (colEven ? 'G' : 'B'); break;
          case 'bggr': role = rowEven ? (colEven ? 'B' : 'G') : (colEven ? 'G' : 'R'); break;
          case 'grbg': role = rowEven ? (colEven ? 'G' : 'R') : (colEven ? 'B' : 'G'); break;
          case 'gbrg': role = rowEven ? (colEven ? 'G' : 'B') : (colEven ? 'R' : 'G'); break;
          default:    role = 'G';
        }

        let R, G, B;
        if (role === 'R') {
          R = v;
          G = (left + right + up + down) >> 2;
          B = (ul + ur + dl + dr) >> 2;
        } else if (role === 'B') {
          B = v;
          G = (left + right + up + down) >> 2;
          R = (ul + ur + dl + dr) >> 2;
        } else {
          G = v;
          // Two diagonal R-G-B configurations depending on row parity.
          if ((rowEven && (pattern === 'rggb' || pattern === 'grbg'))
              || (!rowEven && (pattern === 'bggr' || pattern === 'gbrg'))) {
            R = (left + right) >> 1;
            B = (up + down) >> 1;
          } else {
            R = (up + down) >> 1;
            B = (left + right) >> 1;
          }
        }
        dst[j] = R;
        dst[j + 1] = G;
        dst[j + 2] = B;
        dst[j + 3] = 255;
      }
    }
  } else {
    throw new Error(`Unsupported render mode: ${renderMode} for ${bytesPerPx} bytes/px`);
  }

  ctx.canvas.width = width;
  ctx.canvas.height = height;
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Build a Photo Finish modal viewer for the given race.
 *
 * The operator picks the .lcd (and optionally the matching .jyd) via a
 * file input. We render the .lcd to an off-screen canvas at native
 * resolution, then place it inside a scroll-zoom container with vertical
 * reach-line overlays from the .jyd's ReachPoints.
 *
 * @param {Object} race - the active race record (provides start_time)
 * @param {File[]} files - selected file(s); we look for one .lcd and one .jyd
 */
export async function showPhotoFinishModal(race, files) {
  const lcdFile = [...files].find(f => /\.lcd$/i.test(f.name));
  const jydFile = [...files].find(f => /\.jyd$/i.test(f.name));
  if (!lcdFile) throw new Error('No .lcd file in the selection');

  // Parse .jyd first (if present) for overlay metadata.
  let jydData = null;
  if (jydFile) {
    const { parseJydFile } = await import('./import.js');
    try {
      const parsed = await parseJydFile(jydFile);
      jydData = parsed.jyd;
    } catch (err) {
      console.warn('Could not parse .jyd, continuing without overlays:', err);
    }
  }

  // Parse + render the .lcd. Try grayscale first; user can flip render mode.
  const buf = await lcdFile.arrayBuffer();
  const img = parseLcdHeader(buf);

  // Build modal.
  const existing = document.getElementById('photoFinishModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'photoFinishModal';
  modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:9999; display:flex; flex-direction:column;';
  modal.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; padding:10px 16px; background:var(--bg-card); border-bottom:1px solid var(--border);">
      <strong style="font-size:14px;">Photo Finish — Race ${race.race_number}</strong>
      <span style="font-size:12px; color:var(--text-tertiary);">${img.width}×${img.height} · ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB</span>
      <span style="flex:1;"></span>
      <label style="font-size:12px; display:flex; align-items:center; gap:6px;">
        Render:
        <select id="pfRenderMode" class="form-select" style="font-size:12px; padding:2px 6px;">
          <option value="grayscale" selected>Grayscale</option>
          <option value="bayer-rggb">Bayer RGGB</option>
          <option value="bayer-bggr">Bayer BGGR</option>
          <option value="bayer-grbg">Bayer GRBG</option>
          <option value="bayer-gbrg">Bayer GBRG</option>
        </select>
      </label>
      <label style="font-size:12px; display:flex; align-items:center; gap:6px;" title="Pixel columns per second — used to label the time axis">
        Px/sec:
        <input id="pfPxPerSec" type="number" min="1" value="1000" style="width:70px; font-size:12px; padding:2px 6px;">
      </label>
      <button class="btn btn-ghost btn-sm" id="pfClose" title="Close (Esc)">
        <i class="material-icons" style="font-size:18px;">close</i>
      </button>
    </div>
    <div id="pfScroll" style="flex:1; overflow:auto; background:#111; position:relative;">
      <canvas id="pfCanvas" style="display:block;"></canvas>
    </div>
  `;
  document.body.appendChild(modal);

  const canvas = modal.querySelector('#pfCanvas');
  const ctx = canvas.getContext('2d');
  const scroll = modal.querySelector('#pfScroll');

  const draw = (mode) => {
    renderLcdToCanvas(ctx, img, mode);
    drawOverlays();
  };

  function drawOverlays() {
    if (!jydData?.reachPoints?.length) return;
    ctx.save();
    // Vertical reach lines per lane.
    ctx.strokeStyle = 'rgba(0, 200, 230, 0.6)';
    ctx.lineWidth = 1;
    ctx.font = '14px monospace';
    ctx.fillStyle = '#ff4040';

    const players = jydData.players || [];
    const byLaneRank = new Map();
    players.forEach(p => byLaneRank.set(p.lane, p));

    for (const rp of jydData.reachPoints) {
      const x = rp.line;
      if (x < 0 || x >= img.width) continue;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, img.height);
      ctx.stroke();
      // No is 0-based, lane is No+1.
      const lane = rp.no + 1;
      const player = byLaneRank.get(lane);
      const label = player
        ? `${lane}  ${formatMs(player.realScoreMs)}`
        : `${lane}`;
      ctx.fillText(label, x + 4, 14 + (rp.no % 6) * 16);
    }
    ctx.restore();
  }

  modal.querySelector('#pfRenderMode').addEventListener('change', (e) => {
    draw(e.target.value);
  });
  modal.querySelector('#pfClose').addEventListener('click', () => modal.remove());
  const onKey = (e) => { if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  // Initial render
  draw('grayscale');

  // Scroll to the earliest ReachPoint so the operator lands on the action.
  if (jydData?.reachPoints?.length) {
    const minLine = Math.min(...jydData.reachPoints.map(rp => rp.line));
    requestAnimationFrame(() => {
      scroll.scrollLeft = Math.max(0, minLine - 400);
    });
  }
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return '';
  const totalCs = Math.round(ms / 10);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60);
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
