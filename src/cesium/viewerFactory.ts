/**
 * Viewer construction. This is the only module that wires Cesium to the app.
 *
 * Hard rules enforced here:
 *  - no Cesium Ion asset is requested (no ion imagery, no ion terrain), so the
 *    app runs fully offline and needs no token;
 *  - the base map comes from the pluggable `BaseLayerProvider` seam;
 *  - widget chrome is trimmed to the timeline and animation controls.
 */

import {
  ClockRange,
  Color,
  JulianDate,
  Viewer,
  type ImageryProvider,
} from 'cesium';
import { createBaseLayerProvider, type BaseLayerRuntimeConfig } from './baseLayer/baseLayerProvider';

export interface CreateViewerOptions {
  container: HTMLElement;
  baseLayerId: string;
  baseLayerConfig?: BaseLayerRuntimeConfig;
  startJulian: JulianDate;
  stopJulian: JulianDate;
}

export interface ViewerBundle {
  viewer: Viewer;
  baseLayerId: string;
  baseLayerActive: boolean;
}

export async function createViewer(options: CreateViewerOptions): Promise<ViewerBundle> {
  const { container, baseLayerId, baseLayerConfig, startJulian, stopJulian } = options;

  const provider = createBaseLayerProvider(baseLayerId, baseLayerConfig ?? {});
  let imagery: ImageryProvider | null = null;
  try {
    imagery = await provider.createImageryProvider();
  } catch (error) {
    console.warn(`[baseLayer] "${baseLayerId}" failed to initialise:`, error);
  }

  const viewer = new Viewer(container, {
    // `false` disables the default Ion imagery entirely.
    baseLayer: false,
    // `false` suppresses the default star sky box outright: Cesium then never
    // creates the SkyBox, nor its Sun/Moon and their bloom passes, so the six
    // cube-map textures are never even requested. Doing it here (rather than
    // `show = false` afterwards) is what actually frees the resource. The space
    // background is then just `scene.backgroundColor` below, which costs one
    // clear per frame instead of a textured full-screen draw.
    skyBox: false,
    // The custom top strip owns play/pause and speed; Cesium only draws the
    // draggable timeline.
    animation: false,
    timeline: true,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    requestRenderMode: true,
    maximumRenderTimeChange: 0.05,
    contextOptions: { webgl: { preserveDrawingBuffer: true } },
  });

  // Trim Cesium's default credit/logo chrome.
  const credit = viewer.cesiumWidget.creditContainer as HTMLElement | undefined;
  if (credit) credit.style.display = 'none';

  viewer.scene.globe.baseColor = Color.fromCssColorString('#0b1a2b');
  viewer.scene.globe.showGroundAtmosphere = false;
  // Visible because there is no sky box; this is the whole "space background".
  viewer.scene.backgroundColor = Color.fromCssColorString('#050b16');
  // The single rim glow around the globe is kept: it is one cheap full-screen
  // shader pass and it is what makes the dark globe readable against the
  // background. It is driven by clock time, not by the removed Sun object.
  if (viewer.scene.skyAtmosphere) {
    viewer.scene.skyAtmosphere.show = true;
  }

  if (imagery) {
    viewer.imageryLayers.addImageryProvider(imagery);
  }

  viewer.clock.startTime = startJulian;
  viewer.clock.stopTime = stopJulian;
  viewer.clock.currentTime = startJulian;
  // LOOP_STOP wraps back to the start after the last day. CLAMPED (the numeric
  // value this used to be) silently freezes at stopTime: the clock keeps
  // ticking, the play button still reads "pause", and nothing happens.
  viewer.clock.clockRange = ClockRange.LOOP_STOP;
  viewer.clock.multiplier = 3600; // one wall-clock second ~= one simulation hour

  // The timeline widget zooms to the clock's *default* range (now -> now+1d)
  // during construction, i.e. before the simulation range is assigned above.
  // Re-zoom, otherwise its tick labels and drag mapping are plain wrong.
  viewer.timeline?.zoomTo(startJulian, stopJulian);

  viewer.scene.globe.depthTestAgainstTerrain = false;

  return {
    viewer,
    baseLayerId: provider.id,
    baseLayerActive: imagery !== null,
  };
}
