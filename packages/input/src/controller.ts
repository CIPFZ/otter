// InputController implementation (SPEC §14.3, ADR-005 §5). Listens on the player root; every
// recognised input dispatches its action synchronously inside the originating event callback.
//
// Keyboard: keys belong to the focused control first (Space/Enter on buttons, arrows on sliders
// and menus, everything in text fields); the rest go through the hotkey map. Tab only cycles
// inside the player while it is modal (fullscreen or a menu open): trapping focus in an inline
// player would be a keyboard trap (WCAG 2.1.2).
//
// Pointer: mouse click / double-click; touch tap (deferred, so a double tap is not two taps),
// double tap by zone (left third / centre / right third), long press, vertical swipes per half,
// horizontal swipe (seek preview, committed on release) and two-finger pinch. Events that start
// on interactive chrome (buttons, sliders, menus) are not gestures.

import type { StoreView } from '@otter-player/core';
import type { GestureKind, GestureMap, HotkeyMap, InputAction, InputActionMap } from './index.js';

export interface InputTimings {
  /** Two taps / clicks within this many ms form a double. */
  readonly doubleMs: number;
  /** Held this long without moving: long press. */
  readonly longPressMs: number;
  /** Movement (px) that turns a press into a swipe. */
  readonly slopPx: number;
}

export const DEFAULT_TIMINGS: InputTimings = { doubleMs: 300, longPressMs: 500, slopPx: 10 };

const INTERACTIVE = 'button, input, select, textarea, a[href], [contenteditable=""], [contenteditable="true"], [role="button"], [role="slider"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="listbox"], [role="option"], [role="radiogroup"], [role="tab"], [data-otter-controls]';
const TEXT_ENTRY = 'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]), textarea, select, [contenteditable=""], [contenteditable="true"]';
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const ARROW_OWNERS = 'input[type="range"], [role="slider"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="listbox"], [role="radiogroup"], [role="tablist"]';
const ACTIVATION_OWNERS = 'button, a[href], [role="button"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], input[type="checkbox"], input[type="radio"]';
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Whether any element on the event path (up to the root) matches `selector`. */
const onPath = (e: Event, root: Element, selector: string): boolean => {
  for (const n of e.composedPath()) {
    if (n === root) return false;
    if (n instanceof Element && n.matches(selector)) return true;
  }
  return false;
};

/**
 * Controls that are also a picture (multi-view tiles): taps and clicks belong to them, but wheel,
 * pinch and drag still zoom and pan the picture.
 */
const PICTURE_CONTROL = '[data-otter-picture-gestures]';

/** Payload fields a continuous gesture scales by its magnitude (pinch factor, drag fractions). */
const MAGNITUDE = new Set(['seconds', 'delta', 'scale', 'factor', 'dx', 'dy']);

/** `KeyboardEvent.key` -> hotkey lookup key: single letters lower-case. */
const keyOf = (e: KeyboardEvent): string => (e.key.length === 1 ? e.key.toLowerCase() : e.key);

/** Focusable elements inside `root`, descending into open shadow roots, in tree order. */
function focusables(root: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const visit = (node: Element | ShadowRoot): void => {
    for (const child of Array.from(node.children)) {
      if (child instanceof HTMLElement && child.matches(FOCUSABLE) && !child.hidden && child.getAttribute('aria-hidden') !== 'true') out.push(child);
      if (child.shadowRoot !== null) visit(child.shadowRoot);
      visit(child);
    }
  };
  visit(root);
  return out;
}

/** Deepest active element, through shadow roots. */
const activeElement = (doc: Document): Element | null => {
  let a: Element | null = doc.activeElement;
  while (a?.shadowRoot?.activeElement != null) a = a.shadowRoot.activeElement;
  return a;
};

export interface AttachOptions<S extends object> {
  readonly target: HTMLElement;
  readonly store: StoreView<S, InputActionMap>;
  readonly hotkeys: () => HotkeyMap;
  readonly gestures: () => GestureMap;
  /** Whether the picture is zoomed (drags pan it then); the shell's picture plugin answers. */
  readonly zoomed?: () => boolean;
  /** Focus is trapped (Tab cycles) only while this holds; default: the player is fullscreen. */
  readonly modal: () => boolean;
  readonly timings: InputTimings;
}

interface Press {
  readonly id: number;
  readonly type: string;
  readonly x0: number;
  readonly y0: number;
  lastX: number;
  lastY: number;
  mode: 'press' | 'swipe-x' | 'swipe-y' | 'long' | 'pinch' | 'drag';
  /** Started on a picture surface that is itself a control (a multi-view tile): pinch / drag only. */
  readonly pictureOnly: boolean;
  longTimer: ReturnType<typeof setTimeout> | undefined;
}

export function attachInput<S extends object>(o: AttachOptions<S>): () => void {
  const { target, store, timings } = o;
  const doc = target.ownerDocument;

  const send = (action: InputAction | undefined, scale = 1): boolean => {
    if (action === undefined) return false;
    const { type, ...payload } = action as InputAction & Record<string, unknown>;
    // Only the magnitude field scales; coordinates (zoom-at's x / y) and absolute values do not.
    const scaled: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) scaled[k] = typeof v === 'number' && MAGNITUDE.has(k) ? v * scale : v;
    return store.dispatch(type as keyof InputActionMap, scaled as never);
  };
  const gesture = (kind: GestureKind, scale = 1): boolean => send(o.gestures()[kind], scale);

  // Keyboard ------------------------------------------------------------------------------------
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.isComposing) return;
    if (e.key === 'Tab') {
      if (!o.modal()) return;
      const list = focusables(target);
      if (list.length === 0) return;
      const active = activeElement(doc);
      const index = list.findIndex((el) => el === active || (active !== null && el.shadowRoot?.contains(active) === true));
      const next = e.shiftKey ? (index <= 0 ? list.length - 1 : index - 1) : index === list.length - 1 ? 0 : index + 1;
      if ((e.shiftKey && index <= 0) || (!e.shiftKey && (index === list.length - 1 || index < 0))) {
        e.preventDefault();
        list[next]?.focus();
      }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (onPath(e, target, TEXT_ENTRY)) return;
    if (ARROWS.has(e.key) && onPath(e, target, ARROW_OWNERS)) return;
    if ((e.key === ' ' || e.key === 'Enter') && onPath(e, target, ACTIVATION_OWNERS)) return;
    // Held keys repeat; repeating a toggle would flicker.
    const action = o.hotkeys()[keyOf(e)];
    if (action === undefined) return;
    if (e.repeat && !(action.type === 'seek-by' || action.type === 'volume-by')) {
      e.preventDefault();
      return;
    }
    if (send(action)) e.preventDefault();
  };

  // Pointer -------------------------------------------------------------------------------------
  const presses = new Map<number, Press>();
  let pinchStart = 0;
  let lastTap: { at: number; zone: 'left' | 'center' | 'right' } | undefined;
  let tapTimer: ReturnType<typeof setTimeout> | undefined;
  let suppressClick = false;
  let previewSeconds = 0;

  const zoneOf = (x: number): 'left' | 'center' | 'right' => {
    const r = target.getBoundingClientRect();
    const f = r.width > 0 ? (x - r.left) / r.width : 0.5;
    return f < 1 / 3 ? 'left' : f > 2 / 3 ? 'right' : 'center';
  };
  const distance = (): number => {
    const [a, b] = [...presses.values()];
    return a === undefined || b === undefined ? 0 : Math.hypot(a.lastX - b.lastX, a.lastY - b.lastY);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!e.isPrimary && presses.size !== 1) return;
    const pictureOnly = onPath(e, target, PICTURE_CONTROL);
    if (!pictureOnly && onPath(e, target, INTERACTIVE)) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const press: Press = { id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, lastX: e.clientX, lastY: e.clientY, mode: 'press', longTimer: undefined, pictureOnly };
    presses.set(e.pointerId, press);
    if (presses.size === 2) {
      for (const p of presses.values()) {
        clearTimeout(p.longTimer);
        p.mode = 'pinch';
      }
      pinchStart = distance();
      return;
    }
    if (pictureOnly) return;
    press.longTimer = setTimeout(() => {
      if (press.mode !== 'press') return;
      press.mode = 'long';
      gesture('long-press');
    }, timings.longPressMs);
  };

  /** Whether the picture is zoomed (the host's picture plugin): drags then pan it. */
  const zoomed = (): boolean => o.zoomed?.() === true;

  const onPointerMove = (e: PointerEvent): void => {
    const p = presses.get(e.pointerId);
    if (p === undefined) return;
    const dx = e.clientX - p.lastX;
    const dy = e.clientY - p.lastY;
    p.lastX = e.clientX;
    p.lastY = e.clientY;
    if (p.mode === 'drag') {
      const r = target.getBoundingClientRect();
      // Per axis: the mapped action's dx / dy are per-unit factors of the fraction moved.
      const action = o.gestures().drag;
      if (r.width > 0 && r.height > 0 && action?.type === 'pan-by') send({ type: 'pan-by', dx: (action.dx * dx) / r.width, dy: (action.dy * dy) / r.height });
      else if (r.width > 0) send(action, dx / r.width);
      return;
    }
    if (p.mode === 'pinch') {
      // Relative to the last distance: the zoom action takes a factor, not an absolute scale.
      const d = distance();
      if (pinchStart > 0 && d > 0) gesture('pinch', d / pinchStart);
      pinchStart = d;
      return;
    }
    if (p.mode === 'press' && zoomed() && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > timings.slopPx) {
      // Zoomed: a drag moves the picture instead of a swipe.
      clearTimeout(p.longTimer);
      p.mode = 'drag';
      return;
    }
    if (p.pictureOnly) return;
    if (p.mode === 'press' && p.type !== 'mouse' && Math.hypot(e.clientX - p.x0, e.clientY - p.y0) > timings.slopPx) {
      clearTimeout(p.longTimer);
      p.mode = Math.abs(e.clientX - p.x0) > Math.abs(e.clientY - p.y0) ? 'swipe-x' : 'swipe-y';
      previewSeconds = 0;
    }
    const r = target.getBoundingClientRect();
    if (p.mode === 'swipe-y' && r.height > 0) {
      // Up is more: per-unit delta times the fraction of the player height moved.
      gesture(p.x0 - r.left < r.width / 2 ? 'swipe-vertical-left' : 'swipe-vertical-right', -dy / r.height);
    } else if (p.mode === 'swipe-x' && r.width > 0) {
      // Per-unit seconds per percent of the player width, relative to where the swipe started.
      const action = o.gestures()['swipe-horizontal'];
      if (action?.type === 'seek-preview') {
        previewSeconds = action.seconds * (((e.clientX - p.x0) / r.width) * 100);
        store.dispatch('seek-preview', { seconds: previewSeconds });
      } else {
        send(action, dx / r.width);
      }
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    const p = presses.get(e.pointerId);
    if (p === undefined) return;
    presses.delete(e.pointerId);
    clearTimeout(p.longTimer);
    if (p.mode === 'pinch') {
      if (presses.size === 0) pinchStart = 0;
      return;
    }
    if (p.pictureOnly) return;
    if (p.mode === 'long') {
      // Release restores the rate (hold-rate with rate <= 0).
      const action = o.gestures()['long-press'];
      if (action?.type === 'hold-rate') store.dispatch('hold-rate', { rate: 0 });
      suppressClick = true;
      return;
    }
    if (p.mode === 'swipe-x') {
      const action = o.gestures()['swipe-horizontal'];
      if (action?.type === 'seek-preview') store.dispatch('seek-preview', { seconds: previewSeconds, commit: true });
      return;
    }
    // A mouse drag still ends in a click on the same element: that click is not a gesture.
    if (p.mode === 'drag') {
      if (p.type === 'mouse') suppressClick = true;
      return;
    }
    if (p.mode === 'swipe-y' || p.type === 'mouse' || e.type === 'pointercancel') return;
    // Touch / pen tap: a second tap in time is a zone double tap, otherwise a (deferred) tap.
    const now = e.timeStamp;
    const zone = zoneOf(e.clientX);
    if (lastTap !== undefined && now - lastTap.at < timings.doubleMs) {
      clearTimeout(tapTimer);
      tapTimer = undefined;
      lastTap = undefined;
      gesture(zone === 'left' ? 'double-tap-left' : zone === 'right' ? 'double-tap-right' : 'double-tap-center');
      return;
    }
    lastTap = { at: now, zone };
    tapTimer = setTimeout(() => {
      tapTimer = undefined;
      lastTap = undefined;
      gesture('tap');
    }, timings.doubleMs);
  };

  // Mouse clicks use the browser's click / dblclick (both are user activations).
  const onClick = (e: MouseEvent): void => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if ((e as PointerEvent).pointerType !== undefined && (e as PointerEvent).pointerType !== '' && (e as PointerEvent).pointerType !== 'mouse') return;
    if (onPath(e, target, INTERACTIVE)) return;
    gesture('click');
  };
  const onDoubleClick = (e: MouseEvent): void => {
    if ((e as PointerEvent).pointerType !== undefined && (e as PointerEvent).pointerType !== '' && (e as PointerEvent).pointerType !== 'mouse') return;
    if (onPath(e, target, INTERACTIVE)) return;
    gesture('double-click');
  };
  /**
   * Wheel: Ctrl/Cmd + wheel (a trackpad pinch in Chrome, the Ctrl+wheel of every browser) zooms the
   * picture at the pointer; plain wheel leaves the page's scrolling alone unless the picture is
   * zoomed, where it zooms back out. Both are passive: preventDefault only where handled.
   */
  const onWheel = (e: WheelEvent): void => {
    if (!onPath(e, target, PICTURE_CONTROL) && onPath(e, target, INTERACTIVE)) return;
    const zoom = e.ctrlKey || e.metaKey;
    if (!zoom && !zoomed()) return;
    // Exponential: the same feel at every level (a notch of 100 px doubles, roughly).
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1) * 0.002);
    const r = target.getBoundingClientRect();
    const x = r.width > 0 ? (e.clientX - r.left) / r.width : 0.5;
    const y = r.height > 0 ? (e.clientY - r.top) / r.height : 0.5;
    if (send({ type: 'zoom-at', factor, x, y })) e.preventDefault();
  };

  const onPointerCancel = (e: PointerEvent): void => {
    const p = presses.get(e.pointerId);
    if (p === undefined) return;
    clearTimeout(p.longTimer);
    presses.delete(e.pointerId);
    if (p.mode === 'long') store.dispatch('hold-rate', { rate: 0 });
    if (p.mode === 'swipe-x') store.dispatch('seek-preview', { seconds: 0, commit: false });
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('pointerdown', onPointerDown);
  target.addEventListener('pointermove', onPointerMove);
  target.addEventListener('pointerup', onPointerUp);
  target.addEventListener('pointercancel', onPointerCancel);
  target.addEventListener('click', onClick);
  target.addEventListener('dblclick', onDoubleClick);
  // Not passive: handled wheel events must not scroll the page.
  target.addEventListener('wheel', onWheel, { passive: false });
  // touch-action is the skin's job ([data-otter-player] pan-y inline, none when fullscreen):
  // inline, the page keeps vertical scrolling and the browser cancels vertical swipes.

  return () => {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('pointerdown', onPointerDown);
    target.removeEventListener('pointermove', onPointerMove);
    target.removeEventListener('pointerup', onPointerUp);
    target.removeEventListener('pointercancel', onPointerCancel);
    target.removeEventListener('click', onClick);
    target.removeEventListener('dblclick', onDoubleClick);
    target.removeEventListener('wheel', onWheel);
    clearTimeout(tapTimer);
    for (const p of presses.values()) clearTimeout(p.longTimer);
    presses.clear();
  };
}
