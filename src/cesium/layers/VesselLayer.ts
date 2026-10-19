/**
 * Vessels. This is the only per-frame layer.
 *
 * PERFORMANCE CONTRACT
 * --------------------
 * Every primitive is created once in `build()`. `update()` runs before every
 * rendered frame and is restricted to:
 *   1. binary-search the frame index for `now`;
 *   2. linearly interpolate between the two neighbouring samples;
 *   3. write position / colour / size into the existing primitives.
 * It never adds or removes primitives, never allocates collections, and never
 * touches the data provider. Positions are written through one module-level
 * scratch vector: `PointPrimitive.position` clones into the primitive's own
 * storage (and marks it dirty), so the scratch never aliases between vessels.
 * Mutating a vector in place would be wrong - the setter is what flags the
 * primitive for re-upload.
 *
 * Interpolation is a rendering concern, not a modelling one: samples are
 * typically hours apart (0.25 day in the placeholder provider), and without it
 * vessels visibly jump. It is equally valid for real trajectory exports.
 *
 * A NaN sample means "this vessel does not exist at this instant"; the
 * primitive is hidden rather than drawn at (0, 0).
 */

import {
  Cartesian3,
  Color,
  Ellipsoid,
  PointPrimitiveCollection,
  type PointPrimitive,
  type Viewer,
} from 'cesium';
import type { SceneModel } from '../../viewmodel/sceneModel';
import { frameIndexAt } from '../../viewmodel/sceneModel';
import { VESSEL_STATE_RGBA } from '../../viewmodel/colorScales';
import { VESSEL_STATES } from '../../data/types';
import type { PickPayload, SceneLayer } from './SceneLayer';

/** pixelSize = BASE + teu / TEU_PER_PIXEL, clamped to [MIN, MAX]. */
const BASE_PIXEL = 7;
const TEU_PER_PIXEL = 2500;
const MIN_PIXEL = 7;
const MAX_PIXEL = 16;

/** Reused every frame; `PointPrimitive.position` clones it into place. */
const POSITION_SCRATCH = new Cartesian3();

const OUTLINE_NORMAL = Color.fromCssColorString('#04121f');
const OUTLINE_HIGHLIGHT = Color.fromCssColorString('#ffd166');

// One immutable colour per state - shared by reference, never mutated.
function stateColor(name: string): Color {
  const rgba = VESSEL_STATE_RGBA[name] ?? VESSEL_STATE_RGBA.idle;
  return new Color(rgba[0], rgba[1], rgba[2], 1);
}
const STATE_COLORS = VESSEL_STATES.map((name) => stateColor(name));
const FALLBACK_COLOR = STATE_COLORS[3];

export class VesselLayer implements SceneLayer {
  readonly id = 'vessels';
  readonly label = '船舶';

  private collection: PointPrimitiveCollection | null = null;
  private primitives: PointPrimitive[] = [];
  private visible = true;
  private highlighted = new Set<string>();

  build(model: SceneModel, viewer: Viewer): void {
    this.collection = viewer.scene.primitives.add(new PointPrimitiveCollection());
    this.primitives = [];

    const motion = model.motion;
    if (!motion) return;

    for (const track of motion.vessels) {
      const payload: PickPayload = {
        kind: 'vessel',
        id: track.vesselId,
        label: track.vesselId,
      };
      const primitive = this.collection.add({
        position: Cartesian3.fromDegrees(0, 0, 0),
        color: FALLBACK_COLOR,
        pixelSize: BASE_PIXEL,
        outlineColor: OUTLINE_NORMAL,
        outlineWidth: 1,
        id: payload,
        show: false,
      });
      this.primitives.push(primitive);
    }
  }

  update(model: SceneModel, now: number): void {
    const motion = model.motion;
    if (!motion || !this.visible) return;

    const timeline = motion.timeline;
    const frame = frameIndexAt(timeline, now);
    const nextFrame = Math.min(frame + 1, timeline.length - 1);
    const span = timeline[nextFrame] - timeline[frame];
    const t = span > 0 ? Math.min(1, Math.max(0, (now - timeline[frame]) / span)) : 0;

    const vessels = motion.vessels;
    for (let i = 0; i < vessels.length; i += 1) {
      const primitive = this.primitives[i];
      if (!primitive) continue;
      const track = vessels[i];

      const lonA = track.lon[frame];
      const latA = track.lat[frame];
      const lonB = track.lon[nextFrame];
      const latB = track.lat[nextFrame];
      if (!Number.isFinite(lonA) || !Number.isFinite(latA)) {
        primitive.show = false;
        continue;
      }

      // Either neighbour may be NaN (voyage start/end): fall back to the
      // known sample instead of hiding a vessel that is still sailing.
      const lon = Number.isFinite(lonB) ? interpolateLon(lonA, lonB, t) : lonA;
      const lat = Number.isFinite(latB) ? latA + (latB - latA) * t : latA;

      Cartesian3.fromDegrees(lon, lat, 0, Ellipsoid.WGS84, POSITION_SCRATCH);
      primitive.position = POSITION_SCRATCH;
      primitive.show = true;
      primitive.color = STATE_COLORS[track.state[frame]] ?? FALLBACK_COLOR;

      const teu = track.teu[frame] || 0;
      const grown = BASE_PIXEL + teu / TEU_PER_PIXEL;
      primitive.pixelSize = Math.max(MIN_PIXEL, Math.min(MAX_PIXEL, grown));
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
    for (const primitive of this.primitives) {
      const payload = primitive.id as PickPayload | undefined;
      const active = payload ? this.highlighted.has(payload.id) : false;
      primitive.outlineWidth = active ? 3 : 1;
      primitive.outlineColor = active ? OUTLINE_HIGHLIGHT : OUTLINE_NORMAL;
    }
  }

  dispose(): void {
    this.collection = null;
    this.primitives = [];
  }
}

/** Interpolate along the shortest longitude arc and normalise to [-180, 180]. */
function interpolateLon(a: number, b: number, t: number): number {
  let delta = b - a;
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  const value = a + delta * t;
  if (value > 180) return value - 360;
  if (value < -180) return value + 360;
  return value;
}
