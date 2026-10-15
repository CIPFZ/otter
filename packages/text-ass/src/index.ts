// ASS/SSA subtitles (SPEC §13.1): basic styles in JS, effects through an optional libass WASM module. M0 empty implementation.

import { notImplemented } from '@otter-player/core';
import type { Overlay } from '@otter-player/surface';

export interface AssOverlayOptions {
  /** Load the third-party libass WASM build (LGPL, separate module) for full effects. */
  readonly libass?: boolean;
}

export function createAssOverlay(_options: AssOverlayOptions = {}): Overlay {
  return {
    id: 'text-ass',
    // Provisional stacking order inside the overlay layer; settled with the player shell in M1.
    zIndex: 210,
    mount() {
      throw notImplemented('@otter-player/text-ass mount');
    },
    destroy: () => undefined,
  };
}
