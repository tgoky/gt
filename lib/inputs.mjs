import { stat } from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import { IMG_EXTS } from './utils.mjs';

/**
 * Expand CLI inputs (files, directories, globs) into a deduplicated,
 * sorted list of image files.
 */
export async function collectInputs(args, { recursive = false } = {}) {
  const found = new Set();
  const exts = new Set(IMG_EXTS);

  for (const arg of args) {
    let st = null;
    try {
      st = await stat(arg);
    } catch {
      st = null;
    }

    if (st?.isDirectory()) {
      const base = arg.replace(/[\\/]+$/, '');
      const pattern = recursive ? `${base}/**/*` : `${base}/*`;
      const matches = await fg(pattern, { onlyFiles: true, dot: false, caseSensitiveMatch: false });
      matches.forEach((f) => found.add(path.resolve(f)));
    } else if (st?.isFile()) {
      found.add(path.resolve(arg));
    } else {
      // Not an existing path -> treat as a glob pattern
      const matches = await fg(arg, { onlyFiles: true, dot: false });
      matches.forEach((f) => found.add(path.resolve(f)));
    }
  }

  return [...found]
    .filter((f) => exts.has(path.extname(f).slice(1).toLowerCase()))
    .sort();
}
