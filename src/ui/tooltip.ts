/** Lightweight hover tooltip. Positioned in client coordinates, never captures clicks. */

import { el } from './dom';

export interface Tooltip {
  show(text: string, clientX: number, clientY: number): void;
  hide(): void;
}

export function createTooltip(root: HTMLElement): Tooltip {
  const node = el('div', 'tooltip');
  node.style.display = 'none';
  root.append(node);

  return {
    show(text: string, clientX: number, clientY: number): void {
      node.textContent = text;
      node.style.display = 'block';
      node.style.left = `${Math.round(clientX)}px`;
      node.style.top = `${Math.round(clientY)}px`;
    },
    hide(): void {
      node.style.display = 'none';
    },
  };
}
