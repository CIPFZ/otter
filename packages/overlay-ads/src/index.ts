// Ad overlay (SPEC §13.3): consumes timeline interstitial events only; ad logic stays out of the UI. M0 empty implementation.

import { notImplemented } from '@otter-player/core';
import type { Overlay } from '@otter-player/surface';

export function createAdsOverlay(): Overlay {
  return {
    id: 'ads',
    // Provisional stacking order inside the overlay layer; settled with the player shell in M1.
    zIndex: 500,
    mount() {
      throw notImplemented('@otter-player/overlay-ads mount');
    },
    destroy: () => undefined,
  };
}
