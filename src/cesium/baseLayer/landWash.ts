/**
 * Land wash for the `none` base map: one equirectangular RGBA tile with the
 * land tinted and the sea left transparent.
 *
 * This is deliberately not a polygon layer. The wash only has to answer
 * "which side of the line is land"; a single texture does that in one draw
 * with no triangulation and no antimeridian/pole handling. The feathered edge
 * is one-sided (land only), so it never suggests water where the vector
 * coastline says otherwise, and the coastline itself stays crisp on top at any
 * zoom.
 *
 * Decorative: it carries no ids, so it must never intercept picking, and it is
 * skipped entirely when a real imagery base map is active.
 */

import { t } from '../../i18n';
import {
  ImageryLayer,
  SingleTileImageryProvider,
  type Viewer,
} from 'cesium';
import type { SceneModel } from '../../viewmodel/sceneModel';
import type { SceneLayer } from '../layers/SceneLayer';

export class LandWashLayer implements SceneLayer {
  readonly id = 'landwash';
  get label(): string { return t('layer.landwash'); }

  private layer: ImageryLayer | null = null;
  private visible = true;

  private constructor(private readonly provider: SingleTileImageryProvider) {}

  /** Returns null when the tile is missing - the app still runs without it. */
  static async create(url: string): Promise<LandWashLayer | null> {
    try {
      // `fromUrl` loads the texture through Cesium's own imagery machinery;
      // this layer never reads data files itself.
      const provider = await SingleTileImageryProvider.fromUrl(url);
      return new LandWashLayer(provider);
    } catch (error) {
      console.warn('[landwash] texture unavailable, globe stays flat:', error);
      return null;
    }
  }

  build(_model: SceneModel, viewer: Viewer): void {
    this.layer = viewer.imageryLayers.addImageryProvider(this.provider);
    this.layer.show = this.visible;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.layer) this.layer.show = visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  highlight(): void {
    // Base-map decoration; highlighting does not apply.
  }

  dispose(): void {
    this.layer = null;
  }
}
