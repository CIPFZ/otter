// Progressive files (SPEC §8). A single file plays natively (`<video src>`, also Blob sources);
// several renditions of one programme (`Source.renditions`) play over MSE with Range requests and
// keyframe-boundary quality switching (ADR-007 §4), falling back to the native element.

import type { Capabilities, FormatPlugin, Source } from '@otter-player/media';
import { lazyEngine } from './lazy.js';

export type { Mp4RangeEngineOptions } from './engine.js';

export interface Mp4RangeFormatOptions {
  /** `renditions` (default): MSE only for multi-rendition sources; `always`: single files too. */
  readonly mse?: 'renditions' | 'always';
  /** Seconds buffered ahead before reading pauses (default 30). */
  readonly maxBufferAheadS?: number;
}

const PROGRESSIVE_TYPE = /^(video\/(mp4|webm|quicktime|ogg)|audio\/(mp4|mpeg|aac|ogg|webm|flac|wav))/i;
const PROGRESSIVE_EXT = /\.(mp4|m4v|mov|webm|ogv|mp3|m4a|aac|oga|ogg|flac|wav)(\?|#|$)/i;

export function probeProgressive(source: Source): number {
  const type = source.type ?? (typeof source.src === 'string' ? undefined : source.src.type);
  if (type !== undefined && type !== '') return PROGRESSIVE_TYPE.test(type) ? 0.8 : 0;
  return typeof source.src === 'string' && PROGRESSIVE_EXT.test(source.src) ? 0.7 : 0;
}

export function createMp4RangeFormat(options: Mp4RangeFormatOptions = {}): FormatPlugin {
  return {
    id: 'mp4-range',
    probe: probeProgressive,
    backends: (source: Source, caps: Capabilities) => {
      const ranged = typeof source.src === 'string' && ((source.renditions?.length ?? 0) > 1 || options.mse === 'always');
      return ranged && (caps.mediaSource || caps.managedMediaSource) ? ['mse', 'native'] : ['native'];
    },
    createEngine: (ctx) =>
      lazyEngine('mp4-range', async () =>
        (await import('./engine.js')).createMp4RangeEngine(ctx, options.maxBufferAheadS === undefined ? {} : { maxBufferAheadS: options.maxBufferAheadS }),
      ),
  };
}
