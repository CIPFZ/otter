// Companion mode (ADR-016, SPEC §15.1), an on-demand chunk the plugin loads at install when the
// host turns it on: companion = the `docpip` mode plus this state. It owns the companion settings
// (dim, size, audioOnly), the window size of a companion request, resizing an open window, the
// `toggle-companion` / `companion-set` handlers and the `data-otter-companion` mark on the root
// while in the window (the shell's companion styles key on it).
//
// RESEARCH §1 (companion stop 0, Chromium 156): requestWindow sizes the content area; resizeTo
// sizes the outer window and needs (and uses up) transient user activation, so a resize only
// happens inside the dispatch a click made; without one the window keeps its size and a
// `presentation-denied` (noUserGesture) says so (ADR-016 conflict 2).

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
  /** Writes the presentation snapshot (with this chunk's state). */
  readonly sync: () => void;
}

const WIDTH: Readonly<Record<CompanionSize, number>> = { s: 240, m: 320, l: 440 };
/** Smallest content height Chromium opens (RESEARCH §1). */
const MIN_HEIGHT = 52;

const isSize = (v: unknown): v is CompanionSize => v === 's' || v === 'm' || v === 'l';
/** Dimming within 0..0.8 (the dim layer's cap); anything else keeps `fallback`. */
const clampDim = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(0.8, Math.max(0, v)) : fallback);

export function createCompanion(deps: CompanionDeps): CompanionRuntime {
  const { controller: c, container, surface, qoe, options } = deps;
  const store = deps.store as Pick<Store<object, PresentationActionMap>, 'handle'>;
  const supported = c.capabilities.docpip !== false;
  const remember = options.remember !== false;
  let dim = clampDim(options.dim, 0.4);
  let size: CompanionSize = isSize(options.size) ? options.size : 'm';
  let audioOnly = options.audioOnly === true;

  const active = (): boolean => supported && c.mode === 'docpip';
  const windowSize = (): { width: number; height: number } => {
    const width = WIDTH[size];
    const r = surface.contentRect;
    const ratio = r.width > 0 && r.height > 0 ? r.height / r.width : 9 / 16;
    return { width, height: Math.max(MIN_HEIGHT, Math.round(width * ratio)) };
  };
  const deny = (from: string, reason: string): void => qoe.emit('presentation-denied', { from, to: 'docpip', reason });
  const resize = (): void => {
    const win = container.ownerDocument.defaultView;
    if (!active() || win === null) return;
    const { width, height } = windowSize();
    try {
      // The browser's frame (title bar) as it is now: outer minus inner.
      win.resizeTo(width + win.outerWidth - win.innerWidth, height + win.outerHeight - win.innerHeight);
    } catch (err) {
      deny('docpip', (err as { name?: string } | null)?.name === 'NotAllowedError' ? 'noUserGesture' : 'notAllowed');
    }
  };
  const mark = (): void => void container.toggleAttribute('data-otter-companion', active());

  const offs: Unsubscribe[] = [
    c.on('change', mark),
    store.handle('toggle-companion', () => {
      if (c.mode === 'docpip') return void c.exit();
      if (supported) return deps.request();
      deny(c.mode, 'unsupported');
    }),
    store.handle('companion-set', (p) => {
      const before = size;
      dim = clampDim(p.dim, dim);
      if (isSize(p.size)) size = p.size;
      if (typeof p.audioOnly === 'boolean') audioOnly = p.audioOnly;
      if (size !== before) resize();
      deps.sync();
    }),
  ];
  mark();

  return {
    supported,
    state: () => ({ supported, active: active(), dim, size, audioOnly, remember }),
    windowSize,
    destroy() {
      for (const off of offs.splice(0)) off();
      container.removeAttribute('data-otter-companion');
    },
  };
}
