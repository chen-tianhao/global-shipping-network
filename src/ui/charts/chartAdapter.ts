/**
 * Chart-library-neutral contract.
 *
 * The panel builds a neutral `ChartSpec`; `PlotlyAdapter` is the only file that
 * knows Plotly. Swapping in ECharts later means replacing one adapter, exactly
 * as the plan's §6.3 promises.
 */

export interface ChartSeries {
  name: string;
  x: Array<number | string>;
  y: Array<number | null>;
  color?: string;
}

export interface LineChartSpec {
  type: 'line';
  series: ChartSeries[];
  xTitle?: string;
  yTitle?: string;
  /** Simulation day drawn as a vertical cursor (null hides it). */
  markerDay?: number | null;
}

export interface BarChartSpec {
  type: 'bar';
  categories: string[];
  values: Array<number | null>;
  colors?: string[];
  /** Parallel to `categories`; used to turn a click into a business id. */
  categoryIds?: string[];
  xTitle?: string;
  yTitle?: string;
}

export interface HeatmapChartSpec {
  type: 'heatmap';
  rows: string[];
  cols: string[];
  values: Array<Array<number | null>>;
  rowIds?: string[];
  colIds?: string[];
  xTitle?: string;
  yTitle?: string;
}

export type ChartSpec = LineChartSpec | BarChartSpec | HeatmapChartSpec;

export interface ChartHoverPayload {
  series: string;
  day?: number;
  category?: string;
  categoryId?: string;
  rowId?: string;
  colId?: string;
  value?: number;
}

export interface ChartAdapter {
  render(el: HTMLElement, spec: ChartSpec): Promise<void>;
  update(el: HTMLElement, spec: ChartSpec): Promise<void>;
  on(
    el: HTMLElement,
    event: 'hover' | 'click',
    cb: (payload: ChartHoverPayload) => void,
  ): void;
  dispose(el: HTMLElement): void;
}
