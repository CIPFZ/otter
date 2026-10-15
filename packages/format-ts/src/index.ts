// MPEG-TS format plugin (SPEC §8): mpegts.js adapter in M1, own pipeline with the hls.js TS
// demuxer (L2) in M3. Live sources must set `live: true`.

import type { Capabilities, FormatPlugin, Source } from '@otter-player/media';
import { createMpegtsEngine } from '@otter-player/engine-adapter-mpegts';

export interface TsFormatOptions {
  /** Extra mpegts.js config. */
  readonly config?: Record<string, unknown>;
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
    createEngine: (ctx) =>
      createMpegtsEngine(ctx, { type: 'mpegts', ...(options.config === undefined ? {} : { config: options.config }) }),
  };
}
