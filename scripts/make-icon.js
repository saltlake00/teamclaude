#!/usr/bin/env node
// Builds assets/teamclaude.ico (16/24/32/48/64/256): a #3b4cca rounded square
// with a white six-arm asterisk, the same shape as the dashboard favicon
// (src/dashboard.js FAVICON — keep the two in sync). Node built-ins only: the
// shapes are simple enough to rasterize from distance functions, so no SVG
// renderer is needed.
//
//   node scripts/make-icon.js                 write assets/teamclaude.ico
//   node scripts/make-icon.js --preview <dir> also write per-size PNGs and a
//                                             comparison sheet of every variant
//
// The output is deterministic; test/icon.test.js checks that the committed
// .ico still matches what this script produces.

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ICON_SIZES = [16, 24, 32, 48, 64, 256];
const DEFAULT_FG = [0xff, 0xff, 0xff];

// Every variant is drawn in the favicon's 32-unit design space.
const line = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

export const VARIANTS = {
  // Current icon. Six arms stay legible at 16 px, where the old eight-arm
  // star merged into a blob; small sizes get a heavier stroke.
  six: {
    label: 'six',
    bg: [0x3b, 0x4c, 0xca],
    radius: 8,
    stroke: 3.6,
    smallStroke: 4.2,
    lines: [line(16, 6, 16, 26), line(7.34, 11, 24.66, 21), line(7.34, 21, 24.66, 11)],
  },
  // The dashboard favicon before 2026-10-14, kept for --preview comparison.
  favicon: {
    label: 'old favicon',
    bg: [0xc9, 0x64, 0x42],
    radius: 8,
    stroke: 3,
    lines: [line(16, 6, 16, 26), line(6, 16, 26, 16), line(9, 9, 23, 23), line(23, 9, 9, 23)],
  },
};

export const DEFAULT_VARIANT = 'six';

function segmentDistance(px, py, { x1, y1, x2, y2 }) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (x1 + vx * t), py - (y1 + vy * t));
}

function insideRoundedSquare(px, py, r) {
  const qx = Math.abs(px - 16) - (16 - r);
  const qy = Math.abs(py - 16) - (16 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r <= 0;
}

/** Render one variant at `size` px. Returns RGBA bytes (straight alpha). */
export function renderIcon(variant, size) {
  const spec = typeof variant === 'string' ? VARIANTS[variant] : variant;
  if (!spec) throw new Error(`unknown icon variant: ${variant}`);
  const stroke = size <= 24 && spec.smallStroke ? spec.smallStroke : spec.stroke;
  const BG = spec.bg;
  const FG = spec.fg ?? DEFAULT_FG;
  const half = stroke / 2;
  const ss = 8; // 8x8 supersampling per pixel
  const scale = 32 / size;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = (x + (sx + 0.5) / ss) * scale;
          const py = (y + (sy + 0.5) / ss) * scale;
          if (!insideRoundedSquare(px, py, spec.radius)) continue;
          bg++;
          if (spec.lines.some(l => segmentDistance(px, py, l) <= half)) fg++;
        }
      }
      const i = (y * size + x) * 4;
      if (bg === 0) continue;
      const mix = fg / bg;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(BG[c] + (FG[c] - BG[c]) * mix);
      out[i + 3] = Math.round((bg / (ss * ss)) * 255);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode straight-alpha RGBA as a PNG. */
export function encodePng(rgba, width, height = width) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Classic 32-bit DIB for the small entries (every Windows consumer reads it);
// the 256 px entry is PNG, as Windows itself ships it.
function encodeDib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // XOR + AND masks
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y; // bottom-up
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = (row * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

/** Build the multi-size .ico for a variant. */
export function buildIco(variant = DEFAULT_VARIANT, sizes = ICON_SIZES) {
  const images = sizes.map(size => {
    const rgba = renderIcon(variant, size);
    return { size, data: size >= 256 ? encodePng(rgba, size) : encodeDib(rgba, size) };
  });
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach(({ size, data }, i) => {
    const e = i * 16;
    dir[e] = size >= 256 ? 0 : size;
    dir[e + 1] = size >= 256 ? 0 : size;
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bits per pixel
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, dir, ...images.map(img => img.data)]);
}

// Comparison sheet: one row per variant, every size at 1x on a light and a
// dark strip, plus 16/24/32 magnified 6x (nearest neighbour) to judge pixels.
export function buildSheet(variantNames) {
  const zoom = 6;
  const zoomed = [16, 24, 32];
  const pad = 16;
  const rowH = Math.max(256, 32 * zoom) + pad * 2;
  const oneX = ICON_SIZES.reduce((w, s) => w + s + pad, pad);
  const zoomW = zoomed.reduce((w, s) => w + s * zoom + pad, 0);
  const width = oneX + zoomW;
  const height = rowH * variantNames.length * 2;
  const img = Buffer.alloc(width * height * 4);
  const fill = (x0, y0, w, h, rgb) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * width + x) * 4;
        img[i] = rgb[0]; img[i + 1] = rgb[1]; img[i + 2] = rgb[2]; img[i + 3] = 255;
      }
    }
  };
  const blit = (rgba, size, x0, y0, z) => {
    for (let y = 0; y < size * z; y++) {
      for (let x = 0; x < size * z; x++) {
        const s = (Math.floor(y / z) * size + Math.floor(x / z)) * 4;
        const d = ((y0 + y) * width + x0 + x) * 4;
        const a = rgba[s + 3] / 255;
        for (let c = 0; c < 3; c++) img[d + c] = Math.round(rgba[s + c] * a + img[d + c] * (1 - a));
      }
    }
  };
  variantNames.forEach((name, v) => {
    [[0xf4, 0xf4, 0xf2], [0x20, 0x20, 0x22]].forEach((bgColor, shade) => {
      const top = (v * 2 + shade) * rowH;
      fill(0, top, width, rowH, bgColor);
      let x = pad;
      for (const size of ICON_SIZES) {
        blit(renderIcon(name, size), size, x, top + pad, 1);
        x += size + pad;
      }
      for (const size of zoomed) {
        blit(renderIcon(name, size), size, x, top + pad, zoom);
        x += size * zoom + pad;
      }
    });
  });
  return encodePng(img, width, height);
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const variant = argv.includes('--variant') ? argv[argv.indexOf('--variant') + 1] : DEFAULT_VARIANT;
  const icoPath = join(root, 'assets', 'teamclaude.ico');
  mkdirSync(dirname(icoPath), { recursive: true });
  writeFileSync(icoPath, buildIco(variant));
  console.log(`wrote ${icoPath} (${variant})`);
  const previewIdx = argv.indexOf('--preview');
  if (previewIdx !== -1) {
    const dir = argv[previewIdx + 1];
    mkdirSync(dir, { recursive: true });
    for (const name of Object.keys(VARIANTS)) {
      for (const size of ICON_SIZES) {
        writeFileSync(join(dir, `${name}-${size}.png`), encodePng(renderIcon(name, size), size));
      }
    }
    writeFileSync(join(dir, 'sheet.png'), buildSheet(Object.keys(VARIANTS)));
    console.log(`wrote previews to ${dir}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
