import sharp from 'sharp';
import { hexOf } from './utils.mjs';

/** Maximum possible Euclidean distance in RGB space. */
const MAX_DIST = Math.sqrt(255 * 255 * 3);

/**
 * Detect the dominant background color by sampling a ring of pixels around
 * the image border (mode of 16-step-quantized colors).
 */
export function detectKeyColor(data, width, height) {
  const t = Math.max(2, Math.round(Math.min(width, height) * 0.015));
  const buckets = new Map();
  const sample = (x, y) => {
    const i = (y * width + x) * 4;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n += 1;
    e.r += r;
    e.g += g;
    e.b += b;
    buckets.set(key, e);
  };
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < t; x += 2) {
      sample(x, y);
      sample(width - 1 - x, y);
    }
  }
  for (let x = 0; x < width; x += 2) {
    for (let y = 0; y < t; y += 2) {
      sample(x, y);
      sample(x, height - 1 - y);
    }
  }
  let best = null;
  for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
  if (!best || best.n === 0) return { r: 255, g: 255, b: 255 };
  return { r: Math.round(best.r / best.n), g: Math.round(best.g / best.n), b: Math.round(best.b / best.n) };
}

/**
 * Flood fill from the image borders over pixels that match the key color
 * within the tolerance. Pixels reached become transparent; interior pixels
 * of a similar color (e.g. white text on the product) are preserved.
 *
 * @returns {Uint8Array} mask, 255 = keep, 0 = remove
 */
export function floodFillMask(data, width, height, key, tolerancePct) {
  const th = (Math.max(1, Math.min(100, tolerancePct)) / 100) * MAX_DIST;
  const th2 = th * th;
  const kr = key.r;
  const kg = key.g;
  const kb = key.b;

  const total = width * height;
  const mask = new Uint8Array(total).fill(255);
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  let sp = 0;

  const near = (idx) => {
    const i = idx * 4;
    const dr = data[i] - kr;
    const dg = data[i + 1] - kg;
    const db = data[i + 2] - kb;
    return dr * dr + dg * dg + db * db <= th2;
  };
  const push = (idx) => {
    if (seen[idx]) return;
    seen[idx] = 1;
    if (near(idx)) {
      mask[idx] = 0;
      stack[sp++] = idx;
    }
  };

  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }

  while (sp > 0) {
    const idx = stack[--sp];
    const x = idx % width;
    const y = (idx / width) | 0;
    if (x > 0) push(idx - 1);
    if (x < width - 1) push(idx + 1);
    if (y > 0) push(idx - width);
    if (y < height - 1) push(idx + width);
  }
  return mask;
}

/**
 * Soften mask edges with a small separable box blur (2 full passes ~ gaussian).
 * Implemented in pure JS on purpose: sharp silently promotes 1-channel raw
 * images to 3 channels in some pipelines, which would corrupt the mask.
 */
export function featherMask(mask, width, height, px) {
  if (!px || px <= 0.05) return mask;
  const r = Math.max(1, Math.round(px));
  const a = mask;
  const b = new Uint8Array(mask.length);

  const boxH = (src, dst) => {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < width) {
            sum += src[row + xx];
            n++;
          }
        }
        dst[row + x] = (sum / n) | 0;
      }
    }
  };
  const boxV = (src, dst) => {
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < height) {
            sum += src[yy * width + x];
            n++;
          }
        }
        dst[row + x] = (sum / n) | 0;
      }
    }
  };

  boxH(a, b);
  boxV(b, a);
  boxH(a, b);
  boxV(b, a);
  return a;
}

/**
 * Chroma-key background removal: detect (or take) a key color, flood fill
 * from the borders, feather the edge and apply as alpha.
 *
 * @returns {{ data: Uint8Array, width: number, height: number, keyColor: object }}
 */
export async function chromaRemove(inputBuffer, { key = null, tolerance = 25, feather = 1.5 } = {}) {
  const { data, info } = await sharp(inputBuffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;

  const keyColor = key ?? detectKeyColor(data, width, height);
  const mask = featherMask(floodFillMask(data, width, height, keyColor, tolerance), width, height, feather);

  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 3] = Math.min(data[i * 4 + 3], mask[i]);
  }
  return { data, width, height, keyColor: hexOf(keyColor) };
}
