import type { Viewer } from 'cesium';
import type { PickPayload } from '../../data/types';
import type { SceneModel } from '../../viewmodel/sceneModel';

export type { PickPayload };

/**
 * Contract for every renderable layer.
 *
 * `build` runs once; `update` may run every frame and must not allocate or
 * mutate collections. `highlight` is how the 2D panels drive the globe (they
 * pass business ids, never Cesium objects).
 */
export interface SceneLayer {
  readonly id: string;
  readonly label: string;
  build(model: SceneModel, viewer: Viewer): void;
  update?(model: SceneModel, now: number): void;
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  highlight(ids: string[]): void;
  dispose(): void;
}
