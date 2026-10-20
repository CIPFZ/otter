import { describe, expect, it } from 'vitest';
import { NEUTRAL_FILTERS } from '../src/filter-css.js';
import { colorMatrix, sharpenKernel } from '../src/filters.js';

const apply = (m: readonly number[], [r, g, b]: [number, number, number]): number[] =>
  [0, 1, 2].map((i) => (m[i * 4] as number) * r + (m[i * 4 + 1] as number) * g + (m[i * 4 + 2] as number) * b + (m[i * 4 + 3] as number));

describe('filter matrix (shared by every Surface)', () => {
  it('is the identity for neutral filters', () => {
    expect(colorMatrix(NEUTRAL_FILTERS)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
    expect(sharpenKernel(0)).toEqual([0, -0, 0, -0, 1, -0, 0, -0, 0]);
  });

  it('matches the CSS filter functions in order: brightness, contrast, saturate', () => {
    // brightness(2) then contrast(0.5): 0.25 -> 0.5 -> 0.5 * 0.5 + 0.25
    expect(apply(colorMatrix({ ...NEUTRAL_FILTERS, brightness: 2, contrast: 0.5 }), [0.25, 0.25, 0.25])).toEqual([0.5, 0.5, 0.5]);
    // saturate(0): Rec. 709 luma weights
    const grey = apply(colorMatrix({ ...NEUTRAL_FILTERS, saturate: 0 }), [1, 0, 0]);
    for (const v of grey) expect(v).toBeCloseTo(0.213, 6);
  });

  it('warms by raising red and lowering blue', () => {
    const [r, g, b] = apply(colorMatrix({ ...NEUTRAL_FILTERS, temperature: 1 }), [0.5, 0.5, 0.5]);
    expect(r).toBeCloseTo(0.6, 6);
    expect(g).toBeCloseTo(0.5, 6);
    expect(b).toBeCloseTo(0.4, 6);
  });

  it('sharpen kernel sums to one (flat areas unchanged)', () => {
    expect(sharpenKernel(0.7).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
});
