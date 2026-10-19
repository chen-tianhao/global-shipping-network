/**
 * Minimal typed publish/subscribe bus.
 *
 * The plan calls for 3D, panels and charts to communicate through events rather
 * than direct references. This is the whole implementation: a Map of handler
 * sets, no framework, no Cesium import.
 */

import type { PickPayload } from '../data/types';
import type { CameraPreset } from '../viewmodel/cameraPresets';

export interface SelectionEvent {
  payload: PickPayload | null;
  /** Distinguishes a click on the globe from a click on a chart. */
  source: 'scene' | 'chart';
  /** Optional multi-selection (e.g. an OD cell highlights both endpoints). */
  ids?: string[];
}

export interface TimeChangedEvent {
  day: number;
  playing: boolean;
}

export interface WscEventMap {
  'selection:changed': SelectionEvent;
  'time:changed': TimeChangedEvent;
  'layer:toggled': { layerId: string; visible: boolean };
  'chart:hover': { series: string; day: number };
  'viewport:changed': { preset: CameraPreset };
}

type Handler<T> = (payload: T) => void;

export interface EventBus {
  on<K extends keyof WscEventMap>(
    type: K,
    handler: Handler<WscEventMap[K]>,
  ): () => void;
  emit<K extends keyof WscEventMap>(type: K, payload: WscEventMap[K]): void;
}

type AnyHandler = (payload: never) => void;

export function createEventBus(): EventBus {
  const handlers = new Map<keyof WscEventMap, Set<AnyHandler>>();

  return {
    on(type, handler) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set<AnyHandler>();
        handlers.set(type, set);
      }
      set.add(handler as AnyHandler);
      return () => {
        set?.delete(handler as AnyHandler);
      };
    },
    emit(type, payload) {
      const set = handlers.get(type);
      if (!set) return;
      // Copy so a handler can unsubscribe during dispatch.
      for (const handler of [...set]) {
        (handler as (value: unknown) => void)(payload);
      }
    },
  };
}
