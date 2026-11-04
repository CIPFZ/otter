// Preset `live` (SPEC §19 row "live + LL-HLS / LL-DASH"): HLS live on the own CMAF-HLS engine (latency
// held at HOLD-BACK, DVR window, back to live; LL-HLS parts go to hls.js), DASH live on Shaka, on
// MSE; the live indicator and DVR time bar are in the default controls; captions.
// The default skin is the host's stylesheet: `import '@otter-player/ui-skin-default'`.

import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createDashFormat } from '@otter-player/format-dash';
import { createHlsFormat } from '@otter-player/format-hls';
import { createPlayer, type Player } from './player.js';
import type { PresetOptions } from './options.js';

/** Options of the `live` preset: {@link PresetOptions} and the latency to hold. */
export interface LivePresetOptions extends PresetOptions {
  /**
   * Latency to hold on the own HLS engine, seconds.
   * @defaultValue the playlist's HOLD-BACK
   */
  readonly targetLatency?: number;
}

/**
 * A live player: HLS live on the own engine (latency held, DVR window, back to live; LL-HLS parts
 * go to hls.js), DASH live on Shaka, on MSE; the live badge and DVR time bar in the controls.
 * @example
 * ```ts
 * import { createLivePlayer } from '@otter-player/presets/live';
 * import '@otter-player/ui-skin-default';
 *
 * const player = createLivePlayer({ container, title: 'Live' });
 * void player.load(src);
 * ```
 */
export function createLivePlayer(options: LivePresetOptions): Player {
  return createPlayer({
    ...options,
    formats: [createHlsFormat(options.targetLatency === undefined ? {} : { own: { targetLatency: options.targetLatency } }), createDashFormat()],
    // Native last: Safari's own HLS when MSE is out.
    backends: [createMseBackendFactory(), createNativeBackendFactory()],
  });
}
