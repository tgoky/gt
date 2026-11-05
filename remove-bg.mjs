#!/usr/bin/env node
import { Command, InvalidArgumentError } from 'commander';
import { runBatch } from './lib/batch.mjs';

function num(min, max, integer = true) {
  return (value) => {
    const n = Number(value);
    if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min || n > max) {
      throw new InvalidArgumentError(`must be a number between ${min} and ${max}.`);
    }
    return n;
  };
}

const program = new Command();

program
  .name('remove-bg')
  .version('1.2.0')
  .description('Batch background remover -> transparent PNGs.\nEngines: AI segmentation (offline ONNX model) with chroma-key fallback.')
  .argument('[inputs...]', 'image files, folders or globs (jpg jpeg png webp tiff avif gif)')
  .option('-o, --out <dir>', 'output folder for the PNG cutouts', 'output')
  .option('-e, --engine <name>', 'ai | chroma | auto (auto = AI with chroma-key fallback)', 'auto')
  .option('-m, --model <name>', 'AI model: small | medium', 'medium')
  .option(
    '--no-bottom-boost',
    'skip the second bottom-crop AI pass. By default a second inference on the bottom\n'
      + 'of the image recovers translucent parts the first pass cuts off (glass vial bases,\n'
      + 'clear lids...). Disable to speed up non-product shots.'
  )
  .option(
    '--reuse-mask',
    'run AI on the first image only and reuse its alpha mask for the rest. For groups of\n'
      + 'near-identical shots that differ only in label text - turns an 8-image batch into ~1 AI run.',
    false
  )
  .option(
    '--edge <mode>',
    "edge cleanup: clean (default; kill background fringe in the silhouette band) |\n"
      + 'hard (near-binary edge) | soft (raw model output, may show background fringe)',
    'clean'
  )
  .option(
    '--no-sweep',
    'skip the all-sides background sweep. By default the tool estimates the backdrop from\n'
      + 'the photo\u0027s border frame and flood-cleans every reachable background pixel from ALL\n'
      + 'four sides (top/left/bottom/right), then audits each side and prints `edges T\u2713 L\u2713 B\u2713 R\u2713`.'
  )
  .option(
    '--sweep-tol <n>',
    'background-match strictness for the sweep, 10-80. Lower = only near-exact backdrop\n'
      + 'colors are swept; higher = more aggressive (raise for busy/textured backdrops).',
    num(10, 80),
    46
  )
  .option('-k, --key <hex>', 'chroma-key color, e.g. #ffffff (default: auto-detect from image edges)')
  .option('-t, --tolerance <n>', 'chroma-key tolerance, 1-100', num(1, 100), 25)
  .option('--feather <px>', 'chroma-key edge feather in px, 0-10', num(0, 10, false), 1.5)
  .option('-c, --concurrency <n>', 'how many files to process in parallel', num(1, 16), 2)
  .option('--recursive', 'recurse into subfolders', false)
  .option('--skip-existing', 'skip images whose output PNG already exists', false)
  .option('--save-mask', 'also write <name>_mask.png (grayscale alpha matte)', false)
  .option('--dry-run', 'list the matched images and exit', false)
  .addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  node remove-bg.mjs product.jpeg',
      '  node remove-bg.mjs shots/ -o cutouts/',
      '  node remove-bg.mjs shots/*.jpg --reuse-mask',
      '  node remove-bg.mjs "shots/*.jpg" -e chroma -k "#ffffff" -t 20',
      '  node remove-bg.mjs people/ --no-bottom-boost --edge soft',
      '  node remove-bg.mjs busy-bg/ --sweep-tol 60   # aggressive sweep for textured backdrops',
      '',
    ].join('\n')
  )
  .parseAsync();

try {
  await runBatch(program.args, program.opts());
} catch (err) {
  console.error(`\x1b[31merror:\x1b[0m ${err?.message ?? err}`);
  process.exitCode = 1;
}
