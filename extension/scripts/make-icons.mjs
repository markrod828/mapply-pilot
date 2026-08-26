// Generates ApplyPilot's toolbar icons: a paper plane leaving a briefcase, on a dark
// rounded square.
// 4x supersampled, written as RGBA PNGs with no external dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BG = [15, 23, 42];      // slate-900, matches the in-page panel
const WING = [56, 189, 248];  // sky-400, matches the panel's primary button
const FOLD = [2, 132, 199];   // sky-600, the underside the fold turns away from the light
const CASE = [148, 163, 184]; // slate-400, held back so the plane stays the first read
const SS = 4;                 // supersample factor

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
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

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour with alpha
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- shapes, in unit space so every size renders identically ---

function inRoundedBox(x, y, { x0, y0, x1, y1, r }) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r ** 2;
}

function inTriangle(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const sign = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = sign(x, y, ax, ay, bx, by);
  const d2 = sign(x, y, bx, by, cx, cy);
  const d3 = sign(x, y, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const PLATE = { x0: 0, y0: 0, x1: 1, y1: 1, r: 0.22 };

// The plane: the application being sent, and the flight the name promises. Two facets
// meet along NOSE-FOLD_MID so it reads as folded paper rather than a plain triangle.
const NOSE = [0.855, 0.11];
const TAIL_FAR = [0.1, 0.28];
const FOLD_MID = [0.36, 0.37];
const TAIL_NEAR = [0.3, 0.525];

// The briefcase: the job the plane is leaving. Handle boxes run past the body's top edge
// so their rounded lower corners are buried under it and the two read as one piece.
const CASE_BODY = { x0: 0.235, y0: 0.675, x1: 0.765, y1: 0.89, r: 0.048 };
const HANDLE_OUTER = { x0: 0.415, y0: 0.6, x1: 0.585, y1: 0.72, r: 0.045 };
const HANDLE_INNER = { x0: 0.467, y0: 0.652, x1: 0.533, y1: 0.75, r: 0.024 };

function sample(x, y) {
  if (!inRoundedBox(x, y, PLATE)) return null;
  if (inTriangle(x, y, NOSE, TAIL_FAR, FOLD_MID)) return WING;
  if (inTriangle(x, y, NOSE, FOLD_MID, TAIL_NEAR)) return FOLD;
  if (inRoundedBox(x, y, CASE_BODY)) return CASE;
  if (inRoundedBox(x, y, HANDLE_OUTER) && !inRoundedBox(x, y, HANDLE_INNER)) return CASE;
  return BG;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const colour = sample((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          hits += 1;
        }
      }
      const total = SS * SS;
      const offset = (py * size + px) * 4;
      if (hits === 0) continue;
      // Premultiplied average over covered samples, alpha = coverage.
      rgba[offset] = Math.round(r / hits);
      rgba[offset + 1] = Math.round(g / hits);
      rgba[offset + 2] = Math.round(b / hits);
      rgba[offset + 3] = Math.round((hits / total) * 255);
    }
  }
  return rgba;
}

// fileURLToPath, not .pathname: on Windows the latter hands back '/C:/…', which then
// resolves against the cwd and writes into a phantom 'C:\C:\…' directory.
const outDir = process.argv[2] ?? fileURLToPath(new URL('../public/icons', import.meta.url));
mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = `${outDir}/icon-${size}.png`;
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file}`);
}
