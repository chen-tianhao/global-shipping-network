/**
 * Runtime configuration. Everything environment-specific lives here so nothing
 * else needs to change between local runs, a demo build and a deployment.
 *
 * Precedence (later wins):
 *   1. defaults below
 *   2. `window.WSC_MAP_CONFIG` / `window.WSC_CONFIG`
 *   3. URL query parameters (?baseLayer=...&days=...&apiKey=...)
 */

import { BASE_LAYER_REGISTRY, type BaseLayerRuntimeConfig } from '../cesium/baseLayer/baseLayerProvider';
import type { TimeRange } from '../data/types';

export interface AppConfig {
  /** Base URL of the `public/data` assets. */
  dataBaseUrl: string;
  /** Id into `BASE_LAYER_REGISTRY`. */
  baseLayerId: string;
  /** Key / url for the base map - supplied at runtime, never in source. */
  baseLayerConfig: BaseLayerRuntimeConfig;
  /** Draw the local coastline asset (only meaningful with the none base map). */
  showCoastline: boolean;
  timeRange: TimeRange;
  /** Wall-clock multiplier applied to the Cesium clock at start-up. */
  clockMultiplier: number;
  /** Start playing automatically. */
  autoPlay: boolean;
}

export interface RuntimeConfig {
  baseLayer?: string;
  apiKey?: string;
  tileUrl?: string;
  dataBaseUrl?: string;
  days?: number | string;
  multiplier?: number | string;
  coastline?: boolean;
  autoPlay?: boolean;
}

declare global {
  interface Window {
    WSC_MAP_CONFIG?: RuntimeConfig;
    WSC_CONFIG?: RuntimeConfig;
  }
}

const DEFAULT_DAYS = 360;

export function resolveConfig(): AppConfig {
  const params = new URLSearchParams(window.location.search);
  const declared = { ...(window.WSC_CONFIG ?? {}), ...(window.WSC_MAP_CONFIG ?? {}) };

  const baseLayerId = firstString(params.get('baseLayer'), declared.baseLayer) ?? 'none';
  const days = firstNumber(params.get('days'), declared.days) ?? DEFAULT_DAYS;

  return {
    dataBaseUrl: firstString(params.get('data'), declared.dataBaseUrl) ?? 'data',
    baseLayerId,
    baseLayerConfig: {
      apiKey: firstString(params.get('apiKey'), declared.apiKey),
      url: firstString(params.get('tileUrl'), declared.tileUrl),
    },
    showCoastline:
      firstBool(params.get('coastline'), declared.coastline) ??
      // A tile base map already shows continents, so the outline is redundant.
      baseLayerId === 'none',
    timeRange: { startDay: 0, endDay: days },
    clockMultiplier: firstNumber(params.get('multiplier'), declared.multiplier) ?? 3600,
    autoPlay: firstBool(params.get('autoPlay'), declared.autoPlay) ?? true,
  };
}

/** Human description of the active base map, for the HUD. */
export function describeBaseLayer(config: AppConfig): string {
  const factory = BASE_LAYER_REGISTRY[config.baseLayerId];
  if (!factory) return `未知底图 "${config.baseLayerId}"，已回退到 none`;
  const provider = factory();
  if (provider.requiresKey && !config.baseLayerConfig.apiKey) {
    return `${provider.label}（缺少 key，已回退到无底图）`;
  }
  return provider.label;
}

function firstString(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function firstNumber(
  ...values: Array<string | number | undefined | null>
): number | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstBool(
  ...values: Array<string | boolean | undefined | null>
): boolean | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'boolean') return value;
    const normalised = value.trim().toLowerCase();
    if (normalised === 'true' || normalised === '1') return true;
    if (normalised === 'false' || normalised === '0') return false;
  }
  return undefined;
}
