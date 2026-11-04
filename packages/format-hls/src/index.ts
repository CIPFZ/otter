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
import type { HlsJsEngineOptions } from '@otter-player/engine-adapter-hlsjs';
import type { CmafHlsEngineOptions } from './own/engine.js';
import { lazyCmafHlsEngine } from './own/lazy.js';

export type { CmafHlsEngineOptions } from './own/engine.js';
import type { ShakaEngineOptions } from '@otter-player/engine-adapter-shaka';
import { lazyEngine } from './lazy-adapter.js';

/** Options of the HLS format. */
export interface HlsFormatOptions {
  /**
   * Engine for clear content (DRM content always goes to Shaka): `otter`, the own CMAF-HLS engine
   * falling back to hls.js; `hlsjs`, the adapter only; `shaka`.
   * @defaultValue `'otter'`
   */
  readonly engine?: 'otter' | 'hlsjs' | 'shaka';
  /**
   * Own engine options: buffer ahead, live latency.
   * @defaultValue `{}`
   */
  readonly own?: CmafHlsEngineOptions;
  /**
   * hls.js adapter options (configuration, the light build).
   * @defaultValue `{}`
   */
  readonly hlsjs?: HlsJsEngineOptions;
  /**
   * Shaka adapter options (DRM streams).
   * @defaultValue `{}`
   */
  readonly shaka?: ShakaEngineOptions;
  /**
   * Who decides the quality: `otter`, the pipeline ABR rule stack; `engine`, the engine's own ABR
   * (ADR-005 §1).
   * @defaultValue `'otter'`
   */
  readonly abr?: 'otter' | 'engine';
}

const HLS_TYPE = /mpegurl/i;
const HLS_EXT = /\.m3u8(\?|#|$)/i;

/** How likely a source is HLS, 0..1 (an `mpegurl` type, `.m3u8`): the router's probe. */
export function probeHls(source: Source): number {
  if (typeof source.src !== 'string') return 0;
  if (source.type !== undefined) return HLS_TYPE.test(source.type) ? 1 : 0;
  return HLS_EXT.test(source.src) ? 0.9 : 0;
}

/**
 * The HLS format: the own CMAF-HLS engine (an on-demand chunk), hls.js for what it leaves out,
 * Shaka for DRM, native playback where the browser plays HLS itself (Safari).
 */
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
        return lazyEngine('hls', async () => (await import('@otter-player/engine-adapter-shaka')).createShakaEngine(ctx, { ...options.shaka, ...abr, formatId: 'hls' }));
      }
      const hlsjs = (startTime?: number): Engine =>
        lazyEngine('hls', async () => (await import('@otter-player/engine-adapter-hlsjs')).createHlsJsEngine(startTime === undefined ? ctx : { ...ctx, options: { ...ctx.options, startTime } }, { ...options.hlsjs, ...abr }));
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
