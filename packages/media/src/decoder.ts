// Decoder plugin boundary (SPEC §5, §9). WASM decoders are third-party builds loaded as separate
// modules; this interface is all the rest of Otter sees of them.

import type { OtterError } from '@otter-player/core';
import type { Capabilities } from './capabilities.js';
import type { DecodedFrame } from './frames.js';

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
  /** Video: ITU-T H.273 colour space; passed to VideoDecoder.configure. */
  readonly colorSpace?: VideoColorSpaceInit;
  readonly hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
  /** Called for every decoded frame; the callee takes ownership (closeFrame when done). */
  readonly output: (frame: DecodedFrame) => void;
  readonly error: (error: OtterError) => void;
  /** The decoder waits for a slot (shared decode pool full) and will start later; why. */
  readonly queued?: (reason: string) => void;
  /** A decoder that was queued got its slot. */
  readonly started?: () => void;
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
  /** How this decoder runs here (build, SIMD, threads, Worker), for the route explanation. */
  describe?(): string;
}
