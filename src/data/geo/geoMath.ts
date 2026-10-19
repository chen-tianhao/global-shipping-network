/**
 * Pure spherical geometry, shared by the motion sampler, the camera framing and
 * the verification scripts.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The renderer draws *geodesic* arcs (Cesium polylines are geodesic by default
 * and `RouteLayer` sets `ArcType.GEODESIC` explicitly). Anything that places a
 * vessel between two waypoints must therefore follow the same curve. Linear
 * lon/lat interpolation does not: on a long leg the two curves diverge by
 * hundreds of kilometres, and across the antimeridian the linear path goes the
 * long way round the planet. Both errors make vessels visibly cross land even
 * though the route geometry itself was verified to be clear.
 *
 * This module deliberately has no Cesium, DOM or I/O dependency, so exactly the
 * same code that runs in the browser can be unit-tested in Node
 * (`npm run verify:motion`).
 */

export type LonLat = readonly [lon: number, lat: number];

/** Mean Earth radius in nautical miles. */
export const EARTH_RADIUS_NM = 3440.065;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Normalise longitude to [-180, 180]. */
export function normalizeLon(lon: number): number {
  let value = lon;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
}

/** Signed shortest longitude difference from `from` to `to`, in (-180, 180]. */
export function shortestDeltaLon(from: number, to: number): number {
  let delta = normalizeLon(to) - normalizeLon(from);
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  return delta;
}

/** Great-circle (haversine) distance in nautical miles. */
export function greatCircleDistanceNm(a: LonLat, b: LonLat): number {
  const phi1 = a[1] * DEG;
  const phi2 = b[1] * DEG;
  const dPhi = (b[1] - a[1]) * DEG;
  const dLambda = shortestDeltaLon(a[0], b[0]) * DEG;
  const h =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * EARTH_RADIUS_NM;
}

/**
 * Spherical linear interpolation along the *shorter* great-circle arc.
 * `f` is clamped to [0, 1]. Longitude is unwrapped before interpolation and
 * normalised afterwards, so a leg from 179.9E to 179.9W crosses the
 * antimeridian instead of travelling west across Eurasia.
 */
export function interpolateGreatCircle(a: LonLat, b: LonLat, f: number): [number, number] {
  const t = Math.min(1, Math.max(0, f));
  if (t === 0) return [normalizeLon(a[0]), a[1]];
  if (t === 1) return [normalizeLon(b[0]), b[1]];

  const phi1 = a[1] * DEG;
  const lambda1 = a[0] * DEG;
  const phi2 = b[1] * DEG;
  // Unwrap: the second longitude is expressed on the same continuous branch as
  // the first, which is what makes the interpolation follow the short arc.
  const lambda2 = lambda1 + shortestDeltaLon(a[0], b[0]) * DEG;

  const centralAngle = greatCircleDistanceNm(a, b) / EARTH_RADIUS_NM;
  if (centralAngle < 1e-12) return [normalizeLon(a[0]), a[1]];

  const sinTheta = Math.sin(centralAngle);
  const wa = Math.sin((1 - t) * centralAngle) / sinTheta;
  const wb = Math.sin(t * centralAngle) / sinTheta;

  const x = wa * Math.cos(phi1) * Math.cos(lambda1) + wb * Math.cos(phi2) * Math.cos(lambda2);
  const y = wa * Math.cos(phi1) * Math.sin(lambda1) + wb * Math.cos(phi2) * Math.sin(lambda2);
  const z = wa * Math.sin(phi1) + wb * Math.sin(phi2);

  const lat = Math.atan2(z, Math.hypot(x, y)) * RAD;
  const lon = Math.atan2(y, x) * RAD;
  return [normalizeLon(lon), lat];
}

/** Initial great-circle bearing from `a` to `b`, in degrees clockwise from north. */
export function initialBearingDeg(a: LonLat, b: LonLat): number {
  const phi1 = a[1] * DEG;
  const phi2 = b[1] * DEG;
  const dLambda = shortestDeltaLon(a[0], b[0]) * DEG;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) -
    Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) * RAD + 360) % 360;
}

/**
 * Great-circle midpoint computed independently via 3D vector addition.
 * Kept separate from `interpolateGreatCircle(..., 0.5)` so the verification
 * script can cross-check one against the other instead of comparing a function
 * with itself.
 */
export function greatCircleMidpoint(a: LonLat, b: LonLat): [number, number] {
  const phi1 = a[1] * DEG;
  const lambda1 = a[0] * DEG;
  const phi2 = b[1] * DEG;
  const lambda2 = lambda1 + shortestDeltaLon(a[0], b[0]) * DEG;

  const v1 = [
    Math.cos(phi1) * Math.cos(lambda1),
    Math.cos(phi1) * Math.sin(lambda1),
    Math.sin(phi1),
  ];
  const v2 = [
    Math.cos(phi2) * Math.cos(lambda2),
    Math.cos(phi2) * Math.sin(lambda2),
    Math.sin(phi2),
  ];
  const x = v1[0] + v2[0];
  const y = v1[1] + v2[1];
  const z = v1[2] + v2[2];
  const length = Math.hypot(x, y, z);
  if (length < 1e-12) return [normalizeLon(a[0]), a[1]];

  const nx = x / length;
  const ny = y / length;
  const nz = z / length;
  return [
    normalizeLon(Math.atan2(ny, nx) * RAD),
    Math.atan2(nz, Math.hypot(nx, ny)) * RAD,
  ];
}

export interface LongitudeSpan {
  /** Western edge; may be greater than `east` when the span crosses the antimeridian. */
  west: number;
  /** Eastern edge. */
  east: number;
  /** Width in degrees, always in [0, 360]. */
  span: number;
  /** Width of the largest empty gap, in degrees. */
  gap: number;
}

/**
 * Smallest longitude interval containing every input longitude.
 *
 * Naive min/max framing treats the Pacific as a 360-degree gap and zooms a
 * trans-Pacific route out to the whole globe. Finding the largest empty gap
 * instead makes the interval the complement of that gap, which is exactly what
 * the eye expects: 121E..-120W becomes a ~120-degree Pacific view, not 354.
 */
export function shortestLongitudeSpan(lons: number[]): LongitudeSpan | null {
  if (lons.length === 0) return null;
  const values = lons.map(normalizeLon).sort((a, b) => a - b);
  if (values.length === 1) {
    return { west: values[0], east: values[0], span: 0, gap: 360 };
  }

  let maxGap = -1;
  let gapIndex = 0;
  for (let i = 0; i < values.length; i += 1) {
    const next = i === values.length - 1 ? values[0] + 360 : values[i + 1];
    const gap = next - values[i];
    if (gap > maxGap) {
      maxGap = gap;
      gapIndex = i;
    }
  }

  const west = values[(gapIndex + 1) % values.length];
  const east = values[gapIndex];
  const span = east >= west ? east - west : east + 360 - west;
  return { west, east, span, gap: maxGap };
}
