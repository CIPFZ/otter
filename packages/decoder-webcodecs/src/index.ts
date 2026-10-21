// Default decoder over WebCodecs VideoDecoder / AudioDecoder (SPEC §9, ADR-008 §2). One Decoder
// instance per track; frames go out as VideoFrame / AudioData (transferable). The browser picks
// hardware or software decoding; `supports` reports which one is available. Video decodes in the
// shared Worker pool (ADR-008 §3) by default; audio stays on the main thread (cheap, and its
// output goes to the AudioWorklet from there).

import { createError, type OtterError } from '@otter-player/core';
import { sharedDecodePool, type DecodePool, type WorkerCodec } from '@otter-player/decoder-pool';
import type { Decoder, DecoderConfig, DecoderInstance, EncodedChunk } from '@otter-player/media';
import { webCodecsWorker } from './worker.js';

export interface WebCodecsDecoderOptions {
  /**
   * Only accept hardware decoding (supports() answers false otherwise). Lets hosts and tests
   * force the WASM / MSE fallback steps.
   */
  readonly requireHardware?: boolean;
  /**
   * Take no video at all, as on a machine without a decoder for the codec: the WebCodecs step
   * fails (codecUnsupported) and the route falls back (WASM, MSE). For hosts that switch hardware
   * decoding off, and for testing the fallback chain.
   */
  readonly disableVideo?: boolean;
  /**
   * Where video decodes: a pool (default: the page's shared pool), or false for the main thread
   * (also the fallback where Workers or WebCodecs in Workers are missing).
   */
  readonly pool?: DecodePool | false;
}

let codec: WorkerCodec | undefined;
/** The pool kind for this decoder (worker source built once). */
const workerCodec = (): WorkerCodec => (codec ??= { kind: 'webcodecs', source: webCodecsWorker.toString() });

const AUDIO = /^(mp4a|opus|vorbis|flac|mp3|ac-3|ec-3|alaw|ulaw|pcm-)/i;

/** Audio codec strings (RFC 6381 / WebCodecs registry). */
export const isAudioCodec = (codec: string): boolean => AUDIO.test(codec);

const decodeError = (details: string, cause: unknown): OtterError =>
  createError({
    type: 'media',
    details,
    fatal: true,
    recoverable: true,
    message: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
    cause,
  });

async function videoSupport(codec: string, requireHardware: boolean): Promise<'hardware' | 'software' | false> {
  const any = await VideoDecoder.isConfigSupported({ codec }).catch(() => ({ supported: false }));
  // Chrome treats prefer-hardware as a requirement in isConfigSupported, which tells them apart.
  const hw = await VideoDecoder.isConfigSupported({ codec, hardwareAcceleration: 'prefer-hardware' }).catch(() => ({ supported: false }));
  if (hw.supported === true) return 'hardware';
  if (requireHardware) return false;
  return any.supported === true ? 'software' : false;
}

export function createWebCodecsDecoder(options: WebCodecsDecoderOptions = {}): Decoder {
  const requireHardware = options.requireHardware === true;
  return {
    id: 'webcodecs',
    describe: () => (options.pool === false || typeof Worker !== 'function' ? 'WebCodecs on the main thread' : 'WebCodecs video in the decode pool, audio on the main thread'),
    async supports(codec) {
      if (isAudioCodec(codec)) {
        if (typeof AudioDecoder !== 'function') return false;
        // Audio is never hardware decoded in browsers; requireHardware is about video.
        const s = await AudioDecoder.isConfigSupported({ codec, sampleRate: 48000, numberOfChannels: 2 }).catch(() => ({ supported: false }));
        return s.supported === true ? 'software' : false;
      }
      if (typeof VideoDecoder !== 'function' || options.disableVideo === true) return false;
      return videoSupport(codec, requireHardware);
    },
    create(config) {
      if (config.sampleRate !== undefined) return createAudio(config);
      const pool = options.pool === false || typeof Worker !== 'function' ? undefined : (options.pool ?? sharedDecodePool());
      if (pool === undefined) return createVideo(config, requireHardware);
      return pool.open(workerCodec(), requireHardware ? { ...config, hardwareAcceleration: 'prefer-hardware' } : config, { label: config.codec });
    },
  };
}

function createVideo(config: DecoderConfig, requireHardware: boolean): DecoderInstance {
  let failed = false;
  const decoder = new VideoDecoder({
    output: (frame) => config.output(frame),
    error: (e) => {
      if (failed) return;
      failed = true;
      config.error(decodeError(e.name === 'NotSupportedError' ? 'decoderUnsupported' : 'decodeError', e));
    },
  });
  const configure = (): void =>
    decoder.configure({
      codec: config.codec,
      ...(config.codedWidth === undefined ? {} : { codedWidth: config.codedWidth }),
      ...(config.codedHeight === undefined ? {} : { codedHeight: config.codedHeight }),
      ...(config.description === undefined ? {} : { description: config.description }),
      ...(config.colorSpace === undefined ? {} : { colorSpace: config.colorSpace }),
      hardwareAcceleration: requireHardware ? 'prefer-hardware' : (config.hardwareAcceleration ?? 'no-preference'),
    });
  configure();
  return wrap(decoder, configure, (chunk) => new EncodedVideoChunk(init(chunk)));
}

function createAudio(config: DecoderConfig): DecoderInstance {
  let failed = false;
  const decoder = new AudioDecoder({
    output: (data) => config.output(data),
    error: (e) => {
      if (failed) return;
      failed = true;
      config.error(decodeError(e.name === 'NotSupportedError' ? 'decoderUnsupported' : 'decodeError', e));
    },
  });
  const configure = (): void =>
    decoder.configure({
      codec: config.codec,
      sampleRate: config.sampleRate as number,
      numberOfChannels: config.numberOfChannels ?? 2,
      ...(config.description === undefined ? {} : { description: config.description }),
    });
  configure();
  return wrap(decoder, configure, (chunk) => new EncodedAudioChunk(init(chunk)));
}

const init = (chunk: EncodedChunk): EncodedVideoChunkInit => ({
  type: chunk.type,
  timestamp: chunk.timestamp,
  ...(chunk.duration === undefined ? {} : { duration: chunk.duration }),
  data: chunk.data,
});

/** WebCodecs reset() also drops the configuration: configure again so the instance stays usable. */
function wrap<C>(decoder: VideoDecoder | AudioDecoder, configure: () => void, chunk: (c: EncodedChunk) => C): DecoderInstance {
  return {
    get state() {
      return decoder.state === 'closed' ? 'closed' : 'configured';
    },
    get decodeQueueSize() {
      return decoder.decodeQueueSize;
    },
    decode(c) {
      if (decoder.state !== 'configured') return;
      (decoder as { decode(c: C): void }).decode(chunk(c));
    },
    async flush() {
      if (decoder.state !== 'configured') return;
      await decoder.flush();
    },
    reset() {
      if (decoder.state === 'closed') return;
      decoder.reset();
      configure();
    },
    close() {
      if (decoder.state !== 'closed') decoder.close();
    },
  };
}
