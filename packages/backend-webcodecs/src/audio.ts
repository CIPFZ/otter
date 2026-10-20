// Audio output of the WebCodecs backend: decoded AudioData goes to an AudioWorklet that plays
// each sample at the context time the master clock maps it to (ADR-008 §2). The worklet keeps
// no clock of its own: it receives the clock anchor and looks samples up by media time, so seek,
// pause and a clock source switch need no extra bookkeeping. Rates other than 1 are silent (no
// audio time-stretching yet).

import type { ClockAnchor } from './clock.js';

// Plain JS for AudioWorkletGlobalScope (`currentTime`, `sampleRate` are globals there).
const PROCESSOR = `
class OtterAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = [];
    this.a = null;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'chunk') this.q.push(m);
      else if (m.t === 'anchor') this.a = m;
      else if (m.t === 'flush') this.q.length = 0;
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
    while (q.length > 0 && end(q[0]) <= t0) q.shift();
    const n = out[0].length;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const t = t0 + i / sampleRate;
      while (k < q.length && end(q[k]) <= t) k++;
      const c = q[k];
      if (c === undefined) break;
      const pos = (t - c.start) * c.rate;
      if (pos < 0) continue;
      const j = pos | 0;
      const f = pos - j;
      for (let ch = 0; ch < out.length; ch++) {
        const p = c.planes[Math.min(ch, c.planes.length - 1)];
        const v = p[j];
        out[ch][i] = j + 1 < p.length ? v + (p[j + 1] - v) * f : v;
      }
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
  /** Takes ownership of `data` (closed after copying). */
  push(data: AudioData): void;
  /** Drops everything queued (seek). */
  flush(): void;
  /** End (s) of the audio handed over so far, -Infinity after a flush. */
  readonly bufferedEnd: number;
  setAnchor(a: ClockAnchor): void;
  setVolume(volume: number, muted: boolean): void;
  destroy(): void;
}

export async function createAudioSink(ctx: AudioContext): Promise<AudioSink> {
  await loadProcessor(ctx);
  const node = new AudioWorkletNode(ctx, 'otter-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  const gain = ctx.createGain();
  node.connect(gain).connect(ctx.destination);
  let bufferedEnd = Number.NEGATIVE_INFINITY;
  return {
    push(data) {
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
      node.port.postMessage({ t: 'chunk', start, rate, planes }, planes.map((p) => p.buffer));
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
    destroy() {
      node.port.postMessage({ t: 'flush' });
      node.disconnect();
      gain.disconnect();
    },
  };
}
