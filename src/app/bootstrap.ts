/**
 * Application wiring - the only place that knows about every other module.
 *
 * Flow: config -> data providers -> SceneModel -> Cesium viewer -> layers ->
 * event bus -> 3D picking / HUD / charts -> render loop.
 *
 * Boundaries:
 *   data/      knows about files and CSVs
 *   viewmodel/ knows about business shapes only (no Cesium, no DOM)
 *   cesium/    knows about Cesium and business shapes (no files)
 *   ui/        knows about DOM and business shapes (no Cesium)
 */

import { julianToDay, dayToJulian } from '../cesium/clock';
import { createViewer } from '../cesium/viewerFactory';
import { CoastlineLayer } from '../cesium/baseLayer/coastline';
import { LandWashLayer } from '../cesium/baseLayer/landWash';
import { DisruptionLayer } from '../cesium/layers/DisruptionLayer';
import { PortLayer } from '../cesium/layers/PortLayer';
import { RouteLayer } from '../cesium/layers/RouteLayer';
import { VesselLayer } from '../cesium/layers/VesselLayer';
import type { SceneLayer } from '../cesium/layers/SceneLayer';
import {
  flyToHome,
  flyToPoints,
  flyToPort,
  flyToPreset,
  flyToRoute,
} from '../cesium/camera';
import { installPicking } from '../cesium/picking';
import { StaticDataProvider } from '../data/providers/staticDataProvider';
import { createMotionProvider } from '../data/providers/motionProvider';
import { loadCoastline } from '../data/loaders/coastlineLoader';
import {
  createSceneModel,
  disruptionPath,
  type SceneModel,
} from '../viewmodel/sceneModel';
import { kindLabel, payloadTitle } from '../viewmodel/labels';
import type { PickPayload } from '../data/types';
import { createEventBus } from '../ui/eventBus';
import { createChartPanel } from '../ui/charts/chartPanel';
import { createHud } from '../ui/hud';
import { createMobileSheet, MOBILE_QUERY, type MobileSheet } from '../ui/mobileSheet';
import { createTimeBar } from '../ui/timeBar';
import { createTooltip } from '../ui/tooltip';
import { el } from '../ui/dom';
import { initLocale, onLocaleChange, t } from '../i18n';
import { describeBaseLayer, resolveConfig } from './config';

export async function bootstrap(mount: {
  cesium: HTMLElement;
  ui: HTMLElement;
}): Promise<void> {
  // Resolve the language before anything renders: the dictionary is read while
  // the HUD and the time bar are built.
  initLocale();
  const config = resolveConfig();
  const bus = createEventBus();

  const loading = el('div', 'overlay', t('app.loading'));
  mount.ui.append(loading);

  // Separate mount points: createHud clears its root, and the chart panel owns
  // its own layout, so they must not share a container.
  const hudRoot = el('div');
  const timeBarRoot = el('div');
  const chartRoot = el('div');
  mount.ui.append(hudRoot, timeBarRoot, chartRoot);

  try {
    // ---- data -------------------------------------------------------------
    const staticProvider = new StaticDataProvider();
    await staticProvider.init({ baseUrl: config.dataBaseUrl });

    const graph = await staticProvider.getStaticGraph();
    const stats = await staticProvider.getStats();
    const disruptions = await staticProvider.getDisruptions();

    const motionProvider = createMotionProvider(config.providerId);
    await motionProvider.init({ baseUrl: config.dataBaseUrl });
    // Placeholder motion is generated for the full range (including warm-up);
    // real motion carries its own coverage and ignores the requested range.
    const motion = await motionProvider.getMotion(config.dataRange);

    const isRealMotion = !motionProvider.isPlaceholder;
    const warmUpDays = isRealMotion
      ? Math.max(0, Math.round(-motion.startDay))
      : config.warmUpDays;
    const viewStart = isRealMotion
      ? config.showWarmUp
        ? -warmUpDays
        : Math.max(0, motion.startDay)
      : config.timeRange.startDay;
    const viewEnd = isRealMotion ? motion.endDay : config.timeRange.endDay;
    const viewRange = { startDay: viewStart, endDay: viewEnd };

    const model: SceneModel = createSceneModel({
      graph,
      motion,
      disruptions,
      stats,
      isPlaceholderMotion: motionProvider.isPlaceholder,
      timeRange: viewRange,
    });

    // ---- viewer -----------------------------------------------------------
    const bundle = await createViewer({
      container: mount.cesium,
      baseLayerId: config.baseLayerId,
      baseLayerConfig: config.baseLayerConfig,
      startJulian: dayToJulian(viewStart),
      stopJulian: dayToJulian(viewEnd),
    });
    const viewer = bundle.viewer;
    viewer.clock.multiplier = config.clockMultiplier;

    // ---- layers -----------------------------------------------------------
    const layers: SceneLayer[] = [];
    // The wash is imagery, so it paints under every primitive. Skip it when a
    // tile base map is active: there the imagery is already the land surface.
    if (config.showLandWash && !bundle.baseLayerActive) {
      // Phones get the half-resolution tile: 4096x2048 is ~32 MB of GPU
      // memory (plus mipmaps) and some mobile GPUs cap out at 4096.
      const maskFile = window.matchMedia(MOBILE_QUERY).matches
        ? 'landmask-2k.png'
        : 'landmask.png';
      const wash = await LandWashLayer.create(
        `${config.dataBaseUrl.replace(/\/$/, '')}/${maskFile}`,
      );
      if (wash) layers.push(wash);
    }
    if (config.showCoastline) {
      const rings = await loadCoastline(config.dataBaseUrl);
      if (rings) layers.push(new CoastlineLayer(rings));
    }
    const routeLayer = new RouteLayer();
    const portLayer = new PortLayer();
    const vesselLayer = new VesselLayer();
    const disruptionLayer = new DisruptionLayer();
    layers.push(routeLayer, portLayer, disruptionLayer, vesselLayer);

    for (const layer of layers) layer.build(model, viewer);

    // ---- time controls ----------------------------------------------------
    let syncTime: ((day: number) => void) | null = null;

    const timeBar = createTimeBar(timeBarRoot, {
      startDay: viewRange.startDay,
      endDay: viewRange.endDay,
      multiplier: config.clockMultiplier,
      playing: config.autoPlay,
      onPlayChange: (playing) => {
        viewer.clock.shouldAnimate = playing;
        viewer.scene.requestRender();
      },
      onMultiplierChange: (multiplier) => {
        viewer.clock.multiplier = multiplier;
      },
      onScrub: (day) => {
        viewer.clock.currentTime = dayToJulian(day);
        viewer.scene.requestRender();
      },
      onNextDisruption: () => {
        const day = julianToDay(viewer.clock.currentTime);
        const sorted = [...model.disruptions].sort(
          (a, b) => a.startDay - b.startDay,
        );
        const inRange = sorted.filter(
          (item) => item.startDay >= viewStart && item.startDay <= viewEnd,
        );
        const next =
          inRange.find((item) => item.startDay > day + 1e-6) ?? inRange[0];
        if (!next) return;

        viewer.clock.shouldAnimate = false;
        viewer.clock.currentTime = dayToJulian(next.startDay);
        timeBar.setPlaying(false);
        viewer.scene.requestRender();
        flyToPoints(viewer, disruptionPath(model, next));
      },
    });
    viewer.clock.shouldAnimate = config.autoPlay;
    syncTime = timeBar.sync;

    // ---- HUD / charts / tooltip ------------------------------------------
    const tooltip = createTooltip(mount.ui);

    const hud = createHud(hudRoot, model, layers, {
      // Re-evaluated on every language change, so both names follow the locale.
      describeContext: () => ({
        base: bundle.baseLayerActive
          ? describeBaseLayer(config)
          : t('status.noTiles', { base: describeBaseLayer(config) }),
        motion: motionProvider.isPlaceholder
          ? t('status.motionPlaceholder')
          : t('status.motionReal', {
              start: Math.round(motion.startDay),
              end: Math.round(motion.endDay),
            }),
      }),
      isPlaceholderMotion: motionProvider.isPlaceholder,
      showWarmUp: config.showWarmUp,
      warmUpDays,
      onToggleLayer: (id, visible) => {
        bus.emit('layer:toggled', { layerId: id, visible });
      },
      onWarmUpChange: (show) => applyWarmUpRange(show),
      onPreset: (preset) => {
        bus.emit('viewport:changed', { preset });
      },
      onLocate: (payload) => flyToSelection(viewer, model, payload),
    });

    const chartPanel = createChartPanel(chartRoot, model, bus);

    // One subscription drives every dynamic label: static ones are re-written
    // by translateDom inside setLocale, these three rebuild from their state.
    onLocaleChange(() => {
      hud.refresh();
      timeBar.refresh();
      chartPanel.refresh();
      // 3D labels are primitives, not DOM: they need their text rewritten.
      disruptionLayer.relabel(model);
      viewer.scene.requestRender();
    });

    // On phones the three floating panels cannot coexist (214 + 250 + 380 px
    // on a 390 px screen). Move them into one bottom sheet, details first.
    // Rotation changes the media query, so this has to be reversible: a phone
    // held in landscape is wider than the breakpoint and must go back to the
    // floating layout instead of leaving the panels inside a hidden sheet.
    const narrowQuery = window.matchMedia(MOBILE_QUERY);
    let sheet: MobileSheet | null = null;

    function moveIntoSheet(next: MobileSheet): void {
      const detailsPanel = hudRoot.querySelector('.hud--right');
      const layersPanel = hudRoot.querySelector('.hud--left');
      if (detailsPanel) next.body.append(detailsPanel);
      if (layersPanel) next.body.append(layersPanel);
      // The time bar sits in the dock, not the scrolling body: it has to stay
      // reachable while the sheet is open, and it must not be pushed off
      // screen by a long details panel.
      next.dock.append(timeBarRoot);
      next.body.append(chartRoot);
    }

    /** Handle + dock decide how much stays visible when collapsed. */
    function syncDockHeight(): void {
      if (!sheet) return;
      sheet.setDockHeight(sheet.handle.offsetHeight + sheet.dock.offsetHeight);
    }

    function restoreFloatingLayout(): void {
      if (!sheet) return;
      const detailsPanel = sheet.body.querySelector('.hud--right');
      const layersPanel = sheet.body.querySelector('.hud--left');
      // Re-append into the original hosts, then let the sheet go.
      if (layersPanel) hudRoot.append(layersPanel);
      if (detailsPanel) hudRoot.append(detailsPanel);
      mount.ui.append(timeBarRoot);
      mount.ui.append(chartRoot);
      sheet.element.remove();
      sheet = null;
    }

    function syncLayout(): void {
      if (narrowQuery.matches && !sheet) {
        sheet = createMobileSheet(mount.ui);
        if (sheet) {
          moveIntoSheet(sheet);
          // Measure now (offsetHeight forces layout) and again after the first
          // frame, which is when web fonts have settled the row height.
          syncDockHeight();
          requestAnimationFrame(syncDockHeight);
        }
      } else if (!narrowQuery.matches && sheet) {
        restoreFloatingLayout();
      }
      // Phones keep the toggle in the status strip: the details panel is inside
      // the sheet there, so a button in its header would need the sheet opened.
      hud.setLanguageButtonPlacement(narrowQuery.matches ? 'header' : 'panel');
    }

    syncLayout();
    narrowQuery.addEventListener('change', syncLayout);
    window.addEventListener('resize', syncDockHeight);

    // ---- event wiring -----------------------------------------------------
    bus.on('selection:changed', ({ payload, source, ids }) => {
      hud.setSelected(payload);
      // On a phone the details live in the collapsed sheet; raise it so a tap
      // on a port actually shows something.
      if (sheet && payload && source === 'scene') sheet.setOpen(true);
      const highlightIds = ids ?? (payload ? [payload.id] : []);
      highlight(layers, highlightIds);
      viewer.scene.requestRender();

      if (source !== 'chart' || !payload) return;

      // An OD cell carries both endpoints; frame them together. Everything
      // else (port bar, globe double-click) focuses a single object.
      if (highlightIds.length > 1) {
        const points: Array<[number, number]> = [];
        for (const id of highlightIds) {
          const port = model.ports.find((item) => item.id === id);
          if (port) points.push([port.lon, port.lat]);
        }
        if (points.length > 1) {
          flyToPoints(viewer, points);
          return;
        }
      }

      flyToSelection(viewer, model, payload);
    });

    bus.on('layer:toggled', ({ layerId, visible }) => {
      layers.find((layer) => layer.id === layerId)?.setVisible(visible);
      viewer.scene.requestRender();
    });

    bus.on('viewport:changed', ({ preset }) => {
      flyToPreset(viewer, preset);
    });

    bus.on('chart:hover', ({ day }) => {
      // Hovering the ATT curve scrubs the clock; pause so the sought position
      // is not immediately overwritten by playback. The ATT data can cover a
      // longer horizon than the motion (real-trajectory samples are shorter),
      // so clamp to the visible clock range.
      const clamped = Math.min(viewEnd, Math.max(viewStart, day));
      viewer.clock.shouldAnimate = false;
      viewer.clock.currentTime = dayToJulian(clamped);
      timeBar.setPlaying(false);
      viewer.scene.requestRender();
    });

    // ---- render loop ------------------------------------------------------
    // Single per-frame update path: layers read the clock, never each other.
    let lastTimeEmit = Number.NaN;
    viewer.scene.preRender.addEventListener(() => {
      const day = julianToDay(viewer.clock.currentTime);
      for (const layer of layers) layer.update?.(model, day);
      syncTime?.(day);

      if (Math.abs(day - lastTimeEmit) >= 0.05) {
        lastTimeEmit = day;
        bus.emit('time:changed', {
          day,
          playing: viewer.clock.shouldAnimate,
        });
      }
    });
    // With requestRenderMode the scene only draws on request - but Cesium's
    // `clock.tick()` (and therefore this event) still fires every animation
    // frame, animated or not. Requesting a render unconditionally, as this
    // used to, meant a paused scene kept redrawing at 60 fps. Only an actual
    // change of the simulated instant is a reason to draw; interaction,
    // layer toggles and camera moves request their own frames.
    let lastRequestedDay = Number.NaN;
    viewer.clock.onTick.addEventListener(() => {
      const day = julianToDay(viewer.clock.currentTime);
      if (Math.abs(day - lastRequestedDay) < 1e-9) return;
      lastRequestedDay = day;
      viewer.scene.requestRender();
    });

    // ---- interaction ------------------------------------------------------
    installPicking(viewer, {
      onPick: (payload) => {
        bus.emit('selection:changed', { payload, source: 'scene' });
      },
      onDoublePick: (payload) => {
        if (payload) flyToSelection(viewer, model, payload);
      },
      onHover: (payload, position) => {
        if (!payload) {
          tooltip.hide();
          return;
        }
        const rect = viewer.scene.canvas.getBoundingClientRect();
        const clientX = Math.min(
          window.innerWidth - 240,
          rect.left + position.x + 14,
        );
        const clientY = Math.min(
          window.innerHeight - 40,
          rect.top + position.y + 14,
        );
        tooltip.show(
          `${kindLabel(payload.kind)} · ${payloadTitle(payload, model)}`,
          clientX,
          clientY,
        );
      },
    }, {
      // Touch has no hover, and a 3 px pick radius is unusable with a finger.
      hover: window.matchMedia('(hover: hover)').matches,
      pickRadius: window.matchMedia('(pointer: coarse)').matches ? 22 : 3,
    });

    // MOUSE_MOVE stops firing when the pointer leaves the canvas, so the last
    // tooltip would otherwise stay on screen over the HUD.
    viewer.scene.canvas.addEventListener('mouseleave', () => tooltip.hide());

    flyToHome(viewer, model.ports);
    viewer.scene.requestRender();
    loading.remove();

    // Debug handle: lets you inspect the running scene from the console and is
    // what `npm run smoke` reads. Not used by the app itself.
    (window as unknown as { __WSC__?: unknown }).__WSC__ = {
      viewer,
      model,
      layers,
      config,
      bus,
      chartPanel,
    };

    function applyWarmUpRange(show: boolean): void {
      const start = show ? -warmUpDays : 0;
      const end = viewEnd;

      viewer.clock.startTime = dayToJulian(start);
      viewer.clock.stopTime = dayToJulian(end);
      viewer.clock.currentTime = dayToJulian(start);
      viewer.timeline?.zoomTo(dayToJulian(start), dayToJulian(end));
      timeBar.setRange(start, end);
      viewer.scene.requestRender();
    }
  } catch (error) {
    loading.remove();
    mount.ui.append(
      el(
        'div',
        'overlay overlay--error',
        t('app.error', { message: describe(error) }),
      ),
    );
    throw error;
  }
}

function flyToSelection(
  viewer: Parameters<typeof flyToPort>[0],
  model: SceneModel,
  payload: PickPayload,
): void {
  if (payload.kind === 'port') {
    const port = model.ports.find((item) => item.id === payload.id);
    if (port) flyToPort(viewer, port);
    return;
  }
  if (payload.kind === 'route') {
    const route = model.routes.find((item) => item.id === payload.id);
    if (route) flyToRoute(viewer, route);
    return;
  }
  if (payload.kind === 'disruption') {
    const disruption = model.disruptions.find((item) => item.id === payload.id);
    if (disruption) flyToPoints(viewer, disruptionPath(model, disruption));
  }
}

function highlight(layers: SceneLayer[], ids: string[]): void {
  for (const layer of layers) layer.highlight(ids);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
