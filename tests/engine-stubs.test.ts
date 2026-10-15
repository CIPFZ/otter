// Contract tests for M0 empty implementations: every stub satisfies its SPEC interface and fails
// loudly with a non-fatal `notImplemented` error instead of silently doing nothing.

import { describe, expect, it } from 'vitest';
import { createMseBackend } from '@otter-player/backend-mse';
import { createNativeBackend } from '@otter-player/backend-native';
import { createWebCodecsBackend } from '@otter-player/backend-webcodecs';
import { createWasmFfmpegDecoder } from '@otter-player/decoder-wasm-ffmpeg';
import { createWasmHevcDecoder } from '@otter-player/decoder-wasm-hevc';
import { createWebCodecsDecoder } from '@otter-player/decoder-webcodecs';
import { createHlsJsEngine } from '@otter-player/engine-adapter-hlsjs';
import { createMpegtsEngine } from '@otter-player/engine-adapter-mpegts';
import { createShakaEngine } from '@otter-player/engine-adapter-shaka';
import { createDashFormat } from '@otter-player/format-dash';
import { createFileFormat } from '@otter-player/format-file';
import { createFlvFormat } from '@otter-player/format-flv';
import { createHlsFormat } from '@otter-player/format-hls';
import { createMp4RangeFormat } from '@otter-player/format-mp4-range';
import { createTsFormat } from '@otter-player/format-ts';
import { createWhepFormat } from '@otter-player/format-whep';
import { createQoeHook } from '@otter-player/core';
import {
  createRouter,
  detectCapabilities,
  EMPTY_TIME_RANGES,
  FALLBACK_CHAIN,
  NO_CAPABILITIES,
  type EngineContext,
} from '@otter-player/media';
import { createQoeCollector } from '@otter-player/qoe';

const notImplemented = { type: 'other', details: 'notImplemented', fatal: false };
const source = { src: 'https://example.test/master.m3u8' };

describe('media', () => {
  it('fallback chain follows SPEC §5.2', () => {
    expect(FALLBACK_CHAIN.map((s) => s.decoder ?? s.backend)).toEqual(['webcodecs', 'wasm', 'mse', 'native']);
  });

  it('empty TimeRanges behaves like the DOM one', () => {
    expect(EMPTY_TIME_RANGES.length).toBe(0);
    expect(() => EMPTY_TIME_RANGES.start(0)).toThrow(RangeError);
  });

  it('router and capability detection are stubs', async () => {
    const router = createRouter({ formats: [] });
    expect(() => router.select(source, NO_CAPABILITIES)).toThrow(expect.objectContaining(notImplemented));
    expect(router.explain()).toBeNull();
    await expect(detectCapabilities()).rejects.toMatchObject(notImplemented);
  });
});

describe('backends', () => {
  it.each([
    ['native', createNativeBackend],
    ['mse', createMseBackend],
    ['webcodecs', createWebCodecsBackend],
  ] as const)('%s backend', async (kind, create) => {
    const backend = create();
    expect(backend.kind).toBe(kind);
    expect(backend.tracks.quality).toBe('opaque');
    await expect(backend.load(source, {})).rejects.toMatchObject(notImplemented);
    await expect(backend.play()).rejects.toMatchObject(notImplemented);
    expect(() => backend.seek(1)).toThrow(expect.objectContaining(notImplemented));
    const off = backend.on('error', () => undefined);
    off();
    backend.destroy();
  });
});

describe('formats', () => {
  it.each([
    ['hls', createHlsFormat],
    ['dash', createDashFormat],
    ['flv', createFlvFormat],
    ['ts', createTsFormat],
    ['mp4-range', createMp4RangeFormat],
    ['whep', createWhepFormat],
    ['file', createFileFormat],
  ] as const)('%s format never wins routing yet', (id, create) => {
    const format = create();
    expect(format.id).toBe(id);
    expect(format.probe(source, NO_CAPABILITIES)).toBe(0);
  });
});

describe('engine adapters', () => {
  const ctx: EngineContext = { source, options: {}, caps: NO_CAPABILITIES, backend: 'mse', qoe: createQoeHook() };

  it.each([
    ['hls', createHlsJsEngine],
    ['dash', createShakaEngine],
    ['flv', createMpegtsEngine],
  ] as const)('%s adapter', async (formatId, create) => {
    const engine = create(ctx);
    expect(engine.formatId).toBe(formatId);
    await expect(engine.load()).rejects.toMatchObject(notImplemented);
    engine.destroy();
  });
});

describe('decoders', () => {
  it.each([
    ['webcodecs', createWebCodecsDecoder],
    ['wasm-hevc', createWasmHevcDecoder],
    ['wasm-ffmpeg', createWasmFfmpegDecoder],
  ] as const)('%s decoder supports nothing yet', async (id, create) => {
    const decoder = create();
    expect(decoder.id).toBe(id);
    await expect(decoder.supports('hvc1.1.6.L93.B0', NO_CAPABILITIES)).resolves.toBe(false);
  });
});

describe('qoe', () => {
  it('collector is a stub', () => {
    const collector = createQoeCollector(createQoeHook());
    expect(() => collector.snapshot()).toThrow(expect.objectContaining(notImplemented));
    collector.destroy();
  });
});
