// HLS format plugin (SPEC §8, ADR-003 §3): hls.js adapter by default, Shaka when the source carries
// DRM (DRM only goes through Shaka). Native playback when the browser plays HLS itself (Safari).

import type { Capabilities, Engine, FormatPlugin, Source } from '@otter-player/media';
import { createHlsJsEngine, type HlsJsEngineOptions } from '@otter-player/engine-adapter-hlsjs';
import { createShakaEngine, type ShakaEngineOptions } from '@otter-player/engine-adapter-shaka';

export interface HlsFormatOptions {
  /** Engine for clear content; DRM content always uses Shaka. Default `hlsjs`. */
  readonly engine?: 'hlsjs' | 'shaka';
  readonly hlsjs?: HlsJsEngineOptions;
  readonly shaka?: ShakaEngineOptions;
  /** `otter` (default): pipeline ABR rule stack; `engine`: the engine's own ABR (ADR-005 §1). */
  readonly abr?: 'otter' | 'engine';
}

const HLS_TYPE = /mpegurl/i;
const HLS_EXT = /\.m3u8(\?|#|$)/i;

export function probeHls(source: Source): number {
  if (typeof source.src !== 'string') return 0;
  if (source.type !== undefined) return HLS_TYPE.test(source.type) ? 1 : 0;
  return HLS_EXT.test(source.src) ? 0.9 : 0;
}

export function createHlsFormat(options: HlsFormatOptions = {}): FormatPlugin {
  return {
    id: 'hls',
    probe: probeHls,
    backends(source: Source, caps: Capabilities) {
      const out: ('native' | 'mse')[] = [];
      if (caps.nativeHls && source.drm === undefined) out.push('native');
      if (caps.mediaSource || caps.managedMediaSource) out.push('mse');
      return out;
    },
    createEngine(ctx): Engine {
      const abr = options.abr === undefined ? {} : { abr: options.abr };
      if (ctx.source.drm !== undefined || options.engine === 'shaka') {
        return createShakaEngine(ctx, { ...options.shaka, ...abr, formatId: 'hls' });
      }
      return createHlsJsEngine(ctx, { ...options.hlsjs, ...abr });
    },
  };
}
