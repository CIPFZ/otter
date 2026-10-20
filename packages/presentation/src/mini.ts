// Page mini window behaviour (SPEC §15, M4 prerequisite), loaded when the player enters `mini`:
// the window can be dragged anywhere in the viewport and comes back where it was left (stored as
// the distance to the bottom-right corner, so it stays put when the viewport resizes). A drag
// starts after a few pixels of movement; plain clicks and taps stay with the InputController,
// which gets a pointercancel when a drag takes over (no long press or swipe seek underneath).

const SLOP_PX = 5;
const MARGIN_PX = 8;

export interface MiniOptions {
  /** localStorage key for the position; null keeps it for the session only. */
  readonly storageKey: string | null;
}

interface Offset {
  readonly right: number;
  readonly bottom: number;
}

const INTERACTIVE = 'button, input, select, textarea, a[href], [role="slider"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

let sessionOffset: Offset | undefined;

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    // Sandboxed iframes and some privacy modes throw on access.
    return undefined;
  }
}

function load(key: string | null): Offset | undefined {
  if (key === null) return sessionOffset;
  try {
    const v: unknown = JSON.parse(storage()?.getItem(key) ?? 'null');
    if (typeof v === 'object' && v !== null && typeof (v as Offset).right === 'number' && typeof (v as Offset).bottom === 'number') return v as Offset;
  } catch {
    // Corrupt value: default corner.
  }
  return undefined;
}

function save(key: string | null, offset: Offset): void {
  sessionOffset = offset;
  if (key === null) return;
  try {
    storage()?.setItem(key, JSON.stringify(offset));
  } catch {
    // Quota or privacy mode: kept for this session.
  }
}

/** Starts mini window behaviour on `container`; the returned function undoes it. */
export function attachMini(container: HTMLElement, options: MiniOptions): () => void {
  const view = container.ownerDocument.defaultView as Window;
  const style = container.style;

  /** Keeps the whole window inside the viewport. */
  const place = (offset: Offset): Offset => {
    const r = container.getBoundingClientRect();
    const right = Math.min(Math.max(MARGIN_PX, offset.right), Math.max(MARGIN_PX, view.innerWidth - r.width - MARGIN_PX));
    const bottom = Math.min(Math.max(MARGIN_PX, offset.bottom), Math.max(MARGIN_PX, view.innerHeight - r.height - MARGIN_PX));
    style.right = `${right}px`;
    style.bottom = `${bottom}px`;
    return { right, bottom };
  };

  const remembered = load(options.storageKey);
  if (remembered !== undefined) place(remembered);

  let drag: { id: number; x0: number; y0: number; right0: number; bottom0: number; moving: boolean } | undefined;
  let swallowClick = false;
  /** True while our own pointercancel (for the InputController) is being dispatched. */
  let cancelling = false;

  const onDown = (e: PointerEvent): void => {
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if ((e.target as Element | null)?.closest?.(INTERACTIVE) != null) return;
    const r = container.getBoundingClientRect();
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, right0: view.innerWidth - r.right, bottom0: view.innerHeight - r.bottom, moving: false };
  };
  const onMove = (e: PointerEvent): void => {
    if (drag === undefined || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.moving) {
      if (Math.hypot(dx, dy) < SLOP_PX) return;
      drag.moving = true;
      container.setAttribute('data-otter-dragging', '');
      try {
        container.setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events have no active pointer to capture.
      }
      // The press is ours now: the InputController drops its long press / swipe.
      cancelling = true;
      container.dispatchEvent(new PointerEvent('pointercancel', { pointerId: e.pointerId, pointerType: e.pointerType, isPrimary: true, bubbles: true }));
      cancelling = false;
    }
    e.stopImmediatePropagation();
    e.preventDefault();
    place({ right: drag.right0 - dx, bottom: drag.bottom0 - dy });
  };
  const onUp = (e: PointerEvent): void => {
    if (cancelling || drag === undefined || e.pointerId !== drag.id) return;
    const moved = drag.moving;
    drag = undefined;
    if (!moved) return;
    e.stopImmediatePropagation();
    swallowClick = true;
    container.removeAttribute('data-otter-dragging');
    const r = container.getBoundingClientRect();
    save(options.storageKey, { right: view.innerWidth - r.right, bottom: view.innerHeight - r.bottom });
  };
  const onClick = (e: MouseEvent): void => {
    if (!swallowClick) return;
    // The click that ends a drag is not a play / pause.
    swallowClick = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  const onResize = (): void => {
    const r = container.getBoundingClientRect();
    place({ right: view.innerWidth - r.right, bottom: view.innerHeight - r.bottom });
  };

  container.addEventListener('pointerdown', onDown, true);
  container.addEventListener('pointermove', onMove, true);
  container.addEventListener('pointerup', onUp, true);
  container.addEventListener('pointercancel', onUp, true);
  container.addEventListener('click', onClick, true);
  view.addEventListener('resize', onResize);
  return () => {
    container.removeEventListener('pointerdown', onDown, true);
    container.removeEventListener('pointermove', onMove, true);
    container.removeEventListener('pointerup', onUp, true);
    container.removeEventListener('pointercancel', onUp, true);
    container.removeEventListener('click', onClick, true);
    view.removeEventListener('resize', onResize);
    container.removeAttribute('data-otter-dragging');
    style.right = '';
    style.bottom = '';
  };
}
