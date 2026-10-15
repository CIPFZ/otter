// HTTP-FLV / WS-FLV (SPEC §8): self-built pipeline in M3, demuxer from mpegts.js (REUSE §3). M0 empty implementation: probe() scores every source 0, so the router never selects it.

import { notImplemented } from '@otter-player/core';
import type { FormatPlugin } from '@otter-player/media';

export function createFlvFormat(): FormatPlugin {
  return {
    id: 'flv',
    probe: () => 0,
    createEngine() {
      throw notImplemented('@otter-player/format-flv createEngine');
    },
  };
}
