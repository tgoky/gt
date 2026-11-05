import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { collectInputs } from './inputs.mjs';
import { aiRemove, alphaOf } from './ai.mjs';
import { chromaRemove } from './chroma.mjs';
import { encodePng } from './png.mjs';
import { estimateAnchors, sweepBackground, defringeEdges, auditEdges } from './sweep.mjs';
import { c, fmtBytes, fmtSeconds, parseHex, hexOf } from './utils.mjs';

const ENGINES = ['ai', 'chroma', 'auto'];
const MODELS = ['small', 'medium'];
const EDGE_MODES = ['clean', 'hard', 'soft'];

function fail(msg) {
  console.error(c.red(`error: ${msg}`));
  process.exitCode = 1;
}

/** Build collision-safe output paths (a.jpg + a.png -> a.png + a-1.png). */
function planOutputs(files, outDir, skipExisting) {
  const used = new Set();
  return files.map((file) => {
    const base = path.basename(file, path.extname(file));
    let name = `${base}.png`;
    let n = 1;
    while (used.has(name.toLowerCase())) name = `${base}-${n++}.png`;
    used.add(name.toLowerCase());
    const out = path.join(outDir, name);
    return { file, out, name, skip: skipExisting && existsSync(out) };
  });
}

async function resizeMask(mask, width, height, toWidth, toHeight) {
  // Channel-safe: sharp may promote 1-channel raw to 3 channels, so verify
  // the returned channel count and always take band 0.
  const { data: buf, info } = await sharp(Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength), {
    raw: { width, height, channels: 1 },
  })
    .resize(toWidth, toHeight, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels || 1;
  const out = new Uint8Array(toWidth * toHeight);
  for (let i = 0; i < out.length; i++) out[i] = buf[i * ch];
  return out;
}

/** Apply a stored alpha mask (from the reference shot) to another image. */
async function applyMask(inputBuffer, maskState) {
  const meta = await sharp(inputBuffer).metadata();
  const swapped = meta.orientation >= 5; // 90deg rotations swap w/h
  const width = swapped ? meta.height : meta.width;
  const height = swapped ? meta.width : meta.height;

  const sameSize = width === maskState.width && height === maskState.height;
  const mask = sameSize
    ? maskState.data
    : await resizeMask(maskState.data, maskState.width, maskState.height, width, height);

  const { data } = await sharp(inputBuffer)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 3] = Math.min(data[i * 4 + 3], mask[i]);
  }
  return { data, width, height };
}

/**
 * All-sides background guarantee: estimate the backdrop from the original
 * photo's border frame, flood-sweep every reachable background-like pixel
 * from all four sides, decontaminate edge colors, then audit each side.
 * Runs after ANY engine - the audit result is printed per file so every
 * batch run proves `T✓ L✓ B✓ R✓`.
 */
async function sweepAndAudit(buf, result, opts) {
  const { width, height } = result;
  const { data: raw, info } = await sharp(buf)
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== width || info.height !== height || raw.length !== width * height * 3) {
    return null; // dimension mismatch (should not happen) - skip silently
  }
  const bg = estimateAnchors(raw, width, height);
  const tolSoft = Number(opts.sweepTol) || 46;
  const tolHard = Math.round(tolSoft * 0.65);
  const { removed } = sweepBackground(result.data, width, height, bg, { tolSoft, tolHard });
  const defringed = defringeEdges(result.data, width, height, bg);
  const audit = auditEdges(result.data, width, height, bg, { tolSoft, tolHard });
  return { removed, defringed, audit };
}

/** `edges T✓ L✓ B✓ R✓ · haze Npx` summary colored by verdict. */
function fmtEdges(audit) {
  if (!audit) return '';
  const part = (label, n) => (n === 0 ? c.green(`${label}✓`) : c.red(`${label}✗(${n})`));
  const haze = audit.haze > 50 ? c.red(` · haze ${audit.haze}px`) : c.green(' · haze 0px');
  return ` edges ${part('T', audit.top)} ${part('L', audit.left)} ${part('B', audit.bottom)} ${part('R', audit.right)}${haze}`;
}

async function processJob(job, opts, state) {
  const t0 = performance.now();
  const buf = await fs.readFile(job.file);
  let result;
  let engineUsed = opts.engine;

  const runAi = async () => {
    if (opts.reuseMask && state.mask) {
      const res = await applyMask(buf, state.mask);
      res.engine = 'mask';
      return res;
    }
    const res = await aiRemove(buf, { model: opts.model, bottomBoost: opts.bottomBoost, edge: opts.edge }, state.onModelProgress);
    if (opts.reuseMask && !state.mask) {
      state.mask = { data: alphaOf(res.data, res.width, res.height), width: res.width, height: res.height };
    }
    return res;
  };

  if (opts.engine === 'chroma') {
    result = await chromaRemove(buf, opts.chroma);
    result.engine = 'chroma';
  } else if (opts.engine === 'ai') {
    result = await runAi();
  } else {
    // auto: AI first, chroma-key as fallback
    try {
      result = await runAi();
    } catch (err) {
      console.warn(c.yellow(`  ! ${job.name}: AI engine failed (${err.message}); falling back to chroma-key`));
      result = await chromaRemove(buf, opts.chroma);
      engineUsed = 'auto->chroma';
    }
  }

  const engineTag = result.engine ?? engineUsed;

  // All-sides sweep + per-side proof (AI, mask-reuse and chroma alike).
  let sweepInfo = null;
  if (opts.sweep !== false) {
    try {
      sweepInfo = await sweepAndAudit(buf, result, opts);
    } catch (err) {
      console.warn(c.yellow(`  ! ${job.name}: edge sweep skipped (${err.message})`));
    }
  }

  if (opts.saveMask) {
    const alpha = Buffer.from(alphaOf(result.data, result.width, result.height));
    const maskPath = job.out.replace(/\.png$/i, '') + '_mask.png';
    await sharp(alpha, { raw: { width: result.width, height: result.height, channels: 1 } })
      .png()
      .toFile(maskPath);
  }

  // Encode from a private copy with the pure-JS encoder: sharp lazily
  // re-reads its input during async encode, which silently dropped alpha
  // post-processing done after the AI inference (native-layer memory sharing).
  const outBuffer = Buffer.from(result.data); // content copy, not a view
  await fs.writeFile(job.out, encodePng(outBuffer, result.width, result.height));

  const outStat = await fs.stat(job.out);
  const ms = performance.now() - t0;
  const sweepNote = sweepInfo && sweepInfo.removed > 0
    ? c.dim(` · swept ${sweepInfo.removed}px${sweepInfo.defringed ? ` · defringed ${sweepInfo.defringed}px` : ''}`)
    : '';
  return { ok: true, engine: engineTag, ms, bytes: outStat.size, keyColor: result.keyColor, sweepNote, edges: fmtEdges(sweepInfo?.audit) };
}

export async function runBatch(inputs, opts) {
  // ---- validate options -------------------------------------------------
  if (!inputs.length) return fail('no input given. Pass image files, a folder or a glob.');
  if (!ENGINES.includes(opts.engine)) return fail(`unknown engine "${opts.engine}" (use: ${ENGINES.join(', ')})`);
  if (!MODELS.includes(opts.model)) return fail(`unknown model "${opts.model}" (use: ${MODELS.join(', ')})`);
  if (!EDGE_MODES.includes(opts.edge)) return fail(`unknown --edge mode "${opts.edge}" (use: ${EDGE_MODES.join(', ')})`);

  const chroma = {
    key: opts.key ? parseHex(opts.key) : null,
    tolerance: Number(opts.tolerance),
    feather: Number(opts.feather),
  };
  if (opts.key && !chroma.key) return fail(`invalid --key "${opts.key}" (use hex like #ffffff)`);

  let concurrency = Math.max(1, Math.floor(Number(opts.concurrency) || 2));
  if (opts.reuseMask && concurrency > 1) {
    concurrency = 1; // later images depend on the mask of the first one
    console.log(c.dim('reuse-mask: processing sequentially (each image uses the first image mask)'));
  }

  const files = await collectInputs(inputs, { recursive: opts.recursive });
  if (!files.length) return fail('no images matched the given inputs (jpg jpeg png webp tiff avif gif).');

  console.log(c.bold(`Found ${files.length} image${files.length === 1 ? '' : 's'} · engine: ${opts.engine} · model: ${opts.model} · edge: ${opts.edge}`));

  if (opts.dryRun) {
    for (const f of files) console.log(`  ${path.relative(process.cwd(), f) || f}`);
    return;
  }

  await fs.mkdir(opts.out, { recursive: true });
  const jobs = planOutputs(files, opts.out, opts.skipExisting);

  // ---- model progress (shown once while assets stream in) ---------------
  let modelLine = false;
  const onModelProgress = (key, current, total) => {
    if (key.startsWith('fetch:') && total > 1e6) {
      modelLine = true;
      process.stdout.write(`\r  ${c.dim('loading model assets')} ${Math.round((current / total) * 100)}%  `);
      if (current >= total) {
        process.stdout.write('\n');
        modelLine = false;
      }
    }
  };

  const state = { mask: null, onModelProgress };
  const t0 = performance.now();
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let index = 0;

  const worker = async () => {
    while (index < jobs.length) {
      const job = jobs[index++];
      const label = c.bold(`[${index}/${jobs.length}]`) + ` ${path.basename(job.file)}`;
      if (job.skip) {
        skipped++;
        console.log(`${c.yellow('→')} ${label} ${c.dim('skipped (output exists)')}`);
        continue;
      }
      try {
        const r = await processJob(job, opts, state);
        ok++;
        const extra = r.keyColor ? c.dim(` key=${r.keyColor}`) : '';
        console.log(
          `${c.green('✔')} ${label} ${c.dim(`${r.engine} · ${fmtSeconds(r.ms)} · ${fmtBytes(r.bytes)}${extra}`)}${r.sweepNote}${r.edges} → ${path.join(opts.out, job.name)}`
        );
      } catch (err) {
        failed++;
        console.error(`${c.red('✖')} ${label} ${c.red(err.message)}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

  const total = fmtSeconds(performance.now() - t0);
  const bits = [c.green(`${ok} done`)];
  if (failed) bits.push(c.red(`${failed} failed`));
  if (skipped) bits.push(c.yellow(`${skipped} skipped`));
  console.log(c.bold(`\n${bits.join(', ')} in ${total} → ${path.resolve(opts.out)}`));
  if (failed) process.exitCode = 1;
}
