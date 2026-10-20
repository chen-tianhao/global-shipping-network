/**
 * Camera presets as pure view-model data. `src/cesium/camera.ts` turns these
 * numbers into a Cesium Rectangle; the UI only needs the labels.
 */

export type CameraPreset =
  | 'global'
  | 'east-asia'
  | 'north-europe'
  | 'north-america';

export interface CameraPresetDefinition {
  // The label is a dictionary entry keyed by the preset id (preset.<id>), so
  // this module stays free of user-facing text.
  west: number;
  south: number;
  east: number;
  north: number;
}

export const CAMERA_PRESETS: Record<CameraPreset, CameraPresetDefinition> = {
  global: { west: -180, south: -60, east: 180, north: 70 },
  'east-asia': { west: 95, south: -15, east: 145, north: 50 },
  'north-europe': { west: -12, south: 44, east: 32, north: 63 },
  'north-america': { west: -130, south: 20, east: -60, north: 55 },
};

export const CAMERA_PRESET_ORDER: CameraPreset[] = [
  'global',
  'east-asia',
  'north-europe',
  'north-america',
];
