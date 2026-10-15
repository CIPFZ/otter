// HEVC software decoder (SPEC §9): third-party libde265 WASM (LGPL), loaded as a separate module, never bundled into core. M0 empty implementation: supports() answers false for every codec.

import { notImplemented } from '@otter-player/core';
import type { Decoder } from '@otter-player/media';

export function createWasmHevcDecoder(): Decoder {
  return {
    id: 'wasm-hevc',
    supports: () => Promise.resolve(false),
    create() {
      throw notImplemented('@otter-player/decoder-wasm-hevc create');
    },
  };
}
