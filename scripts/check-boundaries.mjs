#!/usr/bin/env node
/**
 * Layer boundary guard.
 *
 * The architecture only stays honest if the rules can be checked mechanically:
 *
 *   data/      may read files and CSVs
 *   viewmodel/ business shapes only - no Cesium, no DOM
 *   cesium/    Cesium + business shapes - never file access
 *   ui/        DOM + business shapes - no Cesium
 *
 * `tsc` cannot catch a `fetch()` in the wrong folder, and a single slip is how
 * "the renderer reads a CSV" creeps back in. Run from `npm run build`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcRoot = path.join(repoRoot, 'src');

const violations = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.ts')) check(full);
  }
}

function relative(file) {
  return path.relative(repoRoot, file).replaceAll('\\', '/');
}

function check(file) {
  const rel = relative(file);
  const text = fs.readFileSync(file, 'utf8');

  if (rel.startsWith('src/cesium/')) {
    const fileAccess = /\bfetch(Json|Text)?\s*\(|\bXMLHttpRequest\b|\blocalStorage\b/;
    if (fileAccess.test(text)) {
      violations.push(`${rel}: file/network access in the render layer`);
    }
  }

  if (rel.startsWith('src/viewmodel/') || rel.startsWith('src/ui/')) {
    if (/from\s+['"]cesium['"]/.test(text)) {
      violations.push(`${rel}: Cesium import outside src/cesium/`);
    }
  }
}

walk(srcRoot);

if (violations.length > 0) {
  console.error('check-boundaries: layer violations found');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log('check-boundaries: OK');
