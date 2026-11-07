// Preset `lowlatency` (SPEC §19 row "live + LL-HLS / LL-DASH", the low-latency half): LL-HLS goes straight
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

/** Options of the `lowlatency` preset: {@link PresetOptions} and the latency to hold. */
export interface LowLatencyOptions extends PresetOptions {
  /**
   * Seconds behind the live edge to hold (HLS: hls.js `liveSyncDuration`).
   * @defaultValue the playlist's PART-HOLD-BACK
   */
  readonly targetLatency?: number;
}

/**
 * A low-latency live player: LL-HLS straight to hls.js (low-latency mode), LL-DASH on Shaka, on MSE;
 * native playback last (Safari's own LL-HLS where MSE is out).
 * @example
 * ```ts
 * import { createLowLatencyPlayer } from '@otter-player/presets/lowlatency';
 * import '@otter-player/ui-skin-default';
 *
 * const player = createLowLatencyPlayer({ container, title: 'Live', targetLatency: 3 });
 * void player.load(src).catch((error: unknown) => {
 *   if (!(error instanceof Error && error.name === 'AbortError')) console.error(error);
 * });
 * ```
 */
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
