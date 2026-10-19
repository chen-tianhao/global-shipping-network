/**
 * Copy the simulation's exported CSVs into the front-end's public assets.
 *
 *   stats/*.csv        <- Output/*.csv                 (8 aggregate tables)
 *   trajectory/*.csv   <- Output/trajectory/*.csv      (voyages + states)
 *   trajectory/meta.json                              (measurement start etc.)
 *
 * The meta file is what lets `RealTrajectoryProvider` turn Python's year-1
 * timestamps into simulation days. The default warm-up (20 days) matches the
 * bundled sample export; pass `--warm-up-days 140 --measurement-days 360` after
 * a full export.
 *
 * Usage:
 *   node scripts/build-data.mjs
 *   node scripts/build-data.mjs --warm-up-days=140 --measurement-days=360
 *   node scripts/build-data.mjs --source="D:/path/to/Output"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSource = path.resolve(
  root,
  '..',
  'WSC_SimulationChallenge_2026',
  'SimulationChallenge2026_Py',
  'Output',
);

const args = new Map();
for (const raw of process.argv.slice(2)) {
  const match = /^--([^=]+)=(.*)$/.exec(raw);
  if (match) args.set(match[1], match[2]);
}

const source = path.resolve(args.get('source') ?? defaultSource);
const warmUpDays = Math.max(0, Number(args.get('warm-up-days') ?? 20) || 0);
const measurementDays = Math.max(
  0,
  Number(args.get('measurement-days') ?? 10) || 0,
);

const statsDest = path.join(root, 'public', 'data', 'stats');
const trajectoryDest = path.join(root, 'public', 'data', 'trajectory');

if (!fs.existsSync(source)) {
  console.error(`build-data: source directory not found: ${source}`);
  process.exit(1);
}

const statsSource = source;
const trajectorySource = path.join(source, 'trajectory');

const statsCount = copyCsvDirectory(statsSource, statsDest);
if (statsCount === 0) {
  console.error(`build-data: no CSV files in ${statsSource}`);
  process.exit(1);
}

let trajectoryCount = 0;
let metaWritten = false;
if (fs.existsSync(trajectorySource)) {
  trajectoryCount = copyCsvDirectory(trajectorySource, trajectoryDest);

  const voyagesPath = path.join(trajectoryDest, 'voyages.csv');
  const statesPath = path.join(trajectoryDest, 'states.csv');
  if (fs.existsSync(voyagesPath) && fs.existsSync(statesPath)) {
    const meta = {
      generatedAt: new Date().toISOString(),
      source,
      warmUpDays,
      measurementDays,
      measurementStartIso: yearOneIso(warmUpDays),
      voyages: countRows(voyagesPath),
      states: countRows(statesPath),
    };
    fs.writeFileSync(
      path.join(trajectoryDest, 'meta.json'),
      `${JSON.stringify(meta, null, 2)}\n`,
      'utf8',
    );
    metaWritten = true;
    console.log(
      `build-data: meta warm-up ${warmUpDays} d, measurement start ${meta.measurementStartIso}, ` +
        `${meta.voyages} voyages, ${meta.states} states`,
    );
  }
} else {
  console.warn(
    `build-data: no trajectory directory at ${trajectorySource}; real provider will be unavailable`,
  );
}

console.log(`build-data: stats ${statsCount} file(s) -> ${statsDest}`);
if (trajectoryCount > 0) {
  console.log(
    `build-data: trajectory ${trajectoryCount} file(s) -> ${trajectoryDest}`,
  );
}
if (!metaWritten) {
  console.warn(
    'build-data: meta.json not written; run export_trajectory.py before using ?provider=real',
  );
}

function copyCsvDirectory(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let copied = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.csv')) continue;
    fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    copied += 1;
  }
  return copied;
}

function countRows(file) {
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return 0;
  return Math.max(0, text.split(/\r?\n/).length - 1);
}

/** `0001-01-01T00:00:00` + N days, formatted without relying on Date.parse. */
function yearOneIso(dayOffset) {
  const date = new Date(0);
  date.setUTCFullYear(1, 0, 1);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(1 + dayOffset);

  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}T00:00:00`;
}
