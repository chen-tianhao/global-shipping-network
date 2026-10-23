import fs from 'node:fs';
import path from 'node:path';

/**
 * Route smoothness audit.
 *
 * The renderer draws each waypoint pair as a great-circle arc, so a kink is
 * exactly a large course change at a vertex. Two classes matter:
 *
 *  - a reversal (>= 150 deg) can only be a data artifact: no route doubles back
 *    on itself except at a port, where the loop turns around;
 *  - a corner between two long legs (> 400 km each) is visible at any zoom, and
 *    is the "kink in the middle of the Pacific" case.
 *
 * Vertices within PORT_EXEMPT_KM of a port are skipped: a service that ends and
 * restarts at the same port legitimately turns 180 degrees there.
 */

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.replace(/^--/, '').split('=');
  args.set(key, value ?? 'true');
}

const ROOT = path.join(import.meta.dirname, '..');
const ROUTES = args.get('routes') ?? path.join(ROOT, 'public/data/routes.json');
const PORTS = args.get('ports') ?? path.join(ROOT, 'public/data/ports.json');

const PORT_EXEMPT_KM = 60;
const MAX_TURN_DEG = Number(args.get('max-turn') ?? 60);
const MAX_TURN_BUDGET = Number(args.get('max-turn-budget') ?? 90);
const LONG_LEG_KM = 400;
const LONG_LEG_TURN_DEG = Number(args.get('max-long-turn') ?? 20);
// A >=150 deg turn where BOTH adjacent legs exceed this length is a real
// route turnaround (rounding a cape, entering a gulf) rather than a splice
// artifact.  Below this threshold the reversal is almost always a hairpin
// left by a port-gate join and must be flagged.
const REVERSAL_LONG_KM = 30;

const R = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

const distKm = (a, b) => {
  const dLat = rad(b[1] - a[1]);
  const dLon = rad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

const bearing = (a, b) => {
  const lat1 = rad(a[1]);
  const lat2 = rad(b[1]);
  let dLon = rad(b[0] - a[0]);
  if (dLon > Math.PI) dLon -= 2 * Math.PI;
  if (dLon < -Math.PI) dLon += 2 * Math.PI;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
};

const turnDeg = (a, b, c) => {
  let t = bearing(b, c) - bearing(a, b);
  while (t > 180) t -= 360;
  while (t < -180) t += 360;
  return Math.abs(t);
};

const routes = JSON.parse(fs.readFileSync(ROUTES, 'utf8')).routes;
const ports = JSON.parse(fs.readFileSync(PORTS, 'utf8')).ports;
const nearPort = (p) => ports.some((port) => distKm(p, [port.lon, port.lat]) < PORT_EXEMPT_KM);

let vertices = 0;
let reversals = 0;
let longCorners = 0;
let sharp = 0;
const problems = [];

for (const route of routes) {
  const w = route.waypoints;
  vertices += w.length;
  for (let i = 1; i < w.length - 1; i += 1) {
    if (nearPort(w[i])) continue;
    const before = distKm(w[i - 1], w[i]);
    const after = distKm(w[i], w[i + 1]);
    if (before < 0.3 || after < 0.3) continue; // dedupe already removed these
    const turn = turnDeg(w[i - 1], w[i], w[i + 1]);
    const where = `${route.id} ${w[i][0].toFixed(2)},${w[i][1].toFixed(2)}`;
    if (turn >= 150) {
      // A reversal where either leg is long is a legitimate turnaround (the
      // route rounds a cape, enters a dead-end gulf, or makes a port call);
      // only reversals where BOTH legs are short are splice artifacts.
      const legit = before > REVERSAL_LONG_KM || after > REVERSAL_LONG_KM;
      if (!legit) {
        reversals += 1;
        problems.push(
          `${where}: reversal ${turn.toFixed(0)} deg` +
            ` (${Math.round(before)}/${Math.round(after)} km legs)`,
        );
      }
    } else if (before > LONG_LEG_KM && after > LONG_LEG_KM && turn > LONG_LEG_TURN_DEG) {
      longCorners += 1;
      problems.push(
        `${where}: ${turn.toFixed(0)} deg corner between ${Math.round(before)}/${Math.round(after)} km legs`,
      );
    } else if (turn > MAX_TURN_DEG) {
      sharp += 1;
    }
  }
}

console.log(
  `check:smoothness  ${routes.length} routes, ${vertices} vertices` +
    `  >${MAX_TURN_DEG} deg: ${sharp}  reversals: ${reversals}  long-leg corners: ${longCorners}`,
);

const failures = [];
if (reversals > 0) failures.push(`${reversals} reversal(s) outside port approaches`);
if (longCorners > 0) failures.push(`${longCorners} corner(s) between long legs`);
if (sharp > MAX_TURN_BUDGET) {
  failures.push(`${sharp} turns over ${MAX_TURN_DEG} deg (budget ${MAX_TURN_BUDGET})`);
}

if (failures.length) {
  console.error(`check:smoothness FAILED - ${failures.join('; ')}`);
  for (const problem of problems.slice(0, 20)) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('check:smoothness OK');
