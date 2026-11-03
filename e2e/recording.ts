// The WHEP recording's analysis (cn-live-whep.spec.ts), on its own so it can be unit tested
// (tests/recording.test.ts): the tone's frequency, its share per second, the loop seams (phase
// jumps), and the recorder's own drops: stretches where the MediaStream source gave the recording
// worklet exact zeros (F17, owner 2026-11-03: no concealment at the receiver, the fixture sending on
// time; the recording path, not the product). A seam on a recorder drop is the drop's, not the
// stream's: it is set apart, not counted against the loop.

/** Share of the energy of x[from, from + n) at frequency f (Goertzel). */
export function toneShare(x: Float64Array, from: number, n: number, f: number, rate: number): number {
  const w = (2 * Math.PI * f) / rate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  let energy = 0;
  for (let i = from; i < from + n; i++) {
    const v = x[i] as number;
    const s0 = v + c * s1 - s2;
    s2 = s1;
    s1 = s0;
    energy += v * v;
  }
  const power = s1 * s1 + s2 * s2 - c * s1 * s2;
  return energy === 0 ? 0 : (2 * power) / (n * energy);
}

/** Runs of exact zeros of at least `minSamples` after `skipS` (the stream starting): start (s) and length. */
export function recorderDrops(x: Float64Array, rate: number, minSamples = 64, skipS = 0.05): { at: number; samples: number }[] {
  const out: { at: number; samples: number }[] = [];
  let run = 0;
  for (let i = Math.round(skipS * rate); i <= x.length; i++) {
    if (i < x.length && x[i] === 0) {
      run++;
      continue;
    }
    if (run >= minSamples) out.push({ at: (i - run) / rate, samples: run });
    run = 0;
  }
  return out;
}

export interface ToneAnalysis {
  readonly f0: number;
  /** Per second: the tone's share of the energy (ten 100 ms windows each). */
  readonly shares: readonly number[];
  /** Loop seams after the first half second, recorder drops excluded (s). */
  readonly seams: readonly number[];
  /** Seams within 50 ms of a recorder drop (s): the recording path's, not counted. */
  readonly recorderSeams: readonly number[];
  readonly drops: readonly { at: number; samples: number }[];
}

export function analyzeTone(x: Float64Array, rate: number): ToneAnalysis {
  // The tone's frequency: the strongest of 400-480 Hz (the received clock may differ from the
  // source's by a fraction of a hertz). Coarse on one second, fine on the whole recording.
  let f0 = 440;
  let best = 0;
  const from = Math.min(2 * rate, Math.max(0, x.length - rate));
  for (let f = 400; f <= 480; f += 0.5) {
    const share = toneShare(x, from, Math.min(rate, x.length - from), f, rate);
    if (share > best) [best, f0] = [share, f];
  }
  const coarse = f0;
  best = 0;
  for (let f = coarse - 0.5; f <= coarse + 0.5; f += 0.05) {
    const share = toneShare(x, 0, x.length, f, rate);
    if (share > best) [best, f0] = [share, f];
  }
  // Every second: most of the energy at the tone. Ten 100 ms windows per second, each on its own
  // (a seam's phase jump would cancel a coherent 1 s sum).
  const shares: number[] = [];
  const tenth = Math.round(rate / 10);
  for (let s = 0; s + 10 * tenth <= x.length; s += 10 * tenth) {
    let sum = 0;
    for (let k = 0; k < 10; k++) sum += toneShare(x, s + k * tenth, tenth, f0, rate);
    shares.push(sum / 10);
  }
  // Loop seams: a phase jump. Each 10 ms window is fitted with a sine at f0 (least squares on sin
  // and cos); a seam leaves a residual far above the windows around it. Merged within 300 ms (the
  // jitter buffer may smear one seam over a few windows).
  const win = Math.round(rate * 0.01);
  const w0 = (2 * Math.PI * f0) / rate;
  const residuals: number[] = [];
  for (let s = 0; s + win <= x.length; s += win) {
    let ss = 0;
    let cc = 0;
    let sc = 0;
    let xs = 0;
    let xc = 0;
    let xx = 0;
    for (let i = s; i < s + win; i++) {
      const v = x[i] as number;
      const sn = Math.sin(w0 * i);
      const cs = Math.cos(w0 * i);
      ss += sn * sn;
      cc += cs * cs;
      sc += sn * cs;
      xs += v * sn;
      xc += v * cs;
      xx += v * v;
    }
    const det = ss * cc - sc * sc;
    const a = (xs * cc - xc * sc) / det;
    const b = (xc * ss - xs * sc) / det;
    residuals.push(xx === 0 ? 1 : Math.max(0, xx - a * xs - b * xc) / xx);
  }
  const median = [...residuals].sort((p, q) => p - q)[residuals.length >> 1] as number;
  const all: number[] = [];
  residuals.forEach((r, i) => {
    const t = (i * win) / rate;
    if (r > Math.max(0.01, 10 * median) && (all.length === 0 || t - (all.at(-1) as number) > 0.3)) all.push(t);
  });
  // The first half second may still be the stream starting.
  const inner = all.filter((t) => t > 0.5);
  const drops = recorderDrops(x, rate);
  const onDrop = (t: number): boolean => drops.some((d) => t >= d.at - 0.05 && t <= d.at + d.samples / rate + 0.05);
  return { f0, shares, seams: inner.filter((t) => !onDrop(t)), recorderSeams: inner.filter(onDrop), drops };
}

/**
 * Loop gaps with the receiver's time-stretching taken out (F17): the WebRTC jitter buffer slows
 * playout down (inserts samples) or speeds it up (removes them) without concealment, which moves
 * the seams by that much. `stretchS(t)`: the receiver's net stretch (inserted - removed, seconds)
 * by recording time t; each gap minus the stretch between its two seams.
 */
export function stretchedGaps(seams: readonly number[], stretchS: (t: number) => number): { raw: number[]; corrected: number[] } {
  const raw = seams.slice(1).map((t, i) => t - (seams[i] as number));
  const corrected = seams.slice(1).map((t, i) => t - (seams[i] as number) - (stretchS(t) - stretchS(seams[i] as number)));
  return { raw, corrected };
}

/** A step function from samples (at, value), the last value at or before t (0 before the first). */
export function stepAt(samples: readonly { at: number; value: number }[]): (t: number) => number {
  return (t) => {
    let v = 0;
    for (const s of samples) {
      if (s.at > t) break;
      v = s.value;
    }
    return v;
  };
}
