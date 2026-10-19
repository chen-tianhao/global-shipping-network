/**
 * Motion geometry verification.
 *
 * The route files are already verified to be land-free as geodesics
 * (`npm run verify:geo`). This script verifies the *other* half of the
 * guarantee: that the code which places vessels between waypoints follows that
 * same geodesic. It caught a real bug where linear lon/lat interpolation sent
 * S4/S9 vessels the wrong way around the planet (raw longitude deltas of
 * ±270 degrees across the antimeridian).
 *
 * It compiles the dependency-free `geoMath.ts` to a temp directory and imports
 * it directly, so it exercises the exact module the browser uses.
 *
 * Usage: npm run verify:motion
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.verify-motion');
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

execFileSync(
  process.execPath,
  [
    tscBin,
    path.join(root, 'src', 'data', 'geo', 'geoMath.ts'),
    '--ignoreConfig',
    '--outDir',
    outDir,
    '--module',
    'esnext',
    '--target',
    'es2022',
    '--moduleResolution',
    'bundler',
    '--skipLibCheck',
  ],
  { stdio: 'inherit' },
);

const geo = await import(pathToFileURL(path.join(outDir, 'geoMath.js')).href);
const routesFile = JSON.parse(
  fs.readFileSync(path.join(root, 'public', 'data', 'routes.json'), 'utf8'),
);
const portsFile = JSON.parse(
  fs.readFileSync(path.join(root, 'public', 'data', 'ports.json'), 'utf8'),
);

const failures = [];
const samples = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

/** Independent cross-track distance: sine of the angle between P and the A-B plane. */
function crossTrackNm(point, a, b) {
  const toRad = Math.PI / 180;
  const vector = ([lon, lat]) => [
    Math.cos(lat * toRad) * Math.cos(lon * toRad),
    Math.cos(lat * toRad) * Math.sin(lon * toRad),
    Math.sin(lat * toRad),
  ];
  const cross = (x, y) => [
    x[1] * y[2] - x[2] * y[1],
    x[2] * y[0] - x[0] * y[2],
    x[0] * y[1] - x[1] * y[0],
  ];
  const dot = (x, y) => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];

  const p = vector(point);
  const normal = cross(vector(a), vector(b));
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  if (length < 1e-12) return 0;
  return Math.asin(Math.min(1, Math.abs(dot(p, normal) / length))) * geo.EARTH_RADIUS_NM;
}

let antimeridianPairs = 0;
let totalWaypoints = 0;
let totalSegments = 0;
let totalSamples = 0;

for (const route of routesFile.routes) {
  const waypoints = route.waypoints ?? [];
  totalWaypoints += waypoints.length;
  totalSegments += Math.max(0, waypoints.length - 1);

  // The build-time total is a great-circle polyline length. If the JS distance
  // function drifted from the Python one, speed along the route would drift.
  let sumNm = 0;
  for (let i = 1; i < waypoints.length; i += 1) {
    sumNm += geo.greatCircleDistanceNm(waypoints[i - 1], waypoints[i]);
  }
  const declaredNm = Number(route.totalDistanceNm ?? 0);
  if (declaredNm > 0) {
    const relative = Math.abs(sumNm - declaredNm) / declaredNm;
    check(
      relative < 0.005,
      `${route.id}: summed distance ${sumNm.toFixed(1)} nm differs from routes.json ${declaredNm.toFixed(1)} nm by ${(relative * 100).toFixed(2)}%`,
    );
  }

  for (let i = 1; i < waypoints.length; i += 1) {
    const a = waypoints[i - 1];
    const b = waypoints[i];
    const lengthNm = geo.greatCircleDistanceNm(a, b);
    const steps = Math.max(2, Math.ceil(lengthNm / 25));

    let previous = null;
    for (let step = 0; step <= steps; step += 1) {
      const fraction = step / steps;
      const point = geo.interpolateGreatCircle(a, b, fraction);
      totalSamples += 1;

      check(
        Number.isFinite(point[0]) &&
          Number.isFinite(point[1]) &&
          point[0] >= -180 &&
          point[0] <= 180 &&
          point[1] >= -90 &&
          point[1] <= 90,
        `${route.id} segment ${i}: invalid sample ${JSON.stringify(point)}`,
      );

      // The sampler must stay on the great-circle arc it is interpolating.
      const offArc = crossTrackNm(point, a, b);
      check(
        offArc < 0.05,
        `${route.id} segment ${i}: sample is ${offArc.toFixed(3)} nm off the great-circle arc`,
      );

      // And it must advance monotonically along that arc.
      if (previous) {
        const movedNm = geo.greatCircleDistanceNm(previous, point);
        const expectedNm = lengthNm / steps;
        check(
          Math.abs(movedNm - expectedNm) <= Math.max(1, expectedNm * 0.02),
          `${route.id} segment ${i}: step ${step} moved ${movedNm.toFixed(2)} nm, expected ~${expectedNm.toFixed(2)} nm`,
        );
      }
      previous = point;
    }

    // Explicit 0.5 sample: using floor(steps / 2) / steps would compare a
    // one-third point against the midpoint whenever `steps` is odd.
    const midpoint = geo.interpolateGreatCircle(a, b, 0.5);
    const expectedMidpoint = geo.greatCircleMidpoint(a, b);
    const midpointError = geo.greatCircleDistanceNm(midpoint, expectedMidpoint);
    check(
      midpointError < 0.1,
      `${route.id} segment ${i}: midpoint differs from vector midpoint by ${midpointError.toFixed(3)} nm`,
    );
    const halfSum =
      geo.greatCircleDistanceNm(a, midpoint) + geo.greatCircleDistanceNm(midpoint, b);
    check(
      Math.abs(halfSum - lengthNm) < 0.5,
      `${route.id} segment ${i}: sample is on the long arc (${halfSum.toFixed(
        1,
      )} nm vs ${lengthNm.toFixed(1)} nm)`,
    );

    if (Math.abs(b[0] - a[0]) > 180) {
      antimeridianPairs += 1;
      const oldLinearMidpoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const oldError =
        geo.greatCircleDistanceNm(oldLinearMidpoint, expectedMidpoint) || 0;

      samples.push({
        route: route.id,
        segment: i,
        a,
        b,
        rawDeltaLon: Number((b[0] - a[0]).toFixed(2)),
        fixedMidpoint: midpoint.map((value) => Number(value.toFixed(3))),
        oldLinearMidpoint: oldLinearMidpoint.map((value) => Number(value.toFixed(3))),
        oldErrorNm: Math.round(oldError),
      });

      // The regression test must be able to distinguish the fix from the bug.
      check(
        oldError > 500,
        `${route.id} segment ${i}: antimeridian test is not discriminating (old midpoint only ${oldError.toFixed(
          0,
        )} nm away)`,
      );
    }
  }

  // Headings are rendered as orientation later; they must at least be sane.
  for (let i = 1; i < waypoints.length; i += 1) {
    const heading = geo.initialBearingDeg(waypoints[i - 1], waypoints[i]);
    check(
      Number.isFinite(heading) && heading >= 0 && heading < 360,
      `${route.id} segment ${i}: invalid heading ${heading}`,
    );
  }
}

check(
  antimeridianPairs >= 4,
  `expected at least 4 antimeridian-crossing waypoint pairs, found ${antimeridianPairs}`,
);

// ---- camera framing ------------------------------------------------------
const s4 = routesFile.routes.find((route) => route.id === 'S4');
const s9 = routesFile.routes.find((route) => route.id === 'S9');
const s4Span = geo.shortestLongitudeSpan(s4.waypoints.map(([lon]) => lon));
const s9Span = geo.shortestLongitudeSpan(s9.waypoints.map(([lon]) => lon));

check(
  s4Span && s4Span.span < 150,
  `S4 camera span is ${s4Span?.span.toFixed(1)} degrees, expected < 150`,
);
check(
  s9Span && s9Span.span < 150,
  `S9 camera span is ${s9Span?.span.toFixed(1)} degrees, expected < 150`,
);
check(
  s4Span && s4Span.west > s4Span.east,
  'S4 camera rectangle should cross the antimeridian (west > east)',
);

const wrapped = geo.shortestLongitudeSpan([170, -170]);
check(
  wrapped &&
    Math.abs(wrapped.span - 20) < 1e-9 &&
    wrapped.west === 170 &&
    wrapped.east === -170,
  `two-point antimeridian span is wrong: ${JSON.stringify(wrapped)}`,
);

const homeSpan = geo.shortestLongitudeSpan(
  portsFile.ports.map((port) => port.lon),
);
check(
  homeSpan && homeSpan.span > 240 && homeSpan.span < 255,
  `network home span is ${homeSpan?.span.toFixed(1)} degrees, expected ~247`,
);

// ---- report --------------------------------------------------------------
console.log('--- antimeridian legs ---');
for (const sample of samples) {
  console.log(
    `${sample.route} segment ${sample.segment}: raw dlon ${sample.rawDeltaLon}, ` +
      `fixed midpoint ${JSON.stringify(sample.fixedMidpoint)}, ` +
      `old linear midpoint ${JSON.stringify(sample.oldLinearMidpoint)} ` +
      `(${sample.oldErrorNm} nm away)`,
  );
}
console.log('--- camera framing ---');
console.log(
  `S4 span ${s4Span.span.toFixed(1)} deg (west ${s4Span.west}, east ${s4Span.east})`,
);
console.log(
  `S9 span ${s9Span.span.toFixed(1)} deg (west ${s9Span.west}, east ${s9Span.east})`,
);
console.log(`home span ${homeSpan.span.toFixed(1)} deg`);

console.log('--- summary ---');
console.log(
  `${routesFile.routes.length} routes, ${totalWaypoints} waypoints, ${totalSegments} segments, ` +
    `${totalSamples} samples, ${antimeridianPairs} antimeridian pairs`,
);

if (failures.length) {
  console.error(`\nVERIFY MOTION FAILED (${failures.length}):`);
  for (const failure of failures.slice(0, 20)) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('\nVERIFY MOTION OK');
