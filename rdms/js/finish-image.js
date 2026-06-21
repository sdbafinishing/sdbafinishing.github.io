/**
 * SDBA RDMS — Finish-image (Quick View) Supabase Storage helpers
 *
 * The "Quick View" button shows a small JPEG of the finish. On the LOCAL app
 * the image is generated from the Joyi .lcd/.jyd and uploaded here; on the
 * ONLINE viewer (iPad at another station) there's no file access, so it reads
 * this same JPEG straight from a PUBLIC Supabase Storage bucket by URL.
 *
 * Deliberately a SMALL JPEG (not the big PNG) so it's fast on a weak uplink and
 * — unlike the PNG path — never touches the Google Drive sync queue.
 *
 * Prerequisite: a PUBLIC Storage bucket named `finish-images` in the Supabase
 * project (Storage → New bucket → name `finish-images` → Public). Uploads use
 * the service-role key (local only), reads are public.
 */

export const FINISH_IMAGE_BUCKET = 'finish-images';

/** Deterministic object path so upload + read agree: `{ref}/{race}.jpg`. */
export function finishImagePath(eventRef, raceNumber) {
  return `${eventRef || 'RDMS'}/${raceNumber}.jpg`;
}

/**
 * Public download URL for a finish image. Works without an authenticated
 * client because the bucket is public. Returns null if we don't know the
 * Supabase URL.
 */
export function finishImagePublicUrl(supabaseUrl, eventRef, raceNumber) {
  if (!supabaseUrl) return null;
  const base = String(supabaseUrl).replace(/\/+$/, '');
  return `${base}/storage/v1/object/public/${FINISH_IMAGE_BUCKET}/${finishImagePath(eventRef, raceNumber)}`;
}
