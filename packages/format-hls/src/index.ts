// HLS (SPEC §8): hls.js adapter in M1, lightweight CMAF-HLS engine in M6. M0 empty implementation: probe() scores every source 0, so the router never selects it.

import { notImplemented } from '@otter-player/core';
import type { FormatPlugin } from '@otter-player/media';

export function createHlsFormat(): FormatPlugin {
  return {
    id: 'hls',
    probe: () => 0,
    createEngine() {
      throw notImplemented('@otter-player/format-hls createEngine');
    },
  };
}
