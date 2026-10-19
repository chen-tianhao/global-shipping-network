/**
 * Headless smoke test.
 *
 * Boots Chromium against the built app, collects console errors / uncaught
 * exceptions, then asserts the scene actually has moving vessels:
 *
 *   - the viewer exists and the clock is advancing;
 *   - a sample of vessels are visible and change position over time.
 *
 * Usage:  node scripts/smoke.mjs [url]
 * Requires a prior `vite build` + `vite preview` (or any static server).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME =
  process.env.WSC_CHROME ??
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TARGET = process.argv[2] ?? process.env.WSC_URL ?? 'http://127.0.0.1:4173/';
const DEBUG_PORT = 9333;
const WAIT_MS = 9000;

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-smoke-'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDevTools() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  return false;
}

class Cdp {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 20000);
    });
  }
}

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--window-size=1600,900',
    '--hide-scrollbars',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let exitCode = 0;
try {
  if (!(await waitForDevTools())) throw new Error('Chrome DevTools never came up');

  const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(TARGET)}`, {
    method: 'PUT',
  });
  const target = await created.json();

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  const cdp = new Cdp(socket);

  const consoleErrors = [];
  const pageErrors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.consoleAPICalled') {
      const type = message.params.type;
      if (type === 'error' || type === 'warning') {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(' ');
        consoleErrors.push(`[${type}] ${text}`);
      }
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description ?? details.text);
    } else if (message.method === 'Log.entryAdded') {
      const entry = message.params.entry;
      if (entry.level === 'error') {
        const url = entry.url ? ` ${entry.url}` : '';
        // A missing favicon is not an application error.
        if (entry.url && /favicon\.ico$/.test(entry.url)) return;
        pageErrors.push(`[log] ${entry.text}${url}`);
      }
    }
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: TARGET });
  await sleep(WAIT_MS);

  const probe = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'eval failed');
    }
    return result.result.value;
  };

  const first = await probe(`
    (() => {
      const w = window.__WSC__;
      if (!w) return { ready: false };
      const vessels = w.layers.find((l) => l.id === 'vessels');
      const shown = vessels.primitives.filter((p) => p.show).length;
      const bar = document.querySelector('.timebar');
      const box = bar ? bar.getBoundingClientRect() : null;
      return {
        ready: true,
        timeBar: box
          ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) }
          : 'missing',
        timelineText: (document.querySelector('.cesium-timeline')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 220),
        timelineClasses: Array.from(document.querySelectorAll('.cesium-timeline-ticMain .cesium-timeline-ticLabel, .cesium-timeline-ticLabel'))
          .slice(0, 5)
          .map((node) => node.textContent),
        clockStart: Cesium.JulianDate.toDate(w.viewer.clock.startTime).toISOString(),
        clockStop: Cesium.JulianDate.toDate(w.viewer.clock.stopTime).toISOString(),
        clockNow: Cesium.JulianDate.toDate(w.viewer.clock.currentTime).toISOString(),
        day: Cesium.JulianDate.secondsDifference(
          w.viewer.clock.currentTime,
          Cesium.JulianDate.fromIso8601('2026-01-01T00:00:00Z')) / 86400,
        vesselTotal: vessels.primitives.length,
        vesselShown: shown,
        // The star sky box carries no information and costs a textured
        // full-screen draw plus six cube-map textures, so it must stay absent.
        skyBox: w.viewer.scene.skyBox == null ? 'none' : 'present',
        sun: w.viewer.scene.sun == null ? 'none' : 'present',
        moon: w.viewer.scene.moon == null ? 'none' : 'present',
        background: w.viewer.scene.backgroundColor.toCssColorString(),
        first: vessels.primitives.length
          ? Cesium.Cartographic.fromCartesian(vessels.primitives[0].position)
          : null,
        shouldAnimate: w.viewer.clock.shouldAnimate,
      };
    })()
  `);

  await sleep(2500);

  const second = await probe(`
    (() => {
      const w = window.__WSC__;
      const vessels = w.layers.find((l) => l.id === 'vessels');
      return {
        day: Cesium.JulianDate.secondsDifference(
          w.viewer.clock.currentTime,
          Cesium.JulianDate.fromIso8601('2026-01-01T00:00:00Z')) / 86400,
        first: vessels.primitives.length
          ? Cesium.Cartographic.fromCartesian(vessels.primitives[0].position)
          : null,
      };
    })()
  `);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const outFile = path.join(process.cwd(), 'smoke-screenshot.png');
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));

  const moved =
    first.first && second.first
      ? Math.abs(first.first.longitude - second.first.longitude) > 1e-9 ||
        Math.abs(first.first.latitude - second.first.latitude) > 1e-9
      : false;

  console.log('--- smoke result ---');
  console.log(JSON.stringify({ ...first, dayLater: second.day, moved }, null, 2));
  console.log(`screenshot -> ${outFile}`);
  if (consoleErrors.length) {
    console.log('--- console errors/warnings ---');
    for (const line of consoleErrors) console.log(line);
  }
  if (pageErrors.length) {
    console.log('--- page errors ---');
    for (const line of pageErrors) console.log(line);
  }

  const failures = [];
  if (!first.ready) failures.push('app did not initialise (window.__WSC__ missing)');
  if (!first.vesselShown) failures.push('no vessels are visible');
  if (!(second.day > first.day)) failures.push('clock is not advancing');
  if (first.skyBox !== 'none') failures.push('star sky box is present (should be disabled)');
  if (!moved) failures.push('vessels did not change position over 2.5 s');
  if (pageErrors.length) failures.push(`${pageErrors.length} page error(s)`);
  if (consoleErrors.some((line) => line.startsWith('[error]'))) {
    failures.push('console contains errors');
  }

  if (failures.length) {
    console.error(`\nSMOKE FAILED: ${failures.join('; ')}`);
    exitCode = 1;
  } else {
    console.log('\nSMOKE OK');
  }

  socket.close();
} catch (error) {
  console.error('smoke harness error:', error);
  exitCode = 1;
} finally {
  chrome.kill();
  // Chrome keeps a lock on some profile files for a moment after exit.
  try {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* leave the temp profile behind; harmless */
  }
}

process.exit(exitCode);
