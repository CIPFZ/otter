// The part of the filters every page may need: neutral values and the CSS shorthand functions
// (brightness / contrast / saturate). Temperature and sharpen need the colour matrix and the SVG
// filter (filters.ts, svg-filter.ts), which are loaded on demand.

import type { SurfaceFilters } from './surface.js';

export const NEUTRAL_FILTERS: SurfaceFilters = { brightness: 1, contrast: 1, saturate: 1, temperature: 0, sharpen: 0 };

export const isNeutral = (f: SurfaceFilters): boolean =>
  f.brightness === 1 && f.contrast === 1 && f.saturate === 1 && f.temperature === 0 && f.sharpen === 0;

/** Only what the CSS shorthand functions cover (cheaper than an SVG filter). */
export const cssOnly = (f: SurfaceFilters): boolean => f.temperature === 0 && f.sharpen === 0;

/** Shorthand CSS for brightness / contrast / saturate (Filter Effects, sRGB). */
export function shorthandCss(f: SurfaceFilters): string {
  return [f.brightness !== 1 ? `brightness(${f.brightness})` : '', f.contrast !== 1 ? `contrast(${f.contrast})` : '', f.saturate !== 1 ? `saturate(${f.saturate})` : '']
    .filter((p) => p !== '')
    .join(' ');
}
