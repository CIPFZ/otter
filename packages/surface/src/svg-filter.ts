// The SVG filter element behind VideoSurface / CanvasSurface filters that CSS shorthand functions
// cannot express (temperature, sharpen). One hidden <svg> per surface, next to its element.
// Surfaces load this on demand (the first temperature / sharpen) and use the CSS shorthand
// (filter-css.ts) otherwise, so plain playback pages do not carry it. It must not import anything
// the main entry imports (no shared chunk between the entry and its lazy chunks).

import { svgFilterMarkup } from './filters.js';
import type { SurfaceFilters } from './surface.js';

let ids = 0;

export interface SvgFilter {
  /** Points the filter at `f` and returns the CSS `filter` value (url(#id)). */
  css(f: SurfaceFilters): string;
  destroy(): void;
}

export function createSvgFilter(next: Element): SvgFilter {
  const base = `otter-filter-${++ids}`;
  let svg: SVGSVGElement | undefined;
  let markup = '';
  let rev = 0;
  return {
    css(f) {
      if (svg === undefined) {
        const doc = next.ownerDocument;
        svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
        next.after(svg);
      }
      // A new id for every change: WebKit keeps using a filter it resolved for a url() even after
      // the <filter> content behind that id changed (RESEARCH §1).
      const wanted = svgFilterMarkup('', f);
      if (wanted !== markup) {
        markup = wanted;
        rev++;
        // innerHTML on an SVG element parses SVG; the markup is generated from numbers only.
        svg.innerHTML = svgFilterMarkup(`${base}-${rev}`, f);
      }
      return `url(#${base}-${rev})`;
    },
    destroy() {
      svg?.remove();
      svg = undefined;
    },
  };
}
