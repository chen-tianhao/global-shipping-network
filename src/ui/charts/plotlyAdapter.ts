/**
 * Plotly adapter. The only module that knows Plotly exists.
 *
 * The vendored `plotly.min.js` (4.5 MB) is loaded lazily, only when the chart
 * panel first renders, so start-up is not blocked by the chart library.
 */

import type {
  BarChartSpec,
  ChartAdapter,
  ChartHoverPayload,
  ChartSpec,
  HeatmapChartSpec,
  LineChartSpec,
} from './chartAdapter';

interface PlotlyPoint {
  x?: unknown;
  y?: unknown;
  z?: unknown;
  data?: { name?: string };
}

interface PlotlyApi {
  newPlot(
    el: HTMLElement,
    data: Array<Record<string, unknown>>,
    layout: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<unknown>;
  react(
    el: HTMLElement,
    data: Array<Record<string, unknown>>,
    layout: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<unknown>;
  purge(el: HTMLElement): void;
}

declare global {
  interface Window {
    Plotly?: PlotlyApi;
  }
}

const BASE_LAYOUT: Record<string, unknown> = {
  autosize: true,
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
  font: { color: '#dce8f7', size: 10 },
  showlegend: false,
  hoverlabel: { bgcolor: '#0b1a2b', bordercolor: '#2f6f8f', font: { size: 11 } },
};

const PLOTLY_CONFIG: Record<string, unknown> = {
  displayModeBar: false,
  responsive: true,
  scrollZoom: false,
};

let plotlyPromise: Promise<PlotlyApi> | null = null;

function loadPlotly(): Promise<PlotlyApi> {
  if (window.Plotly) return Promise.resolve(window.Plotly);
  if (plotlyPromise) return plotlyPromise;

  plotlyPromise = new Promise<PlotlyApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('vendor/plotly.min.js', document.baseURI).toString();
    script.async = true;
    script.onload = () => {
      if (window.Plotly) resolve(window.Plotly);
      else reject(new Error('Plotly loaded but window.Plotly is missing'));
    };
    script.onerror = () => reject(new Error(`Failed to load ${script.src}`));
    document.head.append(script);
  }).catch((error: unknown) => {
    // Allow a later retry (e.g. after a transient 404 while developing).
    plotlyPromise = null;
    throw error;
  });

  return plotlyPromise;
}

const specByElement = new WeakMap<HTMLElement, ChartSpec>();
const hoverHandlers = new WeakMap<
  HTMLElement,
  Set<(payload: ChartHoverPayload) => void>
>();
const clickHandlers = new WeakMap<
  HTMLElement,
  Set<(payload: ChartHoverPayload) => void>
>();

function axis(
  title: string | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    gridcolor: 'rgba(120,170,220,0.14)',
    zeroline: false,
    linecolor: 'rgba(120,170,220,0.25)',
    tickfont: { size: 9 },
    ...extra,
  };
  if (title) result.title = { text: title, font: { size: 10 } };
  return result;
}

function lineLayout(spec: LineChartSpec): Record<string, unknown> {
  const shapes =
    spec.markerDay === null || spec.markerDay === undefined
      ? []
      : [
          {
            type: 'line',
            x0: spec.markerDay,
            x1: spec.markerDay,
            y0: 0,
            y1: 1,
            yref: 'paper',
            line: { color: '#ffd166', width: 1, dash: 'dot' },
          },
        ];

  return {
    ...BASE_LAYOUT,
    margin: { l: 46, r: 12, t: 8, b: 34 },
    xaxis: axis(spec.xTitle ?? 'Day'),
    yaxis: axis(spec.yTitle),
    hovermode: 'x unified',
    shapes,
  };
}

function barLayout(spec: BarChartSpec): Record<string, unknown> {
  return {
    ...BASE_LAYOUT,
    margin: { l: 92, r: 12, t: 8, b: 34 },
    xaxis: axis(spec.xTitle ?? 'TEU'),
    yaxis: axis(undefined, {
      autorange: 'reversed',
      tickfont: { size: 9 },
      automargin: true,
    }),
    bargap: 0.25,
  };
}

function heatmapLayout(spec: HeatmapChartSpec): Record<string, unknown> {
  return {
    ...BASE_LAYOUT,
    margin: { l: 84, r: 8, t: 8, b: 72 },
    xaxis: axis(undefined, {
      tickangle: -45,
      tickfont: { size: 8 },
      automargin: true,
    }),
    yaxis: axis(undefined, {
      tickfont: { size: 8 },
      automargin: true,
    }),
  };
}

function traces(spec: ChartSpec): Array<Record<string, unknown>> {
  if (spec.type === 'line') {
    return spec.series.map((series) => ({
      x: series.x,
      y: series.y,
      type: 'scatter',
      mode: 'lines',
      name: series.name,
      line: { color: series.color ?? '#4cc9f0', width: 2 },
      hovertemplate: `<extra>${series.name}</extra>`,
    }));
  }

  if (spec.type === 'bar') {
    return [
      {
        x: spec.values,
        y: spec.categories,
        type: 'bar',
        orientation: 'h',
        marker: { color: spec.colors ?? '#4cc9f0' },
        hovertemplate: '%{y}: %{x:,.0f}<extra></extra>',
      },
    ];
  }

  return [
    {
      z: spec.values,
      x: spec.cols,
      y: spec.rows,
      type: 'heatmap',
      colorscale: 'Viridis',
      hovertemplate: '%{y} → %{x}: %{z:,.0f}<extra></extra>',
      colorbar: { thickness: 8, tickfont: { size: 8 }, len: 0.85 },
    },
  ];
}

function layoutFor(spec: ChartSpec): Record<string, unknown> {
  if (spec.type === 'line') return lineLayout(spec);
  if (spec.type === 'bar') return barLayout(spec);
  return heatmapLayout(spec);
}

function mapPoint(
  el: HTMLElement,
  point: PlotlyPoint | undefined,
): ChartHoverPayload | null {
  const spec = specByElement.get(el);
  if (!spec || !point) return null;

  if (spec.type === 'line') {
    return {
      series: String(point.data?.name ?? 'series'),
      day: Number(point.x),
      value: Number(point.y),
    };
  }

  if (spec.type === 'bar') {
    const category = String(point.y);
    const index = spec.categories.indexOf(category);
    return {
      series: 'ports',
      category,
      categoryId: spec.categoryIds?.[index],
      value: Number(point.x),
    };
  }

  const row = spec.rows.indexOf(String(point.y));
  const col = spec.cols.indexOf(String(point.x));
  return {
    series: 'od',
    rowId: spec.rowIds?.[row],
    colId: spec.colIds?.[col],
    category: `${String(point.y)} → ${String(point.x)}`,
    value: Number(point.z),
  };
}

function bindOnce(
  el: HTMLElement,
  event: 'plotly_hover' | 'plotly_click',
  handlers: WeakMap<HTMLElement, Set<(payload: ChartHoverPayload) => void>>,
): void {
  if (handlers.has(el)) return;
  handlers.set(el, new Set());

  const target = el as unknown as {
    on: (name: string, cb: (data: { points?: PlotlyPoint[] }) => void) => void;
  };
  target.on(event, (data) => {
    const payload = mapPoint(el, data.points?.[0]);
    if (!payload) return;
    for (const handler of handlers.get(el) ?? []) handler(payload);
  });
}

export class PlotlyAdapter implements ChartAdapter {
  async render(el: HTMLElement, spec: ChartSpec): Promise<void> {
    const Plotly = await loadPlotly();
    specByElement.set(el, spec);
    await Plotly.newPlot(el, traces(spec), layoutFor(spec), PLOTLY_CONFIG);
  }

  async update(el: HTMLElement, spec: ChartSpec): Promise<void> {
    const Plotly = await loadPlotly();
    specByElement.set(el, spec);
    await Plotly.react(el, traces(spec), layoutFor(spec), PLOTLY_CONFIG);
  }

  on(
    el: HTMLElement,
    event: 'hover' | 'click',
    cb: (payload: ChartHoverPayload) => void,
  ): void {
    if (event === 'hover') {
      bindOnce(el, 'plotly_hover', hoverHandlers);
      hoverHandlers.get(el)?.add(cb);
      return;
    }
    bindOnce(el, 'plotly_click', clickHandlers);
    clickHandlers.get(el)?.add(cb);
  }

  dispose(el: HTMLElement): void {
    window.Plotly?.purge(el);
    specByElement.delete(el);
    hoverHandlers.delete(el);
    clickHandlers.delete(el);
  }
}
