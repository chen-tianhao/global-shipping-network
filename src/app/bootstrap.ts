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
import type { PickPayload } from '../data/types';
import { createEventBus } from '../ui/eventBus';
import { createChartPanel } from '../ui/charts/chartPanel';
import { createHud } from '../ui/hud';
import { createTimeBar } from '../ui/timeBar';
import { createTooltip } from '../ui/tooltip';
import { el } from '../ui/dom';
import { describeBaseLayer, resolveConfig } from './config';

export async function bootstrap(mount: {
  cesium: HTMLElement;
  ui: HTMLElement;
}): Promise<void> {
  const config = resolveConfig();
  const bus = createEventBus();

  const loading = el('div', 'overlay', '正在加载网络与仿真数据 …');
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
      const wash = await LandWashLayer.create(
        `${config.dataBaseUrl.replace(/\/$/, '')}/landmask.png`,
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
      baseLayerLabel: bundle.baseLayerActive
        ? describeBaseLayer(config)
        : `${describeBaseLayer(config)}（无瓦片）`,
      isPlaceholderMotion: motionProvider.isPlaceholder,
      motionLabel: motionProvider.isPlaceholder
        ? '占位合成'
        : `真实轨迹 ${Math.round(motion.startDay)}…${Math.round(
            motion.endDay,
          )}`,
      showWarmUp: config.showWarmUp,
      warmUpDays,
      onToggleLayer: (id, visible) => {
        bus.emit('layer:toggled', { layerId: id, visible });
      },
      onWarmUpChange: (show) => applyWarmUpRange(show),
      onPreset: (preset) => {
        bus.emit('viewport:changed', { preset });
      },
    });

    const chartPanel = createChartPanel(chartRoot, model, bus);

    // ---- event wiring -----------------------------------------------------
    bus.on('selection:changed', ({ payload, source, ids }) => {
      hud.setSelected(payload);
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
          `${kindLabel(payload.kind)} · ${payload.label}`,
          clientX,
          clientY,
        );
      },
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
      el('div', 'overlay overlay--error', `初始化失败：${describe(error)}`),
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

function kindLabel(kind: PickPayload['kind']): string {
  if (kind === 'port') return '港口';
  if (kind === 'route') return '航线';
  if (kind === 'vessel') return '船舶';
  return '扰动';
}

function highlight(layers: SceneLayer[], ids: string[]): void {
  for (const layer of layers) layer.highlight(ids);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
