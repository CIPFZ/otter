// MPEG-TS (SPEC §8): self-built pipeline in M3, demuxer from hls.js (REUSE §3). M0 empty implementation: probe() scores every source 0, so the router never selects it.

import { notImplemented } from '@otter-player/core';
import type { FormatPlugin } from '@otter-player/media';

export function createTsFormat(): FormatPlugin {
  return {
    id: 'ts',
    probe: () => 0,
    createEngine() {
      throw notImplemented('@otter-player/format-ts createEngine');
    },
  };
}
