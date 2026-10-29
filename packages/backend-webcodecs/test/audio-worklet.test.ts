// The audio worklet of the WebCodecs backend (audio.ts PROCESSOR), run with stand-ins for the
// AudioWorkletGlobalScope globals: a dry queue while playing is reported as an underrun once audio
// flows again (M6 F14); the first fill after a load / seek and a dry end of the media are not.
import { describe, expect, it } from 'vitest';
import { PROCESSOR } from '../src/audio.js';

interface Port {
  posted: { t: string; media?: number; ms?: number }[];
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(m: unknown): void;
}
interface Processor {
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
});
