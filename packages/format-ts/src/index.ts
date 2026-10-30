// MPEG-TS format plugin (SPEC §8): mpegts.js adapter in M1, own pipeline with the hls.js TS
// demuxer (L2) in M3. Live sources must set `live: true`. The WebCodecs backend is fed live sources
// only, through createDemuxer (mediabunny reading the stream as it arrives, ADR-013 §7:
// surveillance walls; VOD TS on WebCodecs is not in 1.0); the router still tries MSE first unless
// the policy prefers WebCodecs.

import { createError } from '@otter-player/core';
import type { BackendKind, Capabilities, FormatPlugin, Source } from '@otter-player/media';
import { createMpegtsEngine } from '@otter-player/engine-adapter-mpegts';
import { createPipelineEngine, withAdapterFallback } from '@otter-player/engine-pipeline';

export interface TsFormatOptions {
  /** Extra mpegts.js config (adapter engine). */
  readonly config?: Record<string, unknown>;
  /**
   * `otter` (default since M3, cn-live acceptance met): Otter's own pipeline (hls.js TS demuxer, L2), falling back to the mpegts.js
   * adapter on media errors; `mpegts`: the adapter only (ADR-007 §2).
   */
  readonly engine?: 'otter' | 'mpegts';
  /** Live latency to hold with the own pipeline, seconds. */
  readonly targetLatency?: number;
}

const TS_TYPE = /mp2t/i;
const TS_EXT = /\.(ts|m2ts|mts)(\?|#|$)/i;

export function probeTs(source: Source): number {
  if (typeof source.src !== 'string') return 0;
  if (source.type !== undefined) return TS_TYPE.test(source.type) ? 1 : 0;
  return TS_EXT.test(source.src) ? 0.8 : 0;
}

export function createTsFormat(options: TsFormatOptions = {}): FormatPlugin {
  return {
    id: 'ts',
    probe: probeTs,
    backends: (source: Source, caps: Capabilities) => {
      const out: BackendKind[] = [];
      if (caps.mediaSource || caps.managedMediaSource) out.push('mse');
      // The WebCodecs demuxer is live-only (ADR-013 §7): VOD FLV / TS stays on MSE in 1.0.
      if (caps.webCodecs && source.live === true) out.push('webcodecs');
      return out;
    },
    createEngine: (ctx) => {
      const adapter = () => createMpegtsEngine(ctx, { type: 'mpegts', ...(options.config === undefined ? {} : { config: options.config }) });
      if ((options.engine ?? 'otter') === 'mpegts') return adapter();
      const own = createPipelineEngine(ctx, { type: 'ts', ...(options.targetLatency === undefined ? {} : { targetLatency: options.targetLatency }) });
      return withAdapterFallback(own, adapter, { media: ctx.media });
    },
    async createDemuxer(ctx) {
      if (ctx.source.live !== true) throw createError({ type: 'other', details: 'liveOnly', fatal: true, recoverable: false, message: 'TS on WebCodecs plays live streams only (set `live: true`; VOD goes through MSE)' });
      if (typeof ctx.source.src !== 'string') throw createError({ type: 'other', details: 'notAUrl', fatal: true, recoverable: false, message: 'format-ts plays live stream URLs (files: format-file)' });
      const { openLiveTs } = await import('@otter-player/demux-mediabunny');
      const url = new URL(ctx.source.src, typeof location === 'object' ? location.href : undefined).href;
      return openLiveTs(url, { signal: ctx.signal, createError, ...(ctx.source.headers === undefined ? {} : { headers: ctx.source.headers }) });
    },
  };
}
