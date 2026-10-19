/**
 * Remove `dist/` before a build.
 *
 * Why not let Vite's `emptyOutDir` do it: on this machine fs deletion is routed
 * through a recycle-bin helper, which times out on a dist containing the whole
 * Cesium runtime (hundreds of files). A direct rmdir is instant.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

if (!fs.existsSync(dist)) {
  process.exit(0);
}

if (process.platform === 'win32') {
  const result = spawnSync('cmd.exe', ['/c', 'rmdir', '/s', '/q', dist], {
    stdio: 'ignore',
  });
  if (result.status !== 0) {
    console.error(`clean-dist: rmdir failed with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
} else {
  fs.rmSync(dist, { recursive: true, force: true });
}

console.log(fs.existsSync(dist) ? 'clean-dist: dist still present' : 'clean-dist: removed dist/');
