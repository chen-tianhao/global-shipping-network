/**
 * Engine-agnostic scene snapshot. Layers consume this; they never see CSV rows,
 * fetch calls, or Cesium types coming from the data layer.
 */

import type {
  DisruptionVM,
  NetworkGraph,
  PortVM,
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
