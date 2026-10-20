/**
 * Head-up display: status line, legend, layer toggles and selection details.
 *
 * Plain DOM on purpose - the panel content is small and changes rarely, so a
 * framework would add a virtual DOM competing with the WebGL loop for no
 * benefit. See the technical plan for the full reasoning.
 *
 * Localisation: static labels are tagged with `data-i18n` and re-labelled in
 * place by `translateDom`; anything derived from state (the status line, the
 * warm-up day count, the details table) is rebuilt by `refresh()`. The panel is
 * never recreated, so the mobile sheet keeps holding the same nodes.
 */

import { el, elI18n, keyValue, panel, row, swatch } from './dom';
import {
  currentLocale,
  numberLocaleTag,
  t,
  toggleLocale,
  translateDom,
  type MessageKey,
} from '../i18n';
import {
  portWaitingStops,
  toCss,
  VESSEL_STATE_RGBA,
} from '../viewmodel/colorScales';
import { waitingTeuByPort } from '../viewmodel/sceneModel';
import {
  CAMERA_PRESET_ORDER,
  type CameraPreset,
} from '../viewmodel/cameraPresets';
import { payloadTitle } from '../viewmodel/labels';
import type { SceneModel } from '../viewmodel/sceneModel';
import type { PickPayload } from '../data/types';
import type { SceneLayer } from '../cesium/layers/SceneLayer';

export interface HudOptions {
  /**
   * Base map and motion source described in the active language. A callback,
   * not a string: the status line has to regenerate when the locale changes.
   */
  describeContext(): { base: string; motion: string };
  isPlaceholderMotion: boolean;
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
  /** Re-render everything that is not a static dictionary label. */
  refresh(): void;
  /**
   * Desktop: the toggle sits in the details panel header, well clear of the
   * centred time bar. Phones: it moves back into the status strip, because the
   * details panel lives inside the collapsible sheet there.
   */
  setLanguageButtonPlacement(where: 'panel' | 'header'): void;
}

export function createHud(
  root: HTMLElement,
  model: SceneModel,
  layers: SceneLayer[],
  options: HudOptions,
): Hud {
  root.innerHTML = '';
  let selected: PickPayload | null = null;

  // ---- status strip -------------------------------------------------------
  const status = el('header', 'hud hud--top');
  const statusBody = el('div', 'hud__body');
  statusBody.append(elI18n('h1', 'hud__title', 'app.title'));
  const subtitle = el('p', 'hud__subtitle');
  statusBody.append(subtitle);
  if (options.isPlaceholderMotion) {
    statusBody.append(elI18n('p', 'hud__warn', 'status.placeholder'));
  }

  // One click flips the whole UI. The label shows the *target* language, which
  // is the convention users expect from a compact toggle.
  const langButton = el('button', 'hud__lang');
  langButton.type = 'button';
  langButton.addEventListener('click', () => toggleLocale());
  status.append(statusBody);
  root.append(status);

  // ---- legend + toggles ---------------------------------------------------
  const left = el('aside', 'hud hud--left');

  const portLegend = el('div', 'legend');
  portLegend.append(elI18n('h3', 'legend__title', 'hud.legendPorts'));
  const portStops = portWaitingStops(
    model.ports.map((port) => waitingTeuByPort(model, port.id)),
  );
  for (const [value, color] of portStops) {
    portLegend.append(
      row(swatch(toCss(color)), Math.round(value).toLocaleString(numberLocaleTag())),
    );
  }

  const vesselLegend = el('div', 'legend');
  vesselLegend.append(elI18n('h3', 'legend__title', 'hud.legendVessels'));
  for (const [state, color] of Object.entries(VESSEL_STATE_RGBA)) {
    const item = el('div', 'row');
    item.append(
      swatch(toCss(color)),
      elI18n('span', 'row__text', `state.${state}` as MessageKey),
    );
    vesselLegend.append(item);
  }

  left.append(panel('hud.panelLegend', portLegend, vesselLegend));

  const toggles = el('div', 'toggles');
  const layerLabels: Array<{ node: HTMLElement; layer: SceneLayer }> = [];
  for (const layer of layers) {
    const label = el('label', 'toggle');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = layer.isVisible();
    input.addEventListener('change', () => {
      options.onToggleLayer(layer.id, input.checked);
    });
    const text = el('span', undefined, layer.label);
    label.append(input, text);
    toggles.append(label);
    // `label` is a getter that reads the dictionary, so re-reading it here is
    // enough to switch languages.
    layerLabels.push({ node: text, layer });
  }
  left.append(panel('hud.panelLayers', toggles));

  const presets = el('div', 'preset-grid');
  for (const preset of CAMERA_PRESET_ORDER) {
    const button = el(
      'button',
      'preset-button',
      t(`preset.${preset}` as MessageKey),
    );
    button.type = 'button';
    button.dataset.i18n = `preset.${preset}`;
    button.addEventListener('click', () => options.onPreset(preset));
    presets.append(button);
  }
  left.append(panel('hud.panelCamera', presets));

  const timeRange = el('div', 'toggles');
  const warmUpLabel = el('label', 'toggle');
  const warmUpInput = el('input');
  warmUpInput.type = 'checkbox';
  warmUpInput.className = 'warmup-toggle';
  warmUpInput.checked = options.showWarmUp;
  warmUpInput.addEventListener('change', () => {
    options.onWarmUpChange(warmUpInput.checked);
  });
  const warmUpText = el('span');
  warmUpLabel.append(warmUpInput, warmUpText);
  timeRange.append(warmUpLabel);
  left.append(panel('hud.panelTimeRange', timeRange));

  root.append(left);

  // ---- selection details --------------------------------------------------
  const right = el('aside', 'hud hud--right');
  const details = el('div', 'details');
  // Built by hand rather than through `panel()`: this one header carries the
  // language toggle, so it needs a two-slot row instead of a bare title.
  const detailsPanel = el('section', 'panel');
  const detailsHead = el('div', 'panel__head');
  const langSlot = el('span', 'panel__actions');
  detailsHead.append(elI18n('h2', 'panel__title', 'hud.panelDetails'), langSlot);
  detailsPanel.append(detailsHead, details);
  right.append(detailsPanel);
  root.append(right);

  function setSelected(payload: PickPayload | null): void {
    selected = payload;
    renderDetails();
  }

  function renderDetails(): void {
    details.innerHTML = '';
    const payload = selected;
    if (!payload) {
      details.append(elI18n('p', 'details__empty', 'hud.detailsEmpty'));
      return;
    }

    details.append(el('h3', 'details__title', payloadTitle(payload, model)));

    if (options.onLocate) {
      const locate = elI18n('button', 'details__locate', 'hud.locate');
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
          [t('field.berths'), `${port.berthCount}`],
          [t('field.coords'), `${port.lon.toFixed(2)}, ${port.lat.toFixed(2)}`],
          [t('field.waitingTeu'), waiting.toLocaleString(numberLocaleTag())],
          [
            t('field.coordSource'),
            port.coordsVerified
              ? t('value.sourceVerified')
              : t('value.sourceUnverified'),
          ],
          ...(port.tunnelledToSea
            ? ([[t('field.seaAccess'), t('value.channelDredged')]] as Array<
                [string, string]
              >)
            : []),
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
            [t('field.route'), route.name],
            [
              t('field.waypoints'),
              t('value.waypointCount', { count: route.waypoints.length }),
            ],
            [
              t('field.distance'),
              `${Math.round(route.totalDistanceNm).toLocaleString(numberLocaleTag())} nm`,
            ],
            [t('field.vesselCount'), `${route.vessels ?? 0}`],
            [
              t('field.capacity'),
              route.capacityTeu || utilization
                ? `${Math.round(
                    route.capacityTeu ?? utilization?.capacityTeu ?? 0,
                  ).toLocaleString(numberLocaleTag())} TEU`
                : '—',
            ],
            [
              t('field.utilization'),
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
          [
            t('field.type'),
            disruption.type === 'closed_port'
              ? t('value.closedPort')
              : t('value.segmentCongestion'),
          ],
          [t('field.target'), target],
          [
            t('field.window'),
            `Day ${Math.round(disruption.startDay)} – ${Math.round(
              disruption.endDay,
            )}`,
          ],
          [
            t('field.magnitude'),
            disruption.type === 'closed_port'
              ? t('value.closed')
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
        [t('field.serviceRoute'), vessel.routeId ?? '—'],
        [t('field.samples'), `${vessel.lon.length}`],
      ]),
    );
  }

  function refresh(): void {
    translateDom(root);
    const context = options.describeContext();
    subtitle.textContent = t('status.subtitle', {
      base: context.base,
      motion: context.motion,
    });
    warmUpText.textContent = t('hud.warmUp', { days: options.warmUpDays });
    langButton.textContent = currentLocale() === 'zh' ? 'EN' : '中文';
    langButton.title = t('locale.switchTo');
    langButton.setAttribute('lang', currentLocale() === 'zh' ? 'en' : 'zh-CN');
    for (const { node, layer } of layerLabels) node.textContent = layer.label;
    renderDetails();
  }

  function setLanguageButtonPlacement(where: 'panel' | 'header'): void {
    if (where === 'header') status.append(langButton);
    else langSlot.append(langButton);
  }

  setLanguageButtonPlacement('panel');
  refresh();
  return { setSelected, refresh, setLanguageButtonPlacement };
}
