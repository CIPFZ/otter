// hls.js engine adapter (REUSE §3, L1): wraps hls.js, exposes only MediaBackend events. M0 empty implementation: the upstream engine is not a dependency yet (added in M1).

import { notImplemented } from '@otter-player/core';
import type { Engine, EngineContext } from '@otter-player/media';

export function createHlsJsEngine(_ctx: EngineContext): Engine {
  return {
    formatId: 'hls',
    load: () => Promise.reject(notImplemented('@otter-player/engine-adapter-hlsjs load')),
    destroy: () => undefined,
  };
}
