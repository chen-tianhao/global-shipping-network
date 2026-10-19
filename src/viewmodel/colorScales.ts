/**
 * Shared colour ramps. Kept engine-agnostic as [r,g,b,a] in 0..1 so both the
 * Cesium layers and the 2D panels can use the same legend.
 */

export type RGBA = readonly [number, number, number, number];

const PORT_WAITING_STOPS: Array<[number, RGBA]> = [
  [0, [0.29, 0.72, 0.85, 1]],
  [400, [0.35, 0.85, 0.55, 1]],
  [900, [0.98, 0.83, 0.36, 1]],
  [1600, [0.95, 0.55, 0.28, 1]],
  [2600, [0.86, 0.25, 0.25, 1]],
];

export const VESSEL_STATE_RGBA: Record<string, RGBA> = {
  sailing: [0.35, 0.85, 0.95, 1],
  queuing: [0.98, 0.65, 0.25, 1],
  served: [0.45, 0.9, 0.45, 1],
  idle: [0.62, 0.66, 0.72, 1],
};

export function portWaitingColor(totalTeu: number): RGBA {
  return interpolate(PORT_WAITING_STOPS, totalTeu);
}

export function utilizationColor(utilization: number): RGBA {
  return interpolate(
    [
      [0, [0.35, 0.45, 0.62, 1]],
      [0.25, [0.35, 0.85, 0.55, 1]],
      [0.5, [0.98, 0.83, 0.36, 1]],
      [0.75, [0.95, 0.55, 0.28, 1]],
      [1, [0.86, 0.25, 0.25, 1]],
    ],
    utilization,
  );
}

function interpolate(stops: Array<[number, RGBA]>, value: number): RGBA {
  if (value <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (value >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i += 1) {
    const [prevValue, prevColor] = stops[i - 1];
    const [nextValue, nextColor] = stops[i];
    if (value <= nextValue) {
      const t = (value - prevValue) / (nextValue - prevValue || 1);
      return [
        prevColor[0] + (nextColor[0] - prevColor[0]) * t,
        prevColor[1] + (nextColor[1] - prevColor[1]) * t,
        prevColor[2] + (nextColor[2] - prevColor[2]) * t,
        prevColor[3] + (nextColor[3] - prevColor[3]) * t,
      ];
    }
  }
  return last[1];
}

/** CSS colour string for the 2D panels / legend swatches. */
export function toCss([r, g, b, a]: RGBA): string {
  const to255 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${to255(r)}, ${to255(g)}, ${to255(b)}, ${a})`;
}

export const LEGEND_PORT_WAITING = PORT_WAITING_STOPS;
