/**
 * Locale-aware titles for picked objects.
 *
 * Disruption labels used to be baked into the data provider as Chinese text, so
 * switching the language left them stranded. They are now derived from the
 * disruption record on demand, which is what lets the 3D labels, the details
 * panel and the tooltip all follow the active locale.
 */

import { t, type MessageKey } from '../i18n';
import type { DisruptionVM, PickPayload } from '../data/types';
import type { SceneModel } from './sceneModel';

const KIND_KEYS = {
  port: 'kind.port',
  route: 'kind.route',
  vessel: 'kind.vessel',
  disruption: 'kind.disruption',
} as const satisfies Record<PickPayload['kind'], MessageKey>;

export function kindLabel(kind: PickPayload['kind']): string {
  return t(KIND_KEYS[kind]);
}

function portName(model: SceneModel, id: string): string {
  return model.ports.find((port) => port.id === id)?.name ?? id;
}

/** e.g. "Shanghai closed for 5 days" / "上海 关闭 5 天". */
export function disruptionTitle(
  disruption: DisruptionVM,
  model: SceneModel,
): string {
  if (disruption.type === 'closed_port') {
    const days = Math.max(1, Math.round(disruption.endDay - disruption.startDay));
    return t('disruption.portClosed', {
      port: portName(model, String(disruption.target)),
      days,
    });
  }
  const [fromId, toId] = disruption.target as [string, string];
  return t('disruption.segment', {
    from: portName(model, fromId),
    to: portName(model, toId),
    mult: disruption.magnitude,
  });
}

/** Title for a payload, rebuilt from data so it follows the locale. */
export function payloadTitle(payload: PickPayload, model: SceneModel): string {
  if (payload.kind === 'disruption') {
    const disruption = model.disruptions.find((item) => item.id === payload.id);
    if (disruption) return disruptionTitle(disruption, model);
  }
  return payload.label;
}
