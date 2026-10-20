/**
 * Camera helpers. All framing is expressed in business terms (a port, a route,
 * the whole network) so callers never build Cesium geometry themselves.
 */

import {
  Cartesian3,
  Ellipsoid,
  Math as CesiumMath,
  Rectangle,
  type Viewer,
} from 'cesium';
import type { PortVM, RouteVM } from '../data/types';
import { normalizeLon, shortestLongitudeSpan } from '../data/geo/geoMath';
import { CAMERA_PRESETS, type CameraPreset } from '../viewmodel/cameraPresets';

const DEFAULT_PADDING = 0.12;

/** Frame every port in the network. */
export function flyToHome(viewer: Viewer, ports: PortVM[]): void {
  const rectangle = boundsOf(ports.map((port) => [port.lon, port.lat]));
  // One frame of slack: at bootstrap the canvas may still carry its pre-layout
  // size, and `Camera.flyTo(rectangle)` bakes the aspect ratio into the chosen
  // distance. On a phone that produced a 5,300 km view of Europe instead of a
  // globe, because the fit ran against a 300x150 canvas.
  requestAnimationFrame(() => {
    if (!rectangle) {
      viewer.camera.flyHome(0);
      return;
    }
    flyToRectangle(viewer, rectangle, 0);
  });
}

export function flyToPort(viewer: Viewer, port: PortVM, rangeMeters = 9.0e5): void {
  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(port.lon, port.lat, rangeMeters),
    orientation: { heading: 0, pitch: CesiumMath.toRadians(-60), roll: 0 },
    duration: 0.8,
  });
}

export function flyToRoute(viewer: Viewer, route: RouteVM): void {
  flyToPoints(viewer, route.waypoints as Array<readonly [number, number]>);
}

/** Frame an arbitrary set of points (used by disruption overlays). */
export function flyToPoints(
  viewer: Viewer,
  points: Array<readonly [number, number]>,
): void {
  const rectangle = boundsOf(points);
  if (!rectangle) return;
  flyToRectangle(viewer, rectangle, 0.8);
}

/**
 * Frame a rectangle, falling back to "fit the whole globe" when the span
 * cannot fit horizontally.
 *
 * `Camera.flyTo(rectangle)` always tries to fit the rectangle, which for a
 * 269-degree network on a portrait phone means asking the camera to show more
 * than the 30-degree horizontal field of view: the result is an arbitrary and
 * useless distance. In that case we fit the sphere itself, so the globe fills
 * the narrow screen and the user zooms in from there.
 */
function flyToRectangle(viewer: Viewer, rectangle: Rectangle, duration: number): void {
  const camera = viewer.camera;
  const canvas = viewer.scene.canvas;

  // clientWidth/Height are CSS pixels, which is what the frustum aspect uses.
  const width = canvas.clientWidth || canvas.width || 1;
  const height = canvas.clientHeight || canvas.height || 1;
  const aspect = width / Math.max(1, height);

  const frustum = camera.frustum as { fov?: number };
  // Cesium applies `fov` to the wider axis: horizontal in landscape, vertical
  // in portrait.
  const fov =
    typeof frustum.fov === 'number' ? frustum.fov : CesiumMath.toRadians(60);
  const horizontalHalf =
    aspect >= 1 ? fov / 2 : Math.atan(Math.tan(fov / 2) * aspect);
  const verticalHalf =
    aspect >= 1 ? Math.atan(Math.tan(fov / 2) / aspect) : fov / 2;

  let span = rectangle.east - rectangle.west;
  if (span < 0) span += CesiumMath.TWO_PI;
  const spanLat = rectangle.north - rectangle.south;

  // A rectangle wider than ~170 deg cannot be framed meaningfully: the camera
  // would need to show more than a hemisphere. Fit the sphere instead.
  const tooLarge = CesiumMath.toRadians(170);
  if (span > tooLarge || spanLat > tooLarge) {
    const radius = Ellipsoid.WGS84.maximumRadius;
    // Fit the silhouette to whichever axis is tighter, so a wide-but-short
    // desktop viewport does not crop the poles.
    const fitHalf = Math.min(horizontalHalf, verticalHalf);
    const distance = radius / Math.sin(fitHalf) - radius;
    const centerLon = normalizeLon(
      CesiumMath.toDegrees(rectangle.west + span / 2),
    );
    const centerLat = CesiumMath.toDegrees(
      (rectangle.north + rectangle.south) / 2,
    );
    camera.flyTo({
      destination: Cartesian3.fromDegrees(centerLon, centerLat, distance),
      duration,
    });
    return;
  }

  camera.flyTo({ destination: rectangle, duration });
}

/** Named regional presets from the HUD. */
export function flyToPreset(viewer: Viewer, preset: CameraPreset): void {
  const definition = CAMERA_PRESETS[preset];
  viewer.camera.flyTo({
    destination: Rectangle.fromDegrees(
      definition.west,
      definition.south,
      definition.east,
      definition.north,
    ),
    duration: 1.2,
  });
}

/** Keep the camera put but centre a moving vessel. */
export function lookAtVessel(viewer: Viewer, lon: number, lat: number): void {
  viewer.camera.lookAt(
    Cartesian3.fromDegrees(lon, lat, 0),
    new Cartesian3(0, 0, 1.2e6),
  );
}

/**
 * Bounding rectangle with padding. Returns null for empty input.
 *
 * Uses the *smallest* longitude interval containing the points, which is the
 * complement of the largest empty gap. Naive min/max would frame a transpacific
 * route as ~354 degrees wide and zoom out to the whole globe; this way
 * 121E..-120W becomes a ~120-degree Pacific view that crosses the antimeridian
 * (`west > east`, which `Rectangle` supports).
 */
function boundsOf(points: Array<readonly [number, number]>): Rectangle | null {
  if (points.length === 0) return null;

  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (const [, lat] of points) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }

  const longitudeSpan = shortestLongitudeSpan(points.map(([lon]) => lon));
  if (!longitudeSpan) return null;

  const padLat = Math.max((north - south) * DEFAULT_PADDING, 2);
  const padLon = Math.max(longitudeSpan.span * DEFAULT_PADDING, 2);

  south = Math.max(-85, south - padLat);
  north = Math.min(85, north + padLat);

  let west: number;
  let east: number;
  if (longitudeSpan.span + padLon * 2 >= 360) {
    // The network genuinely spans the globe; a full-world view is correct.
    west = -180;
    east = 180;
  } else {
    west = normalizeLon(longitudeSpan.west - padLon);
    east = normalizeLon(longitudeSpan.east + padLon);
  }

  return Rectangle.fromDegrees(west, south, east, north);
}
