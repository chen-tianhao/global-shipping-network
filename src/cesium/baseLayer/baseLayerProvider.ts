/**
 * Base-map seam.
 *
 * WHY THIS EXISTS
 * ---------------
 * The globe can render without any third-party tile service, and that is the
 * default here. Every base map is an interchangeable adapter behind one
 * interface, so tile sourcing stays a configuration decision rather than
 * something baked into the renderer.
 *
 * COMPLIANCE BOUNDARY (read before adding a provider)
 * ---------------------------------------------------
 * Tile services differ by jurisdiction and licensing. Do not wire a provider
 * into this file unless the data source's terms and the applicable map
 * regulations have been checked for how the app will actually be published.
 * In particular:
 *   - never hard-code a usable API key in front-end source; read it from
 *     runtime config / environment and, for commercial use, proxy the key
 *     through a back end;
 *   - tile sources whose boundary and territory rendering does not match the
 *     national standard must not be shipped as the default.
 * A placeholder, not a key, belongs in committed code.
 *
 * HOW TO ADD A BASE MAP (three steps, no renderer changes)
 * --------------------------------------------------------
 *   1. Create `src/cesium/baseLayer/<yourProvider>.ts` implementing
 *      `BaseLayerProvider`. Return `null` when it cannot be used (missing key,
 *      offline) and the viewer will fall back to the bare globe.
 *   2. Register it in `BASE_LAYER_REGISTRY` below with a stable id.
 *   3. Set `baseLayer: '<your-id>'` in `src/app/config.ts` (or pass
 *      `?baseLayer=<id>` in the URL for a quick try-out).
 *
 * Keys are supplied at runtime, not in source:
 *   window.WSC_MAP_CONFIG = { baseLayer: 'your-id', apiKey: '...' }
 * or via a build-time env var. Never commit a real key.
 */

import type { ImageryProvider } from 'cesium';
import { Color } from 'cesium';

export interface BaseLayerProvider {
  readonly id: string;
  readonly label: string;
  /** Shown in the UI when the provider cannot be activated. */
  readonly requiresKey: boolean;
  readonly complianceNote: string;
  /** Resolve to null to render the bare globe instead. */
  createImageryProvider(): Promise<ImageryProvider | null>;
}

export interface BaseLayerRuntimeConfig {
  apiKey?: string;
  url?: string;
}

/** Placeholder text that must appear wherever a key is expected in source. */
export const KEY_PLACEHOLDER =
  '请在对应开放平台自行申请并替换此占位符（不要提交真实 key）';

/**
 * Default: no tiles at all. The globe renders with a flat base colour and the
 * app draws its own coastline, so there is no key, no tile licence and no
 * network dependency.
 */
export class NoneBaseLayerProvider implements BaseLayerProvider {
  readonly id = 'none';
  readonly label = '无底图（纯色地球 + 自绘海岸线）';
  readonly requiresKey = false;
  readonly complianceNote = '不加载任何第三方瓦片，无 key、无瓦片合规负担，可离线运行。';
  readonly baseColor = Color.fromCssColorString('#0b1a2b');

  async createImageryProvider(): Promise<ImageryProvider | null> {
    return null;
  }
}

/**
 * Registry of available base maps.
 *
 * Only `none` ships enabled. Add your own provider file and register it here.
 * Deliberately NOT implemented here: OpenStreetMap and other crowd-sourced /
 * non-licensed tile services - see the compliance boundary above. If you have
 * confirmed that such a source is appropriate for your deployment, add it as
 * your own provider module; the interface will accept it.
 */
export const BASE_LAYER_REGISTRY: Record<string, () => BaseLayerProvider> = {
  none: () => new NoneBaseLayerProvider(),
};

export function createBaseLayerProvider(
  id: string,
  _config: BaseLayerRuntimeConfig = {},
): BaseLayerProvider {
  const factory = BASE_LAYER_REGISTRY[id];
  if (!factory) {
    console.warn(
      `[baseLayer] unknown provider "${id}", falling back to "none". Known: ${Object.keys(
        BASE_LAYER_REGISTRY,
      ).join(', ')}`,
    );
    return new NoneBaseLayerProvider();
  }
  return factory();
}
