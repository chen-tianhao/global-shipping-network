/**
 * Bottom sheet for narrow viewports.
 *
 * The desktop UI floats three fixed-width panels around the globe (214 + 250 +
 * 380 px). At 390 px they overlap by more than the screen width, so on phones
 * the panels move into one scrollable sheet and the globe keeps the screen.
 *
 * Only the container lives here: the existing panels are re-parented into
 * `body` by the bootstrap, which keeps `hud/`, `charts/` and this module
 * independent of each other.
 */

export const MOBILE_QUERY = '(max-width: 640px)';

export interface MobileSheet {
  readonly element: HTMLElement;
  /** Panels appended here are laid out in normal flow, top to bottom. */
  readonly body: HTMLElement;
  setOpen(open: boolean): void;
  toggle(): void;
  isOpen(): boolean;
}

/** Returns null on wide viewports - callers must handle the desktop case. */
export function createMobileSheet(parent: HTMLElement): MobileSheet | null {
  if (!window.matchMedia(MOBILE_QUERY).matches) return null;

  const sheet = document.createElement('section');
  sheet.className = 'mobile-sheet';

  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'mobile-sheet__handle';
  handle.setAttribute('aria-expanded', 'false');
  handle.setAttribute('aria-label', '展开详情、图层与图表');

  const grip = document.createElement('span');
  grip.className = 'mobile-sheet__grip';
  const label = document.createElement('span');
  label.className = 'mobile-sheet__label';
  label.textContent = '详情 · 图层 · 图表';
  handle.append(grip, label);

  const body = document.createElement('div');
  body.className = 'mobile-sheet__body';

  sheet.append(handle, body);
  parent.append(sheet);

  let open = false;

  function setOpen(next: boolean): void {
    open = next;
    sheet.classList.toggle('is-open', open);
    handle.setAttribute('aria-expanded', String(open));
  }

  handle.addEventListener('click', () => setOpen(!open));

  return {
    element: sheet,
    body,
    setOpen,
    toggle: () => setOpen(!open),
    isOpen: () => open,
  };
}
