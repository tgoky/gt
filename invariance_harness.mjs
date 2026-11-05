// Scale/color invariance harness.
//
// For every fixture in test-inv/<name>/ (photo.png + cutout-in.png with
// known debris on all four sides) run the sweep pipeline and PROVE:
//   1. the fixture actually has residue  (BEFORE audit nonzero)
//   2. after sweep: all four sides clean + haze gone
//   3. the product core was not eaten   (solid area shrink < 1.5%)
// PASS/FAIL per fixture, non-zero exit on any failure.
import sharp from 'sharp';
import fs from 'node:fs/promises';
import { estimateAnchors, sweepBackground, defringeEdges, auditEdges } from './lib/sweep.mjs';

const ROOT = './test-inv';
const variants = (await fs.readdir(ROOT)).filter((d) => !d.startsWith('.'));

let failures = 0;
const rows = [];

for (const name of variants) {
  const photo = await sharp(`${ROOT}/${name}/photo.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = await sharp(`${ROOT}/${name}/cutout-in.png`).raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const bg = estimateAnchors(photo.data, W, H);

  const before = auditEdges(data, W, H, bg);

  // product core = central window that contains only genuine product pixels
  const cx0 = Math.round(W * 0.38), cx1 = Math.round(W * 0.62);
  const cy0 = Math.round(H * 0.30), cy1 = Math.round(H * 0.70);
  const coreBefore = (() => {
    let n = 0;
    for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) if (data[(y * W + x) * 4 + 3] >= 200) n++;
    return n;
  })();

  const out = new Uint8Array(data);
  const res = sweepBackground(out, W, H, bg);
  const defr = defringeEdges(out, W, H, bg);
  const after = auditEdges(out, W, H, bg);

  let coreAfter = 0;
  for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) if (out[(y * W + x) * 4 + 3] >= 200) coreAfter++;
  const shrink = 1 - coreAfter / Math.max(1, coreBefore);

  const sideOk = after.top === 0 && after.left === 0 && after.bottom === 0 && after.right === 0;
  const beforeDirty = before.top + before.left + before.bottom + before.right > 0 || before.haze > 50;
  // haze allowance must scale with resolution (6 ppm of the canvas)
  const hazeLimit = Math.max(5, Math.round(W * H * 0.000006));
  const hazeOk = after.haze <= hazeLimit;
  const coreOk = shrink < 0.015;
  const ok = sideOk && beforeDirty && hazeOk && coreOk;
  if (!ok) failures++;

  rows.push({
    name, size: `${W}x${H}`, anchors: bg.count,
    before: `T${before.top} L${before.left} B${before.bottom} R${before.right} hz${before.haze}`,
    after: `T${after.top} L${after.left} B${after.bottom} R${after.right} hz${after.haze}`,
    swept: res.removed, keptSolid: res.keptSolid,
    patchLimit: res.patchLimit, objArea: res.objArea,
    normSwept: (res.removed / (W * H) * 100).toFixed(2) + '%',
    coreShrink: (shrink * 100).toFixed(2) + '%',
    defringed: defr, verdict: ok ? 'PASS' : 'FAIL',
  });
}

for (const r of rows) {
  console.log(
    `${r.verdict === 'PASS' ? '✔' : '✖'} ${r.name.padEnd(8)} ${r.size.padEnd(10)} anchors=${r.anchors} `
    + `before[${r.before}] after[${r.after}] swept=${r.swept} (${r.normSwept}) keptSolid=${r.keptSolid} `
    + `patchLimit=${r.patchLimit} obj=${r.objArea} coreShrink=${r.coreShrink} defr=${r.defringed}`
  );
}
console.log(failures === 0 ? '\nALL INVARIANCE TESTS PASS' : `\n${failures} INVARIANCE TEST(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
