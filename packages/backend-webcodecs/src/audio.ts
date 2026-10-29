// Audio output of the WebCodecs backend: decoded AudioData goes to an AudioWorklet that plays
// each sample at the context time the master clock maps it to (ADR-008 §2). The worklet keeps
// no clock of its own: it receives the clock anchor and looks samples up by media time, so seek,
// pause and a clock source switch need no extra bookkeeping. Rates other than 1 are silent (no
// audio time-stretching yet).

import type { ClockAnchor } from './clock.js';

// Plain JS for AudioWorkletGlobalScope (`currentTime`, `sampleRate` are globals there). Exported
// for the unit tests, which run it with stand-ins for those globals.
export const PROCESSOR = `
class OtterAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = [];
    this.a = null;
    // Observation (M6 F14), summed over about 0.2 s and posted as 'stat': samples output as zeros
    // because the queue was dry (under) or the next chunk starts later (gap), chunks dropped as
    // already past (late), the largest discontinuity between consecutive chunks (disc, s), the
    // decode queue depth sent with the last chunk (dq).
    this.s = { n: 0, under: 0, gap: 0, late: 0, disc: 0, dq: 0 };
    this.lastEnd = null;
    // Underrun (M6 F14): the queue ran dry while playing after audio had been flowing (not the
    // first fill after a load or seek); reported with its length once audio flows again (a dry end
    // of the media is not reported).
    this.flowing = false;
    this.dryFrom = null;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'chunk') {
        if (this.lastEnd !== null) {
          const d = m.start - this.lastEnd;
          if (Math.abs(d) > Math.abs(this.s.disc)) this.s.disc = d;
        }
        this.lastEnd = m.start + m.planes[0].length / m.rate;
        this.s.dq = m.dq;
        this.q.push(m);
      } else if (m.t === 'anchor') this.a = m;
      else if (m.t === 'flush') {
        this.q.length = 0;
        this.lastEnd = null;
        this.flowing = false;
        this.dryFrom = null;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    for (const ch of out) ch.fill(0);
    const a = this.a;
    if (a === null || !a.playing || a.rate !== 1 || out.length === 0) return true;
    const q = this.q;
    const t0 = a.media + (currentTime - a.context);
    const end = (c) => c.start + c.planes[0].length / c.rate;
    const s = this.s;
    while (q.length > 0 && end(q[0]) <= t0) {
      q.shift();
      s.late++;
    }
    const n = out[0].length;
    let k = 0;
    let i = 0;
    for (; i < n; i++) {
      const t = t0 + i / sampleRate;
      while (k < q.length && end(q[k]) <= t) k++;
      const c = q[k];
      if (c === undefined) break;
      const pos = (t - c.start) * c.rate;
      if (pos < 0) {
        s.gap++;
        continue;
      }
      const j = pos | 0;
      const f = pos - j;
      for (let ch = 0; ch < out.length; ch++) {
        const p = c.planes[Math.min(ch, c.planes.length - 1)];
        const v = p[j];
        out[ch][i] = j + 1 < p.length ? v + (p[j + 1] - v) * f : v;
      }
    }
    s.under += n - i;
    s.n += n;
    // Audio in this quantum after a dry stretch in earlier ones: that stretch is over.
    if (i > 0) {
      if (this.dryFrom !== null) this.port.postMessage({ t: 'underrun', media: this.dryFrom, ms: (t0 - this.dryFrom) * 1000 });
      this.dryFrom = null;
      this.flowing = true;
    }
    if (i < n && this.flowing && this.dryFrom === null) this.dryFrom = t0 + i / sampleRate;
    if (s.n >= sampleRate / 5) {
      const last = q[q.length - 1];
      this.port.postMessage({ t: 'stat', at: currentTime, media: t0, ahead: last === undefined ? -1 : end(last) - t0, queued: q.length, ...s });
      this.s = { n: 0, under: 0, gap: 0, late: 0, disc: 0, dq: s.dq };
    }
    return true;
  }
}
registerProcessor('otter-audio', OtterAudio);
`;

const modules = new WeakMap<AudioContext, Promise<void>>();

/** A context whose worklet module never loads (no audio backend: headless Firefox) is unusable. */
const WORKLET_TIMEOUT_MS = 3000;

function loadProcessor(ctx: AudioContext): Promise<void> {
  let p = modules.get(ctx);
  if (p === undefined) {
    const url = URL.createObjectURL(new Blob([PROCESSOR], { type: 'text/javascript' }));
    const load = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    p = Promise.race([
      load,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error(`audioWorklet.addModule timed out after ${WORKLET_TIMEOUT_MS} ms`)), WORKLET_TIMEOUT_MS)),
    ]);
    // Do not cache a timeout: a later attempt (other instance) may still get through.
    p.catch(() => modules.delete(ctx));
    modules.set(ctx, p);
  }
  return p;
}

export interface AudioSink {
  /** Takes ownership of `data` (closed after copying); `decodeQueue`: the decoder's queue depth then. */
  push(data: AudioData, decodeQueue?: number): void;
  /** Drops everything queued (seek). */
  flush(): void;
  /** End (s) of the audio handed over so far, -Infinity after a flush. */
  readonly bufferedEnd: number;
  setAnchor(a: ClockAnchor): void;
  setVolume(volume: number, muted: boolean): void;
  /** The worklet ran dry while playing (media time it began, ms of silence), once audio flows again. */
  onUnderrun(h: (media: number, ms: number) => void): void;
  destroy(): void;
}

export async function createAudioSink(ctx: AudioContext): Promise<AudioSink> {
  await loadProcessor(ctx);
  const node = new AudioWorkletNode(ctx, 'otter-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  const gain = ctx.createGain();
  node.connect(gain).connect(ctx.destination);
  let bufferedEnd = Number.NEGATIVE_INFINITY;
  let underrun: ((media: number, ms: number) => void) | undefined;
  node.port.onmessage = (e: MessageEvent<{ t: string; media?: number; ms?: number }>) => {
    if (e.data.t === 'underrun') underrun?.(e.data.media as number, e.data.ms as number);
  };
  return {
    push(data, decodeQueue = 0) {
      const frames = data.numberOfFrames;
      const planes: Float32Array[] = [];
      for (let ch = 0; ch < data.numberOfChannels; ch++) {
        const plane = new Float32Array(frames);
        data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
        planes.push(plane);
      }
      const start = data.timestamp / 1e6;
      const rate = data.sampleRate;
      data.close();
      bufferedEnd = Math.max(bufferedEnd, start + frames / rate);
      node.port.postMessage({ t: 'chunk', start, rate, planes, dq: decodeQueue }, planes.map((p) => p.buffer));
    },
    flush() {
      bufferedEnd = Number.NEGATIVE_INFINITY;
      node.port.postMessage({ t: 'flush' });
    },
    get bufferedEnd() {
      return bufferedEnd;
    },
    setAnchor(a) {
      node.port.postMessage({ t: 'anchor', ...a });
    },
    setVolume(volume, muted) {
      gain.gain.value = muted ? 0 : volume;
    },
    onUnderrun(h) {
      underrun = h;
    },
    destroy() {
      node.port.postMessage({ t: 'flush' });
      node.disconnect();
      gain.disconnect();
    },
  };
}
