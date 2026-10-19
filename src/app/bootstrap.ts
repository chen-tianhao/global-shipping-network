/**
 * Application wiring - the only place that knows about every other module.
 *
 * Flow: config -> data providers -> SceneModel -> Cesium viewer -> layers ->
 * render loop -> UI. Nothing else in the app reaches across these boundaries:
 *   data/      knows about files and CSVs
 *   viewmodel/ knows about business shapes only (no Cesium, no DOM)
 *   cesium/    knows about Cesium and business shapes (no files)
 *   ui/        knows about DOM and business shapes
 */

import { julianToDay, dayToJulian } from '../cesium/clock';
import { createViewer } from '../cesium/viewerFactory';
import { CoastlineLayer } from '../cesium/baseLayer/coastline';
import { DisruptionLayer } from '../cesium/layers/DisruptionLayer';
import { PortLayer } from '../cesium/layers/PortLayer';
import { RouteLayer } from '../cesium/layers/RouteLayer';
import { VesselLayer } from '../cesium/layers/VesselLayer';
import type { SceneLayer } from '../cesium/layers/SceneLayer';
import type { PickPayload } from '../cesium/layers/SceneLayer';
import { flyToHome, flyToPort, flyToRoute } from '../cesium/camera';
import { installPicking } from '../cesium/picking';
import { StaticDataProvider } from '../data/providers/staticDataProvider';
import { PlaceholderMotionProvider } from '../data/providers/placeholderMotionProvider';
import { createSceneModel, type SceneModel } from '../viewmodel/sceneModel';
import { createHud } from '../ui/hud';
import { createTimeBar } from '../ui/timeBar';
import { el } from '../ui/dom';
import { describeBaseLayer, resolveConfig } from './config';

export async function bootstrap(mount: {
  cesium: HTMLElement;
  ui: HTMLElement;
}): Promise<void> {
  const config = resolveConfig();

  const loading = el('div', 'overlay', '正在加载网络与仿真数据 …');
  mount.ui.append(loading);

  // Separate mount points: createHud clears its root, so it must not share one
  // with the time bar.
  const hudRoot = el('div');
  const timeBarRoot = el('div');
  mount.ui.append(hudRoot, timeBarRoot);

  try {
    // ---- data -------------------------------------------------------------
    const staticProvider = new StaticDataProvider();
    await staticProvider.init({ baseUrl: config.dataBaseUrl });

    const graph = await staticProvider.getStaticGraph();
    const stats = await staticProvider.getStats();
    const disruptions = await staticProvider.getDisruptions();

    const motionProvider = new PlaceholderMotionProvider();
    await motionProvider.init(config.dataBaseUrl);
    const motion = motionProvider.getMotion(config.timeRange);

    const model: SceneModel = createSceneModel({
      graph,
      motion,
      disruptions,
      stats,
      isPlaceholderMotion: true,
      timeRange: config.timeRange,
    });

    // ---- viewer -----------------------------------------------------------
    const bundle = await createViewer({
      container: mount.cesium,
      baseLayerId: config.baseLayerId,
      baseLayerConfig: config.baseLayerConfig,
      startJulian: dayToJulian(config.timeRange.startDay),
      stopJulian: dayToJulian(config.timeRange.endDay),
    });
    const viewer = bundle.viewer;
    viewer.clock.multiplier = config.clockMultiplier;

    // ---- layers -----------------------------------------------------------
    const layers: SceneLayer[] = [];
    if (config.showCoastline) {
      const coastline = await CoastlineLayer.load(config.dataBaseUrl);
      if (coastline) layers.push(coastline);
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
      startDay: config.timeRange.startDay,
      endDay: config.timeRange.endDay,
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
    });
    viewer.clock.shouldAnimate = config.autoPlay;
    syncTime = timeBar.sync;

    // ---- render loop ------------------------------------------------------
    // Single per-frame update path: layers read the clock, never each other.
    viewer.scene.preRender.addEventListener(() => {
      const day = julianToDay(viewer.clock.currentTime);
      for (const layer of layers) layer.update?.(model, day);
      syncTime?.(day);
    });
    // With requestRenderMode the scene only draws on request.
    viewer.clock.onTick.addEventListener(() => viewer.scene.requestRender());

    // ---- interaction ------------------------------------------------------
    const hud = createHud(hudRoot, model, layers, {
      baseLayerLabel: bundle.baseLayerActive
        ? describeBaseLayer(config)
        : `${describeBaseLayer(config)}（无瓦片）`,
      isPlaceholderMotion: model.isPlaceholderMotion,
      onToggleLayer: (id, visible) => {
        layers.find((layer) => layer.id === id)?.setVisible(visible);
        viewer.scene.requestRender();
      },
    });

    installPicking(viewer, {
      onPick: (payload: PickPayload | null) => {
        hud.setSelected(payload);
        if (!payload) {
          highlight(layers, []);
          return;
        }
        highlight(layers, [payload.id]);
        if (payload.kind === 'port') {
          const port = model.ports.find((item) => item.id === payload.id);
          if (port) flyToPort(viewer, port);
        } else if (payload.kind === 'route') {
          const route = model.routes.find((item) => item.id === payload.id);
          if (route) flyToRoute(viewer, route);
        }
      },
    });

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
    };
  } catch (error) {
    loading.remove();
    mount.ui.append(
      el('div', 'overlay overlay--error', `初始化失败：${describe(error)}`),
    );
    throw error;
  }
}

function highlight(layers: SceneLayer[], ids: string[]): void {
  for (const layer of layers) layer.highlight(ids);
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
