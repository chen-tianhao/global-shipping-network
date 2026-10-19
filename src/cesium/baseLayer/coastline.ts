/**
 * Continent outlines for the `none` base map.
 *
 * Without imagery the globe is an unreadable sphere, so the bare-globe mode
 * draws simplified coastlines from a local asset. This lives under `baseLayer/`
 * on purpose: it is part of "what the globe looks like", not part of the
 * simulation data, so it is not exposed through `SimulationDataProvider`.
 *
 * The asset is optional - if it is missing the app still runs, just without
 * continents.
 */

import {
  ArcType,
  Cartesian3,
  Color,
  Material,
  PolylineCollection,
  type Viewer,
} from 'cesium';
import { fetchJson } from '../../data/provider';
import type { SceneModel } from '../../viewmodel/sceneModel';
import type { SceneLayer } from '../layers/SceneLayer';

interface CoastlineFile {
  lines: Array<Array<[number, number]>>;
}

const COAST_COLOR = Color.fromCssColorString('#2f6f8f').withAlpha(0.9);

export class CoastlineLayer implements SceneLayer {
  readonly id = 'coastline';
  readonly label = '海岸线';

  private collection: PolylineCollection | null = null;
  private visible = true;

  constructor(private readonly lines: Array<Array<[number, number]>>) {}

  /** Returns null when the asset is unavailable - callers must tolerate that. */
  static async load(baseUrl: string): Promise<CoastlineLayer | null> {
    try {
      const file = await fetchJson<CoastlineFile>(
        `${baseUrl.replace(/\/$/, '')}/coastline.json`,
      );
      if (!Array.isArray(file.lines) || file.lines.length === 0) return null;
      return new CoastlineLayer(file.lines);
    } catch (error) {
      console.warn('[coastline] asset unavailable, globe will be blank:', error);
      return null;
    }
  }

  build(_model: SceneModel, viewer: Viewer): void {
    this.collection = viewer.scene.primitives.add(new PolylineCollection());
    for (const line of this.lines) {
      if (line.length < 2) continue;
      this.collection.add({
        positions: line.map(([lon, lat]) => Cartesian3.fromDegrees(lon, lat, 0)),
        width: 1,
        arcType: ArcType.GEODESIC,
        material: Material.fromType('Color', { color: COAST_COLOR }),
      });
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.collection) this.collection.show = visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  highlight(): void {
    // Coastline is decoration; highlighting does not apply.
  }

  dispose(): void {
    this.collection = null;
  }
}
