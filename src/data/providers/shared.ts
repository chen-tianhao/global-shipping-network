/**
 * Shared mapping from the build-time JSON to the engine-agnostic VM types.
 *
 * Both providers read the same `ports.json` / `routes.json`. Keeping the
 * mapping here means the static skeleton and the motion provider cannot drift
 * apart (a port id or a segment endpoint resolved differently in each would
 * break picking and disruption overlays in subtle ways).
 */

import type { PortVM, RouteSegmentVM } from '../types';

/** Stable id for names that are not in `ports.json`. */
export function slug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}

export function mapPorts(rawPorts: Array<Record<string, unknown>>): PortVM[] {
  return rawPorts.map((raw) => ({
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    lon: Number(raw.lon),
    lat: Number(raw.lat),
    berthCount: Number(raw.berthCount ?? 0),
    coordsVerified: Boolean(raw.coordsVerified),
    note: raw.note ? String(raw.note) : undefined,
    tunnelledToSea: Boolean(raw.tunnelledToSea),
  }));
}

export function mapSegments(
  rawSegments: unknown,
  ports: PortVM[],
): RouteSegmentVM[] {
  if (!Array.isArray(rawSegments)) return [];
  const idByName = new Map(
    ports.map((port) => [port.name.trim().toLowerCase(), port.id]),
  );

  return rawSegments.map((value, index) => {
    const raw = value as Record<string, unknown>;
    const fromName = String(raw.from ?? '');
    const toName = String(raw.to ?? '');
    return {
      sequence: Number(raw.sequence ?? index + 1),
      fromPortId:
        idByName.get(fromName.trim().toLowerCase()) ?? slug(fromName),
      toPortId: idByName.get(toName.trim().toLowerCase()) ?? slug(toName),
      fromPortName: fromName,
      toPortName: toName,
      waypoints: (raw.waypoints as Array<[number, number]>) ?? [],
      routeDistanceNm: Number(raw.routeDistanceNm ?? 0),
    };
  });
}
