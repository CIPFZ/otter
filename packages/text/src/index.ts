// Text tracks (SPEC §13.1): WebVTT / SRT, IMSC1 via imscJS, CEA-608/708 from engine inband cues. M0 empty implementation.

import { notImplemented } from '@otter-player/core';
import type { Overlay } from '@otter-player/surface';

export interface TextOverlayOptions {
  /** Native TextTrack rendering (system preferences, no styling) or the custom CueRenderer. */
  readonly mode?: 'native' | 'custom';
}

export function createTextOverlay(_options: TextOverlayOptions = {}): Overlay {
  return {
    id: 'text',
    // Provisional stacking order inside the overlay layer; settled with the player shell in M1.
    zIndex: 200,
    mount() {
      throw notImplemented('@otter-player/text mount');
    },
    destroy: () => undefined,
  };
}
