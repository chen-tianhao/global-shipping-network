/**
 * Bottom-right statistics panel.
 *
 * Tabs:
 *   ATT 时序   - the only true time series in the CSV bundle; hovering seeks
 *                the clock, and the clock draws a vertical cursor.
 *   港口等待   - whole-run average waiting TEU per port; clicking a bar selects
 *                the port in 3D.
 *   OD 矩阵    - 22 x 22 average in-transit TEU; clicking a cell selects the
 *                origin port.
 *
 * The port-waiting CSV is an aggregate, not a time series. The chart title says
 * so explicitly; a per-interval port export is still a data-side prerequisite
 * for the full plan §6.2 linkage.
 */

import type { PickPayload } from '../../data/types';
import type { SceneModel } from '../../viewmodel/sceneModel';
import {
  portWaitingColor,
  portWaitingStops,
  toCss,
} from '../../viewmodel/colorScales';
import { el, elI18n } from '../dom';
import { numberLocaleTag, t, translateDom, type MessageKey } from '../../i18n';
import type { EventBus } from '../eventBus';
import type { ChartAdapter, ChartHoverPayload, ChartSpec } from './chartAdapter';
import { PlotlyAdapter } from './plotlyAdapter';

type Tab = 'att' | 'ports' | 'od';

export interface ChartPanel {
  /** Re-label and re-render after a language change (axis titles are baked in). */
  refresh(): void;
  dispose(): void;
}

const TAB_DEFS: Array<[Tab, MessageKey]> = [
  ['ports', 'chart.tabPorts'],
  ['att', 'chart.tabAtt'],
  ['od', 'chart.tabOd'],
];

/**
 * 22x22 cells do not survive a 360 px wide sheet: each cell is ~14 px, below the
 * touch target minimum and unreadable. The OD matrix is desktop-only; phones
 * keep the two charts that still work at that width.
 */
const NARROW_QUERY = '(max-width: 640px)';

export function createChartPanel(
  root: HTMLElement,
  model: SceneModel,
  bus: EventBus,
): ChartPanel {
  const adapter: ChartAdapter = new PlotlyAdapter();
  const buttons = new Map<Tab, HTMLButtonElement>();

  let activeTab: Tab = 'att';
  let selection: PickPayload | null = null;
  let markerDay: number | null = null;
  let lastMarkerRender = Number.NaN;
  let renderToken = 0;
  let eventsBound = false;
  let lastHoverAt = 0;

  root.innerHTML = '';
  const panel = el('section', 'chart-panel');
  const header = el('header', 'chart-panel__header');
  header.append(elI18n('h2', 'chart-panel__title', 'chart.title'));

  const tabs = el('div', 'chart-panel__tabs');
  const availableTabs = window.matchMedia(NARROW_QUERY).matches
    ? TAB_DEFS.filter(([tab]) => tab !== 'od')
    : TAB_DEFS;
  for (const [tab, labelKey] of availableTabs) {
    const button = elI18n('button', 'chart-panel__tab', labelKey);
    button.type = 'button';
    button.addEventListener('click', () => setTab(tab));
    buttons.set(tab, button);
    tabs.append(button);
  }
  header.append(tabs);

  const collapse = el('button', 'chart-panel__collapse');
  collapse.type = 'button';
  const syncCollapseLabel = () => {
    const collapsed = panel.classList.contains('is-collapsed');
    collapse.textContent = collapsed ? t('chart.expand') : t('chart.collapse');
  };
  syncCollapseLabel();
  collapse.addEventListener('click', () => {
    panel.classList.toggle('is-collapsed');
    syncCollapseLabel();
  });
  header.append(collapse);

  const body = el('div', 'chart-panel__body');
  const hint = el('p', 'chart-panel__hint', '');
  panel.append(header, body, hint);
  root.append(panel);

  const offSelection = bus.on('selection:changed', ({ payload }) => {
    applySelection(payload);
  });
  const offTime = bus.on('time:changed', ({ day }) => {
    setTime(day);
  });

  setTab('ports');

  function setTab(tab: Tab): void {
    if (tab === activeTab && eventsBound) {
      void updateActive();
      return;
    }
    activeTab = tab;
    for (const [id, button] of buttons) {
      button.classList.toggle('is-active', id === tab);
    }
    void renderActive();
  }

  async function renderActive(): Promise<void> {
    const spec = currentSpec();
    const token = ++renderToken;

    if (!spec) {
      body.innerHTML = '';
      body.append(elI18n('p', 'chart-panel__empty', 'chart.empty'));
      eventsBound = false;
      return;
    }

    adapter.dispose(body);
    eventsBound = false;
    body.innerHTML = '';
    body.append(elI18n('p', 'chart-panel__empty', 'chart.loading'));

    try {
      await adapter.render(body, spec);
      if (token !== renderToken) return;
      // Plotly.newPlot appends its own DOM without removing the loading
      // placeholder, so clear it explicitly after a successful render.
      body.querySelector('.chart-panel__empty')?.remove();
      bindEvents();
      setHint(defaultHint());
    } catch (error) {
      if (token !== renderToken) return;
      body.innerHTML = '';
      body.append(
        el(
          'p',
          'chart-panel__error',
          t('chart.error', {
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
      console.error('[charts] render failed', error);
    }
  }

  async function updateActive(): Promise<void> {
    const spec = currentSpec();
    if (!spec || !eventsBound) {
      void renderActive();
      return;
    }
    try {
      await adapter.update(body, spec);
    } catch (error) {
      console.warn('[charts] update failed, re-rendering', error);
      eventsBound = false;
      void renderActive();
    }
  }

  function bindEvents(): void {
    if (eventsBound) return;
    eventsBound = true;
    adapter.on(body, 'click', onClick);
    adapter.on(body, 'hover', onHover);
  }

  function onClick(payload: ChartHoverPayload): void {
    if (payload.series === 'ATT' && Number.isFinite(payload.day)) {
      bus.emit('chart:hover', { series: 'att', day: Number(payload.day) });
      return;
    }

    if (payload.series === 'ports' && payload.categoryId) {
      const port = model.ports.find((item) => item.id === payload.categoryId);
      if (port) {
        bus.emit('selection:changed', {
          payload: { kind: 'port', id: port.id, label: port.name },
          source: 'chart',
        });
      }
      return;
    }

    if (payload.series === 'od' && payload.rowId) {
      const origin = model.ports.find((item) => item.id === payload.rowId);
      if (origin) {
        const destination = payload.colId
          ? model.ports.find((item) => item.id === payload.colId)
          : undefined;
        bus.emit('selection:changed', {
          payload: { kind: 'port', id: origin.id, label: origin.name },
          source: 'chart',
          // Highlight both endpoints of the OD pair, not just the origin.
          ids: [origin.id, destination?.id].filter(
            (id): id is string => Boolean(id),
          ),
        });
      }
      if (payload.category) {
        setHint(
          t('chart.hintOdCell', {
            pair: payload.category,
            value: fmt(payload.value),
          }),
        );
      }
    }
  }

  function onHover(payload: ChartHoverPayload): void {
    if (payload.series === 'ATT' && Number.isFinite(payload.day)) {
      const now = performance.now();
      if (now - lastHoverAt < 200) return;
      lastHoverAt = now;
      bus.emit('chart:hover', { series: 'att', day: Number(payload.day) });
      setHint(
        t('chart.hintAttHover', {
          day: Math.round(Number(payload.day)),
          value: fmt(payload.value, 2),
        }),
      );
      return;
    }

    if (payload.series === 'ports') {
      setHint(
        t('chart.hintValue', {
          name: payload.category ?? '',
          value: fmt(payload.value),
        }),
      );
      return;
    }

    if (payload.series === 'od') {
      setHint(
        t('chart.hintValue', {
          name: payload.category ?? '',
          value: fmt(payload.value),
        }),
      );
    }
  }

  function applySelection(payload: PickPayload | null): void {
    selection = payload;
    if (payload?.kind === 'port') {
      if (activeTab !== 'ports') {
        setTab('ports');
      } else {
        void updateActive();
      }
      setHint(hintForSelection());
      return;
    }
    setHint(hintForSelection());
    if (activeTab === 'ports') void updateActive();
  }

  /** Hint that matches the current selection, in the active language. */
  function hintForSelection(): string {
    if (selection?.kind === 'port') {
      return t('chart.hintSelectedPort', { name: selection.label });
    }
    if (selection) return t('chart.hintSelected', { name: selection.label });
    return defaultHint();
  }

  function setTime(day: number): void {
    // Keep the cursor inside the ATT data domain. A marker at Day -140 would
    // stretch the x-axis and squash the line into the right edge during warm-up.
    const periods = model.stats?.attByPeriod ?? [];
    const firstDay = periods[0]?.startDay ?? 0;
    const lastDay = periods[periods.length - 1]?.endDay ?? 0;
    const nextMarker = day >= firstDay && day <= lastDay ? day : null;

    const markerChanged = nextMarker !== markerDay;
    markerDay = nextMarker;

    if (activeTab !== 'att' || !eventsBound) return;
    if (!markerChanged && nextMarker === null) return;
    if (
      !markerChanged &&
      nextMarker !== null &&
      Math.abs(day - lastMarkerRender) < 0.5
    ) {
      return;
    }

    lastMarkerRender = day;
    void updateActive();
  }

  function currentSpec(): ChartSpec | null {
    if (activeTab === 'att') {
      const periods = model.stats?.attByPeriod ?? [];
      if (periods.length === 0) return null;
      return {
        type: 'line',
        series: [
          {
            name: 'ATT',
            x: periods.map((period) => period.startDay),
            y: periods.map((period) => period.att),
            color: '#4cc9f0',
          },
        ],
        xTitle: t('chart.attX'),
        yTitle: t('chart.attY'),
        markerDay,
      };
    }

    if (activeTab === 'ports') {
      const rows = [...(model.stats?.portWaiting ?? [])].sort(
        (a, b) => b.totalTeu - a.totalTeu,
      );
      if (rows.length === 0) return null;
      const stops = portWaitingStops(rows.map((row) => row.totalTeu));
      const selectedId = selection?.kind === 'port' ? selection.id : null;
      return {
        type: 'bar',
        categories: rows.map(
          (row) =>
            model.ports.find((port) => port.id === row.portId)?.name ??
            row.portId,
        ),
        categoryIds: rows.map((row) => row.portId),
        values: rows.map((row) => row.totalTeu),
        colors: rows.map((row) =>
          row.portId === selectedId
            ? '#ffd166'
            : toCss(portWaitingColor(row.totalTeu, stops)),
        ),
        xTitle: t('chart.portsX'),
      };
    }

    const matrix = model.stats?.inTransitByOd;
    if (!matrix || matrix.rows.length === 0) return null;
    return {
      type: 'heatmap',
      rows: matrix.rows.map(
        (id) => model.ports.find((port) => port.id === id)?.name ?? id,
      ),
      cols: matrix.cols.map(
        (id) => model.ports.find((port) => port.id === id)?.name ?? id,
      ),
      rowIds: matrix.rows,
      colIds: matrix.cols,
      values: matrix.values,
    };
  }

  function setHint(text: string): void {
    hint.textContent = text;
  }

  function defaultHint(): string {
    if (activeTab === 'att') return t('chart.hintAtt');
    if (activeTab === 'ports') return t('chart.hintPorts');
    return t('chart.hintOd');
  }

  return {
    refresh(): void {
      translateDom(panel);
      syncCollapseLabel();
      setHint(hintForSelection());
      // Axis titles are part of the chart spec, so the plot has to be rebuilt.
      void renderActive();
    },
    dispose(): void {
      offSelection();
      offTime();
      adapter.dispose(body);
    },
  };
}

function fmt(value: number | undefined, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return Number(value).toLocaleString(numberLocaleTag(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
