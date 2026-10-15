// Shaka Player engine adapter (REUSE §3, L1): DASH / HLS, DRM via drm.servers, offline storage. M0 empty implementation: the upstream engine is not a dependency yet (added in M1).

import { notImplemented } from '@otter-player/core';
import type { Engine, EngineContext } from '@otter-player/media';

export function createShakaEngine(_ctx: EngineContext): Engine {
  return {
    formatId: 'dash',
    load: () => Promise.reject(notImplemented('@otter-player/engine-adapter-shaka load')),
    destroy: () => undefined,
  };
}
