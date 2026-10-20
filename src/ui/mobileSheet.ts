/**
 * Bottom sheet for narrow viewports.
 *
 * The desktop UI floats three fixed-width panels around the globe (214 + 250 +
 * 380 px). At 390 px they overlap by more than the screen width, so on phones
 * the panels move into one scrollable sheet and the globe keeps the screen.
 *
 * The sheet has a fixed dock between the handle and the scrolling body. The
 * time bar lives there: if it stayed at the bottom of the screen it would be
 * covered as soon as the sheet opened, leaving no way to scrub.
 *
 * Only the container lives here: the existing panels are re-parented into
 * `body`/`dock` by the bootstrap, which keeps `hud/`, `charts/` and this module
 * independent of each other.
 */

export const MOBILE_QUERY = '(max-width: 640px)';

export interface MobileSheet {
  readonly element: HTMLElement;
  /** Scrollable content: details, legend, layers, charts. */
  readonly body: HTMLElement;
  /** Fixed strip under the handle, stays visible while the body scrolls. */
  readonly dock: HTMLElement;
  readonly handle: HTMLElement;
  setOpen(open: boolean): void;
  toggle(): void;
  isOpen(): boolean;
  /** Height of handle + dock, i.e. how much stays visible when collapsed. */
  setDockHeight(px: number): void;
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
  handle.setAttribute('aria-label', '展开或收起详情、图层与图表');

  const grip = document.createElement('span');
  grip.className = 'mobile-sheet__grip';
  const label = document.createElement('span');
  label.className = 'mobile-sheet__label';
  label.textContent = '详情 · 图层 · 图表';
  handle.append(grip, label);

  const dock = document.createElement('div');
  dock.className = 'mobile-sheet__dock';

  const body = document.createElement('div');
  body.className = 'mobile-sheet__body';

  sheet.append(handle, dock, body);
  parent.append(sheet);

  let open = false;
  // Collapsed height = handle + dock (+ safe area). Set from measurement.
  let dockHeight = 115;

  function setOpen(next: boolean): void {
    open = next;
    sheet.classList.toggle('is-open', open);
    handle.setAttribute('aria-expanded', String(open));
    // Exposed for the smoke test: layout state is otherwise invisible.
    sheet.dataset.open = String(open);
  }

  // ---- drag the handle ----------------------------------------------------
  // A bottom sheet that only reacts to taps feels broken on touch. Pointer
  // events cover mouse and touch with one code path; the click handler is not
  // used, because a drag would otherwise toggle on release.
  //
  // The sheet animates its *height*, not a translate: the collapsed height is
  // exactly the dock, so the bar can never end up a few pixels below the
  // viewport because of a stale measurement.
  let dragging = false;
  let moved = false;
  let dragStartY = 0;
  let dragStartHeight = 0;
  let dragHeight = 0;

  const expandedHeight = () => Math.min(window.innerHeight * 0.72, 620);
  const collapsedHeight = () => dockHeight;

  handle.addEventListener('pointerdown', (event) => {
    dragging = true;
    moved = false;
    dragStartY = event.clientY;
    dragStartHeight = sheet.offsetHeight;
    dragHeight = dragStartHeight;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events (and some older browsers) have no active pointer to
      // capture; the drag still works because we listen on the handle itself.
    }
  });

  handle.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const delta = event.clientY - dragStartY;
    if (Math.abs(delta) > 4) moved = true;
    if (!moved) return;

    dragHeight = Math.min(
      expandedHeight(),
      Math.max(collapsedHeight(), dragStartHeight - delta),
    );
    sheet.style.height = `${Math.round(dragHeight)}px`;
    sheet.dataset.drag = String(Math.round(dragHeight));
  });

  function endDrag(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    try {
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Nothing to release for synthetic pointers.
    }

    if (!moved) {
      sheet.style.removeProperty('height');
      setOpen(!open);
      return;
    }

    // Commit past 30 % of the travel, which is the usual bottom-sheet
    // threshold; half the panel would feel sticky at this height.
    const collapsed = collapsedHeight();
    const expanded = expandedHeight();
    setOpen(dragHeight > collapsed + (expanded - collapsed) * 0.3);
    // Drop the inline height on the next frame so the transition starts from
    // where the finger left it instead of jumping.
    requestAnimationFrame(() => sheet.style.removeProperty('height'));
  }

  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // Keyboard: Enter/Space on a button normally fires click, which is unused.
  handle.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    setOpen(!open);
  });

  function setDockHeight(px: number): void {
    if (!Number.isFinite(px) || px <= 0) return;
    // Measure the handle and dock, then add the safe-area padding: the
    // collapsed sheet is border-box, so its height must include that padding.
    const padding = Number.parseFloat(getComputedStyle(sheet).paddingBottom) || 0;
    dockHeight = Math.ceil(px + padding);
    sheet.style.setProperty('--dock-height', `${dockHeight}px`);
    sheet.dataset.dock = String(dockHeight);
  }

  return {
    element: sheet,
    body,
    dock,
    handle,
    setOpen,
    toggle: () => setOpen(!open),
    isOpen: () => open,
    setDockHeight,
  };
}
