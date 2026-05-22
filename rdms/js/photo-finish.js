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
// Per-scanline metadata bytes prefixed before pixel data. Statistical
// analysis of the sample file showed storage cols 3..7 are always zero
// and col 0..2 carry frame-counter-like bytes — i.e. an 8-byte preamble.
const DEFAULT_LINE_HEADER_BYTES = 8;
// Daheng trilinear-RGB line-scan: each pixel = 3 bytes (R, G, B
// interleaved). Lag-3 autocorrelation on the sample's storage rows
// confirms this pattern.
const DEFAULT_BYTES_PER_PIXEL = 3;

/**
 * Parse the JLIF header and return image metadata.
 *
 * Layout (reverse-engineered from sample 2025TN.9.lcd):
 *   Storage is row-major over **time slices**: each stored row is one captured
 *   line of the camera at one instant. So:
 *     storage rows = number of time slices (= display width  after transpose)
 *     storage cols = scene height in pixels  (= display height after transpose)
 *
 *   Header offset 12 holds the "bytes per scanline" = stored column count
 *   = display height. The stored row count is derived from (dataBytes / cols).
 *
 *   The display orientation (boats running horizontally with time on the
 *   x-axis, as Joyi's own viewer shows) requires transposing the storage.
 *   `displayWidth` and `displayHeight` are the post-transpose dimensions.
 *
 * @param {ArrayBuffer} buf
 * @param {Object} [hint] - optional overrides { storageRows, storageCols, bytesPerPx, headerBytes }
 * @returns {{ displayWidth, displayHeight, storageRows, storageCols, bytesPerPx, headerBytes, raw: Uint8Array }}
 */
export function parseLcdHeader(buf, hint = {}) {
  if (buf.byteLength < 32) throw new Error('LCD file too small');
  const u8 = new Uint8Array(buf);
  const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
  if (magic !== 'JLIF') throw new Error(`Not a JLIF file. Magic = "${magic}"`);

  const view = new DataView(buf);
  // Bytes-per-scanline lives at offset 12. In the sample: 0x0878 = 2168.
  // That's 8 metadata bytes + 720 pixels × 3 channels.
  const headerScanlineCols = view.getUint32(12, /* littleEndian */ true);
  const storageCols = hint.storageCols || headerScanlineCols || 2168;
  const headerBytes = hint.headerBytes || DEFAULT_HEADER_BYTES;
  const lineHeaderBytes = hint.lineHeaderBytes != null ? hint.lineHeaderBytes : DEFAULT_LINE_HEADER_BYTES;
  const bytesPerPixel = hint.bytesPerPixel || DEFAULT_BYTES_PER_PIXEL;

  // pixels per scan line, after stripping the per-line preamble.
  const pixelsPerLine = Math.floor((storageCols - lineHeaderBytes) / bytesPerPixel);

  const dataBytes = buf.byteLength - headerBytes;
  const storageRows = hint.storageRows || Math.floor(dataBytes / storageCols);

  if (storageRows <= 0 || pixelsPerLine <= 0) {
    throw new Error(`Invalid derived storage dimensions: rows=${storageRows} pixelsPerLine=${pixelsPerLine}`);
  }

  // Per-scanline preamble carries a u32 LE microsecond timestamp at offset 0
  // (bytes 4..7 are always zero in observed samples). Sampling the deltas tells
  // us the camera's actual line rate — the only place framerate is stored
  // anywhere in the Joyi triplet (.lcd / .cpd / .jyd / .xls).
  //
  // Use median of (first..mid..last) deltas to skip the very-first row in
  // case it carries a sync artefact, and to ignore the occasional ±1 µs jitter.
  let fpsFromMetadata = null;
  let firstTsUs = null;
  if (storageRows >= 2) {
    const rawView = new Uint8Array(buf);
    firstTsUs = new DataView(rawView.buffer, rawView.byteOffset).getUint32(headerBytes, true);
    const lastTsUs = new DataView(rawView.buffer, rawView.byteOffset).getUint32(headerBytes + (storageRows - 1) * storageCols, true);
    const spanUs = lastTsUs - firstTsUs;
    if (spanUs > 0) {
      // Mean is fine here — deltas are tightly clustered around 1957..1958 µs.
      fpsFromMetadata = (storageRows - 1) * 1e6 / spanUs;
    }
  }

  return {
    displayWidth: storageRows,        // each stored row = one time slice = one display column
    displayHeight: pixelsPerLine,     // post-decode pixels along the scene-Y axis
    storageRows,
    storageCols,
    lineHeaderBytes,
    bytesPerPixel,
    pixelsPerLine,
    fpsFromMetadata,                  // null if unavailable
    firstTsUs,                        // first scanline's µs timestamp (camera clock)
    raw: new Uint8Array(buf, headerBytes, storageRows * storageCols),
  };
}

// Tile width in display columns. Sized so a tile's ImageData is comfortably
// below browser canvas-area limits (Safari caps at ~16k width × ~16k height
// AND at a total pixel-area budget that 8192×720 stays well under). Each
// tile costs ~24 MB peak (RGBA × 8192 × 720) so onscreen-only rendering
// caps memory at ~70 MB regardless of total image width.
const TILE_WIDTH = 8192;

/**
 * Render the JLIF pixel data onto a 2D canvas context — entire image.
 * Convenience wrapper around renderLcdRangeToCanvas for callers that don't
 * need tiling (small images, off-screen exports).
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} img - parseLcdHeader output
 * @param {string} [renderMode] - one of SUPPORTED_RENDERS
 */
export function renderLcdToCanvas(ctx, img, renderMode = 'trilinear-rgb') {
  return renderLcdRangeToCanvas(ctx, img, renderMode, 0, img.displayWidth);
}

/**
 * Render a column range [colStart, colEnd) of the JLIF pixel data into the
 * given canvas context. The canvas is sized to (colEnd - colStart) × height.
 * Used both by the tile renderer and the crop-and-save export.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} img - parseLcdHeader output
 * @param {string} renderMode
 * @param {number} colStart - inclusive
 * @param {number} colEnd - exclusive, clamped to displayWidth
 */
export function renderLcdRangeToCanvas(ctx, img, renderMode, colStart, colEnd) {
  const { displayHeight, storageCols, lineHeaderBytes, bytesPerPixel, pixelsPerLine, raw } = img;
  const c0 = Math.max(0, Math.floor(colStart));
  const c1 = Math.min(img.displayWidth, Math.ceil(colEnd));
  const w = Math.max(0, c1 - c0);
  ctx.canvas.width = w;
  ctx.canvas.height = displayHeight;
  if (w === 0) return;
  const imageData = ctx.createImageData(w, displayHeight);
  const dst = imageData.data;

  // Storage layout per scan line:
  //   [lineHeaderBytes preamble] [pixelsPerLine × bytesPerPixel channel-interleaved data]
  // Display: time on X, scene-Y on Y. Pixel (x = sr, y = py) sources its
  // bytes from raw[sr * storageCols + lineHeaderBytes + py * bytesPerPixel + ch].
  //
  // The native format is trilinear RGB (3 bytes/pixel). Mode "grayscale"
  // collapses to luminance; "trilinear-XYZ" renders the channel permutation
  // so the operator can find the right order visually.

  // Channel permutation: which storage byte goes to R/G/B in the imageData.
  const channelOrder = (() => {
    switch (renderMode) {
      case 'trilinear-rgb': return [0, 1, 2];
      case 'trilinear-bgr': return [2, 1, 0];
      case 'trilinear-grb': return [1, 0, 2];
      case 'trilinear-rbg': return [0, 2, 1];
      case 'trilinear-gbr': return [1, 2, 0];
      case 'trilinear-brg': return [2, 0, 1];
      case 'grayscale':     return null; // averaged luminance below
      case 'grayscale-smooth': return null;
      default: return [0, 1, 2];
    }
  })();

  if (channelOrder) {
    for (let sr = c0; sr < c1; sr++) {
      const lineBase = sr * storageCols + lineHeaderBytes;
      const dstCol = sr - c0;
      for (let py = 0; py < pixelsPerLine; py++) {
        const px = lineBase + py * bytesPerPixel;
        const r = raw[px + channelOrder[0]];
        const g = raw[px + channelOrder[1]];
        const b = raw[px + channelOrder[2]];
        const di = (py * w + dstCol) * 4;
        dst[di] = r;
        dst[di + 1] = g;
        dst[di + 2] = b;
        dst[di + 3] = 255;
      }
    }
  } else {
    // Grayscale = average of 3 channels per pixel. Smoothed variant adds
    // a 1-2-1 blur along the scene-Y axis.
    const smooth = renderMode === 'grayscale-smooth';
    for (let sr = c0; sr < c1; sr++) {
      const lineBase = sr * storageCols + lineHeaderBytes;
      const dstCol = sr - c0;
      for (let py = 0; py < pixelsPerLine; py++) {
        const px = lineBase + py * bytesPerPixel;
        let v = (raw[px] + raw[px + 1] + raw[px + 2]) / 3;
        if (smooth) {
          const pxUp = py > 0 ? lineBase + (py - 1) * bytesPerPixel : px;
          const pxDn = py < pixelsPerLine - 1 ? lineBase + (py + 1) * bytesPerPixel : px;
          const vu = (raw[pxUp] + raw[pxUp + 1] + raw[pxUp + 2]) / 3;
          const vd = (raw[pxDn] + raw[pxDn + 1] + raw[pxDn + 2]) / 3;
          v = (vu + 2 * v + vd) / 4;
        }
        v |= 0;
        const di = (py * w + dstCol) * 4;
        dst[di] = v;
        dst[di + 1] = v;
        dst[di + 2] = v;
        dst[di + 3] = 255;
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}

/**
 * Show a small upstream "drop your files" modal with two drop zones — one for
 * the .lcd, one for the .jyd. Avoids the macOS multi-select awkwardness where
 * an `accept` filter restricts the picker to one extension at a time.
 *
 * Calls `showPhotoFinishModal(race, files)` once the operator clicks "Open".
 * Auto-loads any matching files passed in `preset` (used when we auto-find
 * the pair from the Joyi folder).
 *
 * @param {Object} race
 * @param {{ lcd?: File, jyd?: File }} [preset]
 */
export async function showPhotoFinishPicker(race, preset = {}) {
  const existing = document.getElementById('photoFinishPicker');
  if (existing) existing.remove();

  let lcdFile = preset.lcd || null;
  let jydFile = preset.jyd || null;

  const modal = document.createElement('div');
  modal.id = 'photoFinishPicker';
  modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.7); z-index:9998; display:flex; align-items:center; justify-content:center;';
  modal.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:18px 20px; width:min(640px,92vw); box-shadow:var(--shadow-lg);">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
        <i class="material-icons" style="font-size:22px; color:var(--accent);">photo_camera</i>
        <strong style="font-size:15px;">Photo Finish — Race ${race.race_number}</strong>
        <span style="flex:1;"></span>
        <button class="btn btn-ghost btn-sm" id="pfpClose" title="Cancel">
          <i class="material-icons" style="font-size:18px;">close</i>
        </button>
      </div>
      <p style="font-size:12px; color:var(--text-tertiary); margin:0 0 12px;">
        Drop the matching <code>.lcd</code> and <code>.jyd</code> files, or click to pick. Both are required — the .jyd carries the reach points and finish times used to anchor the time axis.
      </p>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
        <div class="pfp-dz" data-kind="lcd" data-accept=".lcd"
             style="border:2px dashed var(--border); border-radius:var(--radius-sm); padding:18px; text-align:center; cursor:pointer; transition:all 0.15s;">
          <i class="material-icons" style="font-size:28px; color:var(--text-tertiary);">image</i>
          <div style="font-weight:600; margin-top:4px;">.lcd image <span style="color:var(--danger); font-weight:400;">*</span></div>
          <div class="pfp-status" style="font-size:11px; color:var(--text-tertiary); margin-top:6px; min-height:14px;">drop here or click</div>
        </div>
        <div class="pfp-dz" data-kind="jyd" data-accept=".jyd"
             style="border:2px dashed var(--border); border-radius:var(--radius-sm); padding:18px; text-align:center; cursor:pointer; transition:all 0.15s;">
          <i class="material-icons" style="font-size:28px; color:var(--text-tertiary);">description</i>
          <div style="font-weight:600; margin-top:4px;">.jyd metadata <span style="color:var(--danger); font-weight:400;">*</span></div>
          <div class="pfp-status" style="font-size:11px; color:var(--text-tertiary); margin-top:6px; min-height:14px;">drop here or click</div>
        </div>
      </div>
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:14px;">
        <button class="btn btn-ghost" id="pfpCancel">Cancel</button>
        <button class="btn btn-primary" id="pfpOpen" disabled>
          <i class="material-icons">open_in_new</i> Open
        </button>
      </div>
      <input type="file" id="pfpLcdInput" accept=".lcd" style="display:none;">
      <input type="file" id="pfpJydInput" accept=".jyd" style="display:none;">
    </div>
  `;
  document.body.appendChild(modal);

  const openBtn = modal.querySelector('#pfpOpen');
  const lcdInput = modal.querySelector('#pfpLcdInput');
  const jydInput = modal.querySelector('#pfpJydInput');

  const zone = (kind) => modal.querySelector(`.pfp-dz[data-kind="${kind}"]`);
  const status = (kind) => zone(kind).querySelector('.pfp-status');

  function refresh() {
    if (lcdFile) {
      status('lcd').textContent = `${lcdFile.name} · ${(lcdFile.size / 1024 / 1024).toFixed(1)} MB`;
      zone('lcd').style.borderColor = 'var(--success, #10b981)';
    } else {
      status('lcd').textContent = 'drop here or click';
      zone('lcd').style.borderColor = 'var(--border)';
    }
    if (jydFile) {
      status('jyd').textContent = `${jydFile.name} · ${(jydFile.size / 1024).toFixed(1)} KB`;
      zone('jyd').style.borderColor = 'var(--success, #10b981)';
    } else {
      status('jyd').textContent = 'drop here or click';
      zone('jyd').style.borderColor = 'var(--border)';
    }
    // Both LCD and JYD are required so the time axis can be anchored to
    // race-start. Disable Open until both are present.
    openBtn.disabled = !lcdFile || !jydFile;
  }
  refresh();

  function accept(kind, file) {
    if (!file) return;
    const ext = (file.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    if (kind === 'lcd' && ext !== '.lcd') return;
    if (kind === 'jyd' && ext !== '.jyd') return;
    if (kind === 'lcd') lcdFile = file;
    else jydFile = file;
    refresh();
  }

  // Auto-sort files dropped onto either zone — if the user drops both files
  // onto the .lcd zone we still route them by extension. Also handles the
  // common case of dragging the whole .lcd+.jyd pair from Finder.
  function acceptAny(files) {
    for (const f of files) {
      const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
      if (ext === '.lcd') lcdFile = f;
      else if (ext === '.jyd') jydFile = f;
    }
    refresh();
  }

  for (const kind of ['lcd', 'jyd']) {
    const z = zone(kind);
    z.addEventListener('dragover', (e) => {
      e.preventDefault();
      z.style.background = 'rgba(255,255,255,0.04)';
    });
    z.addEventListener('dragleave', () => { z.style.background = ''; });
    z.addEventListener('drop', (e) => {
      e.preventDefault();
      z.style.background = '';
      acceptAny(e.dataTransfer.files);
    });
    z.addEventListener('click', () => {
      (kind === 'lcd' ? lcdInput : jydInput).click();
    });
  }
  lcdInput.addEventListener('change', () => { accept('lcd', lcdInput.files[0]); lcdInput.value = ''; });
  jydInput.addEventListener('change', () => { accept('jyd', jydInput.files[0]); jydInput.value = ''; });

  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  modal.querySelector('#pfpClose').addEventListener('click', close);
  modal.querySelector('#pfpCancel').addEventListener('click', close);

  openBtn.addEventListener('click', async () => {
    const files = [lcdFile, jydFile].filter(Boolean);
    close();
    try {
      await showPhotoFinishModal(race, files);
    } catch (err) {
      const { showToast } = await import('./utils.js');
      showToast(`Photo finish failed: ${err.message}`, 'error', 5000);
      console.error(err);
    }
  });
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

  // Parse .jyd first (if present) for overlay metadata. Tracks status so the
  // modal header can show whether overlays loaded — silent failure here led
  // to a wrong-time-by-capture-offset bug that took a round-trip to diagnose.
  let jydData = null;
  let jydLoadError = null;
  if (jydFile) {
    const { parseJydFile } = await import('./import.js');
    try {
      const parsed = await parseJydFile(jydFile);
      jydData = parsed.jyd;
    } catch (err) {
      jydLoadError = err.message || String(err);
      console.warn('Could not parse .jyd, continuing without overlays:', err);
    }
  }

  // Resolve metadata for the left-side info panel.
  //
  // Field strategy:
  //   - event_official_name_en/tc are the OPTIONAL long names used only on
  //     the photo-finish export. If both empty, fall back to the existing
  //     short event_long_name_en (RDMS internal name), then to short ref.
  //   - div_main_name_en/tc are optional long division names with similar
  //     fallback to the short division_name / div_short_ref.
  //   - Lane draw rows skip lanes with no team name, with "---" team name,
  //     or with remarks === "DNS" (operator already marked DNS).
  const { getConfig: _getCfg, getAllDivisions: _getDivs, getLaneResults: _getLanes } = await import('./db.js');
  const _cfg = await _getCfg();
  let _divInfo = null;
  if (race?.division_id) {
    const _divs = await _getDivs();
    _divInfo = _divs.find(d => d.id === race.division_id) || null;
  }
  let _laneDraw = [];
  if (race?.race_number != null) {
    try {
      const lanes = await _getLanes(race.race_number);
      _laneDraw = lanes
        .filter(lr => {
          const tn = (lr.team_name || '').trim();
          if (!tn || tn === '---') return false;
          if (lr.remarks === 'DNS') return false;
          return true;
        })
        .sort((a, b) => (a.lane_number || 0) - (b.lane_number || 0))
        .map(lr => ({ lane: lr.lane_number, team: lr.team_name }));
    } catch { /* lane fetch is best-effort */ }
  }
  const meta = {
    eventEn: _cfg?.event_official_name_en || _cfg?.event_long_name_en || '',
    eventTc: _cfg?.event_official_name_tc || '',
    eventShort: _cfg?.event_short_ref || '',
    eventColour: _cfg?.event_colour_code_hex || '#0f172a',
    raceDate: _cfg?.race_date || '',
    divEn: _divInfo?.div_main_name_en || '',
    divTc: _divInfo?.div_main_name_tc || '',
    divShort: _divInfo?.division_name || _divInfo?.div_short_ref || '',
    divColour: _divInfo?.colour_hex || '',
    raceNumber: race?.race_number,
    raceTitle: race?.race_title || '',
    laneDraw: _laneDraw,
  };

  // Parse + render the .lcd. Try grayscale first; user can flip render mode.
  // `img` is needed for the lane-text auto-shrink below, so parse first.
  const buf = await lcdFile.arrayBuffer();
  const img = parseLcdHeader(buf);

  // Pre-compute the lane-list font size: shrink the lane rows when 13
  // teams with multi-line names would otherwise overflow the panel
  // height. Same size used for live HTML + canvas export so the two
  // paths look identical.
  meta.laneTextSize = computeLaneTextSize(img.displayHeight, meta);

  // We've already got the .lcd File in hand — derive joyi_start_time and
  // persist it onto the race. Fire-and-forget; failure is tolerable
  // because the viewer doesn't depend on it (the race page picks up the
  // change via the 'race-updated' broadcast we issue).
  if (race?.race_number != null) {
    (async () => {
      try {
        const { deriveJoyiStartTime, setJoyiStartTimeOnRace } = await import('./import.js');
        const iso = await deriveJoyiStartTime(lcdFile);
        if (iso) {
          const changed = await setJoyiStartTimeOnRace(race.race_number, iso);
          if (changed) {
            const { broadcastChange } = await import('./app.js');
            broadcastChange('race-updated', { race_number: race.race_number, joyi_start: true });
          }
        }
      } catch (err) { console.warn('photo-finish: joyi_start_time derive failed', err); }
    })();
  }

  // Calibrate the px↔time mapping. Two independent sources of truth:
  //   1. The .lcd's own per-scanline µs timestamps (always present, exact).
  //   2. The .jyd's (RealScore, ReachPoint) pairs (only present when .jyd is
  //      loaded; subject to operator marking).
  // We prefer the metadata-derived fps for `pxPerSec` and use the JYD only
  // to anchor `colAtZero` (so t=0 = race start). If they disagree by more
  // than 2%, we warn in the header strip — usually means a mis-marked reach.
  const calibration = calibrateFromMetadata(img, jydData);

  // Build modal.
  const existing = document.getElementById('photoFinishModal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'photoFinishModal';
  modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:9999; display:flex; flex-direction:column;';

  // Source label for the fps field — explain to operator which number they're
  // looking at. The .lcd metadata is always the most trustworthy when present.
  const fpsSourceLabel = computeFpsSourceLabel(img, calibration, jydData);

  modal.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; padding:10px 16px; background:var(--bg-card); border-bottom:1px solid var(--border);">
      <strong style="font-size:14px;">Photo Finish — Race ${race.race_number}</strong>
      <span style="font-size:12px; color:var(--text-tertiary);">${img.displayWidth}×${img.displayHeight} · ${(buf.byteLength / 1024 / 1024).toFixed(1)} MB</span>
      <span style="flex:1;"></span>
      <label style="font-size:12px; display:flex; align-items:center; gap:6px;">
        Render:
        <select id="pfRenderMode" class="form-select" style="font-size:12px; padding:2px 6px;">
          <option value="trilinear-rgb" selected>Colour (RGB)</option>
          <option value="trilinear-bgr">Colour (BGR)</option>
          <option value="trilinear-grb">Colour (GRB)</option>
          <option value="trilinear-rbg">Colour (RBG)</option>
          <option value="trilinear-gbr">Colour (GBR)</option>
          <option value="trilinear-brg">Colour (BRG)</option>
          <option value="grayscale-smooth">Grayscale (smoothed)</option>
          <option value="grayscale">Grayscale</option>
        </select>
      </label>
      <label style="font-size:12px; display:flex; align-items:center; gap:6px;"
             title="Pixel columns per second. Preferred source: .lcd per-scanline µs timestamps. JYD reach points anchor t=0 to race start.">
        Frame rate (fps):
        <input id="pfPxPerSec" type="number" min="1" step="0.1" value="${calibration.pxPerSec.toFixed(2)}"
               style="width:80px; font-size:12px; padding:2px 6px;">
        <span id="pfFpsSource" style="font-size:11px; color:var(--text-tertiary);">${fpsSourceLabel}</span>
      </label>
      <label style="font-size:12px; display:flex; align-items:center; gap:6px;"
             title="Seconds between race start (t=0) and the camera's first captured scanline. Auto-derived from the .jyd; editable when no .jyd is loaded.">
        Offset (s):
        <input id="pfOffset" type="number" min="0" step="0.01" value="${(-calibration.colAtZero / calibration.pxPerSec).toFixed(2)}"
               style="width:70px; font-size:12px; padding:2px 6px;">
      </label>
      <label style="font-size:12px; display:flex; align-items:center; gap:6px;"
             title="Horizontal compression — preview only when 1x; lower ratios shrink the image on screen and in the exported PNG.">
        Zoom:
        <select id="pfZoom" class="form-select" style="font-size:12px; padding:2px 6px; width:70px;">
          <option value="1" selected>1×</option>
          <option value="0.75">¾×</option>
          <option value="0.5">½×</option>
          <option value="0.33">⅓×</option>
          <option value="0.25">¼×</option>
          <option value="0.2">⅕×</option>
        </select>
      </label>
      <span id="pfMouseTime" style="font-family:monospace; font-size:13px; min-width:100px; color:var(--text-tertiary); text-align:right;">—:—.———</span>
      <button class="btn btn-ghost btn-sm" id="pfResetAll" title="Reset render mode, framerate, offset and zoom to the auto-derived defaults.">
        <i class="material-icons" style="font-size:18px;">restart_alt</i>
      </button>
      <button class="btn btn-ghost btn-sm" id="pfCropToggle" title="Crop & save as PNG. Drag the handles to pick the column range, then click Save in the bottom bar.">
        <i class="material-icons" style="font-size:18px;">crop</i>
      </button>
      <button class="btn btn-ghost btn-sm" id="pfClose" title="Close (Esc)">
        <i class="material-icons" style="font-size:18px;">close</i>
      </button>
    </div>
    <!-- JYD-status banner. Loud when the .jyd is missing or failed to parse,
         because without it overlays + race-start anchor don't work and the
         operator's hover times are off by the capture-start offset. -->
    <div id="pfJydBanner" style="display:none; padding:6px 16px; font-size:12px;
                                 background:rgba(255,160,0,0.15); color:#ffb84d;
                                 border-bottom:1px solid var(--border); align-items:center; gap:10px;"></div>
    <!-- Body row: metadata panel + image scroll viewport, side by side.
         align-items:flex-start so the panel takes natural height (matched to
         the image) instead of stretching down to fill the modal — that
         stretching gave a tall blank white slab below the image. -->
    <div style="flex:1; display:flex; min-height:0; align-items:flex-start;">
      <div id="pfMetaPanel" style="width:320px; flex-shrink:0; height:${img.displayHeight}px;
                                   background:#ffffff; color:#0f172a;
                                   border-right:1px solid var(--border); overflow:auto;
                                   font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
                                   font-size:13px; line-height:1.45; box-sizing:border-box;">
        ${renderMetaPanelHtml(meta)}
      </div>
    <div id="pfScroll" style="flex:1; overflow:auto; background:#111; position:relative;">
      <!-- Stage holds the tile row + the SVG overlay, both absolutely
           positioned. Stage width = displayWidth so scrolling works
           against the full image width even though only a few tiles are
           materialised at any moment. -->
      <div id="pfStage" style="position:relative; width:${img.displayWidth}px; height:${img.displayHeight}px;">
        <div id="pfTiles" style="position:absolute; left:0; top:0; width:${img.displayWidth}px; height:${img.displayHeight}px;"></div>
        <!-- SVG overlay for axis/reach lines/labels. SVG handles arbitrary
             widths without canvas-area limits, so it scales to 90k+ display
             columns. Pointer-events:none so the canvases beneath still
             receive mousemove for the hover scrubber. -->
        <svg id="pfOverlay" style="position:absolute; left:0; top:0;
                                   width:${img.displayWidth}px; height:${img.displayHeight}px;
                                   pointer-events:none;"
             viewBox="0 0 ${img.displayWidth} ${img.displayHeight}" preserveAspectRatio="none"></svg>
      </div>
      <!-- DOM-overlay hover scrubber. Lives outside the canvas/SVG so right-
           click "Save Image" doesn't capture it. Hidden until the mouse
           enters the stage. -->
      <div id="pfScrubber" style="position:absolute; top:0; left:0; width:1px;
                                  height:${img.displayHeight}px;
                                  background:#ffffff; box-shadow:0 0 2px rgba(255,255,255,0.6);
                                  pointer-events:none; display:none; z-index:2;"></div>
      <!-- Crop overlay (hidden until the user clicks the crop button). Two
           dim panes mask the off-crop regions, two handles on the inside
           edges let the operator drag-resize the crop range. Positioned
           inside #pfScroll so it spans the full image width and follows
           horizontal scrolling. Sized via JS (paintCrop) so it tracks the
           current zoom factor. -->
      <div id="pfCropOverlay" style="display:none; position:absolute; top:0; left:0;
                                     width:${img.displayWidth}px; height:${img.displayHeight}px;
                                     z-index:3; pointer-events:none;">
        <div id="pfCropDimL" style="position:absolute; top:0; left:0; height:100%;
                                    background:rgba(0,0,0,0.55); pointer-events:none;"></div>
        <div id="pfCropDimR" style="position:absolute; top:0; right:0; height:100%;
                                    background:rgba(0,0,0,0.55); pointer-events:none;"></div>
        <div id="pfCropFrame" style="position:absolute; top:0; left:0; height:100%;
                                     box-shadow: inset 0 0 0 1px rgba(252, 211, 77, 0.85);
                                     pointer-events:none;"></div>
        <div id="pfCropHandleL" data-side="L"
             style="position:absolute; top:0; left:0; width:12px; height:100%;
                    background:linear-gradient(90deg, rgba(252,211,77,0.95), rgba(252,211,77,0.55));
                    cursor:ew-resize; pointer-events:auto; touch-action:none;"></div>
        <div id="pfCropHandleR" data-side="R"
             style="position:absolute; top:0; left:0; width:12px; height:100%;
                    background:linear-gradient(270deg, rgba(252,211,77,0.95), rgba(252,211,77,0.55));
                    cursor:ew-resize; pointer-events:auto; touch-action:none;"></div>
      </div>
    </div>
    </div><!-- /pfBody flex row -->
    <!-- Crop toolbar — sticky inside the modal, appears below the scroll
         viewport while the operator is picking a range. Shows the current
         column range + duration and offers Save / Cancel. -->
    <div id="pfCropBar" style="display:none; padding:8px 16px; gap:12px; align-items:center;
                               background:var(--bg-card); border-top:1px solid var(--border);
                               font-size:13px; color:var(--text-secondary);">
      <i class="material-icons" style="font-size:18px; color:#fcd34d;">crop</i>
      <span id="pfCropRange" style="font-family:monospace;"></span>
      <span style="flex:1;"></span>
      <button class="btn btn-ghost btn-sm" id="pfCropReset" title="Reset to default range (−0.5s before first finish, +6s after last)">
        <i class="material-icons" style="font-size:16px;">refresh</i>
      </button>
      <button class="btn btn-ghost btn-sm" id="pfCropCancel">Cancel</button>
      <button class="btn btn-primary btn-sm" id="pfCropSave">
        <i class="material-icons" style="font-size:16px;">save_alt</i> Save crop
      </button>
    </div>
    <!-- Hidden file input used by the banner's "Load .jyd" button. macOS file
         picker doesn't let users multi-select across extensions cleanly, so
         this provides a second one-file picker just for the .jyd. -->
    <input type="file" id="pfJydInput" accept=".jyd" style="display:none;">
  `;
  document.body.appendChild(modal);

  const stage = modal.querySelector('#pfStage');
  const tilesWrap = modal.querySelector('#pfTiles');
  const overlay = modal.querySelector('#pfOverlay');
  const scroll = modal.querySelector('#pfScroll');
  const pxPerSecInput = modal.querySelector('#pfPxPerSec');
  const mouseTimeEl = modal.querySelector('#pfMouseTime');
  const zoomSelect = modal.querySelector('#pfZoom');

  // Mutable calibration the user can override via Px/sec.
  let cal = { ...calibration };
  let currentMode = 'trilinear-rgb';
  // Horizontal compress ratio for the on-screen preview AND the exported
  // PNG. 1 = native (one image column per CSS px); <1 visually shrinks the
  // image so 90k-wide captures fit comfortably on a normal monitor. Tile
  // canvases stay at native resolution internally — only the CSS display
  // width changes — so panning/cropping math is unaffected.
  let zoom = 1;

  // Tile manager — builds one placeholder canvas per TILE_WIDTH columns,
  // renders each on demand via IntersectionObserver, and invalidates all
  // tiles when the render mode flips. Memory stays bounded at ~3 visible
  // tiles regardless of total image width.
  const tileCount = Math.ceil(img.displayWidth / TILE_WIDTH);
  const tiles = []; // { canvas, x, width, rendered, mode }

  for (let i = 0; i < tileCount; i++) {
    const x = i * TILE_WIDTH;
    const width = Math.min(TILE_WIDTH, img.displayWidth - x);
    const canvas = document.createElement('canvas');
    canvas.className = 'pf-tile';
    canvas.dataset.tileIndex = String(i);
    canvas.style.cssText = `position:absolute; left:${x}px; top:0; width:${width}px; height:${img.displayHeight}px; display:block;`;
    // Placeholder size — actual ImageData allocation happens at render time.
    canvas.width = 1;
    canvas.height = 1;
    tilesWrap.appendChild(canvas);
    tiles.push({ canvas, x, width, rendered: false, mode: null });
  }

  /**
   * Apply a horizontal compress ratio to the stage / tiles / overlay /
   * crop UI. Image-pixel resolution inside each canvas is preserved; only
   * the CSS display width changes (the browser bilinear-downscales).
   *
   * The SVG overlay's viewBox is stretched to match the compressed CSS
   * width so 1 user-unit == 1 CSS px regardless of zoom. drawOverlays then
   * multiplies image-column x positions by zoom on output; the upshot is
   * that lines and ticks still mark the right boats while text labels keep
   * their natural pixel size instead of being squished.
   */
  function applyZoom(z) {
    zoom = z;
    const w = img.displayWidth * z;
    stage.style.width = `${w}px`;
    tilesWrap.style.width = `${w}px`;
    overlay.style.width = `${w}px`;
    overlay.setAttribute('viewBox', `0 0 ${w} ${img.displayHeight}`);
    for (const t of tiles) {
      t.canvas.style.left = `${t.x * z}px`;
      t.canvas.style.width = `${t.width * z}px`;
    }
    const cropO = modal.querySelector('#pfCropOverlay');
    if (cropO) cropO.style.width = `${w}px`;
    // Re-paint crop overlay positions if crop mode is active.
    if (typeof paintCrop === 'function') paintCrop();
    // Re-draw overlays since column-x positions depend on the zoom factor.
    drawOverlays();
  }

  function renderTile(tile) {
    if (tile.rendered && tile.mode === currentMode) return;
    const ctx = tile.canvas.getContext('2d');
    renderLcdRangeToCanvas(ctx, img, currentMode, tile.x, tile.x + tile.width);
    tile.rendered = true;
    tile.mode = currentMode;
  }

  function invalidateAllTiles() {
    for (const t of tiles) { t.rendered = false; t.mode = null; }
  }

  // IntersectionObserver renders tiles as they scroll into view (plus one
  // tile worth of margin either side so panning is smooth). rootMargin in
  // CSS px so we don't need to scale by zoom.
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const i = Number(entry.target.dataset.tileIndex);
      renderTile(tiles[i]);
    }
  }, {
    root: scroll,
    rootMargin: `0px ${TILE_WIDTH}px 0px ${TILE_WIDTH}px`,
    threshold: 0,
  });
  for (const t of tiles) io.observe(t.canvas);

  const draw = (mode) => {
    if (mode !== currentMode) {
      currentMode = mode;
      invalidateAllTiles();
      // Re-render anything currently in the viewport immediately so the
      // operator sees the colour change without scrolling.
      const viewLeft = scroll.scrollLeft;
      const viewRight = viewLeft + scroll.clientWidth;
      for (const t of tiles) {
        if (t.x + t.width >= viewLeft - TILE_WIDTH && t.x <= viewRight + TILE_WIDTH) {
          renderTile(t);
        }
      }
    }
    drawOverlays();
  };

  function colToMs(col) {
    return (col - cal.colAtZero) * 1000 / cal.pxPerSec;
  }

  // svg helper: build an element with attrs in one call. Keeps the SVG-
  // building below readable without dragging in a tag library.
  function svgEl(tag, attrs, text) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }

  function drawOverlays() {
    // Wipe + rebuild the SVG layer. The overlay is light (axis strip + ~12
    // reach lines + ~12 labels) so a full rebuild is cheaper than mutating
    // existing nodes and easier to reason about.
    while (overlay.firstChild) overlay.removeChild(overlay.firstChild);

    // Modern system-font stack — falls back gracefully on every OS without
    // bundling a webfont. Tabular numerals used wherever times are shown so
    // digits line up across labels even though the font is proportional.
    const UI_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    const TABULAR = 'tabular-nums';

    // SVG viewBox is now (img.displayWidth * zoom) wide so 1 user-unit = 1
    // CSS px. Image-column-based x positions get multiplied by zoom; CSS-px
    // measurements (font-size, label widths, axis height) stay unchanged.
    const Z = zoom;
    const stageW = img.displayWidth * Z;
    const axisH = 24;
    const axisY = img.displayHeight - axisH;

    // Time axis strip — slate-900 base with a 1-px hairline at top.
    overlay.appendChild(svgEl('rect', {
      x: 0, y: axisY, width: stageW, height: axisH, fill: '#0f172a',
    }));
    overlay.appendChild(svgEl('rect', {
      x: 0, y: axisY, width: stageW, height: 1, fill: 'rgba(255,255,255,0.08)',
    }));

    // Tick marks every ~100 CSS px. The visible ms-per-CSS-px is
    // 1000 / (pxPerSec * zoom), so the spacing we target in seconds is
    // 100 / (pxPerSec * zoom).
    const tickStepSec = pickTickStep(100 / (cal.pxPerSec * Z));
    const firstColMs = colToMs(0);
    const lastColMs = colToMs(img.displayWidth - 1);
    const startSec = Math.floor(firstColMs / 1000 / tickStepSec) * tickStepSec;
    for (let sec = startSec; sec * 1000 <= lastColMs; sec += tickStepSec) {
      const col = cal.colAtZero + sec * cal.pxPerSec;
      if (col < 0 || col >= img.displayWidth) continue;
      const x = col * Z;
      overlay.appendChild(svgEl('rect', {
        x: Math.round(x), y: axisY + 1, width: 1, height: 5, fill: 'rgba(255,255,255,0.65)',
      }));
      overlay.appendChild(svgEl('text', {
        x, y: axisY + 15,
        'text-anchor': 'middle', 'dominant-baseline': 'hanging',
        'font-family': UI_FONT, 'font-size': 11, 'font-weight': 500,
        'font-variant-numeric': TABULAR, fill: 'rgba(255,255,255,0.92)',
      }, formatMs(sec * 1000)));
    }

    // Capture-start label, pinned to the left of the axis strip.
    overlay.appendChild(svgEl('text', {
      x: 8, y: axisY + 12,
      'text-anchor': 'start', 'dominant-baseline': 'middle',
      'font-family': UI_FONT, 'font-size': 11, 'font-weight': 600,
      'font-variant-numeric': TABULAR, fill: '#7dd3fc',
    }, `cap. start ${formatSignedSec(firstColMs)}`));

    // Race-start anchor (t=0). Only drawn if it lands within the image.
    if (cal.colAtZero >= 0 && cal.colAtZero < img.displayWidth) {
      const x0 = cal.colAtZero * Z;
      overlay.appendChild(svgEl('line', {
        x1: x0 + 0.5, y1: 0, x2: x0 + 0.5, y2: axisY,
        stroke: 'rgba(125, 211, 252, 0.45)', 'stroke-width': 1, 'stroke-dasharray': '3 5',
      }));
      // Halo behind the text for legibility against any boat colour.
      const haloAttrs = {
        x: x0 + 5, y: 13,
        'text-anchor': 'start', 'dominant-baseline': 'middle',
        'font-family': UI_FONT, 'font-size': 11, 'font-weight': 600,
        'font-variant-numeric': TABULAR,
        style: 'paint-order:stroke; stroke:rgba(0,0,0,0.75); stroke-width:3; stroke-linejoin:round;',
        fill: '#7dd3fc',
      };
      overlay.appendChild(svgEl('text', haloAttrs, '0:00.000 race start'));
    }

    // Reach lines + lane# / time labels. Greedy top-bias slot assignment so
    // far-apart lanes (12, 7) stay at row 0 instead of being pushed down by
    // a fixed index-modulo pattern.
    if (jydData?.reachPoints?.length) {
      const players = jydData.players || [];
      const byLane = new Map();
      players.forEach(p => byLane.set(p.lane, p));
      const reaches = [...jydData.reachPoints].sort((a, b) => a.line - b.line);

      const slotLastRight = [];
      // Slightly tighter slot geometry now that the labels are smaller.
      const slotHeight = 30;
      const labelWidth = 70;       // tabular sans-serif "01:17.999" at 11 px + lane# + pad
      const slotGap = 4;

      // Common text style — paint-order:stroke draws a semi-opaque outline
      // behind each glyph's fill so labels stay legible over any boat /
      // water / sky colour without needing a hard background box. The
      // stroke is intentionally wide enough to also cover the whitespace
      // between adjacent glyphs in the same word, so a red reach line
      // passing through the label is fully broken by the halo.
      const HALO = 'paint-order:stroke; stroke:rgba(0,0,0,0.85); stroke-width:5; stroke-linejoin:round;';

      // Podium tint for the lane number — mirrors the gold/silver/bronze
      // treatment in the results export but at higher chroma since these
      // labels sit on top of photo pixels with a dark halo, not on a white
      // table row. White for everyone else.
      const PODIUM_FILL = { 1: '#fbbf24', 2: '#e5e7eb', 3: '#f97316' };

      // Pass 1: draw every red reach line in one go. Doing this BEFORE any
      // labels guarantees the labels render on top — otherwise a later
      // reach's line would paint across an earlier reach's label and we'd
      // see red bars cutting through the text (the bug in the screenshot).
      for (const rp of reaches) {
        const col = rp.line;
        if (col < 0 || col >= img.displayWidth) continue;
        const x = col * Z;
        overlay.appendChild(svgEl('line', {
          x1: x + 0.5, y1: 0, x2: x + 0.5, y2: axisY,
          stroke: '#ef4444', 'stroke-width': 0.75, 'stroke-opacity': 0.85,
        }));
      }

      // Pass 2: greedy top-bias label placement. Each label has a dark
      // pill behind it so any other reach line that happens to pass
      // through this label's x-range is visually broken by the pill (the
      // halo alone leaves gaps between glyphs where the red line shows).
      for (const rp of reaches) {
        const col = rp.line;
        if (col < 0 || col >= img.displayWidth) continue;
        const x = col * Z;

        const lane = rp.no + 1;
        const player = byLane.get(lane);
        const tMs = finishMs(player);
        const tLabel = tMs != null ? formatMs(tMs) : '';
        const rank = Number.isFinite(player?.rank) ? player.rank : null;
        const laneFill = (rank && PODIUM_FILL[rank]) || '#ffffff';

        let slot = 0;
        while (slot < slotLastRight.length && slotLastRight[slot] > x - slotGap) slot++;
        slotLastRight[slot] = x + labelWidth;
        const yOff = 6 + slot * slotHeight;

        // Lane number — top-3 finishers wear gold / silver / bronze. The
        // wide halo (defined above) gives readable contrast on any
        // background and visually breaks any red line passing through.
        overlay.appendChild(svgEl('text', {
          x: x + 4, y: yOff,
          'text-anchor': 'start', 'dominant-baseline': 'hanging',
          'font-family': UI_FONT, 'font-size': 15, 'font-weight': 700,
          'letter-spacing': '-0.3',
          style: HALO,
          fill: laneFill,
        }, String(lane)));
        if (tLabel) {
          overlay.appendChild(svgEl('text', {
            x: x + 4, y: yOff + 16,
            'text-anchor': 'start', 'dominant-baseline': 'hanging',
            'font-family': UI_FONT, 'font-size': 11, 'font-weight': 500,
            'font-variant-numeric': TABULAR, 'letter-spacing': '0',
            style: HALO,
            fill: '#fecaca',
          }, tLabel));
        }
      }
    }
  }

  const scrubber = modal.querySelector('#pfScrubber');
  function onMouseMove(e) {
    // Stage CSS width === img.displayWidth in image-pixels (set in the HTML
    // above), so the cursor's offsetX inside the stage maps 1:1 to a column.
    // The scroll container's getBoundingClientRect handles the actual mouse
    // → CSS-px math accounting for any CSS zoom/scaling along the way.
    const stageRect = stage.getBoundingClientRect();
    const xCss = e.clientX - stageRect.left;
    const xCol = (xCss / stageRect.width) * img.displayWidth;
    if (xCol < 0 || xCol >= img.displayWidth) {
      mouseTimeEl.textContent = '—:—.———';
      scrubber.style.display = 'none';
      return;
    }
    mouseTimeEl.textContent = formatMs(colToMs(xCol));
    scrubber.style.display = '';
    scrubber.style.transform = `translateX(${xCss}px)`;
  }
  stage.addEventListener('mousemove', onMouseMove);
  stage.addEventListener('mouseleave', () => {
    mouseTimeEl.textContent = '—:—.———';
    scrubber.style.display = 'none';
  });

  modal.querySelector('#pfRenderMode').addEventListener('change', (e) => {
    draw(e.target.value);
  });

  const offsetInput = modal.querySelector('#pfOffset');
  const jydBanner = modal.querySelector('#pfJydBanner');
  const jydInput = modal.querySelector('#pfJydInput');

  function syncOffsetFromCal() {
    if (!offsetInput) return;
    offsetInput.value = (-cal.colAtZero / cal.pxPerSec).toFixed(2);
  }

  function refreshJydBanner() {
    if (!jydBanner) return;
    if (jydData?.reachPoints?.length) {
      jydBanner.style.display = 'none';
      return;
    }
    const msg = jydLoadError
      ? `.jyd parse error: ${jydLoadError}.`
      : 'No .jyd loaded — overlays disabled and race-start offset is a guess.';
    jydBanner.style.display = 'flex';
    jydBanner.innerHTML = `
      <i class="material-icons" style="font-size:16px;">warning</i>
      <span>${msg}</span>
      <button class="btn btn-outline btn-sm" id="pfLoadJyd" style="padding:2px 10px; font-size:12px;">
        <i class="material-icons" style="font-size:14px;">upload_file</i> Load .jyd
      </button>
    `;
    jydBanner.querySelector('#pfLoadJyd').addEventListener('click', () => jydInput.click());
  }
  refreshJydBanner();

  pxPerSecInput.addEventListener('input', () => {
    const v = parseFloat(pxPerSecInput.value);
    if (!Number.isFinite(v) || v <= 0) return;
    // Re-derive both pxPerSec and colAtZero so the JYD anchor stays consistent.
    const recal = calibrateFromMetadata({ ...img, fpsFromMetadata: v }, jydData);
    cal.pxPerSec = recal.pxPerSec;
    cal.colAtZero = recal.colAtZero;
    syncOffsetFromCal();
    draw(modal.querySelector('#pfRenderMode').value);
  });

  // Manual race-start offset (seconds past capture-start to t=0). Lets the
  // operator calibrate when no .jyd is loaded — type "68.32" and the time
  // axis snaps to the real race time. Disabled visually (but still editable)
  // when a JYD anchor exists, since the JYD is the source of truth there.
  offsetInput.addEventListener('input', () => {
    const v = parseFloat(offsetInput.value);
    if (!Number.isFinite(v)) return;
    cal.colAtZero = -v * cal.pxPerSec;
    draw(modal.querySelector('#pfRenderMode').value);
  });

  // Zoom selector — applies the chosen compress ratio to the live preview.
  // The export also uses this ratio so what you see is what you save.
  // After re-applying, scroll the viewport so the first finisher (earliest
  // reach point) is near the left of the visible area — switching zoom
  // levels otherwise lands you on whatever empty water you were over.
  if (zoomSelect) {
    zoomSelect.addEventListener('change', () => {
      const z = parseFloat(zoomSelect.value);
      if (!Number.isFinite(z) || z <= 0) return;
      applyZoom(z);
      const lines = jydData?.reachPoints?.map(rp => rp.line).filter(Number.isFinite);
      if (lines && lines.length) {
        const minLine = Math.min(...lines);
        // Place the first reach ~100 CSS px in from the left edge.
        scroll.scrollLeft = Math.max(0, minLine * z - 100);
      }
    });
  }

  // Second-step .jyd picker — fired by the banner's Load button. macOS
  // multi-select across `accept` extensions is fiddly, so this gives the
  // operator a clean one-shot picker just for the .jyd.
  jydInput.addEventListener('change', async () => {
    const file = jydInput.files[0];
    jydInput.value = '';
    if (!file) return;
    const { parseJydFile } = await import('./import.js');
    try {
      const parsed = await parseJydFile(file);
      jydData = parsed.jyd;
      jydLoadError = null;
      // Re-calibrate with the new JYD anchor.
      const recal = calibrateFromMetadata(img, jydData);
      cal.pxPerSec = recal.pxPerSec;
      cal.colAtZero = recal.colAtZero;
      pxPerSecInput.value = cal.pxPerSec.toFixed(2);
      modal.querySelector('#pfFpsSource').textContent = computeFpsSourceLabel(img, recal, jydData);
      syncOffsetFromCal();
      refreshJydBanner();
      draw(modal.querySelector('#pfRenderMode').value);
      // Scroll to the earliest reach so the operator lands on the action.
      const minLine = Math.min(...jydData.reachPoints.map(rp => rp.line));
      scroll.scrollLeft = Math.max(0, minLine - 400);
    } catch (err) {
      jydLoadError = err.message || String(err);
      refreshJydBanner();
    }
  });

  // Reset-all: snap the viewer back to its auto-derived defaults — render
  // mode = colour RGB, frame rate from .lcd metadata + JYD anchor, offset
  // from JYD anchor, zoom = 1×. Useful when the operator has been fiddling
  // and wants a clean baseline before exporting.
  modal.querySelector('#pfResetAll').addEventListener('click', () => {
    const recal = calibrateFromMetadata(img, jydData);
    cal.pxPerSec = recal.pxPerSec;
    cal.colAtZero = recal.colAtZero;
    pxPerSecInput.value = cal.pxPerSec.toFixed(2);
    offsetInput.value = (-cal.colAtZero / cal.pxPerSec).toFixed(2);
    modal.querySelector('#pfFpsSource').textContent = computeFpsSourceLabel(img, recal, jydData);
    const modeSel = modal.querySelector('#pfRenderMode');
    modeSel.value = 'trilinear-rgb';
    if (zoomSelect) zoomSelect.value = '1';
    applyZoom(1);            // also re-draws overlays
    draw('trilinear-rgb');   // ensures tiles re-render after mode reset
  });

  // Clean shutdown: disconnect the IntersectionObserver before removing the
  // modal so its targets can be GC'd. Leaks here would compound across
  // multiple Photo Finish sessions in one tab.
  const closeModal = () => {
    try { io.disconnect(); } catch {}
    modal.remove();
  };
  modal.querySelector('#pfClose').addEventListener('click', closeModal);
  const onKey = (e) => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  // Crop mode: two draggable handles on the stage define a column range
  // that gets baked to PNG when "Save crop" is clicked. The handles are
  // initialised to the current viewport, so the operator can just click
  // Save to grab the current view, or drag the handles to trim the range.
  const cropOverlay = modal.querySelector('#pfCropOverlay');
  const cropBar = modal.querySelector('#pfCropBar');
  const cropDimL = modal.querySelector('#pfCropDimL');
  const cropDimR = modal.querySelector('#pfCropDimR');
  const cropFrame = modal.querySelector('#pfCropFrame');
  const cropHandleL = modal.querySelector('#pfCropHandleL');
  const cropHandleR = modal.querySelector('#pfCropHandleR');
  const cropRangeLabel = modal.querySelector('#pfCropRange');
  const cropToggleBtn = modal.querySelector('#pfCropToggle');

  let cropActive = false;
  let cropStart = 0;
  let cropEnd = img.displayWidth;
  const MIN_CROP_WIDTH = 32;          // sanity floor in image columns

  function paintCrop() {
    const left = Math.max(0, cropStart);
    const right = Math.min(img.displayWidth, cropEnd);
    // All crop UI elements are in CSS pixels, so multiply image-column
    // coordinates by the current zoom factor before applying.
    cropDimL.style.width = `${left * zoom}px`;
    cropDimR.style.width = `${(img.displayWidth - right) * zoom}px`;
    cropFrame.style.left = `${left * zoom}px`;
    cropFrame.style.width = `${(right - left) * zoom}px`;
    cropHandleL.style.left = `${left * zoom}px`;
    cropHandleR.style.left = `${right * zoom - 12}px`;
    const dtMs = colToMs(right - 1) - colToMs(left);
    const dtSec = dtMs / 1000;
    cropRangeLabel.textContent = `cols ${left}–${right}  ·  width ${right - left}px (native)  ·  Δt ${dtSec.toFixed(3)}s`;
  }

  function resetCropToReachRange() {
    // Default crop: tight window around the action — half a second before
    // the first boat's bow crossing to six seconds after the last. Falls back
    // to the scroll viewport if no .jyd reach points are loaded.
    if (jydData?.reachPoints?.length) {
      const lines = jydData.reachPoints.map(rp => rp.line).filter(Number.isFinite);
      if (lines.length) {
        const first = Math.min(...lines);
        const last = Math.max(...lines);
        cropStart = Math.max(0, Math.floor(first - 0.5 * cal.pxPerSec));
        cropEnd = Math.min(img.displayWidth, Math.ceil(last + 6 * cal.pxPerSec));
        if (cropEnd - cropStart < MIN_CROP_WIDTH) cropEnd = Math.min(img.displayWidth, cropStart + MIN_CROP_WIDTH);
        paintCrop();
        return;
      }
    }
    resetCropToViewport();
  }

  function resetCropToViewport() {
    const stageRect = stage.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();
    const visibleLeftCss = Math.max(0, scrollRect.left - stageRect.left);
    const visibleRightCss = Math.min(stageRect.width, visibleLeftCss + scrollRect.width);
    const colsPerCss = img.displayWidth / stageRect.width;
    cropStart = Math.max(0, Math.floor(visibleLeftCss * colsPerCss));
    cropEnd = Math.min(img.displayWidth, Math.ceil(visibleRightCss * colsPerCss));
    if (cropEnd - cropStart < MIN_CROP_WIDTH) cropEnd = Math.min(img.displayWidth, cropStart + MIN_CROP_WIDTH);
    paintCrop();
  }

  function enterCropMode() {
    cropActive = true;
    cropToggleBtn.classList.add('btn-primary');
    cropToggleBtn.classList.remove('btn-ghost');
    cropOverlay.style.display = 'block';
    cropBar.style.display = 'flex';
    // Default range = the race itself (−0.5s before first reach, +6s after
    // last reach). Operator can still drag to refine, or hit ↻ for a
    // viewport-based reset.
    resetCropToReachRange();
    // Pan to the crop start so the operator can see what they're about to
    // save without manually scrolling the entire 90k-wide image.
    const stageRect = stage.getBoundingClientRect();
    const cssPerCol = stageRect.width / img.displayWidth;
    scroll.scrollLeft = Math.max(0, cropStart * cssPerCol - 80);
  }
  function exitCropMode() {
    cropActive = false;
    cropToggleBtn.classList.remove('btn-primary');
    cropToggleBtn.classList.add('btn-ghost');
    cropOverlay.style.display = 'none';
    cropBar.style.display = 'none';
  }

  cropToggleBtn.addEventListener('click', () => { cropActive ? exitCropMode() : enterCropMode(); });
  modal.querySelector('#pfCropCancel').addEventListener('click', exitCropMode);
  modal.querySelector('#pfCropReset').addEventListener('click', resetCropToReachRange);

  // Handle drag: convert pointer CSS-x to image column via stage CSS-width
  // mapping (same math as the hover scrubber). Pointer capture means a fast
  // drag that leaves the handle still tracks the cursor.
  function bindHandle(handle, side) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const stageRect = stage.getBoundingClientRect();
        const xCss = ev.clientX - stageRect.left;
        const colsPerCss = img.displayWidth / stageRect.width;
        const col = Math.round(xCss * colsPerCss);
        if (side === 'L') {
          cropStart = Math.max(0, Math.min(col, cropEnd - MIN_CROP_WIDTH));
        } else {
          cropEnd = Math.min(img.displayWidth, Math.max(col, cropStart + MIN_CROP_WIDTH));
        }
        paintCrop();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }
  bindHandle(cropHandleL, 'L');
  bindHandle(cropHandleR, 'R');

  // Save-crop: build a composite PNG = [metadata panel] + [image crop] +
  // [SVG overlay clipped to the same range]. The image part respects the
  // current zoom ratio (1× = native; 0.5× / 0.25× / 0.1× = horizontally
  // compressed for narrower output). The panel and panel height stay at
  // native res — they're identity info, not stretchable photo content.
  modal.querySelector('#pfCropSave').addEventListener('click', async () => {
    const colStart = Math.max(0, Math.floor(cropStart));
    const colEnd = Math.min(img.displayWidth, Math.ceil(cropEnd));
    const nativeWidth = colEnd - colStart;
    if (nativeWidth <= 0) return;

    const PANEL_W = 320;
    const imageOutW = Math.max(1, Math.round(nativeWidth * zoom));
    const outW = PANEL_W + imageOutW;
    const outH = img.displayHeight;

    // Render the export canvas at 2× device pixel ratio. The .lcd image
    // itself has fixed native resolution so it gets bilinear-upscaled (no
    // quality gain), but the metadata panel text, axis tick labels and
    // reach-line labels are all drawn at the higher backing density and
    // come out visibly sharper in the saved PNG. The canvas's logical
    // drawing coordinates stay in CSS-px via ctx.scale().
    const DPR = 2;
    const out = document.createElement('canvas');
    out.width = outW * DPR;
    out.height = outH * DPR;
    const outCtx = out.getContext('2d');
    outCtx.scale(DPR, DPR);
    // Use higher-quality resampling for the image stretch step too — Chrome /
    // Safari default to bilinear but the `high` hint asks for bicubic where
    // available, which is meaningfully nicer for line-scan content.
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';

    // 1) Metadata panel slab at x=0..PANEL_W.
    paintMetaPanelOnCanvas(outCtx, 0, 0, PANEL_W, outH, meta);

    // 2) Image pixels for the chosen column range — rendered to an
    // off-screen native-res canvas first, then drawn onto the output at
    // the zoomed width (browser bicubic/bilinear-downscales). This avoids
    // paying the cost of redrawing pixels at a non-native resolution.
    const imgCanvas = document.createElement('canvas');
    renderLcdRangeToCanvas(imgCanvas.getContext('2d'), img, currentMode, colStart, colEnd);
    outCtx.drawImage(imgCanvas, PANEL_W, 0, imageOutW, outH);

    // 3) Overlays via SVG → Image → drawImage. Clone the live overlay,
    // reset viewBox to the crop window — every reach line / tick / label
    // already lives in full-image coords, so the viewBox change shifts
    // and clips them automatically without rerunning the layout.
    // Set the SVG's `width`/`height` to the DPR-scaled output so when the
    // browser rasterises it for drawImage the text comes out crisp.
    const svgClone = overlay.cloneNode(true);
    svgClone.setAttribute('width', imageOutW * DPR);
    svgClone.setAttribute('height', outH * DPR);
    // Live overlay x-coords are in (col × zoom) space, so the export
    // viewBox must be expressed in that same space.
    svgClone.setAttribute('viewBox', `${colStart * zoom} 0 ${nativeWidth * zoom} ${outH}`);
    svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const svgStr = new XMLSerializer().serializeToString(svgClone);
    const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const svgUrl = URL.createObjectURL(svgBlob);
    try {
      const overlayImg = new Image();
      await new Promise((resolve, reject) => {
        overlayImg.onload = resolve;
        overlayImg.onerror = () => reject(new Error('overlay svg load failed'));
        overlayImg.src = svgUrl;
      });
      // We're already inside a `ctx.scale(DPR, DPR)` context, so the draw
      // target is in CSS-px and the higher-res SVG raster bilinear-fits
      // into it cleanly (DPR-up + DPR-down → 1:1 with crisp glyphs).
      outCtx.drawImage(overlayImg, PANEL_W, 0, imageOutW, outH);
    } finally {
      URL.revokeObjectURL(svgUrl);
    }

    // 4) Trigger download. Filename carries race + crop range + zoom so
    // re-exports don't collide and the operator can tell variants apart.
    out.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const zStr = zoom === 1 ? '1x' : `${zoom}x`;
      a.download = `photo-finish-race-${race.race_number}-cols-${colStart}-${colEnd}-${zStr}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');

    exitCropMode();
  });

  // Initial render — colour by default (channels are RGB-interleaved per
  // pixel, no Bayer demosaic needed). Operator can flip channel order if
  // the colours look swapped.
  draw('trilinear-rgb');

  // Scroll to the earliest ReachPoint so the operator lands on the action.
  if (jydData?.reachPoints?.length) {
    const minLine = Math.min(...jydData.reachPoints.map(rp => rp.line));
    requestAnimationFrame(() => {
      scroll.scrollLeft = Math.max(0, minLine - 400);
    });
  }
}

/**
 * Combined calibration:
 *   - pxPerSec preferred from .lcd metadata (always exact when present).
 *   - colAtZero preferred from JYD reach points (need at least one
 *     (RealScore, ReachPoint) pair to anchor t=0 to race start).
 *   - If neither is present, fall back to the JYD fit slope (legacy path)
 *     or finally a hard default of 500 fps with colAtZero=0.
 * Returns { pxPerSec, colAtZero, jydFitPxPerSec } — the third value is the
 * JYD slope (or null) so the header strip can flag any metadata/JYD drift.
 */
/**
 * Per-player canonical finish time in ms. Prefer Score (official, with the
 * .jyd's TimeDelta correction baked in — what gets exported to results); fall
 * back to RealScore for older .jyd files that didn't carry Score.
 */
function finishMs(player) {
  if (!player) return null;
  if (Number.isFinite(player.scoreMs)) return player.scoreMs;
  return player.realScoreMs;
}

function calibrateFromMetadata(img, jydData) {
  const jydFit = fitJyd(jydData);

  // pxPerSec: metadata > JYD fit > hard default.
  let pxPerSec = img?.fpsFromMetadata || jydFit?.pxPerSec || 500;

  // colAtZero: anchor on JYD if we have at least one (RealScore, Line) pair.
  // We don't trust the JYD's slope here — we just need a t→col anchor, and
  // a single pair plus the trusted slope gives us that.
  let colAtZero = 0;
  if (jydData?.players?.length && jydData?.reachPoints?.length) {
    const byLane = new Map(jydData.players.map(p => [p.lane, p]));
    // Use the *earliest* (smallest RealScore) anchor — it's the most likely
    // to be a clean, unambiguous reach point (no overlapping boats).
    let best = null;
    for (const rp of jydData.reachPoints) {
      const p = byLane.get(rp.no + 1);
      if (p?.realScoreMs != null && Number.isFinite(rp.line)) {
        if (!best || finishMs(p) < best.tMs) best = { tMs: finishMs(p), col: rp.line };
      }
    }
    if (best) colAtZero = best.col - (best.tMs / 1000) * pxPerSec;
  } else if (jydFit) {
    colAtZero = jydFit.colAtZero;
  }

  return { pxPerSec, colAtZero, jydFitPxPerSec: jydFit?.pxPerSec ?? null };
}

/**
 * Legacy JYD-only fit. Returns the least-squares slope/intercept or null.
 */
function fitJyd(jydData) {
  if (!jydData?.players?.length || !jydData?.reachPoints?.length) return null;
  const byLane = new Map(jydData.players.map(p => [p.lane, p]));
  const samples = [];
  for (const rp of jydData.reachPoints) {
    const p = byLane.get(rp.no + 1);
    if (p?.realScoreMs != null && Number.isFinite(rp.line)) {
      samples.push({ t: finishMs(p) / 1000, col: rp.line });
    }
  }
  if (samples.length < 2) return null;
  const n = samples.length;
  let sumT = 0, sumC = 0, sumTT = 0, sumTC = 0;
  for (const s of samples) {
    sumT += s.t; sumC += s.col;
    sumTT += s.t * s.t; sumTC += s.t * s.col;
  }
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return null;
  const b = (n * sumTC - sumT * sumC) / denom;
  const a = (sumC - b * sumT) / n;
  return { pxPerSec: b, colAtZero: a };
}

/**
 * Pick a human-friendly tick step (seconds) given the rough desired tick
 * spacing in seconds. Tries 0.1, 0.2, 0.5, 1, 2, 5, 10, ...
 */
function pickTickStep(approxSec) {
  const candidates = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
  for (const c of candidates) {
    if (c >= approxSec) return c;
  }
  return 60;
}

/**
 * Build the metadata side-panel content as HTML for the live viewer. The
 * same data is rendered to canvas for the export bake (see
 * paintMetaPanelOnCanvas). Optional fields with no value are simply omitted
 * so the panel only shows lines we have data for.
 *
 * Visual structure:
 *   [event colour band — 6 px tall, full width]
 *   [Event / Date / Division / Race / Lanes — each a small uppercase
 *    section label followed by its value(s)]
 *   - The Race row gets a small division-colour swatch on its left,
 *     skipped when the race has no division or the division has no colour.
 *   - The Lane Draw block lists `{lane} {team}` rows for lanes that have
 *     a non-empty team name (skipping "---" and DNS).
 */
const META_LABEL_STYLE = `font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; font-size:12px; font-weight:600; letter-spacing:0.6px; text-transform:uppercase; color:#64748b; margin-bottom:4px;`;
const META_VALUE_STYLE = `font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; font-size:14px; font-weight:500; line-height:1.35; color:#0f172a; word-break:break-word;`;

function renderMetaPanelHtml(m) {
  const lines = [];

  // 1) Event banner — the colour band is now a full banner with the event
  // name in white text on top. Replaces the separate "EVENT" label/value
  // rows below; one less section in the panel, more visual weight at the
  // top where it belongs.
  const eventLabel = formatBilingual(m.eventEn, m.eventTc) || m.eventShort || '—';
  lines.push(`
    <div style="background:${escapeHtml(m.eventColour || '#0f172a')}; color:#ffffff;
                padding:14px 16px; font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
                box-shadow:0 1px 3px rgba(15,23,42,0.3);">
      <div style="font-size:11px; font-weight:600; letter-spacing:0.6px; text-transform:uppercase;
                  color:rgba(255,255,255,0.7); margin-bottom:4px;">Event</div>
      <div style="font-size:17px; font-weight:700; line-height:1.25; white-space:pre-line;">${escapeHtml(eventLabel)}</div>
    </div>
  `);

  // Body wrapper with consistent padding.
  lines.push(`<div style="padding:14px 16px;">`);

  // 2) DATE
  if (m.raceDate) {
    lines.push(`<div style="${META_LABEL_STYLE}">Date</div>`);
    lines.push(`<div style="${META_VALUE_STYLE} margin-bottom:14px; font-variant-numeric:tabular-nums;">${escapeHtml(formatDate(m.raceDate))}</div>`);
  }

  // 3) DIVISION
  const divLabel = formatBilingual(m.divEn, m.divTc) || m.divShort || '';
  if (divLabel) {
    lines.push(`<div style="${META_LABEL_STYLE}">Division</div>`);
    lines.push(`<div style="${META_VALUE_STYLE} margin-bottom:14px; white-space:pre-line;">${escapeHtml(divLabel)}</div>`);
  }

  // 4) RACE — with a division-colour swatch to the left of the number when
  // the division has a colour set.
  if (m.raceNumber != null) {
    lines.push(`<div style="${META_LABEL_STYLE}">Race</div>`);
    const swatch = m.divColour
      ? `<span style="display:inline-block; width:16px; height:30px; border-radius:3px; background:${escapeHtml(m.divColour)}; margin-right:10px; flex-shrink:0;"></span>`
      : '';
    lines.push(`<div style="display:flex; align-items:center; margin-bottom:4px;">${swatch}<span style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; font-weight:700; font-size:30px; line-height:1; color:#0f172a;">${escapeHtml(String(m.raceNumber))}</span></div>`);
    if (m.raceTitle) {
      lines.push(`<div style="${META_VALUE_STYLE} color:#334155; margin-bottom:14px;">${escapeHtml(m.raceTitle)}</div>`);
    } else {
      lines.push(`<div style="margin-bottom:14px;"></div>`);
    }
  }

  // 5) LANES — only rendered when at least one lane survives the filter.
  // Multi-line team names wrap naturally via word-break. Font size comes
  // from computeLaneTextSize() so the block auto-shrinks (to a 9 px floor)
  // when 13 teams with multi-line names would otherwise overflow.
  if (m.laneDraw && m.laneDraw.length) {
    const sz = m.laneTextSize || 13;
    lines.push(`<div style="${META_LABEL_STYLE}">Lanes</div>`);
    const rows = m.laneDraw.map(l =>
      `<div style="display:flex; gap:10px; font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; font-size:${sz}px; color:#0f172a; line-height:1.4; margin-bottom:2px;">
        <span style="display:inline-block; width:22px; font-variant-numeric:tabular-nums; font-weight:600; color:#475569; flex-shrink:0;">${escapeHtml(String(l.lane))}</span>
        <span style="flex:1; word-break:break-word;">${escapeHtml(l.team)}</span>
      </div>`
    ).join('');
    lines.push(rows);
  }

  lines.push(`</div>`);
  return lines.join('');
}

/**
 * Combine an English + a Traditional Chinese label. Returns either alone if
 * the other is blank, both joined with a thin space + middle dot if both
 * are present, or empty string if neither is present.
 */
function formatBilingual(en, tc) {
  const a = (en || '').trim();
  const b = (tc || '').trim();
  if (a && b) return `${a}\n${b}`;
  return a || b || '';
}

/**
 * Format YYYYMMDD or YYYY-MM-DD or ISO date strings as YYYY-MM-DD. Leaves
 * other shapes alone so the operator can paste anything semi-readable.
 */
function formatDate(s) {
  if (!s) return '';
  const t = String(s).trim();
  if (/^\d{8}$/.test(t)) return `${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  return t;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

/**
 * Pick the largest font size for the lane-draw rows that still fits inside
 * the meta panel without overflowing the available vertical room.
 *
 * Strategy: measure each fixed section (banner, date, division, race +
 * title, lanes label) with a hidden canvas. Subtract their combined height
 * from the panel height. Then iterate candidate font sizes from the
 * largest down to a minimum-readable 9 px, computing the lane block height
 * at each candidate via canvas measureText for word-wrap accuracy. Return
 * the first size that fits; if nothing fits we fall to the floor (9 px).
 *
 * Returning the same size for both the live HTML view and the export
 * canvas guarantees the rendered panel looks identical across the two.
 */
function computeLaneTextSize(panelHeight, m) {
  const PANEL_W = 320;
  const padX = 16, padY = 14;
  const usableW = PANEL_W - padX * 2;
  const UI = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');

  // --- Banner ---
  const eventLabel = formatBilingual(m.eventEn, m.eventTc) || m.eventShort || '—';
  ctx.font = `700 17px ${UI}`;
  const eventLines = String(eventLabel).split('\n').flatMap(l => wrapText(ctx, l, usableW));
  const bannerH = padY + 16 /* "EVENT" label */ + 4 + eventLines.length * Math.round(17 * 1.25) + padY;

  // --- Date row ---
  const dateH = m.raceDate ? 18 /* DATE label */ + Math.round(14 * 1.35) + 10 /* gap */ : 0;

  // --- Division row ---
  const divLabel = formatBilingual(m.divEn, m.divTc) || m.divShort || '';
  let divH = 0;
  if (divLabel) {
    ctx.font = `500 14px ${UI}`;
    const divLines = String(divLabel).split('\n').flatMap(l => wrapText(ctx, l, usableW));
    divH = 18 + divLines.length * Math.round(14 * 1.35) + 10;
  }

  // --- Race section (label + number row + optional title + gap) ---
  let raceH = 0;
  if (m.raceNumber != null) {
    raceH = 18 + 34;
    if (m.raceTitle) {
      ctx.font = `500 14px ${UI}`;
      const titleLines = wrapText(ctx, m.raceTitle, usableW);
      raceH += titleLines.length * Math.round(14 * 1.35);
    }
    raceH += 10;
  }

  // --- Available room for the lane block ---
  const lanesLabelH = 18;
  const fixedUsed = bannerH + padY + dateH + divH + raceH + lanesLabelH + padY;
  const available = panelHeight - fixedUsed;

  if (!m.laneDraw || m.laneDraw.length === 0 || available <= 0) return 13;

  // Lane-text candidate ladder. 9 px is our readable floor.
  for (const size of [13, 12, 11, 10, 9]) {
    let total = 0;
    const teamW = usableW - 32; // 32 = lane# column + 10 gap
    for (const l of m.laneDraw) {
      ctx.font = `500 ${size}px ${UI}`;
      const lines = wrapText(ctx, l.team, teamW);
      // Row height: N text lines × leading + 2 px row gap.
      total += Math.max(1, lines.length) * Math.round(size * 1.4) + 2;
      if (total > available) break;
    }
    if (total <= available) return size;
  }
  return 9;
}

/**
 * Paint the metadata panel onto a canvas 2D context. Mirrors the live HTML
 * panel; used by the export-crop bake so the PNG carries the same info.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x - left in canvas px
 * @param {number} y - top in canvas px
 * @param {number} w - panel width in canvas px
 * @param {number} h - panel height in canvas px
 * @param {Object} m - metadata object built in showPhotoFinishModal
 */
function paintMetaPanelOnCanvas(ctx, x, y, w, h, m) {
  ctx.save();
  // White slab background.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, w, h);
  // Subtle right border so the panel reads as separate from the image.
  ctx.fillStyle = '#e5e7eb';
  ctx.fillRect(x + w - 1, y, 1, h);

  const padX = 16, padY = 14;

  // Event banner — coloured background slab with the event name in white.
  // Replaces the previous thin colour band + separate EVENT row, giving
  // the brand colour real estate and the event name visual prominence.
  const eventLabel = formatBilingual(m.eventEn, m.eventTc) || m.eventShort || '—';
  const eventLines = wrapTextWithFont(
    ctx, eventLabel,
    w - padX * 2,
    '700 17px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
  );
  const bannerH = padY + 16 + 4 + eventLines.length * Math.round(17 * 1.25) + padY;
  ctx.fillStyle = m.eventColour || '#0f172a';
  ctx.fillRect(x, y, w, bannerH);
  // Subtle soft shadow under the banner.
  ctx.fillStyle = 'rgba(15,23,42,0.18)';
  ctx.fillRect(x, y + bannerH, w, 1);

  // Banner label (uppercase "EVENT" in translucent white).
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText('EVENT', x + padX, y + padY);
  // Banner event name in white.
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 17px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  let bannerCursor = y + padY + 16 + 4;
  for (const line of eventLines) {
    ctx.fillText(line, x + padX, bannerCursor);
    bannerCursor += Math.round(17 * 1.25);
  }

  let cursorY = y + bannerH + padY;

  // Consistent label/value helpers below the banner.
  const drawLabel = (text) => {
    ctx.fillStyle = '#64748b';
    ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(text.toUpperCase(), x + padX, cursorY);
    cursorY += 18;
  };

  const drawValue = (text, opts = {}) => {
    if (text == null || text === '') return;
    const size = opts.size || 14;
    const weight = opts.weight || 500;
    const colour = opts.colour || '#0f172a';
    const indent = opts.indent || 0;
    ctx.fillStyle = colour;
    ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textBaseline = 'top';
    const lines = String(text).split('\n').flatMap(l => wrapText(ctx, l, w - padX * 2 - indent));
    for (const line of lines) {
      ctx.fillText(line, x + padX + indent, cursorY);
      cursorY += Math.round(size * 1.35);
    }
  };

  // DATE
  if (m.raceDate) {
    drawLabel('Date');
    drawValue(formatDate(m.raceDate), { size: 14, weight: 500 });
    cursorY += 10;
  }

  // DIVISION
  const divLabel = formatBilingual(m.divEn, m.divTc) || m.divShort || '';
  if (divLabel) {
    drawLabel('Division');
    drawValue(divLabel, { size: 14, weight: 500 });
    cursorY += 10;
  }

  // RACE — colour swatch + number on one row; title beneath.
  if (m.raceNumber != null) {
    drawLabel('Race');
    let textX = x + padX;
    if (m.divColour) {
      ctx.fillStyle = m.divColour;
      const sw = 16, sh = 30, r = 3;
      const sy = cursorY;
      roundedRect(ctx, x + padX, sy, sw, sh, r);
      ctx.fill();
      textX = x + padX + sw + 10;
    }
    ctx.fillStyle = '#0f172a';
    ctx.font = '700 30px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(String(m.raceNumber), textX, cursorY);
    cursorY += 34;
    if (m.raceTitle) {
      drawValue(m.raceTitle, { size: 14, weight: 500, colour: '#334155' });
    }
    cursorY += 10;
  }

  // LANES — up to 13 lanes with multi-line team-name wrap. Font size
  // comes from m.laneTextSize (precomputed in showPhotoFinishModal) so
  // dense draws shrink instead of clipping at the bottom of the panel.
  if (m.laneDraw && m.laneDraw.length) {
    drawLabel('Lanes');
    const sz = m.laneTextSize || 13;
    const rowGap = 2;
    const lineH = Math.round(sz * 1.4);
    for (const l of m.laneDraw) {
      // Lane number column (~32 px wide, fits "13" even at the smallest
      // candidate size).
      ctx.fillStyle = '#475569';
      ctx.font = `600 ${sz}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(String(l.lane), x + padX, cursorY);
      // Team name body — wraps to multiple lines if it overflows.
      ctx.fillStyle = '#0f172a';
      ctx.font = `500 ${sz}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
      const teamLines = wrapText(ctx, l.team, w - padX * 2 - 32);
      for (let i = 0; i < teamLines.length; i++) {
        ctx.fillText(teamLines[i], x + padX + 32, cursorY);
        if (i < teamLines.length - 1) cursorY += lineH;
      }
      cursorY += lineH + rowGap;
    }
  }

  ctx.restore();
}

/** Same as wrapText but sets the font first, restoring it afterwards.
 *  Used by the banner sizing pass since we need to measure with the actual
 *  font we'll render with. */
function wrapTextWithFont(ctx, text, maxWidth, font) {
  const prev = ctx.font;
  ctx.font = font;
  const out = String(text).split('\n').flatMap(l => wrapText(ctx, l, maxWidth));
  ctx.font = prev;
  return out;
}

/** Path a rounded rectangle on the given context (canvas 2D doesn't have
 *  this as a built-in until very recent Safari). Caller fills/strokes. */
function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return [text];
  const words = String(text).split(/\s+/);
  const out = [];
  let line = '';
  for (const w of words) {
    const probe = line ? line + ' ' + w : w;
    if (ctx.measureText(probe).width <= maxWidth) { line = probe; }
    else { if (line) out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out;
}

/**
 * Build the small "from .lcd metadata" / "metadata + JYD agree" / etc. label
 * shown next to the framerate input.
 */
function computeFpsSourceLabel(img, calibration, jydData) {
  if (img?.fpsFromMetadata && jydData?.reachPoints?.length >= 2 && calibration.jydFitPxPerSec) {
    const drift = Math.abs(calibration.jydFitPxPerSec - img.fpsFromMetadata) / img.fpsFromMetadata;
    if (drift > 0.02) return `metadata + JYD (disagree by ${(drift * 100).toFixed(1)}%)`;
    return 'metadata + JYD agree';
  }
  if (img?.fpsFromMetadata) return 'from .lcd metadata';
  if (calibration?.jydFitPxPerSec) return 'from .jyd fit';
  return 'fallback default';
}

/**
 * Format milliseconds as a signed "+SS.mmm" string for the cap-start label.
 * 3 decimal places to match the rest of the photo-finish viewer.
 */
function formatSignedSec(ms) {
  if (!Number.isFinite(ms)) return '';
  const sign = ms >= 0 ? '+' : '-';
  const abs = Math.round(Math.abs(ms));
  const sec = Math.floor(abs / 1000);
  const millis = abs % 1000;
  return `${sign}${sec}.${String(millis).padStart(3, '0')}s`;
}

/**
 * Photo-finish display format: mm:ss.mmm (3 decimal places — full millisecond
 * precision). The operator-facing race results elsewhere use mss00 (centi-
 * second) format, but the photo-finish viewer is the place where the extra
 * precision actually means something, so we don't truncate here.
 */
function formatMs(ms) {
  if (!Number.isFinite(ms)) return '';
  const sign = ms < 0 ? '-' : '';
  const abs = Math.round(Math.abs(ms));
  const millis = abs % 1000;
  const totalSec = Math.floor(abs / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60);
  return `${sign}${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}
