// WASM software decoder (SPEC §9, ADR-008 §4): Jessibuca 4's jv4-decoder (L2 copy, src/vendor/
// jessibuca), HEVC and H.264, run in the shared decode pool's Workers and loaded only when a
// stream needs it: the ~1 MB module is fetched by the Worker on the first decoder. The SIMD
// build (libhevc / libavc) where WebAssembly SIMD validates, else the plain one (FFmpeg). Both
// are single-threaded builds: crossOriginIsolated is detected and reported, a threaded build
// would need it.

import { sharedDecodePool, type DecodePool, type WorkerCodec } from '@otter-player/decoder-pool';
import type { Decoder } from '@otter-player/media';
import { wasmWorker } from './worker.js';

export interface WasmHevcDecoderOptions {
  /**
   * Directory holding videodec[_simd].{js,wasm} (copied with this package: src/vendor/jessibuca,
   * dist/vendor/jessibuca). Default: next to this module.
   */
  readonly baseUrl?: string | URL;
  /** 'auto' (default) uses the SIMD build where WebAssembly SIMD validates. */
  readonly simd?: 'auto' | boolean;
  readonly pool?: DecodePool;
}

/** What the decoder runs with, for route explanations. */
export interface WasmHevcInfo {
  readonly simd: boolean;
  readonly crossOriginIsolated: boolean;
  readonly threads: 'single';
  readonly build: 'jv4-decoder libhevc/libavc (SIMD)' | 'jv4-decoder FFmpeg (no SIMD)';
}

// The smallest module using a v128 instruction (i8x16.splat / i8x16.popcnt), as feature-detected
// by wasm-feature-detect.
const SIMD_PROBE = [0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11];

export const wasmSimdSupported = (): boolean => typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array(SIMD_PROBE));

const CODECS = /^(hvc1|hev1|avc1|avc3)\./;

export function createWasmHevcDecoder(options: WasmHevcDecoderOptions = {}): Decoder & { info(): WasmHevcInfo } {
  const info = (): WasmHevcInfo => {
    const simd = options.simd === undefined || options.simd === 'auto' ? wasmSimdSupported() : options.simd;
    return {
      simd,
      crossOriginIsolated: typeof crossOriginIsolated === 'boolean' && crossOriginIsolated,
      threads: 'single',
      build: simd ? 'jv4-decoder libhevc/libavc (SIMD)' : 'jv4-decoder FFmpeg (no SIMD)',
    };
  };
  let codec: WorkerCodec | undefined;
  const workerCodec = (): WorkerCodec => {
    if (codec !== undefined) return codec;
    const simd = info().simd;
    // A non-literal path: bundlers leave it alone and the files are served as they are.
    const dir = 'vendor/jessibuca/';
    const base = new URL(options.baseUrl ?? dir, import.meta.url);
    const name = simd ? 'videodec_simd' : 'videodec';
    codec = {
      kind: `jv4-decoder${simd ? '-simd' : ''}`,
      source: wasmWorker.toString(),
      env: { glueUrl: new URL(`${name}.js`, base).href, wasmUrl: new URL(`${name}.wasm`, base).href },
    };
    return codec;
  };
  return {
    id: 'wasm-hevc',
    info,
    describe() {
      const i = info();
      return `${i.build}, ${i.threads}-threaded (crossOriginIsolated ${i.crossOriginIsolated ? 'true' : 'false'}; the copied builds have no threads), in the decode pool`;
    },
    supports(c) {
      return Promise.resolve(typeof Worker === 'function' && typeof WebAssembly === 'object' && CODECS.test(c) ? 'software' : false);
    },
    create(config) {
      return (options.pool ?? sharedDecodePool()).open(workerCodec(), config, { label: `${config.codec} (wasm)` });
    },
  };
}
