// Watermark (SPEC §13.3): static DOM logo, Canvas moving mark against screen recording. M0 empty implementation.

import { notImplemented } from '@otter-player/core';
import type { Overlay } from '@otter-player/surface';

export function createWatermarkOverlay(): Overlay {
  return {
    id: 'watermark',
    // Provisional stacking order inside the overlay layer; settled with the player shell in M1.
    zIndex: 400,
    mount() {
      throw notImplemented('@otter-player/overlay-watermark mount');
    },
    destroy: () => undefined,
  };
}
