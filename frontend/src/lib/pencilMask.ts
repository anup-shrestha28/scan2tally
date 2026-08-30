/**
 * Covering pencil writing in the DISPLAYED voucher photo.
 *
 * The extraction already excludes pencil from the data; the client also wants
 * it invisible in the app. Erasing it from the stored file was measured and
 * rejected — graphite and ballpoint overlap on darkness, local contrast and
 * saturation in these photos, so any pixel rule would sooner or later erase
 * faint pen. Instead the backend asks the vision model WHERE the pencil is
 * (normalized [ymin, xmin, ymax, xmax] boxes, 0-1000), stores the boxes beside
 * the extraction, and this module paints paper-coloured patches over those
 * regions on a canvas copy at display time.
 *
 * The original photo is never modified. A wrong box therefore costs a covered
 * patch of paper, never destroyed information.
 */

export type PencilRegion = [number, number, number, number];

const COORDINATE_SPACE = 1000;
/**
 * Zero on purpose. Covering the graphite's faint edge needs a little room
 * around the box, but padding blindly here is what hid the client's ink: a
 * pencil note sits a few pixels below an ink ledger name, so 0.5% of the
 * image height reached the line above. The backend now spends that room
 * where it has the pixels to see it is blank, and stores a box that is
 * already fitted. Drawing anything extra would undo that.
 */
const PAD_UNITS = 0;
/** More boxes than any voucher plausibly carries means the answer is wrong. */
const MAX_REGIONS = 40;

/**
 * Same distrust as the backend applies, repeated here on purpose: these values
 * come out of a database column any writer could have filled, and they become
 * drawing instructions. Clamped, reordered, degenerate entries dropped.
 */
export function sanitizePencilRegions(value: unknown): PencilRegion[] {
  if (!Array.isArray(value)) return [];
  const regions: PencilRegion[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 4) continue;
    const numbers = entry.map(item => Math.round(Number(item)));
    if (numbers.some(item => !Number.isFinite(item))) continue;
    const clamped = numbers.map(item => Math.max(0, Math.min(COORDINATE_SPACE, item)));
    const [y0, y1] = [clamped[0], clamped[2]].sort((a, b) => a - b);
    const [x0, x1] = [clamped[1], clamped[3]].sort((a, b) => a - b);
    if (y1 - y0 < 2 || x1 - x0 < 2) continue;
    regions.push([y0, x0, y1, x1]);
  }
  return regions.length > MAX_REGIONS ? [] : regions;
}

/** One region as padded, clamped pixel coordinates on a width x height image. */
export function regionToPixels(
  region: PencilRegion,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const [y0, x0, y1, x1] = region;
  const padX = (PAD_UNITS / COORDINATE_SPACE) * width;
  const padY = (PAD_UNITS / COORDINATE_SPACE) * height;
  const left = Math.max(0, (x0 / COORDINATE_SPACE) * width - padX);
  const top = Math.max(0, (y0 / COORDINATE_SPACE) * height - padY);
  const right = Math.min(width, (x1 / COORDINATE_SPACE) * width + padX);
  const bottom = Math.min(height, (y1 / COORDINATE_SPACE) * height + padY);
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) };
}


/* ------------------------------------------------------------------------
   The cover is a deliberately DETERMINISTIC opaque patch.

   Six approaches to erasing only the pencil strokes themselves were built and
   measured on the client's own vouchers, and every one failed in a different
   way: brightness thresholds leave remnants because hard-pressed graphite is
   as dark as ink; colour cannot help because this ink photographs as neutral
   as graphite; generative editing removed the pencil perfectly and then
   REWROTE the voucher (ledger names moved onto other rows' amounts); and
   model-voted stroke classification either fused pencil with the ink above it
   or collapsed into voting everything pencil. The lesson: at this photo
   quality, parts of the pencil are physically indistinguishable from ink, so
   any per-stroke eraser must sometimes be wrong about one of them.

   A flat cover is never wrong about either. Everything inside a located box
   is hidden — pencil with certainty, and occasionally the part of an ink word
   the pencil was scribbled under. That covered ink is never lost: the grid
   beside the photo has the full extracted text and the stored file is
   untouched. The backend also filters every located note before storing it —
   a note whose own text reads back as extracted ink data (the date, a ledger
   name, the narration) is dropped rather than covered, which is what keeps
   covers off real ink fields.
   ------------------------------------------------------------------------ */

/**
 * The average colour of a thin ring just OUTSIDE the patch, so the cover is
 * the local paper tone rather than one global grey — these photos carry heavy
 * shadows, and a bright patch inside a shadow would advertise itself.
 */
function paperColorAround(
  context: CanvasRenderingContext2D,
  patch: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): string {
  const RING = 6;
  let r = 0, g = 0, b = 0, count = 0;

  const strips = [
    { x: patch.x, y: patch.y - RING, w: patch.w, h: RING },
    { x: patch.x, y: patch.y + patch.h, w: patch.w, h: RING },
    { x: patch.x - RING, y: patch.y, w: RING, h: patch.h },
    { x: patch.x + patch.w, y: patch.y, w: RING, h: patch.h },
  ];
  for (const strip of strips) {
    const x = Math.max(0, Math.floor(strip.x));
    const y = Math.max(0, Math.floor(strip.y));
    const w = Math.min(width - x, Math.ceil(strip.w));
    const h = Math.min(height - y, Math.ceil(strip.h));
    if (w <= 0 || h <= 0) continue;
    const pixels = context.getImageData(x, y, w, h).data;
    for (let index = 0; index < pixels.length; index += 4) {
      r += pixels[index]; g += pixels[index + 1]; b += pixels[index + 2];
      count += 1;
    }
  }
  if (!count) return 'rgb(232, 230, 223)';   // a plausible voucher-paper tone
  return `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
}

/**
 * The photo at `url` with its pencil regions covered, as a data URL.
 *
 * Fails open: any problem — network, decode, a tainted canvas — returns the
 * original URL, because a visible pencil note is a lesser failure than no
 * photo at all. createImageBitmap applies EXIF rotation by default, which
 * matches the upright orientation the boxes were measured in.
 */
export async function maskPencilRegions(url: string, value: unknown): Promise<string> {
  const regions = sanitizePencilRegions(value);
  if (!regions.length) return url;

  try {
    const response = await fetch(url);
    if (!response.ok) return url;
    const bitmap = await createImageBitmap(await response.blob());

    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) return url;
    context.drawImage(bitmap, 0, 0);

    for (const region of regions) {
      const patch = regionToPixels(region, bitmap.width, bitmap.height);
      if (!patch.w || !patch.h) continue;
      context.fillStyle = paperColorAround(context, patch, bitmap.width, bitmap.height);
      context.fillRect(patch.x, patch.y, patch.w, patch.h);
    }
    return canvas.toDataURL('image/jpeg', 0.92);
  } catch {
    return url;
  }
}
