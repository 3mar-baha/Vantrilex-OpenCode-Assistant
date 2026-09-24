// Generate Voxaura PNG icons with zero dependencies (raw zlib PNG writer).
// Source: 256px obsidian rounded square, graphite ring, ivory ring, emerald
// core, purple ticks — the Crest geometry rasterized by pixel math.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons');
mkdirSync(root, { recursive: true });

function crc32(buf) {
  let table = crc32.table;
  if (table === undefined) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const dot = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
  };
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      // Obsidian base.
      dot(x, y, 0x14, 0x14, 0x13, 255);
      // Graphite ring.
      if (Math.abs(d - R * 0.92) < size / 48) dot(x, y, 0x38, 0x35, 0x30, 255);
      // Ivory ring.
      if (Math.abs(d - R * 0.38) < size / 64) dot(x, y, 0xe7, 0xe5, 0xe4, 255);
      // Emerald core.
      if (d < R * 0.15) dot(x, y, 0x10, 0xb9, 0x81, 255);
      // Purple cardinal ticks.
      const tick = Math.abs(dx) < size / 96 || Math.abs(dy) < size / 96;
      if (tick && d > R * 0.55 && d < R * 0.8) dot(x, y, 0x8b, 0x5c, 0xf6, 255);
    }
  }
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    raw[y * (1 + size * 4)] = 0;
    px.copy(raw, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [32, 128, 256]) {
  const path = join(root, `${size}x${size}.png`);
  writeFileSync(path, render(size));
  console.log(`wrote ${path}`);
}
