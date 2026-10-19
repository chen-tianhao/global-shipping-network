/**
 * PLACEHOLDER motion: synthesises constant-speed vessel movement along the
 * land-avoiding route geometry.
 *
 * Purpose is to exercise the rendering pipeline before the simulation exports
 * real trajectories. It is NOT a model of reality: there is no queueing, no
 * berth service, no disruption response. The UI must keep the
 * "placeholder data" banner visible while this provider is active - otherwise
 * viewers will read smooth sailing as a result.
 *
 * Retire this in favour of `realTrajectoryProvider` once
 * `export_trajectory.py` output is available.
 */

import { fetchJson, fetchText, parseCsv, toNumber } from '../provider';
import type {
  NetworkGraph,
  RouteVM,
  SimDay,
  TimeRange,
  VesselTrack,
  VesselTrackSet,
} from '../types';
import {
  greatCircleDistanceNm,
  initialBearingDeg,
  interpolateGreatCircle,
} from '../geo/geoMath';
import { mapPorts, mapSegments } from './shared';

/**
 * Sampling step: 1 hour, matching the plan's 37万-point estimate.
 *
 * A coarser 6-hour step made consecutive samples 120 nm apart; `VesselLayer`
 * interpolates linearly between them, so a route bend inside one step was cut
 * by up to ~18 nm - enough to clip a coastline. At 1 hour the step is 20 nm and
 * the corner cut is a few nautical miles at most.
 */
const STEP_DAYS = 1 / 24;
const DEFAULT_SPEED_KNOTS = 20;

interface VesselClassRow {
  name: string;
  capacity: number;
  speed: number;
}

export class PlaceholderMotionProvider {
  readonly id = 'placeholder-motion';

  private graph: NetworkGraph = { ports: [], routes: [] };
  private classes = new Map<string, VesselClassRow>();

  async init(baseUrl: string): Promise<NetworkGraph> {
    const root = baseUrl.replace(/\/$/, '');
    const [portsFile, routesFile, planText, classText] = await Promise.all([
      fetchJson<{ ports: Array<Record<string, unknown>> }>(`${root}/ports.json`),
      fetchJson<{ routes: Array<Record<string, unknown>> }>(`${root}/routes.json`),
      fetchText(`${root}/route_plan.csv`),
      fetchText(`${root}/vessel_classes.csv`),
    ]);

    for (const [index, row] of parseCsv(classText).entries()) {
      if (index === 0) continue;
      this.classes.set(row[0], {
        name: row[0],
        capacity: toNumber(row[1]) || 0,
        speed: toNumber(row[2]) || DEFAULT_SPEED_KNOTS,
      });
    }

    const ports = mapPorts(portsFile.ports);

    const planByRoute = new Map<string, { className: string; count: number }>();
    for (const [index, row] of parseCsv(planText).entries()) {
      if (index === 0) continue;
      planByRoute.set(row[0], { className: row[1] ?? '', count: toNumber(row[2]) || 0 });
    }

    const routes: RouteVM[] = routesFile.routes
      .filter((raw) => !Boolean(raw.isAlternative))
      .map((raw) => {
        const id = String(raw.id ?? '');
        const plan = planByRoute.get(id);
        return {
          id,
          name: String(raw.name ?? id),
          startDayOfWeek: raw.startDayOfWeek === null ? null : Number(raw.startDayOfWeek),
          waypoints: (raw.waypoints as Array<[number, number]>) ?? [],
          segments: mapSegments(raw.segments, ports),
          isAlternative: false,
          totalDistanceNm: Number(raw.totalDistanceNm ?? 0),
          vessels: plan?.count ?? 0,
          // vessel class is carried through for speed lookup
          ...(plan ? { className: plan.className } : {}),
        } as RouteVM & { className?: string };
      });

    this.graph = { ports, routes };
    return this.graph;
  }

  getStaticGraph(): NetworkGraph {
    return this.graph;
  }

  getMotion(range: TimeRange): VesselTrackSet {
    const startDay = range.startDay;
    const endDay = range.endDay;
    const frameCount = Math.max(2, Math.floor((endDay - startDay) / STEP_DAYS) + 1);
    const timeline = new Float64Array(frameCount);
    for (let i = 0; i < frameCount; i += 1) {
      timeline[i] = startDay + i * STEP_DAYS;
    }

    const vessels: VesselTrack[] = [];
    for (const route of this.graph.routes) {
      const geometry = buildGeometry(route);
      if (!geometry) continue;
      const count = route.vessels ?? 0;
      const speed = (route as RouteVM & { className?: string }).className
        ? this.classes.get((route as RouteVM & { className?: string }).className!)?.speed
        : undefined;
      for (let n = 0; n < count; n += 1) {
        vessels.push(
          buildTrack(
            `${route.id}-V${n + 1}`,
            route.id,
            geometry,
            timeline,
            count === 0 ? 0 : n / count,
            speed ?? DEFAULT_SPEED_KNOTS,
          ),
        );
      }
    }

    return { timeline, vessels, startDay, endDay, stepDays: STEP_DAYS };
  }
}

interface Geometry {
  points: ReadonlyArray<readonly [number, number]>;
  cumulativeNm: number[];
  totalNm: number;
}

function buildGeometry(route: RouteVM): Geometry | null {
  const points = route.waypoints;
  if (points.length < 2) return null;
  const cumulativeNm: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulativeNm.push(cumulativeNm[i - 1] + greatCircleDistanceNm(points[i - 1], points[i]));
  }
  return { points, cumulativeNm, totalNm: cumulativeNm[cumulativeNm.length - 1] };
}

function buildTrack(
  vesselId: string,
  routeId: string,
  geometry: Geometry,
  timeline: Float64Array,
  phase: number,
  speedKnots: number,
): VesselTrack {
  const frames = timeline.length;
  const lon = new Float32Array(frames);
  const lat = new Float32Array(frames);
  const heading = new Float32Array(frames);
  const teu = new Float32Array(frames);
  const state = new Uint8Array(frames);

  const nmPerDay = speedKnots * 24;
  const offsetNm = phase * geometry.totalNm;

  for (let f = 0; f < frames; f += 1) {
    // Positive modulo: a negative simulation day (warm-up) must not produce a
    // negative distance, which would extrapolate before the first waypoint.
    const travelledNm =
      geometry.totalNm > 0
        ? (((timeline[f] * nmPerDay + offsetNm) % geometry.totalNm) +
            geometry.totalNm) %
          geometry.totalNm
        : 0;
    const sample = sampleAlong(geometry, travelledNm);
    lon[f] = sample.lon;
    lat[f] = sample.lat;
    heading[f] = sample.heading;
    teu[f] = 0;
    state[f] = 0; // sailing
  }

  return { vesselId, routeId, lon, lat, heading, teu, state };
}

/**
 * Position `distanceNm` along the route.
 *
 * The interpolation is spherical, not linear in lon/lat, because Cesium draws
 * the route as a geodesic. Linear interpolation across a transpacific leg (or
 * across the antimeridian, where the raw longitude delta is ~±270 degrees)
 * places vessels on the wrong side of the planet - visibly on land.
 */
function sampleAlong(
  geometry: Geometry,
  distanceNm: number,
): { lon: number; lat: number; heading: number } {
  const { points, cumulativeNm, totalNm } = geometry;
  const target =
    totalNm > 0 ? ((distanceNm % totalNm) + totalNm) % totalNm : 0;

  // Binary search: at a 1-hour step the old linear scan became O(frames x
  // waypoints) and added seconds to start-up on the long routes.
  let low = 1;
  let high = cumulativeNm.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (cumulativeNm[mid] < target) low = mid + 1;
    else high = mid;
  }
  const index = low;
  const a = points[index - 1];
  const b = points[Math.min(index, points.length - 1)];
  const segmentStart = cumulativeNm[index - 1];
  const segmentLength = cumulativeNm[index] - segmentStart;
  const ratio = segmentLength > 0 ? (target - segmentStart) / segmentLength : 0;

  const [lon, lat] = interpolateGreatCircle(a, b, ratio);
  return { lon, lat, heading: initialBearingDeg(a, b) };
}

/** Cumulative-distance helper exported for the real trajectory provider. */
export type { Geometry, SimDay };
