/**
 * Land-avoidance check against the *displayed* land, not the routing grid.
 *
 * `verify:geo` samples a 0.1 deg raster derived from the same coastline data
 * the router uses, so it can only ever agree with itself. This check is
 * deliberately independent: it reads the land tint the user actually sees
 * (`public/data/landmask.png`) and walks every route polyline at 2 km steps.
 *
 * It exists because Suez/Malacca/Antwerp used to report "0 land crossings"
 * while 3.3 % of the network's length sat on visible land - the routing mask
 * carves corridors through those passages, so the two disagreed.
 *
 * Usage: node scripts/check_route_land.mjs [--max-percent 1] [--max-run 60]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const repoRoot = path.resolve(import.meta.dirname, '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const MAX_PERCENT = Number(args.get('max-percent') ?? 1);
const MAX_RUN_KM = Number(args.get('max-run') ?? 60);

const ROUTES = path.join(repoRoot, 'public/data/routes.json');
const MASK = path.join(repoRoot, 'public/data/landmask.png');

if (!fs.existsSync(ROUTES) || !fs.existsSync(MASK)) {
  console.warn('check:routes skipped - run `npm run build:geo && npm run build:mask` first');
  process.exit(0);
}

// ---- decode the RGBA tile (alpha only) ------------------------------------
const buf = fs.readFileSync(MASK);
let off = 8;
let width = 0;
let height = 0;
let colorType = 0;
const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === 'IHDR') {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    colorType = data[9];
  }
  if (type === 'IDAT') idat.push(data);
  off += 12 + len;
}
const bpp = colorType === 6 ? 4 : 3;
const stride = width * bpp;
const raw = zlib.inflateSync(Buffer.concat(idat));
const px = Buffer.alloc(stride * height);
let pos = 0;
for (let y = 0; y < height; y += 1) {
  const filter = raw[pos++];
  const row = raw.subarray(pos, pos + stride);
  pos += stride;
  const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
  const cur = px.subarray(y * stride, (y + 1) * stride);
  for (let x = 0; x < stride; x += 1) {
    const a = x >= bpp ? cur[x - bpp] : 0;
    const b = prev ? prev[x] : 0;
    const c = prev && x >= bpp ? prev[x - bpp] : 0;
    let v = row[x];
    if (filter === 1) v += a;
    else if (filter === 2) v += b;
    else if (filter === 3) v += (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    cur[x] = v & 0xff;
  }
}

const alphaAt = (lon, lat) => {
  const x = Math.min(width - 1, Math.max(0, Math.round(((lon + 180) / 360) * width)));
  const y = Math.min(height - 1, Math.max(0, Math.round(((90 - lat) / 180) * height)));
  return px[y * stride + x * bpp + 3];
};

// ---- geometry -------------------------------------------------------------
const R = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
const distKm = (a, b) => {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
/**
 * Great-circle interpolation, matching what the renderer draws.
 *
 * Linear lon/lat interpolation is wrong for the long legs in this network: an
 * 8,000 km chord walks a completely different path from the geodesic, which
 * made this check report land crossings that do not exist on screen.
 */
const lerp = (a, b, f) => {
  const lon1 = rad(a[0]);
  const lat1 = rad(a[1]);
  const lon2 = rad(b[0]);
  const lat2 = rad(b[1]);
  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
      ),
    );
  if (d < 1e-12) return [a[0], a[1]];
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return [
    (Math.atan2(y, x) * 180) / Math.PI,
    (Math.atan2(z, Math.hypot(x, y)) * 180) / Math.PI,
  ];
};

const routes = JSON.parse(fs.readFileSync(ROUTES, 'utf8')).routes;
let totalKm = 0;
let landKm = 0;
const runs = [];

for (const route of routes) {
  const points = route.waypoints ?? [];
  let run = null;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const length = distKm(a, b);
    totalKm += length;
    const steps = Math.max(1, Math.ceil(length / 2));
    for (let s = 0; s < steps; s += 1) {
      const p = lerp(a, b, s / steps);
      if (alphaAt(p[0], p[1]) <= 128) {
        run = null;
        continue;
      }
      const stepKm = length / steps;
      landKm += stepKm;
      if (run && distKm([run.lon, run.lat], p) < 6) {
        run.km += stepKm;
        run.lon = p[0];
        run.lat = p[1];
      } else {
        run = { route: route.id, km: stepKm, lon: p[0], lat: p[1] };
        runs.push(run);
      }
    }
  }
}

const percent = (landKm / totalKm) * 100;
runs.sort((a, b) => b.km - a.km);
const worst = runs[0];

console.log(`check:routes  ${Math.round(totalKm).toLocaleString('en-US')} km sampled at 2 km`);
console.log(`  on displayed land : ${Math.round(landKm)} km (${percent.toFixed(2)} %)`);
console.log(`  longest run       : ${worst ? `${Math.round(worst.km)} km at ${worst.route} ${worst.lon.toFixed(2)},${worst.lat.toFixed(2)}` : 'none'}`);

const failures = [];
if (percent > MAX_PERCENT) {
  failures.push(`${percent.toFixed(2)} % on land exceeds ${MAX_PERCENT} %`);
}
if (worst && worst.km > MAX_RUN_KM) {
  failures.push(`a ${Math.round(worst.km)} km stretch sits on land (limit ${MAX_RUN_KM} km)`);
}
if (failures.length) {
  console.error(`check:routes FAILED - ${failures.join('; ')}`);
  process.exit(1);
}
console.log('check:routes OK');
