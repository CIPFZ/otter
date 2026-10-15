// InputController (SPEC §14.3): every keyboard, pointer and touch input maps to one action.
// Actions are dispatched synchronously from the originating event callback, so fullscreen, PiP,
// orientation lock and unmuted autoplay keep their user activation (SPEC §3 rule 3).

import { notImplemented, type StoreView } from '@otter-player/core';

export type InputAction =
  | { readonly type: 'toggle-paused' }
  /** Mobile single tap only toggles control visibility. */
  | { readonly type: 'toggle-controls' }
  | { readonly type: 'seek-by'; readonly seconds: number }
  | { readonly type: 'seek-to-percent'; readonly percent: number }
  /** Horizontal swipe previews; the real seek happens on release. */
  | { readonly type: 'seek-preview'; readonly seconds: number }
  | { readonly type: 'toggle-fullscreen' }
  /** Long press: play at `rate` while held, restore on release. */
  | { readonly type: 'hold-rate'; readonly rate: number }
  /** Brightness only adjusts the player's own dimming layer. */
  | { readonly type: 'brightness-by'; readonly delta: number }
  | { readonly type: 'volume-by'; readonly delta: number }
  | { readonly type: 'toggle-muted' }
  | { readonly type: 'toggle-captions' }
  | { readonly type: 'toggle-pip' }
  | { readonly type: 'toggle-mini' }
  | { readonly type: 'zoom'; readonly scale: number }
  /** Close the open menu, otherwise leave fullscreen. */
  | { readonly type: 'escape' };

export type InputActionType = InputAction['type'];

/** Store action map for input actions: `StoreView<S, InputActionMap>`. */
export type InputActionMap = {
  readonly [T in InputActionType]: Omit<Extract<InputAction, { type: T }>, 'type'>;
};

/** Keys are `KeyboardEvent.key`; single letters are matched case-insensitively. */
export type HotkeyMap = Readonly<Record<string, InputAction>>;

export type GestureKind =
  | 'click'
  | 'double-click'
  | 'tap'
  | 'double-tap-left'
  | 'double-tap-center'
  | 'double-tap-right'
  | 'long-press'
  | 'swipe-vertical-left'
  | 'swipe-vertical-right'
  | 'swipe-horizontal'
  | 'pinch';

/**
 * For continuous gestures (swipes, pinch) the numeric payload is a per-unit factor that the
 * controller scales by the gesture magnitude.
 */
export type GestureMap = Readonly<Partial<Record<GestureKind, InputAction>>>;

/** SPEC §14.3 default keyboard mapping. Every entry can be remapped. */
export const DEFAULT_HOTKEYS: HotkeyMap = {
  ' ': { type: 'toggle-paused' },
  k: { type: 'toggle-paused' },
  j: { type: 'seek-by', seconds: -10 },
  l: { type: 'seek-by', seconds: 10 },
  ArrowLeft: { type: 'seek-by', seconds: -10 },
  ArrowRight: { type: 'seek-by', seconds: 10 },
  ArrowUp: { type: 'volume-by', delta: 0.05 },
  ArrowDown: { type: 'volume-by', delta: -0.05 },
  f: { type: 'toggle-fullscreen' },
  m: { type: 'toggle-muted' },
  c: { type: 'toggle-captions' },
  p: { type: 'toggle-pip' },
  i: { type: 'toggle-mini' },
  Escape: { type: 'escape' },
  '0': { type: 'seek-to-percent', percent: 0 },
  '1': { type: 'seek-to-percent', percent: 10 },
  '2': { type: 'seek-to-percent', percent: 20 },
  '3': { type: 'seek-to-percent', percent: 30 },
  '4': { type: 'seek-to-percent', percent: 40 },
  '5': { type: 'seek-to-percent', percent: 50 },
  '6': { type: 'seek-to-percent', percent: 60 },
  '7': { type: 'seek-to-percent', percent: 70 },
  '8': { type: 'seek-to-percent', percent: 80 },
  '9': { type: 'seek-to-percent', percent: 90 },
};

/** SPEC §14.3 default pointer / touch mapping. */
export const DEFAULT_GESTURES: GestureMap = {
  click: { type: 'toggle-paused' },
  'double-click': { type: 'toggle-fullscreen' },
  tap: { type: 'toggle-controls' },
  'double-tap-left': { type: 'seek-by', seconds: -10 },
  'double-tap-center': { type: 'toggle-fullscreen' },
  'double-tap-right': { type: 'seek-by', seconds: 10 },
  'long-press': { type: 'hold-rate', rate: 2 },
  'swipe-vertical-left': { type: 'brightness-by', delta: 1 },
  'swipe-vertical-right': { type: 'volume-by', delta: 1 },
  'swipe-horizontal': { type: 'seek-preview', seconds: 1 },
  pinch: { type: 'zoom', scale: 1 },
};

export interface InputController {
  readonly hotkeys: HotkeyMap;
  readonly gestures: GestureMap;
  /** Starts listening on the player root. Focus stays trapped inside the player (Tab cycles). */
  attach(target: HTMLElement): void;
  detach(): void;
  setHotkeys(map: HotkeyMap): void;
  setGestures(map: GestureMap): void;
  destroy(): void;
}

export interface InputControllerOptions<S extends object = object> {
  readonly store: StoreView<S, InputActionMap>;
  readonly hotkeys?: HotkeyMap;
  readonly gestures?: GestureMap;
}

/** M0 empty implementation: mappings are stored, nothing is listened to yet. */
export function createInputController<S extends object>(options: InputControllerOptions<S>): InputController {
  let hotkeys = options.hotkeys ?? DEFAULT_HOTKEYS;
  let gestures = options.gestures ?? DEFAULT_GESTURES;
  return {
    get hotkeys() {
      return hotkeys;
    },
    get gestures() {
      return gestures;
    },
    attach() {
      throw notImplemented('@otter-player/input attach');
    },
    detach: () => undefined,
    setHotkeys(map) {
      hotkeys = map;
    },
    setGestures(map) {
      gestures = map;
    },
    destroy: () => undefined,
  };
}
