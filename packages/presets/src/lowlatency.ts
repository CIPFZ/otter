// Preset `lowlatency` (SPEC §19「直播 + LL-HLS / LL-DASH」, the low-latency half): LL-HLS goes straight
// to hls.js (low-latency mode, partial segments: the own engine leaves EXT-X-PART to it, ADR-010, so
// there is no first try on the own engine), LL-DASH to Shaka (its low-latency mode applies to
// low-latency manifests), on MSE; native last (Safari's own LL-HLS when MSE is out).
// The default skin is the host's stylesheet: `import '@otter-player/ui-skin-default'`.

import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createDashFormat } from '@otter-player/format-dash';
import { createHlsFormat } from '@otter-player/format-hls';
import type { PresetOptions } from './options.js';
import { createPlayer, type Player } from './player.js';

export interface LowLatencyOptions extends PresetOptions {
  /** HLS: seconds behind the live edge to hold (hls.js liveSyncDuration); default the playlist's PART-HOLD-BACK. */
  readonly targetLatency?: number;
}

export function createLowLatencyPlayer(options: LowLatencyOptions): Player {
  const latency = options.targetLatency;
  return createPlayer({
    ...options,
    formats: [
      createHlsFormat({ engine: 'hlsjs', hlsjs: { config: { lowLatencyMode: true, ...(latency === undefined ? {} : { liveSyncDuration: latency }) } } }),
      createDashFormat(),
    ],
    backends: [createMseBackendFactory(), createNativeBackendFactory()],
  });
}
