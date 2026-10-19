/**
 * Static port markers. Built once as primitives (not entities) - ports never
 * move, so the entity property system would be pure overhead.
 */

import {
  Cartesian2,
  Cartesian3,
  Color,
  HorizontalOrigin,
  LabelCollection,
  LabelStyle,
  NearFarScalar,
  PointPrimitiveCollection,
  VerticalOrigin,
  type Viewer,
} from 'cesium';
import type { SceneModel } from '../../viewmodel/sceneModel';
import { portWaitingColor, toCss } from '../../viewmodel/colorScales';
import { waitingTeuByPort } from '../../viewmodel/sceneModel';
import type { PickPayload, SceneLayer } from './SceneLayer';

export class PortLayer implements SceneLayer {
  readonly id = 'ports';
  readonly label = '港口';

  private points: PointPrimitiveCollection | null = null;
  private labels: LabelCollection | null = null;
  private visible = true;
  private highlighted = new Set<string>();
  private payloads: PickPayload[] = [];

  build(model: SceneModel, viewer: Viewer): void {
    this.points = viewer.scene.primitives.add(new PointPrimitiveCollection());
    this.labels = viewer.scene.primitives.add(new LabelCollection());

    for (const port of model.ports) {
      const waitingTeu = waitingTeuByPort(model, port.id);
      const [r, g, b, a] = portWaitingColor(waitingTeu);
      const payload: PickPayload = { kind: 'port', id: port.id, label: port.name };
      this.payloads.push(payload);

      this.points.add({
        position: Cartesian3.fromDegrees(port.lon, port.lat, 0),
        color: new Color(r, g, b, a),
        pixelSize: port.coordsVerified ? 12 : 9,
        outlineColor: Color.fromCssColorString('#ffffff'),
        outlineWidth: 1.5,
        id: payload,
        // Hide names when zoomed far out to avoid a wall of text.
        distanceDisplayCondition: undefined,
      });

      this.labels.add({
        position: Cartesian3.fromDegrees(port.lon, port.lat, 0),
        text: port.name,
        font: '13px sans-serif',
        fillColor: Color.fromCssColorString('#e8f1ff'),
        outlineColor: Color.fromCssColorString('#050b16'),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.LEFT,
        verticalOrigin: VerticalOrigin.CENTER,
        pixelOffset: new Cartesian2(14, 0),
        translucencyByDistance: new NearFarScalar(1.5e6, 1.0, 4.0e7, 0.0),
        id: payload,
      });
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.points) this.points.show = visible;
    if (this.labels) this.labels.show = visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  highlight(ids: string[]): void {
    this.highlighted = new Set(ids);
    if (!this.points) return;
    for (let i = 0; i < this.points.length; i += 1) {
      const primitive = this.points.get(i);
      const payload = primitive.id as PickPayload | undefined;
      const active = payload ? this.highlighted.has(payload.id) : false;
      primitive.pixelSize = active ? 20 : payload?.kind === 'port' ? 12 : 12;
      primitive.outlineWidth = active ? 3 : 1.5;
      primitive.outlineColor = active
        ? Color.fromCssColorString('#ffd166')
        : Color.fromCssColorString('#ffffff');
    }
  }

  dispose(): void {
    this.points = null;
    this.labels = null;
  }

  /** Exposed for the legend swatch colours in the 2D panel. */
  static legendColors(): string[] {
    return [0, 400, 900, 1600, 2600].map((value) => toCss(portWaitingColor(value)));
  }
}
