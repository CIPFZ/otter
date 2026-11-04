// Preset `vod` (SPEC §19 row "long VOD + several qualities + captions", and "short videos / simple VOD" with captions and
// thumbnails off): HLS (the own CMAF-HLS engine, hls.js for what it leaves), DASH (Shaka) and
// progressive MP4 (mp4-range), on MSE with native playback as the fallback; quality ABR, captions,
// and preview-card pictures (WebVTT sprites or I-frame playlists). Captions and preview pictures are
// on-demand chunks: `captions: false` / `thumbnails: false` load neither (ADR-013 §4).
// The default skin is the host's stylesheet: `import '@otter-player/ui-skin-default'`.

import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createDashFormat } from '@otter-player/format-dash';
import { createHlsFormat } from '@otter-player/format-hls';
import { createMp4RangeFormat } from '@otter-player/format-mp4-range';
import { provideThumbnails } from '@otter-player/ui-core';
import type { PresetOptions } from './options.js';
import { createPlayer, type Player } from './player.js';

export type { PresetOptions } from './options.js';

/** Options of the `vod` preset: {@link PresetOptions} and the preview pictures. */
export interface VodOptions extends PresetOptions {
  /**
   * Preview-card pictures on the time slider (WebVTT sprites or I-frame playlists): an on-demand
   * chunk, loaded once the player is assembled.
   * @defaultValue `true`
   */
  readonly thumbnails?: boolean;
}

/**
 * A long-form VOD player: HLS (own engine, hls.js for what it hands over), DASH (Shaka) and
 * progressive MP4, on MSE with native playback as the fallback; quality ABR, captions, preview
 * pictures.
 * @example
 * ```ts
 * import { createVodPlayer } from '@otter-player/presets/vod';
 * import '@otter-player/ui-skin-default';
 *
 * const player = createVodPlayer({ container, title: 'Example' });
 * void player.load(src);
 * ```
 */
export function createVodPlayer(options: VodOptions): Player {
  return createPlayer({
    ...options,
    formats: [createHlsFormat(), createDashFormat(), createMp4RangeFormat()],
    backends: [createMseBackendFactory(), createNativeBackendFactory()],
    setup(parts) {
      let live = true;
      if (options.thumbnails !== false) {
        void import('@otter-player/overlay-thumbnails').then(({ createThumbnails }) => {
          if (live) provideThumbnails(parts.root, createThumbnails({ store: parts.store, media: parts.media }));
        });
      }
      const cleanup = options.setup?.(parts);
      return () => {
        live = false;
        provideThumbnails(parts.root, null);
        cleanup?.();
      };
    },
  });
}
