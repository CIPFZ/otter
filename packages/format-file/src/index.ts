// Local File / Blob over WebCodecs (SPEC §8), mediabunny demux (REUSE §3), M4. M0 empty implementation: probe() scores every source 0, so the router never selects it.

import { notImplemented } from '@otter-player/core';
import type { FormatPlugin } from '@otter-player/media';

export function createFileFormat(): FormatPlugin {
  return {
    id: 'file',
    probe: () => 0,
    backends: () => [],
    createEngine() {
      throw notImplemented('@otter-player/format-file createEngine');
    },
  };
}
