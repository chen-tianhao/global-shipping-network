/**
 * Service-route polylines. Geometry is already land-avoiding (computed at build
 * time by `scripts/build_geo.py`); this layer only draws it.
 *
 * Note: primitive polylines carry a `Material`, so colour changes are applied
 * by rewriting the material's `color` uniform rather than by re-creating
 * primitives. Alternative routes opened during a disruption are distinguished
 * by colour and width - the primitive API has no dash material.
 */

import {
  Cartesian3,
  Color,
  Material,
  PolylineCollection,
  type Viewer,
} from 'cesium';
import { densifyGreatCircle, isClosedRing } from '../../data/geo/geoMath';
import type { SceneModel } from '../../viewmodel/sceneModel';
import type { PickPayload, SceneLayer } from './SceneLayer';

const MAIN_COLOR = Color.fromCssColorString('#4cc9f0').withAlpha(0.75);
const ALT_COLOR = Color.fromCssColorString('#ffd166').withAlpha(0.55);
const HIGHLIGHT_COLOR = Color.fromCssColorString('#ff6b6b');

/**
 * Vertices are inserted so no segment exceeds this. `PolylineCollection` joins
 * vertices with straight chords (its `Polyline` has no `arcType`), and a
 * 50 km chord sags 49 m - sub-pixel at every zoom this app allows.
 */
const MAX_SEGMENT_KM = 50;

export class RouteLayer implements SceneLayer {
  readonly id = 'routes';
  readonly label = '航线';

  private collection: PolylineCollection | null = null;
  private visible = true;
  private highlighted = new Set<string>();

  build(model: SceneModel, viewer: Viewer): void {
    this.collection = viewer.scene.primitives.add(new PolylineCollection());

    for (const route of model.routes) {
      if (route.waypoints.length < 2) continue;

      // `PolylineCollection` has no arc type: it draws straight chords, so the
      // great-circle legs must be densified before they reach it. The longest
      // leg in the network is 8,787 km; as a chord it would pass 1,757 km
      // below the surface and disappear into the globe.
      const densified = densifyGreatCircle(route.waypoints, MAX_SEGMENT_KM);
      if (densified.length < 2) continue;

      // Service routes are round trips: the last waypoint repeats the first.
      // Drop it and close the ring instead of leaving a zero-length segment.
      const closed = isClosedRing(route.waypoints);
      const path = closed ? densified.slice(0, -1) : densified;
      if (path.length < 2) continue;

      const positions = path.map(([lon, lat]) =>
        Cartesian3.fromDegrees(lon, lat, 0),
      );
      const payload: PickPayload = { kind: 'route', id: route.id, label: route.name };
      const color = route.isAlternative ? ALT_COLOR : MAIN_COLOR;

      this.collection.add({
        positions,
        width: route.isAlternative ? 1.5 : 2.5,
        loop: closed,
        id: payload,
        material: Material.fromType('Color', { color }),
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

  highlight(ids: string[]): void {
    this.highlighted = new Set(ids);
    if (!this.collection) return;
    for (let i = 0; i < this.collection.length; i += 1) {
      const polyline = this.collection.get(i);
      const payload = polyline.id as PickPayload | undefined;
      if (!payload) continue;
      const active = this.highlighted.has(payload.id);
      const material = polyline.material as Material | undefined;
      if (material?.uniforms?.color) {
        material.uniforms.color = active
          ? HIGHLIGHT_COLOR
          : payload.label.includes('Alternative')
            ? ALT_COLOR
            : MAIN_COLOR;
      }
    }
  }

  dispose(): void {
    this.collection = null;
  }
}
