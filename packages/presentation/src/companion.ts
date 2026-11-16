// Companion mode (ADR-016, SPEC §15.1), an on-demand chunk the plugin loads at install when the
// host turns it on: companion = the `docpip` mode plus this state. It owns the companion settings
// (dim, audioOnly), the window size of a companion request (the host's size step), resizing an open
// window into the audio strip and back, the
// `toggle-companion` / `companion-set` handlers, quiet (danmaku and captions off in the window),
// what closing the window does (`onClose`), and the marks on the root while in the window
// (`data-otter-companion`, `data-otter-audio-only`; the shell's companion styles key on them).
//
// The viewer sizes the window by dragging its edge: the browser restores the last size when the
// same size is requested again (RESEARCH §1), so every request asks for the host's step and there
// is no size setting (owner 2026-11-16).
//
// RESEARCH §1 (companion stop 0, Chromium 156): requestWindow sizes the content area; resizeTo
// sizes the outer window and needs (and uses up) transient user activation, so a resize only
// happens inside the dispatch a click made; without one the window keeps its size and a
// `presentation-denied` (noUserGesture) says so (ADR-016 conflict 2). Every way of closing the
// window gives the same pagehide, so the player tells its own exits apart itself (`leave()`) and
// any other close is the viewer's (ADR-016 conflict 4).

import type { QoeHook, Store, Unsubscribe } from '@otter-player/core';
import type { Surface } from '@otter-player/surface';
import type { PresentationController } from './controller.js';
import type { CompanionOptions, CompanionSize, CompanionState, PresentationActionMap } from './plugin.js';

/** What the plugin reads from the companion chunk. */
export interface CompanionRuntime {
  /** Turned on and Document PiP exists here. */
  readonly supported: boolean;
  state(): CompanionState;
  /** Content size for the companion window request. */
  windowSize(): { width: number; height: number };
  /** The player is leaving the window itself (back to the page): no onClose, focus the page. */
  leave(): void;
  destroy(): void;
}

export interface CompanionDeps {
  readonly controller: PresentationController;
  readonly container: HTMLElement;
  readonly surface: Surface;
  readonly store: object;
  readonly qoe: QoeHook;
  readonly options: CompanionOptions;
  /** The plugin's docpip request (with this chunk's window size). */
  readonly request: () => void;
  /** The plugin's exit of the current mode (calls leave() first). */
  readonly exit: () => void;
  /** Writes the presentation snapshot (with this chunk's state). */
  readonly sync: () => void;
}

/** The state and actions quiet reads and dispatches (text and danmaku plugins, structural). */
interface QuietStore {
  getState(): { readonly danmaku?: { readonly enabled?: boolean }; readonly textTrack?: string | null };
  dispatch(type: 'set-danmaku' | 'select-text-track' | 'pause', payload: unknown): boolean;
}

const WIDTH: Readonly<Record<CompanionSize, number>> = { s: 240, m: 320, l: 440 };
/** Smallest content height Chromium opens (RESEARCH §1). */
const MIN_HEIGHT = 52;
/**
 * Audio strip content height: the lowest an open window resizes to in Chromium 156 (outer 100,
 * content 66; RESEARCH §1), so entering and switching give the same strip (ADR-016 conflict 1).
 */
const STRIP_HEIGHT = 66;

const isSize = (v: unknown): v is CompanionSize => v === 's' || v === 'm' || v === 'l';
/** Dimming within 0..0.8 (the dim layer's cap); anything else keeps `fallback`. */
const clampDim = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(0.8, Math.max(0, v)) : fallback);

export function createCompanion(deps: CompanionDeps): CompanionRuntime {
  const { controller: c, container, surface, qoe, options } = deps;
  const store = deps.store as Pick<Store<object, PresentationActionMap>, 'handle'>;
  const quietStore = deps.store as QuietStore;
  // The page's window (the root is in the PiP window's document while in companion mode).
  const page = container.ownerDocument.defaultView;
  const supported = c.capabilities.docpip !== false;
  const remember = options.remember !== false;
  const quiet = options.quiet !== false;
  let dim = clampDim(options.dim, 0.4);
  const size: CompanionSize = isSize(options.size) ? options.size : 'm';
  let audioOnly = options.audioOnly === true;
  let inWindow = false;
  let leaving = false;
  /** Danmaku on / off and the caption track before quiet turned them off; undefined: not held. */
  let held: { danmaku: boolean | undefined; text: string | null | undefined } | undefined;

  const active = (): boolean => supported && c.mode === 'docpip';
  const windowSize = (): { width: number; height: number } => {
    const width = WIDTH[size];
    if (audioOnly) return { width, height: STRIP_HEIGHT };
    const r = surface.contentRect;
    const ratio = r.width > 0 && r.height > 0 ? r.height / r.width : 9 / 16;
    return { width, height: Math.max(MIN_HEIGHT, Math.round(width * ratio)) };
  };
  const deny = (from: string, reason: string): void => qoe.emit('presentation-denied', { from, to: 'docpip', reason });
  /** The window's content size before it became the audio strip (the viewer may have dragged it). */
  let beforeStrip: { width: number; height: number } | undefined;
  /** Into the audio strip (keeping the width) or back to the size it had before. */
  const resize = (): void => {
    const win = container.ownerDocument.defaultView;
    if (!active() || win === null) return;
    let width = win.innerWidth;
    let height: number;
    if (audioOnly) {
      beforeStrip = { width: win.innerWidth, height: win.innerHeight };
      height = STRIP_HEIGHT;
    } else if (beforeStrip !== undefined) {
      ({ width, height } = beforeStrip);
      beforeStrip = undefined;
    } else {
      const r = surface.contentRect;
      height = Math.max(MIN_HEIGHT, Math.round(width * (r.width > 0 && r.height > 0 ? r.height / r.width : 9 / 16)));
    }
    try {
      // The browser's frame (title bar) as it is now: outer minus inner.
      win.resizeTo(width + win.outerWidth - win.innerWidth, height + win.outerHeight - win.innerHeight);
    } catch (err) {
      deny('docpip', (err as { name?: string } | null)?.name === 'NotAllowedError' ? 'noUserGesture' : 'notAllowed');
    }
  };
  const mark = (): void => {
    container.toggleAttribute('data-otter-companion', active());
    container.toggleAttribute('data-otter-audio-only', active() && audioOnly);
  };

  // Quiet: off while in the window, back to what they were on leaving it. `held` is in the state
  // (quieted) during both, so a preferences plugin does not write these changes.
  const hush = (): void => {
    const s = quietStore.getState();
    held = { danmaku: s.danmaku?.enabled, text: s.textTrack };
    deps.sync();
    if (held.danmaku === true) quietStore.dispatch('set-danmaku', { enabled: false });
    if (held.text != null) quietStore.dispatch('select-text-track', { id: null });
  };
  const unhush = (): void => {
    const h = held;
    if (h === undefined) return;
    const s = quietStore.getState();
    if (h.danmaku !== undefined && s.danmaku?.enabled !== h.danmaku) quietStore.dispatch('set-danmaku', { enabled: h.danmaku });
    if (h.text !== undefined && (s.textTrack ?? null) !== (h.text ?? null)) quietStore.dispatch('select-text-track', { id: h.text ?? null });
    held = undefined;
    deps.sync();
  };

  const changed = (): void => {
    const now = active();
    mark();
    if (now === inWindow) return;
    inWindow = now;
    if (now) {
      if (quiet) hush();
      return;
    }
    unhush();
    beforeStrip = undefined;
    // Closed by the viewer (the browser's close, or any way but the player's own): onClose.
    if (!leaving && options.onClose !== 'continue') quietStore.dispatch('pause', undefined);
    leaving = false;
  };

  const offs: Unsubscribe[] = [
    c.on('change', changed),
    store.handle('toggle-companion', () => {
      if (c.mode === 'docpip') return deps.exit();
      if (supported) return deps.request();
      deny(c.mode, 'unsupported');
    }),
    store.handle('companion-set', (p) => {
      const before = audioOnly;
      dim = clampDim(p.dim, dim);
      if (typeof p.audioOnly === 'boolean') audioOnly = p.audioOnly;
      mark();
      if (audioOnly !== before) resize();
      deps.sync();
    }),
  ];
  mark();

  return {
    supported,
    state: () => ({ supported, active: active(), dim, audioOnly, remember, quieted: held !== undefined }),
    windowSize,
    leave() {
      if (!inWindow) return;
      leaving = true;
      // Best effort: the page's tab to the front (inside the click that asked for it).
      try {
        page?.focus();
      } catch {
        // Not allowed here: the window closes all the same.
      }
    },
    destroy() {
      for (const off of offs.splice(0)) off();
      held = undefined;
      container.removeAttribute('data-otter-companion');
      container.removeAttribute('data-otter-audio-only');
    },
  };
}
