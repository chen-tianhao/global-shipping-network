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
const cliArgs = process.argv.slice(2);
const TARGET =
  cliArgs.find((arg) => !arg.startsWith('--')) ??
  process.env.WSC_URL ??
  'http://127.0.0.1:4173/';
const REAL =
  /[?&]provider=(?:real|real-trajectory)(?:&|$)/.test(TARGET) ||
  process.env.WSC_PROVIDER === 'real';
const EXPECTED_WARM_UP_DAYS = REAL ? 20 : 140;
/** Render as a 390x844 phone and assert the bottom-sheet layout instead. */
const MOBILE = process.env.WSC_MOBILE === '1' || cliArgs.includes('--mobile');
const DEBUG_PORT = 9333;
// SwiftShader + Cesium shader compilation can take ~10 s on a cold profile;
// 9 s made the first probe race the bootstrap and report a false "not ready".
/**
 * Hard ceiling for start-up. Cesium compiles shaders and uploads textures on
 * the first frame; under SwiftShader that is slow and jittery, so poll for the
 * app handle instead of trusting one fixed sleep (a single missed window used
 * to fail the whole run with "window.__WSC__ missing").
 */
const READY_TIMEOUT_MS = 45000;

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsc-smoke-'));

/**
 * Screenshots are diagnostic, not assertions. `WSC_SHOTS=0` keeps the checks
 * runnable in environments where writing PNGs is not allowed.
 */
const SAVE_SHOTS = process.env.WSC_SHOTS !== '0';
function saveShot(name, base64) {
  if (!SAVE_SHOTS) return;
  fs.writeFileSync(path.join(process.cwd(), name), Buffer.from(base64, 'base64'));
}

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
  if (MOBILE) {
    // 390x844 = iPhone 14/15 logical size; the CSS breakpoint is 640 px.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
  }
  await cdp.send('Page.navigate', { url: TARGET });

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

  /**
   * Wait for the app handle instead of sleeping a fixed amount: start-up time
   * depends on shader compilation and texture uploads, which vary a lot on
   * software rendering.
   */
  const waitForApp = async (timeoutMs = READY_TIMEOUT_MS) => {
    const deadline = Date.now() + timeoutMs;
    do {
      const state = await probe(`({
        ready: Boolean(window.__WSC__),
        error: document.querySelector('.overlay--error')?.textContent ?? null
      })`);
      if (state.ready) return { ready: true };
      // Bootstrap writes the real reason into the overlay. Stop waiting as
      // soon as it appears: the rest of the checks assume a live app and
      // would otherwise fail with a cascade of TypeErrors.
      if (state.error) return { ready: false, error: state.error };
      await sleep(400);
    } while (Date.now() < deadline);
    return { ready: false };
  };

  /**
   * Plotly is a 4.5 MB lazy chunk. Sampling its presence once is flaky when
   * the machine is busy (e.g. a simulation export running in parallel), so
   * poll instead of asserting on a single snapshot.
   */
  const waitForChart = async (timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    do {
      const ready = await probe(
        `Boolean(document.querySelector('.chart-panel .js-plotly-plot'))`,
      );
      if (ready) return true;
      await sleep(400);
    } while (Date.now() < deadline);
    return false;
  };

  const startup = await waitForApp();
  if (!startup.ready) {
    const detail = startup.error
      ? `: ${startup.error.replace(/\s+/g, ' ').slice(0, 400)}`
      : ` within ${READY_TIMEOUT_MS} ms`;
    console.error(`SMOKE FAILED: app did not initialise${detail}`);
    if (pageErrors.length) {
      console.error(`page errors:\n  ${pageErrors.join('\n  ')}`);
    }
    process.exit(1);
  }
  // Let the first frame settle: shader compilation, texture upload, fly-home.
  await sleep(1500);

  const first = await probe(`
    (() => {
      const w = window.__WSC__;
      if (!w) {
        // Surface whatever bootstrap wrote on screen: "no data at data/ports.json"
        // is far more actionable than "window.__WSC__ missing".
        const overlay = document.querySelector('.overlay--error');
        return {
          ready: false,
          initError: overlay ? overlay.textContent : null,
        };
      }
      const vessels = w.layers.find((l) => l.id === 'vessels');
      const shown = vessels.primitives.filter((p) => p.show).length;
      const bar = document.querySelector('.timebar');
      const box = bar ? bar.getBoundingClientRect() : null;

      // Every visible vessel must sit on its own route polyline. This is the
      // end-to-end guard against the antimeridian sampling bug, where vessels
      // were drawn thousands of nautical miles off the route (over land).
      const routeById = new Map(w.model.routes.map((route) => [route.id, route]));
      const tracks = w.model.motion ? w.model.motion.vessels : [];
      const toVec = (lon, lat) => Cesium.Cartesian3.fromDegrees(lon, lat, 0);
      const crossTrackNm = (point, a, b) => {
        const P = toVec(point[0], point[1]);
        const A = toVec(a[0], a[1]);
        const B = toVec(b[0], b[1]);
        const n = Cesium.Cartesian3.cross(A, B, new Cesium.Cartesian3());
        const length = Cesium.Cartesian3.magnitude(n);
        if (length < 1e-9) return Cesium.Cartesian3.distance(P, A) / 1852;
        Cesium.Cartesian3.divideByScalar(n, length, n);
        const sinAngle =
          Math.abs(Cesium.Cartesian3.dot(P, n)) /
          Cesium.Cartesian3.magnitude(P);
        const greatCircle =
          (Math.asin(Math.min(1, sinAngle)) * 6371008.8) / 1852;
        const toA = Cesium.Cartesian3.distance(P, A) / 1852;
        const toB = Cesium.Cartesian3.distance(P, B) / 1852;
        return Math.min(greatCircle, toA, toB);
      };
      let maxOffRouteNm = 0;
      let worstOffRoute = null;
      for (let i = 0; i < vessels.primitives.length; i += 1) {
        const primitive = vessels.primitives[i];
        if (!primitive.show) continue;
        const track = tracks[i];
        const route = track ? routeById.get(track.routeId) : null;
        if (!route || route.waypoints.length < 2) continue;
        const carto = Cesium.Cartographic.fromCartesian(primitive.position);
        const point = [
          Cesium.Math.toDegrees(carto.longitude),
          Cesium.Math.toDegrees(carto.latitude),
        ];
        let best = Number.POSITIVE_INFINITY;
        for (let j = 1; j < route.waypoints.length; j += 1) {
          const distance = crossTrackNm(
            point,
            route.waypoints[j - 1],
            route.waypoints[j],
          );
          if (distance < best) best = distance;
        }
        if (best > maxOffRouteNm) {
          maxOffRouteNm = best;
          worstOffRoute = {
            id: track.vesselId,
            route: track.routeId,
            nm: Math.round(best),
          };
        }
      }

      const disruptionLayer = w.layers.find((l) => l.id === 'disruptions');
      const disruptionItems = disruptionLayer ? disruptionLayer.items.length : 0;
      const congestedLegs = disruptionLayer
        ? disruptionLayer.items.filter(
            (item) => item.disruption.type === 'congested_leg',
          ).length
        : 0;
      const congestedWithGeometry = disruptionLayer
        ? disruptionLayer.items.filter(
            (item) =>
              item.disruption.type === 'congested_leg' &&
              item.polylines.length > 0,
          ).length
        : 0;

      const chartPanel = document.querySelector('.chart-panel');
      const chartTabs = chartPanel
        ? chartPanel.querySelectorAll('.chart-panel__tab').length
        : 0;
      const chartReady = Boolean(
        chartPanel && chartPanel.querySelector('.js-plotly-plot'),
      );
      const presetButtons = document.querySelectorAll('.preset-button').length;
      const warmUpToggle = Boolean(document.querySelector('.warmup-toggle'));
      const sheet = document.querySelector('.mobile-sheet');

      // Visible globe window, in degrees. Framing bugs (antimeridian,
      // portrait aspect) show up here immediately.
      const viewRect = (() => {
        const rectangle = w.viewer.camera.computeViewRectangle();
        if (!rectangle) return null;
        return [
          Math.round(Cesium.Math.toDegrees(rectangle.west)),
          Math.round(Cesium.Math.toDegrees(rectangle.south)),
          Math.round(Cesium.Math.toDegrees(rectangle.east)),
          Math.round(Cesium.Math.toDegrees(rectangle.north)),
        ];
      })();

      return {
        ready: true,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        viewRect,
        cameraHeightKm: Math.round(w.viewer.camera.positionCartographic.height / 1000),
        sheet: Boolean(sheet),
        sheetOpen: Boolean(sheet && sheet.classList.contains('is-open')),
        sheetHasDetails: Boolean(sheet && sheet.querySelector('.details')),
        sheetHasCharts: Boolean(sheet && sheet.querySelector('.chart-panel')),
        dockHasTimebar: Boolean(
          sheet && sheet.querySelector('.mobile-sheet__dock .timebar'),
        ),
        timebarInViewport: (() => {
          const bar = document.querySelector('.timebar');
          if (!bar) return false;
          const rect = bar.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= window.innerHeight + 1;
        })(),
        maxOffRouteNm: Math.round(maxOffRouteNm),
        worstOffRoute,
        disruptionItems,
        congestedLegs,
        congestedWithGeometry,
        chartTabs,
        chartReady,
        presetButtons,
        warmUpToggle,
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
        isPlaceholder: w.model.isPlaceholderMotion,
        hasPlaceholderWarning: Boolean(document.querySelector('.hud__warn')),
        motionStart: w.model.motion ? w.model.motion.startDay : null,
        viewEnd:
          Cesium.JulianDate.secondsDifference(
            w.viewer.clock.stopTime,
            Cesium.JulianDate.fromIso8601('2026-01-01T00:00:00Z'),
          ) / 86400,
        positions: vessels.primitives
          .filter((primitive) => primitive.show)
          .map((primitive) => {
            const carto = Cesium.Cartographic.fromCartesian(primitive.position);
            return [carto.longitude, carto.latitude];
          }),
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
      if (!w) return { ready: false, day: Number.NaN, first: null };
      const vessels = w.layers.find((l) => l.id === 'vessels');
      return {
        ready: true,
        day: Cesium.JulianDate.secondsDifference(
          w.viewer.clock.currentTime,
          Cesium.JulianDate.fromIso8601('2026-01-01T00:00:00Z')) / 86400,
        first: vessels.primitives.length
          ? Cesium.Cartographic.fromCartesian(vessels.primitives[0].position)
          : null,
        positions: vessels.primitives
          .filter((primitive) => primitive.show)
          .map((primitive) => {
            const carto = Cesium.Cartographic.fromCartesian(primitive.position);
            return [carto.longitude, carto.latitude];
          }),
      };
    })()
  `);

  // The first probe sampled the chart as soon as the app was up; give the
  // lazy Plotly chunk a real chance before the screenshot and the assertions.
  first.chartReady = await waitForChart();

  let shot = null;
  try {
    shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  } catch (error) {    console.warn(
      'screenshot skipped:',
      error instanceof Error ? error.message : error,
    );
  }
  if (shot) saveShot(MOBILE ? 'smoke-mobile.png' : 'smoke-screenshot.png', shot.data);

  // Render throttling: a paused scene must stop drawing. Cesium's clock keeps
  // ticking every animation frame, so counting `postRender` over a quiet
  // second is the only way to tell "requestRenderMode works" from "we ask for
  // a frame every frame". A handful of frames is allowed for settling.
  await probe(`
    (() => {
      const w = window.__WSC__;
      w.viewer.clock.shouldAnimate = false;
      w.__idleFrames = 0;
      w.viewer.scene.postRender.addEventListener(() => {
        w.__idleFrames += 1;
      });
      return true;
    })()
  `);
  await sleep(1200);
  const idle = await probe(`({ frames: window.__WSC__.__idleFrames })`);

  // Exercise the event bus end to end. This is deliberately after the
  // screenshot so the saved image still shows the initial scene.
  const interaction = await probe(`
    (() => {
      const w = window.__WSC__;
      if (!w) return { ready: false };

      const result = { ready: true };

      // "Next disruption" jumps to the first event start (Day 40) and pauses.
      const nextButton = [...document.querySelectorAll('.timebar__button')].find(
        (button) => button.textContent.includes('下一扰动'),
      );
      if (nextButton) nextButton.click();
      result.disruptionDay = Cesium.JulianDate.secondsDifference(
        w.viewer.clock.currentTime,
        Cesium.JulianDate.fromIso8601('2026-01-01T00:00:00Z')) / 86400;
      result.disruptionPaused = !w.viewer.clock.shouldAnimate;

      // Chart hover -> clock seek + pause.
      w.bus.emit('chart:hover', { series: 'att', day: 120 });
      result.chartSeekDay = Cesium.JulianDate.secondsDifference(
        w.viewer.clock.currentTime,
        Cesium.JulianDate.fromIso8601('2026-01-01T00:00:00Z')) / 86400;
      result.playingAfterSeek = w.viewer.clock.shouldAnimate;

      // Chart click -> selection -> HUD details + ports tab.
      w.bus.emit('selection:changed', {
        payload: { kind: 'port', id: 'shanghai', label: 'Shanghai' },
        source: 'chart',
      });
      result.detailsTitle =
        document.querySelector('.details__title')?.textContent ?? '';
      result.activeTab =
        document.querySelector('.chart-panel__tab.is-active')?.textContent ?? '';

      // Warm-up toggle -> clock range expands to Day -140.
      const warm = document.querySelector('.warmup-toggle');
      if (warm) {
        warm.checked = true;
        warm.dispatchEvent(new Event('change', { bubbles: true }));
      }
      result.clockStart = Cesium.JulianDate.toDate(
        w.viewer.clock.startTime).toISOString();
      result.clockNow = Cesium.JulianDate.toDate(
        w.viewer.clock.currentTime).toISOString();
      result.timebar =
        document.querySelector('.timebar__readout')?.textContent ?? '';
      return result;
    })()
  `);

  let interactionShot = null;
  try {
    interactionShot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
    });
  } catch (error) {
    console.warn(
      'interaction screenshot skipped:',
      error instanceof Error ? error.message : error,
    );
  }
  if (interactionShot) {
    saveShot(
      MOBILE ? 'smoke-mobile-interaction.png' : 'smoke-interaction.png',
      interactionShot.data,
    );
  }

  // Mobile: capture the sheet open, which is where details/layers/charts live.
  let gesture = null;
  if (MOBILE) {
    await probe(`
      (() => {
        const tap = (y) => {
          const handle = document.querySelector('.mobile-sheet__handle');
          if (!handle) return;
          for (const type of ['pointerdown', 'pointerup']) {
            handle.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerId: 1,
                pointerType: 'touch',
                clientY: y,
              }),
            );
          }
        };
        tap(700);
        return true;
      })()
    `);
    await sleep(500);
    try {
      const sheetShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      saveShot('smoke-mobile-sheet.png', sheetShot.data);
    } catch (error) {
      console.warn('sheet screenshot skipped:', error instanceof Error ? error.message : error);
    }

    // Drag the handle instead of clicking it: down 320 px must close, up 320 px
    // must open again. Synthetic PointerEvents exercise the same code path as
    // a finger (capture is unavailable, which the handler tolerates).
    gesture = await probe(`
      (() => {
        const handle = document.querySelector('.mobile-sheet__handle');
        const sheet = document.querySelector('.mobile-sheet');
        if (!handle || !sheet) return { ok: false };
        const fire = (type, y) =>
          handle.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 1,
              pointerType: 'touch',
              clientY: y,
            }),
          );
        const isOpen = () => sheet.classList.contains('is-open');

        const before = isOpen();
        fire('pointerdown', 200);
        fire('pointermove', 360);
        const midDrag = sheet.dataset.drag ?? null;
        fire('pointermove', 520);
        fire('pointerup', 520);
        const afterDown = isOpen();

        fire('pointerdown', 600);
        fire('pointermove', 440);
        fire('pointermove', 280);
        fire('pointerup', 280);
        const afterUp = isOpen();

        return {
          ok: true,
          before,
          afterDown,
          afterUp,
          dock: sheet.dataset.dock ?? null,
          midDrag,
          height: Math.round(sheet.offsetHeight),
        };
      })()
    `);

    // Leave the sheet closed for the rotation check.
    await probe(`
      (() => {
        const sheet = document.querySelector('.mobile-sheet');
        if (sheet && sheet.classList.contains('is-open')) {
        const tap = (y) => {
          const handle = document.querySelector('.mobile-sheet__handle');
          if (!handle) return;
          for (const type of ['pointerdown', 'pointerup']) {
            handle.dispatchEvent(
              new PointerEvent(type, {
                bubbles: true,
                cancelable: true,
                pointerId: 1,
                pointerType: 'touch',
                clientY: y,
              }),
            );
          }
        };
          tap(700);
        }
        return true;
      })()
    `);
    await sleep(300);
  }

  // Mobile rotation: 844x390 is wider than the 640 px breakpoint, so the app
  // must put the panels back on the globe and drop the sheet entirely.
  let rotation = null;
  if (MOBILE) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 844,
      height: 390,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await sleep(600);
    rotation = await probe(`
      (() => {
        const details = document.querySelector('.hud--right');
        const chart = document.querySelector('.chart-panel');
        return {
          width: window.innerWidth,
          sheet: Boolean(document.querySelector('.mobile-sheet')),
          detailsInSheet: Boolean(details && details.closest('.mobile-sheet')),
          chartInSheet: Boolean(chart && chart.closest('.mobile-sheet')),
        };
      })()
    `);
  }

  // Optional close-up (`WSC_ZOOM=1`): the land wash exists so that land and
  // sea stay distinguishable when zoomed in, and that is impossible to judge
  // from a whole-globe screenshot.
  if (process.env.WSC_ZOOM === '1' && !MOBILE) {
    await probe(`
      (() => {
        const w = window.__WSC__;
        const port =
          w.model.ports.find((item) => item.id === 'shanghai') ?? w.model.ports[0];
        w.viewer.clock.shouldAnimate = false;
        w.viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(port.lon, port.lat, 900000),
          duration: 0,
        });
        w.viewer.scene.requestRender();
        return true;
      })()
    `);
    await sleep(900);
    try {
      const zoomShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      saveShot('smoke-zoom.png', zoomShot.data);

      // 2x crop around the view centre: texture resolution and edge alignment
      // are only judgeable at pixel level.
      const detail = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 300, y: 80, width: 520, height: 360, scale: 2 },
      });
      saveShot('smoke-zoom-detail.png', detail.data);

      // Same camera, wash switched off: an A/B for how much contrast the tile
      // actually adds, and the fastest way to tell a texture artefact from a
      // globe/shading effect.
      await probe(`
        (() => {
          const w = window.__WSC__;
          w.layers.find((layer) => layer.id === 'landwash')?.setVisible(false);
          w.viewer.scene.requestRender();
          return true;
        })()
      `);
      await sleep(600);
      const noWash = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 300, y: 80, width: 520, height: 360, scale: 2 },
      });
      saveShot('smoke-zoom-nowash.png', noWash.data);
      await probe(`
        (() => {
          const w = window.__WSC__;
          w.layers.find((layer) => layer.id === 'landwash')?.setVisible(true);
          w.viewer.scene.requestRender();
          return true;
        })()
      `);
    } catch (error) {
      console.warn(
        'zoom screenshot skipped:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  // Exercise the third tab (heatmap) as well; the selection above already
  // exercised the port-bar tab. Phones drop this tab: a 22x22 matrix at 390 px
  // gives ~14 px cells, below the touch target minimum.
  let odProbe = { ready: true, active: '', skipped: true };
  if (!MOBILE) {
  await probe(`
    (() => {
      const tabs = [...document.querySelectorAll('.chart-panel__tab')];
      tabs.find((tab) => tab.textContent.includes('OD'))?.click();
      return true;
    })()
  `);
  await sleep(900);
  odProbe = await probe(`
    (() => {
      const panel = document.querySelector('.chart-panel');
      return {
        active: document.querySelector('.chart-panel__tab.is-active')?.textContent ?? '',
        ready: Boolean(panel && panel.querySelector('.js-plotly-plot')),
      };
    })()
  `);
  }

  const firstPositions = first.positions ?? [];
  const secondPositions = second.positions ?? [];
  let movedCount = 0;
  for (
    let i = 0;
    i < Math.min(firstPositions.length, secondPositions.length);
    i += 1
  ) {
    if (
      Math.abs(firstPositions[i][0] - secondPositions[i][0]) > 1e-9 ||
      Math.abs(firstPositions[i][1] - secondPositions[i][1]) > 1e-9
    ) {
      movedCount += 1;
    }
  }
  const moved = movedCount > 0;

  const { positions: _firstPositions, ...firstSummary } = first;

  console.log('--- smoke result ---');
  console.log(
    JSON.stringify(
      {
        ...firstSummary,
        dayLater: second.day,
        moved,
        movedCount,
        idleFrames: idle.frames,
        interaction,
        gesture,
        rotation,
        odProbe,
      },
      null,
      2,
    ),
  );
  console.log(
    SAVE_SHOTS
      ? `screenshot -> ${MOBILE ? 'smoke-mobile.png' : 'smoke-screenshot.png'}`
      : 'screenshot skipped (WSC_SHOTS=0)',
  );
  if (consoleErrors.length) {
    console.log('--- console errors/warnings ---');
    for (const line of consoleErrors) console.log(line);
  }
  if (pageErrors.length) {
    console.log('--- page errors ---');
    for (const line of pageErrors) console.log(line);
  }

  const failures = [];
  if (!first.ready) {
    failures.push(
      first.initError
        ? `app did not initialise: ${first.initError.replace(/\s+/g, ' ').slice(0, 300)}`
        : 'app did not initialise (window.__WSC__ missing)',
    );
  }
  if (!first.vesselShown) failures.push('no vessels are visible');
  if (first.isPlaceholder !== !REAL) {
    failures.push(
      `provider mismatch: isPlaceholder=${first.isPlaceholder}, expected ${!REAL}`,
    );
  }
  if (first.hasPlaceholderWarning !== !REAL) {
    failures.push(
      `placeholder banner mismatch: found=${first.hasPlaceholderWarning}, expected ${!REAL}`,
    );
  }
  if (!REAL && first.vesselTotal !== 43) {
    failures.push(`expected 43 placeholder vessels, found ${first.vesselTotal}`);
  }
  if (first.maxOffRouteNm > 10) {
    failures.push(
      `vessel ${first.worstOffRoute?.id ?? '?'} is ${first.maxOffRouteNm} nm off route`,
    );
  }
  if (first.disruptionItems !== 8) {
    failures.push(
      `expected 8 disruption overlays, found ${first.disruptionItems}`,
    );
  }
  if (first.congestedWithGeometry !== first.congestedLegs) {
    failures.push(
      `${first.congestedLegs - first.congestedWithGeometry} congested legs have no route geometry`,
    );
  }
  const expectedTabs = MOBILE ? 2 : 3;
  if (first.chartTabs !== expectedTabs) {
    failures.push(`expected ${expectedTabs} chart tabs, found ${first.chartTabs}`);
  }
  if (MOBILE) {
    if (first.viewport.w > 640) {
      failures.push(`viewport override failed (width ${first.viewport.w})`);
    }
    if (!first.sheet) failures.push('mobile layout: bottom sheet is missing');
    if (!first.sheetHasDetails) {
      failures.push('mobile layout: details panel was not moved into the sheet');
    }
    if (!first.sheetHasCharts) {
      failures.push('mobile layout: chart panel was not moved into the sheet');
    }
    if (!first.dockHasTimebar) {
      failures.push('mobile layout: the time bar is not docked in the sheet');
    }
    if (!first.timebarInViewport) {
      failures.push('mobile layout: the time bar is outside the viewport');
    }
    if (
      rotation &&
      (rotation.sheet || rotation.detailsInSheet || rotation.chartInSheet)
    ) {
      failures.push(
        `landscape rotation did not restore the floating layout (${JSON.stringify(rotation)})`,
      );
    }
    if (!gesture || !gesture.ok) {
      failures.push('mobile sheet: the drag probe could not run');
    } else {
      if (!gesture.before) {
        failures.push('mobile sheet: expected it to be open before the drag test');
      }
      if (gesture.afterDown) {
        failures.push('mobile sheet: dragging the handle down did not close it');
      }
      if (!gesture.afterUp) {
        failures.push('mobile sheet: dragging the handle up did not open it');
      }
    }
  } else if (first.sheet) {
    failures.push('desktop layout: the mobile sheet should not exist');
  }
  if (!first.chartReady) {
    failures.push('chart panel did not render a Plotly chart');
  }
  if (first.presetButtons !== 4) {
    failures.push(`expected 4 camera presets, found ${first.presetButtons}`);
  }
  if (!first.warmUpToggle) {
    failures.push('warm-up toggle is missing');
  }
  const expectedSeek = Math.min(120, first.viewEnd ?? 360);
  const effectiveWarmUp = REAL
    ? Math.max(0, Math.round(-(first.motionStart ?? 0)))
    : EXPECTED_WARM_UP_DAYS;
  const expectedWarmUpDate = new Date(
    Date.UTC(2026, 0, 1) - effectiveWarmUp * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);

  if (!interaction.ready) {
    failures.push('interaction probe could not read __WSC__');
  } else {
    if (!REAL) {
      if (Math.abs(interaction.disruptionDay - 40) > 0.1) {
        failures.push(
          `"next disruption" did not jump to Day 40 (got ${interaction.disruptionDay})`,
        );
      }
      if (interaction.disruptionPaused !== true) {
        failures.push('"next disruption" did not pause the clock');
      }
    }
    if (Math.abs(interaction.chartSeekDay - expectedSeek) > 0.1) {
      failures.push(
        `chart hover did not seek the clock to day ${expectedSeek} (got ${interaction.chartSeekDay})`,
      );
    }
    if (interaction.playingAfterSeek !== false) {
      failures.push('chart hover did not pause the clock');
    }
    if (interaction.detailsTitle !== 'Shanghai') {
      failures.push(
        `chart selection did not update the details panel (got "${interaction.detailsTitle}")`,
      );
    }
    if (!interaction.activeTab.includes('港口')) {
      failures.push(
        `chart selection did not switch to the port tab (got "${interaction.activeTab}")`,
      );
    }
    if (!interaction.clockStart.startsWith(expectedWarmUpDate)) {
      failures.push(
        `warm-up toggle did not expand the clock to Day -${effectiveWarmUp} (start ${interaction.clockStart}, expected ${expectedWarmUpDate})`,
      );
    }
    if (!interaction.timebar.includes(`-${effectiveWarmUp}`)) {
      failures.push(
        `time bar did not show the warm-up range (got "${interaction.timebar}")`,
      );
    }
  }
  if (!MOBILE) {
    if (!odProbe.ready) {
      failures.push('OD heatmap did not render');
    }
    if (!odProbe.active.includes('OD')) {
      failures.push(`OD tab did not activate (got "${odProbe.active}")`);
    }
  }
  if (!(second.day > first.day)) failures.push('clock is not advancing');
  if (first.skyBox !== 'none') failures.push('star sky box is present (should be disabled)');
  if (!moved) failures.push('vessels did not change position over 2.5 s');
  if (idle.frames > 5) {
    failures.push(
      `paused scene rendered ${idle.frames} frames in 1.2 s (requestRenderMode is not throttling)`,
    );
  }
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
