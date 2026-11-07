// The audio worklet of the WebCodecs backend (audio.ts PROCESSOR), run with stand-ins for the
// AudioWorkletGlobalScope globals: a dry queue while playing is reported as an underrun once audio
// flows again (M6 F14); the first fill after a load / seek and a dry end of the media are not.
import { describe, expect, it } from 'vitest';
import { PROCESSOR } from '../src/audio.js';

interface Port {
  posted: { t: string; media?: number; ms?: number; dq?: number; under?: number; fill?: number; gap?: number; late?: number }[];
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(m: unknown): void;
}
interface Processor {
  readonly q: readonly unknown[];
  port: Port;
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
}

const RATE = 48_000;
const QUANTUM = 128;

/** A processor instance and a clock: `render(s)` runs `s` seconds of render quanta. */
function worklet() {
  const scope = { currentTime: 0, sampleRate: RATE };
  let Ctor: (new () => Processor) | undefined;
  class AudioWorkletProcessor {
    port: Port = {
      posted: [],
      onmessage: null,
      postMessage(m) {
        this.posted.push(m as Port['posted'][number]);
      },
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('AudioWorkletProcessor', 'registerProcessor', 'scope', `with (scope) { ${PROCESSOR} }`)(AudioWorkletProcessor, (_name: string, c: new () => Processor) => (Ctor = c), scope);
  const p = new (Ctor as new () => Processor)();
  const send = (m: unknown): void => p.port.onmessage?.({ data: m });
  const silent: number[] = [];
  const render = (seconds: number): void => {
    for (let k = 0; k < (seconds * RATE) / QUANTUM; k++) {
      const out = [new Float32Array(QUANTUM), new Float32Array(QUANTUM)];
      p.process([], [out]);
      if (out[0]?.every((v) => v === 0) === true) silent.push(scope.currentTime);
      scope.currentTime += QUANTUM / RATE;
    }
  };
  /** 0.1 s chunks of a constant 0.5 from `from` to `to` (media seconds). */
  const chunks = (from: number, to: number): void => {
    for (let t = from; t < to - 1e-9; t += 0.1) send({ t: 'chunk', start: t, rate: RATE, planes: [new Float32Array(RATE / 10).fill(0.5)], dq: 0 });
  };
  send({ t: 'anchor', media: 0, context: 0, rate: 1, playing: true });
  return { p, send, render, chunks, silent, underruns: () => p.port.posted.filter((m) => m.t === 'underrun') };
}

describe('audio worklet underruns (M6 F14)', () => {
  it('a decoder that stalls while playing: the dry stretch is reported with its length', () => {
    const w = worklet();
    w.chunks(0, 0.5);
    w.render(0.8);
    expect(w.underruns()).toEqual([]);
    // Audio comes again from 0.8 s: the 0.3 s without it are said.
    w.chunks(0.8, 1.5);
    w.render(0.3);
    const u = w.underruns();
    expect(u).toHaveLength(1);
    expect(u[0]?.media).toBeCloseTo(0.5, 2);
    expect(u[0]?.ms).toBeGreaterThan(290);
    expect(u[0]?.ms).toBeLessThan(310);
  });

  it('the first fill is not over after the first chunk: a short gap before the second is not an underrun (16-tile wall, 2 ms at 0.021 s)', () => {
    const w = worklet();
    // One 21 ms chunk, then the rest a moment later.
    w.send({ t: 'chunk', start: 0, rate: RATE, planes: [new Float32Array(1024).fill(0.5)], dq: 0 });
    w.render(0.03);
    w.chunks(0.0213, 0.6);
    w.render(0.4);
    expect(w.underruns()).toEqual([]);
  });

  it('the first fill after a load or a seek is not an underrun, nor a dry end of the media', () => {
    const w = worklet();
    // Nothing yet (decoding the first frames): silent, not reported.
    w.render(0.2);
    w.chunks(0.2, 0.6);
    w.render(0.5);
    // A seek: flush, the clock jumps, the new audio arrives a little later.
    w.send({ t: 'flush' });
    w.send({ t: 'anchor', media: 5, context: 0.7, rate: 1, playing: true });
    w.render(0.1);
    w.chunks(5.1, 5.5);
    w.render(0.6);
    // The media ended (no more chunks): dry, never reported.
    w.render(0.5);
    expect(w.underruns()).toEqual([]);
  });

  it('zeros of the first fill are counted as fill, not under; a dry stretch while flowing is under, with the decode queue depth then', () => {
    const w = worklet();
    // 0.1 s of nothing (first fill), then audio to 0.5 s, then dry to 0.7 s with dq 17 on the last chunk.
    w.render(0.1);
    for (let t = 0.1; t < 0.5 - 1e-9; t += 0.1) w.send({ t: 'chunk', start: t, rate: RATE, planes: [new Float32Array(RATE / 10).fill(0.5)], dq: 17 });
    w.render(0.6);
    w.chunks(0.7, 1.2);
    w.render(0.4);
    const stats = w.p.port.posted.filter((m) => m.t === 'stat');
    const sum = (k: 'under' | 'fill') => stats.reduce((n, x) => n + (x[k] ?? 0), 0);
    // The first 0.1 s: fill (4800 samples, to a quantum), not under.
    expect(sum('fill')).toBeGreaterThanOrEqual(4800 - 128);
    expect(sum('fill')).toBeLessThanOrEqual(4800 + 128);
    // The dry 0.2 s while flowing: under.
    expect(sum('under')).toBeGreaterThanOrEqual(9600 - 128);
    expect(sum('under')).toBeLessThanOrEqual(9600 + 128);
    expect(w.underruns()[0]).toMatchObject({ dq: 17 });
  });

  it('a later chunk with a hole before it: the hole is gap, not under (no underrun)', () => {
    const w = worklet();
    w.chunks(0, 0.3);
    // Next chunk starts 50 ms after the last one ended: queued already, so a gap.
    w.chunks(0.35, 0.8);
    w.render(0.7);
    const stats = w.p.port.posted.filter((m) => m.t === 'stat');
    expect(stats.reduce((n, x) => n + (x.gap ?? 0), 0)).toBeGreaterThanOrEqual(2400 - 128);
    expect(stats.reduce((n, x) => n + (x.under ?? 0), 0)).toBe(0);
    expect(w.underruns()).toEqual([]);
  });
});

it.each([0.5, 2])('releases past PCM while silent at playback rate %s', (rate) => {
  const w = worklet();
  w.send({ t: 'anchor', media: 0, context: 0, rate, playing: true });
  w.chunks(0, rate * 5);
  w.render(5.1);
  expect(w.p.q).toHaveLength(0);
  expect(w.silent.length).toBeGreaterThan(0);
  expect(w.underruns()).toEqual([]);
});
