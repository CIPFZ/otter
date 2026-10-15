// mpegts.js engine adapter (REUSE §3, L1): HTTP-FLV / WS-FLV / MPEG-TS live. M0 empty implementation: the upstream engine is not a dependency yet (added in M1).

import { notImplemented } from '@otter-player/core';
import type { Engine, EngineContext } from '@otter-player/media';

export function createMpegtsEngine(_ctx: EngineContext): Engine {
  return {
    formatId: 'flv',
    load: () => Promise.reject(notImplemented('@otter-player/engine-adapter-mpegts load')),
    destroy: () => undefined,
  };
}
