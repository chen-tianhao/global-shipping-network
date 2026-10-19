/**
 * Visualization contracts - deliberately free of any Cesium or DOM types.
 *
 * Everything downstream (viewmodel, cesium layer, ui panels) depends on these
 * shapes only. Swapping the placeholder data source for real simulation output
 * must not require touching a single line outside `src/data/`.
 */

/** Simulation day. 0 = start of the measured horizon; negative = warm-up. */
export type SimDay = number;

export interface PortVM {
  id: string;
  name: string;
  lon: number;
  lat: number;
  berthCount: number;
  coordsVerified: boolean;
  note?: string;
  /** True when the harbour sits on a land cell and was tunnelled to open water. */
  tunnelledToSea?: boolean;
}

export interface RouteSegmentVM {
  sequence: number;
  /** Port ids, resolved from the port names in `routes.json`. */
  fromPortId: string;
  toPortId: string;
  fromPortName: string;
  toPortName: string;
  /** Land-avoiding geometry of this leg, produced at build time. */
  waypoints: ReadonlyArray<readonly [number, number]>;
  routeDistanceNm: number;
}

export interface RouteVM {
  id: string;
  name: string;
  startDayOfWeek: number | null;
  /** Land-avoiding geometry produced at build time. Renderers never re-route. */
  waypoints: ReadonlyArray<readonly [number, number]>;
  /**
   * Per-leg geometry. Disruption overlays use this to draw a congested leg
   * along the real sea route instead of a straight port-to-port line.
   */
  segments: RouteSegmentVM[];
  isAlternative: boolean;
  totalDistanceNm: number;
  vessels?: number;
  /**
   * Average deployed capacity in TEU, joined from
   * `Service_Route_Utilization.csv` ("Avg Capacity TEU").
   */
  capacityTeu?: number;
}

export type VesselState = 'sailing' | 'queuing' | 'served' | 'idle';

export const VESSEL_STATES: VesselState[] = ['sailing', 'queuing', 'served', 'idle'];

/**
 * Motion data, stored per vessel as typed arrays aligned to `timeline`.
 * NaN marks "not present / not visible at this instant".
 */
export interface VesselTrackSet {
  timeline: Float64Array;
  vessels: VesselTrack[];
  startDay: SimDay;
  endDay: SimDay;
  stepDays: number;
}

export interface VesselTrack {
  vesselId: string;
  routeId: string | null;
  lon: Float32Array;
  lat: Float32Array;
  heading: Float32Array;
  teu: Float32Array;
  state: Uint8Array;
}

export interface DisruptionVM {
  id: string;
  type: 'closed_port' | 'congested_leg';
  target: string | [string, string];
  startDay: SimDay;
  endDay: SimDay;
  magnitude: number;
  label?: string;
}

export interface Matrix2D {
  rows: string[];
  cols: string[];
  values: number[][];
}

export interface PortWaitingRow {
  portId: string;
  originTeu: number;
  transshipTeu: number;
  totalTeu: number;
  vesselsWaiting: number;
}

export interface RouteUtilizationRow {
  routeId: string;
  name: string;
  capacityTeu: number;
  carriedTeu: number;
  utilization: number;
}

export interface AttPeriodRow {
  periodIndex: number;
  startDay: SimDay;
  endDay: SimDay;
  att: number;
}

/** Aggregated statistics, mapped 1:1 from the simulation's output CSVs. */
export interface StatBundle {
  portWaiting: PortWaitingRow[];
  routeUtilization: RouteUtilizationRow[];
  inTransitByOd: Matrix2D;
  originWaitingByOd: Matrix2D;
  completedByOd: Matrix2D;
  attByPeriod: AttPeriodRow[];
  vesselStateCounts: Record<VesselState, number>;
}

export interface NetworkGraph {
  ports: PortVM[];
  routes: RouteVM[];
}

export interface TimeRange {
  startDay: SimDay;
  endDay: SimDay;
}

/**
 * Business identity of a picked object. Kept in the data layer so UI panels and
 * the event bus never have to import anything from `src/cesium/`.
 */
export interface PickPayload {
  kind: 'port' | 'vessel' | 'route' | 'disruption';
  id: string;
  label: string;
}
