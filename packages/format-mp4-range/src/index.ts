// Progressive files (SPEC §8): in M1 played natively (`<video src>`, also Blob sources). Range
// requests + moov parsing with segment-wise quality switching over MSE (xgplayer-mp4 model) land
// in M3; until then the format only offers the native backend.

import { notImplemented } from '@otter-player/core';
import type { FormatPlugin, Source } from '@otter-player/media';

const PROGRESSIVE_TYPE = /^(video\/(mp4|webm|quicktime|ogg)|audio\/(mp4|mpeg|aac|ogg|webm|flac|wav))/i;
const PROGRESSIVE_EXT = /\.(mp4|m4v|mov|webm|ogv|mp3|m4a|aac|oga|ogg|flac|wav)(\?|#|$)/i;

export function probeProgressive(source: Source): number {
  const type = source.type ?? (typeof source.src === 'string' ? undefined : source.src.type);
  if (type !== undefined && type !== '') return PROGRESSIVE_TYPE.test(type) ? 0.8 : 0;
  return typeof source.src === 'string' && PROGRESSIVE_EXT.test(source.src) ? 0.7 : 0;
}

export function createMp4RangeFormat(): FormatPlugin {
  return {
    id: 'mp4-range',
    probe: probeProgressive,
    backends: () => ['native'],
    createEngine() {
      throw notImplemented('@otter-player/format-mp4-range MSE range loading (M3)');
    },
  };
}
