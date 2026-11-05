import zlib from 'node:zlib';

// Minimal, dependency-free PNG encoder (8-bit RGBA, Sub filter).
// Used for the FINAL output encode: sharp lazily re-reads its input buffer
// during async encoding, which made late buffer mutations (and other
// native-layer quirks around the AI engine's memory) silently drop
// post-processed alpha values. This encoder consumes a private copy of the
// pixels synchronously - what you pass is what gets written.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4, 0);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encode raw RGBA pixels (Uint8Array/Buffer, width*height*4 bytes) as PNG.
 * @returns {Buffer}
 */
export function encodePng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter: adaptive
  ihdr[12] = 0; // interlace: none

  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    filtered[y * (stride + 1)] = 1; // Sub filter
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[row + x - 4] : 0;
      filtered[y * (stride + 1) + 1 + x] = (rgba[row + x] - left) & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // signature
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(filtered, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
