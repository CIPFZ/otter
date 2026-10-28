// Preset `vod` (SPEC §19「长视频点播 + 多清晰度 + 字幕」, and「短视频 / 简单点播」with captions and
// thumbnails off): HLS (the own CMAF-HLS engine, hls.js for what it leaves), DASH (Shaka) and
// progressive MP4 (mp4-range), on MSE with native playback as the fallback; quality ABR, captions,
// and preview-card pictures (WebVTT sprites or I-frame playlists).
// The default skin is the host's stylesheet: `import '@otter-player/ui-skin-default'`.

import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createDashFormat } from '@otter-player/format-dash';
import { createHlsFormat } from '@otter-player/format-hls';
import { createMp4RangeFormat } from '@otter-player/format-mp4-range';
import { createThumbnails } from '@otter-player/overlay-thumbnails';
import { provideThumbnails } from '@otter-player/ui-core';
import type { PresetOptions } from './options.js';
import { createPlayer, type Player } from './player.js';

export type { PresetOptions } from './options.js';

export interface VodOptions extends PresetOptions {
  /** Preview-card pictures on the time slider. Default true. */
  readonly thumbnails?: boolean;
}

export function createVodPlayer(options: VodOptions): Player {
  return createPlayer({
    ...options,
    formats: [createHlsFormat(), createDashFormat(), createMp4RangeFormat()],
    backends: [createMseBackendFactory(), createNativeBackendFactory()],
    setup(parts) {
      if (options.thumbnails !== false) provideThumbnails(parts.root, createThumbnails({ store: parts.store, media: parts.media }));
      return options.setup?.(parts);
    },
  });
}
