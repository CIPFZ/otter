// Preset `live` (SPEC §19「直播 + LL-HLS / LL-DASH」): HLS live on the own CMAF-HLS engine (latency
// held at HOLD-BACK, DVR window, back to live; LL-HLS parts go to hls.js), DASH live on Shaka, on
// MSE; the live indicator and DVR time bar are in the default controls; captions.
// The default skin is the host's stylesheet: `import '@otter-player/ui-skin-default'`.

import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createDashFormat } from '@otter-player/format-dash';
import { createHlsFormat } from '@otter-player/format-hls';
import { createPlayer, type Player } from './player.js';
import type { PresetOptions } from './options.js';

export interface LivePresetOptions extends PresetOptions {
  /** Latency to hold on the own HLS engine, seconds; default the playlist's HOLD-BACK. */
  readonly targetLatency?: number;
}

export function createLivePlayer(options: LivePresetOptions): Player {
  return createPlayer({
    ...options,
    formats: [createHlsFormat(options.targetLatency === undefined ? {} : { own: { targetLatency: options.targetLatency } }), createDashFormat()],
    // Native last: Safari's own HLS when MSE is out.
    backends: [createMseBackendFactory(), createNativeBackendFactory()],
  });
}
