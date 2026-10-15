// Default decoder over WebCodecs VideoDecoder / AudioDecoder (SPEC §9). M0 empty implementation: supports() answers false for every codec.

import { notImplemented } from '@otter-player/core';
import type { Decoder } from '@otter-player/media';

export function createWebCodecsDecoder(): Decoder {
  return {
    id: 'webcodecs',
    supports: () => Promise.resolve(false),
    create() {
      throw notImplemented('@otter-player/decoder-webcodecs create');
    },
  };
}
