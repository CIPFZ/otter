// PresentationController (SPEC §15): window-mode state machine. Every transition is
// request -> async browser result -> confirm or roll back; nothing is applied optimistically.
//
// User activation: implementations must call the browser API (requestFullscreen,
// requestPictureInPicture, screen.orientation.lock, documentPictureInPicture.requestWindow)
// synchronously inside request(), before the first await, so the gesture is not lost.

import { notImplemented, type StoreView, type Unsubscribe } from '@otter-player/core';
import type { Surface } from '@otter-player/surface';

export type PresentationMode = 'inline' | 'theater' | 'fullscreen' | 'pip' | 'docpip' | 'mini' | 'background';

export type PresentationSupport = 'native' | 'emulated' | false;

export interface PresentationChange {
  from: PresentationMode;
  to: PresentationMode;
  reason?: string;
}

export interface PresentationController {
  readonly mode: PresentationMode;
  readonly capabilities: Readonly<Record<PresentationMode, PresentationSupport>>;
  request(mode: PresentationMode, opts?: { userGesture?: Event }): Promise<PresentationMode>;
  exit(): Promise<void>;
  on(e: 'change' | 'denied', h: (p: PresentationChange) => void): Unsubscribe;
}

export interface PresentationOptions<S extends object = object, A extends object = object> {
  /** Player root: fullscreen targets the container, never the <video> (SPEC §15). */
  readonly container: HTMLElement;
  /** Picture source for PiP; the controller goes through the Surface, not the engine. */
  readonly surface: Surface;
  readonly store: StoreView<S, A>;
}

const INLINE_ONLY: Readonly<Record<PresentationMode, PresentationSupport>> = {
  inline: 'native',
  theater: false,
  fullscreen: false,
  pip: false,
  docpip: false,
  mini: false,
  background: false,
};

const noop: Unsubscribe = () => undefined;

/** M0 empty implementation: stays inline, every request is rejected as notImplemented. */
export function createPresentationController<S extends object, A extends object>(
  _options: PresentationOptions<S, A>,
): PresentationController {
  return {
    mode: 'inline',
    capabilities: INLINE_ONLY,
    request: (mode) => Promise.reject(notImplemented(`@otter-player/presentation request(${mode})`)),
    exit: () => Promise.resolve(),
    on: () => noop,
  };
}
