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
import { el } from '../dom';
import type { EventBus } from '../eventBus';
import type { ChartAdapter, ChartHoverPayload, ChartSpec } from './chartAdapter';
import { PlotlyAdapter } from './plotlyAdapter';

type Tab = 'att' | 'ports' | 'od';

export interface ChartPanel {
  dispose(): void;
}

const TAB_DEFS: Array<[Tab, string]> = [
  ['att', 'ATT 时序'],
  ['ports', '港口等待'],
  ['od', 'OD 矩阵'],
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
  header.append(el('h2', 'chart-panel__title', '统计图表'));

  const tabs = el('div', 'chart-panel__tabs');
  const availableTabs = window.matchMedia(NARROW_QUERY).matches
    ? TAB_DEFS.filter(([tab]) => tab !== 'od')
    : TAB_DEFS;
  for (const [tab, label] of availableTabs) {
    const button = el('button', 'chart-panel__tab', label);
    button.type = 'button';
    button.addEventListener('click', () => setTab(tab));
    buttons.set(tab, button);
    tabs.append(button);
  }
  header.append(tabs);

  const collapse = el('button', 'chart-panel__collapse', '收起');
  collapse.type = 'button';
  collapse.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('is-collapsed');
    collapse.textContent = collapsed ? '展开' : '收起';
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

  setTab('att');

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
      body.append(
        el('p', 'chart-panel__empty', '统计 CSV 未加载，或该图表没有数据。'),
      );
      eventsBound = false;
      return;
    }

    adapter.dispose(body);
    eventsBound = false;
    body.innerHTML = '';
    body.append(el('p', 'chart-panel__empty', '正在加载图表库 …'));

    try {
      await adapter.render(body, spec);
      if (token !== renderToken) return;
      bindEvents();
      setHint(defaultHint());
    } catch (error) {
      if (token !== renderToken) return;
      body.innerHTML = '';
      body.append(
        el(
          'p',
          'chart-panel__error',
          `图表加载失败：${error instanceof Error ? error.message : String(error)}`,
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
          `OD ${payload.category}：${fmt(payload.value)} TEU（起讫港已选中）`,
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
        `Day ${Math.round(Number(payload.day))} · 平均运输时间 ${fmt(
          payload.value,
          2,
        )} 天`,
      );
      return;
    }

    if (payload.series === 'ports') {
      setHint(`${payload.category ?? ''}：${fmt(payload.value)} TEU`);
      return;
    }

    if (payload.series === 'od') {
      setHint(`${payload.category ?? ''}：${fmt(payload.value)} TEU`);
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
      setHint(`已选港口：${payload.label}`);
      return;
    }
    if (payload) setHint(`已选：${payload.label}`);
    else setHint(defaultHint());
    if (activeTab === 'ports') void updateActive();
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
        xTitle: '仿真天（Day）',
        yTitle: '平均运输时间（天）',
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
        xTitle: '等待 TEU（全程均值）',
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
    if (activeTab === 'att') {
      return '悬停曲线定位时间；竖线为当前时钟位置。';
    }
    if (activeTab === 'ports') {
      return '点击柱状图选中港口，三维视图会同步高亮。';
    }
    return '点击矩阵单元选中起点港口；颜色为平均在途 TEU。';
  }

  return {
    dispose(): void {
      offSelection();
      offTime();
      adapter.dispose(body);
    },
  };
}

function fmt(value: number | undefined, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return Number(value).toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
