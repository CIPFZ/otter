// Chrome state (SPEC §14.2, ADR-005 §6): control visibility and auto-hide, the player's own
// brightness layer, gesture feedback (seek preview) and the open menu. Electronic zoom is the
// picture plugin's (@otter-player/presentation/picture). UI code (the skin's
// shell, the primitives) reads this slice and dispatches these actions; the plugin owns timers.

import type { Plugin, PluginContext, Store, StoreSlice, Unsubscribe } from '@otter-player/core';
import type { InputActionMap } from '@otter-player/input';
import type { MediaActionMap, MediaState } from '@otter-player/media';
import type { PresentationActionMap, PresentationState } from '@otter-player/presentation';

/** Player UI state: control bar visibility, the dimming layer, the seek preview and the open menu. */
export interface PlayerUiState {
  /** Whether the controls are shown (auto-hide while playing). */
  readonly controlsVisible: boolean;
  /** Player dimming layer, 0..1 (gesture-controlled brightness; never the screen's). */
  readonly brightness: number;
  /** Pending seek offset from a horizontal swipe, seconds; the UI shows the target preview. */
  readonly seekPreview: number | null;
  /** The open menu's id, null when none is open. */
  readonly menu: string | null;
}

/** The player UI state before any interaction: controls shown, full brightness, nothing open. */
export const INITIAL_PLAYER_UI_STATE: PlayerUiState = { controlsVisible: true, brightness: 1, seekPreview: null, menu: null };
/** The player UI's store slice (createPlayer adds it). */
export const PLAYER_UI_SLICE: StoreSlice<PlayerUiState> = { id: 'player-ui', initialState: INITIAL_PLAYER_UI_STATE };

/** Actions handled by the player UI plugin; `toggle-fullscreen` etc. belong to presentation. */
export interface PlayerUiActionMap {
  /** Show the controls if hidden, hide them if shown (a tap on mobile). */
  'toggle-controls': Record<string, never>;
  /** Show the controls and restart the auto-hide delay. */
  'show-controls': Record<string, never>;
  /**
   * The pointer and the focus left the player (`bindActivity`). In the companion window this hides
   * the controls at once (ADR-016 §4); elsewhere it changes nothing.
   */
  'hide-controls': Record<string, never>;
  /** Change the player's dimming layer by a delta (clamped to 0..1). */
  'brightness-by': { readonly delta: number };
  /** Preview a seek offset during a swipe; `commit` seeks. */
  'seek-preview': { readonly seconds: number; readonly commit?: boolean };
  /** Open a menu by id; null closes it. */
  'open-menu': { readonly id: string | null };
  /** Close the open menu, else leave fullscreen. */
  escape: Record<string, never>;
}

/** Options of the player UI plugin. */
export interface PlayerUiOptions {
  /**
   * The controls hide this long after the last interaction while playing, ms; 0 keeps them shown.
   * @defaultValue `3000`
   */
  readonly idleMs?: number;
}

/**
 * The player UI plugin: control bar visibility and auto-hide, brightness, seek preview, menus
 * (createPlayer installs it). In the companion window (`presentation.companion.active`) the
 * controls show only while the pointer or the focus is in the player, with no timer.
 */
export function createPlayerUiPlugin<S extends PlayerUiState & Pick<MediaState, 'paused' | 'status'>>(options: PlayerUiOptions = {}): Plugin<S, PlayerUiActionMap & MediaActionMap> {
  const idleMs = options.idleMs ?? 3000;
  let store: Store<S, PlayerUiActionMap & MediaActionMap> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let offs: Unsubscribe[] = [];

  const patch = (p: Partial<PlayerUiState>): void => store?.setState(p as Partial<S>);
  const set = (controlsVisible: boolean): void => patch({ controlsVisible });
  const companion = (s: Readonly<S> | undefined): boolean => (s as Partial<PresentationState> | undefined)?.presentation?.companion?.active === true;

  const schedule = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const s = store?.getState();
    if (s === undefined || idleMs <= 0 || companion(s)) return;
    // Visible only while there is a reason to look at them.
    if (!s.controlsVisible || s.paused || s.status !== 'ready' || s.menu !== null) return;
    timer = setTimeout(() => {
      const now = store?.getState();
      if (now !== undefined && now.controlsVisible && !now.paused && now.menu === null) set(false);
    }, idleMs);
  };

  return {
    id: 'player-ui',
    install(ctx: PluginContext<S, PlayerUiActionMap & MediaActionMap>) {
      store = ctx.store;
      // exit-fullscreen belongs to presentation; dispatching it without that plugin is a no-op.
      const s = ctx.store as unknown as Store<PlayerUiState, PlayerUiActionMap & MediaActionMap & Pick<PresentationActionMap, 'exit-fullscreen'>>;
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
        s.handle('hide-controls', () => {
          const now = store?.getState();
          if (companion(now) && now?.menu === null && now.controlsVisible) set(false);
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
        // Into the companion window: hidden until the pointer or the focus comes in; out of it:
        // shown, and the auto-hide delay again.
        ctx.store.select(
          (st) => companion(st),
          (inWindow) => {
            set(!inWindow);
            schedule();
          },
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
 * Re-shows the controls on mouse movement and keyboard focus inside the player, and reports
 * (`hide-controls`) when the mouse and the focus have both left it. Touch is left to the tap
 * gesture (`toggle-controls`), so a tap can also hide them.
 */
export function bindActivity(root: HTMLElement, store: { dispatch(type: 'show-controls' | 'hide-controls', payload: Record<string, never>): boolean }): Unsubscribe {
  const pointer = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') store.dispatch('show-controls', {});
  };
  const focus = (): void => void store.dispatch('show-controls', {});
  const left = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && !root.matches(':focus-within')) store.dispatch('hide-controls', {});
  };
  const blurred = (e: FocusEvent): void => {
    // Not `instanceof Node`: in a Document PiP window the nodes come from that window's realm.
    const to = e.relatedTarget as Node | null;
    if (!(typeof to?.nodeType === 'number' && root.contains(to)) && !root.matches(':hover')) store.dispatch('hide-controls', {});
  };
  root.addEventListener('pointermove', pointer);
  root.addEventListener('focusin', focus);
  root.addEventListener('pointerleave', left);
  root.addEventListener('focusout', blurred);
  return () => {
    root.removeEventListener('pointermove', pointer);
    root.removeEventListener('focusin', focus);
    root.removeEventListener('pointerleave', left);
    root.removeEventListener('focusout', blurred);
  };
}

// InputActionMap has the same names; exported so hosts can compose UiActions without importing both.
/** The input actions the player UI handles. */
export type PlayerUiInputActions = Pick<InputActionMap, 'toggle-controls' | 'brightness-by' | 'seek-preview' | 'escape'>;
