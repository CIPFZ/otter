// Seek preview thumbnails (SPEC §14.2): VTT sprites or I-frame playlists. M0 empty implementation.

import { notImplemented } from '@otter-player/core';
import type { Overlay } from '@otter-player/surface';

export function createThumbnailsOverlay(): Overlay {
  return {
    id: 'thumbnails',
    // Provisional stacking order inside the overlay layer; settled with the player shell in M1.
    zIndex: 300,
    mount() {
      throw notImplemented('@otter-player/overlay-thumbnails mount');
    },
    destroy: () => undefined,
  };
}
