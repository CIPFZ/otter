// HLS format plugin (SPEC §8, ADR-003 §3, ADR-010): the own CMAF-HLS engine by default (an
// on-demand chunk), wrapped in withAdapterFallback: what it leaves out (discontinuities,
// encryption, TS segments, LL-HLS parts, I-frame playlists) and a fatal media error during
// playback go to the hls.js adapter, keeping the user's selections. Shaka when the source carries
// DRM (DRM only goes through Shaka). Native playback when the browser plays HLS itself (Safari).
// For the WebCodecs backend (codecs MSE cannot play, e.g. HEVC; ADR-008 §2) it hands out a
// mediabunny demuxer, loaded on demand.

import { createError } from '@otter-player/core';
import type { BackendKind, Capabilities, Engine, FormatPlugin, Source } from '@otter-player/media';
// Sub-path: the engine chunk's sink must not be reachable from this entry statically.
import { withAdapterFallback } from '@otter-player/engine-pipeline/fallback';
import { createHlsJsEngine, type HlsJsEngineOptions } from '@otter-player/engine-adapter-hlsjs';
import type { CmafHlsEngineOptions } from './own/engine.js';
import { lazyCmafHlsEngine } from './own/lazy.js';

export type { CmafHlsEngineOptions } from './own/engine.js';
import { createShakaEngine, type ShakaEngineOptions } from '@otter-player/engine-adapter-shaka';

export interface HlsFormatOptions {
  /**
   * Engine for clear content; DRM content always uses Shaka. Default `otter` (own CMAF-HLS
   * engine, falling back to hls.js); `hlsjs` for the adapter only.
   */
  readonly engine?: 'otter' | 'hlsjs' | 'shaka';
  /** Own engine: seconds buffered ahead (default 30); live target latency (default HOLD-BACK). */
  readonly own?: CmafHlsEngineOptions;
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
      const out: BackendKind[] = [];
      if (caps.nativeHls && source.drm === undefined) out.push('native');
      if (caps.mediaSource || caps.managedMediaSource) out.push('mse');
      // Clear content only: the WebCodecs path has no EME.
      if (caps.webCodecs && source.drm === undefined) out.push('webcodecs');
      return out;
    },
    createEngine(ctx): Engine {
      const abr = options.abr === undefined ? {} : { abr: options.abr };
      if (ctx.source.drm !== undefined || options.engine === 'shaka') {
        return createShakaEngine(ctx, { ...options.shaka, ...abr, formatId: 'hls' });
      }
      const hlsjs = (startTime?: number): Engine =>
        createHlsJsEngine(startTime === undefined ? ctx : { ...ctx, options: { ...ctx.options, startTime } }, { ...options.hlsjs, ...abr });
      if (options.engine === 'hlsjs') return hlsjs();
      return withAdapterFallback(lazyCmafHlsEngine(ctx, options.own ?? {}), hlsjs, { media: ctx.media });
    },
    async createDemuxer(ctx) {
      if (typeof ctx.source.src !== 'string') throw createError({ type: 'other', details: 'notAUrl', fatal: true, recoverable: false, message: 'HLS plays playlist URLs' });
      const { openHls } = await import('@otter-player/demux-mediabunny');
      // Relative playlist URLs resolve against the page, like the engines do.
      const url = new URL(ctx.source.src, typeof location === 'object' ? location.href : undefined).href;
      return openHls(url, { signal: ctx.signal, createError, ...(ctx.source.headers === undefined ? {} : { headers: ctx.source.headers }) });
    },
  };
}
