/**
 * Disruption overlays: closed ports and congested legs.
 *
 * Both are time-bounded, so unlike ports/routes this layer has an `update()`:
 * it only flips `show` flags based on the current simulation day. Geometry is
 * built once.
 *
 * Congested legs are drawn along the *real* route segment (`RouteVM.segments`),
 * not as a straight port-to-port line. A direct Colombo -> New Jersey line
 * crosses Arabia and the Mediterranean; the route geometry is the same
 * land-avoiding path the vessels actually sail.
 */

import {
  ArcType,
  Cartesian3,
  Color,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  Material,
  NearFarScalar,
  PointPrimitiveCollection,
  PolylineCollection,
  VerticalOrigin,
  type Label,
  type PointPrimitive,
  type Polyline,
  type Viewer,
} from 'cesium';
import type { SceneModel } from '../../viewmodel/sceneModel';
import { portById, segmentsBetween } from '../../viewmodel/sceneModel';
import type { DisruptionVM, RouteSegmentVM } from '../../data/types';
import { greatCircleMidpoint } from '../../data/geo/geoMath';
import type { PickPayload, SceneLayer } from './SceneLayer';

const CLOSED_COLOR = Color.fromCssColorString('#ff4d4d').withAlpha(0.28);
const CLOSED_ACTIVE = Color.fromCssColorString('#ff4d4d').withAlpha(0.58);
const CONGESTED_COLOR = Color.fromCssColorString('#ff9f1c').withAlpha(0.95);

interface Item {
  disruption: DisruptionVM;
  payload: PickPayload;
  point?: PointPrimitive;
  polylines: Polyline[];
  label?: Label;
}

export class DisruptionLayer implements SceneLayer {
  readonly id = 'disruptions';
  readonly label = '扰动事件';

  private points: PointPrimitiveCollection | null = null;
  private lines: PolylineCollection | null = null;
  private labels: LabelCollection | null = null;
  private items: Item[] = [];
  private visible = true;
  private highlighted = new Set<string>();
  private lastActiveKey = '';

  build(model: SceneModel, viewer: Viewer): void {
    this.lines = viewer.scene.primitives.add(new PolylineCollection());
    this.points = viewer.scene.primitives.add(new PointPrimitiveCollection());
    this.labels = viewer.scene.primitives.add(new LabelCollection());

    for (const disruption of model.disruptions) {
      const payload: PickPayload = {
        kind: 'disruption',
        id: disruption.id,
        label: disruption.label ?? disruption.id,
      };
      const item: Item = { disruption, payload, polylines: [] };

      if (disruption.type === 'closed_port') {
        const port = portById(model, String(disruption.target));
        if (!port) continue;

        item.point = this.points.add({
          position: Cartesian3.fromDegrees(port.lon, port.lat, 0),
          color: CLOSED_COLOR,
          pixelSize: 34,
          outlineColor: Color.fromCssColorString('#ff4d4d'),
          outlineWidth: 2,
          id: payload,
          show: false,
        });
        item.label = this.addLabel([port.lon, port.lat], payload.label);
      } else {
        const [fromId, toId] = disruption.target as [string, string];
        const segments = segmentsBetween(model, fromId, toId);

        if (segments.length > 0) {
          for (const segment of segments) {
            const line = this.addLeg(segment, payload);
            if (line) item.polylines.push(line);
          }
          const anchor = middleOf(segments[0].waypoints);
          if (anchor) item.label = this.addLabel(anchor, payload.label);
        } else {
          // No per-leg geometry in the build output. Fall back to a direct
          // line, but say so: a straight line may cross land.
          const from = portById(model, fromId);
          const to = portById(model, toId);
          if (!from || !to) continue;

          const line = this.lines.add({
            positions: [
              Cartesian3.fromDegrees(from.lon, from.lat, 0),
              Cartesian3.fromDegrees(to.lon, to.lat, 0),
            ],
            width: 3,
            material: Material.fromType('Color', { color: CONGESTED_COLOR }),
            id: payload,
            show: false,
          });
          item.polylines.push(line);

          const anchor = greatCircleMidpoint(
            [from.lon, from.lat],
            [to.lon, to.lat],
          );
          item.label = this.addLabel(anchor, payload.label);
          console.warn(
            `[disruptions] no route segment for ${fromId} -> ${toId}; drawn as a direct line`,
          );
        }
      }

      this.items.push(item);
    }
  }

  private addLeg(
    segment: RouteSegmentVM,
    payload: PickPayload,
  ): Polyline | null {
    if (!this.lines || segment.waypoints.length < 2) return null;
    return this.lines.add({
      positions: segment.waypoints.map(([lon, lat]) =>
        Cartesian3.fromDegrees(lon, lat, 0),
      ),
      width: 3,
      material: Material.fromType('Color', { color: CONGESTED_COLOR }),
      // The segment is land-avoiding as a geodesic, so draw that exact curve.
      arcType: ArcType.GEODESIC,
      id: payload,
      show: false,
    });
  }

  private addLabel(
    position: readonly [number, number],
    text: string,
  ): Label | undefined {
    if (!this.labels) return undefined;
    return this.labels.add({
      position: Cartesian3.fromDegrees(position[0], position[1], 0),
      text,
      font: '12px sans-serif',
      fillColor: Color.fromCssColorString('#ffd7d7'),
      outlineColor: Color.fromCssColorString('#2a0b0b'),
      outlineWidth: 3,
      style: LabelStyle.FILL_AND_OUTLINE,
      horizontalOrigin: HorizontalOrigin.CENTER,
      verticalOrigin: VerticalOrigin.BOTTOM,
      translucencyByDistance: new NearFarScalar(1.0e6, 1.0, 3.0e7, 0.0),
      show: false,
    });
  }

  update(_model: SceneModel, now: number): void {
    if (!this.visible) return;

    // Cheap guard: recompute only when the active set could have changed.
    const key = `${Math.floor(now)}`;
    if (key === this.lastActiveKey) return;
    this.lastActiveKey = key;

    for (const item of this.items) {
      const active =
        now >= item.disruption.startDay && now <= item.disruption.endDay;
      if (item.point) item.point.show = active;
      for (const line of item.polylines) line.show = active;
      if (item.label) item.label.show = active;
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.points) this.points.show = visible;
    if (this.lines) this.lines.show = visible;
    if (this.labels) this.labels.show = visible;
    if (visible) this.lastActiveKey = '';
  }

  isVisible(): boolean {
    return this.visible;
  }

  highlight(ids: string[]): void {
    this.highlighted = new Set(ids);
    for (const item of this.items) {
      // Payload ids are `disruption.id`, so the 3D pick and the 2D panel use
      // the same namespace (they previously used the port id / synthetic
      // "from--to" id and never matched).
      const active = this.highlighted.has(item.disruption.id);
      if (item.point) {
        item.point.pixelSize = active ? 46 : 34;
        item.point.outlineWidth = active ? 4 : 2;
        item.point.color = active ? CLOSED_ACTIVE : CLOSED_COLOR;
      }
      for (const line of item.polylines) {
        line.width = active ? 5 : 3;
      }
    }
  }

  dispose(): void {
    this.points = null;
    this.lines = null;
    this.labels = null;
    this.items = [];
  }
}

function middleOf(
  points: ReadonlyArray<readonly [number, number]>,
): [number, number] | null {
  if (points.length === 0) return null;
  const point = points[Math.floor(points.length / 2)];
  return [point[0], point[1]];
}
