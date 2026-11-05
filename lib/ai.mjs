import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(import.meta.url);

const MIME = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

let removeBackgroundFn = null;
let defaultPublicPath = null;

async function getRemoveBackground() {
  if (!removeBackgroundFn) {
    const mod = await import('@imgly/background-removal-node');
    removeBackgroundFn = mod.removeBackground;
    // The package ships its model assets in <pkg>/dist/ and resolves them
    // relative to process.cwd() by default. Resolve the real location via the
    // CJS entry (dist/index.cjs) so the CLI works from any working directory
    // (and fully offline).
    const entry = require.resolve('@imgly/background-removal-node');
    defaultPublicPath = pathToFileURL(path.dirname(entry)).href + '/';
  }
  return removeBackgroundFn;
}

/**
 * Single inference pass (no post-processing).
 *
 * @returns {{ data: Uint8Array, width: number, height: number }}
 *          Raw RGBA pixels with the background made transparent.
 */
async function aiInfer(inputBuffer, { model = 'medium' } = {}, onProgress) {
  const removeBackground = await getRemoveBackground();

  // Pass jpeg/png/webp straight through; normalize everything else (and any
  // EXIF-rotated image) through sharp so the model sees upright pixels.
  const meta = await sharp(inputBuffer).metadata();
  const upright = !meta.orientation || meta.orientation === 1;
  let blob;
  if (upright && MIME[meta.format]) {
    blob = new Blob([inputBuffer], { type: MIME[meta.format] });
  } else {
    const normalized = await sharp(inputBuffer).rotate().png({ compressionLevel: 1 }).toBuffer();
    blob = new Blob([normalized], { type: 'image/png' });
  }

  const out = await removeBackground(blob, {
    model,
    proxyToWorker: false,
    publicPath: defaultPublicPath,
    output: { format: 'image/x-rgba8' },
    progress: onProgress,
  });

  // IMPORTANT: take a private copy immediately. The blob's ArrayBuffer can
  // still be finalized by imgly's async internals after the promise resolves;
  // holding the view directly made post-processing race with it (alpha edits
  // silently reverted before the PNG encode).
  const src = new Uint8Array(await out.arrayBuffer());
  const raw = new Uint8Array(src.length);
  raw.set(src);
  const params = Object.fromEntries(
    [...out.type.matchAll(/(\w+)=([^;]+)/g)].map((m) => [m[1], m[2]])
  );
  const width = Number.parseInt(params.width, 10);
  const height = Number.parseInt(params.height, 10);

  if (!width || !height || raw.length !== width * height * 4) {
    throw new Error(
      `unexpected AI output: ${raw.length} bytes for ${width || '?'}x${height || '?'}`
    );
  }
  return { data: raw, width, height };
}

/**
 * Measure the opaque support of a mask: last row with alpha >= threshold and
 * the horizontal span of the support.
 */
function maskSupport(data, width, height, threshold = 128) {
  let lastRow = -1;
  let minX = width;
  let maxX = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] >= threshold) {
        if (y > lastRow) lastRow = y;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return { lastRow, minX, maxX };
}

/**
 * AI background removal with bottom recovery.
 *
 * IS-Net works on a 320x320 internal grid, so low-contrast translucent parts
 * that occupy a small fraction of a tall image (e.g. the glass base of a
 * vial) can get classified as background and the cutout ends in a hard
 * horizontal line. Fix: run a second inference on the bottom ~35% crop -
 * where that region fills far more of the model's grid - and union the two
 * masks, letting the crop only EXTEND the silhouette downward within the
 * columns the main mask already occupies.
 *
 * @returns {{ data: Uint8Array, width: number, height: number }}
 */
const EDGE_PROFILES = {
  clean: {},                                              // erode 1px + steep ramp (radii auto-scale)
  hard: { lo: 110, hi: 150 },                             // near-binary edge (radii auto-scale)
  soft: null,                                             // raw model output
};

export async function aiRemove(inputBuffer, { model = 'medium', bottomBoost = true, edge = 'clean' } = {}, onProgress) {
  const finish = (res) => {
    // edge may explicitly be 'soft' (null profile = skip); only fall back to
    // the default profile for an unknown mode. (?? would treat the null
    // 'soft' profile as missing and silently run 'clean' instead.)
    const profile = edge in EDGE_PROFILES ? EDGE_PROFILES[edge] : EDGE_PROFILES.clean;
    if (profile) decontaminateEdges(res.data, res.width, res.height, profile);
    return res;
  };

  const main = await aiInfer(inputBuffer, { model }, onProgress);
  if (!bottomBoost) return finish(main);

  const { width: W, height: H } = main;
  const support = maskSupport(main.data, W, H);
  const { lastRow, minX, maxX } = support;
  // Nothing segmented, or the mask already reaches (nearly) the image bottom.
  if (lastRow < 0 || lastRow > H * 0.985) return main;

  const cropFrac = 0.35;
  const cropTop = Math.floor(H * (1 - cropFrac));
  if (cropTop >= lastRow) return main; // no room below the mask to recover

  const cropBuf = await sharp(inputBuffer)
    .rotate()
    .extract({ left: 0, top: cropTop, width: W, height: H - cropTop })
    .png({ compressionLevel: 1 })
    .toBuffer();
  const crop = await aiInfer(cropBuf, { model }, onProgress);

  const out = new Uint8Array(main.data);
  const pad = Math.round(W * 0.03);
  const band = Math.max(2, Math.round(H * 0.012)); // vertical blend band over the seam
  const gMinX = Math.max(0, minX - pad);
  const gMaxX = Math.min(W - 1, maxX + pad);
  const cH = H - cropTop;

  const blendAt = (y) => (y <= lastRow - band ? 0 : y >= lastRow ? 1 : (y - (lastRow - band)) / band);

  for (let y = cropTop; y < H; y++) {
    const blend = blendAt(y);
    if (blend <= 0) continue;
    for (let x = gMinX; x <= gMaxX; x++) {
      const i = (y * W + x) * 4;
      const a2 = crop.data[((y - cropTop) * W + x) * 4 + 3];
      const boosted = Math.max(out[i + 3], Math.round(a2 * blend));
      if (boosted > out[i + 3]) {
        // Newly added alpha: blend the crop's RGB in (it matches the region),
        // weighted by how much alpha we added.
        const w = ((boosted - out[i + 3]) / Math.max(1, boosted)) * blend;
        for (let c = 0; c < 3; c++) {
          out[i + c] = Math.round(out[i + c] * (1 - w) + crop.data[((y - cropTop) * W + x) * 4 + c] * w);
        }
        out[i + 3] = boosted;
      }
    }
  }
  return finish({ data: out, width: W, height: H });
}

/** Extract the alpha channel of raw RGBA as a standalone Uint8Array. */
export function alphaOf(rgba, width, height) {
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  return alpha;
}

/**
 * Edge decontamination.
 *
 * The segmentation model returns a soft alpha ramp (3-10 px) across the
 * silhouette. In that ramp the RGB is still the ORIGINAL pixel - a blend of
 * product AND the old background - so over a dark or saturated backdrop the
 * half-kept background shows up as a colored fringe (e.g. vertical streaks
 * of the countertop texture along a bottle's label edge).
 *
 * Fix, applied ONLY to the silhouette band (so legitimate translucency like
 * glass bases, which sit far from any solid core, keeps its soft ramp):
 *   1. erode the band by `erode` px (min filter) - drops the outermost,
 *      most contaminated ring entirely;
 *   2. re-map the band's alpha ramp [lo..hi] -> [0..255], so half-opaque
 *      background-contaminated pixels collapse toward 0.
 * Interior (solid) and exterior (transparent) pixels are untouched.
 *
 * `radius`/`erode` are RESOLUTION-INVARIANT by default: derived from the
 * image size (5 px / 1 px at a 1536px-wide photo) so a thumbnail and a 4K
 * export get proportionally identical treatment. lo/hi are alpha-domain and
 * need no scaling.
 */
export function decontaminateEdges(data, width, height, {
  coreA = 200,   // alpha >= coreA counts as solid interior
  lowA = 25,     // alpha <= lowA counts as background
  radius = null, // how far from the solid core the band extends (null = auto)
  erode = null,  // px of inward pull (null = auto)
  lo = 60,       // remap: band alpha <= lo -> 0
  hi = 180,      // remap: band alpha >= hi -> 255
} = {}) {
  const minDim = Math.min(width, height);
  const r = radius ?? Math.min(10, Math.max(2, Math.round(minDim * 0.003)));
  const er = erode ?? Math.min(3, Math.max(1, Math.round(minDim * 0.0008)));
  const n = width * height;
  const a = alphaOf(data, width, height);
  const loU = Math.max(0, lo - 1);
  const scale = 255 / Math.max(1, hi - lo);
  let changed = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const v = a[idx];
      if (v <= lowA || v >= 255) continue; // pure background / already max
      if (v > coreA) {
        // solid: only relevant if it sits ON the band (a low neighbor near)
        let hasLow = false;
        for (let dy = -1; dy <= 1 && !hasLow; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < width && a[yy * width + xx] <= lowA) { hasLow = true; break; }
          }
        }
        if (!hasLow) continue;
      }
      // band membership: within `radius` of both a solid core and background
      let hasCore = false;
      let hasLow = false;
      const y0 = Math.max(0, y - r), y1 = Math.min(height - 1, y + r);
      const x0 = Math.max(0, x - r), x1 = Math.min(width - 1, x + r);
      for (let yy = y0; yy <= y1 && !(hasCore && hasLow); yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const u = a[yy * width + xx];
          if (u >= coreA) hasCore = true;
          else if (u <= lowA) hasLow = true;
        }
      }
      if (!hasCore || !hasLow) continue;

      // min-filter erosion over a (2*er+1)^2 window, then remap
      const ey0 = Math.max(0, y - er), ey1 = Math.min(height - 1, y + er);
      const ex0 = Math.max(0, x - er), ex1 = Math.min(width - 1, x + er);
      let m = 255;
      for (let yy = ey0; yy <= ey1; yy++) {
        for (let xx = ex0; xx <= ex1; xx++) {
          const u = a[yy * width + xx];
          if (u < m) m = u;
        }
      }
      const mapped = m <= loU ? 0 : m >= hi ? 255 : Math.round((m - lo) * scale);
      const out = Math.min(v, mapped); // never add opacity, only clean
      if (out !== v) {
        changed++;
        data[idx * 4 + 3] = out;
      }
    }
  }
  return changed;
}
