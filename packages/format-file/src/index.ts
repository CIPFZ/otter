// Local File / Blob over WebCodecs (SPEC §8, ADR-008 §2). Demuxing is mediabunny (L1, MP4 / MOV /
// WebM / MKV / MPEG-TS / Ogg ...), loaded with the demuxer chunk on the first file. The format feeds
// only the WebCodecs backend: frame-accurate seeking and codecs MSE lacks are the point of it.

import { createError } from '@otter-player/core';
import type { FormatPlugin, Source } from '@otter-player/media';

const isBlob = (src: Source['src']): src is Blob => typeof Blob === 'function' && src instanceof Blob;

export function createFileFormat(): FormatPlugin {
  return {
    id: 'file',
    // Above format-mp4-range (0.8 for a video/* Blob) where WebCodecs exists; nothing without it,
    // so such a Blob still plays through <video>.
    probe: (source, caps) => (isBlob(source.src) && caps.webCodecs ? 0.9 : 0),
    backends: () => ['webcodecs'],
    createEngine() {
      throw createError({ type: 'other', details: 'formatNeedsWebCodecs', fatal: true, recoverable: false, message: 'format-file only feeds the WebCodecs backend (createDemuxer)' });
    },
    async createDemuxer(ctx) {
      if (!isBlob(ctx.source.src)) {
        throw createError({ type: 'other', details: 'notABlob', fatal: true, recoverable: false, message: 'format-file plays File / Blob sources' });
      }
      const { openBlob } = await import('./demuxer.js');
      return openBlob(ctx.source.src, ctx.signal, { createError });
    },
  };
}
