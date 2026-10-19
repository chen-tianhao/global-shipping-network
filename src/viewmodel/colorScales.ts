/**
 * Shared colour ramps. Kept engine-agnostic as [r,g,b,a] in 0..1 so both the
 * Cesium layers and the 2D panels can use the same legend.
 */

export type RGBA = readonly [number, number, number, number];
export type ColorStop = readonly [value: number, color: RGBA];

const WAITING_COLORS: RGBA[] = [
  [0.29, 0.72, 0.85, 1],
  [0.35, 0.85, 0.55, 1],
  [0.98, 0.83, 0.36, 1],
  [0.95, 0.55, 0.28, 1],
  [0.86, 0.25, 0.25, 1],
];

const QUANTILES = [0, 0.25, 0.5, 0.75, 1];

/**
 * Quantile stops derived from the actual waiting-TEU values.
 *
 * The previous fixed 0..2600 ramp advertised a range three times wider than
 * the data (the busiest port peaks around 750 TEU), so every port sat in the
 * blue-green end and the legend lied about the domain. Quantiles use the whole
 * ramp and keep the legend honest for whatever dataset is loaded.
 */
export function portWaitingStops(values: number[]): ColorStop[] {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  if (sorted.length === 0) {
    return QUANTILES.map(
      (quantile, index) => [quantile, WAITING_COLORS[index]] as ColorStop,
    );
  }

  const picked = QUANTILES.map((quantile) => {
    const index = Math.min(
      sorted.length - 1,
      Math.round(quantile * (sorted.length - 1)),
    );
    return sorted[index];
  });

  // Quantiles can repeat when many ports share a value; keep the stops strictly
  // increasing so the interpolation never divides by zero.
  const stops: ColorStop[] = [];
  for (let i = 0; i < picked.length; i += 1) {
    let value = picked[i];
    if (i > 0 && value <= stops[i - 1][0]) {
      value = stops[i - 1][0] + 0.5;
    }
    stops.push([value, WAITING_COLORS[i]]);
  }
  return stops;
}

export const VESSEL_STATE_RGBA: Record<string, RGBA> = {
  sailing: [0.35, 0.85, 0.95, 1],
  queuing: [0.98, 0.65, 0.25, 1],
  served: [0.45, 0.9, 0.45, 1],
  idle: [0.62, 0.66, 0.72, 1],
};

const DEFAULT_WAITING_STOPS = portWaitingStops([]);

export function portWaitingColor(
  totalTeu: number,
  stops: ColorStop[] = DEFAULT_WAITING_STOPS,
): RGBA {
  return interpolate(stops, totalTeu);
}

const UTILIZATION_STOPS: ColorStop[] = [
  [0, [0.35, 0.45, 0.62, 1]],
  [0.25, [0.35, 0.85, 0.55, 1]],
  [0.5, [0.98, 0.83, 0.36, 1]],
  [0.75, [0.95, 0.55, 0.28, 1]],
  [1, [0.86, 0.25, 0.25, 1]],
];

export function utilizationColor(utilization: number): RGBA {
  return interpolate(UTILIZATION_STOPS, utilization);
}

function interpolate(stops: ColorStop[], value: number): RGBA {
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
