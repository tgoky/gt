// Torture harness: run the all-sides sweep on the injected-debris cutout.
// Prints audits for (a) untouched input = negative control, (b) swept output.
import sharp from 'sharp';
import { estimateAnchors, sweepBackground, defringeEdges, auditEdges } from './lib/sweep.mjs';
import { encodePng } from './lib/png.mjs';
import fs from 'node:fs/promises';

const DIR = './test-torture';

const photo = await sharp(`${DIR}/photo.png`).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const bg = estimateAnchors(photo.data, photo.info.width, photo.info.height);
console.log(`anchors: ${bg.count}`);

const { data, info } = await sharp(`${DIR}/cutout-in.png`).raw().toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;

// (a) negative control: audit WITHOUT sweep
const auditBefore = auditEdges(data, W, H, bg, { tolSoft: 46, tolHard: 30 });
console.log('BEFORE sweep:', JSON.stringify(auditBefore));

// (b) run sweep + defringe on a copy
const out = new Uint8Array(data);
const t0 = performance.now();
const res = sweepBackground(out, W, H, bg, { tolSoft: 46, tolHard: 30 });
const defr = defringeEdges(out, W, H, bg);
const ms = (performance.now() - t0).toFixed(0);
const auditAfter = auditEdges(out, W, H, bg, { tolSoft: 46, tolHard: 30 });
console.log(`AFTER  sweep: swept=${res.removed} components=${res.components} keptSolid=${res.keptSolid} defringed=${defr} in ${ms}ms`);
console.log('AFTER audit :', JSON.stringify(auditAfter));

await fs.writeFile(`${DIR}/cutout-swept.png`, encodePng(Buffer.from(out), W, H));
console.log('wrote', `${DIR}/cutout-swept.png`);
