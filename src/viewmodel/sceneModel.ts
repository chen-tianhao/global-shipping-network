/**
 * Engine-agnostic scene snapshot. Layers consume this; they never see CSV rows,
 * fetch calls, or Cesium types coming from the data layer.
 */

import type {
  DisruptionVM,
  NetworkGraph,
  PortVM,
  RouteSegmentVM,
  RouteVM,
  SimDay,
  StatBundle,
  VesselTrackSet,
} from '../data/types';

export interface SceneModel {
  ports: PortVM[];
  routes: RouteVM[];
  motion: VesselTrackSet | null;
  disruptions: DisruptionVM[];
  stats: StatBundle | null;
  /** True while motion comes from PlaceholderMotionProvider. UI must warn. */
  isPlaceholderMotion: boolean;
  timeRange: { startDay: SimDay; endDay: SimDay };
}

export function createSceneModel(parts: {
  graph: NetworkGraph;
  motion: VesselTrackSet | null;
  disruptions: DisruptionVM[];
  stats: StatBundle | null;
  isPlaceholderMotion: boolean;
  timeRange: { startDay: SimDay; endDay: SimDay };
}): SceneModel {
  return {
    ports: parts.graph.ports,
    routes: parts.graph.routes,
    motion: parts.motion,
    disruptions: parts.disruptions,
    stats: parts.stats,
    isPlaceholderMotion: parts.isPlaceholderMotion,
    timeRange: parts.timeRange,
  };
}

export function portById(model: SceneModel, id: string): PortVM | undefined {
  return model.ports.find((port) => port.id === id);
}

export function routeById(model: SceneModel, id: string): RouteVM | undefined {
  return model.routes.find((route) => route.id === id);
}

/**
 * Route legs that connect the two ports in the requested direction.
 *
 * Disruptions are directional (`departure -> arrival` in
 * `disruption_scenario.py`), so the exact direction wins. Only when no
 * forward leg exists fall back to the reverse one - otherwise a
 * Shanghai -> Shenzhen delay would also paint the Shenzhen -> Shanghai leg.
 */
export function segmentsBetween(
  model: SceneModel,
  fromPortId: string,
  toPortId: string,
): RouteSegmentVM[] {
  const forward: RouteSegmentVM[] = [];
  const reverse: RouteSegmentVM[] = [];

  for (const route of model.routes) {
    for (const segment of route.segments) {
      if (segment.fromPortId === fromPortId && segment.toPortId === toPortId) {
        forward.push(segment);
      } else if (
        segment.fromPortId === toPortId &&
        segment.toPortId === fromPortId
      ) {
        reverse.push(segment);
      }
    }
  }

  return forward.length > 0 ? forward : reverse;
}

/**
 * Geometry to frame for a disruption: the port itself for a closure, the real
 * sea-route leg for congestion. Falls back to the two port anchors when the
 * build did not emit per-leg geometry.
 */
export function disruptionPath(
  model: SceneModel,
  disruption: DisruptionVM,
): Array<[number, number]> {
  if (disruption.type === 'closed_port') {
    const port = portById(model, String(disruption.target));
    return port ? [[port.lon, port.lat]] : [];
  }

  const [fromId, toId] = disruption.target as [string, string];
  const segments = segmentsBetween(model, fromId, toId);
  if (segments.length > 0) {
    return segments[0].waypoints.map(([lon, lat]) => [lon, lat]);
  }

  const from = portById(model, fromId);
  const to = portById(model, toId);
  if (!from || !to) return [];
  return [
    [from.lon, from.lat],
    [to.lon, to.lat],
  ];
}

export function waitingTeuByPort(model: SceneModel, portId: string): number {
  const row = model.stats?.portWaiting.find((item) => item.portId === portId);
  return row?.totalTeu ?? 0;
}

/** Binary search for the frame index covering `day`. */
export function frameIndexAt(timeline: Float64Array, day: SimDay): number {
  const last = timeline.length - 1;
  if (day <= timeline[0]) return 0;
  if (day >= timeline[last]) return last;
  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (timeline[mid] <= day) low = mid;
    else high = mid;
  }
  return low;
}
