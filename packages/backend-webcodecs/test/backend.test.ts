// @vitest-environment happy-dom
// Seek and clock rules of the WebCodecs backend (ADR-008 §2) with a fake demuxer / decoder /
// surface: 30 fps, a keyframe every 90 frames, a decoder that outputs I420 frames.
import { describe, expect, it, vi } from 'vitest';
import { createError } from '@otter-player/core';
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

interface FakeOptions {
  /** After this many decodes: report a decode error (ok: never). */
  readonly failAfter?: number;
  /** After this many decodes: keep the packets, output nothing more. */
  readonly stallAfter?: number;
}

/** Decodes asynchronously, like WebCodecs; a frame needs its keyframe since the last reset. */
const makeDecoder = (id: string, o: FakeOptions = {}): Decoder => ({
  id,
  supports: () => Promise.resolve('software'),
  create(config) {
    let decodes = 0;
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
        decodes++;
        if (o.failAfter !== undefined && decodes > o.failAfter) {
          if (decodes === o.failAfter + 1) setTimeout(() => config.error(createError({ type: 'media', details: 'decodeError', fatal: true, recoverable: true, message: 'fake' })), 0);
          return;
        }
        if (o.stallAfter !== undefined && decodes > o.stallAfter) {
          pending.push(setTimeout(() => undefined, 1e9));
          return;
        }
        const w = config.codedWidth ?? 2;
        const t = setTimeout(() => {
          pending = pending.filter((p) => p !== t);
          const frame: I420Frame = { format: 'I420', width: w, height: 2, data: new Uint8Array(6), timestamp: chunk.timestamp };
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
});
const fakeDecoder: Decoder = makeDecoder('webcodecs');

function setup(decoders: readonly Decoder[] = [fakeDecoder], demux?: (fed: number[]) => Demuxer) {
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
    createDemuxer: () => Promise.resolve((demux ?? fakeDemuxer)(fed)),
  };
  const ctx: BackendContext = {
    format,
    step: { backend: 'webcodecs', decoder: 'webcodecs' },
    caps: NO_CAPABILITIES,
    qoe: { emit: () => undefined } as unknown as BackendContext['qoe'],
    decoders,
  };
  const backend = createWebCodecsBackend(ctx, { sink });
  const state: Record<string, unknown> = {};
  backend.on('playback-change', (p) => Object.assign(state, p));
  const details: { reason: string; candidate?: string; outcome?: string }[] = [];
  backend.on('route-detail', (d) => details.push(d));
  const errors: string[] = [];
  backend.on('error', (e) => errors.push(e.details));
  const qualities: string[] = [];
  backend.on('quality-change', (q) => qualities.push(q.id));
  return { backend, fed, drawn, state, sink, details, errors, qualities };
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
      // A rejected resume() is final at once: reported on the next tick, not after the grace.
      await new Promise((r) => setTimeout(r, 1300));
      expect(errors).toEqual(['audioClockUnavailable']);
      // Time still advanced with the fallback clock.
      expect(state['currentTime'] as number).toBeGreaterThan(2.9);
      backend.destroy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('without a user gesture: muted, no AudioContext, the wall clock and no audioClockUnavailable; the first gesture brings the context clock', async () => {
    // A page nobody touched (a surveillance wall, autoplay): the autoplay policy would keep any
    // AudioContext suspended (real Edge, M6 test round F1).
    const created: unknown[] = [];
    class Gated extends EventTarget {
      state = 'suspended';
      currentTime = 0;
      constructor() {
        super();
        created.push(this);
      }
      resume = () => {
        if (!activation.hasBeenActive) return new Promise<void>(() => undefined);
        this.state = 'running';
        this.dispatchEvent(new Event('statechange'));
        return Promise.resolve();
      };
      suspend = () => Promise.resolve();
      close = () => Promise.resolve();
    }
    const activation = { hasBeenActive: false };
    vi.stubGlobal('AudioContext', Gated);
    Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true });
    try {
      const { backend, state, errors } = setup();
      await backend.load({ src: new Blob() }, { startTime: 2 });
      await backend.play();
      await new Promise((r) => setTimeout(r, 3600));
      expect(created).toHaveLength(0);
      expect(errors).not.toContain('audioClockUnavailable');
      expect(state['muted']).toBe(true);
      expect(state['currentTime'] as number).toBeGreaterThan(5);
      // The first gesture: the context is created (inside it) and the clock moves to it.
      activation.hasBeenActive = true;
      document.dispatchEvent(new Event('pointerdown'));
      await new Promise((r) => setTimeout(r, 50));
      expect(created).toHaveLength(1);
      expect((created[0] as Gated).state).toBe('running');
      expect(errors).not.toContain('audioClockUnavailable');
      backend.destroy();
    } finally {
      vi.unstubAllGlobals();
      delete (navigator as { userActivation?: unknown }).userActivation;
    }
  });

  it('WebKit: the gesture context starts suspended and only a later gesture resumes it; no audioClockUnavailable meanwhile (M6 F13)', async () => {
    const created: WebKitLike[] = [];
    let allowed = false;
    class WebKitLike extends EventTarget {
      state = 'suspended';
      currentTime = 0;
      resumes = 0;
      constructor() {
        super();
        created.push(this);
      }
      // Not an audio gesture (pointerdown): pending; a click: running after a while.
      resume = () => {
        this.resumes++;
        if (!allowed) return new Promise<void>(() => undefined);
        return new Promise<void>((r) =>
          setTimeout(() => {
            this.state = 'running';
            this.dispatchEvent(new Event('statechange'));
            r();
          }, 200),
        );
      };
      suspend = () => Promise.resolve();
      close = () => Promise.resolve();
    }
    const activation = { hasBeenActive: false };
    vi.stubGlobal('AudioContext', WebKitLike);
    Object.defineProperty(navigator, 'userActivation', { value: activation, configurable: true });
    try {
      const { backend, errors } = setup();
      await backend.load({ src: new Blob() }, { startTime: 2 });
      await backend.play();
      await new Promise((r) => setTimeout(r, 300));
      activation.hasBeenActive = true;
      document.dispatchEvent(new Event('pointerdown'));
      await new Promise((r) => setTimeout(r, 1000));
      expect(created).toHaveLength(1);
      expect(created[0]?.state).toBe('suspended');
      expect(errors).not.toContain('audioClockUnavailable');
      allowed = true;
      document.dispatchEvent(new Event('click'));
      await new Promise((r) => setTimeout(r, 600));
      expect(created[0]?.state).toBe('running');
      expect(errors).not.toContain('audioClockUnavailable');
      // Running: the listeners are gone (a later click does not touch the context).
      const n = created[0]?.resumes ?? 0;
      document.dispatchEvent(new Event('click'));
      expect(created[0]?.resumes).toBe(n);
      expect(created).toHaveLength(1);
      backend.destroy();
    } finally {
      vi.unstubAllGlobals();
      delete (navigator as { userActivation?: unknown }).userActivation;
    }
  });

  it('runtime fallback: a decode error while playing moves to the WASM decoder, from the keyframe before', async () => {
    const wasm = makeDecoder('wasm-hevc');
    const { backend, drawn, details, errors, state } = setup([makeDecoder('webcodecs', { failAfter: 40 }), wasm]);
    const created = vi.spyOn(wasm, 'create');
    await backend.load({ src: new Blob() }, { startTime: 3 });
    await backend.play();
    await vi.waitFor(() => expect(errors).toContain('decoderFallback'), { timeout: 3000 });
    expect(created).toHaveBeenCalledTimes(1);
    expect(details).toContainEqual(expect.objectContaining({ candidate: 'webcodecs', outcome: 'failed', reason: expect.stringMatching(/^decodeError at \d+\.\d{3} s \(runtime\)$/) }));
    expect(details).toContainEqual(expect.objectContaining({ candidate: 'wasm', outcome: 'selected', reason: expect.stringContaining('runtime fallback inside backend-webcodecs') }));
    // It keeps playing on the new decoder (no fatal error, the picture moves on).
    const before = drawn.length;
    await vi.waitFor(() => expect(drawn.length).toBeGreaterThan(before + 10), { timeout: 3000 });
    expect(state['paused']).toBe(false);
    expect(errors.filter((e) => e !== 'decoderFallback' && e !== 'audioClockUnavailable')).toEqual([]);
    backend.destroy();
  });

  it('runtime fallback also covers a decoder that stops producing frames', async () => {
    const { backend, errors, details } = setup([makeDecoder('webcodecs', { stallAfter: 30 }), makeDecoder('wasm-hevc')]);
    await backend.load({ src: new Blob() }, { startTime: 3 });
    await backend.play();
    await vi.waitFor(() => expect(errors).toContain('decoderFallback'), { timeout: 6000 });
    expect(details).toContainEqual(expect.objectContaining({ candidate: 'webcodecs', outcome: 'failed', reason: expect.stringMatching(/^decoderStalled/) }));
    backend.destroy();
  }, 10_000);

  it('a second failure goes to the session (fatal)', async () => {
    const { backend, errors } = setup([makeDecoder('webcodecs', { failAfter: 20 }), makeDecoder('wasm-hevc', { failAfter: 20 })]);
    await backend.load({ src: new Blob() }, { startTime: 3 });
    await backend.play();
    await vi.waitFor(() => expect(errors).toEqual(expect.arrayContaining(['decoderFallback', 'decodeError'])), { timeout: 6000 });
    backend.destroy();
  }, 10_000);

  it('switches quality at the next keyframe of the new rendition, without a gap', async () => {
    // Two renditions (width 2 / 4), same timeline, keyframes every 90 frames.
    const ladder = (fed: number[]): Demuxer => {
      const base = fakeDemuxer(fed);
      const track = (id: number, width: number, bitrate: number) => ({ id, codec: 'avc1.42c01e', setup: { codec: 'avc1.42c01e', codedWidth: width, codedHeight: 2 }, width, height: 2, bitrate, frameRate: FPS });
      const low = track(1, 2, 100_000);
      const high = track(2, 4, 900_000);
      async function* from(start: number): AsyncGenerator<EncodedChunk> {
        for (let i = start; i < FRAMES; i++) yield { type: i % GOP === 0 ? 'key' : 'delta', timestamp: us(i), duration: us(1), data: new ArrayBuffer(1) };
      }
      return {
        ...base,
        info: { ...base.info, video: low, videoTracks: [low, high] },
        openVideo: (_id, time, edge) => {
          const frame = Math.floor(time * FPS + 1e-6);
          const key = edge === 'before' ? Math.floor(frame / GOP) * GOP : Math.ceil(frame / GOP) * GOP;
          return Promise.resolve(key >= FRAMES ? null : { start: key / FPS, packets: from(key) });
        },
      };
    };
    const widths: number[] = [];
    const { backend, drawn, qualities, state } = setup([fakeDecoder], ladder);
    backend.on('playback-change', (p) => {
      if (p.videoWidth !== undefined) widths.push(p.videoWidth);
    });
    await backend.load({ src: new Blob() }, { startTime: 1, quality: '1' });
    expect(backend.tracks.video.map((v) => [v.id, v.selected])).toEqual([['1', true], ['2', false]]);
    await backend.play();
    backend.selectQuality('2');
    await vi.waitFor(() => expect(widths.at(-1)).toBe(4), { timeout: 8000 });
    expect(qualities).toContain('2');
    expect(backend.tracks.video.find((v) => v.selected)?.id).toBe('2');
    // Frames kept coming in order across the switch (no jump back, no gap of more than a few).
    const seq = drawn.slice(drawn.indexOf(30));
    for (let i = 1; i < seq.length; i++) expect((seq[i] as number) - (seq[i - 1] as number)).toBeGreaterThan(0);
    expect(state['waiting']).not.toBe(true);
    backend.destroy();
  }, 15_000);

  it('background: no video decoding while hidden, the clock goes on; back in view, video restarts at the clock', async () => {
    const setVisibility = (v: 'hidden' | 'visible'): void => {
      Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    try {
      const { backend, fed, drawn, state } = setup();
      await backend.load({ src: new Blob() }, { startTime: 1 });
      await backend.play();
      await new Promise((r) => setTimeout(r, 300));
      setVisibility('hidden');
      await new Promise((r) => setTimeout(r, 100));
      const fedAtHide = fed.length;
      const drawnAtHide = drawn.length;
      await new Promise((r) => setTimeout(r, 1500));
      // Nothing decoded or drawn in the background (a few packets already read ahead may go in).
      expect(fed.length - fedAtHide).toBeLessThan(15);
      expect(drawn.length).toBe(drawnAtHide);
      // The clock went on.
      expect(state['currentTime'] as number).toBeGreaterThan(2.5);
      setVisibility('visible');
      // Video catches up at once: the next picture is near the clock, not where it stopped.
      await vi.waitFor(() => expect(drawn.length).toBeGreaterThan(drawnAtHide));
      const first = drawn[drawnAtHide] as number;
      expect(first / FPS).toBeGreaterThan((state['currentTime'] as number) - 0.3);
      backend.destroy();
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    }
  }, 10_000);
});
