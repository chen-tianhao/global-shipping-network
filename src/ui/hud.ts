/**
 * Head-up display: status line, legend, layer toggles and selection details.
 *
 * Plain DOM on purpose - the panel content is small and changes rarely, so a
 * framework would add a virtual DOM competing with the WebGL loop for no
 * benefit. See the technical plan for the full reasoning.
 */

import { el, keyValue, panel, row, swatch } from './dom';
import {
  portWaitingStops,
  toCss,
  VESSEL_STATE_RGBA,
} from '../viewmodel/colorScales';
import { waitingTeuByPort } from '../viewmodel/sceneModel';
import {
  CAMERA_PRESET_ORDER,
  CAMERA_PRESETS,
  type CameraPreset,
} from '../viewmodel/cameraPresets';
import type { SceneModel } from '../viewmodel/sceneModel';
import type { PickPayload } from '../data/types';
import type { SceneLayer } from '../cesium/layers/SceneLayer';

export interface HudOptions {
  baseLayerLabel: string;
  isPlaceholderMotion: boolean;
  motionLabel: string;
  showWarmUp: boolean;
  warmUpDays: number;
  onToggleLayer(id: string, visible: boolean): void;
  onWarmUpChange(show: boolean): void;
  onPreset(preset: CameraPreset): void;
  /**
   * Explicit "fly to this object" action. Double-click does the same thing with
   * a mouse; on touch there is no reliable double-click, so the button is the
   * gesture-free path.
   */
  onLocate?(payload: PickPayload): void;
}

export interface Hud {
  setSelected(payload: PickPayload | null): void;
}

export function createHud(
  root: HTMLElement,
  model: SceneModel,
  layers: SceneLayer[],
  options: HudOptions,
): Hud {
  root.innerHTML = '';

  // ---- status strip -------------------------------------------------------
  const status = el('header', 'hud hud--top');
  status.append(el('h1', 'hud__title', '全球集装箱航运网络 · 3D 沙盘'));
  status.append(
    el(
      'p',
      'hud__subtitle',
      `底图：${options.baseLayerLabel} · 运动：${options.motionLabel}`,
    ),
  );
  if (options.isPlaceholderMotion) {
    const warn = el('p', 'hud__warn');
    warn.textContent =
      '船舶运动为占位数据：等速沿航线巡航，不含排队、靠泊与扰动响应，不能读作仿真结果。';
    status.append(warn);
  }
  root.append(status);

  // ---- legend + toggles ---------------------------------------------------
  const left = el('aside', 'hud hud--left');

  const portLegend = el('div', 'legend');
  portLegend.append(el('h3', 'legend__title', '港口 · 等待 TEU'));
  const portStops = portWaitingStops(
    model.ports.map((port) => waitingTeuByPort(model, port.id)),
  );
  for (const [value, color] of portStops) {
    portLegend.append(
      row(swatch(toCss(color)), Math.round(value).toLocaleString('zh-CN')),
    );
  }

  const vesselLegend = el('div', 'legend');
  vesselLegend.append(el('h3', 'legend__title', '船舶 · 状态'));
  const stateLabels: Record<string, string> = {
    sailing: '航行中',
    queuing: '锚地等待',
    served: '在泊作业',
    idle: '闲置',
  };
  for (const [state, color] of Object.entries(VESSEL_STATE_RGBA)) {
    vesselLegend.append(row(swatch(toCss(color)), stateLabels[state] ?? state));
  }

  left.append(panel('图例', portLegend, vesselLegend));

  const toggles = el('div', 'toggles');
  for (const layer of layers) {
    const label = el('label', 'toggle');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = layer.isVisible();
    input.addEventListener('change', () => {
      options.onToggleLayer(layer.id, input.checked);
    });
    label.append(input, el('span', undefined, layer.label));
    toggles.append(label);
  }
  left.append(panel('图层', toggles));

  const presets = el('div', 'preset-grid');
  for (const preset of CAMERA_PRESET_ORDER) {
    const button = el(
      'button',
      'preset-button',
      CAMERA_PRESETS[preset].label,
    );
    button.type = 'button';
    button.addEventListener('click', () => options.onPreset(preset));
    presets.append(button);
  }
  left.append(panel('视角', presets));

  const timeRange = el('div', 'toggles');
  const warmUpLabel = el('label', 'toggle');
  const warmUpInput = el('input');
  warmUpInput.type = 'checkbox';
  warmUpInput.className = 'warmup-toggle';
  warmUpInput.checked = options.showWarmUp;
  warmUpInput.addEventListener('change', () => {
    options.onWarmUpChange(warmUpInput.checked);
  });
  warmUpLabel.append(
    warmUpInput,
    el(
      'span',
      undefined,
      `含预热期（${options.warmUpDays} 天）`,
    ),
  );
  timeRange.append(warmUpLabel);
  left.append(panel('时间范围', timeRange));

  root.append(left);

  // ---- selection details --------------------------------------------------
  const right = el('aside', 'hud hud--right');
  const details = el('div', 'details');
  details.append(el('p', 'details__empty', '点击地球上的港口、航线、船舶或扰动事件查看详情。'));
  right.append(panel('详情', details));
  root.append(right);

  function setSelected(payload: PickPayload | null): void {
    details.innerHTML = '';
    if (!payload) {
      details.append(
        el('p', 'details__empty', '点击地球上的港口、航线、船舶或扰动事件查看详情。'),
      );
      return;
    }

    details.append(el('h3', 'details__title', payload.label));

    if (options.onLocate) {
      const locate = el('button', 'details__locate', '定位到此处');
      locate.type = 'button';
      locate.addEventListener('click', () => options.onLocate?.(payload));
      details.append(locate);
    }

    if (payload.kind === 'port') {
      const port = model.ports.find((item) => item.id === payload.id);
      if (!port) return;
      const waiting = waitingTeuByPort(model, port.id);
      details.append(
        keyValue([
          ['泊位数', `${port.berthCount}`],
          ['经纬度', `${port.lon.toFixed(2)}, ${port.lat.toFixed(2)}`],
          ['等待 TEU', waiting.toLocaleString('zh-CN')],
          ['坐标来源', port.coordsVerified ? '公开资料核对' : '未核对'],
          ...(port.tunnelledToSea ? ([['入海处理', '已开凿通道']] as Array<[string, string]>) : []),
        ]),
      );
      if (port.note) details.append(el('p', 'details__note', port.note));
      return;
    }

    if (payload.kind === 'route') {
      const route = model.routes.find((item) => item.id === payload.id);
      if (route) {
        const utilization = model.stats?.routeUtilization.find(
          (item) => item.routeId === route.id,
        );
        details.append(
          keyValue([
            ['航线', route.name],
            ['挂靠航段', `${route.waypoints.length} 个路径点`],
            ['航线里程', `${Math.round(route.totalDistanceNm).toLocaleString('zh-CN')} nm`],
            ['配船数', `${route.vessels ?? 0}`],
            [
              '平均舱位',
              route.capacityTeu || utilization
                ? `${Math.round(
                    route.capacityTeu ?? utilization?.capacityTeu ?? 0,
                  ).toLocaleString('zh-CN')} TEU`
                : '—',
            ],
            [
              '舱位利用率',
              utilization ? `${(utilization.utilization * 100).toFixed(2)}%` : '—',
            ],
          ]),
        );
        return;
      }
      return;
    }

    if (payload.kind === 'disruption') {
      const disruption = model.disruptions.find(
        (item) => item.id === payload.id,
      );
      if (!disruption) return;

      const target = Array.isArray(disruption.target)
        ? disruption.target
            .map((id) => model.ports.find((port) => port.id === id)?.name ?? id)
            .join(' → ')
        : (model.ports.find((port) => port.id === String(disruption.target))
            ?.name ?? String(disruption.target));

      details.append(
        keyValue([
          ['类型', disruption.type === 'closed_port' ? '港口关闭' : '航段拥堵'],
          ['目标', target],
          [
            '时间窗',
            `Day ${Math.round(disruption.startDay)} – ${Math.round(
              disruption.endDay,
            )}`,
          ],
          [
            '强度',
            disruption.type === 'closed_port'
              ? '关闭'
              : `×${disruption.magnitude}`,
          ],
        ]),
      );
      return;
    }

    const vessel = model.motion?.vessels.find((item) => item.vesselId === payload.id);
    if (!vessel) return;
    details.append(
      keyValue([
        ['所属航线', vessel.routeId ?? '—'],
        ['采样点', `${vessel.lon.length}`],
      ]),
    );
  }

  return { setSelected };
}
