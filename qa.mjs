// QA helper: audit cutouts and build magenta composites for visual checks.
//
// Usage:
//   node qa.mjs <cutout.png> [more.png ...]                    structural audit
//   node qa.mjs <cutout.png> --photo <original.jpeg>           full per-side audit
//
// With --photo the tool estimates the backdrop from the original photo's
// border frame and reports the SAME per-side proof the CLI prints:
//   edges T✓ L✓ B✓ R✓ · haze Npx
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs/promises';
import { estimateAnchors, auditEdges } from './lib/sweep.mjs';
import { c } from './lib/utils.mjs';

const outDir = '/home/z/my-project/scripts/bg-remover/qa';
await fs.mkdir(outDir, { recursive: true });

const args = process.argv.slice(2);
let photoPath = null;
const photoIdx = args.indexOf('--photo');
if (photoIdx !== -1) {
  photoPath = args[photoIdx + 1];
  args.splice(photoIdx, 2);
}

let bg = null;
if (photoPath) {
  const raw = await sharp(photoPath).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  bg = { anchors: null, raw: raw.data, width: raw.info.width, height: raw.info.height };
}

for (const file of args) {
  const img = sharp(file);
  const meta = await img.metadata();
  const stats = await img.stats();
  const alpha = stats.channels[3] ?? null;
  console.log(
    `${path.basename(file)}: ${meta.width}x${meta.height} ch=${meta.channels} format=${meta.format}`
      + (alpha ? ` alpha[min=${alpha.min} max=${alpha.max} mean=${alpha.mean.toFixed(1)} stdev=${alpha.stdev.toFixed(1)}]` : ' (no alpha)')
  );

  // Count fully transparent / opaque pixels
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  let transparent = 0, opaque = 0, partial = 0;
  const n = info.width * info.height;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    if (a === 0) transparent++;
    else if (a === 255) opaque++;
    else partial++;
  }
  console.log(
    `  pixels: transparent=${(100 * transparent / n).toFixed(1)}% opaque=${(100 * opaque / n).toFixed(1)}% partial=${(100 * partial / n).toFixed(1)}%`
  );

  // ---- per-side audit -----------------------------------------------------
  if (info.channels < 4) {
    console.log('  edges: (no alpha channel - not a cutout)');
  } else if (bg && bg.width === info.width && bg.height === info.height) {
    const anchors = estimateAnchors(bg.raw, bg.width, bg.height);
    const audit = auditEdges(data, info.width, info.height, anchors, { tolSoft: 46, tolHard: 30 });
    const part = (l, v) => (v === 0 ? c.green(`${l}✓`) : c.red(`${l}✗(${v})`));
    const haze = audit.haze > 50 ? c.red(`haze ${audit.haze}px`) : c.green('haze 0px');
    console.log(`  edges ${part('T', audit.top)} ${part('L', audit.left)} ${part('B', audit.bottom)} ${part('R', audit.right)} · ${haze}`);
  } else {
    // structural fallback: opaque pixels touching the canvas frame
    const ringHit = (x, y) => (data[(y * info.width + x) * 4 + 3] >= 200 ? 1 : 0);
    let top = 0, bottom = 0, left = 0, right = 0;
    for (let x = 0; x < info.width; x++) { top += ringHit(x, 0); bottom += ringHit(x, info.height - 1); }
    for (let y = 0; y < info.height; y++) { left += ringHit(0, y); right += ringHit(info.width - 1, y); }
    const part = (l, v) => (v === 0 ? c.green(`${l}✓`) : c.yellow(`${l}?(${v})`));
    console.log(`  edges ${part('T', top)} ${part('L', left)} ${part('B', bottom)} ${part('R', right)} ${c.dim('(structural only - pass --photo <original> for the full audit)')}`);
  }

  const base = path.basename(file, path.extname(file));
  await sharp(file)
    .resize(360, null, { withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 0, b: 255 } })
    .jpeg({ quality: 82 })
    .toFile(path.join(outDir, `qa_${base}.jpg`));
}
console.log(`QA composites in ${outDir}`);
