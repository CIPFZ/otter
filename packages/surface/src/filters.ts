// Picture filters (SPEC §12, ADR-008 §6) as one colour matrix plus a sharpen kernel, so every
// Surface computes the same picture: VideoSurface and CanvasSurface through an SVG filter
// (feConvolveMatrix, then feColorMatrix, in sRGB like the CSS filter functions), GPUSurface in its
// fragment shader with the same numbers. Part of the GPU entry and the SVG filter chunk; the
// main entry only needs filter-css.ts.

import type { SurfaceFilters } from './surface.js';

/** Red / blue gain per unit of temperature (-1 cool ... +1 warm). */
const TEMPERATURE_GAIN = 0.2;

/** Row-major 3x4 affine colour matrix: [r g b offset] for each of R, G, B. */
export type ColorMatrix = readonly [number, number, number, number, number, number, number, number, number, number, number, number];

const IDENTITY: ColorMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** a ∘ b: apply b first, then a. */
function compose(a: ColorMatrix, b: ColorMatrix): ColorMatrix {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = c === 3 ? (a[r * 4 + 3] as number) : 0;
      for (let k = 0; k < 3; k++) v += (a[r * 4 + k] as number) * (b[k * 4 + c] as number);
      out.push(v);
    }
  }
  return out as unknown as ColorMatrix;
}

/**
 * The colour part of the filters, in the order the CSS functions apply them: brightness,
 * contrast, saturate (Filter Effects §11 matrices), then temperature.
 */
export function colorMatrix(f: SurfaceFilters): ColorMatrix {
  const b = f.brightness;
  const c = f.contrast;
  const s = f.saturate;
  const t = f.temperature;
  const steps: ColorMatrix[] = [
    [b, 0, 0, 0, 0, b, 0, 0, 0, 0, b, 0],
    [c, 0, 0, 0.5 - 0.5 * c, 0, c, 0, 0.5 - 0.5 * c, 0, 0, c, 0.5 - 0.5 * c],
    [
      0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0,
      0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0,
      0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0,
    ],
    [1 + TEMPERATURE_GAIN * t, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 - TEMPERATURE_GAIN * t, 0],
  ];
  return steps.reduce((m, step) => compose(step, m), IDENTITY);
}

/** 3x3 sharpen kernel (unsharp, cross shape), row-major; identity for amount 0. */
export function sharpenKernel(amount: number): readonly number[] {
  const a = Math.max(0, amount);
  return [0, -a, 0, -a, 1 + 4 * a, -a, 0, -a, 0];
}

const num = (n: number): string => String(Math.round(n * 1e6) / 1e6);

/** <filter> markup for `f`: sharpen (when any), then the colour matrix, both in sRGB. */
export function svgFilterMarkup(id: string, f: SurfaceFilters): string {
  const m = colorMatrix(f);
  // feColorMatrix is 4x5 (RGBA rows, offset last); alpha passes through.
  const values = [0, 1, 2].flatMap((r) => [m[r * 4], m[r * 4 + 1], m[r * 4 + 2], 0, m[r * 4 + 3]]).concat([0, 0, 0, 1, 0]);
  const sharpen =
    f.sharpen > 0
      ? `<feConvolveMatrix order="3" kernelMatrix="${sharpenKernel(f.sharpen).map(num).join(' ')}" divisor="1" bias="0" edgeMode="duplicate" preserveAlpha="true"/>`
      : '';
  return `<filter id="${id}" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%">${sharpen}<feColorMatrix type="matrix" values="${values.map((v) => num(v as number)).join(' ')}"/></filter>`;
}
