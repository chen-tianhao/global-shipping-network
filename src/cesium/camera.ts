/**
 * Camera helpers. All framing is expressed in business terms (a port, a route,
 * the whole network) so callers never build Cesium geometry themselves.
 */

import {
  Cartesian3,
  Math as CesiumMath,
  Rectangle,
  type Viewer,
} from 'cesium';
import type { PortVM, RouteVM } from '../data/types';
import { normalizeLon, shortestLongitudeSpan } from '../data/geo/geoMath';

const DEFAULT_PADDING = 0.12;

/** Frame every port in the network. */
export function flyToHome(viewer: Viewer, ports: PortVM[]): void {
  const rectangle = boundsOf(ports.map((port) => [port.lon, port.lat]));
  if (!rectangle) {
    viewer.camera.flyHome(0);
    return;
  }
  viewer.camera.flyTo({ destination: rectangle, duration: 0 });
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
  viewer.camera.flyTo({ destination: rectangle, duration: 0.8 });
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
