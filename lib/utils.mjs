export const IMG_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'avif', 'gif'];

const tty = process.stdout.isTTY && !process.env.NO_COLOR;

export const c = {
  dim: (s) => (tty ? `\x1b[2m${s}\x1b[0m` : String(s)),
  bold: (s) => (tty ? `\x1b[1m${s}\x1b[0m` : String(s)),
  green: (s) => (tty ? `\x1b[32m${s}\x1b[0m` : String(s)),
  yellow: (s) => (tty ? `\x1b[33m${s}\x1b[0m` : String(s)),
  red: (s) => (tty ? `\x1b[31m${s}\x1b[0m` : String(s)),
  cyan: (s) => (tty ? `\x1b[36m${s}\x1b[0m` : String(s)),
};

export function fmtBytes(n) {
  if (n == null || !Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtSeconds(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** Parse '#rgb' / '#rrggbb' / 'rrggbb' into {r,g,b}, or return null. */
export function parseHex(str) {
  if (typeof str !== 'string') return null;
  let s = str.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = [...s].map((ch) => ch + ch).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

export function hexOf({ r, g, b }) {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
