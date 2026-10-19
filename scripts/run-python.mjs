#!/usr/bin/env node
/**
 * Runs one of the geo pipeline scripts with an interpreter that can import
 * numpy.
 *
 * Why this exists: `build:geo` / `verify:geo` used to shell out to bare
 * `python`. On a plain Windows install that is a system interpreter without
 * numpy, so the pipeline died with `ModuleNotFoundError` and a fresh clone
 * could not reproduce the committed geometry. Guessing a single path is not
 * portable either, so candidates are probed in order and the first one that
 * can `import numpy` wins:
 *
 *   1. $WSC_PYTHON             - explicit override, wins over everything
 *   2. <repo>/.venv            - documented per-project option
 *   3. ~/.workbuddy/.../envs/default - the managed runtime on this machine
 *   4. python3 / python / py -3 on PATH
 *
 * Usage: node scripts/run-python.mjs <script.py> [args...]
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [script, ...scriptArgs] = process.argv.slice(2);

if (!script) {
  console.error('run-python: missing script path');
  process.exit(2);
}

const isWindows = process.platform === 'win32';
const venvPython = path.join(
  repoRoot,
  '.venv',
  isWindows ? 'Scripts/python.exe' : 'bin/python',
);
const managedPython = path.join(
  os.homedir(),
  '.workbuddy/binaries/python/envs/default',
  isWindows ? 'Scripts/python.exe' : 'bin/python',
);

/** @type {Array<{label: string, command: string, prefix: string[]}>} */
const candidates = [];
if (process.env.WSC_PYTHON) {
  candidates.push({
    label: 'WSC_PYTHON',
    command: process.env.WSC_PYTHON,
    prefix: [],
  });
}
candidates.push({ label: '.venv', command: venvPython, prefix: [] });
candidates.push({ label: 'managed', command: managedPython, prefix: [] });
candidates.push({ label: 'python3', command: 'python3', prefix: [] });
candidates.push({ label: 'python', command: 'python', prefix: [] });
if (isWindows) {
  candidates.push({ label: 'py -3', command: 'py', prefix: ['-3'] });
}

const reasons = [];
let chosen = null;

for (const candidate of candidates) {
  const isExplicit = candidate.label === 'WSC_PYTHON';

  if (candidate.command.includes(path.sep) && !fs.existsSync(candidate.command)) {
    if (isExplicit) {
      console.error(`run-python: WSC_PYTHON does not exist: ${candidate.command}`);
      process.exit(1);
    }
    continue;
  }

  const probe = spawnSync(
    candidate.command,
    [...candidate.prefix, '-c', 'import numpy'],
    { stdio: 'ignore' },
  );
  if (probe.status === 0) {
    chosen = candidate;
    break;
  }

  // An explicit override that does not work must fail loudly: silently
  // falling back to another interpreter is how "it works on my machine"
  // bugs get shipped.
  if (isExplicit) {
    console.error(
      `run-python: WSC_PYTHON cannot import numpy (${candidate.command}).` +
        '\nPoint it at a Python that has numpy, or unset it to use the auto-detected one.',
    );
    process.exit(1);
  }

  reasons.push(
    `${candidate.label}: ${candidate.command} cannot import numpy` +
      (probe.error ? ` (${probe.error.message})` : ''),
  );
}

if (!chosen) {
  console.error('run-python: no usable Python interpreter found.');
  for (const reason of reasons) console.error(`  - ${reason}`);
  console.error(
    '\nFix one of:\n' +
      '  set WSC_PYTHON=C:\\path\\to\\python.exe\n' +
      '  python -m venv .venv && .venv/Scripts/pip install -r scripts/requirements.txt',
  );
  process.exit(1);
}

const result = spawnSync(chosen.command, [...chosen.prefix, script, ...scriptArgs], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`run-python: failed to start ${chosen.label}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
