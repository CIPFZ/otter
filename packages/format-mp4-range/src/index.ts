// Progressive MP4 via Range + moov parsing (SPEC §8), xgplayer-mp4 + mp4box.js (REUSE §3), M3. M0 empty implementation: probe() scores every source 0, so the router never selects it.

import { notImplemented } from '@otter-player/core';
import type { FormatPlugin } from '@otter-player/media';

export function createMp4RangeFormat(): FormatPlugin {
  return {
    id: 'mp4-range',
    probe: () => 0,
    createEngine() {
      throw notImplemented('@otter-player/format-mp4-range createEngine');
    },
  };
}
