// MPEG-DASH (SPEC §8): Shaka adapter in M1. M0 empty implementation: probe() scores every source 0, so the router never selects it.

import { notImplemented } from '@otter-player/core';
import type { FormatPlugin } from '@otter-player/media';

export function createDashFormat(): FormatPlugin {
  return {
    id: 'dash',
    probe: () => 0,
    createEngine() {
      throw notImplemented('@otter-player/format-dash createEngine');
    },
  };
}
