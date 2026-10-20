// @vitest-environment happy-dom
// Seek and clock rules of the WebCodecs backend (ADR-008 §2) with a fake demuxer / decoder /
// surface: 30 fps, a keyframe every 90 frames, a decoder that outputs I420 frames.
import { describe, expect, it, vi } from 'vitest';
import { createWebCodecsBackend } from '@otter-player/backend-webcodecs';
import { NO_CAPABILITIES, type BackendContext, type Decoder, type Demuxer, type EncodedChunk, type FormatPlugin, type FrameSink, type I420Frame } from '@otter-player/media';

const FPS = 30;
const GOP = 90;
const FRAMES = 300;
const us = (frame: number): number => Math.round((frame / FPS) * 1e6);

function fakeDemuxer(fed: number[]): Demuxer {
  async function* from(start: number): AsyncGenerator<EncodedChunk> {
    for (let i = start; i < FRAMES; i++) {
      fed.push(i);
      yield { type: i % GOP === 0 ? 'key' : 'delta', timestamp: us(i), duration: us(1), data: new ArrayBuffer(1) };
    }
  }
  return {
    info: {
      duration: FRAMES / FPS,
      startTime: 0,
      video: { id: 1, codec: 'avc1.42c01e', setup: { codec: 'avc1.42c01e', codedWidth: 2, codedHeight: 2 }, width: 2, height: 2, frameRate: FPS },
      audio: null,
    },
    packets: () => from(0),
    seek: (_track, time) => Promise.resolve(from(Math.floor(Math.floor(time * FPS + 1e-6) / GOP) * GOP)),
    destroy: () => undefined,
  };
}

/** Decodes asynchronously, like WebCodecs; a frame needs its keyframe since the last reset. */
const fakeDecoder: Decoder = {
  id: 'webcodecs',
  supports: () => Promise.resolve('software'),
  create(config) {
    let pending: ReturnType<typeof setTimeout>[] = [];
    let keyed = false;
    return {
      state: 'configured',
      get decodeQueueSize() {
        return pending.length;
      },
      decode(chunk) {
        if (chunk.type === 'key') keyed = true;
        if (!keyed) throw new Error('delta frame without its keyframe');
        const t = setTimeout(() => {
          pending = pending.filter((p) => p !== t);
          const frame: I420Frame = { format: 'I420', width: 2, height: 2, data: new Uint8Array(6), timestamp: chunk.timestamp };
          config.output(frame);
        }, 0);
        pending.push(t);
      },
      flush: () => new Promise((r) => setTimeout(r, 1)),
      reset() {
        for (const t of pending) clearTimeout(t);
        pending = [];
        keyed = false;
      },
      close() {
        this.reset();
      },
    };
  },
};

function setup() {
  const fed: number[] = [];
  const drawn: number[] = [];
  const sink: FrameSink = { draw: (f) => void drawn.push(Math.round((f.timestamp / 1e6) * FPS)), clear: vi.fn() };
  const format: FormatPlugin = {
    id: 'fake',
    probe: () => 1,
    backends: () => ['webcodecs'],
    createEngine: () => {
      throw new Error('no engine');
    },
    createDemuxer: () => Promise.resolve(fakeDemuxer(fed)),
  };
  const ctx: BackendContext = {
    format,
    step: { backend: 'webcodecs', decoder: 'webcodecs' },
    caps: NO_CAPABILITIES,
    qoe: { emit: () => undefined } as unknown as BackendContext['qoe'],
    decoders: [fakeDecoder],
  };
  const backend = createWebCodecsBackend(ctx, { sink });
  const state: Record<string, unknown> = {};
  backend.on('playback-change', (p) => Object.assign(state, p));
  return { backend, fed, drawn, state, sink };
}

describe('backend-webcodecs', () => {
  it('loads to the first frame, then seeks frame-accurately from the previous keyframe', async () => {
    const { backend, fed, drawn, state } = setup();
    await backend.load({ src: new Blob() }, {});
    expect(drawn).toEqual([0]);
    expect(state).toMatchObject({ duration: 10, readyState: 4, seeking: false, currentTime: 0 });

    for (const [time, frame] of [
      [4.3, 129],
      [139 / FPS, 139],
      [(170 + 0.4) / FPS, 170],
      [1 / FPS, 1],
    ] as const) {
      fed.length = 0;
      backend.seek(time);
      expect(state['seeking']).toBe(true);
      await vi.waitFor(() => expect(state['seeking']).toBe(false));
      expect(drawn.at(-1)).toBe(frame);
      expect(state['currentTime']).toBeCloseTo(time, 9);
      // Decoding started at the keyframe before the target, not at the target.
      expect(fed[0]).toBe(Math.floor(frame / GOP) * GOP);
    }
    backend.destroy();
  });

  it('a seek during a seek wins; the earlier one never draws', async () => {
    const { backend, drawn, state } = setup();
    await backend.load({ src: new Blob() }, {});
    backend.seek(8);
    backend.seek(2);
    await vi.waitFor(() => expect(state['seeking']).toBe(false));
    await new Promise((r) => setTimeout(r, 50));
    expect(drawn).toEqual([0, 60]);
    backend.destroy();
  });

  it('plays on the clock, shows each frame at or before it, ends at the duration', async () => {
    const { backend, drawn, state } = setup();
    await backend.load({ src: new Blob() }, { startTime: 9.5 });
    expect(drawn).toEqual([285]);
    await backend.play();
    expect(state['paused']).toBe(false);
    await vi.waitFor(() => expect(state['ended']).toBe(true), { timeout: 2000 });
    expect(state).toMatchObject({ paused: true, currentTime: 10 });
    // Monotonic, ends on the last frame.
    expect(drawn.at(-1)).toBe(FRAMES - 1);
    expect([...drawn].sort((a, b) => a - b)).toEqual(drawn);
    backend.destroy();
  });

  it('fails the load (and so falls back) when the decoder cannot take the codec', async () => {
    const { backend } = setup();
    vi.spyOn(fakeDecoder, 'supports').mockResolvedValueOnce(false);
    await expect(backend.load({ src: new Blob() }, {})).rejects.toMatchObject({ details: 'codecUnsupported', fatal: true });
    backend.destroy();
  });

  it('plays on performance.now() when the shared context will not resume, and says so once', async () => {
    class Suspended extends EventTarget {
      state = 'suspended';
      currentTime = 0;
      resume = () => Promise.reject(new DOMException('not allowed', 'NotAllowedError'));
      suspend = () => Promise.resolve();
      close = () => Promise.resolve();
    }
    vi.stubGlobal('AudioContext', Suspended);
    try {
      const { backend, state } = setup();
      const errors: string[] = [];
      backend.on('error', (e) => errors.push(e.details));
      await backend.load({ src: new Blob() }, { startTime: 2 });
      await backend.play();
      await new Promise((r) => setTimeout(r, 1300));
      expect(errors).toEqual(['audioClockUnavailable']);
      // Time still advanced with the fallback clock.
      expect(state['currentTime'] as number).toBeGreaterThan(2.9);
      backend.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
