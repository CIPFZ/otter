// Software decoder (SPEC §9): third-party ffmpeg.wasm build (LGPL), loaded as a separate module, never bundled into core. M0 empty implementation: supports() answers false for every codec.

import { notImplemented } from '@otter-player/core';
import type { Decoder } from '@otter-player/media';

export function createWasmFfmpegDecoder(): Decoder {
  return {
    id: 'wasm-ffmpeg',
    supports: () => Promise.resolve(false),
    create() {
      throw notImplemented('@otter-player/decoder-wasm-ffmpeg create');
    },
  };
}
