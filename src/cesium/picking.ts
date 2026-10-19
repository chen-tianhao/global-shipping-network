/**
 * Click / hover picking.
 *
 * Render layers attach a `PickPayload` (business id, never a Cesium object) to
 * every primitive. This module surfaces those payloads to the UI, so panels can
 * drive the globe by id and vice versa.
 *
 * `scene.pick` returns different shapes depending on what was hit, so both are
 * handled: the primitive itself, or a wrapper carrying `primitive`.
 */

import {
  Cartesian2,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  type Viewer,
} from 'cesium';
import type { PickPayload } from './layers/SceneLayer';

export interface PickHandlers {
  onPick(payload: PickPayload | null): void;
  /** Double click is the "fly to" gesture; single click only selects. */
  onDoublePick?(payload: PickPayload | null): void;
  onHover?(payload: PickPayload | null, position: Cartesian2): void;
}

export function installPicking(viewer: Viewer, handlers: PickHandlers): () => void {
  const handler = new ScreenSpaceEventHandler(viewer.scene.canvas);

  handler.setInputAction((event: { position: Cartesian2 }) => {
    handlers.onPick(pickAt(viewer, event.position));
  }, ScreenSpaceEventType.LEFT_CLICK);

  if (handlers.onDoublePick) {
    const onDoublePick = handlers.onDoublePick;
    handler.setInputAction((event: { position: Cartesian2 }) => {
      onDoublePick(pickAt(viewer, event.position));
    }, ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  }

  if (handlers.onHover) {
    const hover = handlers.onHover;
    let lastHoverAt = 0;
    handler.setInputAction((event: { endPosition: Cartesian2 }) => {
      // Picking is a GPU read-back; throttle before it, not after.
      const now = performance.now();
      if (now - lastHoverAt < 100) return;
      lastHoverAt = now;

      const payload = pickAt(viewer, event.endPosition);
      hover(payload, event.endPosition);
      viewer.scene.canvas.style.cursor = payload ? 'pointer' : 'default';
    }, ScreenSpaceEventType.MOUSE_MOVE);
  }

  return () => handler.destroy();
}

function pickAt(viewer: Viewer, position: Cartesian2): PickPayload | null {
  const picked = viewer.scene.pick(position) as unknown;
  return extractPayload(picked);
}

export function extractPayload(picked: unknown): PickPayload | null {
  if (!picked || typeof picked !== 'object') return null;
  const direct = (picked as { id?: unknown }).id;
  if (isPayload(direct)) return direct;
  const nested = (picked as { primitive?: { id?: unknown } }).primitive?.id;
  if (isPayload(nested)) return nested;
  return null;
}

function isPayload(value: unknown): value is PickPayload {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PickPayload>;
  return (
    (candidate.kind === 'port' ||
      candidate.kind === 'vessel' ||
      candidate.kind === 'route' ||
      candidate.kind === 'disruption') &&
    typeof candidate.id === 'string'
  );
}
