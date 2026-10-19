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
  label: string;
  west: number;
  south: number;
  east: number;
  north: number;
}

export const CAMERA_PRESETS: Record<CameraPreset, CameraPresetDefinition> = {
  global: { label: '全球', west: -180, south: -60, east: 180, north: 70 },
  'east-asia': { label: '东亚', west: 95, south: -15, east: 145, north: 50 },
  'north-europe': { label: '北欧', west: -12, south: 44, east: 32, north: 63 },
  'north-america': { label: '北美', west: -130, south: 20, east: -60, north: 55 },
};

export const CAMERA_PRESET_ORDER: CameraPreset[] = [
  'global',
  'east-asia',
  'north-europe',
  'north-america',
];
