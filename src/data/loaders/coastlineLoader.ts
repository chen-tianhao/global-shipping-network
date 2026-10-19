/**
 * Loader for the simplified coastline asset used by the `none` base map.
 *
 * The geometry is file-backed, so it belongs to the data layer: `cesium/`
 * must never fetch. `CoastlineLayer` receives the rings through its
 * constructor instead.
 */

import { fetchJson } from '../provider';

interface CoastlineFile {
  lines?: Array<Array<[number, number]>>;
}

export type CoastlineRings = Array<Array<[number, number]>>;

/**
 * Returns null when the asset is missing or malformed. The base map is
 * decoration, so callers must tolerate its absence rather than fail start-up.
 */
export async function loadCoastline(baseUrl: string): Promise<CoastlineRings | null> {
  try {
    const file = await fetchJson<CoastlineFile>(
      `${baseUrl.replace(/\/$/, '')}/coastline.json`,
    );
    const rings = (file.lines ?? []).filter(
      (line) =>
        Array.isArray(line) &&
        line.length >= 2 &&
        line.every(
          (point) =>
            Array.isArray(point) &&
            point.length >= 2 &&
            Number.isFinite(point[0]) &&
            Number.isFinite(point[1]),
        ),
    );
    return rings.length > 0 ? rings : null;
  } catch (error) {
    console.warn('[coastline] asset unavailable, globe will be blank:', error);
    return null;
  }
}
