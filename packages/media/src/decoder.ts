// Decoder plugin boundary (SPEC §5, §9). WASM decoders are third-party builds loaded as separate
// modules; this interface is all the rest of Otter sees of them.

import type { OtterError } from '@otter-player/core';
import type { Capabilities } from './capabilities.js';

export interface EncodedChunk {
  readonly type: 'key' | 'delta';
  /** Microseconds, same unit as WebCodecs. */
  readonly timestamp: number;
  readonly duration?: number;
  /** Transferable; never retained by the caller after `decode`. */
  readonly data: ArrayBuffer;
}

export interface DecoderConfig {
  readonly codec: string;
  readonly codedWidth?: number;
  readonly codedHeight?: number;
  readonly sampleRate?: number;
  readonly numberOfChannels?: number;
  /** avcC / hvcC / esds payload. */
  readonly description?: ArrayBuffer;
  readonly hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  readonly output: (frame: VideoFrame | AudioData) => void;
  readonly error: (error: OtterError) => void;
}

export interface DecoderInstance {
  readonly state: 'configured' | 'closed';
  readonly decodeQueueSize: number;
  decode(chunk: EncodedChunk): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
}

export interface Decoder {
  readonly id: string;
  supports(codec: string, caps: Capabilities): Promise<'hardware' | 'software' | false>;
  create(config: DecoderConfig): DecoderInstance;
}
