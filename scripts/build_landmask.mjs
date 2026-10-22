#!/usr/bin/env node
/**
 * Rasterises the Natural Earth land polygons into one equirectangular RGBA
 * tile: land tinted, sea fully transparent.
 *
 * Why a texture rather than polygon geometry: this layer only has to answer
 * "which side of the line is land". One 2048x1024 tile costs a single draw and
 * no triangulation, and the feathered edge hides the 0.176 deg/px limit. The
 * precise, zoom-stable boundary stays with the vector coastline layer.
 *
 * The feather is deliberately one-sided: `alpha = min(blur, coverage)` keeps
 * the wash off the water and only fades it inland, so the sea side never gets
 * a halo that contradicts the coastline.
 *
 * Usage:
 *   node scripts/build_landmask.mjs [--width 4096] [--height 2048]
 *                                   [--feather 1] [--color 264F3D]
 *
 * 4096x2048 is ~0.088 deg/px (~10 km). That is enough to keep archipelagos
 * from smearing into blobs at regional zoom; 2048 wide (~20 km/px) did smear
 * around Shanghai/Zhoushan. The cost is a 32 MB RGBA texture (plus mipmaps)
 * on the GPU - drop to 2048 if that matters on the target machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(repoRoot, 'data/ne_50m_land.geojson');
const DEFAULT_OUT = path.join(repoRoot, 'public/data/landmask.png');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const [key, inline] = arg.slice(2).split('=');
  args.set(key, inline ?? process.argv[i + 1]);
}

const WIDTH = Number(args.get('width') ?? 4096);
const HEIGHT = Number(args.get('height') ?? 2048);
const FEATHER = Number(args.get('feather') ?? 1);
const OUT = args.get('out') ? path.resolve(repoRoot, args.get('out')) : DEFAULT_OUT;
const COLOR = hexToRgb(args.get('color') ?? '264F3D');

if (!Number.isInteger(WIDTH) || !Number.isInteger(HEIGHT) || WIDTH < 256 || HEIGHT < 128) {
  console.error('build_landmask: width/height must be integers >= 256x128');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Rasterise: even-odd scanline fill. Holes (the Caspian) fall out for free.
// ---------------------------------------------------------------------------

const geojson = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
const edges = [];

for (const feature of geojson.features) {
  const geometry = feature.geometry;
  if (!geometry) continue;
  const polygons =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];

  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 1; i < ring.length; i += 1) {
        const [lonA, latA] = ring[i - 1];
        const [lonB, latB] = ring[i];
        const yA = ((90 - latA) / 180) * HEIGHT;
        const yB = ((90 - latB) / 180) * HEIGHT;
        if (yA === yB) continue; // horizontal edges never cross a scanline
        edges.push({
          xA: ((lonA + 180) / 360) * WIDTH,
          yA,
          xB: ((lonB + 180) / 360) * WIDTH,
          yB,
          yMin: Math.min(yA, yB),
          yMax: Math.max(yA, yB),
        });
      }
    }
  }
}

console.log(
  `build_landmask: ${edges.length.toLocaleString('en-US')} edges, ` +
    `${WIDTH}x${HEIGHT}, feather ${FEATHER}px`,
);

const coverage = new Uint8Array(WIDTH * HEIGHT);
const crossings = [];
let filled = 0;

for (let row = 0; row < HEIGHT; row += 1) {
  const yc = row + 0.5;
  crossings.length = 0;

  for (const edge of edges) {
    if (yc >= edge.yMin && yc < edge.yMax) {
      const t = (yc - edge.yA) / (edge.yB - edge.yA);
      crossings.push(edge.xA + t * (edge.xB - edge.xA));
    }
  }
  if (crossings.length < 2) continue;
  crossings.sort((a, b) => a - b);

  const base = row * WIDTH;
  for (let i = 0; i + 1 < crossings.length; i += 2) {
    const start = Math.max(0, Math.ceil(crossings[i] - 0.5));
    const end = Math.min(WIDTH - 1, Math.floor(crossings[i + 1] - 0.5));
    for (let x = start; x <= end; x += 1) {
      coverage[base + x] = 255;
      filled += 1;
    }
  }
}

console.log(
  `build_landmask: land covers ${((filled / (WIDTH * HEIGHT)) * 100).toFixed(1)}% of the tile`,
);

// ---------------------------------------------------------------------------
// Carve the waterways.
//
// The router treats the canal/strait corridors as open water (that is the only
// way a 0.25 deg grid can cross Suez or Malacca), so the land tint has to show
// water there as well - otherwise every route runs across a painted continent
// at each chokepoint. The geometry comes from build_geo, so both sides share
// one definition of where the channel is.
// ---------------------------------------------------------------------------

const WATERWAYS = args.get('waterways')
  ? path.resolve(repoRoot, args.get('waterways'))
  : path.join(repoRoot, 'public/data/waterways.json');

if (fs.existsSync(WATERWAYS)) {
  const { widthKm, lines } = JSON.parse(fs.readFileSync(WATERWAYS, 'utf8'));
  const halfKm = (Number(widthKm) || 18) / 2;

  for (const { points } of lines) {
    for (let i = 1; i < points.length; i += 1) {
      const [lonA, latA] = points[i - 1];
      const [lonB, latB] = points[i];
      const pxA = ((lonA + 180) / 360) * WIDTH;
      const pxB = ((lonB + 180) / 360) * WIDTH;
      const pyA = ((90 - latA) / 180) * HEIGHT;
      const pyB = ((90 - latB) / 180) * HEIGHT;
      const steps = Math.max(2, Math.ceil(Math.hypot(pxB - pxA, pyB - pyA)));

      for (let s = 0; s <= steps; s += 1) {
        const f = s / steps;
        const lon = lonA + (lonB - lonA) * f;
        const lat = latA + (latB - latA) * f;
        // km -> pixel; a degree of longitude shrinks with cos(lat)
        const cosLat = Math.max(0.15, Math.cos((lat * Math.PI) / 180));
        const rx = (halfKm / (111.32 * cosLat)) * (WIDTH / 360);
        const ry = (halfKm / 111.32) * (HEIGHT / 180);
        const cx = ((lon + 180) / 360) * WIDTH;
        const cy = ((90 - lat) / 180) * HEIGHT;

        const y0 = Math.max(0, Math.floor(cy - ry));
        const y1 = Math.min(HEIGHT - 1, Math.ceil(cy + ry));
        for (let y = y0; y <= y1; y += 1) {
          const dy = (y + 0.5 - cy) / Math.max(1e-6, ry);
          if (Math.abs(dy) > 1) continue;
          const dx = rx * Math.sqrt(1 - dy * dy);
          const x0 = Math.max(0, Math.floor(cx - dx));
          const x1 = Math.min(WIDTH - 1, Math.ceil(cx + dx));
          const base = y * WIDTH;
          for (let x = x0; x <= x1; x += 1) coverage[base + x] = 0;
        }
      }
    }
  }
  console.log(
    `build_landmask: carved ${lines.length} waterways at ${widthKm} km wide`,
  );
}

// ---------------------------------------------------------------------------
// Feather: box blur, then clamp to the binary coverage so the fade only ever
// happens on the land side.
// ---------------------------------------------------------------------------

function boxBlur(source, width, height, radius) {
  if (radius <= 0) return Float32Array.from(source);
  const horizontal = new Float32Array(width * height);
  const window = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    const base = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      sum += source[base + Math.min(width - 1, Math.max(0, x))];
    }
    for (let x = 0; x < width; x += 1) {
      horizontal[base + x] = sum / window;
      sum -= source[base + Math.min(width - 1, Math.max(0, x - radius))];
      sum += source[base + Math.min(width - 1, Math.max(0, x + radius + 1))];
    }
  }

  const result = new Float32Array(width * height);
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += horizontal[Math.min(height - 1, Math.max(0, y)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      result[y * width + x] = sum / window;
      sum -= horizontal[Math.min(height - 1, Math.max(0, y - radius)) * width + x];
      sum += horizontal[Math.min(height - 1, Math.max(0, y + radius + 1)) * width + x];
    }
  }
  return result;
}

const blurred = boxBlur(coverage, WIDTH, HEIGHT, FEATHER);

const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
for (let i = 0; i < WIDTH * HEIGHT; i += 1) {
  const alpha = Math.min(blurred[i], coverage[i]);
  const offset = i * 4;
  // RGB is the land colour for *every* pixel, including fully transparent
  // sea. Leaving transparent texels black makes bilinear/mipmap sampling bleed
  // black into the coast, which shows up as dark smudges inland.
  rgba[offset] = COLOR[0];
  rgba[offset + 1] = COLOR[1];
  rgba[offset + 2] = COLOR[2];
  rgba[offset + 3] = Math.round(alpha);
}

// ---------------------------------------------------------------------------
// Minimal PNG writer (truecolour + alpha, no filtering). zlib is built in.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(WIDTH, 0);
ihdr.writeUInt32BE(HEIGHT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: truecolour + alpha
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const raw = Buffer.alloc((WIDTH * 4 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const rowStart = y * (WIDTH * 4 + 1);
  raw[rowStart] = 0; // filter: none
  rgba.copy(raw, rowStart + 1, y * WIDTH * 4, (y + 1) * WIDTH * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);

console.log(
  `build_landmask: wrote ${path.relative(repoRoot, OUT)} ` +
    `(${(png.length / 1024).toFixed(0)} KB)`,
);

function hexToRgb(value) {
  const hex = value.replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    console.error(`build_landmask: bad colour "${value}" (expected RRGGBB)`);
    process.exit(2);
  }
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}
