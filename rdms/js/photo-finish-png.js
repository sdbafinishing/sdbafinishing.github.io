/**
 * SDBA RDMS — Photo-Finish PNG (auto-generate + smart read)
 *
 * Builds on the EXISTING photo-finish renderer additively — it reuses the
 * pure, exported helpers (parseLcdHeader / renderLcdRangeToCanvas /
 * paintMetaPanelOnCanvas / computeLaneTextSize) but never touches the
 * interactive crop modal. The modal stays the source of truth for manual,
 * operator-cropped exports; this module produces an unattended "results"
 * PNG = [metadata panel | photo strip] for fast sharing.
 *
 * Differences from the manual crop export (intentional, to stay zero-risk):
 *   - No operator crop handles → auto-crop around the finish (JYD reach
 *     points when available, else the full strip).
 *   - No reach-line / tick SVG overlay → the panel + strip carry the result;
 *     the rich overlay remains available in the interactive viewer.
 *
 * Flow:
 *   #4 background  — joyi-watch calls generateAndSavePhotoFinishPng() when an
 *                    .lcd lands, writing the PNG to the results share folder.
 *   #5 smart read  — the race page reads the saved PNG (fast), else generates
 *                    on demand from the Joyi folder files, else falls back to
 *                    the manual drag-drop picker.
 */
import {
  parseLcdHeader,
  renderLcdRangeToCanvas,
  paintMetaPanelOnCanvas,
  computeLaneTextSize,
  buildPhotoFinishMeta,
} from './photo-finish.js';
import { getConfig, getRace } from './db.js';
import { showToast } from './utils.js';
import { finishImagePublicUrl } from './finish-image.js';
import {
  writeToBoth,
  readFromSourceSubfolder,
  listNestedSubfolder,
  isSourceConnected,
} from './file-access.js';

const RESULTS_LOCAL = '12 Output_Results';
const PANEL_W = 320;
const DPR = 2;
// Padding (in scan-line columns) on each side of the reach-point window when
// auto-cropping around the finish.
const CROP_PAD = 500;

/** Deterministic filename so background-save and smart-read agree. */
export function photoFinishPngFilename(eventRef, raceNumber) {
  return `PhotoFinish_${eventRef || 'RDMS'}_R${raceNumber}.png`;
}

/** Joyi folder path — mirrors joyi-watch.resolveFolderPath. */
function joyiFolderPath(config) {
  const explicit = (config?.shared_joyi_folder || '').trim();
  if (explicit) return explicit;
  const ref = config?.event_short_ref || 'RDMS';
  return `80 Shared/${ref}_Joyi`;
}

/** Parse "{ref}.{N}.lcd|jyd" → race number (whitespace-tolerant prefix). */
function raceNumFromName(name, ext) {
  const m = String(name || '').match(new RegExp(`\\.(\\d+)\\.${ext}$`, 'i'));
  return m ? parseInt(m[1], 10) : NaN;
}

/**
 * Compute the export column window. Prefer the JYD reach-point span (where the
 * boats actually cross), padded; fall back to the full strip when no reach
 * data is present.
 */
export function autoCropRange(img, jydData) {
  const full = [0, img.displayWidth];
  const pts = jydData?.reachPoints;
  if (!Array.isArray(pts) || pts.length === 0) return full;
  const lines = pts.map(rp => rp.line).filter(n => Number.isFinite(n));
  if (lines.length === 0) return full;
  const lo = Math.max(0, Math.min(...lines) - CROP_PAD);
  const hi = Math.min(img.displayWidth, Math.max(...lines) + CROP_PAD);
  if (hi - lo <= 0) return full;
  return [lo, hi];
}

/**
 * Render the composite finish image (panel + auto-cropped strip) for a race to
 * a canvas. Shared by the PNG (full-res) and JPEG (small, for Supabase) paths.
 * @returns {Promise<{canvas: HTMLCanvasElement, width: number, height: number}>}
 */
async function renderPhotoFinishCanvas(race, lcdFile, jydFile) {
  const buf = await lcdFile.arrayBuffer();
  const img = parseLcdHeader(buf);

  let jydData = null;
  if (jydFile) {
    try {
      const { parseJydFile } = await import('./import.js');
      jydData = (await parseJydFile(jydFile)).jyd;
    } catch { /* overlay data optional */ }
  }

  // Shared reusable panel metadata — identical to the interactive modal.
  const meta = await buildPhotoFinishMeta(race);
  meta.laneTextSize = computeLaneTextSize(img.displayHeight, meta);

  const [colStart, colEnd] = autoCropRange(img, jydData);
  const imageOutW = Math.max(1, colEnd - colStart);
  const outW = PANEL_W + imageOutW;
  const outH = img.displayHeight;

  const out = document.createElement('canvas');
  out.width = outW * DPR;
  out.height = outH * DPR;
  const ctx = out.getContext('2d');
  ctx.scale(DPR, DPR);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // 1) Metadata / results panel.
  paintMetaPanelOnCanvas(ctx, 0, 0, PANEL_W, outH, meta);

  // 2) Photo strip for the chosen column range, drawn at native width.
  const imgCanvas = document.createElement('canvas');
  renderLcdRangeToCanvas(imgCanvas.getContext('2d'), img, 'trilinear-rgb', colStart, colEnd);
  ctx.drawImage(imgCanvas, PANEL_W, 0, imageOutW, outH);

  return { canvas: out, width: outW, height: outH };
}

/**
 * Render the composite PNG (panel + auto-cropped strip) for a race.
 * @returns {Promise<Blob>}
 */
export async function generatePhotoFinishBlob(race, lcdFile, jydFile) {
  const { canvas } = await renderPhotoFinishCanvas(race, lcdFile, jydFile);
  return await new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png');
  });
}

/**
 * Render a SMALL JPEG (downscaled to maxWidth, quality-compressed) for fast
 * sharing via Supabase Storage to the online / iPad viewer. Much smaller than
 * the PNG and never written to the Drive-synced folder.
 * @returns {Promise<Blob>}
 */
export async function generatePhotoFinishJpeg(race, lcdFile, jydFile, maxWidth = 1800, quality = 0.82) {
  const { canvas, width, height } = await renderPhotoFinishCanvas(race, lcdFile, jydFile);
  const targetW = Math.min(width, maxWidth);
  const scale = targetW / width;
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(width * scale));
  small.height = Math.max(1, Math.round(height * scale));
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(canvas, 0, 0, small.width, small.height);
  return await new Promise((resolve, reject) => {
    small.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/jpeg', quality);
  });
}

/**
 * Best-effort: generate the small JPEG for a race and upload it to Supabase
 * Storage so the online / iPad viewer can read it. Fire-and-forget — never
 * throws, never blocks the local view. Dynamic-imports sync.js to avoid a
 * circular dependency.
 */
export async function publishFinishImage(race, files = null) {
  try {
    let { lcd, jyd } = files || {};
    if (!lcd) {
      const found = await findJoyiPhotoFiles(race);
      lcd = found.lcd; jyd = found.jyd;
    }
    if (!lcd) return null;
    const jpeg = await generatePhotoFinishJpeg(race, lcd, jyd);
    const { uploadFinishImage } = await import('./sync.js');
    return await uploadFinishImage(race.race_number, jpeg);
  } catch (err) {
    console.warn('publishFinishImage failed (non-fatal):', err);
    return null;
  }
}

/** Read the previously-saved PNG for a race (local results folder). */
export async function readPhotoFinishPng(race) {
  if (!isSourceConnected()) return null;
  const cfg = await getConfig();
  const filename = photoFinishPngFilename(cfg?.event_short_ref, race.race_number);
  return await readFromSourceSubfolder(RESULTS_LOCAL, filename);
}

/** Locate the Joyi .lcd (and optional .jyd) for a race in the Joyi folder. */
export async function findJoyiPhotoFiles(race) {
  if (!isSourceConnected()) return { lcd: null, jyd: null };
  const cfg = await getConfig();
  const handles = await listNestedSubfolder(joyiFolderPath(cfg));
  let lcdHandle = null, jydHandle = null;
  for (const h of handles) {
    if (raceNumFromName(h.name, 'lcd') === race.race_number) lcdHandle = h;
    else if (raceNumFromName(h.name, 'jyd') === race.race_number) jydHandle = h;
  }
  const lcd = lcdHandle ? await lcdHandle.getFile() : null;
  const jyd = jydHandle ? await jydHandle.getFile() : null;
  return { lcd, jyd };
}

/**
 * Generate + save the PNG to the results share folder (local + shared). Used
 * by the background path (#4) and the smart-read on-demand path (#5).
 * @returns {Promise<Blob|null>}
 */
export async function generateAndSavePhotoFinishPng(race, files = null) {
  let { lcd, jyd } = files || {};
  // Even when the caller hands us the .lcd (e.g. the watcher already has it),
  // pull the .jyd from the folder if absent — it drives the auto-crop window.
  if (!lcd || !jyd) {
    const found = await findJoyiPhotoFiles(race);
    lcd = lcd || found.lcd;
    jyd = jyd || found.jyd;
  }
  if (!lcd) return null;

  const blob = await generatePhotoFinishBlob(race, lcd, jyd);
  const cfg = await getConfig();
  const ref = cfg?.event_short_ref || 'RDMS';
  const filename = photoFinishPngFilename(ref, race.race_number);
  try {
    await writeToBoth(RESULTS_LOCAL, filename, blob, `80 Shared/${ref}_Output_Results`);
  } catch (err) {
    console.warn('photo-finish PNG save failed:', err);
  }
  return blob;
}

/**
 * #4 background entry point — called fire-and-forget from joyi-watch when an
 * .lcd lands. Skips work when the PNG already exists so re-scans are cheap.
 *
 * FEATURE-FLAGGED OFF BY DEFAULT: writing each PNG to the shared results folder
 * triggers a Google Drive sync, which was slowing race-day sync noticeably.
 * Auto-generation only runs when config.auto_photo_finish_png === true. The
 * on-demand "Photo PNG" button (smartViewPhotoFinishPng) is unaffected.
 */
export async function backgroundGeneratePhotoFinishPng(raceNumber, lcdFile, jydFile) {
  try {
    const cfg = await getConfig();
    if (!cfg?.auto_photo_finish_png) return; // off by default — see note above
    const race = await getRace(raceNumber);
    if (!race) return;
    const existing = await readPhotoFinishPng(race);
    if (existing) return; // already generated
    await generateAndSavePhotoFinishPng(race, { lcd: lcdFile, jyd: jydFile });
  } catch (err) {
    console.warn('background photo-finish PNG generation failed:', err);
  }
}

/** Resolve true if an image URL loads (used to probe the Supabase JPEG). */
function imageUrlLoads(url) {
  return new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve(true);
    probe.onerror = () => resolve(false);
    probe.src = url;
  });
}

/** Minimal full-screen viewer for a finish image given a ready URL (online). */
function showImageUrlViewer(url, race) {
  showImageModal(url, race, false);
}

/** Minimal full-screen viewer for a photo-finish PNG blob/File. */
function showPngViewer(blob, race) {
  showImageModal(URL.createObjectURL(blob), race, true);
}

/**
 * Shared full-screen image modal.
 * @param {string} url  object URL (revoke=true) or a public URL (revoke=false)
 */
function showImageModal(url, race, revoke) {
  const existing = document.getElementById('pfPngViewer');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'pfPngViewer';
  modal.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.85); z-index:9998; display:flex; flex-direction:column; padding:16px;';
  modal.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:10px; color:#fff;">
      <strong style="font-size:14px;">Photo Finish — Race ${race.race_number}</strong>
      <a href="${url}" download="PhotoFinish_${race._eventRef || 'RDMS'}_R${race.race_number}.${revoke ? 'png' : 'jpg'}"
         class="btn btn-sm btn-outline" style="margin-left:auto;">
        <i class="material-icons" style="font-size:16px;">download</i> Download
      </a>
      <button class="btn btn-sm btn-ghost" id="pfPngClose" style="color:#fff;">
        <i class="material-icons" style="font-size:18px;">close</i>
      </button>
    </div>
    <div style="flex:1; overflow:auto; background:#111; border-radius:var(--radius-sm); display:flex;">
      <img src="${url}" alt="Photo finish race ${race.race_number}"
           style="max-width:none; height:100%; display:block; margin:auto;">
    </div>
  `;
  document.body.appendChild(modal);
  const cleanup = () => { if (revoke) URL.revokeObjectURL(url); modal.remove(); };
  modal.querySelector('#pfPngClose').addEventListener('click', cleanup);
  modal.addEventListener('click', (e) => { if (e.target === modal) cleanup(); });
}

/** Tiny spinner overlay used while generating on demand. */
function showSpinner(raceNumber) {
  const el = document.createElement('div');
  el.id = 'pfPngSpinner';
  el.style.cssText = 'position:fixed; inset:0; background:var(--bg-overlay); z-index:9999; display:flex; align-items:center; justify-content:center;';
  el.innerHTML = `
    <div style="background:var(--bg-card); border-radius:var(--radius-lg); padding:22px 26px; text-align:center; box-shadow:var(--shadow-lg);">
      <i class="material-icons" style="font-size:22px; color:var(--accent); animation:spin 1.4s linear infinite;">refresh</i>
      <div style="font-size:13px; color:var(--text-secondary); margin-top:8px;">Generating photo finish for Race ${raceNumber}…</div>
    </div>
    <style>@keyframes spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }</style>
  `;
  document.body.appendChild(el);
  return () => { document.getElementById('pfPngSpinner')?.remove(); };
}

/**
 * #5 smart-read entry point. Resolution order:
 *   1. Saved PNG in the results folder → show instantly (fast path).
 *   2. Joyi .lcd present → generate on demand (spinner), save, show.
 *   3. Nothing found → open the manual drag-drop picker (same as the existing
 *      Photo Finish button) so the operator can supply the files.
 *
 * Parallel to the interactive viewer — does not modify or interrupt it.
 */
export async function smartViewPhotoFinishPng(race) {
  const cfg = await getConfig();
  race._eventRef = cfg?.event_short_ref || '';

  // ONLINE (no local file access — iPad at another station): read the published
  // small JPEG straight from the public Supabase Storage bucket by URL.
  if (!isSourceConnected()) {
    const url = finishImagePublicUrl(cfg?.supabase_url, cfg?.event_short_ref, race.race_number);
    const stop = showSpinner(race.race_number);
    const ok = url ? await imageUrlLoads(url) : false;
    stop();
    if (ok) { showImageUrlViewer(url, race); return; }
    showToast(`Finish image for Race ${race.race_number} isn't published yet.`, 'info');
    return;
  }

  // LOCAL — show fast from local files, and publish the small JPEG to Supabase
  // in the background so the online viewer can read it.
  // 1) Existing PNG — instant.
  try {
    const existing = await readPhotoFinishPng(race);
    if (existing) {
      showPngViewer(existing, race);
      publishFinishImage(race).catch(() => {});
      return;
    }
  } catch { /* fall through */ }

  // 2) Generate on demand from Joyi files.
  const stop = showSpinner(race.race_number);
  try {
    const found = await findJoyiPhotoFiles(race);
    if (found.lcd) {
      const blob = await generateAndSavePhotoFinishPng(race, found);
      stop();
      if (blob) {
        showPngViewer(blob, race);
        publishFinishImage(race, found).catch(() => {});
        return;
      }
    } else {
      stop();
    }
  } catch (err) {
    stop();
    console.warn('on-demand photo-finish PNG failed:', err);
  }

  // 3) Fallback — manual picker (mirrors the Photo Finish button).
  try {
    const { showPhotoFinishPicker } = await import('./photo-finish.js');
    await showPhotoFinishPicker(race);
  } catch { /* nothing more we can do */ }
}

/**
 * Background entry point — called fire-and-forget from joyi-watch when an .lcd
 * lands, to pre-publish the small JPEG to Supabase so the iPad viewer sees the
 * image for EVERY race without the operator opening Quick View first.
 *
 * Unlike the PNG auto-save this does NOT write to the Drive-synced folder (it
 * uploads straight to Supabase Storage), so it doesn't compete for the uplink.
 * Gated by config.auto_finish_image_upload (default ON when Supabase is set).
 */
export async function backgroundUploadFinishImage(raceNumber, lcdFile, jydFile) {
  try {
    const cfg = await getConfig();
    if (cfg?.auto_finish_image_upload === false) return; // explicit opt-out
    if (!cfg?.supabase_url) return; // no Supabase → nowhere to publish
    const race = await getRace(raceNumber);
    if (!race) return;
    await publishFinishImage(race, { lcd: lcdFile, jyd: jydFile });
  } catch (err) {
    console.warn('background finish-image upload failed:', err);
  }
}
