// Danmaku engine (SPEC §13.2). M0 empty implementation.

import { notImplemented } from '@otter-player/core';
import type { Overlay } from '@otter-player/surface';

export interface DanmakuOverlayOptions {
  /** CSS transform tracks, Canvas 2D, WebGL batch, or OffscreenCanvas in a Worker. */
  readonly renderer?: 'css' | 'canvas2d' | 'webgl' | 'offscreen';
}

export function createDanmakuOverlay(_options: DanmakuOverlayOptions = {}): Overlay {
  return {
    id: 'danmaku',
    // Provisional stacking order inside the overlay layer; settled with the player shell in M1.
    zIndex: 100,
    mount() {
      throw notImplemented('@otter-player/danmaku mount');
    },
    destroy: () => undefined,
  };
}
