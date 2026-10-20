/**
 * Real trajectory provider.
 *
 * Reads the zero-invasion export produced by
 * `SimulationChallenge2026_Py/export_trajectory.py`:
 *
 *   voyages.csv  VesselIndex,FromPort,ToPort,DepartTime,ArriveTime,SailingHours
 *   states.csv   VesselIndex,State,StartTime,EndTime,Port
 *
 * It reconstructs a uniform hourly track per vessel:
 *   - `sailing`   interpolate along the matching route segment's land-avoiding
 *                 geometry using the voyage's departure/arrival times;
 *   - `queuing` / `served` park the vessel at the port anchor.
 *
 * The export uses Python's year-1 timestamps. `meta.json` carries the
 * measurement start, so `SimDay = (timestamp - measurementStart) / 1 day`;
 * warm-up days become negative, matching the rest of the app.
 */

import { t } from '../../i18n';
import {
  fetchJson,
  fetchText,
  parseCsv,
  type ProviderContext,
} from '../provider';
import type {
  PortVM,
  RouteSegmentVM,
  TimeRange,
  VesselState,
  VesselTrack,
  VesselTrackSet,
} from '../types';
import { mapPorts, mapSegments } from './shared';
import type { MotionProvider } from './motionProvider';
import {
  greatCircleDistanceNm,
  interpolateGreatCircle,
} from '../geo/geoMath';

const STEP_DAYS = 1 / 24;
const MS_PER_DAY = 86_400_000;

interface TrajectoryMeta {
  generatedAt?: string;
  warmUpDays?: number;
  measurementDays?: number;
  /** Absolute (year-1) instant that maps to SimDay 0. */
  measurementStartIso: string;
  voyages?: number;
  states?: number;
}

interface PortsFile {
  ports: Array<Record<string, unknown>>;
}

interface RoutesFile {
  routes: Array<Record<string, unknown>>;
}

interface RawVoyage {
  vessel: number;
  from: string;
  to: string;
  depart: number;
  arrive: number;
}

interface RawState {
  vessel: number;
  code: number;
  state: VesselState;
  start: number;
  end: number;
  port: string;
}

interface LegGeometry {
  waypoints: ReadonlyArray<readonly [number, number]>;
  cumulativeNm: number[];
  totalNm: number;
}

export class RealTrajectoryProvider implements MotionProvider {
  readonly id = 'real-trajectory';
  readonly isPlaceholder = false;

  private motion: VesselTrackSet | null = null;

  async init(ctx: ProviderContext): Promise<void> {
    const root = ctx.baseUrl.replace(/\/$/, '');
    try {
      const [meta, voyagesText, statesText, portsFile, routesFile] =
        await Promise.all([
          fetchJson<TrajectoryMeta>(`${root}/trajectory/meta.json`, ctx.signal),
          fetchText(`${root}/trajectory/voyages.csv`, ctx.signal),
          fetchText(`${root}/trajectory/states.csv`, ctx.signal),
          fetchJson<PortsFile>(`${root}/ports.json`, ctx.signal),
          fetchJson<RoutesFile>(`${root}/routes.json`, ctx.signal),
        ]);

      const ports = mapPorts(portsFile.ports);
      const legs = buildLegs(routesFile.routes, ports);
      this.motion = buildMotion(
        meta,
        voyagesText,
        statesText,
        ports,
        legs,
      );
    } catch (error) {
      throw new Error(
        t('error.trajectoryMissing', { root }) +
          (error instanceof Error
            ? t('error.rawDetail', { message: error.message })
            : ''),
      );
    }
  }

  async getMotion(_range: TimeRange): Promise<VesselTrackSet> {
    if (!this.motion) throw new Error('RealTrajectoryProvider.init() not called');
    return this.motion;
  }
}

function buildLegs(
  rawRoutes: Array<Record<string, unknown>>,
  ports: PortVM[],
): Map<string, LegGeometry> {
  const legs = new Map<string, LegGeometry>();

  const add = (
    from: string,
    to: string,
    waypoints: ReadonlyArray<readonly [number, number]>,
  ): void => {
    if (waypoints.length < 2) return;
    const key = legKey(from, to);
    if (legs.has(key)) return;
    const cumulativeNm: number[] = [0];
    for (let i = 1; i < waypoints.length; i += 1) {
      cumulativeNm.push(
        cumulativeNm[i - 1] + greatCircleDistanceNm(waypoints[i - 1], waypoints[i]),
      );
    }
    legs.set(key, {
      waypoints,
      cumulativeNm,
      totalNm: cumulativeNm[cumulativeNm.length - 1],
    });
  };

  for (const raw of rawRoutes) {
    const segments: RouteSegmentVM[] = mapSegments(raw.segments, ports);
    for (const segment of segments) {
      add(segment.fromPortName, segment.toPortName, segment.waypoints);
      add(
        segment.toPortName,
        segment.fromPortName,
        [...segment.waypoints].reverse(),
      );
    }
  }
  return legs;
}

function buildMotion(
  meta: TrajectoryMeta,
  voyagesText: string,
  statesText: string,
  ports: PortVM[],
  legs: Map<string, LegGeometry>,
): VesselTrackSet {
  const measurementStart = parseTimestamp(meta.measurementStartIso);
  if (!Number.isFinite(measurementStart)) {
    throw new Error(
      t('error.metaIso', { value: String(meta.measurementStartIso) }),
    );
  }

  const portByName = new Map(
    ports.map((port) => [port.name.trim().toLowerCase(), port]),
  );

  const voyagesByVessel = new Map<number, RawVoyage[]>();
  for (const row of parseCsv(voyagesText).slice(1)) {
    if (!row[0]) continue;
    const vessel = Number(row[0]);
    const depart = parseTimestamp(row[3]);
    const arrive = parseTimestamp(row[4]);
    if (
      !Number.isFinite(vessel) ||
      !Number.isFinite(depart) ||
      !Number.isFinite(arrive) ||
      arrive <= depart
    ) {
      continue;
    }
    const list = voyagesByVessel.get(vessel) ?? [];
    list.push({
      vessel,
      from: String(row[1] ?? '').trim(),
      to: String(row[2] ?? '').trim(),
      depart,
      arrive,
    });
    voyagesByVessel.set(vessel, list);
  }

  const statesByVessel = new Map<number, RawState[]>();
  for (const row of parseCsv(statesText).slice(1)) {
    if (!row[0]) continue;
    const vessel = Number(row[0]);
    const start = parseTimestamp(row[2]);
    const end = parseTimestamp(row[3]);
    // Zero-duration intervals mark the instantaneous hand-over between two
    // activities; they carry no position of their own.
    if (
      !Number.isFinite(vessel) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    ) {
      continue;
    }
    const stateName = String(row[1] ?? '').trim().toLowerCase();
    const state = toVesselState(stateName);
    const list = statesByVessel.get(vessel) ?? [];
    list.push({
      vessel,
      code: stateCode(state),
      state,
      start,
      end,
      port: String(row[4] ?? '').trim(),
    });
    statesByVessel.set(vessel, list);
  }

  for (const list of voyagesByVessel.values()) {
    list.sort((a, b) => a.depart - b.depart);
  }
  for (const list of statesByVessel.values()) {
    list.sort((a, b) => a.start - b.start);
  }

  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const list of statesByVessel.values()) {
    for (const interval of list) {
      minStart = Math.min(minStart, interval.start);
      maxEnd = Math.max(maxEnd, interval.end);
    }
  }
  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) {
    throw new Error(t('error.noStates'));
  }

  const startDay = Math.floor(toSimDay(minStart, measurementStart));
  const endDay = Math.ceil(toSimDay(maxEnd, measurementStart));
  const frameCount = Math.max(
    2,
    Math.round((endDay - startDay) / STEP_DAYS) + 1,
  );

  const timeline = new Float64Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    timeline[i] = startDay + i * STEP_DAYS;
  }

  const vessels: VesselTrack[] = [];

  for (const [vesselIndex, states] of statesByVessel) {
    const lon = new Float32Array(frameCount).fill(Number.NaN);
    const lat = new Float32Array(frameCount).fill(Number.NaN);
    const heading = new Float32Array(frameCount);
    const teu = new Float32Array(frameCount);
    const state = new Uint8Array(frameCount);
    const voyages = voyagesByVessel.get(vesselIndex) ?? [];

    let cursor = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const day = timeline[frame];
      const timestamp = measurementStart + day * MS_PER_DAY;

      while (cursor < states.length && states[cursor].end <= timestamp) {
        cursor += 1;
      }
      const interval = states[cursor];
      if (!interval || timestamp < interval.start) continue;

      state[frame] = interval.code;

      if (interval.code === 0) {
        const voyage = findVoyage(voyages, timestamp);
        if (!voyage) continue;

        const leg =
          legs.get(legKey(voyage.from, voyage.to)) ??
          directLeg(portByName, voyage.from, voyage.to);
        if (!leg) continue;

        const span = voyage.arrive - voyage.depart;
        const fraction = span > 0 ? (timestamp - voyage.depart) / span : 0;
        const [sampleLon, sampleLat] = sampleLeg(leg, fraction);
        lon[frame] = sampleLon;
        lat[frame] = sampleLat;
      } else {
        const port = portByName.get(interval.port.trim().toLowerCase());
        if (!port) continue;
        lon[frame] = port.lon;
        lat[frame] = port.lat;
      }
    }

    vessels.push({
      vesselId: `V${vesselIndex}`,
      // The export does not carry a service-route id. Leaving it null keeps
      // the HUD honest and lets the smoke test skip route-attribution checks.
      routeId: null,
      lon,
      lat,
      heading,
      teu,
      state,
    });
  }

  vessels.sort((a, b) => a.vesselId.localeCompare(b.vesselId, 'en', { numeric: true }));

  return {
    timeline,
    vessels,
    startDay,
    endDay,
    stepDays: STEP_DAYS,
  };
}

function findVoyage(voyages: RawVoyage[], timestamp: number): RawVoyage | null {
  let low = 0;
  let high = voyages.length - 1;
  let candidate: RawVoyage | null = null;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (voyages[mid].depart <= timestamp) {
      candidate = voyages[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (candidate && timestamp <= candidate.arrive) return candidate;

  // The recorder's state and voyage timestamps can differ by a few
  // microseconds at a hand-over; allow a one-hour tolerance.
  const tolerance = 3_600_000;
  return (
    voyages.find(
      (voyage) =>
        timestamp >= voyage.depart - tolerance &&
        timestamp <= voyage.arrive + tolerance,
    ) ?? null
  );
}

function directLeg(
  ports: Map<string, PortVM>,
  from: string,
  to: string,
): LegGeometry | null {
  const fromPort = ports.get(from.trim().toLowerCase());
  const toPort = ports.get(to.trim().toLowerCase());
  if (!fromPort || !toPort) return null;

  const waypoints: Array<readonly [number, number]> = [
    [fromPort.lon, fromPort.lat],
    [toPort.lon, toPort.lat],
  ];
  const distance = greatCircleDistanceNm(waypoints[0], waypoints[1]);
  return {
    waypoints,
    cumulativeNm: [0, distance],
    totalNm: distance,
  };
}

function sampleLeg(leg: LegGeometry, fraction: number): [number, number] {
  const clamped = Math.min(1, Math.max(0, fraction));
  const target = clamped * leg.totalNm;

  let low = 1;
  let high = leg.cumulativeNm.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (leg.cumulativeNm[mid] < target) low = mid + 1;
    else high = mid;
  }

  const index = low;
  const a = leg.waypoints[index - 1];
  const b = leg.waypoints[Math.min(index, leg.waypoints.length - 1)];
  const segmentStart = leg.cumulativeNm[index - 1];
  const segmentLength = leg.cumulativeNm[index] - segmentStart;
  const ratio = segmentLength > 0 ? (target - segmentStart) / segmentLength : 0;
  return interpolateGreatCircle(a, b, ratio);
}

function legKey(from: string, to: string): string {
  return `${from.trim().toLowerCase()}|${to.trim().toLowerCase()}`;
}

function toVesselState(name: string): VesselState {
  if (name === 'sailing') return 'sailing';
  if (name === 'queuing') return 'queuing';
  if (name === 'served') return 'served';
  return 'idle';
}

function stateCode(state: VesselState): number {
  if (state === 'sailing') return 0;
  if (state === 'queuing') return 1;
  if (state === 'served') return 2;
  return 3;
}

function toSimDay(timestamp: number, measurementStart: number): number {
  return (timestamp - measurementStart) / MS_PER_DAY;
}

/**
 * Parse Python's year-1 timestamps without the JS `Date` two-digit-year quirk.
 * `new Date(0)` + `setUTCFullYear(1, ...)` gives a proleptic Gregorian instant;
 * only differences matter, so the absolute epoch is irrelevant.
 */
function parseTimestamp(text: string): number {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z?$/.exec(
      text.trim(),
    );
  if (!match) return Number.NaN;

  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const milliseconds = match[7]
    ? Math.round(Number(`0.${match[7]}`) * 1000)
    : 0;
  date.setUTCHours(
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    milliseconds,
  );
  return date.getTime();
}
