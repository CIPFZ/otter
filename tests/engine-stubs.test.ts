// Engine-layer contract tests: format probing / backend sets, and the packages that are still
// M0 empty implementations (whep format, WASM decoders).

import { describe, expect, it } from 'vitest';
import { createWebCodecsBackendFactory } from '@otter-player/backend-webcodecs';
import { createWasmFfmpegDecoder } from '@otter-player/decoder-wasm-ffmpeg';
import { createWasmHevcDecoder } from '@otter-player/decoder-wasm-hevc';
import { createDashFormat } from '@otter-player/format-dash';
import { createFileFormat } from '@otter-player/format-file';
import { createFlvFormat } from '@otter-player/format-flv';
import { createHlsFormat } from '@otter-player/format-hls';
import { createMp4RangeFormat } from '@otter-player/format-mp4-range';
import { createTsFormat } from '@otter-player/format-ts';
import { createWhepFormat } from '@otter-player/format-whep';
import { createRouter, FALLBACK_CHAIN, NO_CAPABILITIES, type Capabilities, type Source } from '@otter-player/media';

const desktop: Capabilities = { ...NO_CAPABILITIES, mediaSource: true };
const safari: Capabilities = { ...NO_CAPABILITIES, mediaSource: true, managedMediaSource: true, nativeHls: true };

describe('format probing', () => {
  const formats = [createHlsFormat(), createDashFormat(), createFlvFormat(), createTsFormat(), createMp4RangeFormat()];
  const best = (source: Source): string | undefined => {
    let winner: string | undefined;
    let score = 0;
    for (const f of formats) {
      const s = f.probe(source, desktop);
      if (s > score) {
        score = s;
        winner = f.id;
      }
    }
    return winner;
  };

  it.each([
    [{ src: 'https://e.test/master.m3u8' }, 'hls'],
    [{ src: 'https://e.test/live?x=1', type: 'application/x-mpegURL' }, 'hls'],
    [{ src: 'https://e.test/manifest.mpd' }, 'dash'],
    [{ src: 'https://e.test/live.flv?token=1' }, 'flv'],
    [{ src: 'wss://e.test/live', type: 'video/x-flv' }, 'flv'],
    [{ src: 'https://e.test/clip.ts' }, 'ts'],
    [{ src: 'https://e.test/clip.mp4' }, 'mp4-range'],
    [{ src: new Blob([], { type: 'video/mp4' }) }, 'mp4-range'],
    [{ src: 'https://e.test/unknown' }, undefined],
  ] as const)('%o -> %s', (source, id) => {
    expect(best(source)).toBe(id);
  });

  it('declares the backends each format can feed', () => {
    const hls = createHlsFormat();
    expect(hls.backends({ src: 'a.m3u8' }, desktop)).toEqual(['mse']);
    expect(hls.backends({ src: 'a.m3u8' }, safari)).toEqual(['native', 'mse']);
    // DRM goes through Shaka on MSE / MMS, never through native HLS.
    expect(hls.backends({ src: 'a.m3u8', drm: { servers: {} } }, safari)).toEqual(['mse']);
    expect(createDashFormat().backends({ src: 'a.mpd' }, NO_CAPABILITIES)).toEqual([]);
    expect(createFlvFormat().backends({ src: 'a.flv' }, desktop)).toEqual(['mse']);
    expect(createMp4RangeFormat().backends({ src: 'a.mp4' }, desktop)).toEqual(['native']);
  });
});

describe('format-file (WebCodecs only)', () => {
  const webCodecs: Capabilities = { ...desktop, webCodecs: true };
  const blob = { src: new Blob([], { type: 'video/mp4' }) };

  it('takes Blobs over mp4-range where WebCodecs exists, leaves them to <video> elsewhere', () => {
    const file = createFileFormat();
    expect(file.probe(blob, webCodecs)).toBeGreaterThan(createMp4RangeFormat().probe(blob, webCodecs));
    expect(file.probe(blob, desktop)).toBe(0);
    expect(file.probe({ src: 'https://e.test/a.mp4' }, webCodecs)).toBe(0);
    expect(file.backends(blob, webCodecs)).toEqual(['webcodecs']);
  });

  it('routes WebCodecs first and explains it', () => {
    const router = createRouter({ formats: [createFileFormat(), createMp4RangeFormat()], backends: ['webcodecs', 'mse', 'native'] });
    const decision = router.select(blob, webCodecs);
    expect(decision.step).toEqual({ backend: 'webcodecs', decoder: 'webcodecs' });
    expect(decision.explanation.steps).toContainEqual({ candidate: 'platform', outcome: 'selected', reason: 'format only feeds WebCodecs' });
    expect(createWebCodecsBackendFactory({ sink: { draw: () => undefined, clear: () => undefined } }).kind).toBe('webcodecs');
  });
});

describe('remaining M0 stubs', () => {
  it('whep format never wins routing yet', () => {
    const format = createWhepFormat();
    expect(format.id).toBe('whep');
    expect(format.probe({ src: 'x' }, desktop)).toBe(0);
    expect(format.backends({ src: 'x' }, desktop)).toEqual([]);
  });

  it.each([
    ['wasm-hevc', createWasmHevcDecoder],
    ['wasm-ffmpeg', createWasmFfmpegDecoder],
  ] as const)('%s decoder supports nothing yet', async (id, create) => {
    const decoder = create();
    expect(decoder.id).toBe(id);
    await expect(decoder.supports('hvc1.1.6.L93.B0', NO_CAPABILITIES)).resolves.toBe(false);
  });

  it('fallback chain follows SPEC §5.2', () => {
    expect(FALLBACK_CHAIN.map((s) => s.decoder ?? s.backend)).toEqual(['webcodecs', 'wasm', 'mse', 'native']);
  });
});
