// Preset `ott-drm` (SPEC §19 row "OTT pay TV + DRM + offline"): HLS and DASH with DRM, both through Shaka (the
// only EME path; format-hls hands DRM streams to it, clear HLS keeps the own engine), on MSE with
// native playback as the fallback for clear streams; quality ABR, captions and preview pictures
// as in `vod` (on-demand chunks). `drm` is the default for every load (a source's own `drm` wins).
// Offline storage and ads are not in 1.0 (the ads overlay is a placeholder package, ADR-014).
// The default skin is the host's stylesheet: `import '@otter-player/ui-skin-default'`.

import { createMseBackendFactory } from '@otter-player/backend-mse';
import { createNativeBackendFactory } from '@otter-player/backend-native';
import { createDashFormat } from '@otter-player/format-dash';
import { createHlsFormat } from '@otter-player/format-hls';
import type { DrmConfig, LoadOptions, Source } from '@otter-player/media';
import { provideThumbnails } from '@otter-player/ui-core';
import type { PresetOptions } from './options.js';
import { createPlayer, type Player } from './player.js';

/**
 * Options of the `ott-drm` preset: {@link PresetOptions}, the DRM defaults and the preview
 * pictures.
 */
export interface OttDrmOptions extends PresetOptions {
  /**
   * License servers, headers, FairPlay certificate: applied to every load whose source has no `drm`
   * of its own.
   * @defaultValue none (clear streams only, unless a source brings its `drm`)
   */
  readonly drm?: DrmConfig;
  /**
   * Preview-card pictures on the time slider (an on-demand chunk).
   * @defaultValue `true`
   */
  readonly thumbnails?: boolean;
}

/**
 * A subscription player with DRM: HLS and DASH with DRM through Shaka (the only EME path), clear
 * HLS on the own engine, on MSE with native playback as the fallback for clear streams; ABR,
 * captions, preview pictures.
 * @example
 * ```ts
 * import { createOttDrmPlayer } from '@otter-player/presets/ott-drm';
 * import '@otter-player/ui-skin-default';
 *
 * // drm: { servers: { 'com.widevine.alpha': 'https://license.example.com/widevine' } }
 * const player = createOttDrmPlayer({ container, title: 'Example', drm });
 * void player.load(src);
 * ```
 */
export function createOttDrmPlayer(options: OttDrmOptions): Player {
  const player = createPlayer({
    ...options,
    formats: [createHlsFormat(), createDashFormat()],
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
  const drm = options.drm;
  return {
    ...player,
    load(source: string | Source, loadOptions?: LoadOptions) {
      const s: Source = typeof source === 'string' ? { src: source } : source;
      return player.load(drm === undefined || s.drm !== undefined ? s : { ...s, drm }, loadOptions);
    },
  };
}
