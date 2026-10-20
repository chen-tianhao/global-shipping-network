/**
 * Default provider: reads the build-time geo assets and the simulation's
 * aggregated CSV outputs. Ships with the project and never retires - it is the
 * static skeleton (ports, routes, statistics) that any motion provider sits on.
 */

import {
  fetchJson,
  fetchText,
  parseCsv,
  toNumber,
  type ProviderContext,
  type SimulationDataProvider,
} from '../provider';
import type {
  DisruptionVM,
  Matrix2D,
  NetworkGraph,
  RouteVM,
  StatBundle,
  VesselState,
} from '../types';
import { mapPorts, mapSegments, slug } from './shared';

interface PortsFile {
  ports: Array<Record<string, unknown>>;
}
interface RoutesFile {
  routes: Array<Record<string, unknown>>;
}

export class StaticDataProvider implements SimulationDataProvider {
  readonly id = 'static-csv';

  private baseUrl = '';
  private signal?: AbortSignal;
  private graph: NetworkGraph = { ports: [], routes: [] };
  private stats: StatBundle | null = null;
  private disruptions: DisruptionVM[] = [];

  async init(ctx: ProviderContext): Promise<void> {
    this.baseUrl = ctx.baseUrl.replace(/\/$/, '');
    this.signal = ctx.signal;
    await Promise.all([this.loadGraph(), this.loadStats()]);
    this.loadDisruptions();
  }

  private async loadGraph(): Promise<void> {
    const [portsFile, routesFile, planText] = await Promise.all([
      fetchJson<PortsFile>(`${this.baseUrl}/ports.json`, this.signal),
      fetchJson<RoutesFile>(`${this.baseUrl}/routes.json`, this.signal),
      fetchText(`${this.baseUrl}/route_plan.csv`, this.signal),
    ]);

    const vesselsByRoute = new Map<string, number>();
    for (const [index, row] of parseCsv(planText).entries()) {
      if (index === 0) continue;
      vesselsByRoute.set(row[0], toNumber(row[2]) || 0);
    }

    const ports = mapPorts(portsFile.ports);

    const routes: RouteVM[] = routesFile.routes.map((raw) => {
      const waypoints = (raw.waypoints as Array<[number, number]>) ?? [];
      const id = String(raw.id ?? '');
      return {
        id,
        name: String(raw.name ?? id),
        startDayOfWeek: raw.startDayOfWeek === null ? null : Number(raw.startDayOfWeek),
        waypoints,
        segments: mapSegments(raw.segments, ports),
        isAlternative: Boolean(raw.isAlternative),
        totalDistanceNm: Number(raw.totalDistanceNm ?? 0),
        vessels: vesselsByRoute.get(id.replace(/-ALT.*$/, '')) ?? 0,
      };
    });

    this.graph = { ports, routes };
  }

  private async loadStats(): Promise<void> {
    const url = `${this.baseUrl}/stats`;
    const [portText, routeText, transitText, waitingText, completedText, attText, stateText] =
      await Promise.all([
        fetchText(`${url}/Port_Waiting_Statistics.csv`, this.signal),
        fetchText(`${url}/Service_Route_Utilization.csv`, this.signal),
        fetchText(`${url}/Average_In_Transit_TEU_By_OD.csv`, this.signal),
        fetchText(`${url}/Average_Origin_Waiting_TEU_By_OD.csv`, this.signal),
        fetchText(`${url}/Cumulative_Completed_TEU_By_OD.csv`, this.signal),
        fetchText(`${url}/ATT_By_Statistics_Interval.csv`, this.signal),
        fetchText(`${url}/Average_Vessel_State_Counts.csv`, this.signal),
      ]);

    const portWaiting = parseCsv(portText)
      .slice(1)
      .filter((row) => row[0] && row[0] !== 'TOTAL')
      .map((row) => ({
        portId: slug(row[0]),
        originTeu: toNumber(row[1]) || 0,
        transshipTeu: toNumber(row[2]) || 0,
        totalTeu: toNumber(row[3]) || 0,
        vesselsWaiting: toNumber(row[4]) || 0,
      }));

    const routeUtilization = parseCsv(routeText)
      .slice(1)
      .filter((row) => row[0] && row[0] !== 'TOTAL')
      .map((row) => ({
        routeId: row[0],
        name: row[1] ?? '',
        capacityTeu: toNumber(row[2]) || 0,
        carriedTeu: toNumber(row[3]) || 0,
        utilization: (toNumber(row[4]) || 0) / 100,
      }));

    const vesselStateCounts: Record<VesselState, number> = {
      sailing: 0,
      queuing: 0,
      served: 0,
      idle: 0,
    };
    for (const row of parseCsv(stateText).slice(1)) {
      const label = (row[0] ?? '').toLowerCase();
      const value = toNumber(row[1]) || 0;
      if (label.includes('sailing')) vesselStateCounts.sailing = value;
      else if (label.includes('waiting')) vesselStateCounts.queuing = value;
      else if (label.includes('served')) vesselStateCounts.served = value;
    }

    this.stats = {
      portWaiting,
      routeUtilization,
      inTransitByOd: readMatrix(transitText),
      originWaitingByOd: readMatrix(waitingText),
      completedByOd: readMatrix(completedText),
      attByPeriod: parseCsv(attText)
        .slice(1)
        .filter((row) => row[0] && row[0] !== '')
        .map((row) => ({
          periodIndex: toNumber(row[0]) || 0,
          startDay: toNumber(row[1]) || 0,
          endDay: toNumber(row[2]) || 0,
          att: toNumber(row[3]) || 0,
        })),
      vesselStateCounts,
    };
  }

  /**
   * Disruptions are still hard-coded here because the simulation does not export
   * them yet. They mirror `scenario_builders/disruption_scenario.py`.
   */
  private loadDisruptions(): void {
    const congested: Array<[string, string, number, number, number]> = [
      ['Shanghai', 'Shenzhen', 40, 70, 4.0],
      ['Singapore', 'Shenzhen', 65, 45, 3.0],
      ['Rotterdam', 'Hamburg', 130, 80, 4.0],
      ['Colombo', 'Piraeus', 145, 45, 2.3],
      ['Singapore', 'Shanghai', 245, 85, 3.0],
      ['Colombo', 'New Jersey', 265, 40, 2.0],
    ];
    const closed: Array<[string, number, number]> = [
      ['Qingdao', 175, 8],
      ['New Jersey', 200, 8],
    ];

    this.disruptions = [
      ...closed.map(([port, start, duration], index) => ({
        id: `closed-${index}`,
        type: 'closed_port' as const,
        target: slug(port),
        startDay: start,
        endDay: start + duration,
        magnitude: 1,
      })),
      ...congested.map(([from, to, start, duration, mult], index) => ({
        id: `congested-${index}`,
        type: 'congested_leg' as const,
        target: [slug(from), slug(to)] as [string, string],
        startDay: start,
        endDay: start + duration,
        magnitude: mult,
      })),
    ];
  }

  async getStaticGraph(): Promise<NetworkGraph> {
    return this.graph;
  }

  async getStats(): Promise<StatBundle> {
    if (!this.stats) throw new Error('StaticDataProvider.init() not called');
    return this.stats;
  }

  async getDisruptions(): Promise<DisruptionVM[]> {
    return this.disruptions;
  }

  /** Static provider carries no motion; compose with a motion provider. */
  async getMotion(): Promise<never> {
    throw new Error('StaticDataProvider does not provide motion data');
  }
}

function readMatrix(text: string): Matrix2D {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], cols: [], values: [] };
  const cols = table[0].slice(1);
  const rows: string[] = [];
  const values: number[][] = [];
  for (const row of table.slice(1)) {
    rows.push(row[0]);
    values.push(row.slice(1).map((cell) => toNumber(cell) || 0));
  }
  return { rows: rows.map(slug), cols: cols.map(slug), values };
}
