// WebRTC WHEP client (SPEC §8), M4. M0 empty implementation: probe() scores every source 0, so the router never selects it.

import { notImplemented } from '@otter-player/core';
import type { FormatPlugin } from '@otter-player/media';

export function createWhepFormat(): FormatPlugin {
  return {
    id: 'whep',
    probe: () => 0,
    backends: () => [],
    createEngine() {
      throw notImplemented('@otter-player/format-whep createEngine');
    },
  };
}
