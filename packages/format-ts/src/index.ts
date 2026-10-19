// MPEG-TS format plugin (SPEC §8): mpegts.js adapter in M1, own pipeline with the hls.js TS
// demuxer (L2) in M3. Live sources must set `live: true`.

import type { Capabilities, FormatPlugin, Source } from '@otter-player/media';
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
    backends: (_source: Source, caps: Capabilities) => (caps.mediaSource || caps.managedMediaSource ? ['mse'] : []),
    createEngine: (ctx) => {
      const adapter = () => createMpegtsEngine(ctx, { type: 'mpegts', ...(options.config === undefined ? {} : { config: options.config }) });
      if ((options.engine ?? 'otter') === 'mpegts') return adapter();
      const own = createPipelineEngine(ctx, { type: 'ts', ...(options.targetLatency === undefined ? {} : { targetLatency: options.targetLatency }) });
      return withAdapterFallback(own, adapter);
    },
  };
}
