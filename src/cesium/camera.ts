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
  const rectangle = boundsOf(route.waypoints as Array<readonly [number, number]>);
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
 * Longitudes are normalised, so a network spanning the Pacific is framed the
 * short way round rather than as a full 360 degree wrap.
 */
function boundsOf(points: Array<readonly [number, number]>): Rectangle | null {
  if (points.length === 0) return null;

  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const [lon, lat] of points) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }

  const padLon = Math.max((east - west) * DEFAULT_PADDING, 2);
  const padLat = Math.max((north - south) * DEFAULT_PADDING, 2);

  south = Math.max(-85, south - padLat);
  north = Math.min(85, north + padLat);
  west = Math.max(-180, west - padLon);
  east = Math.min(180, east + padLon);

  return Rectangle.fromDegrees(west, south, east, north);
}
