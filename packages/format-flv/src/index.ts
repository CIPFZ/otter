// HTTP-FLV / WS-FLV format plugin (SPEC §8): mpegts.js adapter in M1, own pipeline with the
// mpegts.js demuxer (L2) in M3. Live sources must set `live: true` (MSE). The WebCodecs backend is
// fed through createDemuxer (the pipeline's FLV samples, ADR-013 §7: surveillance walls); the
// router still tries MSE first unless the policy prefers WebCodecs.

import { createError } from '@otter-player/core';
import type { BackendKind, Capabilities, FormatPlugin, Source } from '@otter-player/media';
import { createMpegtsEngine } from '@otter-player/engine-adapter-mpegts';
import { createPipelineEngine, withAdapterFallback } from '@otter-player/engine-pipeline';

export interface FlvFormatOptions {
  /** Extra mpegts.js config (adapter engine). */
  readonly config?: Record<string, unknown>;
  /**
   * `otter` (default since M3, cn-live acceptance met): Otter's own pipeline (mpegts.js FLV demuxer, L2), falling back to the mpegts.js
   * adapter on media errors; `mpegts`: the adapter only (ADR-007 §2).
   */
  readonly engine?: 'otter' | 'mpegts';
  /** Live latency to hold with the own pipeline, seconds. */
  readonly targetLatency?: number;
}

const FLV_TYPE = /x-flv/i;
const FLV_EXT = /\.flv(\?|#|$)/i;

export function probeFlv(source: Source): number {
  if (typeof source.src !== 'string') return 0;
  if (source.type !== undefined) return FLV_TYPE.test(source.type) ? 1 : 0;
  return FLV_EXT.test(source.src) ? 0.9 : 0;
}

export function createFlvFormat(options: FlvFormatOptions = {}): FormatPlugin {
  return {
    id: 'flv',
    probe: probeFlv,
    backends: (_source: Source, caps: Capabilities) => {
      const out: BackendKind[] = [];
      if (caps.mediaSource || caps.managedMediaSource) out.push('mse');
      if (caps.webCodecs) out.push('webcodecs');
      return out;
    },
    createEngine: (ctx) => {
      const adapter = () => createMpegtsEngine(ctx, { type: 'flv', ...(options.config === undefined ? {} : { config: options.config }) });
      if ((options.engine ?? 'otter') === 'mpegts') return adapter();
      const own = createPipelineEngine(ctx, { type: 'flv', ...(options.targetLatency === undefined ? {} : { targetLatency: options.targetLatency }) });
      return withAdapterFallback(own, adapter, { media: ctx.media });
    },
    async createDemuxer(ctx) {
      if (typeof ctx.source.src !== 'string') throw createError({ type: 'other', details: 'notAUrl', fatal: true, recoverable: false, message: 'FLV plays http(s) / ws(s) URLs' });
      const { openFlvDemuxer } = await import('@otter-player/engine-pipeline/demux');
      const url = new URL(ctx.source.src, typeof location === 'object' ? location.href : undefined).href;
      return openFlvDemuxer(url, { signal: ctx.signal, createError, ...(ctx.source.headers === undefined ? {} : { headers: ctx.source.headers }) });
    },
  };
}
