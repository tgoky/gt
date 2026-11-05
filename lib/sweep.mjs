/**
 * All-sides background sweep.
 *
 * The AI mask shapes alpha by geometry alone; it never asks whether a kept
 * pixel actually LOOKS like the background. That is how gray fuzz (a sliver
 * of countertop/backdrop at partial alpha) can survive along the silhouette
 * - typically near high-frequency product edges like a barcode, a cap ribbing
 * or a spout - and it can appear on ANY side, not just one.
 *
 * This module closes that gap deterministically:
 *
 *   1. estimateAnchors()   build a small multi-color model of the background
 *                          from the original photo's border frame (handles
 *                          textured / gradient backdrops, unlike a single
 *                          key color).
 *   2. sweepBackground()   flood from ALL FOUR borders through the current
 *                          cutout. Every reachable pixel whose color matches
 *                          the background model is made fully transparent.
 *                          Wide solid product interiors are protected, so
 *                          the sweep can never eat into the bottle body -
 *                          it only trims fringe, haze and pockets that are
 *                          physically connected to the outside on some side.
 *   3. defringeEdges()     silhouette-band pixels keep their ORIGINAL RGB,
 *                          i.e. a blend of product and old backdrop. Un-
 *                          premix them against the estimated backdrop so a
 *                          semi-transparent edge pixel shows product color,
 *                          not gray halo (matters when the PNG is placed on
 *                          a light design background).
 *   4. auditEdges()        count remaining opaque background-like pixels on
 *                          each side's outer ring -> the CLI prints
 *                          `edges T✓ L✓ B✓ R✓` so every batch run PROVES
 *                          all four sides are clean.
 */

/** Squared RGB distance between a pixel and its nearest anchor. */
function nearestAnchorDist2(anchors, count, r, g, b) {
  let best = Infinity;
  for (let k = 0; k < count; k++) {
    const o = k * 3;
    const dr = r - anchors[o];
    const dg = g - anchors[o + 1];
    const db = b - anchors[o + 2];
    const d = dr * dr + dg * dg + db * db;
    if (d < best) best = d;
  }
  return best;
}

/**
 * Estimate background reference colors from the border frame of the ORIGINAL
 * photo. Online clustering: a sample far from every existing anchor spawns a
 * new anchor (captures multi-tone backdrops: table + wall, vignetting...),
 * then a few refinement passes average each cluster.
 *
 * @param {Uint8Array} raw  upright RGB (3 ch) of the original photo
 * @returns {{ anchors: Float32Array, count: number }}
 */
export function estimateAnchors(raw, width, height, { maxAnchors = 12, spawnDist = 48 } = {}) {
  const t = Math.max(2, Math.round(Math.min(width, height) * 0.02)); // frame thickness
  const spawn2 = spawnDist * spawnDist;

  // --- collect border samples (subsampled) -------------------------------
  const samples = [];
  const step = 2;
  const take = (x, y) => {
    const i = (y * width + x) * 3;
    samples.push(raw[i], raw[i + 1], raw[i + 2]);
  };
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < t; x += step) { take(x, y); take(width - 1 - x, y); }
  }
  for (let x = 0; x < width; x += step) {
    for (let y = 0; y < t; y += step) { take(x, y); take(x, height - 1 - y); }
  }

  // --- online split: seed anchors where samples are far apart ------------
  const anchors = new Float32Array(maxAnchors * 3);
  const sums = new Float64Array(maxAnchors * 3);
  const counts = new Uint32Array(maxAnchors);
  let count = 0;

  for (let s = 0; s < samples.length; s += 3) {
    const r = samples[s], g = samples[s + 1], b = samples[s + 2];
    let bestK = -1;
    let bestD = Infinity;
    for (let k = 0; k < count; k++) {
      const o = k * 3;
      const dr = r - anchors[o], dg = g - anchors[o + 1], db = b - anchors[o + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; bestK = k; }
    }
    if (bestK === -1 || bestD > spawn2) {
      if (count < maxAnchors) {
        const o = count * 3;
        anchors[o] = r; anchors[o + 1] = g; anchors[o + 2] = b;
        count++;
      }
      // anchor budget exhausted: fold into nearest (bestK may still be -1 if
      // the very first sample overflowed - impossible since count starts 0)
    }
  }

  // --- refinement: 3 Lloyd passes over the samples ------------------------
  for (let pass = 0; pass < 3; pass++) {
    sums.fill(0);
    counts.fill(0);
    for (let s = 0; s < samples.length; s += 3) {
      const r = samples[s], g = samples[s + 1], b = samples[s + 2];
      let bestK = 0;
      let bestD = Infinity;
      for (let k = 0; k < count; k++) {
        const o = k * 3;
        const dr = r - anchors[o], dg = g - anchors[o + 1], db = b - anchors[o + 2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; bestK = k; }
      }
      const o = bestK * 3;
      sums[o] += r; sums[o + 1] += g; sums[o + 2] += b;
      counts[bestK]++;
    }
    for (let k = 0; k < count; k++) {
      if (!counts[k]) continue;
      const o = k * 3;
      anchors[o] = sums[o] / counts[k];
      anchors[o + 1] = sums[o + 1] / counts[k];
      anchors[o + 2] = sums[o + 2] / counts[k];
    }
  }

  return { anchors, count };
}

/**
 * Area of the largest 4-connected component of solid (alpha >= solidA)
 * pixels - a resolution-independent estimate of "how big the product is".
 */
function largestSolidArea(rgba, width, height, solidA) {
  const total = width * height;
  const seen = new Uint8Array(total);
  const queue = new Int32Array(total);
  let best = 0;
  for (let seed = 0; seed < total; seed++) {
    if (seen[seed] || rgba[seed * 4 + 3] < solidA) continue;
    let qh = 0, qt = 0, area = 0;
    seen[seed] = 1;
    queue[qt++] = seed;
    while (qh < qt) {
      const i = queue[qh++];
      area++;
      const x = i % width;
      const y = (i - x) / width;
      const push = (j) => {
        if (!seen[j] && rgba[j * 4 + 3] >= solidA) { seen[j] = 1; queue[qt++] = j; }
      };
      if (x > 0) push(i - 1);
      if (x < width - 1) push(i + 1);
      if (y > 0) push(i - width);
      if (y < height - 1) push(i + width);
    }
    if (area > best) best = area;
  }
  return best;
}

/**
 * Border flood sweep over the CUTOUT - structure-aware.
 *
 * Color alone cannot separate "background sliver" from "translucent product"
 * (a glass base shows the backdrop THROUGH itself, so its pixels match the
 * backdrop colors). The discriminator is structure:
 *
 *   stage 1  flood from ALL FOUR borders: fully transparent pixels are free
 *            to walk (so islands floating in the removed zone are reached);
 *            a pixel with alpha > 0 JOINES the candidate set M when its
 *            color matches the background model (loose tol for soft pixels,
 *            strict tol for solid ones). Nothing is erased yet.
 *   stage 2  split M into connected components and decide per component:
 *              - small / mostly-soft patch  -> real debris (haze, gray fuzz,
 *                shadow wisps, pockets): erase the whole component;
 *              - component dominated by a large SOLID area -> translucent
 *                product body (glass base, clear lid): keep every solid
 *                pixel, erase only its soft (alpha < solidA) fringe ring.
 *
 * @param {Uint8Array} rgba  cutout pixels, modified in place
 * @param {{ anchors, count }} bg  background model from estimateAnchors()
 * @returns {{ removed: number, components: number, keptSolid: number }}
 */
export function sweepBackground(rgba, width, height, bg, {
  tolSoft = 46,     // max color distance for alpha < solidA pixels
  tolHard = 30,     // ...for alpha >= solidA pixels (product-solid candidates)
  solidA = 200,     // alpha at/above which a pixel counts as solid
  maxPatch = null,  // solid-px debris limit; derived scale-invariantly if null
  keepFrac = 0.05,  // debris limit as a fraction of the product's solid area
} = {}) {
  const { anchors, count } = bg;
  const total = width * height;
  const soft2 = tolSoft * tolSoft;
  const hard2 = tolHard * tolHard;

  // Scale-invariant debris limit. "How much solid backdrop-colored area is
  // still a pocket of debris vs a translucent product body" must scale with
  // the PRODUCT, not with a constant pixel count: a fixed 20k px would eat a
  // glass base on a 600px photo and keep real debris on a 4000px one.
  // Limit = 5% of the product's own solid area, clamped to 0.4%-2% of the
  // canvas so absurd frames (tiny object / object filling the frame) stay
  // sane. minDim^2 bounds make the ratio resolution-independent.
  const minDim = Math.min(width, height);
  const loCap = Math.max(256, Math.round(minDim * minDim * 0.004));
  const hiCap = Math.max(loCap, Math.round(minDim * minDim * 0.02));
  const objArea = largestSolidArea(rgba, width, height, solidA);
  const patchLimit = maxPatch ?? Math.min(hiCap, Math.max(loCap, Math.round(objArea * keepFrac)));

  // ---- stage 1: border flood, collect matched candidates -----------------
  const inM = new Uint8Array(total);
  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  let sp = 0;
  let matched = 0;

  const tryEnter = (i) => {
    if (seen[i]) return;
    seen[i] = 1;
    const i4 = i * 4;
    const a = rgba[i4 + 3];
    if (a === 0) { stack[sp++] = i; return; } // walk through for free
    const d2 = nearestAnchorDist2(anchors, count, rgba[i4], rgba[i4 + 1], rgba[i4 + 2]);
    if (d2 > (a < solidA ? soft2 : hard2)) return; // wall: not background-like
    inM[i] = 1;
    matched++;
    stack[sp++] = i;
  };

  // seed: the whole outer ring (all four sides at once)
  for (let x = 0; x < width; x++) { tryEnter(x); tryEnter((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { tryEnter(y * width); tryEnter(y * width + width - 1); }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % width;
    const y = (i - x) / width;
    if (x > 0) tryEnter(i - 1);
    if (x < width - 1) tryEnter(i + 1);
    if (y > 0) tryEnter(i - width);
    if (y < height - 1) tryEnter(i + width);
  }

  // ---- stage 2: per-component decision ------------------------------------
  const comp = new Int32Array(total).fill(-1);
  const queue = new Int32Array(total);
  let components = 0;
  let removed = 0;
  let keptSolid = 0;

  for (let seed = 0; seed < total; seed++) {
    if (!inM[seed] || comp[seed] !== -1) continue;
    // collect this component (soft + solid members)
    let qh = 0, qt = 0;
    comp[seed] = components;
    queue[qt++] = seed;
    const softMembers = [];
    const solidMembers = [];
    while (qh < qt) {
      const i = queue[qh++];
      if (rgba[i * 4 + 3] >= solidA) solidMembers.push(i);
      else softMembers.push(i);
      const x = i % width;
      const y = (i - x) / width;
      const push = (j) => {
        if (inM[j] && comp[j] === -1) { comp[j] = components; queue[qt++] = j; }
      };
      if (x > 0) push(i - 1);
      if (x < width - 1) push(i + 1);
      if (y > 0) push(i - width);
      if (y < height - 1) push(i + width);
    }
    components++;

    // Soft members are always debris (haze, fuzz, shadow wisps, soft fringe).
    for (const i of softMembers) { rgba[i * 4 + 3] = 0; removed++; }

    // Solid members: decide per SOLID SUB-COMPONENT (connected through solid
    // pixels only - a barcode stripe or label separates neighboring pockets).
    // Small solid clumps of backdrop color = pockets caught between product
    // parts (e.g. background showing between barcode stripes) -> sweep.
    // One huge solid blob = translucent product body (glass base showing the
    // table through itself) -> keep.
    const sComp = new Int32Array(solidMembers.length).fill(-1);
    const sIndex = new Map();
    for (let m = 0; m < solidMembers.length; m++) sIndex.set(solidMembers[m], m);
    for (let m = 0; m < solidMembers.length; m++) {
      if (sComp[m] !== -1) continue;
      // BFS over this solid sub-component
      let qh = 0, qt = 0;
      sComp[m] = m;
      queue[qt++] = solidMembers[m];
      const group = [];
      while (qh < qt) {
        const i = queue[qh++];
        group.push(i);
        const x = i % width;
        const y = (i - x) / width;
        const push = (j) => {
          const mj = sIndex.get(j);
          if (mj !== undefined && sComp[mj] === -1) { sComp[mj] = m; queue[qt++] = j; }
        };
        if (x > 0) push(i - 1);
        if (x < width - 1) push(i + 1);
        if (y > 0) push(i - width);
        if (y < height - 1) push(i + width);
      }
      if (group.length <= patchLimit) {
        for (const i of group) { rgba[i * 4 + 3] = 0; removed++; }
      } else {
        keptSolid += group.length;
      }
    }
  }

  return { removed, components, keptSolid, patchLimit, objArea };
}

/**
 * Color-correct the silhouette band: for semi-transparent pixels close to
 * full transparency, recover the true product color
 *     F = (C - (1 - a) * B) / a
 * where C is the stored (contaminated) color and B the estimated backdrop.
 * Interior pixels (glass translucency etc.) are never touched - only pixels
 * within `band` px of a transparent pixel.
 *
 * @returns {number} corrected pixel count
 */
export function defringeEdges(rgba, width, height, bg, { band = null, maxAlpha = 250 } = {}) {
  const { anchors, count } = bg;
  // band width scales with resolution (2 px at a 1536px-wide photo).
  const b = band ?? Math.min(6, Math.max(1, Math.round(Math.min(width, height) * 0.0015)));
  const band2max = maxAlpha;
  const candidates = [];
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3];
    if (a > 0 && a < band2max) candidates.push(i);
  }

  let changed = 0;
  for (const i of candidates) {
    const x = i % width;
    const y = (i - x) / width;
    let nearTransparent = false;
    const y0 = Math.max(0, y - b), y1 = Math.min(height - 1, y + b);
    const x0 = Math.max(0, x - b), x1 = Math.min(width - 1, x + b);
    for (let yy = y0; yy <= y1 && !nearTransparent; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        if (rgba[(yy * width + xx) * 4 + 3] < 8) { nearTransparent = true; break; }
      }
    }
    if (!nearTransparent) continue;

    const i4 = i * 4;
    const a = rgba[i4 + 3] / 255;
    const af = a * a; // straight unpremix explodes at tiny alpha; square-damp it
    const denom = Math.max(a, 0.25);
    // nearest anchor as backdrop estimate
    let bestK = 0;
    let bestD = Infinity;
    for (let k = 0; k < count; k++) {
      const o = k * 3;
      const dr = rgba[i4] - anchors[o], dg = rgba[i4 + 1] - anchors[o + 1], db = rgba[i4 + 2] - anchors[o + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; bestK = k; }
    }
    const o = bestK * 3;
    for (let c = 0; c < 3; c++) {
      const mixed = rgba[i4 + c];
      const b = anchors[o + c];
      // F = (C - (1-a)B) / a, damped: blend the estimate with C by af so
      // near-transparent pixels (where F is statistically noise) stay calm.
      const est = (mixed - (1 - a) * b) / denom;
      rgba[i4 + c] = Math.max(0, Math.min(255, Math.round(est * af + mixed * (1 - af))));
    }
    changed++;
  }
  return changed;
}

/**
 * Audit of the finished cutout, two metrics:
 *
 *   sides   - opaque background-like pixels on each side's outer frame ring.
 *             Zero on a side = that side is provably clean where it meets
 *             the canvas (top / left / bottom / right).
 *   haze    - silhouette fringe: semi-transparent pixels that hug full
 *             transparency and still look like the backdrop (the gray fuzz
 *             class). Zero = no visible background haze left anywhere along
 *             the silhouette, including mid-canvas spots like a barcode.
 *
 * @returns {{ top, left, bottom, right, haze }}
 */
export function auditEdges(rgba, width, height, bg, { tolHard = 30, tolSoft = 46, ring = null, minAlpha = 200 } = {}) {
  const { anchors, count } = bg;
  const hard2 = tolHard * tolHard;
  const soft2 = tolSoft * tolSoft;
  // Probe ring + haze search radius scale with resolution (2 px at 1536).
  const R = ring ?? Math.min(5, Math.max(1, Math.round(Math.min(width, height) * 0.00125)));
  const sideHit = (x, y) => {
    const i4 = (y * width + x) * 4;
    if (rgba[i4 + 3] < minAlpha) return 0;
    const d2 = nearestAnchorDist2(anchors, count, rgba[i4], rgba[i4 + 1], rgba[i4 + 2]);
    return d2 <= hard2 ? 1 : 0;
  };
  const res = { top: 0, left: 0, bottom: 0, right: 0, haze: 0 };
  for (let s = 0; s < R; s++) {
    for (let x = 0; x < width; x++) {
      res.top += sideHit(x, s);
      res.bottom += sideHit(x, height - 1 - s);
    }
    for (let y = 0; y < height; y++) {
      res.left += sideHit(s, y);
      res.right += sideHit(width - 1 - s, y);
    }
  }

  // silhouette haze: soft pixel adjacent to transparency, backdrop-colored
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i4 = (y * width + x) * 4;
      const a = rgba[i4 + 3];
      if (a < 10 || a >= 200) continue;
      let nearClear = false;
      for (let dy = -R; dy <= R && !nearClear; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < width && rgba[(yy * width + xx) * 4 + 3] < 10) { nearClear = true; break; }
        }
      }
      if (!nearClear) continue;
      const d2 = nearestAnchorDist2(anchors, count, rgba[i4], rgba[i4 + 1], rgba[i4 + 2]);
      if (d2 <= soft2) res.haze++;
    }
  }
  res.ring = R;
  return res;
}
