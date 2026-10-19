#!/usr/bin/env node
/**
 * Pre-deploy asset check for `dist/`.
 *
 * The failure this prevents: a static host serves `index.html` for any unknown
 * path, so a missing `dist/data/ports.json` comes back as HTTP 200 + HTML. The
 * app then dies with `Unexpected token '<'`, which says nothing about the real
 * cause. Worse, most of `public/data` is generated and git-ignored, so a
 * CI/deploy that only runs `vite build` silently ships a bundle with no data.
 *
 * Runs as the last step of `npm run build`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = process.env.WSC_DIST ?? path.join(repoRoot, 'dist');

const REQUIRED = [
  'index.html',
  'vendor/plotly.min.js',
  'data/ports.json',
  'data/routes.json',
  'data/route_plan.csv',
  'data/vessel_classes.csv',
  'data/stats/Port_Waiting_Statistics.csv',
  'data/stats/Service_Route_Utilization.csv',
  'data/stats/Average_In_Transit_TEU_By_OD.csv',
  'data/stats/Average_Origin_Waiting_TEU_By_OD.csv',
  'data/stats/Cumulative_Completed_TEU_By_OD.csv',
  'data/stats/ATT_By_Statistics_Interval.csv',
  'data/stats/Average_Vessel_State_Counts.csv',
];

// The app tolerates these (it falls back to a flat globe / placeholder-only),
// but a deploy without them is almost never intentional.
const RECOMMENDED = [
  'data/coastline.json',
  'data/landmask.png',
  'data/trajectory/meta.json',
  'data/trajectory/voyages.csv',
  'data/trajectory/states.csv',
];

const JSON_FILES = new Set([
  'data/ports.json',
  'data/routes.json',
  'data/coastline.json',
  'data/trajectory/meta.json',
]);

const problems = [];
const warnings = [];

for (const relative of REQUIRED) problems.push(...check(relative));
for (const relative of RECOMMENDED) warnings.push(...check(relative));

if (problems.length > 0) {
  console.error('check-dist: the build cannot be deployed as-is');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nGenerate the missing assets and rebuild:\n' +
      '  npm run build:geo      # routes.json (+ ports.json)\n' +
      '  npm run build:coast    # coastline.json\n' +
      '  npm run build:mask     # landmask.png\n' +
      '  npm run build:data     # stats/*.csv + trajectory/*\n' +
      '  npm run build\n\n' +
      'Generated files under public/data are git-ignored on purpose, so a CI\n' +
      'that only runs "vite build" will always fail this check.',
  );
  process.exit(1);
}

const suffix = warnings.length ? ` (${warnings.length} recommended missing)` : '';
console.log(`check-dist: OK${suffix}`);
for (const warning of warnings) console.warn(`  warning: ${warning}`);

function check(relative) {
  const file = path.join(dist, relative);
  if (!fs.existsSync(file)) {
    return [`missing: ${relative}`];
  }

  const size = fs.statSync(file).size;
  if (size < 32) {
    return [`empty or truncated: ${relative} (${size} bytes)`];
  }

  if (JSON_FILES.has(relative)) {
    const text = fs.readFileSync(file, 'utf8').trimStart();
    if (text.startsWith('<')) {
      return [`${relative} contains HTML, not JSON (SPA fallback was saved by mistake)`];
    }
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      return [`${relative} is not valid JSON: ${error.message}`];
    }
  }

  return [];
}
