// The WHEP recording's analysis (e2e/recording.ts): loop seams of a 440 Hz tone, and F17's
// recorder drops (exact-zero stretches from the MediaStream source) set apart from them.
import { describe, expect, it } from 'vitest';
import { analyzeTone, recorderDrops } from '../e2e/recording.ts';

const RATE = 44_100;
const LOOP_S = 4.02;

/** 20 s of a 440 Hz tone whose phase restarts every LOOP_S from `first` (off the 10 ms window grid, as real seams are) (the source's loop), with `drops` of exact zeros (s, samples) where the recorder got nothing; after a drop the tone goes on where it left off (delayed, as a recorder underrun does). */
function recording(first: number, drops: readonly [number, number][] = []): Float64Array {
  const x = new Float64Array(20 * RATE);
  let src = 0;
  for (let i = 0; i < x.length; i++) {
    const drop = drops.find(([at, n]) => i >= Math.round(at * RATE) && i < Math.round(at * RATE) + n);
    if (drop !== undefined) {
      x[i] = 0;
      continue;
    }
    const t = src / RATE;
    const k = t < first ? -1 : Math.floor((t - first) / LOOP_S);
    const local = k < 0 ? t : t - first - k * LOOP_S;
    x[i] = 0.088 * Math.sin(2 * Math.PI * 440 * local + (k < 0 ? 0 : 1.3 * (k + 1)));
    src++;
  }
  return x;
}

describe('WHEP recording analysis', () => {
  it('finds the loop seams every 4.02 s', () => {
    const a = analyzeTone(recording(2.5037), RATE);
    expect(a.f0).toBeCloseTo(440, 0);
    expect(a.seams.length).toBeGreaterThanOrEqual(4);
    const gaps = a.seams.slice(1).map((t, i) => t - (a.seams[i] as number));
    for (const g of gaps) expect(Math.abs(g - LOOP_S)).toBeLessThan(0.05);
    expect(a.recorderSeams).toEqual([]);
  });

  it('F17: a seam on a recorder drop (373 exact zeros at 9.63 s, as at 74548b2) is the recording\'s, not the loop\'s', () => {
    const x = recording(2.5037, [[9.63, 373]]);
    expect(recorderDrops(x, RATE)).toEqual([{ at: expect.closeTo(9.63, 2) as number, samples: 373 }]);
    const a = analyzeTone(x, RATE);
    expect(a.recorderSeams.length).toBe(1);
    expect(a.recorderSeams[0]).toBeCloseTo(9.63, 1);
    // The loop seams alone: every gap is the loop (the drop delays the tone by 8.5 ms, within tolerance).
    const gaps = a.seams.slice(1).map((t, i) => t - (a.seams[i] as number));
    for (const g of gaps) expect(Math.abs(g - LOOP_S)).toBeLessThan(0.25);
  });
});

describe('WHEP recording loop gaps with the receiver\'s time-stretching (F17)', () => {
  it('a gap stretched by the jitter buffer (290 ms inserted between two seams, as at 821a099: 4.29 s) is the loop once the stretch is taken out', async () => {
    const { stretchedGaps, stepAt } = await import('../e2e/recording.ts');
    const seams = [2.56, 6.85, 10.87, 14.89];
    // 0.27 s inserted between 3 s and 4 s of the recording, none elsewhere.
    const stretch = stepAt([{ at: 0, value: 0 }, { at: 3.5, value: 0.27 }]);
    const { raw, corrected } = stretchedGaps(seams, stretch);
    expect(raw[0]).toBeCloseTo(4.29, 2);
    // The old check (raw gaps within 0.25 s of the loop) fails on this recording; the corrected gap passes.
    expect(Math.abs((raw[0] as number) - LOOP_S)).toBeGreaterThan(0.25);
    for (const g of corrected) expect(Math.abs(g - LOOP_S)).toBeLessThan(0.05);
  });
});
