/** Tiny DOM builders. No framework - the whole UI surface is a few panels. */

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

export function panel(title: string, ...children: HTMLElement[]): HTMLElement {
  const root = el('section', 'panel');
  const heading = el('h2', 'panel__title', title);
  root.append(heading);
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
