// Chrome state (SPEC §14.2, ADR-005 §6): control visibility and auto-hide, the player's own
// brightness layer, gesture feedback (seek preview, zoom) and the open menu. UI code (the skin's
// shell, the primitives) reads this slice and dispatches these actions; the plugin owns timers.

import type { Plugin, PluginContext, Store, StoreSlice, Unsubscribe } from '@otter-player/core';
import type { InputActionMap } from '@otter-player/input';
import type { MediaActionMap, MediaState } from '@otter-player/media';
import type { PresentationActionMap } from '@otter-player/presentation';

export interface ChromeState {
  readonly controlsVisible: boolean;
  /** Player dimming layer, 0..1 (gesture-controlled brightness; never the screen's). */
  readonly brightness: number;
  /** Pending seek offset from a horizontal swipe, seconds; the UI shows the target preview. */
  readonly seekPreview: number | null;
  /** Electronic zoom, 1 = none. */
  readonly zoom: number;
  readonly menu: string | null;
}

export const INITIAL_CHROME_STATE: ChromeState = { controlsVisible: true, brightness: 1, seekPreview: null, zoom: 1, menu: null };
export const CHROME_SLICE: StoreSlice<ChromeState> = { id: 'chrome', initialState: INITIAL_CHROME_STATE };

/** Actions handled by the chrome plugin; `toggle-fullscreen` etc. belong to presentation. */
export interface ChromeActionMap {
  'toggle-controls': Record<string, never>;
  'show-controls': Record<string, never>;
  'brightness-by': { readonly delta: number };
  'seek-preview': { readonly seconds: number; readonly commit?: boolean };
  zoom: { readonly scale: number };
  'open-menu': { readonly id: string | null };
  escape: Record<string, never>;
}

export interface ChromeOptions {
  /** Hidden this long after the last interaction while playing and idle, ms; 0 keeps them shown. */
  readonly idleMs?: number;
}

export function createChromePlugin<S extends ChromeState & Pick<MediaState, 'paused' | 'status'>>(options: ChromeOptions = {}): Plugin<S, ChromeActionMap & MediaActionMap> {
  const idleMs = options.idleMs ?? 3000;
  let store: Store<S, ChromeActionMap & MediaActionMap> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let offs: Unsubscribe[] = [];

  const patch = (p: Partial<ChromeState>): void => store?.setState(p as Partial<S>);
  const set = (controlsVisible: boolean): void => patch({ controlsVisible });

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const s = store?.getState();
    if (s === undefined || idleMs <= 0) return;
    // Visible only while there is a reason to look at them.
    if (!s.controlsVisible || s.paused || s.status !== 'ready' || s.menu !== null) return;
    timer = setTimeout(() => {
      const now = store?.getState();
      if (now !== undefined && now.controlsVisible && !now.paused && now.menu === null) set(false);
    }, idleMs);
  };

  return {
    id: 'chrome',
    install(ctx: PluginContext<S, ChromeActionMap & MediaActionMap>) {
      store = ctx.store;
      // exit-fullscreen belongs to presentation; dispatching it without that plugin is a no-op.
      const s = ctx.store as unknown as Store<ChromeState, ChromeActionMap & MediaActionMap & Pick<PresentationActionMap, 'exit-fullscreen'>>;
      offs = [
        s.handle('toggle-controls', () => {
          const visible = !(store?.getState().controlsVisible ?? true);
          set(visible);
          schedule();
        }),
        s.handle('show-controls', () => {
          if (store?.getState().controlsVisible === false) set(true);
          schedule();
        }),
        s.handle('brightness-by', ({ delta }) => {
          const b = store?.getState().brightness ?? 1;
          patch({ brightness: Math.min(1, Math.max(0.2, b + delta)) });
        }),
        s.handle('seek-preview', ({ seconds, commit }) => {
          if (commit === true) {
            patch({ seekPreview: null });
            if (seconds !== 0) s.dispatch('seek-by', { seconds });
            return;
          }
          patch({ seekPreview: seconds });
        }),
        s.handle('zoom', ({ scale }) => patch({ zoom: Math.min(4, Math.max(1, scale)) })),
        s.handle('open-menu', ({ id }) => {
          patch({ menu: id, controlsVisible: true });
          schedule();
        }),
        s.handle('escape', () => {
          if (store?.getState().menu !== null) patch({ menu: null });
          // No menu to close: leave fullscreen (the browser only does that for the native one).
          else s.dispatch('exit-fullscreen', {});
          schedule();
        }),
        // Any interaction keeps the controls up; playback state changes re-arm the timer.
        ctx.store.select(
          (st) => st.paused,
          () => schedule(),
          (a, b) => a === b,
        ),
      ];
      schedule();
    },
    uninstall() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const off of offs) off();
      offs = [];
      store = undefined;
    },
  };
}

/**
 * Re-shows the controls on mouse movement and keyboard focus inside the player. Touch is left
 * to the tap gesture (`toggle-controls`), so a tap can also hide them.
 */
export function bindActivity(root: HTMLElement, store: { dispatch(type: 'show-controls', payload: Record<string, never>): boolean }): Unsubscribe {
  const pointer = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') store.dispatch('show-controls', {});
  };
  const focus = (): void => void store.dispatch('show-controls', {});
  root.addEventListener('pointermove', pointer);
  root.addEventListener('focusin', focus);
  return () => {
    root.removeEventListener('pointermove', pointer);
    root.removeEventListener('focusin', focus);
  };
}

// InputActionMap has the same names; exported so hosts can compose UiActions without importing both.
export type ChromeUiActions = Pick<InputActionMap, 'toggle-controls' | 'brightness-by' | 'seek-preview' | 'zoom' | 'escape'>;
