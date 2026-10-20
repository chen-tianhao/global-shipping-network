/** Tiny DOM builders. No framework - the whole UI surface is a few panels. */

import { t, type MessageKey } from '../i18n';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Element whose text is a dictionary entry.
 *
 * Marking it with `data-i18n` lets `translateDom` re-label it in place when the
 * language changes: no rebuild, so panels keep their parent (the mobile sheet
 * moves them around) and their listeners.
 */
export function elI18n<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string | undefined,
  key: MessageKey,
  vars?: Record<string, string | number>,
): HTMLElementTagNameMap[K] {
  const node = el(tag, className, t(key, vars));
  node.dataset.i18n = key;
  return node;
}

export function panel(key: MessageKey, ...children: HTMLElement[]): HTMLElement {
  const root = el('section', 'panel');
  root.append(elI18n('h2', 'panel__title', key));
  for (const child of children) root.append(child);
  return root;
}

export function swatch(color: string): HTMLElement {
  const node = el('span', 'swatch');
  node.style.background = color;
  return node;
}

export function row(...children: Array<HTMLElement | string>): HTMLElement {
  const node = el('div', 'row');
  for (const child of children) {
    node.append(typeof child === 'string' ? el('span', 'row__text', child) : child);
  }
  return node;
}

export function keyValue(pairs: Array<[string, string]>): HTMLElement {
  const table = el('dl', 'kv');
  for (const [key, value] of pairs) {
    table.append(el('dt', undefined, key), el('dd', undefined, value));
  }
  return table;
}
