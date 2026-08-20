#!/usr/bin/env node
/**
 * Renders the app icon to PNG at the sizes a Home Screen install needs.
 *
 * iOS will not use an SVG favicon for `apple-touch-icon`, and a PWA manifest
 * wants real raster icons, so the mark from index.html is rasterised here
 * rather than committed as binary blobs. Encoding is done by hand against
 * node:zlib: an icon this simple does not justify an image dependency.
 */
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import path from 'node:path';

const BG = [0x0b, 0x0d, 0x10];
const FG = [0x64, 0xd2, 0xa3];

/** The mark from index.html, in the same 32x32 viewBox. */
const STROKES = [
  [
    [7, 10],
    [13, 16],
  ],
  [
    [13, 16],
    [7, 22],
  ],
  [
    [17, 22],
    [25, 22],
  ],
];
const STROKE_WIDTH = 2.5;

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideRoundedRect(x, y, size, radius) {
  const near = (v) => Math.min(v, size - v);
  const cx = near(x);
  const cy = near(y);
  if (cx > radius || cy > radius) return cx >= 0 && cy >= 0;
  return Math.hypot(radius - cx, radius - cy) <= radius;
}

/**
 * 3x3 supersampling per pixel. Coverage of the glyph and of the (optionally
 * rounded) tile are computed separately so the mark antialiases against the
 * background rather than against transparency.
 */
function renderRGBA(size, { rounded, glyphScale }) {
  const pixels = Buffer.alloc(size * size * 4);
  const unit = size / 32;
  const radius = rounded ? 7 * unit : 0;
  const halfWidth = (STROKE_WIDTH / 2) * unit * glyphScale;
  const samples = 3;
  const centre = size / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let tileHits = 0;
      let glyphHits = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          if (!rounded || insideRoundedRect(px, py, size, radius)) tileHits += 1;

          // Scale the glyph about the centre so a maskable icon keeps its safe zone.
          const gx = (centre + (px - centre) / glyphScale) / unit;
          const gy = (centre + (py - centre) / glyphScale) / unit;
          for (const [a, b] of STROKES) {
            if (distanceToSegment(gx * unit, gy * unit, [a[0] * unit, a[1] * unit], [b[0] * unit, b[1] * unit]) <= halfWidth / glyphScale) {
              glyphHits += 1;
              break;
            }
          }
        }
      }

      const total = samples * samples;
      const tile = tileHits / total;
      const glyph = Math.min(glyphHits / total, tile);
      const offset = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        // Composite glyph over background, then the whole tile over transparency.
        const blended = BG[channel] * (1 - glyph) + FG[channel] * glyph;
        pixels[offset + channel] = Math.round(blended);
      }
      pixels[offset + 3] = Math.round(tile * 255);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePNG(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One scanline per row, each prefixed with filter type 0 (None).
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const VARIANTS = [
  { file: 'icon-192.png', size: 192, rounded: true, glyphScale: 1 },
  { file: 'icon-512.png', size: 512, rounded: true, glyphScale: 1 },
  // Maskable icons get cropped to a circle, so keep the mark inside the safe zone.
  { file: 'icon-maskable-512.png', size: 512, rounded: false, glyphScale: 0.72 },
  // iOS applies its own corner mask and dislikes transparency: full bleed square.
  { file: 'apple-touch-icon.png', size: 180, rounded: false, glyphScale: 0.88 },
];

export async function generateIcons(outDir) {
  await fs.mkdir(outDir, { recursive: true });
  for (const variant of VARIANTS) {
    const rgba = renderRGBA(variant.size, variant);
    await fs.writeFile(path.join(outDir, variant.file), encodePNG(variant.size, rgba));
  }
  return VARIANTS.map((v) => v.file);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2] ?? 'dist/web/icons';
  const files = await generateIcons(path.resolve(target));
  console.log(`icons: wrote ${files.join(', ')} to ${target}`);
}
