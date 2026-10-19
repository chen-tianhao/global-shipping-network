/**
 * Disruption overlays: closed ports and congested legs.
 *
 * Both are time-bounded, so unlike ports/routes this layer has an `update()`:
 * it only flips `show` flags based on the current simulation day. Geometry is
 * built once.
 */

import {
  Cartesian3,
  Color,
  HorizontalOrigin,
  Material,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  PointPrimitiveCollection,
  PolylineCollection,
  VerticalOrigin,
  type PointPrimitive,
  type Polyline,
  type Viewer,
} from 'cesium';
import type { SceneModel } from '../../viewmodel/sceneModel';
import { portById } from '../../viewmodel/sceneModel';
import type { DisruptionVM } from '../../data/types';
import type { PickPayload, SceneLayer } from './SceneLayer';

const CLOSED_COLOR = Color.fromCssColorString('#ff4d4d').withAlpha(0.28);
const CONGESTED_COLOR = Color.fromCssColorString('#ff9f1c').withAlpha(0.95);

interface Item {
  disruption: DisruptionVM;
  point?: PointPrimitive;
  polyline?: Polyline;
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
      const item: Item = { disruption };

      if (disruption.type === 'closed_port') {
        const port = portById(model, String(disruption.target));
        if (!port) continue;
        const payload: PickPayload = {
          kind: 'port',
          id: port.id,
          label: disruption.label ?? `${port.name} 关闭`,
        };
        item.point = this.points.add({
          position: Cartesian3.fromDegrees(port.lon, port.lat, 0),
          color: CLOSED_COLOR,
          pixelSize: 34,
          outlineColor: Color.fromCssColorString('#ff4d4d'),
          outlineWidth: 2,
          id: payload,
          show: false,
        });
      } else {
        const [fromId, toId] = disruption.target as [string, string];
        const from = portById(model, fromId);
        const to = portById(model, toId);
        if (!from || !to) continue;
        const payload: PickPayload = {
          kind: 'route',
          id: `${fromId}--${toId}`,
          label: disruption.label ?? `${from.name} → ${to.name}`,
        };
        item.polyline = this.lines.add({
          positions: [
            Cartesian3.fromDegrees(from.lon, from.lat, 0),
            Cartesian3.fromDegrees(to.lon, to.lat, 0),
          ],
          width: 3,
          material: Material.fromType('Color', { color: CONGESTED_COLOR }),
          id: payload,
          show: false,
        });
      }

      this.items.push(item);
    }

    // Labels are created lazily-free: one per disruption, hidden by default.
    for (const item of this.items) {
      const anchor = this.anchorOf(model, item.disruption);
      if (!anchor) continue;
      this.labels.add({
        position: Cartesian3.fromDegrees(anchor[0], anchor[1], 0),
        text: item.disruption.label ?? item.disruption.id,
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
  }

  private anchorOf(model: SceneModel, disruption: DisruptionVM): [number, number] | null {
    if (disruption.type === 'closed_port') {
      const port = portById(model, String(disruption.target));
      return port ? [port.lon, port.lat] : null;
    }
    const [fromId, toId] = disruption.target as [string, string];
    const from = portById(model, fromId);
    const to = portById(model, toId);
    if (!from || !to) return null;
    return [(from.lon + to.lon) / 2, (from.lat + to.lat) / 2];
  }

  update(_model: SceneModel, now: number): void {
    if (!this.visible) return;

    // Cheap guard: recompute only when the active set could have changed.
    const key = `${Math.floor(now)}`;
    if (key === this.lastActiveKey) return;
    this.lastActiveKey = key;

    for (let i = 0; i < this.items.length; i += 1) {
      const item = this.items[i];
      const active =
        now >= item.disruption.startDay && now <= item.disruption.endDay;
      if (item.point) item.point.show = active;
      if (item.polyline) item.polyline.show = active;
      const label = this.labels?.get(i);
      if (label) label.show = active;
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
      const id = item.disruption.id;
      const active = this.highlighted.has(id);
      if (item.point) {
        item.point.pixelSize = active ? 46 : 34;
        item.point.outlineWidth = active ? 4 : 2;
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
